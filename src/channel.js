/**
 * ag 渠道的状态与地址。
 *
 * 状态文件 ~/.dsh/ag-channel.json 里放这个渠道的一切：
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

export function dshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

export function statePath(home) {
  return path.join(home, 'ag-channel.json')
}

export function readState(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(home), 'utf8'))
    if (raw === null || typeof raw !== 'object') return {}
    return raw
  } catch {
    return {}
  }
}

export function writeState(home, state) {
  const file = statePath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 把「用户填的端点」归一成 DSH 能用的 baseURL。
 *  - 去掉尾部斜杠
 *  - 去掉尾部 /v1（SDK 自己会拼 /v1/messages）
 */
export function normalizeBaseURL(input) {
  let url = String(input ?? '').trim()
  if (url === '') return ''
  url = url.replace(/\/+$/, '')
  url = url.replace(/\/v1$/i, '')
  return url
}

/** 归一后的 baseURL → 实际请求地址（给日志看）。 */
export function requestUrlOf(baseURL) {
  return `${baseURL}/v1/messages`
}

/** 预设名或自定义地址 → 归一后的 baseURL。 */
export function resolveBaseURL(choice) {
  const preset = URL_PRESETS[choice]
  const raw = typeof choice === 'string' && choice.length > 0 ? choice : URL_PRESETS[DEFAULT_PRESET]
  return normalizeBaseURL(preset ?? raw)
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
