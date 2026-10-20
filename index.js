/**
 * dsh-ag-channel — 只管「ag」这一个模型渠道的插件（自带 key 轮询）。
 *
 * 它做三件事：
 *   1. 在运行时接管 llm-pi-ai 的 provider 配置里的 `ag` 这一条：
 *      apiKeyEnv / api / baseURL / models / headers(originator: codex_cli_rs)；
 *      其它 provider（minimax-cn 等）一概不碰。
 *   2. 给这个渠道挂一个 key 池：某个 key 额度耗尽 / 失效 / 被限流时，
 *      自动切到下一个 key 并重发当前请求（池的引擎对其它渠道也可用）。
 *   3. 两个可用地址（ps.air-outer.com / agentrouter.org）任选其一，
 *      主地址连不上时自动换另一个。
 *
 * 为什么能在运行时接管：DSH 的 provider 配置在 fiber 装载时解析，
 * `internal/config` 是 cordis 的 waterfall 事件；用 `{ global: true }` 注册的
 * 监听器会看到每个 fiber 的配置解析，`this` 就是那个 fiber。
 * 我们只认 llm-pi-ai 这一个 fiber，并且只改 `providers.ag`。
 *
 * 状态全在 ~/.dsh 下：
 *   ~/.dsh/ag-channel.json   这个渠道的地址、key、模型
 *   ~/.dsh/key-pool.json     其它渠道的通用 key 池（可选）
 *
 * @module index.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MODELS, DEFAULT_PRESET, URL_PRESETS, dshHome, hostOfBaseURL, normalizeBaseURL,
  presetHosts, readState, requestUrlOf, resolveBaseURL, statePath, writeState,
} from './src/channel.js'
import { KeyPoolEngine, maskKey } from './src/pool.js'
import { installFetchGuard } from './src/fetch-guard.js'
import { installUrlFailover } from './src/url-failover.js'
import { poolConfigPath, readPools, readState as readPoolState, writeState as writePoolState } from './src/store.js'

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
    keyRotation: Schema.boolean().default(true).description('key 轮询：额度耗尽/失效/限流时自动换下一个 key'),
    autoFailover: Schema.boolean().default(true).description('主地址连不上时自动换另一个地址重发'),
  }).description('ag 渠道（agentrouter / ps.air-outer，含 key 轮询）')
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
  const poolState = readPoolState(home)

  const chosen = () => {
    const fromState = typeof state.url === 'string' && state.url.length > 0 ? state.url : undefined
    const fromConfig = typeof config.url === 'string' && config.url.length > 0 ? config.url : undefined
    return fromState ?? fromConfig ?? URL_PRESETS[DEFAULT_PRESET]
  }
  const baseURL = () => resolveBaseURL(chosen())
  /**
   * 插件托管的 host：两个预设 + 用户自填的那个。
   * **以 URL 判定，不以路由 id 判定** —— 渠道叫什么名字（ag / ar / 随便）
   * 都不影响插件接管它。
   */
  const managedHosts = () => {
    const hosts = new Set(presetHosts())
    const custom = hostOfBaseURL(normalizeBaseURL(chosen()))
    if (custom !== '') hosts.add(custom)
    return hosts
  }
  const isManagedUrl = (value) => {
    const host = hostOfBaseURL(String(value ?? ''))
    return host !== '' && managedHosts().has(host)
  }
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
  const agKeys = () => (Array.isArray(state.keys) ? state.keys.filter((key) => typeof key === 'string' && key.length > 0) : [])

  /**
   * 生效中的 provider 配置。每次 llm-pi-ai 的配置被解析时刷新，
   * 界面上显示的就是它（用户自己在「设置 → 模型」改过的值优先）。
   */
  let effective = null
  /** 插件当前接管的路由 id（以 URL 判定得出，不是写死的）。 */
  let managedId = null
  /** 所有 baseURL 命中托管 host 的路由 id（界面上给这些路由都挂 key 池）。 */
  let managedIds = []

  /**
   * 把托管路由的字段写进 profile 的 cordis.patch.yml ——
   * 走的是「设置 → 模型」背后那个 configEditor 服务：同样的校验、
   * 同样的文件锁、同样的热重载。**单一数据源**：插件界面改的和
   * Models 页改的是同一份东西，谁都不会冲掉谁。
   */
  let configEditor = null
  ctx.inject(['configEditor'], (scoped) => {
    configEditor = scoped.configEditor ?? null
  })
  const managedRouteId = () => managedId ?? (typeof config.providerId === 'string' && config.providerId.length > 0 ? config.providerId : 'ag')
  const writeAgProfile = async (fields) => {
    if (configEditor === null) {
      throw new Error('这个 profile 没有配置编辑器（configEditor），无法写入 provider 配置')
    }
    const entry = configEditor.entries().find((item) => item.options.id === 'llm-pi-ai')
    if (entry === undefined) {
      throw new Error('找不到 llm-pi-ai 条目')
    }
    const id = managedRouteId()
    await configEditor.edit(entry, (current) => ({
      ...current,
      providers: {
        ...(current.providers ?? {}),
        [id]: { ...(current.providers?.[id] ?? {}), ...fields },
      },
    }))
  }

  /**
   * profile patch 里 llm-pi-ai 那一条的真实 providers（用户自己写的那些路由）。
   * 这是配置的真源：Models 页改的就是它，运行时读到的也是它。
   */
  const patchProviders = () => {
    if (configEditor === null) return {}
    try {
      const row = configEditor.configuration().find((item) => item.entry.options.id === 'llm-pi-ai')
      const providers = row?.override?.providers
      return providers !== null && typeof providers === 'object' ? providers : {}
    } catch {
      return {}
    }
  }

  /**
   * 按 URL 找出用户自己建的那些「指向托管 host 的路由」。
   * 路由叫什么名字都不影响：叫 ag、ar、随便什么都认。
   */
  const discoverManagedRoutes = () => {
    const found = []
    for (const [id, profile] of Object.entries(patchProviders())) {
      if (profile !== null && typeof profile === 'object' && isManagedUrl(profile.baseURL)) found.push(id)
    }
    return found
  }

  /** 通用 key 池（其它渠道用），从 ~/.dsh/key-pool.json 读。 */
  const genericPools = () => readPools(home, poolConfigPath(home))

  /** 这个渠道自己的池：host 覆盖两个预设地址，key 来自状态文件。 */
  const agPool = () => ({
    id: 'ag',
    keys: agKeys(),
    hosts: presetHosts(),
    credentialRef: typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0 ? config.apiKeyEnv : 'AG_API_KEY',
    strategy: 'failover',
    authHeader: 'auto',
    cooldownMs: { quota: 60 * 60 * 1000, auth: 60 * 60 * 1000, rateLimit: 60 * 1000 },
    seed: true,
  })

  const persistPoolState = () => {
    try { writePoolState(home, poolState) } catch { /* 落盘失败不影响轮询 */ }
  }

  const engine = new KeyPoolEngine({
    pools: [agPool(), ...genericPools()],
    state: poolState,
    persist: persistPoolState,
    onRotate: ({ pool, key }) => {
      ctx.logger?.info?.(`dsh-ag-channel: 池 ${pool.id} 已切到 ${maskKey(key)}`)
      void writeCredential(pool, key)
    },
  })

  /** 凭据服务可选：有就把换到的 key 写回去，下一次请求原生就用它。 */
  let credentials = null
  ctx.inject(['credentials'], (scoped) => {
    credentials = scoped.credentials ?? null
  })
  const writeCredential = async (pool, key) => {
    if (credentials === null || pool.credentialRef === '') return
    try {
      await credentials.set?.(pool.credentialRef, key)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ag-channel: 写回凭据 ${pool.credentialRef} 失败: ${error?.message ?? error}`)
    }
  }

  const buildProfile = () => ({
    apiKeyEnv: typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0 ? config.apiKeyEnv : 'AG_API_KEY',
    api: 'anthropic-messages',
    baseURL: baseURL(),
    models: models(),
    headers: {
      ...(typeof config.originator === 'string' && config.originator.length > 0 ? { originator: config.originator } : { originator: 'codex_cli_rs' }),
    },
    ...(typeof config.displayName === 'string' && config.displayName.length > 0 ? { displayName: config.displayName } : { displayName: 'ag' }),
  })

  if (config.enabled !== false) {
    // 不用运行时拦截：profile 的 patch 就是 llm-pi-ai 配置的真源，
    // 插件直接把托管路由补齐写进 patch（见 ensureManagedRoute），
    // 运行时就自然带着插件的请求头与模型。
    ctx.logger?.info?.(
      `dsh-ag-channel: 渠道已接管（托管 host=${[...managedHosts()].join(', ')}，模型=${models().map((m) => m.id).join(',')}，key 数=${agKeys().length}）`,
    )
  }

  // --- key 轮询拦截器 -----------------------------------------------------
  let guard = { installed: false, uninstall: () => {} }
  const startGuard = () => {
    if (guard.installed || config.keyRotation === false) return
    guard = installFetchGuard({
      engine,
      log: (level, message) => ctx.logger?.[level]?.(message),
    })
  }
  if (config.enabled !== false) startGuard()

  // --- 地址自动兜底（只在网络层失败时换，不重复已到达上游的请求）--------
  let failover = { installed: false, uninstall: () => {} }
  const startFailover = () => {
    if (failover.installed || config.autoFailover === false) return
    const [first, second] = presetHosts()
    if (first === undefined || second === undefined) return
    failover = installUrlFailover({
      primaryHost: first,
      fallbackHost: second,
      log: (level, message) => ctx.logger?.[level]?.(message),
    })
  }
  if (config.enabled !== false) startFailover()

  /**
   * 把插件的缺项补进 profile 里那个托管路由：
   *   - 路由不存在 → 用插件默认值建一个（名字可在设置里改）
   *   - 路由存在   → 只补用户没写的（协议、请求头），模型等一律不动
   *
   * 写进 patch 之后，运行时读到的就是它 —— Models 页看得见、也能编辑，
   * 插件的 originator 请求头也真的生效。
   */
  const ensureManagedRoute = async () => {
    if (configEditor === null) return
    const providers = patchProviders()
    const found = Object.keys(providers).filter((id) => isManagedUrl(providers[id]?.baseURL))
    const defaults = buildProfile()
    const preferred = typeof config.providerId === 'string' && config.providerId.length > 0 ? config.providerId : undefined
    const id = found.includes(preferred) ? preferred
      : found[0]
      ?? preferred
      ?? 'ag'
    const existing = providers[id] ?? {}
    const wanted = {
      ...existing,
      api: existing.api ?? defaults.api,
      baseURL: existing.baseURL ?? defaults.baseURL,
      models: Array.isArray(existing.models) && existing.models.length > 0 ? existing.models : defaults.models,
      headers: { ...defaults.headers, ...(existing.headers ?? {}) },
    }
    const same = JSON.stringify(existing) === JSON.stringify(wanted)
    managedIds = found.length > 0 ? found : [id]
    managedId = id
    if (same) return
    const entry = configEditor.entries().find((item) => item.options.id === 'llm-pi-ai')
    if (entry === undefined) return
    try {
      await configEditor.edit(entry, (raw) => ({
        ...raw,
        providers: {
          ...(raw.providers ?? {}),
          [id]: wanted,
        },
      }))
      ctx.logger?.info?.(`dsh-ag-channel: 已在 profile 里就位托管路由「${id}」`)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ag-channel: 写入托管路由失败: ${error?.message ?? error}`)
    }
  }
  void ensureManagedRoute()

  /** 启动时把池里的当前 key 写进凭据引用（provider 因此不需要改配置）。 */
  const seedCredential = async () => {
    if (credentials === null) return
    const pool = agPool()
    if (pool.keys.length === 0) return
    const key = engine.currentKey(pool)
    if (key === null) return
    try {
      const stored = await credentials.resolve?.(pool.credentialRef)
      const value = stored?.value
      if (value === undefined || value === '' || pool.keys.includes(value)) {
        await credentials.set?.(pool.credentialRef, key)
        ctx.logger?.info?.(`dsh-ag-channel: ${pool.credentialRef} 已指向池里的当前 key`)
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-ag-channel: 初始化凭据失败: ${error?.message ?? error}`)
    }
  }
  void seedCredential()

  /** 状态文件变了自动重载（加 key 之后不必重启）。 */
  let lastMtime = 0
  const reloadIfChanged = () => {
    try {
      const mtime = fs.statSync(statePath(home)).mtimeMs
      if (mtime === lastMtime) return
      lastMtime = mtime
      const next = readState(home)
      state.url = next.url
      state.keys = next.keys
      state.models = next.models
      engine.pools = [agPool(), ...genericPools()]
      ctx.logger?.info?.(`dsh-ag-channel: 已重载（key 数=${agKeys().length}）`)
    } catch {
      // 文件还没建：等下一轮
    }
  }
  try { lastMtime = fs.statSync(statePath(home)).mtimeMs } catch { lastMtime = 0 }
  let lastEnsured = ''
  const timer = setInterval(() => {
    reloadIfChanged()
    // 托管路由跟着 profile 走：用户在 Models 页新建/改名/改地址后，
    // 这里会重新按 URL 认一遍，key 池面板也就跟着挂到正确的行上；
    // 同时把插件的缺项（协议、originator 头）补齐。
    const found = discoverManagedRoutes()
    if (found.length > 0 || managedIds.length === 0) managedIds = found
    const signature = found.join(',')
    if (signature !== lastEnsured) {
      lastEnsured = signature
      void ensureManagedRoute()
    }
  }, 15_000)
  if (typeof timer.unref === 'function') timer.unref()

  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      name: 'ag-channel',
      description: 'ag 渠道：看状态 / 换地址 / 加删 key',
      input: { hint: 'status | url <ps|agentrouter|完整端点> | add <key> | remove <key> | reset' },
      handler: async (invocation) => {
        const raw = (invocation?.rawInput ?? '').trim()
        const [action = 'status', value] = raw.split(/\s+/)

        if (action === 'url') {
          if (typeof value !== 'string' || value.length === 0) {
            return { kind: 'error', text: '用法：url <ps|agentrouter|完整端点>' }
          }
          const next = resolveBaseURL(value)
          try {
            // 写进 profile patch —— 和「设置 → 模型」里改 baseURL 是同一份数据
            await writeAgProfile({ baseURL: next })
          } catch (error) {
            return { kind: 'error', text: `改地址失败：${error?.message ?? error}` }
          }
          state.url = value
          writeState(home, state)
          return {
            kind: 'success',
            text: `ag 渠道地址已切到 ${value}（baseURL=${next}，请求 ${requestUrlOf(next)}）。` +
              '\n已写入 profile 配置，「设置 → 模型」里看到的就是它。',
          }
        }

        if (action === 'models') {
          const list = effective?.models ?? models()
          const lines = ['ag 渠道的模型（这里改 / 在「设置 → 模型」里改，写进的是同一份 profile 配置）：']
          for (const model of list) {
            lines.push(`  ${model.id}`)
            lines.push(`    名称: ${model.name ?? model.id}`)
            lines.push(`    上下文: ${model.contextWindow ?? '(默认)'}   输出上限: ${model.maxTokens ?? '(默认)'}`)
            lines.push(`    输入类型: ${Array.isArray(model.input) && model.input.length > 0 ? model.input.join(', ') : '(默认)'}`)
            lines.push(`    思考强度: ${model.reasoningEfforts === false ? '不支持' : JSON.stringify(model.reasoningEfforts ?? '(默认)')}`)
          }
          lines.push('', '想改就用「设置 → 模型」里编辑 ag，或用面板里的模型编辑器。')
          return { kind: 'success', text: lines.join('\n') }
        }

        if (action === 'add') {
          if (typeof value !== 'string' || value.length === 0) {
            return { kind: 'error', text: '用法：add <key>' }
          }
          const keys = agKeys()
          if (!keys.includes(value)) keys.push(value)
          state.keys = keys
          writeState(home, state)
          engine.pools = [agPool(), ...genericPools()]
          const pool = agPool()
          const current = engine.currentKey(pool)
          if (current !== null) await writeCredential(pool, current)
          return {
            kind: 'success',
            text: `已加入 key ${maskKey(value)}（池里共 ${keys.length} 个）。` +
              (keys.length === 1 ? '\n提示：再加几个 key，才能在某个 key 没额度时自动切换。' : ''),
          }
        }

        if (action === 'remove') {
          const keys = agKeys()
          const index = keys.indexOf(value ?? '')
          if (index < 0) return { kind: 'error', text: '池里没有这个 key。' }
          keys.splice(index, 1)
          state.keys = keys
          writeState(home, state)
          engine.pools = [agPool(), ...genericPools()]
          return { kind: 'success', text: `已移除 key ${maskKey(value)}（池里剩 ${keys.length} 个）。` }
        }

        if (action === 'reset') {
          const pool = agPool()
          engine.reset(pool)
          return { kind: 'success', text: '池里的冷却已全部清除。' }
        }

        const pool = agPool()
        const snapshot = engine.snapshot().find((item) => item.id === 'ag')
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
          '',
          `key 池（${agKeys().length} 个）：`,
        ]
        for (const key of snapshot?.keys ?? []) {
          const flags = [
            key.banned ? '已拉黑' : '',
            key.cooling > 0 ? `冷却 ${Math.ceil(key.cooling / 1000)}s` : '',
            key.failures > 0 ? `失败 ${key.failures} 次` : '',
          ].filter(Boolean).join(' / ')
          lines.push(`  ${key.key}${flags ? '  [' + flags + ']' : ''}${key.lastError ? '  ' + key.lastError : ''}`)
        }
        if (agKeys().length === 0) {
          lines.push('  （还没有 key —— 用 /ag-channel add <key> 加几个）')
        }
        lines.push('', '命令：/ag-channel add <key> | url <ps|agentrouter> | remove <key> | reset')
        return { kind: 'success', text: lines.join('\n') }
      },
    })
  })

  // --- 管理界面（webServer：JSON API + 独立页面）----------------------
  // 页面：/dsh-ag-channel/        API：/dsh-ag-channel/api/*
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    const PKG_DIR = fileURLToPath(new URL('./', import.meta.url))
    const sendJson = (res, status, obj) => {
      const payload = JSON.stringify(obj)
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(payload)
    }
    const readBody = (req) => new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 200_000) { try { req.destroy() } catch { /* ignore */ } chunks.length = 0; resolve(''); return }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })

    /** 给界面看的完整状态。 */
    const stateSnapshot = () => {
      const enginePool = engine.snapshot().find((item) => item.id === 'ag')
      const keys = (enginePool?.keys ?? []).map((key) => ({
        mask: key.key,
        full: key.full,
        current: enginePool?.current === key.full,
        banned: key.banned,
        failures: key.failures,
        cooling: key.cooling,
        lastError: key.lastError,
      }))
      // 托管路由的生效配置直接读 profile patch（真源），不是内存里的副本
      const providers = patchProviders()
      const found = Object.keys(providers).filter((id) => isManagedUrl(providers[id]?.baseURL))
      const route = providers[found[0]] ?? {}
      const defaults = buildProfile()
      return {
        ok: true,
        url: chosen(),
        preset: presetOf(chosen()),
        baseURL: route.baseURL ?? defaults.baseURL,
        requestUrl: requestUrlOf(route.baseURL ?? defaults.baseURL),
        credentialRef: route.apiKeyEnv ?? defaults.apiKeyEnv,
        headers: route.headers ?? defaults.headers,
        models: route.models ?? defaults.models,
        keys,
        poolId: 'ag',
        // 托管的路由：按 URL 判定出来的，不是写死 id
        managedId: found[0] ?? managedRouteId(),
        managedIds: found.length > 0 ? found : managedIds,
        managedHosts: [...managedHosts()],
        canWriteProfile: configEditor !== null,
      }
    }

    const handler = async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const sub = url.pathname.replace(/^\/dsh-ag-channel\/?/, '').replace(/\/+$/, '')
        if (req.method === 'GET' && (sub === '' || sub === 'index.html')) {
          const html = fs.readFileSync(path.join(PKG_DIR, 'src', 'ui.html'), 'utf8')
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(html)
          return
        }
        if (req.method === 'GET' && sub === 'api/state') { sendJson(res, 200, stateSnapshot()); return }
        if (req.method === 'POST' && sub === 'api/keys') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const key = typeof body.key === 'string' ? body.key.trim() : ''
          if (key === '') { sendJson(res, 400, { ok: false, error: 'key 不能为空' }); return }
          const keys = agKeys()
          if (!keys.includes(key)) keys.push(key)
          state.keys = keys
          writeState(home, state)
          engine.pools = [agPool(), ...genericPools()]
          const pool = agPool()
          const current = engine.currentKey(pool)
          if (current !== null) await writeCredential(pool, current)
          sendJson(res, 200, stateSnapshot())
          return
        }
        if (req.method === 'POST' && sub === 'api/keys/remove') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const keys = agKeys()
          const index = keys.indexOf(typeof body.key === 'string' ? body.key : '')
          if (index >= 0) keys.splice(index, 1)
          state.keys = keys
          writeState(home, state)
          engine.pools = [agPool(), ...genericPools()]
          sendJson(res, 200, stateSnapshot())
          return
        }
        if (req.method === 'POST' && sub === 'api/url') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const value = typeof body.url === 'string' ? body.url.trim() : ''
          if (value === '') { sendJson(res, 400, { ok: false, error: '端点不能为空' }); return }
          const next = resolveBaseURL(value)
          try {
            await writeAgProfile({ baseURL: next })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
            return
          }
          state.url = value
          writeState(home, state)
          sendJson(res, 200, stateSnapshot())
          return
        }
        if (req.method === 'POST' && sub === 'api/models') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const list = Array.isArray(body.models) ? body.models : null
          if (list === null) { sendJson(res, 400, { ok: false, error: 'models 必须是数组' }); return }
          const cleaned = list
            .filter((model) => model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id.length > 0)
            .map((model) => ({
              id: model.id,
              name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
              ...(Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
              ...(Number.isInteger(model.maxTokens) && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
              ...(Array.isArray(model.input) && model.input.length > 0 ? { input: [...model.input].filter((m) => m === 'text' || m === 'image') } : {}),
              ...(model.reasoningEfforts === false
                ? { reasoningEfforts: false }
                : model.reasoningEfforts !== null && typeof model.reasoningEfforts === 'object'
                  ? { reasoningEfforts: model.reasoningEfforts }
                  : {}),
            }))
          if (cleaned.length === 0) { sendJson(res, 400, { ok: false, error: '至少要有一个模型' }); return }
          try {
            await writeAgProfile({ models: cleaned })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
            return
          }
          state.models = cleaned
          writeState(home, state)
          sendJson(res, 200, stateSnapshot())
          return
        }
        if (req.method === 'POST' && sub === 'api/reset') {
          engine.reset(agPool())
          sendJson(res, 200, stateSnapshot())
          return
        }
        sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
      }
    }
    scoped.effect(
      () => server.register({ kind: 'prefix', path: '/dsh-ag-channel', handler }),
      'dsh-ag-channel: 管理界面',
    )
  })

  ctx.on('dispose', () => {
    clearInterval(timer)
    guard.uninstall()
    failover.uninstall()
  })
}
