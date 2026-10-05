// Open-Box 程序、内核与 Geo 数据统一升级的系统层。
//
// 升级本身交给随包发布的 scripts/update.sh(--detach 后台跑、--cancel 协作式取消、
// /tmp/openbox-update.status 报进度),面板只负责:读版本、探最新版、发起/取消、
// 读进度。这样 LuCI 兜底页和面板用的是同一条升级路径,不会各有一套坑。
export const REPO = 'timeflysoon/Open-Box'
export const UPDATE_MIRRORS = ['', 'https://ghfast.top/', 'https://gh-proxy.com/', 'https://gh.llkk.cc/']

export const parseKeyValues = (text) => {
  const out = {}
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('=')
    if (i === -1) continue
    out[line.slice(0, i)] = line.slice(i + 1)
  }
  return out
}

// 版本号:发布包是 vX.Y.Z,开发部署是 git describe 的 vX.Y.Z-N-gHASH;只比前三段。
export const parseVersion = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
export const compareVersions = (a, b) => {
  const pa = parseVersion(a), pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

export const readMeta = async (ctx, paths) => {
  try {
    const meta = JSON.parse(await ctx.readFile(paths.metaPath))
    return meta && typeof meta === 'object' ? meta : {}
  } catch {
    return {}
  }
}

// 内核自己报的版本号(如 1.14.1-openbox-tcp11);二进制缺失 / 跑不起来就是空串。要起一次内核进程,别放在常被调的接口里
export const readKernelVersion = async (ctx, paths) => {
  try {
    const { code, stdout } = await ctx.exec(paths.singbox, ['version'])
    return code === 0 ? (/version\s+(\S+)/.exec(stdout) || [])[1] || '' : ''
  } catch {
    return ''
  }
}

export const readChannel = async (ctx, paths) => {
  try {
    const [mode, prefix] = (await ctx.readFile(paths.channelPath)).split('\n')
    return { mode: mode === 'mirror' ? 'mirror' : 'direct', prefix: (prefix || '').trim() }
  } catch {
    return { mode: 'direct', prefix: '' }
  }
}

// /tmp/openbox-update.status:pid= stage= bytes= total= message=
// 与 scripts/update.sh 的 write_status 一致。restarting_core 是面板重启之后、内核按新版本
// 重新部署的那一段(约 20 秒):必须算"进行中",否则前端会当升级已结束而提前刷新页面。
const RUNNING_STAGES = new Set(['starting', 'probing', 'downloading', 'verifying', 'extracting', 'committing', 'restarting_core'])
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return Boolean(err && err.code === 'EPERM')
  }
}

export const readUpdateStatus = async (ctx, paths) => {
  let raw = ''
  try { raw = await ctx.readFile(paths.updateStatusPath) } catch { return { stage: '', running: false } }
  const kv = parseKeyValues(raw)
  const num = (v) => (/^\d+$/.test(v || '') ? Number(v) : null)
  return {
    stage: kv.stage || '',
    pid: kv.pid || '',
    bytes: num(kv.bytes),
    total: num(kv.total),
    message: kv.message || '',
    // worker 被 OOM / 断电杀掉时状态文件会永远停在 downloading 之类:pid 已经不在就不算进行中,
    // 否则面板一直 409「已有一次更新在进行中」直到重启路由器
    running: RUNNING_STAGES.has(kv.stage || '') && (!kv.pid || pidAlive(Number(kv.pid))),
  }
}

export const readUpdateLogTail = async (ctx, paths, lines = 30) => {
  try {
    const all = (await ctx.readFile(paths.updateLogPath)).split('\n')
    return all.slice(-lines).join('\n').trim()
  } catch {
    return ''
  }
}

// 发起升级:update.sh --detach 自己 fork 到后台并立刻返回;真正的进度看状态文件。
export const startUpdate = async (ctx, paths, channel = 'auto', { expect = '' } = {}) => {
  const args = [paths.updateScript, '--detach']
  if (channel === 'direct') args.push('--direct')
  else if (channel === 'mirror') args.push('--mirror')
  // 把探到的最新 tag 交给脚本:它据此下载带版本号的资产,并在解包后核对版本,
  // 镜像缓存的旧包过不了这一关(见 update.sh 里 EXPECT_VERSION 的说明)
  if (expect && /^[A-Za-z0-9._-]+$/.test(expect)) args.push('--expect', expect)
  const r = await ctx.exec('sh', args, { timeoutMs: 20_000 })
  return { ok: r.code === 0, code: r.code, output: `${r.stdout}${r.stderr}`.trim() }
}

export const cancelUpdate = async (ctx, paths) => {
  const r = await ctx.exec('sh', [paths.updateScript, '--cancel'], { timeoutMs: 20_000 })
  return { result: (r.stdout || '').trim().split('\n').pop() || 'none' }
}

// 某个 GitHub 仓库的最新 tag:不查 api.github.com(限流、镜像站不代理),而是看
// releases/latest 的 302 跳转指向 /releases/tag/<tag>——几十字节就能拿到 tag。
// sources 是来源前缀顺序('' 直连),依次试到拿到为止。
export const fetchLatestTag = async (fetchImpl, repo, { sources = ['', ...UPDATE_MIRRORS.filter(Boolean)], timeoutMs = 8000 } = {}) => {
  let lastError = ''
  for (const source of sources) {
    const prefix = source && !source.endsWith('/') ? `${source}/` : source
    const url = `${prefix}https://github.com/${repo}/releases/latest`
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let res
      try {
        res = await fetchImpl(url, { method: 'HEAD', redirect: 'manual', signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
      const location = res.headers.get('location') || ''
      let tag = /\/releases\/tag\/([^/?#]+)/.exec(location)?.[1]
      // 有的镜像会把跳转吃掉直接返回落地页:从最终 URL 里再找一次
      if (!tag && res.url) tag = /\/releases\/tag\/([^/?#]+)/.exec(res.url)?.[1]
      if (tag) return { latest: decodeURIComponent(tag), via: prefix || 'direct' }
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  throw new Error(`没能取到最新版本号:${lastError || '所有来源均不可用'}`)
}

// Open-Box 自身的最新版:直连不通就依次试镜像
export const fetchLatestVersion = async (fetchImpl = globalThis.fetch, { mirrors = UPDATE_MIRRORS, timeoutMs = 8000 } = {}) =>
  fetchLatestTag(fetchImpl, REPO, { sources: ['', ...mirrors.filter(Boolean)], timeoutMs })

// 更新日志(用户 2026-10-02:检查到新版时弹窗里列出「更新了什么」,取 Release 说明;只显示最新那一版,最后一行给 Release 列表
// 的链接看其它版本)。先直连 GitHub API 取最新那一版的说明;镜像站不代理 api.github.com(ghfast.top 回 403 Invalid input),
// 直连不通(比如本机内核没真节点、直连 GitHub 被重置)就从各来源取它的 release-notes.md 附件(v0.1.276 起随 Release 上传,
// 和升级包同一批来源:直连 + 镜像)。都取不到 note 为空、带上原因
export const RELEASE_NOTES_ASSET = 'release-notes.md'
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`
const MAX_NOTE_CHARS = 20_000
export const fetchReleaseNote = async (fetchImpl = globalThis.fetch, { latest = '', mirrors = UPDATE_MIRRORS, timeoutMs = 8000 } = {}) => {
  const tag = /^[A-Za-z0-9._-]+$/.test(latest) ? latest : ''
  const base = { url: RELEASES_PAGE }
  if (!tag) return { ...base, note: null, via: '', error: '不知道最新版本号' }
  const get = async (target, init = {}) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetchImpl(target, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
  let apiError = ''
  try {
    const res = await get(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Open-Box' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const r = await res.json()
    if (!r || typeof r !== 'object') throw new Error('GitHub 返回的不是 Release')
    const body = String(r.body || '').slice(0, MAX_NOTE_CHARS).trim()
    return { ...base, note: { version: tag, date: typeof r.published_at === 'string' ? r.published_at : '', body }, via: 'api' }
  } catch (err) {
    apiError = err instanceof Error ? err.message : String(err)
  }
  for (const source of ['', ...mirrors.filter(Boolean)]) {
    const prefix = source && !source.endsWith('/') ? `${source}/` : source
    try {
      const res = await get(`${prefix}https://github.com/${REPO}/releases/download/${tag}/${RELEASE_NOTES_ASSET}`)
      if (!res.ok) continue
      const text = String(await res.text())
      // 镜像出错时可能回 200 的网页:不像 Markdown 的不要
      if (!text.trim() || /^\s*</.test(text)) continue
      return { ...base, note: { version: tag, date: '', body: text.slice(0, MAX_NOTE_CHARS).trim() }, via: prefix || 'direct' }
    } catch {
      // 下一个来源
    }
  }
  return { ...base, note: null, via: '', error: apiError || '所有来源都取不到' }
}

export const readJsonFile = async (ctx, path, fallback = {}) => {
  try { return JSON.parse(await ctx.readFile(path)) } catch { return fallback }
}
export const writeJsonFile = async (ctx, path, data) => {
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (dir) await ctx.mkdirp(dir)
  await ctx.writeFile(path, JSON.stringify(data))
}
