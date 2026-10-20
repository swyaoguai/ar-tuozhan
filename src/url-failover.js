/**
 * 两个地址的自动兜底：主地址连不上（网络层失败，请求根本没到上游）时，
 * 换另一个地址重发一次。
 *
 * 只在「抛异常」时兜底，不在 HTTP 状态码上兜底 —— 状态码说明请求已经被
 * 上游收到并处理过（可能已经计费），再打一次就是重复花钱。
 */

const PATCH = Symbol.for('dsh-ag-channel.fetch')

/** 这些错误说明请求没发出去，换个地址重发是安全的。 */
function isNetworkFailure(error) {
  if (error === null || error === undefined) return false
  const code = error?.cause?.code ?? error?.code
  if (typeof code === 'string') {
    return ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)
  }
  const message = String(error?.message ?? error)
  return /fetch failed|network|socket hang up|ECONNREFUSED|ENOTFOUND/i.test(message)
}

export function installUrlFailover({ primaryHost, fallbackHost, log = () => {} }) {
  const original = globalThis.fetch
  if (typeof original !== 'function') return { installed: false, uninstall: () => {} }
  const previous = globalThis[PATCH]
  if (previous?.uninstall !== undefined) {
    try { previous.uninstall() } catch { /* 已经没了 */ }
  }

  const patched = async function agChannelFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url
    if (typeof url !== 'string' || !url.includes(primaryHost)) return original(input, init)
    try {
      return await original(input, init)
    } catch (error) {
      if (!isNetworkFailure(error)) throw error
      const fallback = url.replace(primaryHost, fallbackHost)
      log('warn', `dsh-ag-channel: ${primaryHost} 连不上，改用 ${fallbackHost} 重试`)
      const nextInit = init === undefined || init === null
        ? undefined
        : { ...init, headers: new Headers(init.headers) }
      if (nextInit?.headers !== undefined) {
        const headers = new Headers(init.headers)
        for (const [name, value] of headers) {
          if (name.toLowerCase() === 'host') headers.delete(name)
        }
        nextInit.headers = headers
      }
      return original(fallback, nextInit)
    }
  }

  globalThis.fetch = patched
  const uninstall = () => {
    if (globalThis.fetch === patched) globalThis.fetch = original
    if (globalThis[PATCH]?.uninstall === uninstall) delete globalThis[PATCH]
  }
  globalThis[PATCH] = { uninstall, original }
  return { installed: true, uninstall }
}
