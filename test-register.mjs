// 验证 dsh-model-sorter 的注册与数据来源。
//
// 覆盖两轮真实故障：
//   1. 插件先 `ctx.get('slots')` 判空就 return —— 服务未 active 时静默退出，
//      模型座位整个消失。
//   2. 只读 per-session 目录 —— 该目录在会话 `modelSelection` 投影就绪前会一直
//      停在 loading/groups 为空，于是列表空白（即使全局 catalog 已装满模型）。
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SRC = 'E:\\随便玩玩dsh\\model-sorter\\client.js'
const assert = (c, m) => { if (!c) throw new Error('ASSERT FAILED: ' + m) }

// ---- React 桩 -----------------------------------------------------------
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  memo: (f) => f,
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useRef: (v) => ({ current: v }),
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

let captured = null
globalThis.window = {
  __ModuleLoader__: { load: (d) => { captured = d } },
  innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {},
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
  head: { appendChild: () => {} },
  body: {}, addEventListener() {}, removeEventListener() {},
}

await import(pathToFileURL(SRC).href)
assert(captured !== null, '模块加载器未被调用')

const mod = captured.factory((name) => {
  if (name === 'react') return React
  if (name === 'react-dom') return { createPortal: (n) => n }
  throw new Error('意外的 require: ' + name)
})

// ---- 假 slots / ctx -----------------------------------------------------
let registrations = []
let injections = []
const fakeSlots = {
  register(options, component) { registrations.push({ options, component }); return () => {} },
  inject(key, cb) { injections.push(key); return cb() },
}

function makeContext({ services, readyNow }) {
  const pending = []
  const makeScope = (deps) => {
    const scope = {}
    for (const d of deps) scope[d] = services[d]
    scope.get = (name) => (name in scope ? scope[name] : services[name])
    return scope
  }
  const ctx = {
    servicesReady: readyNow,
    get(name) { return ctx.servicesReady ? services[name] : undefined },
    inject(deps, cb) {
      pending.push({ deps, cb })
      if (ctx.servicesReady) cb(makeScope(deps))
      return () => {}
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    locale: {
      register() { return () => {} },
      bind() { return (k, p) => (p ? k + JSON.stringify(p) : k) },
    },
  }
  ctx._ready = () => { ctx.servicesReady = true; for (const { deps, cb } of pending.splice(0)) cb(makeScope(deps)) }
  return ctx
}

/** 标准服务集：会话目录与全局 catalog 可分别控制。 */
function makeServices({ directoryGroups = [], catalogGroups = null, directoryThrows = false } = {}) {
  const dirStore = {
    getSnapshot: () => ({
      groups: directoryGroups,
      current: null,
      pending: null,
      status: directoryGroups.length > 0 ? 'ready' : 'loading',
      error: null,
      failures: [],
    }),
    subscribe: () => () => {},
  }
  const catStore = {
    getSnapshot: () => (catalogGroups === null
      ? { value: null, status: 'loading', error: null }
      : { value: { groups: catalogGroups }, status: 'ready', error: null }),
    subscribe: () => () => {},
  }
  return {
    slots: fakeSlots,
    modelDirectories: {
      catalog: { store: catStore, load: () => Promise.resolve() },
      directoryFor: () => {
        if (directoryThrows) throw new Error('ui-model-selection: session resolved no binding')
        return { store: dirStore, load: () => Promise.resolve(), select: () => Promise.resolve({ ok: true }) }
      },
    },
    sessions: { subagentAddress: () => undefined },
  }
}

function applyWith(services) {
  registrations = []; injections = []
  const ctx = makeContext({ services, readyNow: true })
  mod.apply(ctx)
  return registrations.find((r) => r.options.name === 'conversation.input.model')
}

// ---- 1. 基本注册 ---------------------------------------------------------
console.log('=== 1. 基本注册 ===')
{
  const reg = applyWith(makeServices())
  assert(reg !== undefined, '应注册 conversation.input.model')
  assert(reg.options.priority === -1000, `priority 应为 -1000，实为 ${reg.options.priority}`)
  assert(reg.options.locale === 'model-sorter', 'locale 命名空间错误')
  console.log('  注册成功，priority=-1000 ✓')
}

// ---- 2. 服务延迟就绪 -----------------------------------------------------
console.log('\n=== 2. 服务延迟就绪（不静默退出）===')
{
  registrations = []
  const services = makeServices({ catalogGroups: [{ id: 'p', name: 'P', models: [{ id: 'GLM-5.3', name: 'GLM-5.3' }] }] })
  const ctx = makeContext({ services, readyNow: false })
  mod.apply(ctx)
  assert(registrations.length === 0, '未就绪时不应注册')
  ctx._ready()
  assert(registrations.some((r) => r.options.name === 'conversation.input.model'), '就绪后必须完成注册')
  console.log('  未就绪时排队 → 就绪后注册 ✓')
}

// ---- 3. inject 声明完整 -------------------------------------------------
console.log('\n=== 3. inject 声明 ===')
for (const dep of ['slots', 'locale', 'modelDirectories', 'sessions']) {
  assert(mod.inject.includes(dep), `应声明 ${dep}`)
}
console.log(`  ${mod.inject.join(', ')} ✓`)

// ---- 4. 核心：全局 catalog 兜底 -----------------------------------------
console.log('\n=== 4. 会话目录为空时用全局 catalog 兜底（本轮修复点）===')
{
  const reg = applyWith(makeServices({
    directoryGroups: [],   // 会话目录：空（投影未就绪）
    catalogGroups: [{ id: 'our-free-model', name: 'OFM', models: [{ id: 'GLM-5.3', name: 'GLM-5.3' }] }],
  }))
  const injected = reg.options.inject('s1')
  assert(injected.catalog !== null && injected.catalog !== undefined, 'inject 必须提供全局 catalog')
  const cat = injected.catalog.getSnapshot()
  assert(cat.value.groups.length === 1, '全局 catalog 应有 1 组')
  const dir = injected.directory.getSnapshot()
  assert(dir.groups.length === 0, '会话目录本身为空（模拟投影未就绪）')
  console.log('  会话目录为空、全局 catalog 有 1 组 → 组件取 catalog ✓')
}

// ---- 5. 目录解析失败也不影响列表 ---------------------------------------
console.log('\n=== 5. directoryFor 抛错时的健壮性 ===')
{
  const reg = applyWith(makeServices({
    directoryThrows: true,
    catalogGroups: [{ id: 'p', name: 'P', models: [{ id: 'X', name: 'X' }] }],
  }))
  const injected = reg.options.inject('s1')
  assert(injected.directory !== null && injected.directory !== undefined, '应提供代理 directory store（解析失败时回落到空快照）')
  assert(injected.catalog !== null, 'catalog 仍必须可用（列表不空白）')
  const snap = injected.directory.getSnapshot()
  assert(Array.isArray(snap.groups) && snap.groups.length === 0, `解析失败时空快照 groups 应为空，实为 ${JSON.stringify(snap.groups)}`)
  injected.load()
  console.log('  解析失败 → 代理 store 返回空快照，但 catalog 可用、load 不抛 ✓')
}

// ---- 5b. 解析失败后 select 明确报错而非静默 resolve(undefined) -------
console.log('\n=== 5b. 解析失败时 select 拒绝并带可读错误 ===')
{
  const reg = applyWith(makeServices({ directoryThrows: true, catalogGroups: [] }))
  const injected = reg.options.inject('s1')
  let rejected = null
  try {
    await injected.select({ provider: 'p', model: 'X' })
  } catch (error) {
    rejected = error
  }
  assert(rejected !== null, 'select 必须 reject（不能静默成功）')
  assert(String(rejected.message).includes('no model directory'), `错误信息应说明目录不可用，实为 ${rejected.message}`)
  console.log('  select 拒绝: ' + rejected.message + ' ✓')
}

// ---- 5c. 解析恢复：首次失败后 directoryFor 可用时自动接管 -------
console.log('\n=== 5c. 解析失败后恢复 ===')
{
  let fail = true
  const base = makeServices({ catalogGroups: [{ id: 'p', name: 'P', models: [{ id: 'A', name: 'A' }] }] })
  const origDirFor = base.modelDirectories.directoryFor
  let realCalls = 0
  base.modelDirectories.directoryFor = (...args) => {
    if (fail) throw new Error('session resolved no binding')
    realCalls += 1
    const d = origDirFor(...args)
    // 模拟原生 ModelDirectory：select 成功后把 groups 写进快照
    const snap = d.store.getSnapshot()
    const selected = { groups: [{ id: 'p', name: 'P', models: [{ id: 'A', name: 'A' }] }], current: { provider: 'p', model: 'A' }, pending: null, status: 'ready', error: null, failures: [] }
    const wrapped = {
      store: {
        getSnapshot: () => selected,
        subscribe: d.store.subscribe,
      },
      load: d.load,
      select: async () => { return { ok: true, value: undefined } },
    }
    return wrapped
  }
  const reg = applyWith(base)
  const injected = reg.options.inject('s1')
  assert(injected.directory.getSnapshot().groups.length === 0, '解析失败时快照为空')
  fail = false
  const store = injected.directory
  // select 触发 refreshDirectory，成功解析后应自动订阅真实 store
  const result = await injected.select({ provider: 'p', model: 'A' })
  assert(result && result.ok === true, `恢复后 select 应成功，实为 ${JSON.stringify(result)}`)
  assert(realCalls >= 1, `directoryFor 应被再次调用，实为 ${realCalls} 次`)
  const snap = store.getSnapshot()
  assert(snap.groups.length === 1, `恢复后快照应有 1 组，实为 ${snap.groups.length}`)
  console.log('  恢复后 select 成功、快照自动接管 ✓')
}

// ---- 6. load 同时触发两个来源 -------------------------------------------
console.log('\n=== 6. load 同时触发两个来源 ===')
{
  let catLoads = 0
  let dirLoads = 0
  const services = makeServices({ catalogGroups: [{ id: 'p', name: 'P', models: [{ id: 'A', name: 'A' }] }] })
  services.modelDirectories.catalog.load = () => { catLoads += 1; return Promise.resolve() }
  const origDirFor = services.modelDirectories.directoryFor
  services.modelDirectories.directoryFor = (...args) => {
    const d = origDirFor(...args)
    d.load = () => { dirLoads += 1; return Promise.resolve() }
    return d
  }
  const reg = applyWith(services)
  reg.options.inject('s1').load()
  assert(catLoads === 1, `应触发 1 次 catalog 加载，实为 ${catLoads}`)
  assert(dirLoads === 1, `应触发 1 次目录加载，实为 ${dirLoads}`)
  console.log(`  catalog=${catLoads} 次、目录=${dirLoads} 次 ✓`)
}

// ---- 7. 空状态文案区分 ---------------------------------------------------
console.log('\n=== 7. 空状态按原因区分 ===')
{
  const src = readFileSync(SRC, 'utf8')
  assert(src.includes("'model.catalogError'"), '应有 catalog 错误文案')
  assert(src.includes('const emptyReason'), '应有 emptyReason 分支')
  assert(!src.includes("nameRows.length === 0 ? h('div', { className: 'msr_strip' }, translate('model.searchEmpty'))"),
    '不应在空列表时无条件显示 searchEmpty')
  console.log('  搜索 / 错误 / 加载 / 真的没有 —— 四种原因分开 ✓')
}

console.log('\nALL CHECKS PASSED')