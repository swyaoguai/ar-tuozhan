/**
 * fetch 层拦截：把命中池的请求接管过来，用池里的 key 发；失败就换 key 重发。
 *
 * 为什么拦 fetch 而不是改 provider 配置：
 *   pi-ai 发请求时写的是 `(options?.fetch ?? globalThis.fetch)(url, init)`，
 *   globalThis.fetch 是**调用时**才取的，所以在进程内换掉它就生效，
 *   DSH 的 provider 配置（apiKeyEnv / baseURL / models）一行都不用动。
 *
 * 边界：
 *   - 只碰 host 命中池配置的请求，其余请求原样放行；
 *   - 池里所有 key 都在冷却时，放行（让上游照常报错，不做无谓拦截）；
 *   - 请求体不可重放（stream / FormData）时不重试，只把错误如实返回。
 */

const PATCH = Symbol.for('dsh-key-pool.fetch')

/** 这些状态码值得换 key 再试一次。 */
const FAILURE_STATUS = new Set([401, 402, 403, 429])

export function requestUrl(input) {
  if (typeof input === 'string') return input
  if (input !== null && typeof input === 'object') {
    if (typeof input.url === 'string') return input.url
    if (typeof input.href === 'string') return input.href
  }
  return ''
}

export function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

/** 请求体能不能重放（换 key 重发时要用第二遍）。 */
export function bodyReusable(init) {
  if (init === undefined || init === null) return true
  const body = init.body
  if (body === undefined || body === null) return true
  if (typeof body === 'string') return true
  if (typeof Uint8Array !== 'undefined' && body instanceof Uint8Array) return true
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) return true
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) return true
  return false
}

function effectiveHeaders(input, init) {
  const headers = new Headers()
  if (input !== null && typeof input === 'object' && input.headers !== undefined) {
    const source = new Headers(input.headers)
    for (const [name, value] of source) headers.set(name, value)
  }
  if (init?.headers !== undefined) {
    const source = new Headers(init.headers)
    for (const [name, value] of source) {
      headers.delete(name)
      headers.set(name, value)
    }
  }
  return headers
}

/** 用哪个请求头带 key：沿用上游原本的风格，auto 时按 bearer 处理。 */
export function resolveAuthStyle(headers, pool) {
  if (pool.authHeader === 'bearer' || pool.authHeader === 'x-api-key') return pool.authHeader
  if (headers.has('x-api-key')) return 'x-api-key'
  if (headers.has('authorization')) return 'bearer'
  return 'bearer'
}

function applyKey(headers, style, key) {
  if (style === 'x-api-key') headers.set('x-api-key', key)
  else headers.set('authorization', `Bearer ${key}`)
}

async function readErrorBody(response) {
  try {
    const clone = response.clone()
    return await clone.text()
  } catch {
    return ''
  }
}

/**
 * 装上拦截器。
 * @param {object} options
 * @param {import('./pool.js').KeyPoolEngine} options.engine
 * @param {(level: string, payload: unknown) => void} [options.log]
 * @returns {{installed: boolean, uninstall: () => void}}
 */
export function installFetchGuard({ engine, log = () => {} }) {
  const original = globalThis.fetch
  if (typeof original !== 'function') {
    log('warn', 'dsh-key-pool: this runtime has no global fetch; nothing to guard')
    return { installed: false, uninstall: () => {} }
  }
  const previous = globalThis[PATCH]
  if (previous?.uninstall !== undefined) {
    try { previous.uninstall() } catch { /* 已经没了 */ }
  }

  const patched = async function keyPoolFetch(input, init) {
    const url = requestUrl(input)
    if (url === '') return original(input, init)
    const pool = engine.poolForHost(hostOf(url))
    if (pool === undefined) return original(input, init)
    const key = engine.currentKey(pool)
    if (key === null) return original(input, init)

    const maxAttempts = Math.max(1, Math.min(pool.keys.length, 4))
    const reusable = bodyReusable(init)
    // Request 的 body 只能读一次：先把要用的副本备好（pi-ai 走的是 init.body，这里只是兜底）。
    const requestClones = []
    if (!reusable && input !== null && typeof input === 'object' && typeof input.clone === 'function') {
      for (let index = 0; index < maxAttempts; index += 1) {
        try { requestClones.push(input.clone()) } catch { break }
      }
    }

    let usedKey = key
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const headers = effectiveHeaders(input, init)
      const style = resolveAuthStyle(headers, pool)
      applyKey(headers, style, usedKey)

      let callInput = input
      let callInit = { ...(init ?? {}), headers }
      if (requestClones.length > attempt) {
        try {
          callInput = new Headers === undefined ? input : makeRequest(requestClones[attempt], headers)
        } catch {
          callInput = input
        }
      }
      const response = await original(callInput, callInit)
      if (!FAILURE_STATUS.has(response.status)) {
        engine.markSuccess(pool, usedKey)
        return response
      }

      const text = await readErrorBody(response)
      const { classifyFailure } = await import('./pool.js')
      const kind = classifyFailure(response.status, text)
      if (kind === 'model') {
        // 套餐/模型层面的限制：换 key 也一样，如实把错误交给上层。
        log('warn', `dsh-key-pool: ${pool.id} 返回 ${response.status}（套餐/模型限制，未换 key）: ${text.slice(0, 200)}`)
        return response
      }
      const next = engine.rotate(pool, usedKey, kind, `${response.status} ${text.slice(0, 200)}`)
      if (next === null) {
        log('warn', `dsh-key-pool: ${pool.id} 没有可用 key 了，${usedKey} 冷却中`)
        return response
      }
      log('info', `dsh-key-pool: ${pool.id} 的 key 因 ${kind} 失败，已切换到下一个 key`)
      usedKey = next
      if (!reusable && requestClones.length === 0) {
        log('warn', 'dsh-key-pool: 请求体不可重放，无法自动重试')
        return response
      }
    }
    return original(input, init)
  }

  globalThis.fetch = patched
  const uninstall = () => {
    if (globalThis.fetch === patched) globalThis.fetch = original
    if (globalThis[PATCH]?.uninstall === uninstall) delete globalThis[PATCH]
  }
  globalThis[PATCH] = { uninstall, original }
  return { installed: true, uninstall }
}

function makeRequest(clone, headers) {
  return new Request(clone, { headers })
}
