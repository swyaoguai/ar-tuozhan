/**
 * ag 渠道的状态与地址。
 *
 * 状态文件 ~/.dsh/ar-tuozhan.json 里放这个渠道的一切：
 *   { "url": "https://ps.air-outer.com/v1", "keys": ["sk-…"], "models": [...] }
 *
 * 注意 baseURL 的归一：Anthropic 协议下 pi-ai 走的是官方 SDK，
 * `beta.messages` 打的是 `<baseURL>/v1/messages`。所以用户手里的
 * 「完整端点」（https://ps.air-outer.com/v1）不能原样填进 baseURL，
 * 否则会变成 /v1/v1/messages。这里统一去掉尾部的 /v1。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 两个都可用，用户挑一个。 */
export const URL_PRESETS = {
  ps: 'https://ps.air-outer.com/v1',
  agentrouter: 'https://agentrouter.org/v1',
}

export const DEFAULT_PRESET = 'ps'

/** 渠道里默认这四个模型（可在设置页或状态文件里改）。 */
export const DEFAULT_MODELS = [
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' },
  { id: 'claude-opus-5.5', name: 'claude-opus-5.5' },
  { id: 'gpt-6-astra', name: 'gpt-6-astra' },
  { id: 'gpt-6.1-sol', name: 'gpt-6.1-sol', input: ['text', 'image'] },
]

/**
 * 两个套站点，各对应一个 provider（路由）：
 *   ps         → ps.air-outer.com  → anthropic-messages（SDK 自己拼 /v1/messages）
 *   agentrouter→ agentrouter.org   → openai-responses（SDK 拼 /responses，baseURL 留 /v1）
 * 两者实测都支持这两种协议；originator 头是必需的。
 */
export const DEFAULT_STATIONS = [
  { id: 'ar', label: 'ps', url: URL_PRESETS.ps, api: 'anthropic-messages' },
  { id: 'ar2', label: 'agentrouter', url: URL_PRESETS.agentrouter, api: 'openai-responses' },
]

export function dshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

export function statePath(home) {
  return path.join(home, 'ar-tuozhan.json')
}

/** 旧版本的状态文件（插件改名前）：读新文件时顺手迁移，key 池不丢。 */
function legacyStatePath(home) {
  return path.join(home, 'ag-channel.json')
}

export function readState(home) {
  const file = statePath(home)
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw !== null && typeof raw === 'object') return normalizeState(raw)
  } catch {
    // 新文件还没有 → 看看旧的在不在
  }
  try {
    const legacy = legacyStatePath(home)
    const raw = JSON.parse(fs.readFileSync(legacy, 'utf8'))
    if (raw !== null && typeof raw === 'object') {
      // 迁移到新名字
      try { writeState(home, normalizeState(raw)) } catch { /* 迁移失败也不影响读 */ }
      return normalizeState(raw)
    }
  } catch {
    // 旧文件也没有
  }
  return {}
}

/**
 * 状态归一：旧版本只有 { url, keys }（一个站点），现在�� { stations, keys }（两个站点）。
 * 旧数据迁过来时，第一个站点沿用原来的地址与协议。
 */
export function normalizeState(raw) {
  const state = { ...raw }
  if (!Array.isArray(state.stations) || state.stations.length === 0) {
    const first = { ...DEFAULT_STATIONS[0] }
    if (typeof raw.url === 'string' && raw.url.length > 0) first.url = raw.url
    state.stations = [first, { ...DEFAULT_STATIONS[1] }]
  }
  state.stations = state.stations
    .filter((station) => station !== null && typeof station === 'object' && typeof station.url === 'string' && station.url.length > 0)
    .map((station, index) => ({
      id: typeof station.id === 'string' && station.id.length > 0 ? station.id : `ar${index + 1}`,
      label: typeof station.label === 'string' && station.label.length > 0 ? station.label : station.id ?? `站 ${index + 1}`,
      url: station.url,
      api: typeof station.api === 'string' && station.api.length > 0 ? station.api : 'anthropic-messages',
      ...(Array.isArray(station.models) && station.models.length > 0 ? { models: station.models } : {}),
    }))
  if (!Array.isArray(state.keys)) state.keys = []
  return state
}

export function writeState(home, state) {
  const file = statePath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 把「用户填的端点」归一成 DSH 能用的 baseURL —— **按协议区别对待**：
 *
 *  - anthropic-messages：pi-ai 走官方 Anthropic SDK，它自己拼 `/v1/messages`，
 *    所以 baseURL 末尾不能有 /v1（否则变成 /v1/v1/messages）→ 去掉。
 *  - openai-completions / openai-responses：走 OpenAI SDK，它拼的是
 *    `/chat/completions`、`/responses`，baseURL **必须保留 /v1** → 保留。
 *
 * 也就是说：用户填的永远是「完整端点」（https://host/v1），插件按协议决定
 * 去掉还是保留那截 /v1。
 *
 * 传进来的是预设名（ps / agentrouter）时先解析成 URL——调用方不必自己判断，
 * 免得把 "ps" 这种字符串当地址写进配置。
 */
export function normalizeBaseURL(input, api = 'anthropic-messages') {
  let url = String(input ?? '').trim()
  if (url === '') return ''
  if (URL_PRESETS[url] !== undefined) url = URL_PRESETS[url]
  url = url.replace(/\/+$/, '')
  if (api === 'anthropic-messages') url = url.replace(/\/v1$/i, '')
  return url
}

/** 归一后的 baseURL → 实际请求地址（给日志看）。 */
export function requestUrlOf(baseURL, api = 'anthropic-messages') {
  if (api === 'anthropic-messages') return `${baseURL}/v1/messages`
  if (api === 'openai-responses') return `${baseURL}/responses`
  return `${baseURL}/chat/completions`
}

/** 预设名或自定义地址 → 归一后的 baseURL（按协议）。 */
export function resolveBaseURL(choice, api = 'anthropic-messages') {
  const preset = URL_PRESETS[choice]
  const raw = typeof choice === 'string' && choice.length > 0 ? choice : URL_PRESETS[DEFAULT_PRESET]
  return normalizeBaseURL(preset ?? raw, api)
}

/** 归一后的 baseURL → host（key 池要按 host 匹配请求）。 */
export function hostOfBaseURL(baseURL) {
  try {
    return new URL(baseURL).host.toLowerCase()
  } catch {
    return ''
  }
}

/** 两个预设的 host（自动兜底时互换用）。 */
export function presetHosts() {
  return Object.values(URL_PRESETS).map((url) => hostOfBaseURL(normalizeBaseURL(url)))
}
