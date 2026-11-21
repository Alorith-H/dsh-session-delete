/**
 * dsh-session-delete — host half.
 *
 * DSH ships archive but never delete: a conversation's JSONL log under
 * `<session root>/<project key>/<session id>/` accumulates forever. This plugin
 * adds the missing operation and keeps it on the Host:
 *
 *   1. refuse while a turn is still open on the session;
 *   2. remove the session's on-disk directory (the durable log);
 *   3. drop the session from its Workspace's `sessionIds` accounting so the
 *      sidebar row disappears;
 *   4. clear the registry-global archive/pin bookkeeping so no stale id
 *      survives the removal.
 *
 * The browser half (client.js) calls the one POST route registered here; the
 * route asks Connection's own request gate first, exactly like the shipped
 * routes do.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const name = 'dsh-session-delete'
export const inject = ['webServer']

/** Route the client row posts one deletion to. */
export const ROUTE_PATH = '/dsh-session-delete/delete'

/** A SessionId is an unvalidated branded string; only path-safe ones are accepted. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/
const MAX_BODY_BYTES = 16 * 1024
const MAX_PROJECT_DIRECTORIES = 4096

/** One refused deletion, with the HTTP status and machine-readable code. */
export class DeleteError extends Error {
	constructor(code, message, status = 500) {
		super(message)
		this.name = 'DeleteError'
		this.code = code
		this.status = status
	}
}

function sendJson(response, status, payload) {
	response.writeHead(status, {
		'cache-control': 'no-store',
		'content-type': 'application/json; charset=utf-8'
	})
	response.end(JSON.stringify(payload))
}

async function readJsonBody(request) {
	const chunks = []
	let total = 0
	for await (const chunk of request) {
		total += chunk.length
		if (total > MAX_BODY_BYTES) throw new DeleteError('body-too-large', '请求体过大。', 413)
		chunks.push(chunk)
	}
	if (total === 0) return undefined
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} catch {
		throw new DeleteError('bad-request', '请求体不是合法 JSON。', 400)
	}
}

/**
 * Encode an arbitrary string as one safe path segment — the same injective
 * `~XXXX` escaping dsh-session-persistence-jsonl uses, so the directory we
 * remove is exactly the one the backend writes.
 */
export function encodeSegment(raw) {
	if (raw === '.') return '~002E'
	if (raw === '..') return '~002E~002E'
	let out = ''
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i)
		const ch = String.fromCharCode(code)
		if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
		else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
	}
	return out
}

/** The human-navigable project directory key for one session cwd. */
export function projectKey(cwd) {
	let readable = ''
	let separatorRun = false
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i)
		const ch = String.fromCharCode(code)
		if (ch === '/' || ch === '\\' || ch === ':') {
			if (!separatorRun) readable += '-'
			separatorRun = true
		} else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch
			separatorRun = false
		} else {
			readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
			separatorRun = false
		}
	}
	return '--' + ((readable.replace(/^-+/, '')) || 'root').slice(0, 251) + '--'
}

/** Resolve the session storage root the running persistence backend writes to. */
function sessionRoot(persistence) {
	const looksPath = (value) => typeof value === 'string' && value.trim().length > 0
	try {
		if (looksPath(persistence?.root)) return resolve(persistence.root)
	} catch {
		/* a getter that throws is simply not an answer */
	}
	try {
		if (looksPath(persistence?.config?.root)) return resolve(persistence.config.root)
	} catch {
		/* same */
	}
	if (looksPath(process.env.DSH_HOME)) return resolve(join(process.env.DSH_HOME, 'sessions'))
	return undefined
}

async function isDirectory(path) {
	try {
		return (await stat(path)).isDirectory()
	} catch {
		return false
	}
}

/** Translate a locked/inaccessible file into the one refusal the UI can explain. */
function classifyRemovalError(error) {
	const code = typeof error?.code === 'string' ? error.code : ''
	if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY') {
		return new DeleteError(
			'session-busy',
			'会话文件正被占用，请先切换到其他会话再试一次。（Perhaps the session is open right now.）',
			409
		)
	}
	return new DeleteError('delete-failed', '删除会话文件失败：' + String(error?.message ?? error), 500)
}

async function removeDirectory(target, root) {
	const absolute = resolve(target)
	const base = resolve(root)
	const inside = absolute !== base
		&& (absolute.startsWith(base + '\\') || absolute.startsWith(base + '/'))
	if (!inside) {
		// Never remove the storage root itself, whatever the caller derived.
		throw new DeleteError('delete-failed', '拒绝删除会话根目录或其之外的路径：' + absolute, 500)
	}
	try {
		await rm(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 80 })
	} catch (error) {
		throw classifyRemovalError(error)
	}
	return absolute
}

/**
 * Remove the durable artifacts of one session.
 *
 * The directory name is derived from the recorded cwd when there is one; a
 * missing/unknown cwd falls back to `_no-cwd` and, failing that, to a bounded
 * scan of the root's project directories for the exact encoded session id.
 */
async function removeArtifacts(root, sessionId, cwd) {
	const segment = encodeSegment(sessionId)
	const removed = []

	if (typeof cwd === 'string' && cwd.length > 0) {
		const primary = join(root, projectKey(cwd), segment)
		if (await isDirectory(primary)) {
			removed.push(await removeDirectory(primary, root))
			return removed
		}
	}

	const noCwd = join(root, '_no-cwd', segment)
	if (await isDirectory(noCwd)) {
		removed.push(await removeDirectory(noCwd, root))
		return removed
	}

	let entries = []
	try {
		entries = await readdir(root, { withFileTypes: true })
	} catch (error) {
		throw new DeleteError('session-root-unknown', '读不到会话存储目录：' + String(error?.message ?? error), 500)
	}
	for (const entry of entries.slice(0, MAX_PROJECT_DIRECTORIES)) {
		if (!entry.isDirectory()) continue
		const candidate = join(root, entry.name, segment)
		if (await isDirectory(candidate)) removed.push(await removeDirectory(candidate, root))
	}
	return removed
}

/** Read an optional Host service; a missing or refusing provider is just "absent". */
function service(ctx, key) {
	try {
		return typeof ctx?.get === 'function' ? ctx.get(key) : undefined
	} catch {
		return undefined
	}
}

function listWorkspaces(registry) {
	try {
		const workspaces = registry?.list?.()
		return Array.isArray(workspaces) ? workspaces : []
	} catch {
		return []
	}
}

/**
 * Is a turn still open on this live session?
 *
 * An *open* session is not the same as a *running* one: DSH keeps a session in
 * the in-memory store whenever a panel shows it, and deleting the conversation
 * you are looking at is the common case. Only an unterminated turn means the
 * log is being written right now, so only that refuses.
 */
function turnInProgress(session) {
	try {
		const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : undefined
		if (!Array.isArray(events)) return true
		let open = false
		for (const event of events) {
			if (event?.type === 'turn/start') open = true
			else if (event?.type === 'turn/end') open = false
		}
		return open
	} catch {
		/* an unreadable log counts as running: refuse rather than race it */
		return true
	}
}

/**
 * Take one session out of the in-memory store.
 *
 * The sidebar row is backed by the live store entry, not only by the log file:
 * `session.list` reports a live session with no persisted log as a still-pending
 * conversation, so deleting the bytes alone leaves a row that can never be
 * removed again (the log is already gone, the entry is not). The store keeps
 * one entry per live session and each entry owns the detach capability that
 * removes it and emits the paired `session/disposed`; `sessions` exposes no
 * public detach, so use that entry, then fall back to the store map.
 *
 * @returns whether a live entry was found and removed.
 */
function detachLiveSession(sessions, sessionId) {
	let store
	try {
		store = sessions?.store
	} catch {
		store = undefined
	}
	if (!(store instanceof Map)) return false
	const entry = store.get(sessionId)
	if (entry === undefined) return false
	try {
		if (typeof entry.detach === 'function') {
			entry.detach()
			return true
		}
		if (typeof sessions.detachEntered === 'function') {
			sessions.detachEntered(entry)
			return true
		}
		store.delete(sessionId)
		return true
	} catch {
		return false
	}
}

/** Wait one macrotask so disposal-triggered writers settle before files disappear. */
function settle() {
	return new Promise((resolve) => setTimeout(resolve, 25))
}

/**
 * The projection-cache document the Host writes for one session. The cache is
 * a derived listing hint, but a stale document with no log left behind is one
 * more durable artifact of a conversation that no longer exists.
 */
function projectionCacheRecord(persistence, root, sessionId) {
	const candidates = []
	try {
		if (typeof persistence?.config?.root === 'string') {
			candidates.push(join(persistence.config.root, '..', 'storages', 'session_projcache', 'sessions'))
		}
	} catch {
		/* getter refused: try the derived layout */
	}
	const home = join(root, '..')
	candidates.push(join(home, 'storages', 'session_projcache', 'sessions'))
	if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
		candidates.push(join(process.env.DSH_HOME, 'storages', 'session_projcache', 'sessions'))
	}
	return candidates.map((directory) => join(resolve(directory), sessionId + '.json'))
}

/** Remove the session's cached listing document; a missing or locked one is not a failure. */
async function removeProjectionCacheRecord(persistence, root, sessionId) {
	const removed = []
	for (const path of projectionCacheRecord(persistence, root, sessionId)) {
		if (!(await isFile(path))) continue
		try {
			await rm(path, { force: true })
			removed.push(path)
		} catch {
			/* derived data: a stale document is harmless, never a refused deletion */
		}
	}
	return removed
}

async function isFile(path) {
	try {
		return (await stat(path)).isFile()
	} catch {
		return false
	}
}

/**
 * Delete one conversation. This is the single implementation both the UI row
 * and any future agent tool would call.
 *
 * @returns the removed directories and the cwd the artifacts were found under.
 */
export async function deleteSession(ctx, sessionId) {
	const persistence = service(ctx, 'sessionPersistence')
	const registry = service(ctx, 'workspaceRegistry')
	const agents = service(ctx, 'agents')
	const sessions = service(ctx, 'sessions')

	// 1. Never pull the files out from under a running turn.
	const liveSession = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
	if (liveSession !== undefined && liveSession !== null) {
		if (turnInProgress(liveSession)) {
			throw new DeleteError('session-running', '这个会话正在运行，请先停止当前回合再删除。', 409)
		}
	} else {
		let liveAgent
		try {
			liveAgent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
		} catch {
			liveAgent = undefined
		}
		if (liveAgent !== undefined && liveAgent !== null) {
			throw new DeleteError('session-running', '这个会话正在运行，请先停止当前回合再删除。', 409)
		}
	}

	// 2. Where the log lives: the persistence snapshot knows the session cwd.
	let cwd
	try {
		const snapshot = typeof persistence?.stat === 'function' ? await persistence.stat(sessionId) : undefined
		cwd = snapshot?.header?.cwd
	} catch {
		cwd = undefined
	}

	// 3. A live session must leave the store BEFORE its bytes go away: the
	//    disposal path flushes the session, so flushing first (and letting the
	//    detach settle) keeps a farewell write from recreating the log after we
	//    deleted it. The row itself is that store entry — see detachLiveSession.
	let detachedLive = false
	if (liveSession !== undefined && liveSession !== null) {
		try {
			if (typeof sessions.flush === 'function') await sessions.flush(liveSession)
		} catch {
			/* a session whose log is already gone cannot flush; deletion still proceeds */
		}
		detachedLive = detachLiveSession(sessions, sessionId)
		if (detachedLive) await settle()
	}

	const root = sessionRoot(persistence)
	if (root === undefined) {
		throw new DeleteError('session-root-unknown', '找不到会话存储目录，没有删除任何文件。', 500)
	}

	// 4. Remove the bytes. A session that is already gone on disk is not a
	//    failure: the live entry was the last thing keeping the row visible.
	const removed = await removeArtifacts(root, sessionId, cwd)
	const removedCache = await removeProjectionCacheRecord(persistence, root, sessionId)

	// 5. Unaccount it from its workspace.
	let detachedFrom
	for (const workspace of listWorkspaces(registry)) {
		const sessionIds = workspace?.sessionIds
		if (!Array.isArray(sessionIds) || !sessionIds.includes(sessionId)) continue
		if (typeof workspace.detachSession !== 'function') continue
		try {
			await workspace.detachSession(sessionId)
			detachedFrom = workspace
		} catch (error) {
			throw new DeleteError(
				'detach-failed',
				'会话文件已删除，但从工作区移除失败：' + String(error?.message ?? error),
				500
			)
		}
		break
	}

	// 6. Drop stale archive/pin ids. Both calls are idempotent no-ops for an id
	//    that is not in the set, but only call them when the set has it.
	const archived = Array.isArray(registry?.archivedSessionIds) ? registry.archivedSessionIds : []
	if (archived.includes(sessionId) && typeof registry?.unarchiveSession === 'function') {
		try {
			await registry.unarchiveSession(sessionId)
		} catch {
			/* the id is going away anyway; a stale array entry is harmless */
		}
	}
	const pinned = Array.isArray(registry?.pinnedSessionIds) ? registry.pinnedSessionIds : []
	if (pinned.includes(sessionId) && typeof registry?.unpinSession === 'function') {
		try {
			await registry.unpinSession(sessionId)
		} catch {
			/* same */
		}
	}

	return {
		sessionId,
		removed,
		cwd,
		detached: detachedFrom !== undefined,
		detachedLive,
		removedCache
	}
}

/** Apply Connection's Host/Origin fence and browser login to our route. */
function refused(request, ctx) {
	try {
		const connection = service(ctx, 'connection')
		if (typeof connection?.requestRejection !== 'function') return undefined
		return connection.requestRejection(request)
	} catch {
		return 403
	}
}

async function handleRequest(ctx, request, response) {
	const rejection = refused(request, ctx)
	if (rejection !== undefined) {
		sendJson(response, rejection, { ok: false, code: 'refused', error: '请求未被授权。（Request refused.）' })
		return
	}

	if (request.method !== 'POST') {
		response.writeHead(405, { allow: 'POST' })
		response.end()
		return
	}
	const contentType = String(request.headers['content-type'] ?? '').toLowerCase()
	if (!contentType.startsWith('application/json')) {
		sendJson(response, 415, { ok: false, code: 'bad-request', error: '需要 application/json 请求体。' })
		return
	}

	let body
	try {
		body = await readJsonBody(request)
	} catch (error) {
		sendJson(response, error?.status ?? 400, {
			ok: false,
			code: error?.code ?? 'bad-request',
			error: String(error?.message ?? error)
		})
		return
	}

	const sessionId = body?.sessionId
	if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) {
		sendJson(response, 400, { ok: false, code: 'bad-session-id', error: '会话 ID 不合法。' })
		return
	}

	try {
		const outcome = await deleteSession(ctx, sessionId)
		sendJson(response, 200, { ok: true, ...outcome })
	} catch (error) {
		const status = error instanceof DeleteError ? error.status : 500
		const code = error instanceof DeleteError ? error.code : 'delete-failed'
		const message = String(error?.message ?? error)
		if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('dsh-session-delete: %s failed: %s', sessionId, message)
		sendJson(response, status, { ok: false, code, error: message })
	}
}

export function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: ROUTE_PATH,
		handler: (request, response) => handleRequest(ctx, request, response)
	}))
	if (typeof ctx.logger?.info === 'function') ctx.logger.info('dsh-session-delete: mounted %s (1.1.0, live-session detach)', ROUTE_PATH)
}
