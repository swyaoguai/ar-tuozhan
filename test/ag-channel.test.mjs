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

/** 造一个假 ctx，把 internal/config 的监听器抓出来。 */
function makeCtx() {
  const hooks = []
  const commands = []
  return {
    hooks,
    commands,
    logger: { info() {}, warn() {}, error() {} },
    on(event, listener) { if (event === 'internal/config') hooks.push(listener) },
    inject(names, fn) { fn({ commands: { register: (cmd) => commands.push(cmd) } }) },
    get() { return undefined },
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
  assert.equal(out.providers.ag.baseURL, 'https://ps.air-outer.com')
  assert.equal(out.providers.ag.api, 'anthropic-messages')
  assert.equal(out.providers.ag.apiKeyEnv, 'AG_API_KEY')
  assert.deepEqual(out.providers.ag.headers, { originator: 'codex_cli_rs' })
  assert.deepEqual(out.providers.ag.models.map((m) => m.id), ['deepseek-v4-flash', 'claude-opus-5.5', 'gpt-6-astra', 'gpt-6.1-sol'])
  assert.deepEqual(out.providers.ag.models.at(-1).input, ['text', 'image'], '带图片输入的模型要保留 input')
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
