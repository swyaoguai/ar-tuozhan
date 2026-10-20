# dsh-ag-channel — 只管 `ag` 这一个模型渠道

DSH 插件。接管 `llm-pi-ai` 的 provider 配置里的 **`ag` 这一条**，别的 provider
（`minimax-cn` 等）一概不碰。

接管的内容：

```yaml
ag:
  apiKeyEnv: AG_API_KEY
  api: anthropic-messages
  baseURL: https://ps.air-outer.com      # 由插件按你选的那个地址填
  models:
    - id: deepseek-v4-flash
    - id: claude-opus-5
    - id: gpt-6-astra
    - id: gpt-5.6-sol
  headers:
    originator: codex_cli_rs
```

## 两个地址，任意一个都行

| 预设 | 端点 | 实际 baseURL | 实际请求 |
| --- | --- | --- | --- |
| `ps` | `https://ps.air-outer.com/v1` | `https://ps.air-outer.com` | `https://ps.air-outer.com/v1/messages` |
| `agentrouter` | `https://agentrouter.org/v1` | `https://agentrouter.org` | `https://agentrouter.org/v1/messages` |

**为什么填进去的 `/v1` 会被去掉**：Anthropic 协议下 pi-ai 走的是官方 SDK，
`beta.messages` 打的是 `<baseURL>/v1/messages`。baseURL 若带 `/v1`，请求就变成
`/v1/v1/messages`。所以插件把你填的「完整端点」归一成 API 根地址。
`/ag-channel status` 会把最终请求地址打出来。

`autoFailover` 打开时：主地址**连不上**（网络层失败，请求根本没到上游）会自动换另一个地址重发一次。
只在抛异常时兜底——收到 HTTP 状态码说明请求已被上游处理（可能已计费），不再重发。

## 命令

```
/ag-channel                    看当前地址、baseURL、实际请求地址、模型、请求头
/ag-channel url ps             切到 ps.air-outer.com
/ag-channel url agentrouter    切到 agentrouter.org
/ag-channel url https://x/v1   填任意自定义端点
```

切换会写 `~/.dsh/ag-channel.json`，并在支持热重载的 profile 上立即生效；
不支持的 profile 会提示重启 DSH。

## 装法

```bash
# 1) 把包放进 DSH profile（开发目录直接 link）
cd <你的 dsh profile 目录>
# 在 package.json 的 dependencies 里加："dsh-ag-channel": "link:D:/dsh-ag-channel"
# 并在 dsh.profile.bundles 里加一行 "dsh-ag-channel"

# 2) 装依赖
pnpm install

# 3) 重启 DSH，在「设置 → 模型」里把 ag 这个渠道的 API Key 填上（AG_API_KEY）
```

装好后，profile 自己的 `cordis.patch.yml` 里**不用再写 `ag` 那一段**——插件是它的唯一出处。

## 原理

DSH 的 provider 配置在 fiber 装载时解析，`internal/config` 是 cordis 的 waterfall 事件。
用 `{ global: true }` 注册的监听器会看到每个 fiber 的配置解析（`this` 就是那个 fiber），
插件据此只认 `@deepseek-ai/dsh-llm-pi-ai` 这一个 fiber，并且只改 `providers.ag`。

## 自测

```bash
node --test test/ag-channel.test.mjs
```

覆盖：baseURL 归一、只改 ag 不碰别的 provider、非目标 fiber 放行、status 输出。

## 许可

MIT
