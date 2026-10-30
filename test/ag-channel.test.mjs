/**
 * 自测：拦截器只改 llm-pi-ai 的 providers.ar，其它 provider 与其它 fiber 一概不碰。
 *
 *   node test/ag-channel.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 每个测试用独立的 DSH_HOME —— 插件会把站点配置写进 ~/.dsh/ar-tuozhan.json，
 * 共用一个 home 会让前一个测试的改动污染后一个。
 */
function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-tuozhan-'))
  process.env.DSH_HOME = dir
  return dir
}

const { apply, name } = await import('../index.js')
const { normalizeBaseURL, requestUrlOf, resolveBaseURL, URL_PRESETS } = await import('../src/channel.js')

/** 造一个假 ctx，把命令、webServer 路由与 configEditor 的写入抓出来。 */
function makeCtx() {
  const hooks = []
  const commands = []
  const registered = []
  const edits = []
  const ctx = {
    hooks,
    commands,
    registered,
    edits,
    /** profile patch 里 llm-pi-ai 那一条的真实 providers */
    patch: { providers: {} },
    logger: { info() {}, warn() {}, error() {} },
    on(event, listener) { if (event === 'internal/config') hooks.push(listener) },
    inject(names, fn) {
      fn({
        commands: { register: (cmd) => commands.push(cmd) },
        webServer: { register: (route) => registered.push(route) },
        configEditor: {
          entries: () => [{ options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } }],
          configuration: () => [{ entry: { options: { id: 'llm-pi-ai' } }, override: ctx.patch }],
          edit: async (entry, change) => {
            // 真实的 configEditor 传的是当前完整配置（这里是 patch 里的 providers）
            const current = { providers: ctx.patch.providers ?? {} }
            const next = change(current, {})
            edits.push({ id: entry.options.id, next })
            // 写完之后 patch 也变了（模拟落盘）
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

test('baseURL 归一按协议区别对待', () => {
  // Anthropic：SDK 自己拼 /v1/messages → baseURL 去掉 /v1
  assert.equal(normalizeBaseURL('https://ps.air-outer.com/v1', 'anthropic-messages'), 'https://ps.air-outer.com')
  assert.equal(normalizeBaseURL('https://agentrouter.org/v1', 'anthropic-messages'), 'https://agentrouter.org')
  assert.equal(normalizeBaseURL('https://ps.air-outer.com', 'anthropic-messages'), 'https://ps.air-outer.com')
  assert.equal(requestUrlOf('https://ps.air-outer.com', 'anthropic-messages'), 'https://ps.air-outer.com/v1/messages')
  assert.equal(resolveBaseURL('ps', 'anthropic-messages'), 'https://ps.air-outer.com')
  assert.equal(resolveBaseURL('agentrouter', 'anthropic-messages'), 'https://agentrouter.org')

  // OpenAI 系：SDK 拼 /responses、/chat/completions → baseURL 必须保留 /v1
  assert.equal(normalizeBaseURL('https://ps.air-outer.com/v1', 'openai-responses'), 'https://ps.air-outer.com/v1')
  assert.equal(normalizeBaseURL('https://agentrouter.org/v1', 'openai-completions'), 'https://agentrouter.org/v1')
  assert.equal(requestUrlOf('https://ps.air-outer.com/v1', 'openai-responses'), 'https://ps.air-outer.com/v1/responses')
  assert.equal(requestUrlOf('https://ps.air-outer.com/v1', 'openai-completions'), 'https://ps.air-outer.com/v1/chat/completions')
  assert.equal(resolveBaseURL('ps', 'openai-responses'), 'https://ps.air-outer.com/v1')
})

test('启动时把插件的缺项补进 profile 里那个托管路由（按 URL 认，名字随意）', async () => {
  const home = freshHome()
  const ctx = makeCtx()
  ctx.patch = {
    providers: {
      'minimax-cn': { apiKeyEnv: 'MINIMAX_CN_API_KEY' },
      ar: { apiKeyEnv: 'AR_API_KEY', api: 'anthropic-messages', baseURL: 'https://ps.air-outer.com', models: [{ id: 'gpt-6.1-sol', name: 'gpt-6.1-sol-ar' }] },
    },
  }
  apply(ctx, { enabled: true, url: URL_PRESETS.ps, apiKeyEnv: 'AG_API_KEY', originator: 'codex_cli_rs', autoFailover: false })
  await new Promise((resolve) => setTimeout(resolve, 30))

  const providers = ctx.edits.at(-1)?.next?.providers
  const written = providers?.ar
  assert.ok(written, '应当写进 ar 这个路由（baseURL 命中托管 host）')
  assert.equal(written.baseURL, 'https://ps.air-outer.com', '用户的 baseURL 不动')
  assert.deepEqual(written.models, [{ id: 'gpt-6.1-sol', name: 'gpt-6.1-sol-ar' }], '用户的模型不动')
  assert.equal(written.headers.originator, 'codex_cli_rs', '插件补上 originator 头')
  assert.equal(written.api, 'anthropic-messages')
  assert.equal(written.apiKeyEnv, 'AR_API_KEY', '用户的凭据引用不动')
  assert.equal(providers['minimax-cn'].apiKeyEnv, 'MINIMAX_CN_API_KEY', '别的路由不碰')
  // 第二个站点（agentrouter / openai-responses）应当另建一个路由，且 baseURL 保留 /v1
  assert.ok(providers.agentrouter, '应当为第二个站点建路由')
  assert.equal(providers.agentrouter.api, 'openai-responses')
  assert.equal(providers.agentrouter.baseURL, 'https://agentrouter.org/v1', 'openai-responses 的 baseURL 保留 /v1')
  assert.equal(providers.agentrouter.headers.originator, 'codex_cli_rs')
})

test('一个托管路由都没有时，按 host 派生名新建两个路由', async () => {
  const home = freshHome()
  const ctx = makeCtx()
  ctx.patch = { providers: { other: { apiKeyEnv: 'Y', api: 'openai-completions', baseURL: 'https://ai.1tim.com/v1', models: [{ id: 'm2' }] } } }
  apply(ctx, { enabled: true, url: URL_PRESETS.ps, autoFailover: false })
  await new Promise((resolve) => setTimeout(resolve, 30))

  const providers = ctx.edits.at(-1)?.next?.providers
  assert.ok(providers.ps, '应当新建 ps 路由')
  assert.equal(providers.ps.baseURL, 'https://ps.air-outer.com')
  assert.deepEqual(providers.ps.models.map((m) => m.id), ['deepseek-v4-flash', 'claude-opus-5.5', 'gpt-6-astra', 'gpt-6.1-sol'])
  assert.ok(providers.agentrouter, '应当为第二个站点建路由')
  assert.equal(providers.agentrouter.baseURL, 'https://agentrouter.org/v1')
  assert.equal(providers.other.baseURL, 'https://ai.1tim.com/v1', '别的路由不碰')
})

test('同一个 host 上挂两种协议的路由时，按 host+协议分开认', async () => {
  const home = freshHome()
  const ctx = makeCtx()
  // ps.air-outer.com 上同时有 anthropic-messages 和 openai-responses 两条路由
  ctx.patch = {
    providers: {
      ar: { apiKeyEnv: 'AR_API_KEY', api: 'anthropic-messages', baseURL: 'https://ps.air-outer.com', models: [{ id: 'm1' }] },
      ar2: { apiKeyEnv: 'AR_API_KEY', api: 'openai-responses', baseURL: 'https://ps.air-outer.com/v1', models: [{ id: 'm2' }] },
    },
  }
  // 第二个站点的地址也指到 ps（两个站同 host，靠协议区分）
  const stateFile = path.join(home, 'ar-tuozhan.json')
  fs.writeFileSync(stateFile, JSON.stringify({
    keys: [],
    stations: [
      { id: 'ps', label: 'ps', url: 'https://ps.air-outer.com/v1', api: 'anthropic-messages' },
      { id: 'ps-responses', label: 'ps-responses', url: 'https://ps.air-outer.com/v1', api: 'openai-responses' },
    ],
  }, null, 2))
  apply(ctx, { enabled: true, url: URL_PRESETS.ps, autoFailover: false })
  await new Promise((resolve) => setTimeout(resolve, 30))

  const providers = ctx.edits.at(-1)?.next?.providers
  // 两条路由都还在，且各自保留自己的协议/模型
  assert.equal(providers.ar.api, 'anthropic-messages')
  assert.deepEqual(providers.ar.models.map((m) => m.id), ['m1'])
  assert.equal(providers.ar2.api, 'openai-responses')
  assert.deepEqual(providers.ar2.models.map((m) => m.id), ['m2'])
  // openai-responses 自动补 compat.supportsStrictMode
  assert.equal(providers.ar2.compat?.supportsStrictMode, true)
  // anthropic 那条不需要
  assert.equal(providers.ar.compat, undefined)
})

test('/ag-channel status 能报出当前地址与请求地址', async () => {
  const home = freshHome()
  const ctx = makeCtx()
  apply(ctx, { enabled: true, url: URL_PRESETS.agentrouter, autoFailover: false })
  const cmd = ctx.commands.find((item) => item.name === 'ar-tuozhan')
  assert.ok(cmd)
  const out = await cmd.handler({ rawInput: 'status' })
  assert.equal(out.kind, 'success')
  assert.match(out.text, /ps（ps，anthropic-messages）/)
  assert.match(out.text, /https:\/\/ps\.air-outer\.com\/v1\/messages/)
  assert.match(out.text, /agentrouter（agentrouter，openai-responses）/)
  assert.match(out.text, /https:\/\/agentrouter\.org\/v1\/responses/)
})

test('/ag-channel add <key> 把 key 存进状态文件，并让池认到它', async () => {
  const home = freshHome()
  const ctx = makeCtx()
  apply(ctx, { enabled: true, url: URL_PRESETS.ps, autoFailover: false, keyRotation: false })
  const cmd = ctx.commands.find((item) => item.name === 'ar-tuozhan')
  const out = await cmd.handler({ rawInput: 'add sk-secret-123456' })
  assert.equal(out.kind, 'success')

  const saved = JSON.parse(fs.readFileSync(path.join(home, 'ar-tuozhan.json'), 'utf8'))
  assert.deepEqual(saved.keys, ['sk-secret-123456'])
  assert.match(out.text, /sk-s…3456|已加入 key/)
})

test('webServer 路由：页面、读状态、加删 key、切地址都能用', async () => {
  const home = freshHome()
  const ctx = makeCtx()
  apply(ctx, { enabled: true, url: URL_PRESETS.ps, autoFailover: false, keyRotation: false })
  const routes = ctx.registered
  assert.equal(routes.length, 1, '应当注册一条前缀路由')
  assert.equal(routes[0].path, '/ar-tuozhan')

  const call = async (method, url, body) => {
    const res = fakeRes()
    await routes[0].handler(fakeReq(method, url, body), res)
    return res
  }

  const page = await call('GET', '/ar-tuozhan/')
  assert.equal(page.status, 200)
  assert.match(page.body, /ag 渠道/)

  const state = await call('GET', '/ar-tuozhan/api/state')
  assert.equal(state.status, 200)
  const parsed = JSON.parse(state.body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.baseURL, 'https://ps.air-outer.com')
  assert.match(parsed.requestUrl, /ps\.air-outer\.com\/v1\/messages/)
  assert.equal(parsed.headers.originator, 'codex_cli_rs')

  const before = JSON.parse(state.body).keys.length
  const added = await call('POST', '/ar-tuozhan/api/keys', { key: 'sk-one' })
  assert.equal(added.status, 200)
  assert.equal(JSON.parse(added.body).keys.length, before + 1)
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'ar-tuozhan.json'), 'utf8'))
  assert.ok(saved.keys.includes('sk-one'))

  await call('POST', '/ar-tuozhan/api/keys', { key: 'sk-two' })
  const two = JSON.parse((await call('GET', '/ar-tuozhan/api/state')).body)
  assert.equal(two.keys.length, before + 2)

  const switched = await call('POST', '/ar-tuozhan/api/url', { url: 'agentrouter' })
  assert.equal(JSON.parse(switched.body).baseURL, 'https://agentrouter.org')
  // 地址是写进 profile patch 的（和「设置 → 模型」同一份数据）
  const patchAfter = ctx.edits.at(-1).next.providers
  const switchedRoute = Object.values(patchAfter).find((route) => route?.baseURL === 'https://agentrouter.org')
  assert.ok(switchedRoute, '切地址后应当有一条路由指向新地址')

  const removed = await call('POST', '/ar-tuozhan/api/keys/remove', { key: 'sk-one' })
  assert.equal(JSON.parse(removed.body).keys.length, before + 1)

  // 手动指定优先使用的 key
  const preferred = await call('POST', '/ar-tuozhan/api/keys/current', { key: 'sk-two' })
  assert.equal(preferred.status, 200)
  const afterPick = JSON.parse(preferred.body)
  const picked = afterPick.keys.find((key) => key.full === 'sk-two')
  assert.equal(picked.current, true, '被指定的 key 应当成为使用中的那个')
  // 不在池里的 key 不行
  const bad = await call('POST', '/ar-tuozhan/api/keys/current', { key: 'sk-nope' })
  assert.equal(bad.status, 400)

  // 写模型
  const modelsSaved = await call('POST', '/ar-tuozhan/api/models', {
    models: [{ id: 'gpt-6.1-sol', name: 'gpt-6.1-sol-ar', contextWindow: 256000, maxTokens: 32000, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low' } }],
  })
  assert.equal(modelsSaved.status, 200)
  const written = ctx.edits.at(-1).next.providers.ps.models
  assert.equal(written.length, 1)
  assert.equal(written[0].id, 'gpt-6.1-sol')
  assert.equal(written[0].contextWindow, 256000)
  assert.equal(written[0].maxTokens, 32000)
  assert.deepEqual(written[0].input, ['text', 'image'])
  assert.deepEqual(written[0].reasoningEfforts, { off: null, low: 'low' })

  const missing = await call('GET', '/ar-tuozhan/api/nope')
  assert.equal(missing.status, 404)
})
