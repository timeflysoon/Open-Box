import express from 'express'

// 故障转移组的运行状态(system/failover-manager.mjs 维护;代理页展示当前主备页签、实际节点、最近切换)
//   GET  /failover/status   所有故障转移组的运行状态
//   POST /failover/refresh  立刻重载映射并重测(部署 / 保存分组后前端可调,不等 interval;正在跑的轮次作废)
//   POST /failover/recheck  { id }:「重新检测」一个组——正在跑的那轮作废,马上把这个组的节点全部强制测一遍(GitHub #514)
export const registerFailoverRoutes = (app, { manager } = {}) => {
  const router = express.Router({ caseSensitive: true })
  router.get('/failover/status', (_req, res) => {
    res.json(manager ? manager.status() : { version: null, paused: 'none', groups: [] })
  })
  router.post('/failover/refresh', (_req, res) => {
    if (manager) manager.refresh()
    res.json({ ok: true })
  })
  router.post('/failover/recheck', express.json({ limit: '4kb' }), (req, res) => {
    const id = req.body && typeof req.body.id === 'string' ? req.body.id : ''
    if (!manager || !id) return res.status(400).json({ error: 'id required' })
    if (!manager.recheck(id)) return res.status(404).json({ error: 'unknown failover group' })
    res.json({ ok: true })
  })
  app.use('/api/openbox', router)
}
