/**
 * 自测：用一个假上游验证拦截器的四条行为。
 *
 *   node --test test/
 *
 * 覆盖：正常请求用当前 key / 额度耗尽换 key 并重发 / 套餐限制不换 key /
 *       全部冷却时放行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { KeyPoolEngine, classifyFailure } from '../src/pool.js'
import { installFetchGuard } from '../src/fetch-guard.js'

/** 记下每个请求带的是哪个 key。 */
function startServer() {
  const seen = []
  const server = http.createServer((req, res) => {
    const key = req.headers['x-api-key'] ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    seen.push({ url: req.url, key })
    if (req.url === '/quota') {
      if (key === 'key-good') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return }
      res.writeHead(402, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"insufficient balance"}}')
      return
    }
    if (req.url === '/plan') {
      res.writeHead(402, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"当前 Token Plan 套餐等级不支持该模型，请升级套餐后使用。 (2068)"}}')
      return
    }
    if (req.url === '/auth') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"invalid api key"}}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, seen, host: `127.0.0.1:${port}` })
    })
  })
}

function makeEngine(host, keys) {
  const pool = {
    id: 'test',
    keys,
    hosts: [host],
    credentialRef: '',
    strategy: 'failover',
    authHeader: 'auto',
    cooldownMs: { quota: 60_000, auth: 60_000, rateLimit: 60_000 },
    seed: true,
  }
  const engine = new KeyPoolEngine({ pools: [pool], state: { pools: {} }, persist: () => {} })
  return { engine, pool }
}

test('失败分类：套餐/模型限制不被当成可轮换的额度问题', () => {
  assert.equal(classifyFailure(402, 'insufficient balance'), 'quota')
  assert.equal(classifyFailure(402, '当前 Token Plan 套餐等级不支持该模型 (2068)'), 'model')
  assert.equal(classifyFailure(401, 'invalid api key'), 'auth')
  assert.equal(classifyFailure(429, 'too many requests'), 'rateLimit')
  assert.equal(classifyFailure(404, 'model_not_found'), 'model')
})

test('正常请求用当前 key；额度耗尽换 key 重发；套餐限制不换 key', async (t) => {
  const { server, seen, host } = await startServer()
  t.after(() => server.close())

  const { engine, pool } = makeEngine(host, ['key-bad', 'key-good'])
  const guard = installFetchGuard({ engine })
  t.after(() => guard.uninstall())

  // 1) 正常请求：带 key-bad，成功
  const ok = await fetch(`http://${host}/ok`, { headers: { 'x-api-key': 'key-bad' } })
  assert.equal(ok.status, 200)
  assert.equal(seen.at(-1).key, 'key-bad')

  // 2) 额度耗尽：key-bad 被 402 拒 → 换 key-good 重发成功
  const quota = await fetch(`http://${host}/quota`, { headers: { 'x-api-key': 'key-bad' } })
  assert.equal(quota.status, 200)
  assert.deepEqual(seen.slice(-2).map((item) => item.key), ['key-bad', 'key-good'])
  // 换过的 key 被记为当前
  assert.equal(engine.currentKey(pool), 'key-good')
  // 坏 key 进入冷却
  assert.equal(engine.usable(pool, 'key-bad'), false)

  // 3) 套餐限制：原样透传，不换 key
  const before = seen.length
  const plan = await fetch(`http://${host}/plan`, { headers: { 'x-api-key': 'key-good' } })
  assert.equal(plan.status, 402)
  assert.equal(seen.length, before + 1, '套餐限制不应触发重发')
  assert.equal(engine.currentKey(pool), 'key-good', '套餐限制不应换掉当前 key')
})

test('所有 key 都在冷却时放行，不做无谓拦截', async (t) => {
  const { server, seen, host } = await startServer()
  t.after(() => server.close())

  const { engine, pool } = makeEngine(host, ['key-a', 'key-b'])
  const guard = installFetchGuard({ engine })
  t.after(() => guard.uninstall())

  engine.markFailure(pool, 'key-a', 'quota', 'no money')
  engine.markFailure(pool, 'key-b', 'quota', 'no money')
  assert.equal(engine.availableKey(pool), null)

  const before = seen.length
  const response = await fetch(`http://${host}/ok`, { headers: { 'x-api-key': 'key-a' } })
  assert.equal(response.status, 200)
  assert.equal(seen.length, before + 1)
  assert.equal(seen.at(-1).key, 'key-a', '不该替换成别的 key')
})

test('不属于池的 host 完全不受影响', async (t) => {
  const { server, seen, host } = await startServer()
  t.after(() => server.close())

  const { engine } = makeEngine('example.invalid', ['key-a'])
  const guard = installFetchGuard({ engine })
  t.after(() => guard.uninstall())

  const response = await fetch(`http://${host}/ok`, { headers: { 'x-api-key': 'whatever' } })
  assert.equal(response.status, 200)
  assert.equal(seen.at(-1).key, 'whatever')
})
