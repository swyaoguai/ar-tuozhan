/**
 * 别名功能测试：设置、清除、随 key 删除。
 *
 *   node --test test/alias.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-alias-'))
process.env.DSH_HOME = home

const { apply } = await import('../index.js')

function makeCtx() {
  const commands = []
  const registered = []
  const edits = []
  const ctx = {
    commands,
    registered,
    edits,
    patch: { providers: {} },
    logger: { info() {}, warn() {}, error() {} },
    on() {},
    inject(names, fn) {
      fn({
        commands: { register: (cmd) => commands.push(cmd) },
        webServer: { register: (route) => registered.push(route) },
        configEditor: {
          entries: () => [{ options: { id: 'llm-pi-ai' } }],
          configuration: () => [{ entry: { options: { id: 'llm-pi-ai' } }, override: ctx.patch }],
          edit: async (entry, change) => {
            const next = change({ providers: ctx.patch.providers ?? {} }, {})
            edits.push(next)
            ctx.patch = next
            return next
          },
        },
        credentials: { resolve: async () => undefined, set: async () => {} },
        effect: (run) => { const dispose = run(); return () => dispose?.() },
      })
    },
    get() { return undefined },
  }
  return ctx
}

function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: {},
    on(event, cb) {
      if (event === 'data') for (const chunk of chunks) cb(chunk)
      if (event === 'end') cb()
    },
    destroy() {},
  }
}

function fakeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(payload) { if (payload !== undefined) this.body = String(payload) },
  }
}

test('别名：设置、修改、清除、随 key 删除', async () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: true, autoFailover: false, keyRotation: false })
  const route = ctx.registered[0]
  const call = async (method, url, body) => {
    const res = fakeRes()
    await route.handler(fakeReq(method, url, body), res)
    return JSON.parse(res.body)
  }

  // 加两个 key
  await call('POST', '/ar-tuozhan/api/keys', { key: 'sk-aaa' })
  await call('POST', '/ar-tuozhan/api/keys', { key: 'sk-bbb' })

  // 设别名
  const named = await call('POST', '/ar-tuozhan/api/keys/alias', { key: 'sk-aaa', alias: '主力号' })
  assert.equal(named.keys.find((k) => k.full === 'sk-aaa').alias, '主力号')

  // 落盘
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'ar-tuozhan.json'), 'utf8'))
  assert.equal(saved.aliases['sk-aaa'], '主力号')

  // 改别名
  const renamed = await call('POST', '/ar-tuozhan/api/keys/alias', { key: 'sk-aaa', alias: '备用号' })
  assert.equal(renamed.keys.find((k) => k.full === 'sk-aaa').alias, '备用号')

  // 清除（空串）
  const cleared = await call('POST', '/ar-tuozhan/api/keys/alias', { key: 'sk-aaa', alias: '' })
  assert.equal(cleared.keys.find((k) => k.full === 'sk-aaa').alias, '')
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'ar-tuozhan.json'), 'utf8')).aliases['sk-aaa'], undefined)

  // 不在池里的 key 拒绝
  const bad = await call('POST', '/ar-tuozhan/api/keys/alias', { key: 'sk-nope', alias: 'x' })
  assert.equal(bad.ok, false)

  // 删 key 时别名一并清掉
  await call('POST', '/ar-tuozhan/api/keys/alias', { key: 'sk-bbb', alias: '临时号' })
  await call('POST', '/ar-tuozhan/api/keys/remove', { key: 'sk-bbb' })
  const final = JSON.parse(fs.readFileSync(path.join(home, 'ar-tuozhan.json'), 'utf8'))
  assert.equal(final.aliases['sk-bbb'], undefined)
  assert.equal(final.keys.includes('sk-bbb'), false)
})
