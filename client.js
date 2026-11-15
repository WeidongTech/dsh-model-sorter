// dsh-model-sorter — 浏览器半。
//
// 接管 conversation.input.model 槽位，替换 DSH 原生模型选择器，提供：
//   • 字母索引栏（A–Z、#）：只列实际出现的字母，点击跳到该字母的第一行；
//   • 版本倒序：GLM-5.3 在 GLM-5.2 之上，5.10 在 5.9 之上（不是浮点比较）；
//   • 同族归并：DeepSeek-V4.1-Flash 与 DeepSeek V4 1 Flash 归为一组；
//   • 搜索：只在模型数 > 4 时出现。
//
// 不接入任何 provider：数据完全来自宿主注入的 per-session ModelDirectory，
// 与原生选择器读的是同一份目录。因此本插件可以与任何 provider 插件共存。
window.__ModuleLoader__.load({
  id: 'dsh-model-sorter',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useSyncExternalStore } = React

    const CSS_ID = 'dsh-model-sorter/picker.css'
    const NS = 'model-sorter'

    // ---- 语言 -------------------------------------------------------------
    const zh = {
      'model.placeholder': '选择模型',
      'model.searchPlaceholder': '搜索模型…',
      'model.searchEmpty': '没有匹配的模型。',
      'model.empty': '暂无可用模型。',
      'model.loading': '正在加载模型列表…',
      'model.retry': '重新加载',
      'model.back': '返回',
      'model.providersCount': '{count} 个渠道',
      'model.indexLabel': '按首字母跳转',
      'model.sortByName': '按名称',
      'model.sortByProvider': '按供应商',
      'model.unavailable': '此会话暂不可切换模型',
      'model.selectFailed': '选择失败：{message}',
      'model.groupFailed': '{name} 加载失败：{message}',
      'model.catalogError': '模型目录读取失败：{message}',
      'provider.account': '账户',
      'model.effortLabel': '推理强度',
      'model.effortDefault': '默认',
      'model.effortMax': '最强',
      'model.effortOff': '关闭思考',
    }
    const en = {
      'model.placeholder': 'Select a model',
      'model.searchPlaceholder': 'Search models…',
      'model.searchEmpty': 'No matching models.',
      'model.empty': 'No models available.',
      'model.loading': 'Loading model list…',
      'model.retry': 'Reload',
      'model.back': 'Back',
      'model.providersCount': '{count} providers',
      'model.indexLabel': 'Jump to letter',
      'model.sortByName': 'Name',
      'model.sortByProvider': 'Provider',
      'model.unavailable': 'Model selection is unavailable for this session',
      'model.selectFailed': 'Selection failed: {message}',
      'model.groupFailed': '{name} failed to load: {message}',
      'model.catalogError': 'Model catalog failed to load: {message}',
      'provider.account': 'Account',
      'model.effortLabel': 'Effort',
      'model.effortDefault': 'Default',
      'model.effortMax': 'Max',
      'model.effortOff': 'Thinking off',
    }

    // ---- 空快照 -----------------------------------------------------------
    const EMPTY_DIRECTORY_SNAPSHOT = Object.freeze({ groups: [], current: null, pending: null, status: 'idle', error: null, failures: [] })
    /** 全局 catalog 的空快照；形状与 ModelCatalogDirectory.store 一致。 */
    const EMPTY_CATALOG_SNAPSHOT = Object.freeze({ value: null, status: 'idle', error: null })
    const NOOP_SUBSCRIBE = () => () => {}

    // =====================================================================
    // 排序：纯字符串算法，不依赖任何 provider 数据
    // =====================================================================

    /**
     * 去掉模型名前面的厂商路径。
     *
     * 同一个模型在目录里有三种叫法：裸显示名（`MiniMax-M3.1-Flash`）、
     * 带厂商前缀（`MiniMax/MiniMax-M3.1-Flash`、`kimi/kimi-k2.8-preview`）、
     * 厂商封装的（`deepseek-ai/DeepSeek-V4.1-Flash`）。路径段是路由命名空间，
     * 不是模型身份的一部分：留着它会把同一个族拆成多个排序桶
     * （`kimi/kimi k` 与 `kimi k`），于是 `Kimi-K2.8` 反而排在 `Kimi-K2.5` 下面。
     */
    function stripVendorPath(base) {
      let s = String(base ?? '').trim()
      // 最多两层：`channel/vendor/model` 会出现，`a/b/c/d` 不会。
      for (let i = 0; i < 2; i += 1) {
        const cut = s.indexOf('/')
        if (cut <= 0) break
        const head = s.slice(0, cut)
        // 命名空间是 id 形状的 token：不含空格，所以只是名字里带斜杠的短语不动。
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(head)) break
        const rest = s.slice(cut + 1).trim()
        if (rest === '') break
        s = rest
      }
      return s
    }

    /** 去掉聚合展示名里带的 provider 前缀（"Alibaba Cloud Deepseek V4 1 Flash"、"Kilo …"）。 */
    function stripNamePrefix(base) {
      return stripVendorPath(base).replace(/^\s*(alibaba\s+cloud|alibaba|eac|kilo)\s+/i, '')
    }

    /**
     * 目录展示名里非模型身份的后缀：
     *   • 积分倍率 / 折扣（"· x0.18"、"· x0.12→x0.06"、"· x2.0"）；
     *   • 免费标记（"· 免费"、"-Free"）；
     *   • 发布日期戳（"0731"、"1017"）。
     *
     * 这些是 provider 的运营信息，不是模型名字。不剥掉，同一个模型会因价格标签
     * 被拆成好几行 —— 选择器里出现一串"看起来一模一样"的 DeepSeek-V4.1-Flash。
     */
    const DECORATION = /(?:[\s·・|/_\-]+)(?:x\s*\d+(?:\.\d+)?(?:\s*[→>\-–]\s*x?\d+(?:\.\d+)?)?|免费|free)\s*$/i
    const DATE_STAMP = /(?:[\s\-_·・|]+)?(\d{4})\s*$/

    /**
     * 把展示名拆成「模型名 + 装饰后缀」。
     * @param base 目录里的展示名。
     * @returns 干净名字与被剥掉的后缀（后缀用作渠道徽章，例如 "x0.18"、"免费"）。
     */
    function splitDecoration(base) {
      let s = String(base ?? '').trim()
      const parts = []
      for (let i = 0; i < 4; i += 1) {
        const match = DECORATION.exec(s)
        if (match === null) break
        parts.unshift(s.slice(match.index).replace(/^[\s·・|/_\-]+/, '').trim())
        s = s.slice(0, match.index).trim()
      }
      const date = DATE_STAMP.exec(s)
      if (date !== null) {
        const head = s.slice(0, date.index).trim()
        // 只剥"真名字 + 日期戳"；纯数字名不剥（那是模型名本身）。
        if (head !== '' && /[A-Za-z\u4e00-\u9fff]/.test(head)) {
          parts.unshift(date[1])
          s = head
        }
      }
      return { name: s, decoration: parts.filter((part) => part !== '').join(' · ') }
    }

    /** 只取干净名字（用于分组与标题）。 */
    function stripDecorations(base) {
      return splitDecoration(base).name
    }

    /**
     * 归并用的 key：跨 provider 合并同一个模型。
     * 大小写与 -/./_ 分隔符无关（"Deepseek-V4.1-Flash" === "DeepSeek V4 1 Flash"），
     * 积分倍率、免费标记与发布日期戳都不参与身份。
     */
    function modelGroupKey(base) {
      let s = stripDecorations(stripNamePrefix(base)).toLowerCase()
      s = s.replace(/[-_.]+/g, ' ')
      s = s.replace(/\s+/g, ' ').trim()
      s = s.replace(/\s+\d{3,}$/, '')
      s = s.replace(/\s+free$/i, '')
      return s
    }

    /** 组标题的候选名（已剥掉装饰后缀）。 */
    function prettyCandidate(base) {
      return stripDecorations(stripNamePrefix(base)).trim()
    }

    /** 组标题：出现次数最多的清理后名字（按归一键投票，避免同一族因分隔符拆票）。 */
    function groupDisplayName(lanes) {
      const votes = new Map()
      for (const lane of lanes) {
        const cand = prettyCandidate(lane.display.base)
        if (cand === '') continue
        const k = modelGroupKey(cand)
        const vote = votes.get(k)
        if (vote === undefined) votes.set(k, { count: 1, text: cand })
        else vote.count += 1
      }
      const ranked = [...votes.values()].sort((a, b) => b.count - a.count || a.text.length - b.text.length)
      return ranked.length > 0 ? ranked[0].text : ''
    }

    /**
     * 该渠道与组标题的差异，作为短徽章。
     * 名字一致时用被剥掉的装饰（积分倍率 / 免费 / 日期）当徽章，
     * 这样合并后仍能看出该渠道的价格档；完全一致时返回 null。
     */
    function variantSuffixOf(lane, key) {
      const { name, decoration } = splitDecoration(stripNamePrefix(lane.display.base))
      const s = name.toLowerCase().replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim()
      if (s !== key) {
        if (s.startsWith(`${key} `)) {
          const rest = s.slice(key.length + 1).trim()
          if (rest !== '') return rest.charAt(0).toUpperCase() + rest.slice(1)
        }
        return s
      }
      return decoration === '' ? null : decoration
    }

    /**
     * our-free-model 的渠道徽标。
     *
     * 免费渠道和它的 region 限流档共用同一批模型名，只靠 provider 显示名很难
     * 一眼认出「这条是免费的」；这里给它们一个固定短标，选择器里可直接区分。
     * 其它 provider 返回 null（它们本来就靠 provider 名区分）。
     */
    function ourFreeTagOf(providerId) {
      const id = String(providerId ?? '')
      if (id === 'our-free-model') return 'our-free'
      if (id === 'our-free-model-region') return 'our-free · region'
      return null
    }

    /** 渠道排序：免费渠道排最前，其次 region 档，其余按原名。 */
    function laneRankOf(providerId) {
      const id = String(providerId ?? '')
      if (id === 'our-free-model') return 0
      if (id === 'our-free-model-region') return 1
      return 2
    }

    /**
     * our-free-model 内部的上游渠道。
     *
     * 同一个 provider 路由下混了多条上游渠道，目录里的展示名已经带了渠道标记：
     *   • Kilo 渠道 → "Kilo <模型>"；
     *   • EAC（co-paid）→ "EAC <模型>"；
     *   • 聚合渠道（阿里巴巴等）→ "<Provider 名> <模型>"，如 "Alibaba Cloud …"；
     *   • 组合（fallback 链）→ id 前缀 `combo:`；
     *   • 其余是匿名免费池（seal / opencode 等）。
     * 返回 null 表示不是 our-free-model 的渠道（调用方不加渠道徽章）。
     */
    function ourFreeChannelOf(providerId, modelId, rawName) {
      const provider = String(providerId ?? '')
      const isOurFree = provider === 'our-free-model' || provider === 'our-free-model-region'
      if (!isOurFree) return null
      const id = String(modelId ?? '')
      const name = String(rawName ?? '').trim()
      if (id.startsWith('combo:')) return 'combo'
      if (/^kilo\b/i.test(name)) return 'Kilo'
      if (/^eac\b/i.test(name)) return 'EAC'
      if (/^alibaba(\s+cloud)?\b/i.test(name)) return 'Alibaba'
      return 'free'
    }

    /**
     * 名字首字母 → 索引栏字母：拉丁字母取 A–Z，数字与无法归类的一律 `#`。
     *
     * 模型名以拉丁为主（`DeepSeek-V4.1-Flash`、`GLM-5.3`），所以优先取第一个 ASCII 字母。
     * 以非 ASCII 开头的名字否则会全挤进同一个桶，因此对模型名里真实出现过的少数汉字
     * 按拼音首字母映射；其余回退 `#`。
     */
    const PINYIN_INITIALS = {
      通: 'T', 义: 'Y', 千: 'Q', 问: 'W', 智: 'Z', 谱: 'Z', 豆: 'D', 包: 'B',
      混: 'H', 元: 'Y', 星: 'X', 火: 'H', 昆: 'K', 仑: 'L', 文: 'W', 心: 'X',
      一: 'Y', 言: 'Y', 商: 'S', 汤: 'T', 讯: 'X', 飞: 'F', 阿: 'A', 里: 'L',
      百: 'B', 炼: 'L', 华: 'H', 为: 'W', 字: 'Z', 节: 'J', 跳: 'T', 动: 'D',
      推: 'T', 荐: 'J', 免: 'M', 费: 'F', 组: 'Z', 官: 'G', 方: 'F', 账: 'Z',
      户: 'H', 渠: 'Q', 道: 'D', 聚: 'J', 合: 'H', 平: 'P', 台: 'T', 模: 'M',
      型: 'X', 强: 'Q', 度: 'D', 默: 'M', 认: 'R', 余: 'Y', 额: 'E', 倍: 'B',
      率: 'L', 查: 'C', 不: 'B', 到: 'D',
    }

    function initialOf(name) {
      const text = stripVendorPath(name).trim()
      if (text === '') return '#'
      const first = text[0]
      if (/[0-9]/.test(first)) return '#'
      if (/[a-z]/i.test(first)) return first.toUpperCase()
      const mapped = PINYIN_INITIALS[first]
      if (mapped !== undefined) return mapped
      // 靠后的 ASCII 字母仍可给出可用桶（"· DeepSeek"）。
      const latin = /[a-z]/i.exec(text)
      return latin === null ? '#' : latin[0].toUpperCase()
    }

    /** 索引栏顺序：A–Z，然后 `#`。 */
    function compareInitials(left, right) {
      if (left === right) return 0
      if (left === '#') return 1
      if (right === '#') return -1
      return left < right ? -1 : 1
    }

    /**
     * 把模型名拆成 (family, version, suffix) 用于排序。
     *
     * "DeepSeek-V4.1-Flash" -> { family: "deepseek v", parts: [4, 1], suffix: "flash" }
     * "GLM-5.3"             -> { family: "glm",        parts: [5, 3], suffix: "" }
     *
     * family 是第一个数字之前的部分，因此同一个模型的各版本落在同一段里，
     * 不会因为档位后缀（Flash / Pro）而散开。数字粘在单位上是容量而非版本
     * （`Flint 40b`），结尾日期戳（`…-1017`、`…-2026-06-08`）是快照而非新版本，
     * 两者都在解析前剔除。厂商路径也不属于身份，否则
     * `kimi/kimi-k2.8-preview` 与 `Kimi-K2.6` 会读成两个族。
     *
     * 点分版本展开成逐个整数，而不是浮点：`Number("5.10")` 是 `5.1`，
     * 会让 `GLM-5.10` 与 `GLM-5.1` 同级且排在 `GLM-5.9` 之下。展开成 `[5, 10]`
     * 才让 5.10 真正压过 5.9。
     */
    function versionKeyOf(name) {
      let text = stripVendorPath(name)
      // 容量（`40b`、`120B`）永远不是版本号。
      text = text.replace(/\d+(?:\.\d+)?\s*[bB](?![a-z])/g, ' ')

      // 结尾日期戳是快照标签，但仍有排序意义：同一版本的两个快照里，
      // 日期更新的那个是更新的产物，所以单独留作降序键。
      let stamp = null
      const fullDate = /[-_\s]+((?:19|20)\d{2})[-_\s]+(\d{1,2})[-_\s]+(\d{1,2})\s*$/.exec(text)
      if (fullDate !== null) {
        stamp = Number(fullDate[1]) * 10000 + Number(fullDate[2]) * 100 + Number(fullDate[3])
        text = text.slice(0, fullDate.index)
      } else {
        const shortStamp = /[-_\s]+(\d{3,4})\s*$/.exec(text)
        // 只有前面已有版本号时才算快照：`-1017` 是快照，`Kimi-100` 是完整版本名。
        if (shortStamp !== null && /\d/.test(text.slice(0, shortStamp.index))) {
          stamp = Number(shortStamp[1])
          text = text.slice(0, shortStamp.index)
        }
      }

      const firstDigit = text.search(/\d/)
      const head = firstDigit < 0 ? text : text.slice(0, firstDigit)
      const tail = firstDigit < 0 ? '' : text.slice(firstDigit)
      const parts = []
      for (const match of tail.matchAll(/\d+(?:\.\d+)*/g)) {
        // 点分部分逐个整数，让 5.10 排在 5.9 之上，而不是塌缩成浮点 5.1。
        for (const piece of match[0].split('.')) parts.push(Number(piece))
      }
      const normalize = (value) => value
        .toLowerCase()
        .replace(/[*.]/g, ' ')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      const family = normalize(head)
      const suffix = normalize(tail.replace(/\d+(?:\.\d+)*/g, ' '))
      return {
        family: family === '' ? normalize(stripVendorPath(name)) : family,
        parts,
        suffix,
        stamp,
      }
    }

    /**
     * 新版本在前。
     *
     * 字母桶打头，让列表读起来与索引栏一致。桶内按族分组、版本号降序
     * —— `GLM-5.3` 在 `GLM-5.2` 之上、`GLM-5.2` 在 `GLM-5.1` 之上 ——
     * 纯名字排序只是碰巧对，`GLM-5.10` 一出现就会错。档位后缀（`Flash`、`Pro`）
     * 在版本相同时按字母断开，最后用原始名字做稳定兜底，使顺序不依赖目录到达顺序。
     *
     * 两侧都按去掉厂商路径后的身份名比较，所以同一个模型经由不同命名空间
     * （`Kimi-K2.8-Preview` 与 `kimi/kimi-k2.8-preview`）永远不会落在两个不同的段里。
     */
    function compareModelNames(left, right) {
      const aName = stripVendorPath(left)
      const bName = stripVendorPath(right)
      const byInitial = compareInitials(initialOf(aName), initialOf(bName))
      if (byInitial !== 0) return byInitial

      const a = versionKeyOf(aName)
      const b = versionKeyOf(bName)
      const byFamily = a.family.localeCompare(b.family, 'zh-Hans-CN')
      if (byFamily !== 0) return byFamily

      const depth = Math.max(a.parts.length, b.parts.length)
      for (let i = 0; i < depth; i += 1) {
        const x = a.parts[i]
        const y = b.parts[i]
        // 缺失的部分低于任何存在的部分，于是新版本在前时
        // "GLM-5.3.1" 在 "GLM-5.3" 之上、"GLM-5.3" 在 "GLM-5" 之上。
        if (x === undefined && y === undefined) break
        if (x === undefined) return 1
        if (y === undefined) return -1
        if (x !== y) return y - x
      }

      const bySuffix = a.suffix.localeCompare(b.suffix, 'zh-Hans-CN')
      if (bySuffix !== 0) return bySuffix

      // 同一版本的两个快照：日期更新的更重要。
      const aStamp = a.stamp ?? -1
      const bStamp = b.stamp ?? -1
      if (aStamp !== bStamp) return bStamp - aStamp

      return aName.localeCompare(bName, 'zh-Hans-CN')
    }

    /**
     * provider 分组顺序：账户与官方渠道在前，其余保持目录原序。
     * 与 DSH 原生选择器的规则一致，所以排序插件不会意外改变 provider 的先后。
     */
    function orderModelProviders(groups) {
      const rank = (group) => (group.id === 'deepseek-account' ? 0 : group.id === 'deepseek-official' ? 1 : 2)
      return [...groups].sort((left, right) => rank(left) - rank(right))
    }

    /**
     * 按供应商视图：每个 provider 一组，组内按模型名排序。
     *
     * 与「按名称」视图并列使用：名称视图跨渠道合并同名模型（同一模型只出现
     * 一次，第二级再选渠道），供应商视图则按 provider 分组直出模型，
     * 适合「我就想用某个供应商的模型」的场景。查询只过滤模型名，
     * 整组没有命中时整组不出现。
     */
    function providerSectionsOf(groups, query) {
      const q = String(query ?? '').trim().toLowerCase().replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ')
      const sections = []
      for (const group of groups ?? []) {
        const models = [...(group.models ?? [])]
          .filter((model) => {
            if (q === '') return true
            const name = String(model.name ?? model.id).toLowerCase().replace(/[-_.]+/g, ' ')
            return name.includes(q)
          })
          .sort((a, b) => compareModelNames(String(a.name ?? a.id), String(b.name ?? b.id)))
        if (models.length > 0) sections.push({ group, models })
      }
      return sections
    }

    // =====================================================================
    // 推理强度
    // =====================================================================

    // 档位强度：包含厂商常用别名（xhigh/extra-high 等），未知档按 medium 计。
    const EFFORT_RANK = { disabled: 0, none: 0, off: 0, minimal: 1, light: 1, low: 1, medium: 2, balanced: 2, high: 3, deep: 3, xhigh: 3.5, 'extra-high': 3.5, max: 4, ultra: 4 }
    const EFFORT_MAX = 4

    function effortStrength(id) {
      if (id === undefined || id === null) return -1
      return EFFORT_RANK[String(id).toLowerCase()] ?? 2
    }

    /** 模型声明的最强档位。 */
    function strongestEffort(reasoning) {
      const efforts = reasoning?.efforts
      if (!Array.isArray(efforts) || efforts.length === 0) return undefined
      let best = efforts[0]
      for (const level of efforts) if (effortStrength(level.id) > effortStrength(best.id)) best = level
      return best
    }

    /**
     * 选择该模型时默认使用的档位：声明档位里**最强的一档**（用户要求选模型即最深思考）。
     *
     * 但只考虑"开启思考"的档位：像 qoder 的 Qwen3.7-Plus 这类只声明了
     * `关闭思考` 一档的模型，若把这一档当成默认，选中模型就等于静默关掉思考——
     * 那正好是用户最不想要的。这里改成"没有正强度档位时不带 effort"，
     * 交给适配器用它自己的默认（通常是开启思考）。
     *
     * 安全性由 commit 的降级重试兜底：目录声明与适配器解析不一致时，
     * 宿主会以 `UNSUPPORTED_REASONING_EFFORT` 拒绝，那一次会去掉 effort 重试。
     */
    function defaultEffortFor(reasoning) {
      const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
      const positive = efforts.filter((level) => effortStrength(level.id) > 0)
      if (positive.length > 0) {
        let best = positive[0]
        for (const level of positive) if (effortStrength(level.id) > effortStrength(best.id)) best = level
        return best.id
      }
      return reasoning?.defaultEffort
    }

    /** 当前选择生效的档位。 */
    function effectiveEffortFor(current, reasoning) {
      const levels = reasoning?.efforts
      if (!Array.isArray(levels) || levels.length === 0) return undefined
      const chosen = current?.reasoningEffort
      if (chosen !== undefined && levels.some((level) => level.id === chosen)) return chosen
      return defaultEffortFor(reasoning)
    }

    // =====================================================================
    // 样式
    // =====================================================================

    const CSS = `
.msr_root{min-width:0;position:relative;display:inline-flex;align-items:center;gap:4px}
.msr_trigger{border-radius:var(--dsw-radius-sm,6px);min-width:0;max-width:min(360px,45cqw);height:28px;color:var(--dsw-alias-label-secondary,#888);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:400;line-height:20px;display:flex;font-family:inherit}
.msr_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.msr_trigger:disabled{color:var(--dsw-alias-label-dimmed,#aaa);cursor:default}
.msr_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.msr_chevron{color:var(--dsw-alias-label-caption,#999);flex:none;transition:transform .12s}
.msr_chevron[data-open="true"]{transform:rotate(180deg)}
.msr_chevronNext{color:var(--dsw-alias-label-caption,#999);font-size:14px;line-height:1;flex:none;margin-left:2px}
.msr_menu{z-index:1100;width:max-content;min-width:min(340px,100vw - 32px);max-width:min(480px,100vw - 32px);max-height:min(420px,100vh - 96px);background-color:var(--dsw-alias-bg-base,#fff);background-color:rgb(from var(--dsw-alias-bg-base,#fff) r g b);background-image:linear-gradient(var(--dsw-alias-bg-overlay,transparent),var(--dsw-alias-bg-overlay,transparent));-webkit-backdrop-filter:blur(20px) saturate(120%);backdrop-filter:blur(20px) saturate(120%);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:var(--dsw-radius-md,10px);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));color:var(--dsw-alias-label-primary,#222);flex-direction:column;padding:4px;display:flex;position:fixed;overflow:hidden;font-size:13px}
.msr_body{display:flex;min-height:0;flex:1;overflow:hidden}
.msr_rail{display:flex;flex-direction:column;align-items:center;gap:1px;padding:2px 2px 2px 0;flex:none;overflow-y:auto;scrollbar-width:none;border-right:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}
.msr_rail::-webkit-scrollbar{display:none}
.msr_railBtn{width:18px;min-height:15px;flex:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#888);font-size:10px;line-height:15px;font-weight:650;cursor:pointer;padding:0;border-radius:4px;font-family:inherit}
.msr_railBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,#222)}
.msr_railBtn[data-active="true"]{color:var(--dsw-alias-brand-primary,#4c6ef5);background:rgba(76,110,245,.14)}
.msr_list{flex:1;min-width:0;overflow-y:auto;padding:2px 2px 2px 6px;scrollbar-width:thin}
.msr_initialHead{position:sticky;top:0;z-index:1;padding:5px 8px 3px;font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--dsw-alias-label-secondary,#888);background-color:var(--dsw-alias-bg-base,#fff);background-image:linear-gradient(var(--dsw-alias-bg-overlay,transparent),var(--dsw-alias-bg-overlay,transparent));border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12))}
.msr_item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px;min-width:0;line-height:18px}
.msr_item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.msr_itemCheck{width:14px;flex:none;color:var(--dsw-alias-brand-primary,#4c6ef5);font-size:12px;text-align:center}
.msr_itemName{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden;flex:1}
.msr_count{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);flex:none;white-space:nowrap}
.msr_badge{font-size:11px;border-radius:4px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));flex:none;white-space:nowrap;line-height:15px}
.msr_note{color:var(--dsw-alias-label-secondary,#888);border-color:transparent}
.msr_tag{font-size:10px;font-weight:600;letter-spacing:.02em;border-radius:4px;padding:1px 5px;flex:none;white-space:nowrap;line-height:14px;color:var(--dsw-alias-brand-primary,#4c6ef5);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4c6ef5) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4c6ef5) 12%,transparent)}
.msr_channel{font-size:10px;font-weight:600;padding:1px 5px;line-height:14px;color:var(--dsw-alias-label-secondary,#888);border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.35))}
.msr_tabs{display:flex;gap:2px;padding:2px 2px 4px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12));margin-bottom:2px}
.msr_tab{border:none;background:0 0;color:var(--dsw-alias-label-secondary,#888);font:inherit;font-size:12px;line-height:16px;padding:4px 9px;border-radius:6px;cursor:pointer;font-family:inherit}
.msr_tab:hover{color:var(--dsw-alias-label-primary,#222)}
.msr_tab[data-active="true"]{color:var(--dsw-alias-label-primary,#222);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.msr_providerHead{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:6px;padding:5px 8px 3px;font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--dsw-alias-label-secondary,#888);background-color:var(--dsw-alias-bg-base,#fff);background-image:linear-gradient(var(--dsw-alias-bg-overlay,transparent),var(--dsw-alias-bg-overlay,transparent));border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12))}
.msr_search{padding:4px 4px 6px;flex:none}
.msr_searchInput{width:100%;box-sizing:border-box;height:26px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;padding:0 7px;outline:none}
.msr_searchInput:focus{border-color:var(--dsw-alias-brand-primary,#4c6ef5)}
.msr_head{display:flex;align-items:center;gap:6px;padding:4px 4px 6px;flex:none;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}
.msr_back{background:0 0;border:none;color:var(--dsw-alias-label-secondary,#888);cursor:pointer;font-size:12px;padding:2px 6px;border-radius:4px;flex:none;font-family:inherit}
.msr_back:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.msr_strip{color:var(--dsw-alias-label-tertiary,#999);padding:8px;font-size:12px;line-height:18px}
.msr_error{color:var(--dsw-alias-state-error-primary,#d33);display:flex;align-items:center;gap:8px}
.msr_retry{background:0 0;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));color:inherit;cursor:pointer;font-size:11px;padding:2px 8px;border-radius:4px;flex:none;font-family:inherit}
.msr_spinner{width:10px;height:10px;border-radius:50%;border:1.5px solid currentColor;border-top-color:transparent;display:inline-block;animation:msr_spin .7s linear infinite}
@keyframes msr_spin{to{transform:rotate(360deg)}}
.msr_effort{position:relative;display:inline-flex;align-items:center;min-width:0}
.msr_effortBtn{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));background:transparent;color:var(--dsw-alias-label-secondary,#888);font-size:11px;line-height:16px;cursor:pointer;font-family:inherit;white-space:nowrap}
.msr_effortBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.msr_effortBtn:disabled{opacity:.55;cursor:default}
.msr_effortMenu{position:absolute;bottom:calc(100% + 6px);right:0;min-width:110px;background-color:var(--dsw-alias-bg-base,#fff);background-color:rgb(from var(--dsw-alias-bg-base,#fff) r g b);background-image:linear-gradient(var(--dsw-alias-bg-overlay,transparent),var(--dsw-alias-bg-overlay,transparent));-webkit-backdrop-filter:blur(20px) saturate(120%);backdrop-filter:blur(20px) saturate(120%);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));border-radius:8px;box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.18));padding:4px;z-index:1200;display:flex;flex-direction:column;gap:1px}
.msr_effortItem{border:none;background:transparent;color:var(--dsw-alias-label-primary,#222);text-align:left;padding:5px 8px;border-radius:5px;cursor:pointer;font-size:12px;line-height:16px;font-family:inherit;white-space:nowrap;display:flex;align-items:center;justify-content:space-between;gap:8px}
.msr_effortItem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.msr_effortCheck{color:var(--dsw-alias-brand-primary,#4c6ef5);font-size:11px}
`

    // =====================================================================
    // 推理强度控件
    // =====================================================================

    function EffortControl({ levels, active, strongest, disabled, onPick, translate }) {
      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (rootRef.current?.contains(event.target) === true) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      if (!Array.isArray(levels) || levels.length === 0) return null

      /**
       * 档位显示名：优先用目录给的名字；`none`/`disabled`/`off` 统一叫「关闭思考」；
       * 最强档（max）用更强说法；其余直接显示 id。
       */
      const labelOf = (id) => {
        if (id === undefined) return translate('model.effortDefault')
        const level = levels.find((entry) => entry.id === id)
        if (level?.name !== undefined && level.name !== '') return level.name
        if (effortStrength(id) <= 0) return translate('model.effortOff')
        if (id === strongest?.id && effortStrength(id) >= EFFORT_MAX) return translate('model.effortMax')
        return id
      }

      // 菜单首项永远是「默认」（不显式带档位，交给适配器决定）。
      // 只有一档的模型（例如 qoder 的 Qwen3.7-Plus 只声明了「关闭思考」）
      // 也必须有这一项，否则用户只能在唯一档位里打转、无法回到默认。
      const options = [{ id: undefined, label: translate('model.effortDefault') }]
        .concat(levels.map((level) => ({ id: level.id, label: labelOf(level.id) })))

      return h('div', { className: 'msr_effort', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'msr_effortBtn',
          disabled: disabled === true,
          title: translate('model.effortLabel'),
          'aria-haspopup': 'listbox',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
        }, labelOf(active)),
        open
          ? h('div', { className: 'msr_effortMenu', role: 'listbox' },
              options.map((option) => h('button', {
                key: option.id ?? '__default__',
                type: 'button',
                role: 'option',
                className: 'msr_effortItem',
                'aria-selected': option.id === active ? 'true' : 'false',
                onClick: () => { setOpen(false); onPick(option.id) },
              },
                h('span', null, option.label),
                option.id === active ? h('span', { className: 'msr_effortCheck' }, '✓') : null,
              )),
            )
          : null,
      )
    }

    // =====================================================================
    // 主选择器
    // =====================================================================

    /**
     * 排序后的模型选择器，占据 `conversation.input.model` 座位。
     *
     * 两级选择：第一级是「去重后的模型名」列表（带字母索引栏），第二级是
     * 该名字下的各 provider 渠道。
     *
     * ⚠️ 数据来源（2026-10-26 修「选择器一片空白」时确定）：
     * 模型列表的**权威来源是全局 catalog**（`modelDirectories.catalog.store`），
     * per-session 的 ModelDirectory 只是它的一层包装：
     * `syncInputs()` 会把 `catalog.value.groups` 拷进会话快照。而那一步有个
     * 「补集条件」——`catalog.status !== "ready" || catalog.value === null ||
     * projected === void 0` 时，会话快照的 status 会停在 `loading`、groups 留空。
     * 也就是说：只要会话的 `modelSelection` 投影还没就绪，per-session 目录就一直
     * 是空的，**即使全局 catalog 早已装满模型**。
     *
     * 因此本组件把 groups 直接读全局 catalog，只把 `current` / `pending` / 选择动作
     * 交给 per-session 目录。这样列表不再受会话投影时序影响，也不会因为目录解析
     * 失败而整片空白。
     */
    function SortedModelSelect({ locked, available, directory, catalog, load, select, t }) {
      const dirState = useSyncExternalStore(
        (fn) => (directory ? directory.subscribe(fn) : NOOP_SUBSCRIBE()),
        () => (directory ? directory.getSnapshot() : EMPTY_DIRECTORY_SNAPSHOT),
      )
      const catState = useSyncExternalStore(
        (fn) => (catalog ? catalog.subscribe(fn) : NOOP_SUBSCRIBE()),
        () => (catalog ? catalog.getSnapshot() : EMPTY_CATALOG_SNAPSHOT),
      )

      // 全局 catalog 是权威；目录只补 current / pending / failures。
      const state = useMemo(() => {
        const catGroups = catState?.value?.groups
        const groups = Array.isArray(catGroups) && catGroups.length > 0 ? catGroups : (dirState.groups ?? [])
        const catStatus = catState?.status ?? 'idle'
        // catalog 出错时以它为准确；catalog 就绪后继续沿用目录自身的 ready/selecting。
        const status = catStatus === 'error'
          ? 'error'
          : catStatus === 'ready'
            ? (dirState.status === 'selecting' ? 'selecting' : 'ready')
            : catStatus
        return {
          groups,
          current: dirState.current ?? null,
          pending: dirState.pending ?? null,
          status,
          error: catState?.error ?? dirState.error ?? null,
          failures: catState?.value?.failures ?? dirState.failures ?? [],
        }
      }, [catState, dirState])

      const [open, setOpen] = useState(false)
      const [stage, setStage] = useState('names') // 'names' | 'providers'
      // 视图模式：'name' 按名称（跨渠道合并同名模型）| 'provider' 按供应商分组直出。
      const [mode, setMode] = useState(() => {
        try { return localStorage.getItem('dsh-model-sorter.mode') === 'provider' ? 'provider' : 'name' } catch { return 'name' }
      })
      // 「按供应商」视图里当前展开的 provider（第二级）。
      const [pickedProvider, setPickedProvider] = useState(null)
      const [pickedKey, setPickedKey] = useState(null)
      const [query, setQuery] = useState('')
      const [highlight, setHighlight] = useState(0)
      const [menuPos, setMenuPos] = useState(null)
      const [activeInitial, setActiveInitial] = useState(null)
      const [selectError, setSelectError] = useState(null)

      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const menuRef = useRef(null)
      const searchRef = useRef(null)
      const listRef = useRef(null)

      const translate = t ?? ((key, params) => {
        const dict = zh[key] !== undefined ? zh[key] : en[key] !== undefined ? en[key] : key
        return String(dict).replace(/\{(\w+)\}/g, (_, name) => (params && params[name] !== undefined ? String(params[name]) : `{${name}}`))
      })

      const accountProviderName = translate('provider.account')

      // provider 分组顺序沿用 DSH 原生规则；组内模型随后由 compareModelNames 排序。
      const groups = useMemo(
        () => orderModelProviders(state.groups ?? []).map((group) => ({
          ...group,
          provider: { id: group.id, name: group.id === 'deepseek-account' ? accountProviderName : group.name },
        })),
        [state.groups, accountProviderName],
      )

      const allChoices = useMemo(() => groups.flatMap((group) => group.models.map((model) => {
        // 每个选择都应用该模型声明的最强档位，选模型时不会静默丢掉深度。
        const reasoningEffort = defaultEffortFor(model.reasoning)
        return {
          group,
          model,
          display: { base: model.name ?? model.id },
          selection: {
            provider: group.id,
            model: model.id,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          },
        }
      })), [groups])

      // ---- 第一级：去重后的模型名 ------------------------------------------
      const nameGroups = useMemo(() => {
        const map = new Map()
        for (const choice of allChoices) {
          const key = modelGroupKey(choice.display.base)
          let entry = map.get(key)
          if (!entry) {
            entry = { key, lanes: [] }
            map.set(key, entry)
          }
          entry.lanes.push(choice)
        }
        for (const entry of map.values()) entry.name = groupDisplayName(entry.lanes)
        // 这里就是排序的落点：族/版本/首字母三键比较，而非目录到达顺序。
        return [...map.values()].sort((a, b) => compareModelNames(a.name, b.name))
      }, [allChoices])

      const showSearch = mode === 'provider' ? allChoices.length > 4 : nameGroups.length > 4
      const filteredNames = useMemo(() => {
        const q = query.trim().toLowerCase().replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ')
        if (!q) return nameGroups
        const scored = []
        for (const entry of nameGroups) {
          const index = entry.name.toLowerCase().indexOf(q)
          if (index < 0) continue
          scored.push({ entry, score: (index === 0 ? 0 : 1) + entry.name.length / 1000 })
        }
        return scored.sort((a, b) => a.score - b.score).map((s) => s.entry)
      }, [nameGroups, query])

      // ---- 字母索引 ---------------------------------------------------------
      // 索引栏只列实际出现的首字母，短目录就是短栏，绝不出现一列死字母。
      // 搜索会收窄列表，索引栏随之跟随过滤后的集合。
      const initials = useMemo(() => {
        const seen = new Set()
        for (const entry of filteredNames) seen.add(initialOf(entry.name))
        return [...seen].sort(compareInitials)
      }, [filteredNames])

      /**
       * 把选中字母的第一个标题滚到列表顶部。
       *
       * 刻意不用 getBoundingClientRect：标题是 position:sticky，列表一旦滚动过，
       * 视口上方的每个标题都贴在容器顶部，rect 差值恒为 0 —— 第二次跳转就永远不动。
       * offsetTop 是布局值，sticky 渲染不改变它，减去列表自身 offset 即得标题在
       * 滚动内容里的真实位置，于是无论列表当前在哪，每次跳转都能落准。
       */
      const jumpTo = useCallback((initial) => {
        setActiveInitial(initial)
        const host = listRef.current
        if (host === null) return
        const target = host.querySelector(`[data-initial="${initial}"]`)
        if (target === null) return
        // 绝对赋值（而非 +=）：重复点同一个字母也会回到该字母顶部，而不是静默无反应。
        host.scrollTop = target.offsetTop - host.offsetTop
      }, [])

      const currentChoice = useMemo(() => (
        state.current === null || state.current === undefined
          ? undefined
          : allChoices.find((c) => c.group.id === state.current.provider && c.model.id === state.current.model)
      ), [allChoices, state.current])
      const currentKey = currentChoice === undefined ? null : modelGroupKey(currentChoice.display.base)

      // ---- 已选模型的推理强度 ------------------------------------------------
      const effortReasoning = currentChoice?.model.reasoning
      const effortLevels = useMemo(() => effortReasoning?.efforts ?? [], [effortReasoning])
      const effortActive = effectiveEffortFor(state.current, effortReasoning)
      const effortStrongest = strongestEffort(effortReasoning)

      const pickEffort = useCallback((level) => {
        if (state.current === null || state.current === undefined || !select) return
        void Promise.resolve(select({
          provider: state.current.provider,
          model: state.current.model,
          ...(level === undefined ? {} : { reasoningEffort: level }),
        })).catch((error) => {
          console.error('[model-sorter] effort change failed', error)
        })
      }, [state.current, select])

      // ---- 第二级：该名字下的各 provider ------------------------------------
      const picked = useMemo(() => nameGroups.find((entry) => entry.key === pickedKey), [nameGroups, pickedKey])
      const pickedLanes = useMemo(() => {
        if (!picked) return []
        // 同一 provider 下若有多条 lane 指向同一模型，只留一条，避免出现
        // 若干无法区分的重复条目。胜者按 id 稳定决定，绝不依赖目录顺序
        // （任意 tie 会在下次目录刷新时静默改道）。
        const byLane = new Map()
        for (const lane of picked.lanes) {
          const key = `${lane.group.id}/${lane.model.id}`
          if (!byLane.has(key)) byLane.set(key, lane)
        }
        const lanes = [...byLane.values()]
        lanes.sort((a, b) => {
          const byRank = laneRankOf(a.group.id) - laneRankOf(b.group.id)
          if (byRank !== 0) return byRank
          const byProvider = String(a.group.provider.name ?? a.group.id).localeCompare(String(b.group.provider.name ?? b.group.id), 'zh-Hans-CN')
          if (byProvider !== 0) return byProvider
          return String(a.model.id).localeCompare(String(b.model.id), 'zh-Hans-CN')
        })
        return lanes
      }, [picked])

      const busy = state.pending !== null && state.pending !== undefined

      // ---- 数据加载 ---------------------------------------------------------
      useEffect(() => {
        if (available && load) load()
      }, [available, load])

      useEffect(() => {
        if (!open) return
        if (state.status === 'idle' || state.status === 'error') {
          if (available && load) load()
        }
      }, [open, state.status, available, load])

      // ---- 开关 -------------------------------------------------------------
      const closeMenu = useCallback((refocus) => {
        setOpen(false)
        setStage('names')
        setPickedKey(null)
        setPickedProvider(null)
        setQuery('')
        setHighlight(0)
        setSelectError(null)
        if (refocus) {
          try { triggerRef.current?.focus() } catch { /* 焦点被拒绝 */ }
        }
      }, [])

      // 切换视图分页：按名称 / 按供应商。选择会记住，下次打开沿用它。
      const chooseMode = useCallback((next) => {
        if (next === mode) return
        setMode(next)
        setStage('names')
        setPickedKey(null)
        setPickedProvider(null)
        setHighlight(0)
        setSelectError(null)
        try { localStorage.setItem('dsh-model-sorter.mode', next) } catch { /* 存储不可用 */ }
      }, [mode])

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (rootRef.current?.contains(event.target) === true) return
          if (menuRef.current?.contains(event.target) === true) return
          closeMenu(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => { document.removeEventListener('mousedown', onDown) }
      }, [open, closeMenu])

      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (stage === 'providers') {
            event.stopPropagation()
            setStage('names')
            setPickedKey(null)
            setPickedProvider(null)
            setQuery('')
            setHighlight(0)
          } else {
            event.stopPropagation()
            closeMenu(true)
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => { document.removeEventListener('keydown', onKey, true) }
      }, [open, stage, closeMenu])

      // 名字列表出现时聚焦搜索框。
      useEffect(() => {
        if (!open || stage !== 'names' || !showSearch) return undefined
        const timer = setTimeout(() => { try { searchRef.current?.focus() } catch { /* 焦点被拒绝 */ } }, 0)
        return () => { clearTimeout(timer) }
      }, [open, stage, showSearch])

      // ---- 菜单定位（固定在触发器上方的 portal）----------------------------
      useLayoutEffect(() => {
        if (!open) { setMenuPos(null); return undefined }
        const place = () => {
          const rect = triggerRef.current?.getBoundingClientRect()
          const node = menuRef.current
          if (rect === undefined || node === null) return
          const width = node.offsetWidth
          const height = node.offsetHeight
          let x = rect.right - width
          let y = rect.top - 8 - height
          if (width > 0) x = Math.min(Math.max(x, 12), window.innerWidth - width - 12)
          if (height > 0) y = Math.min(Math.max(y, 12), window.innerHeight - height - 12)
          setMenuPos((previous) => (previous && previous.left === x && previous.top === y ? previous : { left: x, top: y }))
        }
        place()
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
        if (observer && menuRef.current) observer.observe(menuRef.current)
        return () => {
          observer?.disconnect()
          window.removeEventListener('scroll', place, true)
          window.removeEventListener('resize', place)
        }
      }, [open, stage, pickedKey, filteredNames.length, query])

      // ---- 选择 -------------------------------------------------------------
      // 失败时**不关菜单**，把错误直接渲染在菜单里（msr_error 条）：
      // 之前的实现先关菜单再只往 console 写错误 —— 选择失败在界面上毫无痕迹，
      // 看起来就像「点了没反应」。
      //
      // 降级重试：默认带着「最强档位」去选，宿主若以
      // `UNSUPPORTED_REASONING_EFFORT` 拒绝（目录声明与适配器解析不一致），
      // 去掉 effort 再试一次 —— 保证模型能选中，只是深度回到适配器默认。
      const commit = useCallback(async (selection) => {
        if (!select) return
        setSelectError(null)
        const attempt = async (value) => {
          try {
            const result = await select(value)
            if (result && result.ok === false) {
              return {
                ok: false,
                code: String(result.error?.code ?? ''),
                message: `${result.error?.code ?? ''}${result.error?.code ? ': ' : ''}${result.error?.message ?? ''}`,
              }
            }
            return { ok: true }
          } catch (error) {
            return { ok: false, code: '', message: error instanceof Error ? error.message : String(error) }
          }
        }
        let outcome = await attempt(selection)
        if (!outcome.ok && selection.reasoningEffort !== undefined && /UNSUPPORTED_REASONING_EFFORT/i.test(`${outcome.code} ${outcome.message}`)) {
          const { reasoningEffort: _dropped, ...fallback } = selection
          outcome = await attempt(fallback)
        }
        if (!outcome.ok) {
          setSelectError(outcome.message || outcome.code || 'unknown error')
          return
        }
        closeMenu(true)
      }, [closeMenu, select])

      // 不可用时给出一个禁用的占位触发器，而不是渲染空 —— 否则布局会跳。
      if (!available) {
        return h('div', { className: 'msr_root', ref: rootRef },
          h('button', { type: 'button', className: 'msr_trigger', disabled: true, title: translate('model.unavailable') },
            h('span', { className: 'msr_triggerLabel' }, translate('model.placeholder')),
          ),
        )
      }

      const pending = state.pending

      const pendingKey = useMemo(() => {
        if (!busy || pending === null || pending === undefined) return null
        const lane = allChoices.find((c) => c.group.id === pending.provider && c.model.id === pending.model)
        return lane === undefined ? null : modelGroupKey(lane.display.base)
      }, [busy, pending, allChoices])

      // ---- 第一级行 ---------------------------------------------------------
      const nameRows = (() => {
        const rows = []
        let lastInitial = null
        for (const entry of filteredNames) {
          const initial = initialOf(entry.name)
          // 每个字母段一个标题。标题携带索引栏跳转用的锚点，所以跳转会落在字母上，
          // 而不是列表中间。
          if (initial !== lastInitial) {
            lastInitial = initial
            rows.push(h('div', {
              key: `initial:${initial}`,
              className: 'msr_initialHead',
              'data-initial': initial,
              'aria-hidden': 'true',
            }, initial))
          }
          const isCurrent = entry.key === currentKey
          const pendingHere = busy && entry.key === pendingKey
          rows.push(h('div', {
            key: entry.key,
            role: 'menuitemradio',
            'aria-checked': isCurrent ? 'true' : 'false',
            className: 'msr_item',
            tabIndex: -1,
            onClick: () => { setPickedKey(entry.key); setStage('providers') },
          },
            h('span', { className: 'msr_itemCheck' }, pendingHere ? h('span', { className: 'msr_spinner' }) : (isCurrent ? '✓' : '')),
            h('span', { className: 'msr_itemName' }, entry.name),
            entry.lanes.length > 1 ? h('span', { className: 'msr_count' }, translate('model.providersCount', { count: entry.lanes.length })) : null,
          ))
        }
        return rows
      })()

      // ---- 第二级行 ---------------------------------------------------------
      const laneRows = pickedLanes.map((lane) => {
        const isCurrent = currentChoice !== undefined && currentChoice.group.id === lane.group.id && currentChoice.model.id === lane.model.id
        const pendingHere = busy && pending !== null && pending !== undefined && pending.provider === lane.group.id && pending.model === lane.model.id
        const providerName = lane.group.provider.name ?? lane.group.id
        const variant = picked ? variantSuffixOf(lane, picked.key) : null
        const tag = ourFreeTagOf(lane.group.id)
        const channel = ourFreeChannelOf(lane.group.id, lane.model.id, lane.model.name)
        return h('div', {
          key: `${lane.group.id}/${lane.model.id}`,
          role: 'menuitemradio',
          'aria-checked': isCurrent ? 'true' : 'false',
          className: 'msr_item',
          tabIndex: -1,
          onClick: () => { void commit(lane.selection) },
        },
          h('span', { className: 'msr_itemCheck' }, pendingHere ? h('span', { className: 'msr_spinner' }) : (isCurrent ? '✓' : '')),
          h('span', { className: 'msr_itemName', title: lane.model.name }, providerName),
          tag ? h('span', { className: 'msr_tag', title: lane.group.id }, tag) : null,
          channel !== null && channel !== 'free' ? h('span', { className: 'msr_badge msr_channel', title: lane.model.id }, channel) : null,
          variant ? h('span', { className: 'msr_badge msr_note' }, variant) : null,
        )
      })

      // ---- 按供应商视图 -----------------------------------------------------
      // 与「按名称」并列的分页，两级：先列供应商（默认收起），点进去再看模型。
      const providerSections = useMemo(() => providerSectionsOf(groups, query), [groups, query])
      const allProviderSections = useMemo(() => providerSectionsOf(groups, ''), [groups])

      const choiceByLane = useMemo(() => {
        const map = new Map()
        for (const choice of allChoices) map.set(`${choice.group.id}/${choice.model.id}`, choice)
        return map
      }, [allChoices])

      // 展开的供应商始终从**未过滤**的全集里取，这样搜索不会把标题/表单弄丢；
      // 它下面的模型行再按当前查询收窄。
      const pickedProviderSection = allProviderSections.find((section) => section.group.id === pickedProvider)

      // 第一级：供应商行（带模型数量）
      const providerListRows = providerSections.map((section) => {
        const group = section.group
        const tag = ourFreeTagOf(group.id)
        const hasCurrent = currentChoice !== undefined && currentChoice.group.id === group.id
        return h('div', {
          key: `prov:${group.id}`,
          role: 'menuitemradio',
          'aria-checked': hasCurrent ? 'true' : 'false',
          className: 'msr_item',
          tabIndex: -1,
          onClick: () => { setPickedProvider(group.id); setStage('providers'); setQuery(''); setHighlight(0) },
        },
          h('span', { className: 'msr_itemCheck' }, hasCurrent ? '✓' : ''),
          h('span', { className: 'msr_itemName', title: group.id }, group.provider.name ?? group.id),
          tag ? h('span', { className: 'msr_tag', title: group.id }, tag) : null,
          h('span', { className: 'msr_count' }, translate('model.providersCount', { count: section.models.length })),
          h('span', { className: 'msr_chevron msr_chevronNext', 'aria-hidden': 'true' }, '›'),
        )
      })

      // 第二级：选中供应商的模型行（按当前查询收窄）
      const providerModelRows = (() => {
        const section = pickedProviderSection
        if (section === undefined) return []
        const visible = query.trim() === ''
          ? section.models
          : (providerSectionsOf([section.group], query)[0]?.models ?? [])
        const group = section.group
        const rows = []
        for (const model of visible) {
          const choice = choiceByLane.get(`${group.id}/${model.id}`)
          if (choice === undefined) continue
          const isCurrent = currentChoice !== undefined && currentChoice.group.id === group.id && currentChoice.model.id === model.id
          const pendingHere = busy && pending !== null && pending !== undefined && pending.provider === group.id && pending.model === model.id
          const channel = ourFreeChannelOf(group.id, model.id, model.name)
          const { name: cleanName, decoration } = splitDecoration(stripNamePrefix(model.name ?? model.id))
          rows.push(h('div', {
            key: `${group.id}/${model.id}`,
            role: 'menuitemradio',
            'aria-checked': isCurrent ? 'true' : 'false',
            className: 'msr_item',
            tabIndex: -1,
            onClick: () => { void commit(choice.selection) },
          },
            h('span', { className: 'msr_itemCheck' }, pendingHere ? h('span', { className: 'msr_spinner' }) : (isCurrent ? '✓' : '')),
            h('span', { className: 'msr_itemName', title: model.name }, cleanName),
            channel !== null && channel !== 'free' ? h('span', { className: 'msr_badge msr_channel', title: model.id }, channel) : null,
            decoration !== '' ? h('span', { className: 'msr_badge msr_note' }, decoration) : null,
          ))
        }
        return rows
      })()

      const tabs = h('div', { className: 'msr_tabs', key: 'tabs' },
        h('button', {
          type: 'button',
          className: 'msr_tab',
          'data-active': mode === 'name' ? 'true' : undefined,
          onClick: () => chooseMode('name'),
        }, translate('model.sortByName')),
        h('button', {
          type: 'button',
          className: 'msr_tab',
          'data-active': mode === 'provider' ? 'true' : undefined,
          onClick: () => chooseMode('provider'),
        }, translate('model.sortByProvider')),
      )

      // 空列表的原因要分开说，否则「目录还在加载」和「真的没有模型」都显示成
      // 「没有匹配的模型」，把病根藏了起来（这正是上一轮误判的由来）。
      const emptyReason = (() => {
        if (query.trim() !== '') return translate('model.searchEmpty')
        if (state.status === 'error') return translate('model.catalogError', { message: state.error ?? '' })
        if (state.status === 'loading' || state.status === 'idle') return translate('model.loading')
        return translate('model.empty')
      })()

      const menuChildren = []

      // 搜索框：两个视图共用；回车在「按名称」进入渠道页，"按供应商"直接选第一个命中。
      const searchField = showSearch ? h('div', { className: 'msr_search', key: 'search' },
        h('input', {
          ref: searchRef,
          className: 'msr_searchInput',
          type: 'text',
          value: query,
          placeholder: translate('model.searchPlaceholder'),
          onChange: (event) => { setQuery(event.target.value); setHighlight(0) },
          onKeyDown: (event) => {
            const rowCount = mode === 'provider'
              ? (stage === 'providers' ? providerModelRows.length : providerListRows.length)
              : filteredNames.length
            if (event.key === 'ArrowDown') { event.preventDefault(); setHighlight((i) => Math.min(i + 1, rowCount - 1)) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setHighlight((i) => Math.max(i - 1, 0)) }
            else if (event.key === 'Enter') {
              event.preventDefault()
              if (mode === 'provider') {
                if (stage === 'providers') {
                  const section = pickedProviderSection
                  const model = section?.models?.[0]
                  const choice = section === undefined || model === undefined ? undefined : choiceByLane.get(`${section.group.id}/${model.id}`)
                  if (choice !== undefined) void commit(choice.selection)
                  return
                }
                const first = providerSections[0]
                if (first !== undefined) { setPickedProvider(first.group.id); setStage('providers'); setQuery(''); setHighlight(0) }
                return
              }
              const entry = filteredNames[highlight] ?? filteredNames[0]
              if (entry) { setPickedKey(entry.key); setStage('providers') }
            }
          },
        }),
      ) : null

      if (mode === 'provider' && stage === 'names') {
        menuChildren.push(tabs)
        if (searchField !== null) menuChildren.push(searchField)
        menuChildren.push(h('div', { className: 'msr_list', key: 'provider-list', ref: listRef, role: 'menu' },
          providerListRows.length === 0 ? h('div', { className: 'msr_strip' }, emptyReason) : providerListRows,
        ))
      } else if (mode === 'provider' && stage === 'providers') {
        const section = pickedProviderSection
        const group = section?.group
        menuChildren.push(h('div', { className: 'msr_head', key: 'head' },
          h('button', {
            type: 'button',
            className: 'msr_back',
            onClick: () => { setStage('names'); setPickedProvider(null); setQuery(''); setHighlight(0) },
          }, `‹ ${translate('model.back')}`),
          h('span', { className: 'msr_itemName' }, group === undefined ? '' : (group.provider.name ?? group.id)),
          group === undefined ? null : h('span', { className: 'msr_count' }, translate('model.providersCount', { count: section.models.length })),
          group === undefined || ourFreeTagOf(group.id) === null ? null : h('span', { className: 'msr_tag', title: group.id }, ourFreeTagOf(group.id)),
        ))
        if (searchField !== null) menuChildren.push(searchField)
        menuChildren.push(h('div', { className: 'msr_list', key: 'provider-models', ref: listRef, role: 'menu' },
          providerModelRows.length === 0 ? h('div', { className: 'msr_strip' }, emptyReason) : providerModelRows,
        ))
      } else if (stage === 'names') {
        menuChildren.push(tabs)
        if (searchField !== null) menuChildren.push(searchField)
        // 左侧索引栏 + 列表。栏是独立列，列表滚动时它保持不动 ——
        // 这才是「跳转目标」而不是「跟着滚走的东西」。
        const rail = initials.length > 1
          ? h('div', { className: 'msr_rail', key: 'rail', role: 'navigation', 'aria-label': translate('model.indexLabel') },
              initials.map((initial) => h('button', {
                key: initial,
                type: 'button',
                className: 'msr_railBtn',
                'data-active': activeInitial === initial ? 'true' : undefined,
                onClick: () => jumpTo(initial),
                tabIndex: -1,
              }, initial)))
          : null
        menuChildren.push(h('div', { className: 'msr_body', key: 'body' },
          rail,
          h('div', { className: 'msr_list', ref: listRef, role: 'menu' },
            nameRows.length === 0 ? h('div', { className: 'msr_strip' }, emptyReason) : nameRows,
          ),
        ))
        if ((state.groups ?? []).length === 0 && showSearch && query.trim() === '') {
          menuChildren.push(h('div', { className: 'msr_strip', key: 'hint' },
            state.status === 'loading' ? translate('model.loading') : translate('model.empty'),
          ))
        }
      } else if (stage === 'providers') {
        menuChildren.push(h('div', { className: 'msr_head', key: 'head' },
          h('button', { type: 'button', className: 'msr_back', onClick: () => { setStage('names'); setPickedKey(null) } }, `‹ ${translate('model.back')}`),
          h('span', { className: 'msr_itemName' }, picked ? picked.name : ''),
          picked && picked.lanes.length > 0 ? h('span', { className: 'msr_count' }, translate('model.providersCount', { count: picked.lanes.length })) : null,
        ))
        menuChildren.push(h('div', { className: 'msr_list', key: 'lanes', role: 'menu' }, laneRows))
      }

      if (selectError !== null) {
        menuChildren.push(h('div', { className: 'msr_strip msr_error', key: 'select-error' },
          h('span', { className: 'msr_itemName' }, translate('model.selectFailed', { message: selectError })),
          h('button', { type: 'button', className: 'msr_retry', onClick: () => setSelectError(null) }, '×'),
        ))
      }
      if (state.error) {
        menuChildren.push(h('div', { className: 'msr_strip msr_error', key: 'error' },
          h('span', { className: 'msr_itemName' }, translate('model.selectFailed', { message: state.error })),
          h('button', { type: 'button', className: 'msr_retry', onClick: () => { if (load) load() } }, translate('model.retry')),
        ))
      }
      for (const failure of state.failures ?? []) {
        menuChildren.push(h('div', { className: 'msr_strip', key: `failure:${failure.id}` },
          translate('model.groupFailed', { name: failure.id === 'deepseek-account' ? accountProviderName : failure.name, message: failure.message ?? '' }),
        ))
      }

      const menu = h('div', {
        ref: menuRef,
        className: 'msr_menu',
        role: 'dialog',
        style: menuPos === null ? { visibility: 'hidden', left: 0, top: 0 } : { left: `${menuPos.left}px`, top: `${menuPos.top}px` },
      }, menuChildren)

      return h('div', { className: 'msr_root', ref: rootRef },
        h('div', { className: 'msr_controls', style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
          h('button', {
            type: 'button',
            ref: triggerRef,
            className: 'msr_trigger',
            disabled: locked === true,
            'aria-haspopup': 'listbox',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => {
              if (open) { closeMenu(true); return }
              setOpen(true)
              setStage('names')
              setPickedKey(null)
              setPickedProvider(null)
              setQuery('')
              setHighlight(0)
            },
          },
            h('span', { className: 'msr_triggerLabel' }, currentChoice ? currentChoice.model.name : translate('model.placeholder')),
            busy
              ? h('span', { className: 'msr_spinner' })
              : h('svg', { className: 'msr_chevron', 'data-open': open ? 'true' : 'false', viewBox: '0 0 16 16', width: '12', height: '12', 'aria-hidden': true },
                  h('path', { d: 'M3.5 6l4.5 4.5L12.5 6', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' }),
                ),
          ),
          // 强度控件紧挨模型按钮，声明了档位时才出现。
          h(EffortControl, {
            key: 'effort',
            levels: effortLevels,
            active: effortActive,
            strongest: effortStrongest,
            disabled: locked === true,
            onPick: pickEffort,
            translate,
          }),
        ),
        open ? ReactDOM.createPortal(menu, document.body) : null,
      )
    }

    // =====================================================================
    // 插件主体
    // =====================================================================

    const inject = ['slots', 'locale', 'modelDirectories', 'sessions', 'remote', 'remote.session']

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh, en }),
        'model-sorter: dictionaries',
      )

      // 样式注入一次（随页面存活，无需清理）。
      if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`) === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-model-sorter'
        tag.dataset.pluginCss = CSS_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      }

      // 接管 conversation.input.model。
      //
      // ⚠️ 这里必须用 `ctx.inject([...])` 等待服务就绪，**绝不能**先
      // `ctx.get('slots')` 再 `if (undefined) return`。`ctx.get` 默认 strict：
      // 服务提供者的 fiber 尚未 active 时它返回 undefined，于是插件会在注册
      // 任何组件之前静默退出 —— 模型座位变成空的，界面只剩「暂无可用模型」。
      // `ctx.inject` 则把本插件挂起，等服务 provide 出来再回调；这也是原生
      // ui-model-selection 的写法。
      ctx.inject(['slots', 'modelDirectories', 'sessions', 'remote.session'], (scope) => {
        const directories = scope.modelDirectories
        const sessions = scope.sessions
        const remoteSession = scope.get('remote.session')
        // 全局 catalog：模型列表的权威来源，任何会话都能读到，且不依赖会话投影。
        const globalCatalog = directories.catalog?.store ?? null
        scope.slots.inject('conversation.input.model', () => scope.slots.register({
          name: 'conversation.input.model',
          priority: -1000,
          order: 0,
          locale: NS,
          inject: (sessionId) => {
            // 会话目录可能晚于会话 retain 才可解析（scope/binding 就绪前
            // directoryFor 会抛错）。这里不再"解析一次失败就永远 null"：
            // 用一个可变 holder + 自愈订阅，让组件订阅的 store 在目录就绪后
            // 自动切换过去；select/load 每次都会重试解析。
            const resolveDirectory = () => {
              try {
                return directories.directoryFor(sessionId)
              } catch (error) {
                console.error('[model-sorter] directory resolution failed', error)
                return null
              }
            }
            let directory = resolveDirectory()
            let sessionAvailable = false
            try {
              sessionAvailable = sessions.subagentAddress(sessionId) === undefined
            } catch { sessionAvailable = false }

            const listeners = new Set()
            const emit = () => { for (const fn of [...listeners]) fn() }
            let unsubscribeStore = null
            const attachStore = () => {
              if (typeof unsubscribeStore === 'function') unsubscribeStore()
              unsubscribeStore = directory !== null ? directory.store.subscribe(emit) : null
            }
            attachStore()

            const refreshDirectory = () => {
              if (directory === null) {
                directory = resolveDirectory()
                attachStore()
                emit()
              }
              return directory
            }

            return {
              available: sessionAvailable,
              // 代理 store：始终订阅最新解析出的目录，解析成功后自动切到真实快照。
              directory: {
                getSnapshot: () => (directory !== null ? directory.store.getSnapshot() : EMPTY_DIRECTORY_SNAPSHOT),
                subscribe: (fn) => {
                  listeners.add(fn)
                  return () => { listeners.delete(fn) }
                },
              },
              catalog: globalCatalog,
              // 同时触发全局 catalog 与会话目录：前者保证列表有内容，
              // 后者带上 current/pending 与选择能力。任一失败都不影响另一个。
              load: () => {
                try { directories.catalog?.load?.()?.catch?.(() => {}) } catch { /* catalog 不可用 */ }
                const dir = refreshDirectory()
                if (sessionAvailable && dir !== null) dir.load().catch(() => {})
              },
              // 失败时 reject 而不是静默 resolve(undefined)：菜单里会显示
              // 明确错误条，而不是"点了没反应"。
              // 目录始终解析不出（session scope/binding 尚未就绪）时，
              // 走原生 ModelDirectory.select 的底层 remote 通道兜底——
              // 它只要求 sessionId，不依赖客户端会话 retain。
              select: (selection) => {
                const dir = refreshDirectory()
                if (!sessionAvailable) return Promise.reject(new Error('model selection is unavailable for addressed subagent sessions'))
                if (dir === null) {
                  if (remoteSession === undefined || typeof remoteSession.selectModel !== 'function') {
                    return Promise.reject(new Error('this session has no model directory yet — click again'))
                  }
                  return remoteSession.selectModel({
                    sessionId,
                    provider: selection.provider,
                    model: selection.model,
                    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
                  }).then((result) => {
                    if (result.ok) return result
                    throw new Error(`${result.error?.code ?? ''}${result.error?.code ? ': ' : ''}${result.error?.message ?? ''}`)
                  })
                }
                return dir.select(selection)
              },
            }
          },
        }, SortedModelSelect))
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
