// 验证 dsh-model-sorter 的排序算法。
//
// 从 client.js 抽取纯函数（不依赖 React），覆盖：
//   1. 版本倒序：GLM-5.3 > 5.2 > 5.1；5.10 > 5.9（不是浮点比较）
//   2. 字母索引：# 在最后；A–Z 升序
//   3. 同族归并：DeepSeek-V4.1-Flash 与 DeepSeek V4 1 Flash 同组
//   4. 厂商路径剥离：kimi/kimi-k2.8 与 Kimi-K2.8 同族
//   5. provider 顺序：deepseek-account → deepseek-official → 其余
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'

const SRC = 'E:\\随便玩玩dsh\\model-sorter\\client.js'
const src = readFileSync(SRC, 'utf8')

// 抽取从 stripVendorPath 到 orderModelProviders 之间的纯函数块。
const startMarker = '    function stripVendorPath(base) {'
const endMarker = '    // =====================================================================\n    // 样式'
const a = src.indexOf(startMarker)
const b = src.indexOf(endMarker, a)
if (a < 0 || b < 0) throw new Error(`抽取失败 a=${a} b=${b}`)

const body = src.slice(a, b)

const harness = `${body}

export {
  stripVendorPath, stripNamePrefix, splitDecoration, stripDecorations,
  modelGroupKey, prettyCandidate, groupDisplayName, providerSectionsOf,
  variantSuffixOf, ourFreeTagOf, ourFreeChannelOf, laneRankOf,
  strongestEffort, defaultEffortFor, effectiveEffortFor,
  initialOf, compareInitials, versionKeyOf, compareModelNames,
  orderModelProviders,
}
`

const tmp = 'E:\\随便玩玩dsh\\model-sorter\\.sort-test.mjs'
writeFileSync(tmp, harness, 'utf8')
const m = await import('file:///' + tmp.replace(/\\/g, '/') + '?t=' + Date.now())
unlinkSync(tmp)

const assert = (c, msg) => { if (!c) throw new Error('ASSERT FAILED: ' + msg) }

// ---- 1. 版本倒序 ---------------------------------------------------------
console.log('=== 1. 版本倒序（新版本在前）===')
const versionCases = [
  [['GLM-5.1', 'GLM-5.2', 'GLM-5.3'], ['GLM-5.3', 'GLM-5.2', 'GLM-5.1']],
  [['GLM-5.1', 'GLM-5.10', 'GLM-5.9'], ['GLM-5.10', 'GLM-5.9', 'GLM-5.1']],
  [['DeepSeek-V3', 'DeepSeek-V4.1'], ['DeepSeek-V4.1', 'DeepSeek-V3']],
]
for (const [input, expected] of versionCases) {
  const sorted = [...input].sort(m.compareModelNames)
  assert(JSON.stringify(sorted) === JSON.stringify(expected),
    `${input.join(',')} → 期望 ${expected.join(',')}，实际 ${sorted.join(',')}`)
  console.log(`  ${input.join(' < ')}  →  ${sorted.join(' > ')} ✓`)
}

// ---- 2. 首字母索引 -------------------------------------------------------
console.log('\n=== 2. 首字母索引 ===')
const initialCases = [
  ['GLM-5.3', 'G'], ['DeepSeek-V4.1-Flash', 'D'], ['kimi-k2.8', 'K'],
  ['MiniMax-M3.1', 'M'], ['Qwen3.8', 'Q'], ['1Model', '#'], ['123', '#'],
]
for (const [name, expected] of initialCases) {
  const got = m.initialOf(name)
  assert(got === expected, `${name} → 期望 ${expected}，实为 ${got}`)
  console.log(`  ${name} → ${got} ✓`)
}
// 中文名走拼音首字母
const cjk = m.initialOf('通义千问')
assert(cjk === 'T', `通义千问 → 期望 T，实为 ${cjk}`)
console.log(`  通义千问 → ${cjk}（拼音）✓`)

// # 必须排在最后
const initials = ['B', 'A', '#', 'C'].sort(m.compareInitials)
assert(JSON.stringify(initials) === JSON.stringify(['A', 'B', 'C', '#']), `字母序错误：${initials.join(',')}`)
console.log(`  排序 [B,A,#,C] → ${initials.join(',')} ✓`)

// ---- 3. 厂商路径剥离 -----------------------------------------------------
console.log('\n=== 3. 厂商路径剥离 ===')
const pathCases = [
  ['kimi/kimi-k2.8-preview', 'kimi-k2.8-preview'],
  ['deepseek-ai/DeepSeek-V4.1-Flash', 'DeepSeek-V4.1-Flash'],
  ['MiniMax/MiniMax-M3.1-Flash', 'MiniMax-M3.1-Flash'],
  ['plain-name', 'plain-name'],
]
for (const [input, expected] of pathCases) {
  const got = m.stripVendorPath(input)
  assert(got === expected, `${input} → 期望 ${expected}，实为 ${got}`)
  console.log(`  ${input} → ${got} ✓`)
}
// 名字里带空格的斜杠不是命名空间，不应剥离（head 含空格）
assert(m.stripVendorPath('DeepSeek V4.1 / Flash') === 'DeepSeek V4.1 / Flash', 'head 含空格的斜杠不应剥离')
console.log('  "DeepSeek V4.1 / Flash" 保持不变 ✓')
// 但 head 本身是 id 形状时按设计剥离（最多两层）
assert(m.stripVendorPath('A/B test') === 'B test', 'id 形状 head 应剥离')
assert(m.stripVendorPath('a/b/c/d') === 'c/d', '最多剥两层')
console.log('  id 形状 head 剥离、最多两层 ✓')

// ---- 4. 同族归并 ---------------------------------------------------------
console.log('\n=== 4. 同族归并 ===')
const groupCases = [
  ['DeepSeek-V4.1-Flash', 'DeepSeek V4 1 Flash'],
  ['Deepseek-V4.1-Flash', 'DeepSeek-V4.1-Flash'],
  ['GLM-5.3-Free', 'GLM-5.3'],
]
for (const [left, right] of groupCases) {
  const kl = m.modelGroupKey(left)
  const kr = m.modelGroupKey(right)
  assert(kl === kr, `${left} 与 ${right} 应同族，key: ${kl} vs ${kr}`)
  console.log(`  "${left}" ≡ "${right}" (key="${kl}") ✓`)
}
// 不同版本必须不同族
assert(m.modelGroupKey('GLM-5.2') !== m.modelGroupKey('GLM-5.3'), 'GLM-5.2 与 5.3 不应同族')
console.log('  GLM-5.2 ≠ GLM-5.3 ✓')

// ---- 4b. 装饰后缀（积分倍率 / 免费 / 日期戳）不参与身份 -------------------
console.log('\n=== 4b. 积分倍率 / 免费 / 日期戳合并 ===')
const decorated = [
  // 截图里同一串 DeepSeek-V4.1-Flash 的价格档，必须归为一族
  ['DeepSeek-V4.1-Flash · x0.18', 'DeepSeek-V4.1-Flash'],
  ['DeepSeek-V4.1-Flash · x0.12→x0.06', 'DeepSeek-V4.1-Flash'],
  ['DeepSeek-V4.1-Flash · x0.11', 'DeepSeek-V4.1-Flash'],
  ['DeepSeek V4.1 Flash · x2.0', 'DeepSeek-V4.1-Flash'],
  ['DeepSeek V4.1-Flash 1017 · x0.18', 'DeepSeek-V4.1-Flash'],
  ['DeepSeek-V4.1-Flash-1017 · 免费', 'DeepSeek-V4.1-Flash'],
  ['DeepSeek V4 Flash 0731 · x0.06', 'DeepSeek-V4-Flash'],
]
for (const [left, right] of decorated) {
  const kl = m.modelGroupKey(left)
  const kr = m.modelGroupKey(right)
  assert(kl === kr, `"${left}" 应与 "${right}" 同族，key: ${kl} vs ${kr}`)
  console.log(`  "${left}" ≡ "${right}" ✓`)
}
// 干净名字与装饰被正确拆开
{
  const { name, decoration } = m.splitDecoration('DeepSeek-V4.1-Flash · x0.12→x0.06')
  assert(name === 'DeepSeek-V4.1-Flash', `name 应为 DeepSeek-V4.1-Flash，实为 ${name}`)
  assert(decoration === 'x0.12→x0.06', `decoration 应为 x0.12→x0.06，实为 ${decoration}`)
  console.log(`  拆分: "${name}" + "${decoration}" ✓`)
}
{
  const { name, decoration } = m.splitDecoration('DeepSeek-V4.1-Flash-1017 · 免费')
  assert(name === 'DeepSeek-V4.1-Flash', `日期戳应剥掉，实为 ${name}`)
  assert(decoration === '1017 · 免费', `decor 应为 1017 · 免费，实为 ${decoration}`)
  console.log(`  拆分: "${name}" + "${decoration}" ✓`)
}
// 纯数字名不能被日期戳规则吃掉
assert(m.splitDecoration('1017').name === '1017', '纯数字名不应被当作日期戳剥掉')
console.log('  纯数字名保持 ✓')
// 名字里本来就有的 4 位数字中缀不能误剥（只在末尾）
assert(m.splitDecoration('GPT-4-1106-Turbo').name === 'GPT-4-1106-Turbo', '中缀数字不应剥')
console.log('  中缀数字保持 ✓')
// 合并后的徽章：同名字渠道用价格档做区分
{
  const lane = { display: { base: 'DeepSeek-V4.1-Flash · x0.18' } }
  const key = m.modelGroupKey('DeepSeek-V4.1-Flash')
  const badge = m.variantSuffixOf(lane, key)
  assert(badge === 'x0.18', `徽章应为 x0.18，实为 ${badge}`)
  console.log(`  渠道徽章: ${badge} ✓`)
}

// ---- 4c. our-free-model 渠道标记与排序优先级 ----------------------------
console.log('\n=== 4c. our-free-model 区分标记 ===')
assert(m.ourFreeTagOf('our-free-model') === 'our-free', 'our-free-model 应有 our-free 标记')
assert(m.ourFreeTagOf('our-free-model-region') === 'our-free · region', 'region 档应有 region 标记')
assert(m.ourFreeTagOf('deepseek-account') === null, '其它 provider 不应有标记')
console.log('  our-free-model / region 有标记，其它无 ✓')
assert(m.laneRankOf('our-free-model') < m.laneRankOf('our-free-model-region'), '免费档应排在 region 档前')
assert(m.laneRankOf('our-free-model-region') < m.laneRankOf('alibaba_cloud'), 'region 档应排在普通 provider 前')
console.log('  渠道排序: our-free-model → region → 其它 ✓')

// ---- 4d. 选模型默认最大思考强度 ------------------------------------------
console.log('\n=== 4d. 默认最强思考档 ===')
{
  const reasoning = {
    efforts: [{ id: 'low' }, { id: 'high' }, { id: 'medium' }],
    defaultEffort: 'low',
  }
  assert(m.defaultEffortFor(reasoning) === 'high', `应默认最强档 high，实为 ${m.defaultEffortFor(reasoning)}`)
  console.log('  声明 low/medium/high → 默认 high ✓')
}
{
  const reasoning = { efforts: [{ id: 'minimal' }, { id: 'max' }], defaultEffort: 'minimal' }
  assert(m.defaultEffortFor(reasoning) === 'max', '应默认 max')
  console.log('  声明 minimal/max → 默认 max ✓')
}
{
  // 厂商别名档（xhigh）必须排在 high 之上、max 之下，否则"最强"会选错
  const reasoning = { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'xhigh' }], defaultEffort: 'low' }
  assert(m.defaultEffortFor(reasoning) === 'xhigh', `应默认 xhigh，实为 ${m.defaultEffortFor(reasoning)}`)
  console.log('  声明 low/high/xhigh → 默认 xhigh ✓')
}
{
  const reasoning = { efforts: [], defaultEffort: 'medium' }
  assert(m.defaultEffortFor(reasoning) === 'medium', '无档位列表时应回退 defaultEffort')
  console.log('  无档位列表 → 回退 defaultEffort ✓')
}
{
  // 只声明「关闭思考」一档的模型（qoder Qwen3.7-Plus）：不能默认就把它关掉
  const reasoning = { efforts: [{ id: 'none', name: '关闭思考' }] }
  assert(m.defaultEffortFor(reasoning) === undefined, '只有关闭档时不应自带 effort（保持适配器默认）')
  console.log('  只有「关闭思考」→ 不带 effort（思考保持开启）✓')
}
{
  // 有关闭档但也有正强度档时，仍默认最强
  const reasoning = { efforts: [{ id: 'none' }, { id: 'low' }, { id: 'high' }] }
  assert(m.defaultEffortFor(reasoning) === 'high', '含关闭档时仍应默认最强正强度档')
  console.log('  none/low/high → 默认 high ✓')
}
assert(m.defaultEffortFor(undefined) === undefined, '未声明推理时应返回 undefined')
console.log('  未声明推理 → undefined（不带 effort）✓')

// 当前档位展示：未显式选择时也显示最强档，与实际发送一致
{
  const reasoning = { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' }
  assert(m.effectiveEffortFor({ provider: 'p', model: 'm' }, reasoning) === 'high', '未显式选择时应显示最强档')
  assert(m.effectiveEffortFor({ provider: 'p', model: 'm', reasoningEffort: 'low' }, reasoning) === 'low', '显式选择应优先')
  console.log('  触发按钮显示: 未选=high、显式=low ✓')
}

// ---- 4e. our-free-model 内部渠道标注 ------------------------------------
console.log('\n=== 4e. our-free-model 渠道标注 ===')
{
  const cases = [
    ['our-free-model', 'kilo-auto/free', 'Kilo Auto Free', 'Kilo'],
    ['our-free-model', 'reflection/beam-free', 'Kilo Beam 1.0', 'Kilo'],
    ['our-free-model', 'z-ai/glm-5.3-flash', 'EAC GLM 5.3 Flash', 'EAC'],
    ['our-free-model', 'alibaba_cloud/qwen3.8-max', 'Alibaba Cloud Qwen3.8 Max', 'Alibaba'],
    ['our-free-model', 'combo:recommended-free', '推荐免费组', 'combo'],
    ['our-free-model', 'deepseek-v4.1-flash-free', 'DeepSeek V4.1 Flash', 'free'],
    ['our-free-model-region', 'z-ai/glm-5.3-flash', 'EAC GLM 5.3 Flash', 'EAC'],
  ]
  for (const [provider, id, name, expected] of cases) {
    const got = m.ourFreeChannelOf(provider, id, name)
    assert(got === expected, `"${name}" 渠道应 ${expected}，实为 ${got}`)
    console.log(`  ${provider} / ${id} → ${got} ✓`)
  }
  assert(m.ourFreeChannelOf('deepseek-account', 'x', 'Kilo X') === null, '非 our-free-model 不应标注渠道')
  console.log('  其它 provider 不标注 ✓')
}
// 渠道前缀参与归并：Kilo 前缀剥掉后与同名模型同族
assert(m.modelGroupKey('Kilo Nemotron 3.5 Super VL') === m.modelGroupKey('Nemotron 3.5 Super VL'), 'Kilo 前缀应可归并')
assert(m.modelGroupKey('Alibaba Cloud Qwen3.8 Max') === m.modelGroupKey('Qwen3.8 Max'), 'Alibaba 前缀应可归并')
console.log('  Kilo / Alibaba 前缀可归并 ✓')

// ---- 4f. 按供应商视图 ---------------------------------------------------
console.log('\n=== 4f. 按供应商视图 ===')
{
  const groupsForView = [
    { id: 'our-free-model', name: 'Our Free Model', models: [
      { id: 'glm-5.3', name: 'GLM-5.3' },
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    ] },
    { id: 'deepseek-account', name: 'Account', models: [
      { id: 'dmodel', name: 'DeepSeek-V4.1' },
    ] },
    { id: 'empty-provider', name: 'Empty', models: [] },
  ]
  const sections = m.providerSectionsOf(groupsForView, '')
  assert(sections.length === 2, `空供应商应被丢弃，实为 ${sections.length} 组`)
  assert(sections[0].group.id === 'our-free-model', '组顺序应保持传入顺序')
  assert(sections[0].models.map((x) => x.id).join(',') === 'deepseek-v4.1-flash,glm-5.3,glm-5.2',
    `组内应按模型名排序，实为 ${sections[0].models.map((x) => x.id).join(',')}`)
  console.log(`  分组: ${sections.map((s) => s.group.id).join(' → ')}，组内已排序 ✓`)

  const filtered = m.providerSectionsOf(groupsForView, 'glm')
  assert(filtered.length === 1 && filtered[0].models.length === 2, '查询应只保留命中的模型与分组')
  console.log('  查询过滤: glm → 仅 GLM 两条 ✓')

  const none = m.providerSectionsOf(groupsForView, 'no-such-model')
  assert(none.length === 0, '无命中时应返回空')
  console.log('  无命中 → 空 ✓')
}

// ---- 5. provider 顺序 ----------------------------------------------------
console.log('\n=== 5. provider 顺序 ===')
const groups = [
  { id: 'our-free-model', name: 'OFM' },
  { id: 'deepseek-official', name: 'Official' },
  { id: 'trae', name: 'Trae' },
  { id: 'deepseek-account', name: 'Account' },
]
const ordered = m.orderModelProviders(groups).map((g) => g.id)
assert(ordered[0] === 'deepseek-account', `首项应为 deepseek-account，实为 ${ordered[0]}`)
assert(ordered[1] === 'deepseek-official', `次项应为 deepseek-official，实为 ${ordered[1]}`)
console.log(`  ${ordered.join(' → ')} ✓`)

// ---- 6. 综合：模拟一份真实目录 -------------------------------------------
console.log('\n=== 6. 综合排序（模拟目录）===')
const catalog = [
  'GLM-5.1', 'GLM-5.3', 'GLM-5.2',
  'deepseek-ai/DeepSeek-V4.1-Flash', 'DeepSeek-V3',
  'kimi/kimi-k2.8-preview', 'kimi-k2.6',
  'Qwen3.8-Max', 'MiniMax-M3.1-Flash',
]
const sortedCatalog = [...catalog].sort(m.compareModelNames)
console.log('  排序结果：')
for (const name of sortedCatalog) console.log(`    ${m.initialOf(name)}  ${name}`)

// 断言：同族的相对顺序正确（新版本在前）
const pos = (n) => sortedCatalog.indexOf(n)
assert(pos('GLM-5.3') < pos('GLM-5.2'), 'GLM-5.3 应在 GLM-5.2 之前')
assert(pos('GLM-5.2') < pos('GLM-5.1'), 'GLM-5.2 应在 GLM-5.1 之前')
console.log('  GLM 族版本倒序 ✓')

// 断言：首字母单调不降（# 除外）
let lastInitial = null
let monotonic = true
for (const name of sortedCatalog) {
  const ini = m.initialOf(name)
  if (ini === '#') continue
  if (lastInitial !== null && ini < lastInitial) monotonic = false
  lastInitial = ini
}
assert(monotonic, '首字母必须单调不降')
console.log('  首字母单调 ✓')

// 断言：kimi 的两个版本同族且 2.8 在 2.6 之前
assert(m.stripVendorPath(sortedCatalog[pos('kimi/kimi-k2.8-preview')]) === 'kimi-k2.8-preview', 'kimi 路径未剥离')
assert(pos('kimi/kimi-k2.8-preview') < pos('kimi-k2.6'), 'kimi-k2.8 应在 kimi-k2.6 之前')
console.log('  kimi 族版本倒序（路径已剥离）✓')

console.log('\nALL CHECKS PASSED')
