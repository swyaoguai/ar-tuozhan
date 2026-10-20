/**
 * Key 池引擎：选 key、判失败、记冷却、给下一个。
 *
 * 失败分四类：
 *   auth      —— key 无效/被撤（401/403）→ 换 key
 *   quota     —— 额度/余额耗尽（402）→ 换 key
 *   rateLimit —— 被限流（429）→ 换 key（短冷却）
 *   model     —— 套餐等级/模型不支持（402 但带 2068 之类文案）→ **换 key 也没用**，
 *                直接把错误透传给用户，避免无意义的轮询风暴。
 *
 * 判定文案参考 MiniMax 的 2068："当前 Token Plan 套餐等级不支持该模型"，
 * 以及 OpenAI 的 model_not_found —— 这两类都是「账户/套餐」层面的问题，
 * 同一个池里的其它 key 大概率同样不支持。
 */

/** 命中即认为「换 key 解决不了」的错误文案。 */
const MODEL_LEVEL = /(token\s*plan|套餐|不支持该模型|模型不支持|model[_ ]not[_ ]found|model not found|does not support (the )?model|not support this model|model_not_supported)/i

/** 命中即认为「这个 key 真的没额度了」的错误文案。 */
const BALANCE = /(insufficient[_ ]balance|insufficient[_ ]quota|quota exhausted|exceeded your current quota|余额不足|额度不足|额度已用尽|账户余额)/i

export const FAILURE_KINDS = ['auth', 'quota', 'rateLimit', 'model']

/**
 * 读一段错误正文，判断失败类别。body 为空时按 status 兜底。
 * @param {number} status HTTP 状态码
 * @param {string} body 错误正文（可能为空）
 * @returns {'auth'|'quota'|'rateLimit'|'model'}
 */
export function classifyFailure(status, body = '') {
  const text = typeof body === 'string' ? body : ''
  if (MODEL_LEVEL.test(text)) return 'model'
  if (status === 429) return 'rateLimit'
  if (status === 402) return BALANCE.test(text) ? 'quota' : 'quota'
  if (status === 401 || status === 403) return 'auth'
  if (BALANCE.test(text)) return 'quota'
  return 'auth'
}

export class KeyPoolEngine {
  /**
   * @param {object} options
   * @param {Array} options.pools 归一化后的池配置
   * @param {object} options.state 冷却状态
   * @param {() => void} [options.persist] 状态落盘回调
   * @param {(info: object) => void} [options.onRotate] 换 key 回调
   * @param {() => number} [options.now] 时钟（测试可注入）
   */
  constructor({ pools, state, persist = () => {}, onRotate = () => {}, now = () => Date.now() }) {
    this.pools = pools
    this.state = state
    this.persist = persist
    this.onRotate = onRotate
    this.now = now
    if (this.state.pools === undefined || this.state.pools === null) this.state.pools = {}
  }

  /** 池按 host 索引；一个 host 可以属于多个池（取第一个有可用 key 的）。 */
  poolForHost(host) {
    const target = String(host ?? '').toLowerCase()
    if (target === '') return undefined
    for (const pool of this.pools) {
      for (const host of pool.hosts) {
        if (target === host || target.endsWith(`.${host}`)) return pool
      }
    }
    return undefined
  }

  stateOf(pool) {
    let entry = this.state.pools[pool.id]
    if (entry === undefined || entry === null || typeof entry !== 'object') {
      entry = { current: '', keys: {} }
      this.state.pools[pool.id] = entry
    }
    if (entry.keys === undefined || entry.keys === null || typeof entry.keys !== 'object') entry.keys = {}
    return entry
  }

  keyState(pool, key) {
    const entry = this.stateOf(pool)
    let record = entry.keys[key]
    if (record === undefined || record === null || typeof record !== 'object') {
      record = { cooldownUntil: 0, failures: 0, lastError: '', banned: false }
      entry.keys[key] = record
    }
    return record
  }

  /** 这个 key 现在能不能用。 */
  usable(pool, key) {
    const record = this.keyState(pool, key)
    if (record.banned === true) return false
    return Number(record.cooldownUntil ?? 0) <= this.now()
  }

  /** 池里第一个（或轮询后的下一个）可用 key。 */
  availableKey(pool, exclude = null) {
    const usable = pool.keys.filter((key) => key !== exclude && this.usable(pool, key))
    if (usable.length === 0) return null
    if (pool.strategy === 'round-robin') {
      const entry = this.stateOf(pool)
      const index = pool.keys.indexOf(entry.current ?? '')
      const start = index < 0 ? 0 : index + 1
      for (let step = 0; step < pool.keys.length; step += 1) {
        const candidate = pool.keys[(start + step) % pool.keys.length]
        if (candidate !== exclude && this.usable(pool, candidate)) return candidate
      }
      return usable[0]
    }
    return usable[0]
  }

  /** 当前应当使用的 key：优先沿用上一次成功的那个。 */
  currentKey(pool) {
    const entry = this.stateOf(pool)
    const current = typeof entry.current === 'string' ? entry.current : ''
    if (current !== '' && this.usable(pool, current)) return current
    const next = this.availableKey(pool)
    if (next !== null) {
      entry.current = next
      this.persist()
    }
    return next
  }

  /**
   * 记一次失败并冷却这个 key。
   * @returns {{kind: string, cooledUntil: number}|null} model 类失败返回 null（不冷却）
   */
  markFailure(pool, key, kind, error = '') {
    if (kind === 'model') return null
    const record = this.keyState(pool, key)
    record.failures = Number(record.failures ?? 0) + 1
    record.lastError = String(error ?? '').slice(0, 500)
    const cooldown = Number(pool.cooldownMs?.[kind] ?? 60_000)
    record.cooldownUntil = this.now() + cooldown
    const entry = this.stateOf(pool)
    if (entry.current === key) entry.current = ''
    this.persist()
    return { kind, cooledUntil: record.cooldownUntil }
  }

  /** 记一次成功：清冷却、记为当前 key。 */
  markSuccess(pool, key) {
    const record = this.keyState(pool, key)
    record.cooldownUntil = 0
    record.failures = 0
    record.lastError = ''
    this.stateOf(pool).current = key
    this.persist()
  }

  /**
   * 失败后换 key：选一个新的可用 key，写入状态并通知外部（写回凭据）。
   * @returns {string|null} 新 key；没有可换的了返回 null
   */
  rotate(pool, failedKey, kind, error = '') {
    this.markFailure(pool, failedKey, kind, error)
    const next = this.availableKey(pool, failedKey)
    if (next === null) return null
    this.stateOf(pool).current = next
    this.persist()
    this.onRotate({ pool, key: next, previous: failedKey, kind })
    return next
  }

  /** 手动把某个 key 放行 / 拉黑。 */
  setBanned(pool, key, banned) {
    const record = this.keyState(pool, key)
    record.banned = banned === true
    if (banned !== true) record.cooldownUntil = 0
    this.persist()
  }

  /** 全部解除冷却。 */
  reset(pool) {
    const entry = this.stateOf(pool)
    for (const key of pool.keys) {
      const record = this.keyState(pool, key)
      record.cooldownUntil = 0
      record.failures = 0
      record.lastError = ''
      record.banned = false
    }
    entry.current = ''
    this.persist()
  }

  /** 给人看的状态快照。 */
  snapshot() {
    const now = this.now()
    return this.pools.map((pool) => {
      const entry = this.stateOf(pool)
      return {
        id: pool.id,
        hosts: pool.hosts,
        strategy: pool.strategy,
        credentialRef: pool.credentialRef,
        current: entry.current ?? '',
        keys: pool.keys.map((key) => {
          const record = this.keyState(pool, key)
          const remaining = Math.max(0, Number(record.cooldownUntil ?? 0) - now)
          return {
            key: maskKey(key),
            full: key,
            banned: record.banned === true,
            failures: Number(record.failures ?? 0),
            cooling: remaining > 0 ? remaining : 0,
            lastError: record.lastError ?? '',
          }
        }),
      }
    })
  }
}

/** 只显示头尾，密钥不进日志。 */
export function maskKey(key) {
  const text = String(key ?? '')
  if (text.length <= 10) return `${text.slice(0, 2)}***`
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}
