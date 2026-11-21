/**
 * dsh-session-delete — browser half.
 *
 * Adds one `删除会话` / `Delete session` row to a Session's "..." menu
 * (`sidebar.workspaces.session.menu.item`). Clicking it turns the row into an
 * inline second step, so the destructive action needs two deliberate clicks
 * and never opens a native dialog (the desktop shell renders this page on its
 * own protocol; modal dialogs there are unreliable).
 *
 * The row posts the session id to the Host route the plugin's host half serves
 * and then lets the Workspace follow stream drop the row from the sidebar.
 */
window.__ModuleLoader__.load({
	id: 'dsh-session-delete',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require('react');
		const { useEffect, useState } = React;

		/** Client locale namespace; also the slot's locale namespace. */
		const NS = 'dsh-session-delete';
		/** Where a Session's "..." menu renders its rows. */
		const SLOT = 'sidebar.workspaces.session.menu.item';
		/** Host route that performs the deletion. */
		const ROUTE = '/dsh-session-delete/delete';
		const STYLE_ID = 'dsh-session-delete-style';
		/** How long the inline confirmation stays armed. */
		const CONFIRM_WINDOW_MS = 6000;

		const zh = {
			'menu.deleteSession': '删除会话',
			'menu.confirmDelete': '再次点击确认删除',
			'menu.deleting': '正在删除…',
			'hint.irreversible': '会话日志会从磁盘移除，无法恢复。',
			'toast.deleted': '已删除会话：',
			'toast.deletedNoTitle': '会话已删除。',
			'error.session-running': '这个会话正在运行，请先停止当前回合再删除。',
			'error.session-busy': '会话文件正被占用，请先切换到其他会话再试一次。',
			'error.session-root-unknown': '找不到会话存储目录，没有删除任何文件。',
			'error.detach-failed': '会话文件已删除，但从工作区移除失败，请刷新页面后重试。',
			'error.failed': '删除失败：'
		};

		const en = {
			'menu.deleteSession': 'Delete session',
			'menu.confirmDelete': 'Click again to delete',
			'menu.deleting': 'Deleting…',
			'hint.irreversible': 'The session log is removed from disk; this cannot be undone.',
			'toast.deleted': 'Session deleted: ',
			'toast.deletedNoTitle': 'Session deleted.',
			'error.session-running': 'This session is running. Stop the current turn before deleting it.',
			'error.session-busy': 'The session files are in use. Switch to another session and try again.',
			'error.session-root-unknown': 'Cannot locate the session storage directory; no files were removed.',
			'error.detach-failed': 'The files are gone but the workspace removal failed. Refresh the page and try again.',
			'error.failed': 'Delete failed: '
		};

		const CSS = [
			'.dsh-session-delete{display:flex;flex-direction:column;gap:2px;width:100%;}',
			'.dsh-session-delete-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;',
			'border:0;border-radius:6px;background:transparent;font:inherit;font-size:13px;line-height:20px;',
			'text-align:left;cursor:pointer;color:#e5484d;}',
			'.dsh-session-delete-row:hover{background:rgba(229,72,77,.12);}',
			'.dsh-session-delete-row:focus-visible{outline:1px solid rgba(229,72,77,.65);outline-offset:-1px;}',
			'.dsh-session-delete-row[disabled]{opacity:.55;cursor:default;}',
			'.dsh-session-delete-row[data-phase="confirm"]{background:rgba(229,72,77,.16);font-weight:600;}',
			'.dsh-session-delete-hint{padding:0 10px 4px;font-size:11px;line-height:16px;color:#e5484d;opacity:.85;}',
			'.dsh-session-delete-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483000;',
			'max-width:min(560px,calc(100vw - 48px));padding:9px 14px;border-radius:10px;font:inherit;font-size:13px;',
			'line-height:20px;box-shadow:0 8px 28px rgba(0,0,0,.28);word-break:break-word;}',
			'.dsh-session-delete-toast[data-kind="ok"]{background:#1f7a48;color:#f2fff7;}',
			'.dsh-session-delete-toast[data-kind="error"]{background:#b3282d;color:#fff4f4;}',
			'.dsh-session-delete-toast[hidden]{display:none;}'
		].join('');

		/**
		 * Window-level feedback. The session menu unmounts as soon as the pointer
		 * leaves it (and a successful delete closes it), so an error rendered only
		 * inside the row can vanish before it is read — which is exactly how this
		 * feature first looked like "the click does nothing". A body-level toast
		 * outlives the menu, and needed no react-dom in this bundle.
		 */
		let toastTimer = null;
		function showToast(kind, text) {
			if (typeof document === 'undefined' || !document.body) return;
			let host = document.getElementById('dsh-session-delete-toast');
			if (!host) {
				host = document.createElement('div');
				host.id = 'dsh-session-delete-toast';
				host.className = 'dsh-session-delete-toast';
				host.setAttribute('role', kind === 'error' ? 'alert' : 'status');
				document.body.appendChild(host);
			}
			host.textContent = text;
			host.dataset.kind = kind;
			host.hidden = false;
			if (toastTimer !== null) clearTimeout(toastTimer);
			toastTimer = setTimeout(() => {
				host.hidden = true;
				toastTimer = null;
			}, kind === 'ok' ? 3200 : 9000);
		}

		/** Resolve a route against the page's own base URI, like the shipped plugins do. */
		function apiPath(path) {
			const relative = String(path).replace(/^\/+/, '');
			if (typeof document === 'undefined' || typeof document.baseURI !== 'string') return '/' + relative;
			try {
				return new URL(relative, document.baseURI).pathname;
			} catch {
				return '/' + relative;
			}
		}

		async function requestDelete(sessionId) {
			const response = await fetch(apiPath(ROUTE), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ sessionId }),
				cache: 'no-store'
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (!response.ok || payload?.ok !== true) {
				const error = new Error(payload?.error ?? ('HTTP ' + response.status));
				error.code = payload?.code;
				throw error;
			}
			return payload;
		}

		/** Client context, captured so the row can nudge the inventory after a delete. */
		let clientCtx = null;

		/** The follow stream removes the sidebar row; this only refreshes projections. */
		function refreshAfterDelete() {
			try {
				const sessions = clientCtx && typeof clientCtx.get === 'function' ? clientCtx.get('sessions') : undefined;
				if (sessions && typeof sessions.refresh === 'function') sessions.refresh();
			} catch {
				/* a missing refresh is not a deletion failure */
			}
		}

		function DeleteSessionRow(props) {
			const sessionId = String(props.sessionId);
			const translate = typeof props.t === 'function' ? props.t : (key) => key;
			const menuOpenState = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : undefined;
			const setMenuOpen = Array.isArray(menuOpenState) ? menuOpenState[1] : undefined;

			/** 'idle' → 'confirm' → 'busy'; a failure lands in 'error'. */
			const [phase, setPhase] = useState('idle');
			const [failure, setFailure] = useState('');

			// Disarm the confirmation when the click was a mistake or the menu closed.
			useEffect(() => {
				if (phase !== 'confirm') return undefined;
				const timer = setTimeout(() => setPhase('idle'), CONFIRM_WINDOW_MS);
				return () => clearTimeout(timer);
			}, [phase]);

			const message = (error) => {
				const code = typeof error?.code === 'string' ? error.code : '';
				const key = code.length > 0 ? 'error.' + code : '';
				const localized = key.length > 0 ? translate(key) : '';
				if (localized.length > 0 && localized !== key) return localized;
				return translate('error.failed') + String(error?.message ?? error);
			};

			const run = () => {
				setPhase('busy');
				setFailure('');
				requestDelete(sessionId)
					.then(() => {
						// The workspace follow stream drops the row; closing the menu keeps
						// the pointer's focus in the sidebar.
						const title = typeof props.displayTitle === 'string' ? props.displayTitle.trim() : '';
						showToast('ok', title.length > 0 ? translate('toast.deleted') + title : translate('toast.deletedNoTitle'));
						if (typeof setMenuOpen === 'function') setMenuOpen(false);
						refreshAfterDelete();
					})
					.catch((error) => {
						const text = message(error);
						setFailure(text);
						setPhase('error');
						showToast('error', text);
					});
			};

			const onSelect = (event) => {
				if (event) {
					event.preventDefault();
					event.stopPropagation();
				}
				if (phase === 'busy') return;
				if (phase === 'idle' || phase === 'error') {
					setFailure('');
					setPhase('confirm');
					return;
				}
				run();
			};

			const label = phase === 'confirm'
				? translate('menu.confirmDelete')
				: phase === 'busy'
					? translate('menu.deleting')
					: translate('menu.deleteSession');

			return React.createElement(
				'div',
				{ className: 'dsh-session-delete' },
				React.createElement(
					'button',
					{
						type: 'button',
						role: 'menuitem',
						className: 'dsh-session-delete-row',
						'data-phase': phase,
						'aria-describedby': phase === 'confirm' ? 'dsh-session-delete-hint' : undefined,
						disabled: phase === 'busy',
						onClick: onSelect
					},
					label
				),
				phase === 'confirm'
					? React.createElement('div', { className: 'dsh-session-delete-hint', id: 'dsh-session-delete-hint' }, translate('hint.irreversible'))
					: null,
				phase === 'error' && failure.length > 0
					? React.createElement('div', { className: 'dsh-session-delete-hint', role: 'alert' }, failure)
					: null
			);
		}

		function installStyle() {
			if (typeof document === 'undefined') return () => {};
			if (document.getElementById(STYLE_ID)) return () => {};
			const style = document.createElement('style');
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
			return () => {
				if (style.parentNode) style.parentNode.removeChild(style);
			};
		}

		function apply(ctx) {
			clientCtx = ctx;
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-session-delete: dictionaries');
			ctx.effect(() => installStyle(), 'dsh-session-delete: style');
			ctx.effect(
				() => ctx.slots.inject(SLOT, () => ctx.slots.register({
					name: SLOT,
					id: 'delete-session',
					order: 500,
					locale: NS,
					inject: () => ({ t: ctx.locale.bind(NS) })
				}, DeleteSessionRow)),
				'dsh-session-delete: menu row'
			);
		}

		exports.name = 'dsh-session-delete';
		exports.inject = ['slots', 'locale'];
		exports.apply = apply;
		return module.exports;
	}
});
