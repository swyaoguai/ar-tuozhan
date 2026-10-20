/**
 * dsh-ag-channel — 只管「ag」这一个模型渠道的插件。
 *
 * 它做两件事：
 *   1. 在运行时接管 llm-pi-ai 的 provider 配置里的 `ag` 这一条：
 *      apiKeyEnv / api / baseURL / models / headers(originator: codex_cli_rs)；
 *      其它 provider（minimax-cn 等）一概不碰。
 *   2. 两个可用地址（ps.air-outer.com / agentrouter.org）任选其一，
 *      也可以让主地址连不上时自动换另一个。
 *
 * 为什么能在运行时接管：DSH 的 provider 配置在 fiber 装载时解析，
 * `internal/config` 是 cordis 的 waterfall 事件；用 `{ global: true }` 注册的
 * 监听器会看到每个 fiber 的配置解析，`this` 就是那个 fiber。
 * 我们只认 llm-pi-ai 这一个 fiber，并且只改 `providers.ag`。
 *
 * @module index.js
 */
import fs from 'node:fs'
import {
  DEFAULT_MODELS, DEFAULT_PRESET, URL_PRESETS, dshHome, readState, requestUrlOf,
  resolveBaseURL, statePath, writeState,
} from './src/channel.js'
import { installUrlFailover } from './src/url-failover.js'

export const name = 'ag-channel'

/** 不依赖任何服务。 */
export const inject = []

/** llm-pi-ai 这个 fiber 的两种认法：包名（稳）或条目 id（用户可改）。 */
const TARGET_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'
const TARGET_ID = 'llm-pi-ai'

let Config
try {
  const { default: Schema } = await import('@deepseek-ai/schemastery')
  Config = Schema.object({
    enabled: Schema.boolean().default(true).description('启用 ag 渠道'),
    url: Schema.string().default(URL_PRESETS[DEFAULT_PRESET])
      .description('ag 渠道地址：ps = https://ps.air-outer.com/v1，agentrouter = https://agentrouter.org/v1（也可填自定义完整端点）'),
    apiKeyEnv: Schema.string().default('AG_API_KEY').description('取 key 的凭据引用'),
    originator: Schema.string().default('codex_cli_rs').description('附带的 originator 请求头'),
    displayName: Schema.string().default('ag').description('显示名'),
    models: Schema.array(Schema.object({
      id: Schema.string(),
      name: Schema.string(),
      input: Schema.array(Schema.string()).optional(),
    })).default([]).description('模型列表（留空用内置的四个）'),
    autoFailover: Schema.boolean().default(true).description('主地址连不上时自动换另一个地址重发'),
  }).description('ag 渠道（agentrouter / ps.air-outer）')
} catch {
  Config = undefined
}
export { Config }

function isTargetFiber(fiber) {
  const options = fiber?.entry?.options
  if (options === undefined || options === null) return false
  return options.name === TARGET_PACKAGE || options.id === TARGET_ID
}

export function apply(ctx, config = {}) {
  const home = dshHome()
  const state = readState(home)

  const chosen = () => {
    const fromState = typeof state.url === 'string' && state.url.length > 0 ? state.url : undefined
    const fromConfig = typeof config.url === 'string' && config.url.length > 0 ? config.url : undefined
    return fromState ?? fromConfig ?? URL_PRESETS[DEFAULT_PRESET]
  }

  const baseURL = () => resolveBaseURL(chosen())
  const presetOf = (value) => {
    for (const [name, url] of Object.entries(URL_PRESETS)) {
      if (value === name || value === url) return name
    }
    return 'custom'
  }

  const models = () => {
    const list = Array.isArray(state.models) && state.models.length > 0
      ? state.models
      : Array.isArray(config.models) && config.models.length > 0
        ? config.models
        : DEFAULT_MODELS
    return list
      .filter((model) => model !== null && typeof model === 'object' && typeof model.id === 'string')
      .map((model) => ({
        id: model.id,
        name: typeof model.name === 'string' ? model.name : model.id,
        ...(Array.isArray(model.input) && model.input.length > 0 ? { input: [...model.input] } : {}),
      }))
  }

  const buildProfile = () => ({
    apiKeyEnv: typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0 ? config.apiKeyEnv : 'AG_API_KEY',
    api: 'anthropic-messages',
    baseURL: baseURL(),
    models: models(),
    headers: {
      ...(typeof config.originator === 'string' && config.originator.length > 0 ? { originator: config.originator } : {}),
    },
    ...(typeof config.displayName === 'string' && config.displayName.length > 0 ? { displayName: config.displayName } : {}),
  })

  if (config.enabled !== false) {
    // 全局拦截：只认 llm-pi-ai 那个 fiber，只改 providers.ag。
    ctx.on('internal/config', function (raw, next) {
      const resolved = next()
      if (!isTargetFiber(this)) return resolved
      const providers = { ...(resolved?.providers ?? {}) }
      providers.ag = buildProfile()
      return { ...resolved, providers }
    }, { global: true })

    ctx.logger?.info?.(
      `dsh-ag-channel: ag 渠道 baseURL=${baseURL()}（实际请求 ${requestUrlOf(baseURL())}）` +
      ` 预设=${presetOf(chosen())} 模型=${models().map((m) => m.id).join(',')}`,
    )
  }

  // 两个地址的自动兜底（只在网络层失败时换，不重复已到达上游的请求）
  let guard = { installed: false, uninstall: () => {} }
  const hosts = () => {
    const urls = Object.values(URL_PRESETS).map((url) => new URL(url).host)
    return urls
  }
  const startGuard = () => {
    if (guard.installed) return
    const [first, second] = hosts()
    if (first === undefined || second === undefined) return
    guard = installUrlFailover({
      primaryHost: first,
      fallbackHost: second,
      log: (level, message) => ctx.logger?.[level]?.(message),
    })
  }
  if (config.enabled !== false && config.autoFailover !== false) startGuard()

  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      name: 'ag-channel',
      description: 'ag 渠道：看当前地址/模型、切换地址',
      input: { hint: 'status | url <ps|agentrouter|完整端点>' },
      handler: async (invocation) => {
        const raw = (invocation?.rawInput ?? '').trim()
        const [action = 'status', value] = raw.split(/\s+/)

        if (action === 'url') {
          if (typeof value !== 'string' || value.length === 0) {
            return { kind: 'error', text: '用法：url <ps|agentrouter|完整端点>' }
          }
          state.url = value
          writeState(home, state)
          // 让 llm-pi-ai 重新解析配置：能热重载就热重载，否则提示重启。
          const hmr = ctx.get('hmr')
          if (hmr?.reconcileProfile !== undefined) {
            try {
              await hmr.reconcileProfile([])
            } catch {
              // 忽略：下面会提示重启
            }
          }
          return {
            kind: 'success',
            text: `ag 渠道地址已切到 ${value}（baseURL=${baseURL()}，请求 ${requestUrlOf(baseURL())}）。` +
              (hmr?.reconcileProfile === undefined ? '\n这个 profile 不支持热重载，请重启 DSH 生效。' : ''),
          }
        }

        const lines = [
          'ag 渠道：',
          `  地址预设: ${presetOf(chosen())}`,
          `  填写的端点: ${chosen()}`,
          `  实际 baseURL: ${baseURL()}`,
          `  实际请求地址: ${requestUrlOf(baseURL())}`,
          `  凭据引用: ${buildProfile().apiKeyEnv}`,
          `  请求头: ${JSON.stringify(buildProfile().headers)}`,
          `  模型: ${models().map((m) => m.id).join(', ')}`,
          `  状态文件: ${statePath(home)}`,
        ]
        return { kind: 'success', text: lines.join('\n') }
      },
    })
  })

  ctx.on('dispose', () => {
    guard.uninstall()
  })
}
