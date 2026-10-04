// platform:'openwrt'(默认)或 'systemd'(Debian / Ubuntu,见 system/platform.mjs)。两种系统上安装布局一样
// (都在 /opt/open-box),只有服务控制脚本和 DHCP 租约表的位置不同。默认值故意不自动探测:测试在哪台机器上跑
// 都得到同一份路径;面板入口(index.mjs)和命令行部署(cli/deploy.mjs)自己传 detectPlatform() 的结果
export const createPaths = (root = '/opt/open-box', { platform = 'openwrt' } = {}) => ({
  root,
  platform,
  bin: `${root}/bin`,
  singbox: `${root}/bin/sing-box`,
  etc: `${root}/etc`,
  configPath: `${root}/etc/config.json`,
  // 进内核之前就放行的端口 / 终端(GitHub #183 #187):部署时生成的 nft 链,init 脚本起内核前装进 inet openbox 表
  // (system/entry-bypass.mjs)
  entryBypassPath: `${root}/etc/entry-bypass.nft`,
  // 共享网络的自签证书(system/tls-keypair.mjs)
  certsDir: `${root}/etc/certs`,
  tlsCert: `${root}/etc/certs/server.crt`,
  tlsKey: `${root}/etc/certs/server.key`,
  dataDir: `${root}/data`,
  rulesetDir: `${root}/data/rulesets`,
  geoDir: `${root}/panel/server/resources/geodata`,
  // 内核的 cache_file:记住各 selector 的选择,重启不丢
  cacheDb: `${root}/data/cache.db`,
  metaPath: `${root}/meta.json`,
  updateScript: `${root}/update.sh`,
  channelPath: `${root}/data/channel`,
  // 和 scripts/update.sh 里 STATUS_PATH / UPDATE_LOG 的默认值一致(TMPDIR 未设置时)
  updateStatusPath: '/tmp/openbox-update.status',
  // dnsmasq 的 DHCP 租约表,每日流量「访问终端」用它把 IP 翻成主机名。OpenWrt 在 /tmp;Debian 装了 dnsmasq 的话
  // 在 /var/lib/misc(没装就没有这个文件,读不到按无名字处理)
  dhcpLeases: platform === 'systemd' ? '/var/lib/misc/dnsmasq.leases' : '/tmp/dhcp.leases',
  updateLogPath: '/tmp/openbox-update.log',
  geoUpdateStatePath: `${root}/data/geo-update.json`,
  scheduleStatePath: `${root}/data/schedule-state.json`,
  // DNS 过滤名单自己的计划状态,避免和 Open-Box / Geo / 订阅调度同时写共享 JSON 时互相覆盖。
  dnsFilterScheduleStatePath: `${root}/data/dns-filter-schedule.json`,
  // 服务控制脚本:面板只用 start / stop / restart / enable / disable / enabled / status 这几个动作(system/service.mjs)。
  // OpenWrt 是 procd 的 init 脚本;Debian 是同样动作集合的 systemctl 包装(debian/bin/openbox-ctl)
  initd: platform === 'systemd'
    ? { core: `${root}/debian/bin/openbox-ctl`, panel: `${root}/debian/bin/openbox-panel-ctl` }
    : { core: '/etc/init.d/openbox', panel: '/etc/init.d/openbox-panel' },
})
