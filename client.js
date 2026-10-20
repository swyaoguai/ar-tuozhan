/**
 * dsh-ag-channel 的浏览器半身。
 *
 * 两个入口：
 *   1. 设置 → 模型 → ag 这个 provider 的卡片里：多 key 池（settings.models.provider-card 插槽）
 *   2. 设置 → ag 渠道（独立分区）：渠道、key 池、模型编辑
 *
 * 这是手写的 ModuleLoader bundle：外壳会执行它，它必须恰好调用一次
 * `window.__ModuleLoader__.load({ id, factory })`，factory(require) 返回一个
 * Cordis 客户端插件（{ name, inject, apply }）。外壳只提供 require('react')。
 * 没有构建步骤，也不能在模块顶层做 require/exports —— 全部写在 factory 里。
 *
 * 所有写操作都走宿主提供的 /dsh-ag-channel/api/*（同源，无需鉴权）。
 *
 * @module client.js
 */
window.__ModuleLoader__.load({
  id: 'dsh-ag-channel',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const inject = ['slots']
    const API_BASE = '/dsh-ag-channel/api'

    const S = {
      page: { padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18 },
      h2: { fontSize: 14, fontWeight: 600, margin: 0 },
      sub: { fontSize: 12, opacity: 0.65, margin: '4px 0 0', lineHeight: 1.6 },
      card: { border: '1px solid var(--dsh-border, rgba(128,128,128,.25))', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      grow: { flex: 1, minWidth: 160 },
      input: { padding: '8px 10px', borderRadius: 8, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'var(--dsh-input-bg, rgba(128,128,128,.08))', color: 'inherit', font: 'inherit', outline: 'none' },
      btn: { padding: '7px 13px', borderRadius: 8, border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', background: 'var(--dsh-input-bg, rgba(128,128,128,.08))', color: 'inherit', font: 'inherit', cursor: 'pointer' },
      btnPrimary: { padding: '7px 13px', borderRadius: 8, border: 'none', background: 'var(--dsh-accent, #4f7cff)', color: '#fff', font: 'inherit', fontWeight: 600, cursor: 'pointer' },
      btnGhost: { padding: '5px 10px', borderRadius: 7, border: '1px solid var(--dsh-border, rgba(128,128,128,.4))', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer' },
      pill: { fontSize: 11, padding: '2px 8px', borderRadius: 999, fontWeight: 600 },
      mono: { font: '12px ui-monospace, Menlo, Consolas, monospace' },
      empty: { fontSize: 12, opacity: 0.6, padding: '10px 0', textAlign: 'center' },
      hint: { fontSize: 11, opacity: 0.55, margin: 0 },
    }

    const pill = (text, color) => h('span', { style: { ...S.pill, background: `${color}22`, color } }, text)

    async function api(path, body) {
      const opts = body === undefined
        ? { headers: { accept: 'application/json' } }
        : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }
      const res = await fetch(`${API_BASE}/${path}`, opts)
      const data = await res.json().catch(() => ({ ok: false, error: '响应不是 JSON' }))
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
      return data
    }

    /* ------------------------------------------------------------------ */
    /* key 池（模型页与设置分区共用）                                        */
    /* ------------------------------------------------------------------ */

    /** 读一次插件状态（渠道、key 池、模型、托管路由名单）。 */
    function useAgState() {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const load = useCallback(async () => {
        try {
          setState(await api('state'))
          setError(null)
        } catch (e) {
          setError(e.message)
        }
      }, [])
      useEffect(() => { load() }, [load])
      return [state, error, load]
    }

    function KeyPoolWidget({ compact = false }) {
      const [state, error, load] = useAgState()
      const [newKey, setNewKey] = useState('')
      const [busy, setBusy] = useState(false)

      const run = useCallback(async (fn) => {
        setBusy(true)
        try { await fn(); await load() } catch (e) { /* load 里的 error 会显示 */ } finally { setBusy(false) }
      }, [load])

      const addKey = () => {
        const key = newKey.trim()
        if (!key) return
        setNewKey('')
        run(() => api('keys', { key }))
      }

      if (error && !state) {
        return h('p', { style: { ...S.sub, color: 'var(--dsh-danger, #e03131)' } }, `key 池读取失败：${error}`)
      }
      if (!state) return h('p', { style: S.sub }, '加载中…')

      const keys = state.keys ?? []
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { style: { ...S.row, alignItems: 'center' } },
          h('span', { style: S.h2 }, 'key 池'),
          pill(`${keys.length} 个`, '#4f7cff'),
        ),
        h('div', { style: S.row },
          h('input', {
            style: { ...S.input, ...S.grow },
            placeholder: '粘贴 API Key，回车添加（可放多个账号轮换）',
            value: newKey,
            onChange: (e) => setNewKey(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') addKey() },
          }),
          h('button', { style: S.btnPrimary, disabled: busy, onClick: addKey }, '添加'),
          h('button', { style: S.btnGhost, disabled: busy, onClick: () => run(() => api('reset', {})) }, '全部解封'),
        ),
        keys.length === 0
          ? h('p', { style: S.empty }, '还没有 key —— 在上面粘贴一个开始。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            keys.map((key) => h('div', {
              key: key.full,
              style: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 7, background: 'rgba(128,128,128,.08)' },
            },
              h('span', { style: { ...S.mono, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, key.mask),
              key.current ? pill('使用中', '#37b24d') : null,
              key.banned ? pill('已拉黑', '#e03131') : null,
              !key.banned && key.cooling > 0 ? pill(`冷却 ${Math.ceil(key.cooling / 1000)}s`, '#f08c00') : null,
              !key.banned && key.cooling === 0 && key.failures > 0 ? pill(`失败 ${key.failures} 次`, '#f08c00') : null,
              h('button', {
                style: { ...S.btnGhost, color: 'var(--dsh-danger,#e03131)' },
                disabled: busy,
                onClick: () => run(() => api('keys/remove', { key: key.full })),
              }, '删除'),
            )),
          ),
        compact ? null : h('p', { style: S.hint }, '上游返回 401 / 402 / 429 时，插件会自动冷却当前 key、换下一个并重发当前请求。池里只有一个 key 时没有轮换可言。'),
        error ? h('p', { style: { ...S.sub, color: 'var(--dsh-danger, #e03131)' } }, error) : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* 模型编辑                                                            */
    /* ------------------------------------------------------------------ */

    const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

    /** 编辑副本 → profile 里的模型条目（和网页版同一套规则）。 */
    function modelsFromDraft(draft) {
      return draft.map((model) => {
        const entry = { id: model.id, name: model.name || model.id }
        if (Number.isInteger(model.contextWindow) && model.contextWindow > 0) entry.contextWindow = model.contextWindow
        if (Number.isInteger(model.maxTokens) && model.maxTokens > 0) entry.maxTokens = model.maxTokens
        if (Array.isArray(model.input) && model.input.length > 0) entry.input = [...model.input]
        if (model.reasoning.none) {
          entry.reasoningEfforts = false
        } else if (model.reasoning.levels.length > 0) {
          const efforts = {}
          for (const level of model.reasoning.levels) efforts[level] = level
          if (model.reasoning.levels.length > 1 || !model.reasoning.levels.includes('off')) efforts.off = null
          entry.reasoningEfforts = efforts
        }
        return entry
      })
    }

    function draftFrom(models) {
      return (models ?? []).map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        contextWindow: model.contextWindow ?? '',
        maxTokens: model.maxTokens ?? '',
        input: Array.isArray(model.input) && model.input.length > 0 ? [...model.input] : ['text'],
        reasoning: model.reasoningEfforts === false
          ? { none: true }
          : { none: false, levels: Object.keys(model.reasoningEfforts ?? {}) },
      }))
    }

    function ModelEditor({ models, onSave, disabled }) {
      const [draft, setDraft] = useState(() => draftFrom(models))
      useEffect(() => { setDraft(draftFrom(models)) }, [models])
      const patch = (index, changes) => setDraft((list) => list.map((model, i) => (i === index ? { ...model, ...changes } : model)))

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        draft.map((model, index) => h('div', {
          key: index,
          style: { border: '1px solid var(--dsh-border, rgba(128,128,128,.25))', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 },
        },
          h('div', { style: S.row },
            h('input', {
              style: { ...S.input, ...S.grow }, placeholder: '模型 id', value: model.id,
              onChange: (e) => patch(index, { id: e.target.value }),
            }),
            h('input', {
              style: { ...S.input, ...S.grow }, placeholder: '显示名称', value: model.name,
              onChange: (e) => patch(index, { name: e.target.value }),
            }),
            h('button', {
              style: { ...S.btnGhost, color: 'var(--dsh-danger,#e03131)' },
              onClick: () => setDraft((list) => list.filter((_, i) => i !== index)),
            }, '删除'),
          ),
          h('div', { style: S.row },
            h('span', { style: { fontSize: 11, opacity: 0.6 } }, '上下文'),
            h('input', {
              style: { ...S.input, width: 110 }, placeholder: '默认', value: String(model.contextWindow),
              onChange: (e) => patch(index, { contextWindow: e.target.value === '' ? '' : Number(e.target.value) }),
            }),
            h('span', { style: { fontSize: 11, opacity: 0.6 } }, '输出上限'),
            h('input', {
              style: { ...S.input, width: 110 }, placeholder: '默认', value: String(model.maxTokens),
              onChange: (e) => patch(index, { maxTokens: e.target.value === '' ? '' : Number(e.target.value) }),
            }),
          ),
          h('div', { style: S.row },
            h('span', { style: { fontSize: 11, opacity: 0.6 } }, '输入'),
            ...['text', 'image'].map((modality) => h('label', { key: modality, style: { fontSize: 12, display: 'inline-flex', gap: 4, alignItems: 'center' } },
              h('input', {
                type: 'checkbox',
                checked: model.input.includes(modality),
                onChange: (e) => patch(index, {
                  input: e.target.checked ? [...model.input, modality] : model.input.filter((m) => m !== modality),
                }),
              }),
              modality === 'text' ? '文本' : '图片',
            )),
          ),
          h('div', { style: S.row },
            h('span', { style: { fontSize: 11, opacity: 0.6 } }, '思考强度'),
            h('label', { style: { fontSize: 12, display: 'inline-flex', gap: 4, alignItems: 'center' } },
              h('input', {
                type: 'checkbox',
                checked: model.reasoning.none,
                onChange: (e) => patch(index, { reasoning: { ...model.reasoning, none: e.target.checked } }),
              }),
              '不支持',
            ),
            ...LEVELS.filter((level) => level !== 'off').map((level) => h('label', {
              key: level,
              style: { fontSize: 12, display: 'inline-flex', gap: 4, alignItems: 'center' },
            },
              h('input', {
                type: 'checkbox',
                disabled: model.reasoning.none,
                checked: !model.reasoning.none && model.reasoning.levels.includes(level),
                onChange: (e) => patch(index, {
                  reasoning: {
                    ...model.reasoning,
                    levels: e.target.checked
                      ? [...model.reasoning.levels, level]
                      : model.reasoning.levels.filter((l) => l !== level),
                  },
                }),
              }),
              level,
            )),
          ),
        )),
        h('div', { style: S.row },
          h('button', {
            style: S.btn,
            onClick: () => setDraft((list) => [...list, { id: '', name: '', contextWindow: '', maxTokens: '', input: ['text'], reasoning: { none: false, levels: [] } }]),
          }, '添加模型'),
          h('button', {
            style: S.btnPrimary,
            disabled,
            onClick: () => onSave(modelsFromDraft(draft).filter((model) => model.id.trim().length > 0)),
          }, '保存模型配置'),
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 设置分区：ag 渠道                                                    */
    /* ------------------------------------------------------------------ */

    function AgChannelSettings() {
      const [state, error, load] = useAgState()
      const [busy, setBusy] = useState(false)

      const run = useCallback(async (fn) => {
        setBusy(true)
        try { await fn(); await load() } catch (e) { /* load 里的 error 会显示 */ } finally { setBusy(false) }
      }, [load])

      if (error && !state) {
        return h('div', { style: S.page },
          h('p', { style: { ...S.sub, color: 'var(--dsh-danger, #e03131)' } }, `读取失败：${error}`),
        )
      }
      if (!state) return h('div', { style: S.page }, h('p', { style: S.sub }, '加载中…'))

      return h('div', { style: S.page },
        h('div', { style: S.card },
          h('h2', { style: S.h2 }, '渠道'),
          h('div', { style: S.row },
            h('button', {
              style: { ...S.btn, ...(state.preset === 'ps' ? { borderColor: 'var(--dsh-accent,#4f7cff)' } : {}) },
              disabled: busy,
              onClick: () => run(() => api('url', { url: 'ps' })),
            }, 'ps.air-outer.com'),
            h('button', {
              style: { ...S.btn, ...(state.preset === 'agentrouter' ? { borderColor: 'var(--dsh-accent,#4f7cff)' } : {}) },
              disabled: busy,
              onClick: () => run(() => api('url', { url: 'agentrouter' })),
            }, 'agentrouter.org'),
          ),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12 } },
            h('span', { style: { opacity: 0.65 } }, '实际请求'),
            h('span', { style: S.mono }, state.requestUrl),
            h('span', { style: { opacity: 0.65 } }, '请求头'),
            h('span', { style: S.mono }, JSON.stringify(state.headers)),
          ),
          h('p', { style: S.hint }, '两个地址任意一个都能用；主地址连不上时插件会自动换另一个。'),
        ),

        h('div', { style: S.card }, h(KeyPoolWidget, {})),

        h('div', { style: S.card },
          h('h2', { style: S.h2 }, '模型'),
          h('p', { style: S.hint }, '这里改的和「设置 → 模型」里编辑 ag 是同一份 profile 配置，两边实时同步。'),
          h(ModelEditor, {
            models: state.models,
            disabled: busy,
            onSave: (models) => run(() => api('models', { models })),
          }),
        ),

        error ? h('p', { style: { ...S.sub, color: 'var(--dsh-danger, #e03131)' } }, error) : null,
      )
    }

    /* ------------------------------------------------------------------ */
    /* 模型页里的托管渠道卡片：多 key 池                                    */
    /* ------------------------------------------------------------------ */

    /** 这张卡片对应的路由 id（Models 页给的是条目，id 在 provider / settingsPath 里）。 */
    function routeIdOf(entry) {
      if (entry === null || entry === undefined || typeof entry !== 'object') return undefined
      if (typeof entry.provider === 'string' && entry.provider.length > 0) return entry.provider
      if (Array.isArray(entry.settingsPath) && typeof entry.settingsPath[1] === 'string') return entry.settingsPath[1]
      return undefined
    }

    function AgProviderCard(props) {
      const [state] = useAgState()
      const id = routeIdOf(props?.provider)
      // 托管哪些路由由宿主按 URL 判定（不写死名字），这里只对照名单
      if (!state || !id) return null
      const managed = state.managedIds ?? []
      if (!managed.includes(id)) return null
      return h('div', {
        style: {
          marginTop: 12, padding: 12, borderRadius: 10,
          border: '1px solid var(--dsh-border, rgba(128,128,128,.25))',
          display: 'flex', flexDirection: 'column', gap: 8,
        },
      },
        h('p', { style: { ...S.hint, margin: 0 } },
          `渠道 ${id} 的 key 池：在这里加多个 key，某个 key 没额度时会自动切下一个并重发当前请求。`),
        h(KeyPoolWidget, { compact: true }),
      )
    }

    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      // 模型页里 ag 这个 provider 的卡片（多 key 池）
      ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register(
        {
          name: 'settings.models.provider-card',
          id: 'ag-channel-key-pool',
          order: 50,
        },
        AgProviderCard,
      ))

      // 独立分区：设置 → ag 渠道
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: 'ag-channel',
          order: 43,
          label: () => 'ag 渠道',
        },
        AgChannelSettings,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-ag-channel-client'
    return module.exports
  },
})
