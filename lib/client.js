/**
 * dsh-plugin-simple-delete-session — browser half.
 *
 * Adds one row to the sidebar session menu ("..." → 删除会话 / Delete session)
 * and one confirmation dialog. Nothing else in the shell is touched: the menu
 * row is a first-class occupant of `sidebar.workspaces.session.menu.item`, so
 * it inherits the shipped menu's styling, keyboard walk and focus return; the
 * dialog lives in `shell.overlay`, the frame-wide floating layer.
 *
 * Flow: menu row → dialog (shows the session title and id, warns when the
 * session is running) → the user ticks the acknowledgement → 删除 → the host
 * route erases the session's own log directory and its durable accounting.
 * There is no undo and no trash: the dialog says so before it does anything.
 *
 * Bundle format: the client-modules protocol. `window.__ModuleLoader__.load`
 * registers a lazy CommonJS factory whose `require` resolves against the
 * shell's own module table — no bundler, no duplicate React, no runtime
 * dependency on another feature package. Only `react` is required, and the
 * optional primitives below are read defensively so a shell that does not ship
 * them still gets a working (in-house styled) UI.
 */
/* eslint-disable no-undef -- browser bundle: React and the shell loader are globals here. */
if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) {
  window.__ModuleLoader__.load({
    id: 'dsh-plugin-simple-delete-session',
    factory: (require) => {
    const React = require('react')

    /** Optional shell primitives; the bundle must work without them. */
    let primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives') ?? {}
    } catch {
      primitives = {}
    }
    const MenuItemButton = typeof primitives.MenuItemButton === 'function' ? primitives.MenuItemButton : null

    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const OVERLAY_SLOT = 'shell.overlay'
    const MENU_ID = 'dsh-session-delete'
    const DIALOG_ID = 'dsh-session-delete-dialog'
    const MENU_ORDER = 900
    /** Bumped on every client-side change; the first trace line reports it, so a
     *  stale page (loaded before the last refresh) is obvious in the log. */
    const CLIENT_REVISION = '0.2.0'
    /** Host route registered by src/index.js. */
    const DELETE_PATH = '/plugins/dsh-plugin-simple-delete-session/delete'
    const NS = 'dsh-session-delete'

    const zh = {
      'menu.delete': '删除会话',
      'dialog.title': '彻底删除这个会话？',
      'dialog.warning': '删除后无法恢复，DSH 不提供回收站，也无法找回这段对话。',
      'dialog.detail': '将删除该会话在本机的全部记录：会话日志、投影缓存与工作区记账。其他会话不受影响。',
      'dialog.session': '会话',
      'dialog.untitled': '（未命名会话）',
      'dialog.id': '会话 id',
      'dialog.running': '该会话正在处理消息。确认删除会先停止当前回合，再进行删除。',
      'dialog.ack': '我已了解：删除后无法找回。',
      'dialog.cancel': '取消',
      'dialog.confirm': '确认删除',
      'dialog.confirmRunning': '停止并删除',
      'dialog.working': '正在删除…',
      'dialog.done': '会话已彻底删除。',
      'dialog.failed': '删除失败',
    }

    const en = {
      'menu.delete': 'Delete session',
      'dialog.title': 'Permanently delete this session?',
      'dialog.warning': 'This cannot be undone. DSH has no trash, and the conversation cannot be recovered.',
      'dialog.detail': 'It removes every local record of this session: its log, its projection cache and its workspace accounting. Other sessions are not affected.',
      'dialog.session': 'Session',
      'dialog.untitled': '(untitled session)',
      'dialog.id': 'Session id',
      'dialog.running': 'This session is processing a message. Confirming stops the current turn before deleting.',
      'dialog.ack': 'I understand this cannot be recovered.',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete',
      'dialog.confirmRunning': 'Stop and delete',
      'dialog.working': 'Deleting…',
      'dialog.done': 'The session was permanently deleted.',
      'dialog.failed': 'Delete failed',
    }

    let localeService = null

    /** @returns the active locale id ('zh' fallback). */
    function activeLocale() {
      try {
        const snapshot = localeService?.getLocale?.()
        const id = snapshot?.id ?? snapshot?.locale
        if (typeof id === 'string' && id !== '') return id.toLowerCase().startsWith('en') ? 'en' : 'zh'
      } catch {
        // fall through to the browser language
      }
      const tag = typeof navigator !== 'undefined' ? navigator.language : 'zh'
      return typeof tag === 'string' && tag.toLowerCase().startsWith('en') ? 'en' : 'zh'
    }

    /**
     * Translate one key.
     * @param key - dictionary key.
     * @param params - `{ name }` placeholders.
     * @returns localized text, falling back to zh and then the key.
     */
    function text(key, params) {
      const dictionary = activeLocale() === 'en' ? en : zh
      const template = dictionary[key] ?? zh[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /** Re-render on locale switches so an already-open menu/dialog follows. */
    function useLocaleRevision() {
      const [revision, setRevision] = React.useState(0)
      React.useEffect(() => {
        if (typeof localeService?.subscribe !== 'function') return undefined
        return localeService.subscribe(() => setRevision((value) => value + 1))
      }, [])
      return revision
    }

    const styles = {
      dialogLayer: {
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.42)',
      },
      dialog: {
        width: 'min(460px, calc(100vw - 48px))',
        boxSizing: 'border-box',
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.28))',
        background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff))',
        color: 'var(--dsw-alias-label-primary, inherit)',
        boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)',
        padding: '18px 20px 16px',
        fontSize: 14,
        lineHeight: '22px',
      },
      title: { fontSize: 16, fontWeight: 600, lineHeight: '24px', margin: '0 0 10px' },
      warning: {
        color: 'var(--dsw-alias-state-error-primary, #e5484d)',
        fontWeight: 500,
        margin: '0 0 8px',
      },
      detail: { color: 'var(--dsw-alias-label-secondary, #8a8a8e)', fontSize: 13, margin: '0 0 12px' },
      meta: {
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))',
        borderRadius: 8,
        padding: '8px 10px',
        margin: '0 0 12px',
        background: 'var(--dsw-alias-bg-layer-2, transparent)',
        fontSize: 13,
      },
      metaRow: { display: 'flex', gap: 8, lineHeight: '20px' },
      metaKey: { color: 'var(--dsw-alias-label-tertiary, #9a9a9f)', flex: 'none', minWidth: 68 },
      metaValue: { minWidth: 0, wordBreak: 'break-all' },
      running: { color: 'var(--dsw-alias-state-warn-primary, #f5a524)', fontSize: 13, margin: '0 0 10px' },
      ack: { display: 'flex', alignItems: 'flex-start', gap: 8, margin: '0 0 14px', cursor: 'pointer' },
      ackText: { fontSize: 13, lineHeight: '20px' },
      error: {
        color: 'var(--dsw-alias-state-error-primary, #e5484d)',
        fontSize: 13,
        margin: '0 0 12px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      footer: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
      button: {
        font: 'inherit',
        fontSize: 13,
        lineHeight: '20px',
        padding: '6px 14px',
        borderRadius: 8,
        cursor: 'pointer',
        border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.4))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      buttonDanger: {
        border: '1px solid var(--dsw-alias-state-error-primary, #e5484d)',
        background: 'var(--dsw-alias-state-error-primary, #e5484d)',
        color: '#ffffff',
      },
      buttonDisabled: { opacity: 0.5, cursor: 'default' },
    }

    /** Destructive copy colour, shared by both menu-row implementations. */
    const dangerTextStyle = { color: 'var(--dsw-alias-state-error-primary, #e5484d)' }

    /** `{ ...style, ...(disabled ? styles.buttonDisabled : null) }` helper. */
    function withDisabled(style, disabled) {
      return disabled === true ? { ...style, ...styles.buttonDisabled } : style
    }

    /** Inline trash glyph (no dependency on a shipped icon export). */
    function TrashIcon(props) {
      const size = props?.size ?? 16
      return React.createElement('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { flex: 'none' },
      }, React.createElement('path', {
        d: 'M6.5 1.5h3a1 1 0 0 1 1 1V3h3a0.75 0.75 0 0 1 0 1.5h-0.7l-0.6 8.05A2 2 0 0 1 10.21 14.5H5.79a2 2 0 0 1-1.99-1.95L3.2 4.5H2.5a0.75 0.75 0 0 1 0-1.5h3V2.5a1 1 0 0 1 1-1Zm0.5 1.5h2V3H7v0Zm-2.03 1.5 0.58 7.95a0.5 0.5 0 0 0 0.5 0.55h4.4a0.5 0.5 0 0 0 0.5-0.55l0.58-7.95H4.97ZM6.4 6.2v4.6a0.6 0.6 0 0 0 1.2 0V6.2a0.6 0.6 0 0 0-1.2 0Zm2 0v4.6a0.6 0.6 0 0 0 1.2 0V6.2a0.6 0.6 0 0 0-1.2 0Z',
        fill: 'currentColor',
      }))
    }

    /**
     * One menu row of the sidebar session menu. It renders as
     * `role="menuitem"` and closes the menu through the slot's
     * `useMenuOpenState` hook, so keyboard navigation and focus return keep
     * working exactly like the shipped rows.
     */
    function DeleteSessionMenuItem(props) {
      useLocaleRevision()
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : null
      const displayTitle = typeof props?.displayTitle === 'string' && props.displayTitle.trim() !== ''
        ? props.displayTitle
        : null
      const closeMenu = useMenuCloser(props?.useMenuOpenState)

      const onSelect = React.useCallback(() => {
        closeMenu()
        if (sessionId === null) return
        window.dispatchEvent(new CustomEvent('dsh-session-delete:open', {
          detail: { sessionId, title: displayTitle },
        }))
      }, [closeMenu, sessionId, displayTitle])

      const label = text('menu.delete')

      if (MenuItemButton !== null) {
        // The danger colour rides the shared style object rather than an
        // optional prop of the shipped primitive; `separatorBefore` is the
        // documented way for a plugin row to open its own group.
        return React.createElement(MenuItemButton, {
          separatorBefore: true,
          onSelect,
          style: dangerTextStyle,
        }, React.createElement(TrashIcon, { size: 16 }), label)
      }
      return React.createElement('button', {
        type: 'button',
        role: 'menuitem',
        onClick: onSelect,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '6px 12px',
          border: 'none',
          background: 'transparent',
          color: 'var(--dsw-alias-state-error-primary, #e5484d)',
          font: 'inherit',
          fontSize: 13,
          lineHeight: '20px',
          textAlign: 'left',
          borderRadius: 6,
          cursor: 'pointer',
        },
      }, React.createElement(TrashIcon, { size: 16 }), label)
    }

    /**
     * Adapt the slot's menu-state hook (a `[state, setState]` pair) into a
     * close callback that works with either the pair or a bare function.
     */
    function useMenuCloser(useMenuOpenState) {
      const state = typeof useMenuOpenState === 'function' ? useMenuOpenState() : null
      return React.useCallback(() => {
        try {
          if (Array.isArray(state) && typeof state[1] === 'function') state[1](false)
          else if (state !== null && typeof state?.close === 'function') state.close()
          else if (typeof state === 'function') state(false)
        } catch {
          // Closing is cosmetic: the dialog is already anchored to the viewport.
        }
      }, [state])
    }

    /** One `key: value` line of the dialog's session card. */
    function MetaRow({ label, value }) {
      return React.createElement('div', { style: styles.metaRow },
        React.createElement('span', { style: styles.metaKey }, label),
        React.createElement('span', { style: styles.metaValue }, value))
    }

    /**
     * The confirmation dialog. It is a `shell.overlay` occupant listening for
     * the menu row's open event, so every entry point shares exactly one
     * dialog and the sidebar row never has to navigate anywhere.
     */
    function DeleteSessionDialog() {
      useLocaleRevision()
      const [target, setTarget] = React.useState(null)
      const [acknowledged, setAcknowledged] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      /** Mirrors `busy` for callbacks that must not read stale closures. */
      const busyRef = React.useRef(false)
      React.useEffect(() => { busyRef.current = busy }, [busy])

      React.useEffect(() => {
        const onOpen = (event) => {
          const detail = event?.detail ?? {}
          if (typeof detail.sessionId !== 'string' || detail.sessionId === '') return
          setTarget({
            sessionId: detail.sessionId,
            title: typeof detail.title === 'string' && detail.title.trim() !== '' ? detail.title : null,
            running: false,
          })
          setAcknowledged(false)
          setError(null)
          setBusy(false)
          // Ask the host whether the session is running, so the dialog can warn
          // before the user commits to anything.
          request({ sessionId: detail.sessionId, action: 'describe' })
            .then((info) => {
              if (info?.ok !== true) return
              setTarget((current) => (current !== null && current.sessionId === detail.sessionId
                ? { ...current, running: info.running === true, title: current.title ?? info.title ?? null }
                : current))
            })
            .catch(() => { /* the dialog works without the extra detail */ })
        }
        window.addEventListener('dsh-session-delete:open', onOpen)
        return () => window.removeEventListener('dsh-session-delete:open', onOpen)
      }, [])

      const close = React.useCallback(() => {
        if (busyRef.current === true) return
        setTarget(null)
        setError(null)
      }, [])

      const confirm = React.useCallback(() => {
        if (target === null || acknowledged !== true) return
        // Remember whether the session being deleted is the one on screen: its
        // mirror entry still exists right now, so this is the only reliable
        // moment to answer "do we need to navigate away afterwards?".
        const deletedCurrent = currentSessionId() === target.sessionId
        setBusy(true)
        setError(null)
        request({ sessionId: target.sessionId, force: true, action: 'delete' })
          .then((result) => {
            if (result?.ok !== true) {
              setBusy(false)
              setError(result?.error ?? text('dialog.failed'))
              return
            }
            setTarget(null)
            setBusy(false)
            refreshShell()
            notify(text('dialog.done'))
            if (deletedCurrent) goToPreviousSession(target.sessionId)
          })
          .catch((reason) => {
            setBusy(false)
            setError(String(reason?.message ?? reason))
          })
      }, [acknowledged, target])

      if (target === null) return null

      const deleteLabel = target.running ? text('dialog.confirmRunning') : text('dialog.confirm')
      const blocked = busy || !acknowledged

      return React.createElement('div', {
        style: styles.dialogLayer,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) close()
        },
      }, React.createElement('div', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': text('dialog.title'),
        style: styles.dialog,
        onMouseDown: (event) => event.stopPropagation(),
        onKeyDown: (event) => {
          if (event.key === 'Escape') close()
        },
      },
      React.createElement('div', { style: styles.title }, text('dialog.title')),
      React.createElement('div', { style: styles.warning }, `⚠ ${text('dialog.warning')}`),
      React.createElement('div', { style: styles.detail }, text('dialog.detail')),
      React.createElement('div', { style: styles.meta },
        React.createElement(MetaRow, { label: text('dialog.session'), value: target.title ?? text('dialog.untitled') }),
        React.createElement(MetaRow, { label: text('dialog.id'), value: target.sessionId })),
      target.running ? React.createElement('div', { style: styles.running }, text('dialog.running')) : null,
      React.createElement('label', { style: styles.ack },
        React.createElement('input', {
          type: 'checkbox',
          checked: acknowledged,
          disabled: busy,
          onChange: (event) => setAcknowledged(event.target.checked === true),
        }),
        React.createElement('span', { style: styles.ackText }, text('dialog.ack'))),
      error !== null ? React.createElement('div', { style: styles.error, role: 'alert' }, error) : null,
      React.createElement('div', { style: styles.footer },
        React.createElement('button', {
          type: 'button',
          style: withDisabled(styles.button, busy),
          disabled: busy,
          onClick: close,
        }, text('dialog.cancel')),
        React.createElement('button', {
          type: 'button',
          style: withDisabled({ ...styles.button, ...styles.buttonDanger }, blocked),
          disabled: blocked,
          onClick: confirm,
        }, busy ? text('dialog.working') : deleteLabel))))
    }

    /**
     * POST one action to the host route (registered by src/index.js).
     * @param body - `{ sessionId, action, force? }`.
     * @returns the parsed JSON result.
     */
    async function request(body) {
      const response = await fetch(DELETE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null || typeof payload !== 'object') {
        return { ok: false, error: `主机未返回有效响应（HTTP ${response.status}）。请确认插件已在当前 profile 中启用，并重启 DSH。` }
      }
      return payload
    }

    /**
     * Ask the shell's own session/workspace models to re-read their baseline.
     *
     * The host already broadcasts both removal events, so this is the safety
     * net for a shell whose list keeps a cached row: `ctx.sessions.refresh()`
     * re-pulls the Session baseline (`refreshList` in the manager) and
     * `ctx.workspaces.refresh()` re-pulls the workspace baseline. Both services
     * and both method spellings are optional — whichever exists is used.
     */
    function refreshShell() {
      for (const name of ['sessions', 'workspaces']) {
        try {
          const service = contextRef.current?.get?.(name)
          if (service === undefined) continue
          const refresh = typeof service.refresh === 'function'
            ? service.refresh
            : typeof service.refreshList === 'function' ? service.refreshList : null
          if (refresh === null) continue
          Promise.resolve(refresh.call(service)).catch(() => { /* the baseline pull reports its own failure */ })
        } catch {
          // A shell without that service simply refreshes on its own.
        }
      }
    }

    /**
     * Read the shell's session-list snapshot, whichever shape the installed
     * client model exposes: `sessions.list.getSnapshot()`, a bare
     * `sessions.getSnapshot()`, or a `sessions.snapshot()` accessor.
     * @returns the snapshot object, or null.
     */
    function sessionListSnapshot() {
      const sessions = contextRef.current?.get?.('sessions')
      if (sessions === undefined || sessions === null) return null
      const readers = [
        () => sessions.list?.getSnapshot?.(),
        () => sessions.getSnapshot?.(),
        () => sessions.snapshot?.(),
      ]
      for (const read of readers) {
        try {
          const snapshot = read()
          if (snapshot !== null && typeof snapshot === 'object') return snapshot
        } catch {
          // try the next shape
        }
      }
      return null
    }

    /**
     * Read the Session the shell currently shows.
     * @returns the selected session id, or null.
     */
    function currentSessionId() {
      try {
        const snapshot = sessionListSnapshot()
        return typeof snapshot?.current === 'string' && snapshot.current !== '' ? snapshot.current : null
      } catch {
        return null
      }
    }

    /**
     * List the sessions a user could open next, most recent first.
     *
     * The snapshot carries the shell's own session ids and summaries; session
     * order is browser-local, so this sorts by the summary's `updatedAt` when it
     * is present and otherwise keeps the shell's order, which already puts pinned
     * and recently active rows first.
     * @param excludedId - the session that was just deleted.
     * @returns openable session ids, best candidate first.
     */
    function listOpenableSessionIds(excludedId) {
      try {
        const snapshot = sessionListSnapshot()
        if (snapshot === null) return []
        const ids = Array.isArray(snapshot.ids)
          ? snapshot.ids
          : Object.keys(snapshot.byId ?? {})
        const byId = snapshot.byId ?? {}
        const candidates = ids.filter((id) => id !== excludedId && byId[id]?.archived !== true)
        const timeOf = (id) => {
          const updatedAt = byId[id]?.updatedAt
          return typeof updatedAt === 'number' ? updatedAt : 0
        }
        if (candidates.some((id) => timeOf(id) > 0)) {
          return [...candidates].sort((left, right) => timeOf(right) - timeOf(left))
        }
        return candidates
      } catch {
        return []
      }
    }

    /**
     * Every service that can move the main panel onto a Session, in order of
     * preference. `uiWorkspace.openSession` is the exact call the workspace
     * browser uses for a session-row click; `workspaces` is its controller face;
     * `sessions.retain` is the model-level primitive `openSession` itself calls.
     * @returns `{ open, clear }` — either may be null when the shell lacks it.
     */
    function navigationApi() {
      const lookup = (name) => {
        try {
          return contextRef.current?.get?.(name)
        } catch {
          return undefined
        }
      }
      const uiWorkspace = lookup('uiWorkspace')
      if (uiWorkspace !== undefined && typeof uiWorkspace.openSession === 'function') {
        return { open: (id) => uiWorkspace.openSession(id), clear: null, via: 'uiWorkspace' }
      }
      const workspaces = lookup('workspaces')
      if (workspaces !== undefined && typeof workspaces.openSession === 'function') {
        return { open: (id) => workspaces.openSession(id), clear: null, via: 'workspaces' }
      }
      const sessions = lookup('sessions')
      if (sessions !== undefined && typeof sessions.retain === 'function') {
        return {
          open: (id) => sessions.retain(id, { source: 'mainView' }),
          clear: typeof sessions.clear === 'function' ? () => sessions.clear() : null,
          via: 'sessions.retain',
        }
      }
      return {
        open: null,
        clear: sessions !== undefined && typeof sessions.clear === 'function' ? () => sessions.clear() : null,
        via: 'none',
      }
    }

    /**
     * Move the shell off a session that was just deleted.
     *
     * A deleted session stays selected until something else is opened, so the
     * empty conversation frame lingers until the user clicks another row. This
     * opens the first remaining session instead, and falls back to the shell's
     * "no session" state when nothing is left.
     *
     * Service availability and list freshness are both racy right after a
     * deletion, so the attempt is repeated: while the deleted session is still
     * the selected one and candidates exist, try again a few times with a short
     * delay before giving up.
     * @param deletedId - the session that was just deleted.
     */
    function goToPreviousSession(deletedId) {
      const attempts = 12
      const delayMs = 200
      let attempt = 0
      let lastLine = null

      const settle = () => {
        attempt += 1
        const api = navigationApi()
        const candidates = listOpenableSessionIds(deletedId)
        const current = currentSessionId()
        const line = `navigate attempt=${attempt} via=${api.via} candidates=${candidates.length} current=${current ?? 'none'}`
        if (line !== lastLine) {
          lastLine = line
          trace(line)
        }

        if (candidates.length === 0) {
          // Nothing left to open: leave the frame of a deleted conversation and
          // show the shell's new-session empty state instead.
          if (api.clear !== null && (current === deletedId || current === null)) {
            try {
              api.clear()
              trace('navigate cleared selection (no session left)')
            } catch (error) {
              trace(`navigate clear failed: ${String(error?.message ?? error)}`)
            }
          }
          if (attempt < attempts && api.clear === null) setTimeout(settle, delayMs)
          return
        }

        if (api.open === null) {
          // The navigation service may simply not be mounted yet.
          if (attempt < attempts) setTimeout(settle, delayMs)
          return
        }

        // Open the best candidate whenever the shell has not already moved off
        // the deleted session. Opening it is harmless even if the shell briefly
        // still holds the deleted id, and retrying covers a stale list.
        try {
          api.open(candidates[0])
          trace(`navigate opened ${candidates[0]} (${api.via})`)
        } catch (error) {
          trace(`navigate open failed: ${String(error?.message ?? error)}`)
          if (attempt < attempts) setTimeout(settle, delayMs)
          return
        }
        if (currentSessionId() === deletedId && attempt < attempts) setTimeout(settle, delayMs)
      }

      // One microtask first: the removal events and the baseline pull above may
      // still be in flight, and the candidate list must not contain the row we
      // just deleted.
      Promise.resolve().then(settle)
    }

    /**
     * Send one diagnostic line to the host's plugin log.
     *
     * Navigation depends on shell services whose availability is timing
     * dependent; without a record there is no way to tell "the client bundle is
     * stale", "the service was missing" and "the call was refused" apart once
     * the UI has settled. Fire and forget — a diagnostics failure never affects
     * the deletion.
     * @param message - text to record.
     */
    function trace(message) {
      try {
        void fetch(DELETE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ action: 'trace', message: `[client ${CLIENT_REVISION}] ${String(message)}` }),
        }).catch(() => {})
      } catch {
        // ignore: diagnostics are best effort
      }
    }

    /** Short-lived in-page notice (no dependency on a shipped toast service). */
    function notify(message) {
      try {
        const node = document.createElement('div')
        node.textContent = message
        node.style.cssText = [
          'position:fixed', 'left:50%', 'bottom:32px', 'transform:translateX(-50%)',
          'z-index:2200', 'padding:8px 16px', 'border-radius:8px', 'font-size:13px',
          'line-height:20px', 'pointer-events:none',
          'background:var(--dsw-alias-bg-overlay, #1f1f22)',
          'color:var(--dsw-alias-label-primary, #fff)',
          'border:1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
          'box-shadow:0 8px 24px rgba(0,0,0,0.24)',
          'transition:opacity .24s ease',
        ].join(';')
        document.body.appendChild(node)
        setTimeout(() => { node.style.opacity = '0' }, 2600)
        setTimeout(() => { node.remove() }, 3000)
      } catch {
        // A missing toast is not worth failing a successful deletion over.
      }
    }

    /**
     * Live client Cordis context holder.
     *
     * Navigation reads services through this holder rather than a captured
     * local: a page loads the bundle once but may re-apply the plugin on a new
     * context (reconnect, HMR, another client tree), and every lookup must see
     * the current generation's service registry.
     */
    const contextRef = { current: null }

    /**
     * Adopt the shell's locale service so the dictionary follows the UI
     * language, and register our translations for slot consumers.
     * @param ctx - client plugin context.
     */
    function adoptLocale(ctx) {
      try {
        const locale = ctx.get?.('locale')
        if (locale === undefined) return
        localeService = locale
        if (typeof locale.register === 'function') locale.register(NS, { zh, en })
      } catch {
        // Without the service the bundle falls back to navigator.language.
      }
    }

    /**
     * Client plugin entry: one menu row, one dialog.
     * @param ctx - client plugin context (slots, locale).
     */
    function apply(ctx) {
      contextRef.current = ctx
      adoptLocale(ctx)

      const slots = ctx.get?.('slots')
      if (slots === undefined) return

      slots.inject(MENU_SLOT, () => slots.register({
        name: MENU_SLOT,
        id: MENU_ID,
        order: MENU_ORDER,
      }, DeleteSessionMenuItem))

      slots.inject(OVERLAY_SLOT, () => slots.register({
        name: OVERLAY_SLOT,
        id: DIALOG_ID,
        order: 220,
      }, DeleteSessionDialog))
    }

      return { apply, inject: ['slots'] }
    },
  })
}
