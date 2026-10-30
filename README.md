# ar-tuozhan

DSH 插件：**接管 ar 套站（agentrouter / ps.air-outer）的模型渠道**，并自带 **API Key 轮询**与可视化界面。

它只碰 `llm-pi-ai` 里 baseURL 指向托管 host 的那几条路由（`ag` / `ar2` …），
**其它 provider 一概不碰**（`xxzl` / `xqp` / `luna` / `fh` / `minimax-cn` … 由你自己管）。

```yaml
ar:
  apiKeyEnv: AR_API_KEY
  api: anthropic-messages
  baseURL: https://ps.air-outer.com
  models:
    - id: deepseek-v4-flash
    - id: claude-opus-5.5
    - id: gpt-6-astra
    - id: gpt-6.1-sol
      input: [text, image]
  headers:
    originator: codex_cli_rs
```

---

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 接管渠道 | 按 **baseURL 的 host + 协议** 认路由，路由叫什么名字都无所谓；自动补齐 `originator` 头、凭据引用、默认模型 |
| 双协议 | 同一地址上可以同时挂 `anthropic-messages` 和 `openai-responses` 两条路由，各认各的 |
| Key 轮询 | 上游回 401/402/429 → 冷却当前 key → 换下一个 → **重发当前请求** |
| 优先 key | 手动指定先用哪个 key（面板里点「优先」） |
| Key 别名 | 给每个 key 起名字（"主力号"/"备用号"…），一眼分得清 |
| 协议适配 | `openai-responses` 路由自动补 `compat.supportsStrictMode: true` |
| 地址兜底 | 主地址**连不上**时自动换另一个地址重发 |
| 可视化界面 | DSH「设置 → ar 套站」面板 + 独立管理页 |

---

## 1. 两个地址，任意一个都行

| 预设 | 端点 | 实际 baseURL | 实际请求 |
| --- | --- | --- | --- |
| `ps` | `https://ps.air-outer.com/v1` | `https://ps.air-outer.com` | `https://ps.air-outer.com/v1/messages` |
| `agentrouter` | `https://agentrouter.org/v1` | `https://agentrouter.org` | `https://agentrouter.org/v1/messages` |

**`/v1` 的去留按协议决定**（这是最容易踩的坑）：

- `anthropic-messages`：pi-ai 走官方 Anthropic SDK，`beta.messages` 打的是
  `<baseURL>/v1/messages` → baseURL **不能**带 `/v1`（否则变成 `/v1/v1/messages`）→ 去掉
- `openai-responses` / `openai-completions`：走 OpenAI SDK，拼的是 `/responses`、`/chat/completions`
  → baseURL **必须保留** `/v1`

所以你永远只填「完整端点」（`https://host/v1`），插件按协议决定去掉还是保留那截 `/v1`。
`/ar-tuozhan status` 会把最终请求地址打出来。

`autoFailover` 打开时：主地址**连不上**（网络层失败，请求根本没到上游）会自动换另一个地址重发一次。
只在抛异常时兜底 —— 收到 HTTP 状态码说明请求已被上游处理（可能已计费），不再重发。

## 2. Key 轮询（额度耗尽自动换下一个）

池里放几个 key。上游回 401/402/429 时，插件把该 key 冷却、换下一个 **重发当前请求**，
并把新 key 写回凭据引用，于是下一次请求原生就用它。

**有一类错误不会换 key**：`402` 但正文是「套餐等级不支持该模型」（MiniMax 的 `2068`）、
`model_not_found` 这类**账户/套餐层面**的限制 —— 换 key 解决不了，插件原样透传，
免得无意义的轮询风暴把真正的原因盖住。

## 3. 路由是怎么认的

**以 URL 为准，不以名字为准。** 判据是 **(host, 协议)** 这一对：

- `baseURL` 指向 `ps.air-outer.com` + `api: anthropic-messages` → 那是 anthropic 那条路由
- `baseURL` 指向 `ps.air-outer.com/v1` + `api: openai-responses` → 那是 responses 那条路由

同一个中转站上挂两种协议也分得清。另外插件会**记住站点 ↔ 路由的对应关系**：
你在插件里改了地址，host 就变了，它仍然改的是「自己那条」路由，不会误伤别人。

被它接管的路由会自动补齐（只补没写的，已有的一律保留）：

- `headers.originator: codex_cli_rs` —— 这个头**必需**，不带就是 401
- `apiKeyEnv: AR_API_KEY` —— 没有会直接报 `MISSING_CREDENTIAL`
- `api: anthropic-messages` / `openai-responses`
- `compat.supportsStrictMode: true` —— 仅 `openai-responses` 这族协议需要，
  否则适配器不发 `strict:false`，网关侧会把可选权限字段当必填而拒绝
- 默认模型列表（你已有的模型不动）

---

## 安装

```bash
# 方式 A：GitHub（推荐给别人用）
#   profile 的 package.json：
"ar-tuozhan": "github:swyaoguai/ar-tuozhan"
#   并把 ar-tuozhan 加进 dsh.profile.bundles，然后：
pnpm install

# 方式 B：本地目录
"ar-tuozhan": "link:D:/ar-tuozhan"
```

装完重启 DSH，在「设置 → 模型」里给对应路由填一个 API Key（凭据引用 `AR_API_KEY`），
然后在 **设置 → ar 套站** 面板里加几个备用 key（可视化，不用敲命令）。

---

## 可视化界面（不用敲命令、不用改 JSON）

插件带一个网页界面，两种入口：

**A. DSH「设置」里的面板**（推荐）

设置 → **ar 套站**：

- **套站**：切换当前编辑哪个站点（每个站点一个地址 + 一种协议）
- **key 池**：加/删 key、**指定优先使用哪个**、给 key 起**别名**、看状态（使用中 / 冷却 / 拉黑 / 失败次数）、全部解封
- **模型**：编辑当前站点的模型（id / 名称 / 上下文窗口 / 输出上限 / 输入类型 / 思考强度）

**B. 独立管理页**

浏览器打开 `http://127.0.0.1:<DSH 端口>/ar-tuozhan/`（端口就是 DSH 窗口地址栏那个）。
两边是同一份数据，实时同步。

> 界面只跟本机 DSH 通信（`/ar-tuozhan/api/*`），不联外网。

## 命令（备用的，脚本化更方便）

```
/ar-tuozhan                    看两个站点的地址、baseURL、实际请求地址、模型、key 池状态
/ar-tuozhan site <id>          切换当前编辑的站点
/ar-tuozhan add <key> [别名]    加一个 key（可带别名），自动生效，不用重启
/ar-tuozhan remove <key>       删一个 key
/ar-tuozhan use <key>          把某个 key 设为优先使用
/ar-tuozhan url ps             切到 ps.air-outer.com
/ar-tuozhan url agentrouter    切到 agentrouter.org
/ar-tuozhan url https://x/v1   填任意自定义端点
/ar-tuozhan reset              清掉池里的所有冷却
/ar-tuozhan models             看当前站点的模型配置
```

状态文件 `~/.dsh/ar-tuozhan.json`（可以直接编辑）：

```json
{
  "url": "https://ps.air-outer.com/v1",
  "keys": ["sk-第一个", "sk-第二个", "sk-第三个"],
  "aliases": { "sk-第一个": "主力号", "sk-第二个": "备用号" },
  "stations": [
    { "id": "ps", "label": "ps", "url": "https://ps.air-outer.com/v1", "api": "anthropic-messages" },
    { "id": "agentrouter", "label": "agentrouter", "url": "https://agentrouter.org/v1", "api": "openai-responses" }
  ],
  "current": "ps.air-outer.com#anthropic-messages"
}
```

---

## 原理

**配置写入**：profile 的 `cordis.patch.yml` 就是 `llm-pi-ai` 配置的真源 —— 「设置 → 模型」改的就是它，
运行时读到的也是它。插件通过 DSH 自带的 `configEditor` 服务往里写（同样的校验、同样的文件锁、
同样的热重载），所以**插件界面改的和 Models 页改的是同一份数据，谁都不会冲掉谁**。

**Key 轮询**：走进程内 `fetch` 拦截。pi-ai 发请求写的是
`(options?.fetch ?? globalThis.fetch)(url, init)`，`globalThis.fetch` 是**调用时**才取的，
所以换掉它就生效 —— provider 配置一行都不用改。

## 自测

```bash
node --test test/ag-channel.test.mjs test/alias.test.mjs test/client.test.mjs test/guard.test.mjs
```

覆盖：baseURL 按协议归一、按 host+协议 认路由、同 host 双协议并存、改地址后仍认自己的路由、
只改托管路由不碰别的 provider、补齐 `apiKeyEnv` / `compat.supportsStrictMode`、
别名增删改、status 输出，以及 key 轮询的行为（正常用当前 key / 额度耗尽换 key 重发 /
套餐限制不换 key / 全部冷却时放行 / 非池内 host 不受影响）。

## 许可

MIT
