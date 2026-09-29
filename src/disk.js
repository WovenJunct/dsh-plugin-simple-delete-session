/**
 * dsh-plugin-simple-delete-session — disk helper.
 *
 * The session log lives under the root configured on the
 * `session-persistence-jsonl` loader row (by default `dshHomePath('sessions')`,
 * i.e. `<DSH_HOME>/sessions`). Layout, observed on a live install:
 *
 *   <root>/<project>/<session-id>/session.jsonl.zstd
 *
 * This module finds that directory for exactly one session id and removes it,
 * then re-scans to prove the removal happened. It never walks the whole tree
 * recursively and never touches anything whose base name is not the session id
 * itself, so no other session, and no unrelated file, can be affected.
 *
 * Node built-ins only; no dependency on DSH internals.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Session ids accepted by the disk layer (same shape the service validates). */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Never spend more than this long looking for one session's directory. */
const SCAN_BUDGET_MS = 4_000

/** Unlink retries: Windows keeps the handle for a moment after a close. */
const REMOVE_ATTEMPTS = 4
const REMOVE_RETRY_MS = 250

/** @returns a promise resolving after `ms` milliseconds. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @returns the DSH home directory this process would default to. */
function defaultHome() {
  if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '') {
    return path.resolve(process.env.DSH_HOME.trim())
  }
  return path.join(homedir(), '.dsh')
}

/**
 * Ask the loader for the *live* `session-persistence-jsonl` configuration, so a
 * profile that moved the sessions root is still supported.
 * @param ctx - plugin context (may expose `configEditor`).
 * @returns the configured root, or undefined.
 */
function rootFromConfig(ctx) {
  try {
    const editor = ctx.get?.('configEditor')
    if (editor === undefined) return undefined
    const configuration = typeof editor.configuration === 'function' ? editor.configuration() : []
    if (!Array.isArray(configuration)) return undefined
    for (const row of configuration) {
      const name = row?.entry?.name
      if (name !== '@deepseek-ai/dsh-session-persistence-jsonl') continue
      const candidates = [row.override?.root, row.inherited?.root, row.entry?.config?.root]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== '') return path.resolve(candidate.trim())
      }
    }
  } catch {
    // Configuration introspection is best effort.
  }
  return undefined
}

/**
 * Resolve the directory holding every session log.
 * @param ctx - plugin context.
 * @returns an absolute path, or undefined when it cannot be resolved.
 */
export async function resolvePersistenceRoot(ctx) {
  const configured = rootFromConfig(ctx)
  if (configured !== undefined) return configured
  const envRoot = process.env.DSH_SESSIONS_ROOT
  if (typeof envRoot === 'string' && envRoot.trim() !== '') return path.resolve(envRoot.trim())
  return path.join(defaultHome(), 'sessions')
}

/** @returns the entry list of one directory, or [] when unreadable. */
async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Find every on-disk directory that belongs to exactly one session.
 * @param root - sessions root (e.g. `<DSH_HOME>/sessions`).
 * @param sessionId - the one session id to look for.
 * @param deadline - absolute timestamp after which the scan stops early.
 * @returns `{ dirs, incomplete }` — `incomplete` marks a budget stop, so the
 *   caller never reports success on a scan it could not finish.
 */
export async function locateSessionDirs(root, sessionId, deadline = Date.now() + SCAN_BUDGET_MS) {
  if (typeof root !== 'string' || root === '' || !SESSION_ID_PATTERN.test(sessionId)) {
    return { dirs: [], incomplete: false }
  }
  const rootInfo = await stat(root).catch(() => undefined)
  if (rootInfo === undefined || !rootInfo.isDirectory()) return { dirs: [], incomplete: false }

  const dirs = []
  const projects = await listDir(root)
  for (const project of projects) {
    if (Date.now() > deadline) return { dirs, incomplete: true }
    if (!project.isDirectory()) continue
    const projectDir = path.join(root, project.name)
    const entries = await listDir(projectDir)
    for (const entry of entries) {
      if (Date.now() > deadline) return { dirs, incomplete: true }
      if (!entry.isDirectory() || entry.name !== sessionId) continue
      dirs.push(path.join(projectDir, entry.name))
    }
  }
  return { dirs, incomplete: false }
}

/**
 * Remove one session's log directory (or directories, when the same id was
 * materialized under more than one project spelling) and verify it is gone.
 * @param root - sessions root.
 * @param sessionId - the one session to erase.
 * @returns `{ removed, gone, error? }`; `gone === true` means nothing for this
 *   session is left on disk.
 */
export async function deleteSessionLog(root, sessionId) {
  const located = await locateSessionDirs(root, sessionId, Date.now() + SCAN_BUDGET_MS)
  const removed = []
  let error

  for (const dir of located.dirs) {
    let lastError
    for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 2 })
        lastError = undefined
        break
      } catch (failure) {
        lastError = failure
        await delay(REMOVE_RETRY_MS)
      }
    }
    if (lastError === undefined) removed.push(dir)
    else if (error === undefined) error = lastError instanceof Error ? lastError.message : String(lastError)
  }

  // Verification gets its own budget: the removal itself may have taken a while.
  const verify = await locateSessionDirs(root, sessionId, Date.now() + SCAN_BUDGET_MS)
  const gone = !verify.incomplete && verify.dirs.length === 0
  if (!gone && error === undefined) {
    error = verify.incomplete
      ? '扫描超时，无法确认日志已删除'
      : `日志目录仍然存在：${verify.dirs.join(', ')}`
  }
  return { removed, gone, ...(error === undefined ? {} : { error }) }
}
