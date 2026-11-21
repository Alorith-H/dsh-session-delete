// Host-side behaviour checks for dsh-session-delete.
//
// No real session data is touched: every case builds a throwaway session root
// under the OS temp directory and drives `deleteSession()` with a fake Cordis
// context. Run with `node test/run.mjs` (or `npm test`).
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeleteError, deleteSession, encodeSegment, projectKey } from '../index.js'

const TMP = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
const ROOT = join(TMP, 'sessions')
const SESSION_ID = 'session-alpha'
const CWD = 'C:\\Users\\someone\\Documents\\project'

const exists = async (path) => {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

/** A fake ctx exposing the four Host services the deletion path reads. */
function makeCtx({ root = ROOT, cwd, liveAgent = false, liveSession, archived = [], pinned = [], store, flush, detachEntered } = {}) {
	const workspace = {
		sessionIds: [SESSION_ID],
		async detachSession(id) {
			this.sessionIds = this.sessionIds.filter((value) => value !== id)
		}
	}
	const registry = {
		list: () => [workspace],
		archivedSessionIds: archived,
		pinnedSessionIds: pinned,
		unarchiveSession: async (id) => {
			registry.archivedSessionIds = registry.archivedSessionIds.filter((value) => value !== id)
		},
		unpinSession: async (id) => {
			registry.pinnedSessionIds = registry.pinnedSessionIds.filter((value) => value !== id)
		}
	}
	const persistence = {
		root,
		stat: async () => ({ header: cwd === undefined ? {} : { cwd } })
	}
	const agents = { get: () => (liveAgent ? { id: SESSION_ID } : undefined) }
	const sessionStore = store ?? new Map()
	const sessions = {
		get: () => liveSession,
		list: () => (liveSession === undefined ? [] : [liveSession]),
		store: sessionStore,
		flush: async () => {
			if (typeof flush === 'function') flush()
		}
	}
	if (typeof detachEntered === 'function') sessions.detachEntered = detachEntered
	return {
		workspace,
		registry,
		store: sessionStore,
		ctx: {
			get: (name) => ({ sessionPersistence: persistence, workspaceRegistry: registry, agents, sessions })[name]
		}
	}
}

/** A live in-memory session whose event log ends with the given event types. */
const liveWithEvents = (...types) => ({ snapshotEvents: () => types.map((type) => ({ type })) })

const results = []
const check = (label, condition, extra = '') => {
	results.push(`${condition ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
	if (!condition) process.exitCode = 1
}

/** Fresh root + one materialised session directory under `projectKey(cwd)`. */
async function prepare(cwd = CWD) {
	await rm(TMP, { recursive: true, force: true })
	const dir = join(ROOT, projectKey(cwd), encodeSegment(SESSION_ID))
	await mkdir(dir, { recursive: true })
	await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'log')
	return dir
}

// 1. happy path: cwd known, directory present
{
	const dir = await prepare()
	const { ctx, workspace } = makeCtx({ cwd: CWD })
	const outcome = await deleteSession(ctx, SESSION_ID)
	check('cwd path removed', !(await exists(dir)))
	check('removed list has one entry', outcome.removed.length === 1, JSON.stringify(outcome.removed))
	check('workspace accounting dropped', workspace.sessionIds.length === 0)
	check('detached flag', outcome.detached === true)
}

// 2. cwd unknown -> falls back to scanning the root's project directories
{
	await rm(TMP, { recursive: true, force: true })
	const dir = join(ROOT, projectKey('D:\\other\\project'), encodeSegment(SESSION_ID))
	await mkdir(dir, { recursive: true })
	await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'log')
	const { ctx } = makeCtx({ cwd: undefined })
	const outcome = await deleteSession(ctx, SESSION_ID)
	check('scan fallback removed', !(await exists(dir)), JSON.stringify(outcome.removed))
}

// 3. a session that never recorded a cwd lives under `_no-cwd`
{
	await rm(TMP, { recursive: true, force: true })
	const dir = join(ROOT, '_no-cwd', encodeSegment(SESSION_ID))
	await mkdir(dir, { recursive: true })
	const { ctx } = makeCtx({ cwd: 'no-such-project' })
	await deleteSession(ctx, SESSION_ID)
	check('_no-cwd fallback removed', !(await exists(dir)))
}

// 4. a live agent without a readable log is refused, and nothing is touched
{
	const dir = await prepare()
	const { ctx, workspace } = makeCtx({ cwd: CWD, liveAgent: true })
	let code = ''
	try {
		await deleteSession(ctx, SESSION_ID)
	} catch (error) {
		code = error instanceof DeleteError ? error.code : 'other'
	}
	check('running session refused', code === 'session-running', code)
	check('running session keeps files', await exists(dir))
	check('running session keeps accounting', workspace.sessionIds.length === 1)
}

// 4b. an OPEN session whose turn already ended is deletable (the common case)
{
	const dir = await prepare()
	const { ctx, workspace } = makeCtx({
		cwd: CWD,
		liveSession: liveWithEvents('turn/start', 'step/start', 'step/end', 'turn/end')
	})
	await deleteSession(ctx, SESSION_ID)
	check('idle open session removed', !(await exists(dir)))
	check('idle open session detached', workspace.sessionIds.length === 0)
}

// 4c. an OPEN session mid-turn is still refused
{
	const dir = await prepare()
	const { ctx, workspace } = makeCtx({ cwd: CWD, liveSession: liveWithEvents('turn/start', 'step/start') })
	let code = ''
	try {
		await deleteSession(ctx, SESSION_ID)
	} catch (error) {
		code = error instanceof DeleteError ? error.code : 'other'
	}
	check('mid-turn session refused', code === 'session-running', code)
	check('mid-turn session keeps files', await exists(dir))
	check('mid-turn session keeps accounting', workspace.sessionIds.length === 1)
}

// 5. archive + pin bookkeeping is cleared, unrelated ids survive
{
	await prepare()
	const { ctx, registry } = makeCtx({
		cwd: CWD,
		archived: [SESSION_ID, 'other'],
		pinned: [SESSION_ID]
	})
	await deleteSession(ctx, SESSION_ID)
	check('archive set cleaned', !registry.archivedSessionIds.includes(SESSION_ID), JSON.stringify(registry.archivedSessionIds))
	check('unrelated archive id kept', registry.archivedSessionIds.includes('other'))
	check('pin set cleaned', !registry.pinnedSessionIds.includes(SESSION_ID), JSON.stringify(registry.pinnedSessionIds))
}

// 6. a traversal-shaped id stays one path segment, and the root is never removed
{
	await mkdir(ROOT, { recursive: true })
	const { ctx } = makeCtx({ cwd: CWD })
	const segment = encodeSegment('../../etc/passwd')
	check('encodeSegment keeps traversal inside one segment', !/[/\\:]/.test(segment) && segment !== '../../etc/passwd', segment)
	check('encodeSegment special-cases dot segments', encodeSegment('..') === '~002E~002E' && encodeSegment('.') === '~002E')
	check('root itself survives a delete of a bogus id', (await deleteSession(ctx, '..')).removed.length === 0)
	check('root still exists', await exists(ROOT))
}

// 7. projectKey escapes separators and unsafe units like the persistence backend
{
	check('projectKey collapses separators', projectKey('C:\\a\\b') === projectKey('C:/a/b') && projectKey('C:\\a\\b').startsWith('--'))
	check('projectKey keeps the 255-unit cap', projectKey('x'.repeat(400)).length <= 255)
}

// 8. a live session leaves the in-memory store BEFORE its bytes go away
{
	const dir = await prepare()
	const order = []
	const store = new Map()
	store.set(SESSION_ID, {
		id: SESSION_ID,
		detach() {
			order.push('detach')
			store.delete(SESSION_ID)
		}
	})
	const { ctx } = makeCtx({
		cwd: CWD,
		liveSession: liveWithEvents('turn/start', 'turn/end'),
		store,
		flush: () => order.push('flush')
	})
	const outcome = await deleteSession(ctx, SESSION_ID)
	check('live session flushed before detach', order.join(',') === 'flush,detach', order.join(','))
	check('live session gone from store', !store.has(SESSION_ID))
	check('live session files removed', !(await exists(dir)))
	check('detachedLive reported', outcome.detachedLive === true)
}

// 9. a live session whose log is already gone is still deletable (the row
//    that could not be removed is backed by the store entry, not by the log)
{
	await rm(TMP, { recursive: true, force: true })
	await mkdir(ROOT, { recursive: true })
	const store = new Map()
	store.set(SESSION_ID, {
		id: SESSION_ID,
		detach() {
			store.delete(SESSION_ID)
		}
	})
	const { ctx, workspace } = makeCtx({ cwd: CWD, liveSession: liveWithEvents('turn/end'), store })
	const outcome = await deleteSession(ctx, SESSION_ID)
	check('log-less live session succeeds', outcome.removed.length === 0, JSON.stringify(outcome.removed))
	check('log-less live session leaves store', !store.has(SESSION_ID))
	check('log-less live session reports detach', outcome.detachedLive === true)
	check('log-less live session drops workspace row', workspace.sessionIds.length === 0)
}

// 10. the cached listing document is removed as well
{
	await prepare()
	const cacheDir = join(TMP, 'storages', 'session_projcache', 'sessions')
	await mkdir(cacheDir, { recursive: true })
	const cacheFile = join(cacheDir, SESSION_ID + '.json')
	await writeFile(cacheFile, JSON.stringify({ version: 7, record: {} }))
	const { ctx } = makeCtx({ cwd: CWD })
	const outcome = await deleteSession(ctx, SESSION_ID)
	check('projection cache document removed', !(await exists(cacheFile)))
	check('removedCache lists it', outcome.removedCache.length === 1, JSON.stringify(outcome.removedCache))
}

// 11. an entry without its own detach falls back to the store's detachEntered
{
	await rm(TMP, { recursive: true, force: true })
	await mkdir(ROOT, { recursive: true })
	const store = new Map()
	store.set(SESSION_ID, { id: SESSION_ID })
	const { ctx } = makeCtx({
		cwd: CWD,
		liveSession: liveWithEvents('turn/end'),
		store,
		detachEntered: (entry) => store.delete(entry.id)
	})
	const outcome = await deleteSession(ctx, SESSION_ID)
	check('detachEntered fallback used', !store.has(SESSION_ID) && outcome.detachedLive === true)
}

// 12. a refused mid-turn delete keeps the live entry where it was
{
	const dir = await prepare()
	const store = new Map()
	store.set(SESSION_ID, {
		id: SESSION_ID,
		detach() {
			store.delete(SESSION_ID)
		}
	})
	const { ctx } = makeCtx({ cwd: CWD, liveSession: liveWithEvents('turn/start'), store })
	let code = ''
	try {
		await deleteSession(ctx, SESSION_ID)
	} catch (error) {
		code = error instanceof DeleteError ? error.code : 'other'
	}
	check('mid-turn live session refused', code === 'session-running', code)
	check('mid-turn live session stays in store', store.has(SESSION_ID))
	check('mid-turn live session keeps files', await exists(dir))
}

await rm(TMP, { recursive: true, force: true })
console.log(results.join('\n'))
console.log(process.exitCode === 1 ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED')
