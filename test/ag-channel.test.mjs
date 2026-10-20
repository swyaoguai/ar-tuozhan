/**
 * 自测：拦截器只改 llm-pi-ai 的 providers.ag，其它 provider 与其它 fiber 一概不碰。
 *
 *   node test/ag-channel.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ag-channel-'))
process.env.DSH_HOME = home

const { apply, name } = await import('../index.js')
const { normalizeBaseURL, requestUrlOf, resolveBaseURL, URL_PRESETS } = await import('../src/channel.js')

/** 造一个假 ctx，把 internal/config 的监听器与 webServer 路由抓出来。 */
function makeCtx() {
  const hooks = []
  const commands = []
  const registered = []
  const edits = []
  const configEditor = {
    entries: () => [{ options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } }],
    edit: async (entry, change) => {
      const current = { providers: {} }
      const next = change(current, {})
      edits.push({ id: entry.options.id, next })
      return next
    },
  }
  return {
    hooks,
    commands,
    registered,
    edits,
    logger: { info() {}, warn() {}, error() {} },
    on(event, listener) { if (event === 'internal/config') hooks.push(listener) },
    inject(names, fn) {
      fn({
        commands: { register: (cmd) => commands.push(cmd) },
        webServer: { register: (route) => registered.push(route) },
        configEditor,
        credentials: { resolve: async () => undefined, set: async () => {} },
        effect: (run) => { const dispose = run(); return () => dispose?.() },
      })
    },
    get() { return undefined },
  }
}

/** 假的 req/res，用来直接调 webServer 的 handler。 */
function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { 'content-length': String(body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body))) },
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
    headers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {} },
    end(payload) { if (payload !== undefined) this.body = String(payload) },
  }
}

const LLM_PI_AI_FIBER = { entry: { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } } }
const OTHER_FIBER = { entry: { options: { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' } } }

test('baseURL 归一：去掉尾部 /v1，避免 /v1/v1/messages', () => {
  assert.equal(normalizeBaseURL('https://ps.air-outer.com/v1'), 'https://ps.air-outer.com')
  assert.equal(normalizeBaseURL('https://agentrouter.org/v1'), 'https://agentrouter.org')
  assert.equal(normalizeBaseURL('https://ps.air-outer.com'), 'https://ps.air-outer.com')
  assert.equal(requestUrlOf('https://ps.air-outer.com'), 'https://ps.air-outer.com/v1/messages')
  assert.equal(resolveBaseURL('ps'), 'https://ps.air-outer.com')
  assert.equal(resolveBaseURL('agentrouter'), 'https://agentrouter.org')
})

test('只改 llm-pi-ai 的 providers.ag，其它 provider 原样保留', () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: true, url: URL_PRESETS.ps, apiKeyEnv: 'AG_API_KEY', originator: 'codex_cli_rs', autoFailover: false })
  assert.equal(ctx.hooks.length, 1)

  const raw = {
    providers: {
      'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY' },
      ag: { apiKeyEnv: 'AG_API_KEY', api: 'anthropic-messages', baseURL: 'https://old.example', models: [{ id: 'old' }] },
    },
  }
  const next = () => raw
  const out = ctx.hooks[0].call(LLM_PI_AI_FIBER, raw, next)

  assert.deepEqual(out.providers['minimax-cn'], raw.providers['minimax-cn'], '别的 provider 不能被碰')
  // 用户在 patch 里保存过的 ag 字段保持不变（合并，不是覆盖）
  assert.equal(out.providers.ag.baseURL, 'https://old.example')
  assert.deepEqual(out.providers.ag.models, [{ id: 'old' }])
  // 插件只补齐用户没写的
  assert.equal(out.providers.ag.headers.originator, 'codex_cli_rs')
  assert.equal(out.providers.ag.api, 'anthropic-messages')
  assert.equal(out.providers.ag.apiKeyEnv, 'AG_API_KEY')
  assert.notEqual(out.providers.ag, raw.providers.ag, 'ag 必须被换成插件的版本')
})

test('不是 llm-pi-ai 的 fiber 一律放行', () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: true, url: URL_PRESETS.ps, autoFailover: false })
  const raw = { providers: { 'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY' } } }
  const out = ctx.hooks[0].call(OTHER_FIBER, raw, () => raw)
  assert.equal(out, raw, '别的 fiber 的配置必须原样返回')
})

test('/ag-channel status 能报出当前地址与请求地址', async () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: true, url: URL_PRESETS.agentrouter, autoFailover: false })
  const cmd = ctx.commands.find((item) => item.name === 'ag-channel')
  assert.ok(cmd)
  const out = await cmd.handler({ rawInput: 'status' })
  assert.equal(out.kind, 'success')
  assert.match(out.text, /agentrouter/)
  assert.match(out.text, /https:\/\/agentrouter\.org\/v1\/messages/)
})

test('/ag-channel add <key> 把 key 存进状态文件，并让池认到它', async () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: true, url: URL_PRESETS.ps, autoFailover: false, keyRotation: false })
  const cmd = ctx.commands.find((item) => item.name === 'ag-channel')
  const out = await cmd.handler({ rawInput: 'add sk-secret-123456' })
  assert.equal(out.kind, 'success')

  const saved = JSON.parse(fs.readFileSync(path.join(home, 'ag-channel.json'), 'utf8'))
  assert.deepEqual(saved.keys, ['sk-secret-123456'])
  assert.match(out.text, /sk-s…3456|已加入 key/)
})

test('用户在「设置 → 模型」里保存的 ag 配置优先于插件默认值（不会被插件冲掉）', () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: true, url: URL_PRESETS.ps, apiKeyEnv: 'AG_API_KEY', originator: 'codex_cli_rs', autoFailover: false })

  // 模拟 profile patch 里已有 providers.ag（用户在 Models 页改过）
  const raw = {
    providers: {
      ag: {
        apiKeyEnv: 'AG_API_KEY',
        api: 'anthropic-messages',
        baseURL: 'https://ps.air-outer.com',
        models: [{ id: 'gpt-6.1-sol', name: 'gpt-6.1-sol-ar', contextWindow: 256000, maxTokens: 32000, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' } }],
        displayName: '我的 ag',
      },
    },
  }
  const out = ctx.hooks[0].call(LLM_PI_AI_FIBER, raw, () => raw)
  const ag = out.providers.ag

  assert.equal(ag.models.length, 1, '用户自己的模型列表要原样保留')
  assert.equal(ag.models[0].name, 'gpt-6.1-sol-ar')
  assert.equal(ag.models[0].contextWindow, 256000)
  assert.equal(ag.models[0].maxTokens, 32000)
  assert.deepEqual(ag.models[0].input, ['text', 'image'])
  assert.deepEqual(ag.models[0].reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high' })
  assert.equal(ag.displayName, '我的 ag')
  assert.equal(ag.baseURL, 'https://ps.air-outer.com')
  // 插件补齐用户没写的部分
  assert.equal(ag.headers.originator, 'codex_cli_rs', 'originator 头要补上')
  assert.equal(ag.api, 'anthropic-messages')
})

test('没保存过 ag 时用插件默认模型', () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: true, url: URL_PRESETS.ps, autoFailover: false })
  const raw = { providers: {} }
  const out = ctx.hooks[0].call(LLM_PI_AI_FIBER, raw, () => raw)
  assert.deepEqual(out.providers.ag.models.map((m) => m.id), ['deepseek-v4-flash', 'claude-opus-5.5', 'gpt-6-astra', 'gpt-6.1-sol'])
  assert.equal(out.providers.ag.baseURL, 'https://ps.air-outer.com')
})

test('webServer 路由：页面、读状态、加删 key、切地址都能用', async () => {
  const ctx = makeCtx()
  apply(ctx, { enabled: true, url: URL_PRESETS.ps, autoFailover: false, keyRotation: false })
  const routes = ctx.registered
  assert.equal(routes.length, 1, '应当注册一条前缀路由')
  assert.equal(routes[0].path, '/dsh-ag-channel')

  const call = async (method, url, body) => {
    const res = fakeRes()
    await routes[0].handler(fakeReq(method, url, body), res)
    return res
  }

  const page = await call('GET', '/dsh-ag-channel/')
  assert.equal(page.status, 200)
  assert.match(page.body, /ag 渠道/)

  const state = await call('GET', '/dsh-ag-channel/api/state')
  assert.equal(state.status, 200)
  const parsed = JSON.parse(state.body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.baseURL, 'https://ps.air-outer.com')
  assert.match(parsed.requestUrl, /ps\.air-outer\.com\/v1\/messages/)
  assert.equal(parsed.headers.originator, 'codex_cli_rs')

  const before = JSON.parse(state.body).keys.length
  const added = await call('POST', '/dsh-ag-channel/api/keys', { key: 'sk-one' })
  assert.equal(added.status, 200)
  assert.equal(JSON.parse(added.body).keys.length, before + 1)
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'ag-channel.json'), 'utf8'))
  assert.ok(saved.keys.includes('sk-one'))

  await call('POST', '/dsh-ag-channel/api/keys', { key: 'sk-two' })
  const two = JSON.parse((await call('GET', '/dsh-ag-channel/api/state')).body)
  assert.equal(two.keys.length, before + 2)

  const switched = await call('POST', '/dsh-ag-channel/api/url', { url: 'agentrouter' })
  assert.equal(JSON.parse(switched.body).baseURL, 'https://agentrouter.org')
  // 地址是写进 profile patch 的（和「设置 → 模型」同一份数据）
  assert.equal(ctx.edits.at(-1).next.providers.ag.baseURL, 'https://agentrouter.org')

  const removed = await call('POST', '/dsh-ag-channel/api/keys/remove', { key: 'sk-one' })
  assert.equal(JSON.parse(removed.body).keys.length, before + 1)

  // 写模型
  const modelsSaved = await call('POST', '/dsh-ag-channel/api/models', {
    models: [{ id: 'gpt-6.1-sol', name: 'gpt-6.1-sol-ar', contextWindow: 256000, maxTokens: 32000, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low' } }],
  })
  assert.equal(modelsSaved.status, 200)
  const written = ctx.edits.at(-1).next.providers.ag.models
  assert.equal(written.length, 1)
  assert.equal(written[0].id, 'gpt-6.1-sol')
  assert.equal(written[0].contextWindow, 256000)
  assert.equal(written[0].maxTokens, 32000)
  assert.deepEqual(written[0].input, ['text', 'image'])
  assert.deepEqual(written[0].reasoningEfforts, { off: null, low: 'low' })

  const missing = await call('GET', '/dsh-ag-channel/api/nope')
  assert.equal(missing.status, 404)
})
