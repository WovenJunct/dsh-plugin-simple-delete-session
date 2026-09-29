/**
 * Verification for dsh-plugin-simple-delete-session.
 *
 * No test framework and no dependencies: run with
 *   node verify/verify.mjs
 * It checks the pure disk logic on a throwaway tree, the shape of both plugin
 * halves, and that the browser bundle at least evaluates.
 */
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')

let failures = 0

/** @param name - check label. @param condition - must be true. */
function check(name, condition) {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL ${name}`)
  }
}

/** Run one labelled section. @param title - section label. @param body - async work. */
async function section(title, body) {
  console.log(`\n${title}`)
  await body()
}

await section('disk: locate + delete exactly one session', async () => {
  const { locateSessionDirs, deleteSessionLog, resolvePersistenceRoot } = await import(
    pathToFileURL(path.join(pkgRoot, 'src', 'disk.js')).href
  )
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-sd-'))
  try {
    const projectA = path.join(root, '--D-projA--')
    const projectB = path.join(root, '--D-projB--')
    const target = 'session-11111111-2222-3333-4444-555555555555'
    const keeper = 'session-99999999-8888-7777-6666-555555555555'
    for (const [project, id] of [[projectA, target], [projectA, keeper], [projectB, target], [projectB, 'other-dir']]) {
      await mkdir(path.join(project, id), { recursive: true })
      await writeFile(path.join(project, id, 'session.jsonl.zstd'), 'x')
    }
    // A file named like a session must never be treated as a session directory.
    await writeFile(path.join(projectA, target + '.txt'), 'x')

    const located = await locateSessionDirs(root, target)
    check('locates both copies of the target only', located.dirs.length === 2 && !located.incomplete)
    check('never returns the keeper', !located.dirs.some((dir) => dir.includes(keeper)))

    const removal = await deleteSessionLog(root, target)
    check('reports two removals', removal.removed.length === 2)
    check('reports the log gone', removal.gone === true && removal.error === undefined)

    const afterA = await readdir(projectA)
    const afterB = await readdir(projectB)
    check('keeper survived', afterA.includes(keeper))
    check('unrelated file survived', afterA.includes(target + '.txt'))
    check('unrelated directory survived', afterB.includes('other-dir'))
    check('target removed from both projects', !afterA.includes(target) && !afterB.includes(target))

    const again = await deleteSessionLog(root, target)
    check('second delete is an idempotent success', again.gone === true && again.removed.length === 0)

    const rejected = await locateSessionDirs(root, '../escape')
    check('rejects a traversing id', rejected.dirs.length === 0)
    const missing = await deleteSessionLog(path.join(root, 'nope'), target)
    check('missing root is a success', missing.gone === true)

    const resolved = await resolvePersistenceRoot({ get: () => undefined })
    check('root falls back to <home>/sessions', typeof resolved === 'string' && resolved.endsWith('sessions'))
    const fromConfig = await resolvePersistenceRoot({
      get: (name) => (name === 'configEditor'
        ? { configuration: () => [{ entry: { name: '@deepseek-ai/dsh-session-persistence-jsonl' }, inherited: { root: path.join(root, 'custom') } }] }
        : undefined),
    })
    check('root honours the live loader config', fromConfig === path.join(root, 'custom'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await section('host half: shape + delete orchestration against fakes', async () => {
  const host = await import(pathToFileURL(path.join(pkgRoot, 'src', 'index.js')).href)
  check('exports apply()', typeof host.apply === 'function')
  check('exports the service class', typeof host.SessionDeleteService === 'function')
  check('does not declare a hard inject list that blocks activation', host.inject === undefined || Array.isArray(host.inject))

  const root = await mkdtemp(path.join(tmpdir(), 'dsh-sd-host-'))
  const warnings = []
  const emitted = []
  const detached = []
  const detachCalls = []
  const cacheDeletes = []
  const cacheSpecs = []
  const target = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const keeper = 'session-ffffffff-0000-1111-2222-333333333333'
  try {
    const project = path.join(root, 'proj')
    for (const id of [target, keeper]) {
      await mkdir(path.join(project, id), { recursive: true })
      await writeFile(path.join(project, id, 'session.jsonl.zstd'), 'x')
    }
    const ctx = {
      get(name) {
        if (name === 'configEditor') {
          return { configuration: () => [{ entry: { name: '@deepseek-ai/dsh-session-persistence-jsonl' }, inherited: { root } }] }
        }
        if (name === 'agents') return { get: () => undefined }
        if (name === 'sessions') {
          // A store whose live session for `target` is still entered: deleting
          // it must release the store slot, or the sidebar keeps an
          // "Ungrouped" ghost row until the next DSH start.
          const entry = {
            id: target,
            announced: true,
            detach: () => {
              liveStore.delete(target)
              detachCalls.push(target)
            },
          }
          const liveStore = new Map([[target, entry]])
          return {
            store: liveStore,
            get: (id) => (liveStore.has(id) ? { id, header: { id } } : undefined),
            flush: async () => true,
          }
        }
        if (name === 'sessionPersistence') return { stat: async () => undefined }
        if (name === 'sessionQuery') return { readTitle: async () => ({ title: { title: 'Demo session' } }) }
        if (name === 'storageDomain') {
          // The persisted projection cache: one row per session. A deletion that
          // skips this leaves the folded metadata (title and friends) on disk.
          const rows = new Map([[target, { identity: { formatVersion: 4 }, rows: {} }], [keeper, { identity: { formatVersion: 4 }, rows: {} }]])
          return {
            open: async (spec) => {
              cacheSpecs.push(spec)
              return {
                table: (tableName) => (tableName === 'sessions'
                  ? {
                    has: (id) => rows.has(id),
                    delete: async (id) => { rows.delete(id); cacheDeletes.push(id) },
                  }
                  : undefined),
              }
            },
          }
        }
        if (name === 'workspaceRegistry') {
          return {
            list: () => [{
              id: 'ws-1',
              sessionIds: [target, keeper],
              detachSession: async (id) => { detached.push(id) },
            }],
            unarchiveSession: async () => {},
            unpinSession: async () => {},
          }
        }
        return undefined
      },
      logger: { warn: (line) => warnings.push(line) },
      emit: (name, payload) => emitted.push([name, payload]),
      on: () => () => {},
    }
    const service = new host.SessionDeleteService(ctx)

    const described = await service.describe(target)
    check('describe returns the title', described.title === 'Demo session')
    check('describe reports not running', described.running === false)
    check('describe reports the session as live', described.live === true)

    const bad = await service.delete('../../etc')
    check('rejects a traversing id', bad.ok === false)

    const result = await service.delete(target)
    check('delete succeeds', result.ok === true)
    check('delete removed the target directory', result.removedDirs.length === 1 && result.logGone === true)
    check('delete released the live store slot', result.releasedLive === true)
    check('delete called the store entry detach exactly once', detachCalls.length === 1 && detachCalls[0] === target)
    check('delete detached only the target', detached.length === 1 && detached[0] === target)
    check('delete removed the persisted projection cache row',
      result.removedProjectionCache === true && cacheDeletes.length === 1 && cacheDeletes[0] === target)
    check('the projection cache domain spec matches the shipped declaration',
      cacheSpecs.length === 1 && cacheSpecs[0].name === 'session_projcache' && cacheSpecs[0].version === 7
      && cacheSpecs[0].layout === 'per-record' && Array.isArray(cacheSpecs[0].compatibleVersions))
    check('delete broadcast session/disposed', emitted.some(([name]) => name === 'session/disposed'))
    check('delete broadcast api-session/removed (the event the client mirrors listen to)',
      emitted.some(([name, payload]) => name === 'api-session/removed' && payload === target))

    const left = await readdir(project)
    check('keeper directory survived', left.includes(keeper) && !left.includes(target))
    check('no unexpected warnings', warnings.length === 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await section('browser half: evaluates inside a module-loader stub', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(path.join(pkgRoot, 'lib', 'client.js'), 'utf8')
  const loaded = []
  const registered = []
  const listeners = {}
  // Per-component hook state, like React: a component gets its own slot list,
  // so rendering the menu row cannot shift the dialog's hook slots.
  const hookState = new Map()
  let activeComponent = 'root'
  const React = {
    // Function components are inlined so the test can walk the produced tree
    // and invoke a real click handler. `useEffect` runs inline once per render,
    // which is enough to install the dialog's window listener.
    createElement: (type, props, ...children) => {
      if (typeof type !== 'function') return { type, props, children }
      const previous = activeComponent
      activeComponent = type.name || 'anonymous'
      try {
        return type({ ...(props ?? {}), children })
      } finally {
        activeComponent = previous
      }
    },
    Fragment: 'Fragment',
    useState: (initial) => {
      if (!hookState.has(activeComponent)) hookState.set(activeComponent, { slots: [], cursor: 0 })
      const state = hookState.get(activeComponent)
      const slot = state.cursor++
      if (!(slot in state.slots)) state.slots[slot] = initial
      return [state.slots[slot], (next) => {
        state.slots[slot] = typeof next === 'function' ? next(state.slots[slot]) : next
      }]
    },
    useEffect: (effect) => { effect() },
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  /** Render one registered component with a fresh hook cursor. */
  const renderComponent = (component) => {
    const state = hookState.get(component.name || 'anonymous')
    if (state !== undefined) state.cursor = 0
    const previous = activeComponent
    activeComponent = component.name || 'anonymous'
    try {
      return component({})
    } finally {
      activeComponent = previous
    }
  }
  const stub = {
    load: (entry) => {
      loaded.push(entry.id)
      const exports = entry.factory((name) => {
        if (name === 'react') return React
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
        throw new Error(`unexpected require: ${name}`)
      })
      registered.push(exports)
    },
  }
  globalThis.window = {
    __ModuleLoader__: stub,
    addEventListener: (name, handler) => { listeners[name] = handler },
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }
  try {
    // eslint-disable-next-line no-eval -- the bundle is a classic browser script
    ;(0, eval)(source)
    check('registered exactly one bundle', loaded.length === 1 && loaded[0] === 'dsh-plugin-simple-delete-session')
    const plugin = registered[0]
    check('bundle exports apply()', typeof plugin?.apply === 'function')
    check('bundle declares the slots dependency', Array.isArray(plugin?.inject) && plugin.inject.includes('slots'))

    // A shell stub with just enough surface for the delete flow: the slot
    // registry, the session mirror, and the navigation primitive. No
    // `uiWorkspace` here on purpose, so the plugin must reach navigation
    // through the model-level `sessions.retain` fallback.
    const components = {}
    const injections = []
    const deletedId = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const previousId = 'session-11111111-2222-3333-4444-555555555555'
    const opened = []
    let cleared = false
    const currentId = deletedId
    const posting = []
    globalThis.fetch = async (url, init) => {
      posting.push({ url, body: JSON.parse(init.body) })
      return { status: 200, json: async () => ({ ok: true, sessionId: deletedId }) }
    }
    const slotCtx = {
      get: (name) => {
        if (name === 'slots') {
          return {
            inject: (key, callback) => { injections.push(key); callback() },
            register: (entry, component) => { components[entry.name] = component; return () => {} },
          }
        }
        if (name === 'locale') return { register: () => {}, getLocale: () => ({ id: 'zh' }), subscribe: () => () => {} }
        if (name === 'sessions') {
          return {
            list: { getSnapshot: () => ({ ids: [previousId, deletedId], current: currentId, byId: { [previousId]: {}, [deletedId]: {} } }) },
            retain: (id) => { opened.push(id); return { sessionId: id, release() {} } },
            refresh: () => {},
            clear: () => { cleared = true },
          }
        }
        if (name === 'workspaces') return { refresh: () => {} }
        return undefined
      },
    }
    plugin.apply(slotCtx)
    check('injects the sidebar session menu slot', injections.includes('sidebar.workspaces.session.menu.item'))
    check('injects the shell overlay slot', injections.includes('shell.overlay'))

    // Drive one full delete of the *currently shown* session through the real
    // dialog component, then assert the shell was navigated off it.
    const dialog = components['shell.overlay']
    check('the overlay registers a dialog component', typeof dialog === 'function')

    const menuComponent = components['sidebar.workspaces.session.menu.item']
    const menuTree = menuComponent({ sessionId: deletedId, displayTitle: 'Demo', useMenuOpenState: () => [true, () => {}] })
    check('the session menu row renders', menuTree?.type !== undefined)
    check('the menu row is a menuitem-shaped control',
      menuTree?.props?.role === 'menuitem' || menuTree?.props?.type === 'button' || menuTree?.children !== undefined)

    // Render the dialog once to let its subscription effect run, then hand it
    // the open event and render again with that state applied.
    renderComponent(dialog)
    check('the dialog subscribes to the open event', typeof listeners['dsh-session-delete:open'] === 'function')
    listeners['dsh-session-delete:open']({ detail: { sessionId: deletedId, title: 'Demo' } })
    const tree = renderComponent(dialog)

    const buttons = []
    const inputs = []
    const labels = []
    const walk = (node) => {
      if (node === null || node === undefined) return
      if (typeof node === 'string') { labels.push(node); return }
      if (typeof node !== 'object') return
      if (node.type === 'button') buttons.push(node)
      if (node.type === 'input') inputs.push(node)
      for (const child of node.children ?? []) walk(child)
    }
    walk(tree)
    check('the dialog renders its buttons', buttons.length >= 2)
    check('the dialog explains the deletion cannot be recovered',
      labels.some((label) => typeof label === 'string' && label.includes('无法找回')))
    check('the dialog renders the acknowledgement checkbox', inputs.length === 1)

    // Tick the acknowledgement, then click 确认删除 on the re-rendered dialog.
    inputs[0].props.onChange({ target: { checked: true } })
    const ticked = renderComponent(dialog)
    const tickedButtons = []
    const walkTicked = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (node.type === 'button') tickedButtons.push(node)
      for (const child of node.children ?? []) walkTicked(child)
    }
    walkTicked(ticked)
    const confirmButton = tickedButtons[tickedButtons.length - 1]
    check('the confirm button is enabled after the acknowledgement',
      confirmButton?.props?.disabled === false)

    confirmButton.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 20))
    check('the delete request targets the deleted session',
      posting.some((entry) => entry.body.sessionId === deletedId && entry.body.force === true && entry.body.action === 'delete'))
    check('the shell navigates through the model primitive when no uiWorkspace exists',
      opened.includes(previousId))
    check('the shell does not clear the selection while a session remains', cleared === false)

    // A shell that does expose `uiWorkspace` must be preferred over the model
    // primitive — that is the call the workspace browser itself uses for a
    // session-row click.
    const viaWorkspace = []
    const uiCtx = {
      get: (name) => {
        if (name === 'slots') return { inject: (key, callback) => callback(), register: () => () => {} }
        if (name === 'locale') return { register: () => {}, getLocale: () => ({ id: 'zh' }), subscribe: () => () => {} }
        if (name === 'sessions') {
          return {
            list: { getSnapshot: () => ({ ids: [previousId, deletedId], current: deletedId, byId: { [previousId]: {}, [deletedId]: {} } }) },
            retain: () => { throw new Error('retain must not be used when uiWorkspace exists') },
            clear: () => {},
          }
        }
        if (name === 'uiWorkspace') return { openSession: (id) => { viaWorkspace.push(id) } }
        return undefined
      },
    }
    const uiPlugin = registered[0]
    uiPlugin.apply(uiCtx)
    // Re-open the flow: dispatch the same window event the menu row sends,
    // tick the acknowledgement, then confirm.
    listeners['dsh-session-delete:open']({ detail: { sessionId: deletedId, title: 'Demo' } })
    const uiDialog = components['shell.overlay']
    const uiTree = renderComponent(uiDialog)
    const uiButtons = []
    const uiInputs = []
    const walkUi = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (node.type === 'button') uiButtons.push(node)
      if (node.type === 'input') uiInputs.push(node)
      for (const child of node.children ?? []) walkUi(child)
    }
    walkUi(uiTree)
    uiInputs[0].props.onChange({ target: { checked: true } })
    const uiTicked = renderComponent(uiDialog)
    const uiTickedButtons = []
    const walkUiTicked = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return
      if (node.type === 'button') uiTickedButtons.push(node)
      for (const child of node.children ?? []) walkUiTicked(child)
    }
    walkUiTicked(uiTicked)
    uiTickedButtons[uiTickedButtons.length - 1].props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 20))
    check('uiWorkspace.openSession is used when the shell provides it', viaWorkspace.includes(previousId))
  } finally {
    delete globalThis.window
    delete globalThis.fetch
  }
})

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
