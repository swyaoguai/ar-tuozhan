const fs = require('fs')
const path = require('path')
const https = require('https')
const cred = fs.readFileSync(path.join(process.env.USERPROFILE, '.git-credentials'), 'utf8')
  .split(/\r?\n/).find((line) => line.includes('github.com'))
const token = /https:\/\/([^:]+):([^@]+)@github\.com/.exec(cred)[2]
const owner = 'swyaoguai', repo = 'ar-tuozhan'

function api(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = https.request({
      hostname: 'api.github.com', path: endpoint, method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-push', 'Content-Type': 'application/json', 'Content-Length': payload ? Buffer.byteLength(payload) : 0 },
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => res.statusCode >= 300 ? reject(new Error(`${res.statusCode} ${data.slice(0, 200)}`)) : resolve(data ? JSON.parse(data) : null))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

;(async () => {
  const ref = await api('GET', `/repos/${owner}/${repo}/git/ref/heads/main`)
  const headSha = ref.object.sha
  const commit = await api('GET', `/repos/${owner}/${repo}/git/commits/${headSha}`)
  console.log('远端 HEAD:', headSha.slice(0, 7))
  const entries = []
  // 0.13.1 tgz
  const buf = fs.readFileSync('D:/ar-tuozhan/ar-tuozhan-0.13.1.tgz')
  const blob = await api('POST', `/repos/${owner}/${repo}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' })
  entries.push({ path: 'ar-tuozhan-0.13.1.tgz', mode: '100644', type: 'blob', sha: blob.sha })
  // 删 0.12.0 tgz（0.13.0 时删除失败留下的）
  entries.push({ path: 'ar-tuozhan-0.12.0.tgz', mode: '100644', type: 'commit', sha: null })
  const tree = await api('POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: commit.tree.sha, tree: entries })
  const newCommit = await api('POST', `/repos/${owner}/${repo}/git/commits`, {
    message: 'chore: 补上 0.13.1 tgz（白屏修复版），清理 0.12.0 tgz',
    tree: tree.sha, parents: [headSha],
  })
  await api('PATCH', `/repos/${owner}/${repo}/git/refs/heads/main`, { sha: newCommit.sha })
  console.log('已推送:', newCommit.sha)
})().catch((e) => { console.error('失败:', e.message); process.exit(1) })
