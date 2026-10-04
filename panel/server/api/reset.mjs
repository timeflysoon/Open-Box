import { defaultGroups } from '../engine/user-groups.mjs'
import { loadProfileDefaults } from '../system/seed-defaults.mjs'
import { stopService } from '../system/service.mjs'

// 「恢复默认分流」和「恢复出厂设置」两个破坏性操作。两者都以**随包的初始档案**
// (server/defaults/profile-defaults.json,新装机器写进去的那一份)为准 —— 用户说的"默认 /
// 初始化设置"就是全新装出来的样子,不该另起一套定义。
//
// 「恢复默认分流」只动档案里的 routing。
// 「恢复出厂设置」按用户的要求是**完全回到刚装好的样子**:整张 KV 表清掉(订阅、节点、节点组、
// 目标分流、终端分流、链式代理、共享网络、面板设置、背景图、**面板密码**、登录会话、clash 密钥)
// 加上流量统计,然后按随包默认重新播种(面板设置 + 背景图 + 初始目标分流),内核停掉。
// 也就是说:恢复完打开面板会像第一次那样让你设密码,统计数据从零开始。

// 随包默认档案里的 routing(恢复默认分流用)。没有随包默认时返回 null。
export const defaultRouting = () => {
  const defaults = loadProfileDefaults()
  return defaults && defaults.routing ? defaults.routing : null
}

// 随包默认的节点组(恢复默认用):就是全新安装第一次读取时落地的那两个组 + 内置直连
export const defaultNodeGroups = () => defaultGroups()

export const registerResetRoutes = (app, { ctx, paths, wipeAll = null, log = () => {} } = {}) => {
  // 「恢复默认节点组」:前端拿到这份之后走正常的 PUT /groups 写回(校验、落库不另开一条路)
  app.get('/api/openbox/defaults/groups', (_req, res) => {
    res.json({ groups: defaultNodeGroups() })
  })

  // 「恢复默认分流」:前端拿到这份之后走正常的 PUT /profile 写回去(校验、落库都不另开一条路)
  app.get('/api/openbox/defaults/routing', (_req, res) => {
    const routing = defaultRouting()
    if (!routing) {
      res.status(503).json({ message: '随包的默认档案不可用' })
      return
    }
    res.json({ routing })
  })

  // 「恢复出厂设置」:档案写回随包默认,用户配出来的东西全清,内核停掉。
  app.post('/api/openbox/factory-reset', async (req, res) => {
    const defaults = loadProfileDefaults()
    if (!defaults || typeof wipeAll !== 'function') {
      res.status(503).json({ message: '随包的默认档案不可用,没有恢复出厂设置' })
      return
    }

    // 整张表清掉 + 流量统计清掉 + 按随包默认重新播种(和全新安装第一次启动走同一条路)。
    // 注意不能只写默认档案了事:store.setProfile 是深合并,默认档案里没有的键(终端分流、
    // 链式代理、共享网络……)会原样留下 —— 第一版就是这样,浏览器里实测点完"恢复出厂"
    // 终端分流那条还在,而弹窗明明承诺清掉。
    let seeded = null
    try {
      seeded = wipeAll()
    } catch (error) {
      log(`[reset] 恢复出厂失败:${error?.message || error}`)
      res.status(500).json({ message: `恢复出厂设置失败:${error?.message || error}` })
      return
    }

    // 内核停掉:恢复出厂之后一个节点都没有,让它带着旧配置继续跑只会让人以为"还在代理"
    let kernelStopped = false
    try {
      const r = ctx && paths ? await stopService(ctx, paths.initd.core) : { ok: false }
      kernelStopped = Boolean(r && r.ok)
    } catch (error) {
      log(`[reset] 恢复出厂后停内核失败:${error?.message || error}`)
    }

    log(`[reset] 恢复出厂设置:整表清空并按随包默认重新播种(${seeded?.seeded ?? 0} 项面板设置${seeded?.profile ? ' + 初始目标分流' : ''}),内核${kernelStopped ? '已停止' : '停止失败'}`)
    res.json({ ok: true, seeded: seeded?.seeded ?? 0, profileSeeded: Boolean(seeded?.profile), kernelStopped })
  })
}
