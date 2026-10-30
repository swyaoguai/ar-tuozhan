/**
 * ar-tuozhan — 只管「ag」这一个模型渠道的插件（自带 key 轮询）。
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
 *   ~/.dsh/ar-tuozhan.json   这个渠道的地址、key、模型
 *   ~/.dsh/key-pool.json     其它渠道的通用 key 池（可选）
 *
 * @module index.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MODELS, DEFAULT_PRESET, DEFAULT_STATIONS, URL_PRESETS, dshHome, hostOfBaseURL, normalizeBaseURL,
  presetHosts, readState, requestUrlOf, resolveBaseURL, statePath, writeState,
} from './src/channel.js'
import { KeyPoolEngine, maskKey } from './src/pool.js'
import { installFetchGuard } from './src/fetch-guard.js'
import { installUrlFailover } from './src/url-failover.js'
import { poolConfigPath, readPools, readState as readPoolState, writeState as writePoolState } from './src/store.js'

export const name = 'ar-tuozhan'

/** 不依赖任何服务。 */
export const inject = []

/** llm-pi-ai 这个 fiber 的两种认法：包名（稳）或条目 id（用户可改）。 */
const TARGET_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'
const TARGET_ID = 'llm-pi-ai'

/**
 * 这些协议要求显式声明 compat.supportsStrictMode，
 * 否则适配器不会发 strict:false，网关侧会把可选权限字段当成必填而拒绝。
 */
const RESPONSES_PROTOCOLS = ['openai-responses', 'azure-openai-responses', 'openai-codex-responses']

let Config
try {
  const { default: Schema } = await import('@deepseek-ai/schemastery')
  Config = Schema.object({
    enabled: Schema.boolean().default(true).description('启用 ag 渠道'),
    url: Schema.string().default(URL_PRESETS[DEFAULT_PRESET])
      .description('ag 渠道地址：ps = https://ps.air-outer.com/v1，agentrouter = https://agentrouter.org/v1（也可填自定义完整端点）'),
    apiKeyEnv: Schema.string().default('AR_API_KEY').description('取 key 的凭据引用'),
    originator: Schema.string().default('codex_cli_rs').description('附带的 originator 请求头'),
    displayName: Schema.string().default('ar').description('显示名'),
    api: Schema.string().default('anthropic-messages').description('协议：anthropic-messages（去 /v1）/ openai-responses（保留 /v1）/ openai-completions'),
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
  // 插件改名前池 id 叫 'ag'，现在是 'ar'：把旧记录搬过来，冷却状态不丢
  if (poolState.pools?.ag !== undefined && poolState.pools.ar === undefined) {
    poolState.pools.ar = poolState.pools.ag
    delete poolState.pools.ag
  }

  /** 套站点列表（两个，各对应一个 provider 路由）。 */
  /** 站点 → 路由 id 的记忆（站点改地址后仍认得出自己那条路由）。 */
  const rememberedRoutes = new Map()

  /**
   * 站点身份键：用 **host + 协议**。
   * 同一个中转站上可能挂着两种协议的路由（anthropic-messages / openai-responses），
   * 只看 host 会把它们认成一个。
   */
  const stationKeyOf = (station) => {    const host = hostOfBaseURL(resolveBaseURL(station?.url ?? '', station?.api))
    const api = typeof station?.api === 'string' && station.api.length > 0 ? station.api : 'anthropic-messages'
    return host !== '' ? `${host}#${api}` : String(station?.id ?? '')
  }
  const stations = () => {
    const list = Array.isArray(state.stations) && state.stations.length > 0 ? state.stations : DEFAULT_STATIONS
    return list.map((station) => ({
      ...station,
      key: stationKeyOf(station),
      // 记住上次认到的路由 id：改地址后仍认得出「这条路由是我的」
      routeId: station.routeId ?? rememberedRoutes.get(stationKeyOf(station)) ?? '',
    }))
  }
  const stationById = (id) => stations().find((station) => station.id === id || station.key === id)
  /** 当前选中的站点（面板里编辑哪一个）。 */
  const currentStation = () => {
    const id = typeof state.current === 'string' ? state.current : undefined
    const found = id === undefined ? undefined : stationById(id)
    return found ?? stations()[0]
  }
  /**
   * 插件托管的 host：所有站点的 host。
   * **以 URL 判定，不以路由 id 判定** —— 路由叫什么名字都不影响插件接管它。
   */
  const managedHosts = () => {
    const hosts = new Set(presetHosts())
    for (const station of stations()) {
      const host = hostOfBaseURL(resolveBaseURL(station.url, station.api))
      if (host !== '') hosts.add(host)
    }
    return hosts
  }
  const isManagedUrl = (value) => {
    const host = hostOfBaseURL(String(value ?? ''))
    return host !== '' && managedHosts().has(host)
  }
  /**
   * 站点 → profile patch 里对应的路由 id。
   *
   * 按 **(host + 协议)** 认，不只看 host：同一个中转站上可能同时挂着
   * anthropic-messages 和 openai-responses 两条路由，它们得各认各的。
   *
   * 另外记住上次认到的路由 id（state 里的 routeId）：站点一旦改了地址，
   * host 就对不上了，得靠这个记性才认得出「这条路由还是我的」。
   */
  const routeIdOfStation = (station) => {
    if (station === undefined || station === null) return managedRouteId()
    const providers = patchProviders()
    const stationHost = hostOfBaseURL(resolveBaseURL(station.url, station.api))
    const stationApi = station.api
    const ids = Object.keys(providers)
    // 先按 host + 协议精确匹配
    const exact = ids.find((id) => {
      const host = hostOfBaseURL(String(providers[id]?.baseURL ?? ''))
      return host !== '' && host === stationHost && (providers[id]?.api ?? stationApi) === stationApi
    })
    if (exact !== undefined) {
      rememberRouteId(station, exact)
      return exact
    }
    // 上次认过的那个（地址改了也还算数）
    const remembered = typeof station.routeId === 'string' ? station.routeId : ''
    if (remembered !== '' && providers[remembered] !== undefined) {
      // 但要确认它现在确实是这个协议的（别抢了别的协议的路由）
      const api = providers[remembered]?.api
      if (api === undefined || api === stationApi) return remembered
    }
    // 退而求其次：同 host 的任意一条（协议可能还没写）
    const sameHost = ids.find((id) => {
      const host = hostOfBaseURL(String(providers[id]?.baseURL ?? ''))
      return host !== '' && host === stationHost
    })
    const result = sameHost ?? station.id
    rememberRouteId(station, result)
    return result
  }
  /** 记住站点 ↔ 路由的对应关系（改地址后仍认得）。 */
  const rememberRouteId = (station, routeId) => {
    if (station === undefined || station === null) return
    const key = station.key ?? stationKeyOf(station)
    if (rememberedRoutes.get(key) === routeId) return
    rememberedRoutes.set(key, routeId)
    station.routeId = routeId
    const list = Array.isArray(state.stations) ? state.stations : []
    const target = list.find((item) => item === station || (item.id !== undefined && item.id === station.id))
    if (target !== undefined) {
      target.routeId = routeId
      state.stations = list
    }
  }
  const presetOf = (value) => {
    for (const [name, url] of Object.entries(URL_PRESETS)) {
      if (value === name || value === url) return name
    }
    return 'custom'
  }
  const models = (station = currentStation()) => {
    const list = Array.isArray(station?.models) && station.models.length > 0
      ? station.models
      : Array.isArray(state.models) && state.models.length > 0
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
  const arKeys = () => (Array.isArray(state.keys) ? state.keys.filter((key) => typeof key === 'string' && key.length > 0) : [])

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
  /** configEditor 一到位就补一次托管路由（启动时它可能还没注入）。 */
  let ensureScheduled = false
  ctx.inject(['configEditor'], (scoped) => {
    configEditor = scoped.configEditor ?? null
    if (configEditor !== null && !ensureScheduled) {
      ensureScheduled = true
      // 放到下一个 tick：此时 apply 已跑完，ensureManagedRoutes 已定义
      setTimeout(() => { void ensureManagedRoutes() }, 0)
    }
  })
  const managedRouteId = () => managedId ?? (typeof config.providerId === 'string' && config.providerId.length > 0 ? config.providerId : 'ar')
  /** 往某个路由写字段（stationId 为空时用当前站点）。 */
  const writeAgProfile = async (fields, stationId = undefined) => {
    if (configEditor === null) {
      throw new Error('这个 profile 没有配置编辑器（configEditor），无法写入 provider 配置')
    }
    const entry = configEditor.entries().find((item) => item.options.id === 'llm-pi-ai')
    if (entry === undefined) {
      throw new Error('找不到 llm-pi-ai 条目')
    }
    const id = stationId ?? managedRouteId()
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

  /**
   * 套站共用的 key 池：host 覆盖所有站点（两个地址都命中），
   * key 来自状态文件。谁先失败就换下一个，失败的那个进冷却。
   */
  const arPool = () => ({
    id: 'ar',
    keys: arKeys(),
    hosts: [...managedHosts()],
    credentialRef: typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0 ? config.apiKeyEnv : 'AR_API_KEY',
    strategy: 'failover',
    authHeader: 'auto',
    cooldownMs: { quota: 60 * 60 * 1000, auth: 60 * 60 * 1000, rateLimit: 60 * 1000 },
    seed: true,
  })

  const persistPoolState = () => {
    try { writePoolState(home, poolState) } catch { /* 落盘失败不影响轮询 */ }
  }

  const engine = new KeyPoolEngine({
    pools: [arPool(), ...genericPools()],
    state: poolState,
    persist: persistPoolState,
    onRotate: ({ pool, key }) => {
      ctx.logger?.info?.(`ar-tuozhan: 池 ${pool.id} 已切到 ${maskKey(key)}`)
      void writeCredential(pool, key)
    },
  })

  /** 凭据服务可选：有就把换到的 key 写回去，下一次请求原生就用它。 */
  let credentials = null
  let seeded = false
  ctx.inject(['credentials'], (scoped) => {
    credentials = scoped.credentials ?? null
    // 凭据服务到位后立刻把池里的当前 key 灌进去（apply 那会儿它可能还没注入）
    if (credentials !== null && !seeded) {
      seeded = true
      setTimeout(() => { void seedCredential() }, 0)
    }
  })
  /**
   * 把池里的当前 key 写进凭据引用 —— provider 只要指向它就能用上，
   * 不需要人再手填一次。池里有 key 而凭据空/不在池里时都覆盖。
   */
  const seedCredential = async () => {
    if (credentials === null) return
    const pool = arPool()
    if (pool.keys.length === 0) return
    const key = engine.currentKey(pool) ?? pool.keys[0]
    if (key === null) return
    try {
      const stored = await credentials.resolve?.(pool.credentialRef)
      const value = stored?.value
      if (value === undefined || value === '' || pool.keys.includes(value)) {
        await credentials.set?.(pool.credentialRef, key)
        ctx.logger?.info?.(`ar-tuozhan: ${pool.credentialRef} 已指向池里的当前 key`)
      }
    } catch (error) {
      ctx.logger?.warn?.(`ar-tuozhan: 初始化凭据失败: ${error?.message ?? error}`)
    }
  }
  const writeCredential = async (pool, key) => {
    if (credentials === null || pool.credentialRef === '') return
    try {
      await credentials.set?.(pool.credentialRef, key)
    } catch (error) {
      ctx.logger?.warn?.(`ar-tuozhan: 写回凭据 ${pool.credentialRef} 失败: ${error?.message ?? error}`)
    }
  }

  const buildProfile = (station = currentStation()) => ({
    apiKeyEnv: typeof config.apiKeyEnv === 'string' && config.apiKeyEnv.length > 0 ? config.apiKeyEnv : 'AR_API_KEY',
    api: station?.api ?? 'anthropic-messages',
    baseURL: resolveBaseURL(station?.url ?? URL_PRESETS[DEFAULT_PRESET], station?.api ?? 'anthropic-messages'),
    models: models(station),
    headers: {
      ...(typeof config.originator === 'string' && config.originator.length > 0 ? { originator: config.originator } : { originator: 'codex_cli_rs' }),
    },
    ...(typeof config.displayName === 'string' && config.displayName.length > 0 ? { displayName: config.displayName } : {}),
  })

  if (config.enabled !== false) {
    // 不用运行时拦截：profile 的 patch 就是 llm-pi-ai 配置的真源，
    // 插件把托管路由补齐写进 patch（见 ensureManagedRoutes），
    // 运行时就自然带着插件的请求头与模型。
    ctx.logger?.info?.(
      `ar-tuozhan: 套站已接管（${stations().map((s) => `${s.label}(${s.api})`).join('、')}，key 数=${arKeys().length}）`,
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
   * 把每个站点的路由补进 profile：
   *   - 路由不存在 → 用站点配置建一个（id 优先用站点自己的）
   *   - 路由存在   → 只补用户没写的（协议、请求头），模型等一律不动
   *
   * 写进 patch 之后，运行时读到的就是它 —— Models 页看得见、也能编辑，
   * 插件的 originator 请求头也真的生效。
   */
  const ensureManagedRoutes = async () => {
    if (configEditor === null) return
    const providers = patchProviders()
    const defaults = buildProfile()
    const wanted = {}
    const ids = []
    for (const station of stations()) {
      const stationHost = hostOfBaseURL(resolveBaseURL(station.url, station.api))
      const providerIds = Object.keys(providers)
      // 这个站点已经有的路由：先按 host + 协议精确匹配，
      // 再退到同 host 的任意一条（协议可能还没写上）。
      const existingId = providerIds.find((id) => {
        const host = hostOfBaseURL(String(providers[id]?.baseURL ?? ''))
        return host !== '' && host === stationHost && (providers[id]?.api ?? station.api) === station.api
      }) ?? providerIds.find((id) => {
        const host = hostOfBaseURL(String(providers[id]?.baseURL ?? ''))
        return host !== '' && host === stationHost
      })
      const id = existingId ?? station.id
      const existing = providers[id] ?? {}
      wanted[id] = {
        ...existing,
        api: existing.api ?? station.api,
        baseURL: existing.baseURL ?? resolveBaseURL(station.url, station.api),
        // 凭据引用必须有，否则 llm-pi-ai 解析不到 key 会直接报 MISSING_CREDENTIAL
        apiKeyEnv: existing.apiKeyEnv ?? defaults.apiKeyEnv,
        models: Array.isArray(existing.models) && existing.models.length > 0 ? existing.models : models(station),
        headers: { ...defaults.headers, ...(existing.headers ?? {}) },
        // openai-responses 这类协议必须显式声明 supportsStrictMode，
        // 否则适配器不会发 strict:false，网关侧会把可选权限字段当成必填而拒绝。
        ...(existing.compat === undefined && RESPONSES_PROTOCOLS.includes(existing.api ?? station.api)
          ? { compat: { supportsStrictMode: true } }
          : {}),
        ...(existing.displayName === undefined ? { displayName: station.label ?? station.id } : {}),
      }
      ids.push(id)
    }
    managedIds = ids
    managedId = ids[0] ?? managedRouteId()
    const changed = ids.some((id) => JSON.stringify(providers[id] ?? {}) !== JSON.stringify(wanted[id]))
    if (!changed) return
    const entry = configEditor.entries().find((item) => item.options.id === 'llm-pi-ai')
    if (entry === undefined) return
    try {
      await configEditor.edit(entry, (raw) => ({
        ...raw,
        providers: {
          ...(raw.providers ?? {}),
          ...Object.fromEntries(ids.map((id) => [id, wanted[id]])),
        },
      }))
      ctx.logger?.info?.(`ar-tuozhan: 已在 profile 里就位托管路由 ${ids.join('、')}`)
    } catch (error) {
      ctx.logger?.warn?.(`ar-tuozhan: 写入托管路由失败: ${error?.message ?? error}`)
    }
  }
  void ensureManagedRoutes()

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
      engine.pools = [arPool(), ...genericPools()]
      ctx.logger?.info?.(`ar-tuozhan: 已重载（key 数=${arKeys().length}）`)
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
      void ensureManagedRoutes()
    }
  }, 15_000)
  if (typeof timer.unref === 'function') timer.unref()

  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      name: 'ar-tuozhan',
      description: 'ar 套站：看状态 / 切站点 / 换地址 / 加删 key',
      input: { hint: 'status | site <id> | url <ps|agentrouter|完整端点> | add <key> | remove <key> | use <key> | reset' },
      handler: async (invocation) => {
        const raw = (invocation?.rawInput ?? '').trim()
        const [action = 'status', value] = raw.split(/\s+/)

        if (action === 'site') {
          const station = value === undefined ? currentStation() : stationById(value)
          if (station === undefined) {
            return { kind: 'error', text: `没有叫 "${value}" 的站点。可用：${stations().map((s) => s.key ?? s.id).join('、')}` }
          }
          state.current = station.key ?? station.id
          writeState(home, state)
          return { kind: 'success', text: `当前站点切到「${station.label}」（${station.key ?? station.id}，${station.api}）。` }
        }

        if (action === 'url') {
          if (typeof value !== 'string' || value.length === 0) {
            return { kind: 'error', text: '用法：url <ps|agentrouter|完整端点>' }
          }
          const station = currentStation()
          const next = resolveBaseURL(value, station.api)
          try {
            // 写进 profile patch —— 和「设置 → 模型」里改 baseURL 是同一份数据
            await writeAgProfile({ baseURL: next }, routeIdOfStation(station))
          } catch (error) {
            return { kind: 'error', text: `改地址失败：${error?.message ?? error}` }
          }
          station.url = value
          state.stations = stations()
          writeState(home, state)
          return {
            kind: 'success',
            text: `「${station.label}」地址已切到 ${value}（baseURL=${next}，请求 ${requestUrlOf(next, station.api)}）。` +
              '\n已写入 profile 配置，「设置 → 模型」里看到的就是它。',
          }
        }

        if (action === 'models') {
          const station = currentStation()
          const providers = patchProviders()
          const route = providers[routeIdOfStation(station)] ?? {}
          const list = route.models ?? models(station)
          const lines = [`「${station.label}」的模型（这里改 / 在「设置 → 模型」里改，写进的是同一份 profile 配置）：`]
          for (const model of list) {
            lines.push(`  ${model.id}`)
            lines.push(`    名称: ${model.name ?? model.id}`)
            lines.push(`    上下文: ${model.contextWindow ?? '(默认)'}   输出上限: ${model.maxTokens ?? '(默认)'}`)
            lines.push(`    输入类型: ${Array.isArray(model.input) && model.input.length > 0 ? model.input.join(', ') : '(默认)'}`)
            lines.push(`    思考强度: ${model.reasoningEfforts === false ? '不支持' : JSON.stringify(model.reasoningEfforts ?? '(默认)')}`)
          }
          lines.push('', '想改就用「设置 → 模型」里编辑该路由，或用面板里的模型编辑器。')
          return { kind: 'success', text: lines.join('\n') }
        }

        if (action === 'add') {
          if (typeof value !== 'string' || value.length === 0) {
            return { kind: 'error', text: '用法：add <key> [别名]' }
          }
          const aliasRaw = (invocation?.rawInput ?? '').trim().split(/\s+/)[2]
          if (typeof aliasRaw === 'string' && aliasRaw.length > 0) {
            if (!state.aliases || typeof state.aliases !== 'object') state.aliases = {}
            state.aliases[value] = aliasRaw.slice(0, 40)
          }
          const keys = arKeys()
          if (!keys.includes(value)) keys.push(value)
          state.keys = keys
          writeState(home, state)
          engine.pools = [arPool(), ...genericPools()]
          const pool = arPool()
          const current = engine.currentKey(pool)
          if (current !== null) await writeCredential(pool, current)
          return {
            kind: 'success',
            text: `已加入 key ${maskKey(value)}（池里共 ${keys.length} 个）。` +
              (keys.length === 1 ? '\n提示：再加几个 key，才能在某个 key 没额度时自动切换。' : ''),
          }
        }

        if (action === 'use') {
          if (typeof value !== 'string' || value.length === 0) {
            return { kind: 'error', text: '用法：use <key>' }
          }
          const pool = arPool()
          const picked = engine.setCurrent(pool, value)
          if (picked === null) return { kind: 'error', text: '池里没有这个 key。' }
          await writeCredential(pool, picked)
          return { kind: 'success', text: `已把 ${maskKey(picked)} 设为优先使用的 key。` }
        }

        if (action === 'remove') {
          const keys = arKeys()
          const index = keys.indexOf(value ?? '')
          if (index < 0) return { kind: 'error', text: '池里没有这个 key。' }
          keys.splice(index, 1)
          state.keys = keys
          writeState(home, state)
          engine.pools = [arPool(), ...genericPools()]
          return { kind: 'success', text: `已移除 key ${maskKey(value)}（池里剩 ${keys.length} 个）。` }
        }

        if (action === 'reset') {
          const pool = arPool()
          engine.reset(pool)
          return { kind: 'success', text: '池里的冷却已全部清除。' }
        }

        const pool = arPool()
        const snapshot = engine.snapshot().find((item) => item.id === 'ar')
        const station = currentStation()
        const providers = patchProviders()
        const lines = [
          'ar 套站：',
          '',
          '站点：',
        ]
        for (const item of stations()) {
          const routeId = routeIdOfStation(item)
          const route = providers[routeId] ?? {}
          const isCurrent = item.id === station.id
          const baseURL = route.baseURL ?? resolveBaseURL(item.url, item.api)
          const api = route.api ?? item.api
          lines.push(`  ${isCurrent ? '▶' : ' '} ${item.label}（${item.id}，${api}）`)
          lines.push(`      路由: ${routeId}${route.displayName ? ` · 显示名 ${route.displayName}` : ''}`)
          lines.push(`      baseURL: ${baseURL}`)
          lines.push(`      实际请求: ${requestUrlOf(baseURL, api)}`)
          lines.push(`      模型: ${(route.models ?? models(item)).map((m) => m.id).join(', ')}`)
        }
        lines.push(
          '',
          `当前站点: ${station.label}（/ar-tuozhan site <id> 切换）`,
          `凭据引用: ${buildProfile(station).apiKeyEnv}`,
          `请求头: ${JSON.stringify(buildProfile(station).headers)}`,
          `状态文件: ${statePath(home)}`,
          '',
          `key 池（两个站点共用，${arKeys().length} 个）：`,
        )
        for (const key of snapshot?.keys ?? []) {
          const flags = [
            key.banned ? '已拉黑' : '',
            key.cooling > 0 ? `冷却 ${Math.ceil(key.cooling / 1000)}s` : '',
            key.failures > 0 ? `失败 ${key.failures} 次` : '',
          ].filter(Boolean).join(' / ')
          const alias = state.aliases?.[key.full] ?? ''
          lines.push(`  ${key.key}${alias ? '（' + alias + '）' : ''}${flags ? '  [' + flags + ']' : ''}${key.lastError ? '  ' + key.lastError : ''}`)
        }
        if (arKeys().length === 0) {
          lines.push('  （还没有 key —— 用 /ar-tuozhan add <key> 加几个）')
        }
        lines.push('', '命令：/ar-tuozhan site <id> | add <key> | use <key> | url <ps|agentrouter> | remove <key> | reset')
        return { kind: 'success', text: lines.join('\n') }
      },
    })
  })

  // --- 管理界面（webServer：JSON API + 独立页面）----------------------
  // 页面：/ar-tuozhan/        API：/ar-tuozhan/api/*
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
      const enginePool = engine.snapshot().find((item) => item.id === 'ar')
      const keys = (enginePool?.keys ?? []).map((key) => ({
        mask: key.key,
        full: key.full,
        alias: state.aliases?.[key.full] ?? '',
        current: enginePool?.current === key.full,
        banned: key.banned,
        failures: key.failures,
        cooling: key.cooling,
        lastError: key.lastError,
      }))
      const providers = patchProviders()
      const stationRows = stations().map((station) => {
        const routeId = routeIdOfStation(station)
        const route = providers[routeId] ?? {}
        const baseURL = route.baseURL ?? resolveBaseURL(station.url, station.api)
        const api = route.api ?? station.api
        return {
          id: station.id,
          key: station.key ?? station.id,
          label: station.label,
          api,
          url: station.url,
          baseURL,
          requestUrl: requestUrlOf(baseURL, api),
          routeId,
          displayName: route.displayName ?? station.label,
          credentialRef: route.apiKeyEnv ?? buildProfile(station).apiKeyEnv,
          headers: route.headers ?? buildProfile(station).headers,
          models: route.models ?? models(station),
        }
      })
      const active = currentStation()
      const row = stationRows.find((item) => item.id === active.id) ?? stationRows[0] ?? {}
      const defaults = buildProfile(active)
      return {
        ok: true,
        url: row.url ?? active.url,
        baseURL: row.baseURL ?? defaults.baseURL,
        requestUrl: row.requestUrl ?? requestUrlOf(defaults.baseURL, defaults.api),
        credentialRef: row.credentialRef ?? defaults.apiKeyEnv,
        headers: row.headers ?? defaults.headers,
        models: row.models ?? defaults.models,
        api: row.api ?? defaults.api,
        stations: stationRows,
        currentStation: active.key ?? active.id,
        keys,
        poolId: 'ar',
        managedId: managedRouteId(),
        managedIds: stationRows.map((item) => item.routeId),
        managedHosts: [...managedHosts()],
        canWriteProfile: configEditor !== null,
      }
    }
    const handler = async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const sub = url.pathname.replace(/^\/ar-tuozhan\/?/, '').replace(/\/+$/, '')
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
          const keys = arKeys()
          if (!keys.includes(key)) keys.push(key)
          state.keys = keys
          writeState(home, state)
          engine.pools = [arPool(), ...genericPools()]
          const pool = arPool()
          const current = engine.currentKey(pool)
          if (current !== null) await writeCredential(pool, current)
          sendJson(res, 200, stateSnapshot())
          return
        }
        if (req.method === 'POST' && sub === 'api/keys/alias') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const key = typeof body.key === 'string' ? body.key : ''
          const alias = typeof body.alias === 'string' ? body.alias.trim().slice(0, 40) : ''
          if (!arKeys().includes(key)) { sendJson(res, 400, { ok: false, error: '池里没有这个 key' }); return }
          if (!state.aliases || typeof state.aliases !== 'object') state.aliases = {}
          if (alias === '') delete state.aliases[key]
          else state.aliases[key] = alias
          writeState(home, state)
          sendJson(res, 200, stateSnapshot())
          return
        }
        if (req.method === 'POST' && sub === 'api/keys/current') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const key = typeof body.key === 'string' ? body.key : ''
          const pool = arPool()
          const picked = engine.setCurrent(pool, key)
          if (picked === null) { sendJson(res, 400, { ok: false, error: '池里没有这个 key' }); return }
          await writeCredential(pool, picked)
          sendJson(res, 200, stateSnapshot())
          return
        }
        if (req.method === 'POST' && sub === 'api/keys/remove') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const keys = arKeys()
          const removed = typeof body.key === 'string' ? body.key : ''
          const index = keys.indexOf(removed)
          if (index >= 0) keys.splice(index, 1)
          state.keys = keys
          if (state.aliases && typeof state.aliases === 'object') delete state.aliases[removed]
          writeState(home, state)
          engine.pools = [arPool(), ...genericPools()]
          sendJson(res, 200, stateSnapshot())
          return
        }
        if (req.method === 'POST' && sub === 'api/station') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const id = typeof body.id === 'string' ? body.id : ''
          const picked = stationById(id)
          if (picked === undefined) { sendJson(res, 400, { ok: false, error: '没有这个站点' }); return }
          state.current = picked.key ?? picked.id
          writeState(home, state)
          sendJson(res, 200, stateSnapshot())
          return
        }
        if (req.method === 'POST' && sub === 'api/url') {
          const body = JSON.parse((await readBody(req)) || '{}')
          const value = typeof body.url === 'string' ? body.url.trim() : ''
          if (value === '') { sendJson(res, 400, { ok: false, error: '端点不能为空' }); return }
          const station = typeof body.station === 'string' ? (stationById(body.station) ?? currentStation()) : currentStation()
          const next = resolveBaseURL(value, station.api)
          try {
            await writeAgProfile({ baseURL: next }, routeIdOfStation(station))
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
            return
          }
          station.url = value
          state.stations = stations()
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
          const station = typeof body.station === 'string' ? (stationById(body.station) ?? currentStation()) : currentStation()
          try {
            await writeAgProfile({ models: cleaned }, routeIdOfStation(station))
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
            return
          }
          station.models = cleaned
          state.stations = stations()
          writeState(home, state)
          sendJson(res, 200, stateSnapshot())
          return
        }
        if (req.method === 'POST' && sub === 'api/reset') {
          engine.reset(arPool())
          sendJson(res, 200, stateSnapshot())
          return
        }
        sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error?.message ?? String(error) })
      }
    }
    scoped.effect(
      () => server.register({ kind: 'prefix', path: '/ar-tuozhan', handler }),
      'ar-tuozhan: 管理界面',
    )
  })

  ctx.on('dispose', () => {
    clearInterval(timer)
    guard.uninstall()
    failover.uninstall()
  })
}
