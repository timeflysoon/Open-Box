// tun 接口的几个底层参数(后端设置 → TUN 参数,GitHub #236 #239)。档案 tun.{stack,mtu,tcpMss};生成配置(engine/config.mjs)、
// 入口 nft 表(system/entry-bypass.mjs)和校验(api/profile.mjs)都从这里取值,三处不会各写各的默认
//
// stack:mixed(默认)= TCP 走系统内核栈、其余走用户态,吞吐最高;gvisor = 全部用户态,绕开内核 DNAT 路径——MT6000 这类
//   开着硬件流量卸载的板子,有线口直连大文件坏字节(#236)只能选它;system = 全部系统栈
// mtu:0 = 不写,内核默认(sing-box 是 9000)
// tcpMss:内核自己发出的 TCP 连接(打着 0x2024 标记的)在 SYN 上钳制 MSS;0 = 不钳制。sing-box 没有这个选项,由入口表里
//   一条 nft 规则实现(system/entry-bypass.mjs 的 tcp_mss_out 链)
// 接口名固定、不给设置:生成配置写它(engine/config.mjs),认本机网口时按它把内核自己的 tun 排除在局域网口之外
// (system/local-subnets.mjs)
export const TUN_INTERFACE_NAME = 'openbox-tun'
export const TUN_STACKS = Object.freeze(['mixed', 'gvisor', 'system'])
export const TUN_MTU_MIN = 1280
export const TUN_MTU_MAX = 65535
export const TUN_MSS_MIN = 536
export const TUN_MSS_MAX = 65495

const tun = (profile) => (profile && profile.tun && typeof profile.tun === 'object' ? profile.tun : {})

export const isTunStack = (v) => TUN_STACKS.includes(v)
export const isTunMtu = (v) => v === 0 || (Number.isInteger(v) && v >= TUN_MTU_MIN && v <= TUN_MTU_MAX)
export const isTunMss = (v) => v === 0 || (Number.isInteger(v) && v >= TUN_MSS_MIN && v <= TUN_MSS_MAX)

export const tunStack = (profile) => (isTunStack(tun(profile).stack) ? tun(profile).stack : 'mixed')
export const tunMtu = (profile) => (isTunMtu(tun(profile).mtu) ? tun(profile).mtu : 0)
export const tunTcpMss = (profile) => (isTunMss(tun(profile).tcpMss) ? tun(profile).tcpMss : 0)
