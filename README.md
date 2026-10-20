# dsh-ag-channel

DSH 插件：**只管 `ag` 这一个模型渠道**，并且**自带 key 轮询**。

它接管 `llm-pi-ai` 的 provider 配置里的 `ag` 这一条（别的 provider 一概不碰）：

```yaml
ag:
  apiKeyEnv: AG_API_KEY
  api: anthropic-messages
  baseURL: https://ps.air-outer.com      # 你选的那个地址
  models:
    - id: deepseek-v4-flash
    - id: claude-opus-5.5
    - id: gpt-6-astra
    - id: gpt-6.1-sol
      input: [text, image]
  headers:
    originator: codex_cli_rs
```

## 1. 两个地址，任意一个都行

| 预设 | 端点 | 实际 baseURL | 实际请求 |
| --- | --- | --- | --- |
| `ps` | `https://ps.air-outer.com/v1` | `https://ps.air-outer.com` | `https://ps.air-outer.com/v1/messages` |
| `agentrouter` | `https://agentrouter.org/v1` | `https://agentrouter.org` | `https://agentrouter.org/v1/messages` |

**为什么填进去的 `/v1` 会被去掉**：Anthropic 协议下 pi-ai 走的是官方 SDK，
`beta.messages` 打的是 `<baseURL>/v1/messages`。baseURL 若带 `/v1`，请求就变成
`/v1/v1/messages`。插件把你填的「完整端点」归一成 API 根地址，`/ag-channel status`
会把最终请求地址打出来。

`autoFailover` 打开时：主地址**连不上**（网络层失败，请求根本没到上游）会自动换另一个地址重发一次。
只在抛异常时兜底 —— 收到 HTTP 状态码说明请求已被上游处理（可能已计费），不再重发。

## 2. key 轮询（额度耗尽自动换下一个）

池里放几个 key。上游回 401/402/429 时，插件把该 key 冷却、换下一个 **重发当前请求**，
并把新 key 写回凭据引用，于是下一次请求原生就用它。

**有一类错误不会换 key**：`402` 但正文是「套餐等级不支持该模型」（MiniMax 的 `2068`）、
`model_not_found` 这类**账户/套餐层面**的限制 —— 换 key 解决不了，插件原样透传，
免得无意义的轮询风暴把真正的原因盖住。

## 安装

```bash
# 方式 A：GitHub（推荐给别人用）
#   在 profile 的 package.json 里：
"dsh-ag-channel": "github:swyaoguai/dsh-ag-channel"
#   并把 dsh-ag-channel 加进 dsh.profile.bundles，然后：
pnpm install

# 方式 B：本地目录
"dsh-ag-channel": "link:D:/dsh-ag-channel"
```

装完重启 DSH，在「设置 → 模型」里给 `ag` 填一个 API Key（凭据引用 `AG_API_KEY`），
然后在 **设置 → ag 渠道** 面板里加几个备用 key（可视化，不需要敲命令）。

## 可视化界面（不用敲命令、不用改 JSON）

插件带一个网页界面，两种入口：

**A. DSH「设置」里的面板**（推荐）

设置 → **ag 渠道**：切地址、看 key 池（谁在用 / 谁在冷却 / 失败几次）、加删 key、全部解封。

**B. 独立管理页**

浏览器打开 `http://127.0.0.1:<DSH 端口>/dsh-ag-channel/`（DSH 端口就是 DSH 窗口地址栏那个）。
两边是同一份数据，实时同步。

> 界面只跟本机 DSH 通信（`/dsh-ag-channel/api/*`），不联外网。

## 命令（备用的，脚本化更方便）

```
/ag-channel                    看当前地址、baseURL、实际请求地址、模型、key 池状态
/ag-channel add <key>          加一个 key（自动生效，不用重启）
/ag-channel remove <key>       删一个 key
/ag-channel url ps             切到 ps.air-outer.com
/ag-channel url agentrouter    切到 agentrouter.org
/ag-channel url https://x/v1   填任意自定义端点
/ag-channel reset              清掉池里的所有冷却
```

key 也存在 `~/.dsh/ag-channel.json` 里，可以直接编辑：

```json
{
  "url": "https://ps.air-outer.com/v1",
  "keys": ["sk-第一个", "sk-第二个", "sk-第三个"]
}
```

## 原理

DSH 的 provider 配置在 fiber 装载时解析，`internal/config` 是 cordis 的 waterfall 事件。
用 `{ global: true }` 注册的监听器会看到每个 fiber 的配置解析（`this` 就是那个 fiber），
插件据此只认 `@deepseek-ai/dsh-llm-pi-ai` 这一个 fiber，并且只改 `providers.ag`。

key 轮询走进程内 `fetch` 拦截：pi-ai 发请求写的是
`(options?.fetch ?? globalThis.fetch)(url, init)`，`globalThis.fetch` 是**调用时**才取的，
所以换掉它就生效 —— provider 配置一行都不用改。

## 自测

```bash
node --test test/ag-channel.test.mjs test/guard.test.mjs
```

覆盖：baseURL 归一、只改 ag 不碰别的 provider、非目标 fiber 放行、status 输出、
加 key 落盘，以及 key 轮询的四条行为（正常用当前 key / 额度耗尽换 key 重发 /
套餐限制不换 key / 全部冷却时放行 / 非池内 host 不受影响）。

## 许可

MIT
