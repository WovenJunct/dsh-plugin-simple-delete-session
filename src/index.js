/**
 * dsh-plugin-simple-delete-session — host half.
 *
 * One job: remove ONE session completely, without touching any other session.
 *
 * What "completely" means here, in the order the host performs it:
 *
 *   1. refuse while the session has a running agent turn (its writer would race
 *      the unlink);
 *   2. flush the session durably, so no buffered append can recreate the log
 *      directory right after it is unlinked;
 *   3. remove the session's own log directory from disk
 *      (`<sessions root>/<project>/<session-id>`), verified by re-scanning;
 *   4. drop the session from every workspace account and from the archive and
 *      pin sets, so no stale row survives anywhere;
 *   5. broadcast `session/disposed` so every connected client drops the row
 *      immediately instead of after a reload.
 *
 * Every step is idempotent and every step fails soft: a deletion that cannot
 * finish leaves the session fully intact (never half-deleted), and the caller
 * gets an honest error message.
 *
 * Only public Cordis services are used: `webServer`, `sessions`, `agents`,
 * `sessionController`, `sessionPersistence`, `sessionQuery`,
 * `workspaceRegistry`. The disk helper (src/disk.js) locates the log through the
 * live `session-persistence-jsonl` root instead of trusting a hard-coded path.
 *
 * Deliberately NOT used: `sessions.enter()`. It is a publication primitive with
 * a duplicate guard — calling it for an already-entered session (every live
 * agent session) throws, and a plugin that entered other people's sessions
 * would hold their detach disposers for its whole lifetime. Deleting a session's
 * log does not need store ownership; the in-memory entry is dropped by its real
 * owner or by the next DSH start (whose header index rebuild hides the row).
 */
import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { deleteSessionLog, locateSessionDirs, resolvePersistenceRoot } from './disk.js'

/** HTTP routes the browser half may call. */
const ROUTES = ['/plugins/dsh-plugin-simple-delete-session/delete', '/api/session-delete/delete']

/** Session ids are DSH-branded strings; this is the only shape we accept. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Bounded request body (a JSON envelope with one id). */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Read and parse a JSON request body.
 * @param req - Node request.
 * @returns the parsed object ({} for an empty body).
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        const value = JSON.parse(text)
        resolve(value !== null && typeof value === 'object' ? value : {})
      } catch {
        reject(new Error('request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Write one JSON response.
 * @param res - Node response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * The delete service mounted by this plugin. Holds one piece of state: the
 * detach disposers observed for sessions that entered the in-memory store, used
 * when the store's own entry object is not reachable.
 */
class SessionDeleteService {
  /**
   * @param ctx - plugin context carrying the injected services.
   */
  constructor(ctx) {
    this.ctx = ctx
    /** @type {Map<string, () => unknown>} session id → detach disposer. */
    this.disposers = new Map()
    /** @type {Array<() => void>} listener cleanups. */
    this.cleanups = []
    this.#observeSessionStore()
  }

  /**
   * Capture a detach capability for every session that enters the store.
   *
   * `SessionStore.enter(session)` publishes the store slot and returns the
   * detach disposer; re-entering an already-entered session throws, which is the
   * only way to tell "already owned by someone else" from "not entered yet".
   * The listener therefore runs on `session/created` (by which time the entry
   * exists) purely as a fallback: `#releaseLive` prefers the store's own entry.
   */
  #observeSessionStore() {
    if (typeof this.ctx.on !== 'function') return
    const remember = (session) => {
      const id = session !== null && typeof session === 'object' ? session.id : undefined
      if (typeof id !== 'string' || id === '' || this.disposers.has(id)) return
      const sessions = this.ctx.get('sessions')
      if (sessions === undefined) return
      try {
        const dispose = sessions.enter(session)
        if (typeof dispose === 'function') this.disposers.set(id, dispose)
      } catch {
        // Already entered by its real owner — the store entry path covers it.
      }
    }
    try {
      this.cleanups.push(this.ctx.on('session/created', (session) => remember(session)))
    } catch {
      // A composition without the session store needs no fallback.
    }
  }

  /** Release the listeners this service installed. */
  dispose() {
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup()
      } catch {
        // already released
      }
    }
  }

  /**
   * Describe one session for the confirmation dialog.
   * @param sessionId - session to describe.
   * @returns a JSON-safe description (never throws).
   */
  async describe(sessionId) {
    const state = await this.#state(sessionId)
    return {
      sessionId,
      running: state.running,
      live: state.live,
      persisted: state.persisted,
      title: await this.#title(sessionId),
    }
  }

  /**
   * Permanently delete one session.
   * @param sessionId - the only session this call may touch.
   * @param options - `{ force }` deletes a running session only after its turn
   *   was cancelled and the writer released ownership.
   * @returns a JSON-safe outcome.
   */
  async delete(sessionId, options = {}) {
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      return { ok: false, error: '无效的会话 id。' }
    }
    const force = options.force === true
    const state = await this.#state(sessionId)

    if (state.running) {
      if (!force) {
        return {
          ok: false,
          running: true,
          error: '该会话正在处理消息。请先停止它，或选择「停止并删除」。',
        }
      }
      const stopped = await this.#stopRunning(sessionId)
      if (!stopped) {
        return {
          ok: false,
          running: true,
          error: '无法停止该会话的当前回合，删除已取消。请等它结束后重试。',
        }
      }
    }

    const steps = { flushed: false, releasedLive: false, detachedFromWorkspace: 0, removedFromArchive: false, removedFromPin: false, removedProjectionCache: false, removedDirs: [], logGone: false, respawned: false }

    // 1) Live session first: flush its buffered appends and release its store
    //    slot. Releasing is what removes the sidebar row immediately — a live
    //    session is still reported by sessionQuery and by the workspace header
    //    index, so an unlink alone would leave an "Ungrouped" ghost row until
    //    the next DSH start.
    const live = await this.#releaseLive(sessionId)
    steps.flushed = live.flushed
    steps.releasedLive = live.detached

    // 2) Durable accounting: no workspace, archive or pin may still reference it,
    //    and the persisted projection cache must not keep a record for it.
    steps.detachedFromWorkspace = await this.#detachFromWorkspaces(sessionId)
    steps.removedFromArchive = await this.#unarchive(sessionId)
    steps.removedFromPin = await this.#unpin(sessionId)
    steps.removedProjectionCache = await removeProjectionCache(this.ctx, sessionId)

    // 3) Disk: remove the session's own log directory, then verify it is gone.
    const root = await resolvePersistenceRoot(this.ctx)
    if (root === undefined) {
      return {
        ok: false,
        error: '找不到会话日志根目录，未删除任何文件。请在 DSH 的 cordis 配置中确认 session-persistence-jsonl 的 root。',
      }
    }
    const removal = await deleteSessionLog(root, sessionId)
    steps.removedDirs = removal.removed
    steps.logGone = removal.gone
    if (!removal.gone) {
      return {
        ok: false,
        error: `找到会话日志但删除失败：${removal.error ?? '未知原因'}。请关闭占用该文件的其他 DSH 进程后重试。`,
        ...steps,
      }
    }

    // 3b) Respawn guard: an owner that still holds the session object could
    //     materialize the log again right after the unlink. Wait one beat and
    //     erase again if it came back.
    await delay(300)
    const respawned = await deleteSessionLog(root, sessionId)
    steps.respawned = respawned.removed.length > 0
    if (steps.respawned) {
      steps.removedDirs = [...steps.removedDirs, ...respawned.removed]
      steps.logGone = respawned.gone
      if (!respawned.gone) {
        return {
          ok: false,
          error: `会话日志在删除后又被写回（${respawned.error ?? '仍有进程持有它'}）。请关闭其他 DSH 进程后重试。`,
          ...steps,
        }
      }
    }

    // 4) Broadcast both removal events, so every connected client drops the row
    //    now instead of on reload.
    this.#announce(sessionId)

    return {
      ok: true,
      sessionId,
      note: removal.removed.length === 0
        ? '磁盘上没有找到该会话的日志（可能已被删除），已清理注册表记录。'
        : `已删除 ${removal.removed.length} 个会话日志目录。`,
      ...steps,
    }
  }

  /** @returns one session's live/persisted/running state, never throwing. */
  async #state(sessionId) {
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    let agent
    try {
      agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    } catch {
      agent = undefined
    }
    const running = agent !== undefined && agent.status === 'running'
    let live = false
    try {
      live = typeof sessions?.get === 'function' && sessions.get(sessionId) !== undefined
    } catch {
      live = false
    }
    let persisted = false
    try {
      const persistence = this.ctx.get('sessionPersistence')
      if (typeof persistence?.stat === 'function') {
        persisted = (await persistence.stat(sessionId)) !== undefined
      }
    } catch {
      persisted = false
    }
    return { agent, running, live, persisted }
  }

  /** @returns the session's displayed title, or null. */
  async #title(sessionId) {
    try {
      const query = this.ctx.get('sessionQuery')
      if (typeof query?.readTitle === 'function') {
        const snapshot = await query.readTitle(sessionId)
        const title = snapshot?.title?.title
        if (typeof title === 'string' && title !== '') return title
      }
    } catch {
      // A missing or cold title is not an error for the dialog.
    }
    return null
  }

  /**
   * Cancel the running turn of one session, then wait for it to settle.
   *
   * `sessionController.cancel()` is the same acknowledgement the shipped UI's
   * cancel button uses; the workspace stop seam covers work a provider owns
   * beyond the turn. Neither is guaranteed to exist, so both are probed and the
   * polling loop below decides whether the session actually stopped.
   * @returns true when the session is no longer running.
   */
  async #stopRunning(sessionId) {
    try {
      const controller = this.ctx.get('sessionController')
      if (controller !== undefined && typeof controller.cancel === 'function') {
        controller.cancel({ sessionId })
      }
    } catch {
      // Fall through to the workspace stop seam below.
    }
    try {
      if (typeof this.ctx.parallel === 'function') {
        await this.ctx.parallel('workspace/session-stop', { sessionId })
      }
    } catch {
      // Providers may refuse; the polling loop below decides.
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const state = await this.#state(sessionId)
      if (!state.running) return true
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return false
  }

  /**
   * Remove one live session from the in-memory store.
   *
   * This is the piece that makes the sidebar row disappear *without a restart*.
   * `SessionStore` keeps a `Map<id, entry>` and only the entry's own `detach`
   * capability — reachable through the entry object, or through the disposer
   * that `enter()` returns — tombstones the store slot and emits the paired
   * `session/disposed`, which the API Session Controller forwards to every
   * browser as `api-session/removed`. A session that is only asked to `flush`
   * and then unlinked from disk stays live in memory, so both
   * `sessionQuery.listSessions()` (live precedence) and the workspace registry's
   * header index keep reporting it, and the sidebar re-adds it as an
   * "Ungrouped" ghost row until the next DSH start.
   *
   * Every step is defensive: the entry object is an implementation detail, so a
   * store that no longer exposes it downgrades to "stay live" instead of
   * failing the deletion.
   * @param sessionId - the session to release.
   * @returns `{ flushed, detached }`.
   */
  async #releaseLive(sessionId) {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') return { flushed: false, detached: false }
    let session
    try {
      session = sessions.get(sessionId)
    } catch {
      return { flushed: false, detached: false }
    }
    if (session === undefined) return { flushed: false, detached: false }

    // 1) Drain buffered appends first, so nothing is left to write after the
    //    log directory is unlinked.
    let flushed = false
    try {
      if (typeof sessions.flush === 'function') {
        await sessions.flush(session)
        flushed = true
      }
    } catch (error) {
      this.#warn(`flush failed for "${sessionId}": ${messageOf(error)}`)
    }

    // 2) Release the store slot: the entry's detach capability, or the disposer
    //    recorded from `enter()`.
    const entry = sessionEntry(sessions, sessionId)
    const detach = (entry !== undefined && typeof entry.detach === 'function')
      ? () => entry.detach()
      : this.disposers.get(sessionId)
    let detached = false
    if (detach !== undefined) {
      this.disposers.delete(sessionId)
      try {
        await detach()
        detached = true
      } catch (error) {
        this.#warn(`session detach failed for "${sessionId}": ${messageOf(error)}`)
      }
    }

    // 3) Let the store's disposal dispatch and the persistence tail settle
    //    before the caller unlinks the directory.
    if (flushed || detached) await delay(250)
    return { flushed, detached }
  }

  /**
   * Remove the session from every workspace account.
   * @returns how many workspaces still listed it.
   */
  async #detachFromWorkspaces(sessionId) {
    let detached = 0
    try {
      const registry = this.ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.list !== 'function') return 0
      for (const workspace of registry.list()) {
        const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
        if (!ids.includes(sessionId)) continue
        try {
          await workspace.detachSession(sessionId)
          detached += 1
        } catch (error) {
          this.#warn(`detach session "${sessionId}" from workspace "${workspace?.id}" failed: ${messageOf(error)}`)
        }
      }
    } catch (error) {
      this.#warn(`workspace detach failed for "${sessionId}": ${messageOf(error)}`)
    }
    return detached
  }

  /** @returns whether the archive set held the session. */
  async #unarchive(sessionId) {
    try {
      const registry = this.ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.unarchiveSession !== 'function') return false
      const archived = registry.archivedSessionIds
      const held = archived === undefined || typeof archived.has === 'function'
        ? archived?.has(sessionId) === true
        : Array.isArray(archived) && archived.includes(sessionId)
      await registry.unarchiveSession(sessionId)
      return held
    } catch (error) {
      this.#warn(`unarchive failed for "${sessionId}": ${messageOf(error)}`)
      return false
    }
  }

  /** @returns whether the pin set held the session. */
  async #unpin(sessionId) {
    try {
      const registry = this.ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.unpinSession !== 'function') return false
      await registry.unpinSession(sessionId)
      return true
    } catch (error) {
      this.#warn(`unpin failed for "${sessionId}": ${messageOf(error)}`)
      return false
    }
  }

  /**
   * Tell every connected client that this session is gone.
   *
   * Two events, both idempotent on the receiving side:
   *
   *  - `session/disposed` is the store's own lifecycle event. The API Session
   *    Controller listens for it and turns it into `api-session/removed`; it is
   *    also what the session store would have emitted had the session been
   *    detached by its owner.
   *  - `api-session/removed` is the event the browser's session-controller
   *    mirror actually subscribes to (`ctx.remote.$on`). A cold session — one
   *    that lives only in persistence — never passes through the store, so the
   *    first event alone would leave its sidebar row behind until a reload; this
   *    is the event that removes the row immediately in every case.
   */
  #announce(sessionId) {
    try {
      this.ctx.emit('session/disposed', { id: sessionId, header: { id: sessionId } })
    } catch (error) {
      this.#warn(`session/disposed emit failed for "${sessionId}": ${messageOf(error)}`)
    }
    try {
      this.ctx.emit('api-session/removed', sessionId)
    } catch (error) {
      this.#warn(`api-session/removed emit failed for "${sessionId}": ${messageOf(error)}`)
    }
  }

  /** @param text - host-side diagnostic line. */
  #warn(text) {
    const tag = '[dsh-plugin-simple-delete-session]'
    try {
      this.ctx.logger?.warn?.(`${tag} ${text}`)
    } catch {
      // logging must never break a deletion
    }
  }
}

/** @returns a message string for an unknown thrown value. */
function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  return error instanceof Error ? error.message : String(error)
}

/**
 * Delete one session's persisted projection cache row.
 *
 * `session-projection-cache` keeps a durable checkpoint per session
 * (`<DSH_HOME>/storages/session_projcache/sessions/<id>.json`, the
 * `session_projcache` domain's `sessions` table) holding folded projection
 * state such as the title. Nothing deletes it with the log, so without this
 * step a deleted conversation leaves its folded metadata behind.
 *
 * The domain spec is declared by the owning package and is not exported, so the
 * declaration is reproduced here verbatim: a mismatch (a future version bump)
 * makes `storageDomain.open` refuse, and this step degrades to "not removed"
 * rather than touching a domain it does not understand.
 * @param ctx - plugin context.
 * @param sessionId - the session whose cached row is removed.
 * @returns true when a row was deleted or there was nothing to delete.
 */
async function removeProjectionCache(ctx, sessionId) {
  try {
    const storageDomain = ctx.get('storageDomain')
    if (storageDomain === undefined || typeof storageDomain.open !== 'function') return false
    const spec = {
      name: 'session_projcache',
      version: PROJ_CACHE_VERSION,
      compatibleVersions: PROJ_CACHE_COMPATIBLE_VERSIONS,
      invalidRecords: 'backup-and-skip',
      layout: 'per-record',
      tables: { sessions: { schema: { parse: (value) => value } } },
    }
    const domain = await storageDomain.open(spec)
    const table = domain.table('sessions')
    if (table === undefined || typeof table.delete !== 'function') return false
    if (typeof table.has === 'function' && table.has(sessionId) !== true) return true
    await table.delete(sessionId)
    return true
  } catch (error) {
    try {
      ctx.logger?.warn?.(`[dsh-plugin-simple-delete-session] projection cache removal failed for "${sessionId}": ${messageOf(error)}`)
    } catch {
      // logging must never break a deletion
    }
    return false
  }
}

/** Projection-cache domain version the shipped `session-projection-cache` declares. */
const PROJ_CACHE_VERSION = 7
/** Older projection-cache layouts the shipped backend can still read. */
const PROJ_CACHE_COMPATIBLE_VERSIONS = [3, 4, 5, 6]

/**
 * Read the store's own entry object for one live session.
 *
 * `SessionStore` keeps a `Map<id, entry>` whose entries own the single-shot
 * `detach` capability (store removal plus the paired `session/disposed`). The
 * map is not part of the published service face, so this probes for it and
 * returns `undefined` on any store that does not expose it.
 * @param sessions - the live `ctx.sessions` service.
 * @param sessionId - session whose entry is requested.
 * @returns the entry object, or undefined.
 */
function sessionEntry(sessions, sessionId) {
  try {
    const store = sessions?.store
    if (store === undefined || typeof store.get !== 'function') return undefined
    const entry = store.get(sessionId)
    return entry !== null && typeof entry === 'object' ? entry : undefined
  } catch {
    return undefined
  }
}

/** @returns a promise resolving after `ms` milliseconds. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Register one exact route on the web carrier.
 *
 * Two spellings are attempted because the carrier's own table is keyed by
 * `(kind, path)` and a duplicate throws:
 *
 *  1. the plain `webServer.register(...)` call;
 *  2. the same call on `ctx.connection.operator.ctx`, which mounts the route on
 *     the connection's own Cordis scope — the surface the desktop shell's
 *     shared fetch handler consults.
 *
 * The first route that registers wins; the alternative exists so a carrier
 * whose route list is fiber-scoped still receives the endpoint.
 * @param ctx - plugin context.
 * @param path - exact path to claim.
 * @param handler - full response owner.
 * @returns a disposer removing whichever registration succeeded.
 */
function registerRoute(ctx, path, handler) {
  const attempts = []
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    attempts.push(() => webServer.register({ kind: 'exact', path, handler }))
  }
  try {
    const operatorCtx = ctx.get('connection')?.operator?.ctx
    const operatorWeb = operatorCtx?.get?.('webServer')
    if (operatorWeb !== undefined && operatorWeb !== webServer && typeof operatorWeb.register === 'function') {
      attempts.push(() => operatorWeb.register({ kind: 'exact', path, handler }))
    }
  } catch {
    // No connection scope in this composition; the plain registration stands.
  }

  let lastError
  for (const attempt of attempts) {
    try {
      const dispose = attempt()
      return typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error(`webserver: could not register "${path}"`)
}

/**
 * Register the http routes and build the delete service.
 * @param ctx - plugin context.
 * @returns a disposer releasing every registration.
 */
function mount(ctx) {
  const service = new SessionDeleteService(ctx)
  const disposers = []

  for (const path of ROUTES) {
    disposers.push(registerRoute(ctx, path, async (req, res) => {
      // One marker line per request: enough to tell "the route is registered"
      // from "the /plugins prefix route answered instead".
      ctx.logger?.info?.(`[dsh-plugin-simple-delete-session] ${req.method} ${path}`)
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { ok: false, error: messageOf(error) })
        return
      }
      try {
        // Client-side diagnostics: the browser half reports what its
        // post-deletion navigation could see. Recorded, never acted on.
        if (body.action === 'trace') {
          trace(`client: ${typeof body.message === 'string' ? body.message.slice(0, 500) : '(no message)'}`)
          sendJson(res, 200, { ok: true })
          return
        }
        const sessionId = body.sessionId
        if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
          sendJson(res, 400, { ok: false, error: '缺少合法的 sessionId。' })
          return
        }
        if (body.action === 'describe') {
          sendJson(res, 200, { ok: true, ...(await service.describe(sessionId)) })
          return
        }
        const result = await service.delete(sessionId, { force: body.force === true })
        sendJson(res, result.ok ? 200 : 409, result)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: messageOf(error) })
      }
    }))
  }

  return () => {
    service.dispose()
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // already withdrawn
      }
    }
  }
}

/**
 * Cordis entry: mount the delete service behind its own HTTP route.
 *
 * The route is registered as soon as a web carrier is available: immediately
 * when `webServer` is already there, otherwise through `ctx.inject` the moment
 * it appears. Getting this wrong makes the browser half receive the
 * `/plugins` bundle route's 405 instead of this endpoint, which is exactly the
 * failure the diagnostic line below reports.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  trace('apply() entered')
  const register = (hostCtx) => {
    const webServer = hostCtx.get('webServer')
    trace(`register(): webServer=${webServer === undefined ? 'undefined' : 'present'}`)
    if (webServer === undefined) {
      hostCtx.logger?.warn?.('[dsh-plugin-simple-delete-session] webServer is unavailable; the delete route was not registered.')
      return
    }
    let release
    try {
      release = mount(hostCtx)
      trace(`register(): routes claimed (${ROUTES.join(', ')})`)
    } catch (error) {
      trace(`register(): failed: ${messageOf(error)}`)
      throw error
    }
    hostCtx.logger?.info?.(`[dsh-plugin-simple-delete-session] delete route registered: ${ROUTES.join(', ')}`)
    hostCtx.effect(() => release, 'dsh-plugin-simple-delete-session: routes')
  }

  if (ctx.get('webServer') !== undefined) {
    register(ctx)
    return
  }
  trace('apply(): webServer absent, waiting through ctx.inject')
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (hostCtx) => register(hostCtx))
  }
}

/**
 * Append one diagnostic line to `<DSH home>/dsh-plugin-simple-delete-session.log`.
 *
 * Route registration happens during boot, where a thrown activation error can
 * hide the real cause; this marker makes "did the route get claimed, and on
 * which carrier?" answerable after the fact. The log also collects the browser
 * half's navigation traces, which is the only way to tell a stale client bundle
 * (a page that has not been refreshed since the plugin changed) from a client
 * that ran and was refused. Never throws.
 * @param line - text to append.
 */
function trace(line) {
  try {
    appendFileSync(
      path.join(dshHome(), 'dsh-plugin-simple-delete-session.log'),
      `${new Date().toISOString()}  ${line}\n`,
      'utf8',
    )
  } catch {
    // diagnostics must never affect activation
  }
}

/**
 * Resolve the DSH home directory the way the persistence backend does: the
 * `DSH_HOME` environment variable when the host sets one, otherwise the
 * conventional `<user home>/.dsh`.
 * @returns an absolute directory path.
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured.trim())
  return path.join(homedir(), '.dsh')
}

export { SessionDeleteService, locateSessionDirs }
