// 面板监听的端口只有一个来源:环境变量 PORT —— init 脚本(openwrt/initd/openbox-panel)从
// data/panel-port 读出来塞进去,没有那个文件就是 2026(v0.1.216 及更早装的机器都没有,
// 它们必须继续用 2026,不能跟着新默认值 3036 搬家)。
//
// 端口从 v0.1.217 起可改(装机时可选、LuCI 页面的「修改端口」、open-box port),所以凡是要
// 用到"面板端口"的地方都走这里,别再各写一个 2026:防火墙放行规则写错端口 = 局域网打不开面板,
// 保留端口列表写错 = 用户能把共享网络的服务器开在面板端口上,自己把面板顶掉。
export const PANEL_PORT_FALLBACK = 2026

// globalThis.process:engine/servers.mjs 引了它,那套代码也打进 App(client-engine,QuickJS 里没有 process),在那边就是回落值
export const panelPort = () => {
  const n = Number(globalThis.process?.env?.PORT)
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : PANEL_PORT_FALLBACK
}
