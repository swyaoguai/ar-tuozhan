/**
 * 冒烟测试：client.js 必须符合 DSH 外壳的 ModuleLoader 契约。
 *
 *   node test/client.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 极简 React 替身：client 只用到这几个导出。 */
const fakeReact = {
  // 返回一个可辨识的对象，这样「渲染出了东西」和「返回 null」能区分开
  createElement: (type, props) => ({ type, props }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

test('client.js 会向外壳注册，且 factory 返回一个客户端插件', () => {
  let loaded = null
  const fakeWindow = { __ModuleLoader__: { load: (arg) => { loaded = arg } } }
  // client.js 顶层引用 window，用参数把它喂进去。
  new Function('window', source)(fakeWindow)

  assert.ok(loaded, '必须调用 window.__ModuleLoader__.load(...)')
  assert.equal(loaded.id, 'dsh-ag-channel', 'id 必须是包名')
  assert.equal(typeof loaded.factory, 'function')

  const plugin = loaded.factory(() => fakeReact)
  assert.equal(plugin.name, 'dsh-ag-channel-client')
  assert.ok(Array.isArray(plugin.inject))
  assert.equal(typeof plugin.apply, 'function')
})

test('apply 会往 settings.section 槽里注册一个面板', () => {
  let loaded = null
  const fakeWindow = { __ModuleLoader__: { load: (arg) => { loaded = arg } } }
  new Function('window', source)(fakeWindow)
  const plugin = loaded.factory(() => fakeReact)

  const registered = []
  const ctx = {
    slots: {
      inject: (slotName, fn) => fn(),
      register: (meta, component) => registered.push({ meta, component }),
    },
  }
  plugin.apply(ctx)

  const section = registered.find((item) => item.meta.name === 'settings.section')
  assert.ok(section, '应当注册 settings.section 插槽')
  assert.equal(section.meta.id, 'ag-channel')
  assert.equal(typeof section.meta.label, 'function')
  assert.equal(section.meta.label(), 'ag 渠道')
  assert.equal(typeof section.component, 'function')
})

test('模型页插槽：只给 ag 这个 provider 渲染 key 池', () => {
  let loaded = null
  const fakeWindow = { __ModuleLoader__: { load: (arg) => { loaded = arg } } }
  new Function('window', source)(fakeWindow)
  const plugin = loaded.factory(() => fakeReact)

  const registered = []
  const ctx = {
    slots: {
      inject: (slotName, fn) => fn(),
      register: (meta, component) => registered.push({ meta, component }),
    },
  }
  plugin.apply(ctx)

  const card = registered.find((item) => item.meta.name === 'settings.models.provider-card')
  assert.ok(card, '应当注册 settings.models.provider-card 插槽')

  // 不是 ag 的 provider → 不渲染
  assert.equal(card.component({ provider: { provider: 'ar', settingsPath: ['providers', 'ar'] } }), null)
  assert.equal(card.component({ provider: { provider: 'minimax-cn' } }), null)
  assert.equal(card.component({}), null)
  // ag → 渲染出东西
  const rendered = card.component({ provider: { provider: 'ag', settingsPath: ['providers', 'ag'] } })
  assert.notEqual(rendered, null)
})
