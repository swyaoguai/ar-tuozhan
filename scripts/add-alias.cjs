/**
 * 给 index.js 加 key 别名支持（幂等：重复跑不会重复插入）。
 *
 * 已完成使命保留作记录；实际的别名注入已在 0.13.0 落地。
 */
const fs = require('fs')
const p = 'D:/ar-tuozhan/index.js'
let c = fs.readFileSync(p, 'utf8')
let ok = 0
const fail = []

function sub(name, pattern, replacement) {
  if (!pattern.test(c)) { fail.push(name); return }
  c = c.replace(pattern, replacement)
  ok += 1
}

const EOL = '\\r?\\n'

// 1) stateSnapshot 带别名
sub('snapshot',
  new RegExp(`( {8}mask: key\\.key,${EOL} {8}full: key\\.full,${EOL})`),
  `$1        alias: state.aliases?.[key.full] ?? '',\r\n`)

// 2) api/keys/alias 端点（插在 keys/current 之前）
sub('alias-endpoint',
  new RegExp(`( {8}if \\(req\\.method === 'POST' && sub === 'api/keys/current'\\) \\{)`),
  [
    "        if (req.method === 'POST' && sub === 'api/keys/alias') {",
    "          const body = JSON.parse((await readBody(req)) || '{}')",
    "          const key = typeof body.key === 'string' ? body.key : ''",
    "          const alias = typeof body.alias === 'string' ? body.alias.trim().slice(0, 40) : ''",
    "          if (!arKeys().includes(key)) { sendJson(res, 400, { ok: false, error: '池里没有这个 key' }); return }",
    "          if (!state.aliases || typeof state.aliases !== 'object') state.aliases = {}",
    "          if (alias === '') delete state.aliases[key]",
    "          else state.aliases[key] = alias",
    "          writeState(home, state)",
    "          sendJson(res, 200, stateSnapshot())",
    "          return",
    "        }",
    "$1",
  ].join('\r\n'))

// 3) 删 key 时清掉别名
sub('remove-cleanup',
  new RegExp(`( {10}state\\.keys = keys${EOL})( {10}engine\\.pools = \\[arPool\\(\\), \\.\\.\\.genericPools\\(\\)\\]${EOL})`),
  `$1          if (state.aliases && typeof state.aliases === 'object') delete state.aliases[removed]\r\n$2`)

// 4) remove 端点记下被删的 key（前面的 indexOf 那行改名）
sub('remove-named',
  new RegExp(`( {10}const removed = typeof body\\.key === 'string' \\? body\\.key : ''${EOL})`),
  `$1`)

// 5) status 输出带别名
sub('status',
  new RegExp(`( {10}lines\\.push\\(\`  \\$\\{key\\.key\\}\\$)`),
  `          const alias = state.aliases?.[key.full] ?? ''\r\n$1`)

fs.writeFileSync(p, c, 'utf8')
console.log('成功:', ok, ' 失败:', fail.join('、') || '无')
