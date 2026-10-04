// 激活(用户 2026-09-29):概览页顶栏默认放站点推广;输入内置的激活码激活之后,顶栏左右两边换成自己填的文字,
// 留空就是默认的「Open-Box 版本号」/「sing-box 版本号」(和推广之前的顶栏一样)。反激活恢复推广。
// 入口是面板的 #/active 页面(不进菜单);状态存在路由器上,换浏览器照样生效,不跟着导出 / 导入走。接口都要登录。
import { createHash, timingSafeEqual } from 'node:crypto'
import express from 'express'
import { readKernelVersion, readMeta } from '../system/updater.mjs'

// 必须带 openbox/ 前缀:浏览器同步设置(PUT /api/storage)只保护这个前缀的键
export const ACTIVATION_KEY = 'openbox/activation'
// 内置激活码只存摘要:装在路由器上的面板代码里翻不出原文
const CODE_SHA256 = Buffer.from('e4741c39641cc20dbe85f5742282b8f9210a0eed8e1b700d562feaf7201e6f13', 'hex')
export const ACTIVATION_TEXT_MAX = 60

const cleanText = (value) => (typeof value === 'string' ? value.trim().slice(0, ACTIVATION_TEXT_MAX) : '')

export const checkActivationCode = (code) =>
  timingSafeEqual(createHash('sha256').update(typeof code === 'string' ? code.trim() : '').digest(), CODE_SHA256)

export const readActivation = (store) => {
  try {
    const raw = JSON.parse(store.getRaw(ACTIVATION_KEY) || 'null')
    if (raw && raw.activated === true) return { activated: true, left: cleanText(raw.left), right: cleanText(raw.right) }
  } catch {
    // 存坏了就当没激活
  }
  return { activated: false, left: '', right: '' }
}

// 两边留空时显示的默认值:Open-Box 版本号、改动过的 sing-box 版本号。都先读 meta.json(和「升级」卡片同一份,
// 每次打开概览都要读,不能每次起一个内核进程);meta.json 里没有内核版本才问内核自己,再读不到就只写 sing-box
export const activationDefaults = async (ctx, paths) => {
  const meta = await readMeta(ctx, paths)
  const version = String(meta.version || '').trim()
  const kernel = String(meta.singboxVersion || '').trim() || await readKernelVersion(ctx, paths)
  return {
    left: version ? `Open-Box ${version.startsWith('v') ? version : `v${version}`}` : 'Open-Box',
    right: kernel ? `sing-box ${kernel}` : 'sing-box',
  }
}

export const registerActivationRoutes = (app, { store, ctx, paths }) => {
  const router = express.Router()
  const save = (left, right) => store.setRaw(ACTIVATION_KEY, JSON.stringify({ activated: true, left: cleanText(left), right: cleanText(right), updatedAt: Date.now() }))
  const respond = async (res) => res.json({ ...readActivation(store), defaults: await activationDefaults(ctx, paths) })

  router.get('/activation', (_req, res) => respond(res))
  // 激活:激活码对了才存,两边的文字一起存
  router.post('/activation', (req, res) => {
    if (!checkActivationCode(req.body?.code)) return res.status(400).json({ error: 'invalid activation code' })
    save(req.body?.left, req.body?.right)
    return respond(res)
  })
  // 已经激活:改两边的文字不用再输激活码
  router.put('/activation', (req, res) => {
    if (!readActivation(store).activated) return res.status(400).json({ error: 'not activated' })
    save(req.body?.left, req.body?.right)
    return respond(res)
  })
  // 反激活
  router.delete('/activation', (_req, res) => {
    store.delRaw(ACTIVATION_KEY)
    return respond(res)
  })
  app.use('/api/openbox', router)
}
