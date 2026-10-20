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
  createElement: () => null,
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

  assert.equal(registered.length, 1)
  assert.equal(registered[0].meta.name, 'settings.section')
  assert.equal(registered[0].meta.id, 'ag-channel')
  assert.equal(typeof registered[0].meta.label, 'function')
  assert.equal(registered[0].meta.label(), 'ag 渠道')
  assert.equal(typeof registered[0].component, 'function')
})
