# dsh-model-sorter

DSH 的**模型选择器排序插件**。接管输入框的模型座位（`conversation.input.model`），
替换原生选择器，提供字母索引与版本倒序。

> 本插件**不接入任何 provider**。它读宿主已有的模型目录，所以可以与任何
> provider 插件共存。

## 数据来源（踩过坑，写清楚）

模型列表的**权威来源是全局 catalog**（`modelDirectories.catalog.store`），
per-session 的 `ModelDirectory` 只是它的一层包装。

原生目录在 `syncInputs()` 里把 `catalog.value.groups` 拷进会话快照，而那一步有个
补集条件：

```js
if (catalog.status !== "ready" || catalog.value === null || projected === void 0) {
  // → 会话快照 status 停在 loading，groups 留空
}
```

也就是说：**只要会话的 `modelSelection` 投影还没就绪，per-session 目录就一直是空的，
即使全局 catalog 早已装满模型**。

因此本插件的 groups 直接读全局 catalog，只把 `current` / `pending` / 选择动作交给
per-session 目录。列表因此不受会话投影时序影响；即便 `directoryFor()` 解析失败，
列表仍然完整，只是选择动作会暂时无效。

三种数据来源的分工：

| 字段 | 来源 | 原因 |
| --- | --- | --- |
| `groups` | 全局 catalog | 不依赖会话投影，任何会话都能读到 |
| `current` / `pending` / `failures` | per-session 目录 | 这些是会话级的 |
| `select()` | per-session 目录 | 选择要走该目录的持久化投影 |

## 能力

| 能力 | 说明 |
| --- | --- |
| **字母索引栏** | A–Z，数字与无法归类的进 `#`。只列实际出现的字母，短目录就是短栏，绝不出现一列死字母。点击跳到该字母第一行，重复点同一个字母也会回到顶部。 |
| **版本倒序** | `GLM-5.3` 在 `GLM-5.2` 之上，`GLM-5.2` 在 `GLM-5.1` 之上。点分版本逐段展开比较，所以 `GLM-5.10` 真的排在 `GLM-5.9` 之上（不是浮点比较）。 |
| **同族归并** | `DeepSeek-V4.1-Flash` 与 `DeepSeek V4 1 Flash` 视为同一模型；结尾的 `Free` 视为同模型的免费档。 |
| **厂商路径剥离** | `kimi/kimi-k2.8-preview` 与 `Kimi-K2.8` 同族。路径是路由命名空间，不是模型身份。 |
| **搜索** | 模型数 > 4 时出现。↑/↓ 移动高亮，Enter 进入渠道列表。 |
| **两级选择** | 第一级是去重后的模型名，第二级是该名字下的各 provider 渠道。 |
| **推理强度** | 模型旁边的小控件，显示并可切换当前模型的思考档位。 |

## 排序规则的细节

排序是三层比较，顺序固定：

1. **首字母桶** —— `A`…`Z`，最后 `#`。
2. **族名** —— 第一个数字之前的部分（`GLM`、`deepseek v`）。同一模型的各版本因此落在同一段，不会因 `Flash`/`Pro` 档位后缀而散开。
3. **版本号** —— 逐段整数、降序。缺失的段低于任何存在的段，于是 `GLM-5.3.1` > `GLM-5.3` > `GLM-5`。

打平时依次用档位后缀、日期戳（同版本的两个快照，日期新的在前）、原始名字兜底。
最后一步是**稳定性保证**：顺序不依赖目录的到达顺序。

两个容易踩的坑，代码里已处理：

- **容量不是版本**：`Flint 40b` 里的 `40` 是容量，会在比较前剔除。
- **日期戳不是版本**：`DeepSeek-V4.1-1017` 的 `1017` 是快照标签，单独留作降序键；但 `Kimi-100` 里的 `100` 是完整版本名，必须保留。

## 安装

本机（开发机，直接链本地目录）：

```powershell
dsh plugin --profile desktop add "E:/随便玩玩dsh/model-sorter"
```

多机/平板（从 GitHub 拉取，本仓库为 public，无需凭据）：

```powershell
# 装最新 main
dsh plugin --profile <你的profile> add github:WeidongTech/dsh-model-sorter

# 或锁定到某个发布版本
dsh plugin --profile <你的profile> add github:WeidongTech/dsh-model-sorter#v0.1.0
```

更新（平板同理）：

```powershell
dsh plugin --profile <你的profile> update dsh-model-sorter
# 若 pnpm 没解析到新提交，重新 add 一次即可
```

装完**重启 DSH**（宿主启动时才组装插件树，重启后浏览器半才会加载）。

> 电脑上改完这个插件后：改 `package.json` 的 `version` → `git commit` → `git push`（可选再打 tag），平板执行上面的 update 即可拿到新版本。本机 profile 用的是 `link:` 本地目录，改完重启 DSH 就生效，不需要经过 GitHub。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-model-sorter
```

## 与 opencode-connect 的关系

`opencode-connect` 早期版本自己接管过模型选择器，导致两个插件抢同一个 `single` 槽位
——谁在某次加载中胜出，决定了模型列表是排过序的还是原生顺序，表现就是
「能排序，但过一会就乱、甚至全部不显示」。

现在职责已拆开：

- **opencode-connect**：只做 provider 接入（OpenCode 桌面通道、codearts、weixin、额度隐藏）。
- **dsh-model-sorter**（本插件）：独占模型选择器，负责排序与导航。

⚠️ 不要在两个插件里同时注册 `conversation.input.model`。

## 结构

```
model-sorter/
├── package.json        # dsh.bundle.patch + dsh.client
├── cordis.patch.yml    # insert 一行把插件挂进 profile
├── index.js            # Host 半：空实现（功能全在浏览器）
├── client.js           # Client 半：排序 + 字母索引 + 选择器
└── test-sort.mjs       # 排序算法测试（不依赖 React）
```

## 测试

```powershell
node model-sorter/test-sort.mjs
```

覆盖：版本倒序（含 5.10 vs 5.9）、首字母桶（含中文拼音与 `#`）、厂商路径剥离、
同族归并、provider 顺序，以及一份模拟目录的综合排序。

## License

MIT
