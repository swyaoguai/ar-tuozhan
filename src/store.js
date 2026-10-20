/**
 * 池配置与状态的读写。
 *
 * 池配置（用户手写，含密钥）: ~/.dsh/key-pool.json
 * 冷却状态（插件写）:         ~/.dsh/key-pool-state.json
 *
 * 两份文件都不进 DSH 的设置页，也不进 profile —— 密钥只留在 DSH_HOME 下。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** DSH 主目录：环境变量优先，其次 ~/.dsh。 */
export function dshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

export function poolConfigPath(home) {
  return path.join(home, 'key-pool.json')
}

export function poolStatePath(home) {
  return path.join(home, 'key-pool-state.json')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 原子写：先写临时文件再 rename，避免 DSH 崩溃时留下半个 JSON。 */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

const DEFAULT_COOLDOWN = {
  quota: 60 * 60 * 1000,
  auth: 60 * 60 * 1000,
  rateLimit: 60 * 1000,
}

/**
 * 读池配置并归一化。配置非法时返回空池列表（不抛），插件仍然加载，
 * 只是不接管任何请求 —— 一个写坏的文件不该让 DSH 起不来。
 */
export function readPools(home, file = poolConfigPath(home)) {
  const raw = readJson(file)
  const list = Array.isArray(raw?.pools) ? raw.pools : []
  const pools = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const keys = Array.isArray(entry.keys)
      ? entry.keys.filter((key) => typeof key === 'string' && key.trim().length > 0).map((key) => key.trim())
      : []
    const hosts = Array.isArray(entry.hosts)
      ? entry.hosts.filter((host) => typeof host === 'string' && host.trim().length > 0).map((host) => host.trim().toLowerCase())
      : []
    if (id === '' || keys.length === 0) continue
    pools.push({
      id,
      keys,
      hosts,
      credentialRef: typeof entry.credentialRef === 'string' ? entry.credentialRef.trim() : '',
      strategy: entry.strategy === 'round-robin' ? 'round-robin' : 'failover',
      authHeader: entry.authHeader === 'x-api-key' || entry.authHeader === 'bearer' ? entry.authHeader : 'auto',
      cooldownMs: { ...DEFAULT_COOLDOWN, ...(entry.cooldownMs ?? {}) },
      seed: entry.seed !== false,
    })
  }
  return pools
}

export function writePools(home, pools, file = poolConfigPath(home)) {
  writeJson(file, { pools })
}

/** 冷却状态：{ pools: { [id]: { current, keys: { [key]: { cooldownUntil, failures, lastError, banned } } } } } */
export function readState(home, file = poolStatePath(home)) {
  const raw = readJson(file)
  if (raw === null || typeof raw !== 'object') return { pools: {} }
  if (raw.pools === null || typeof raw.pools !== 'object') return { pools: {} }
  return raw
}

export function writeState(home, state, file = poolStatePath(home)) {
  writeJson(file, state)
}
