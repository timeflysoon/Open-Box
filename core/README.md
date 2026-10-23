# core/ — 自己维护的 openbox-core(开源 Go 实现)

替换上游闭源的 `panel/server/native/openbox-core`。它是一个**无状态**的 stdin/stdout JSON 程序,
由面板的 Node 服务端每次调用时拉起,**不是服务**:HTTP API、订阅解析、部署回滚、服务控制都仍在 Node。

## 协议
- stdin:`{"protocol":1,"method":"...","args":[...],"license":"...","geoTags":[...]}`
- stdout:`{"protocol":1,"ok":true,"value":...}` 或 `{"protocol":1,"ok":false,"error":"..."}`
- 退出码恒为 0;输入上限 32 MiB,输出上限 64 MiB;`license` 字段忽略(没有激活机制)
- 第一次调用先发 `hello`,返回 `implementation:"go-native"`、`protocol:1`、`buildID`;
  `buildID` 必须等于 Node 里写死的期望值(构建脚本从 `panel/server/index.mjs` 读出并注入)

## 方法(共 15 个 + hello)
| 包 | 方法 | 状态 |
|---|---|---|
| routing | normalizePolicy normalizeRouting routingFingerprint migrateStoredRouting classes forwardPlan bypassPlan | 已实现(对照基线的金标准测试) |
| routing | entryPlan | 已实现(含 whitelist,按基线 entryModePlan 对齐) |
| groups | normalizeGroups builtinTags emitGroups | 已实现(对照基线的金标准测试,含逐字节键序) |
| config | configDetailed | 已实现(对照基线 engine/config.mjs 的 buildConfigDetailed 的金标准测试 + 官方 sing-box check,见下) |
| authz | checkActivationCode activationState authorizationState | 已实现(一律解锁) |

## 目录
- `cmd/openbox-core/` 入口与方法注册
- `internal/protocol/` 协议、hello、大小限制
- `internal/{routing,groups,config,authz}/` 各类方法;`internal/config/` 是 configDetailed 的装配(`build.go`)和链式代理核对(`chain.go`),以及 node-dns / tun-options / 常量
- `internal/emit/` 节点 → sing-box 出站 / endpoint
- `internal/ipx/` Node 同款 isIPv4/isIPv6 正则 + CIDR 运算(解析、重叠、包含、挖洞)
- `internal/clientroutes/` 终端分流;`internal/servers/` 共享网络服务端入站;`internal/directhosts/` 订阅和节点站点直连;
  `internal/dnsrewrite/` DNS 重写;`internal/idna/` 域名转 punycode;`internal/urlx/` 按 WHATWG 规则取 `new URL(x).hostname`
- `internal/leafgolden/` 只有测试:上面几个叶子包统一对照基线的金标准
- `internal/jsx/` 复刻旧 Node 实现用到的 JS 语义(Number() 转换、trim、undefined 与 null 的区别)
- `testdata/` 金标准:同一份输入喂基线(engine 明文;urlx 用 Node 内置的 URL)得到的输出;
  `gen-golden.mjs`、`gen-plans-golden.mjs`、`gen-groups-golden.mjs`、`gen-emit-golden.mjs`、`gen-leaf-golden.mjs`、`gen-dnsfilter-golden.mjs`、`gen-dns-golden.mjs`、`gen-route-golden.mjs`、`gen-urlx-golden.mjs` 可重新生成(用法见脚本开头注释)。
  基线的 `panel/server/engine/` 已不在当前分支(同步提交把 server 换掉了),要从 tag 里取:`git archive engine-snapshot panel/server/engine panel/server/system/panel-port.mjs | tar -x -C <临时目录>`(servers.mjs 引了 system/panel-port.mjs),`<临时目录>/panel/server/` 下补一个 `{"type":"module"}` 的 package.json
- `scripts/` 构建脚本
- `singbox/` 预留

## 对照基准(基线)
以 catch-up-upstream 分支 `panel/server/engine/` 里的明文源码为准(v0.1.318 快照,提交 0c9d530;它不随同步更新,
`index.mjs` 里压缩的 v0.1.342 只做增量核对)。
已按新基线对齐:clientroutes(终端分流的 match / admit,以及 dns 用的 SourceMatch / TerminalDNSRedirected)、emit(http 出站、hysteria2 端口跳跃、detour、ws 的 alpn 限制)、groups(手动页签、可接受状态码、链式节点不进动态组、静态组可选内置直连/拒绝)。routing 的模型、迁移、指纹和 plans(classes、forwardPlan、bypassPlan、entryPlan 含 whitelist;备注、随包规则库缺失规则集的过滤、LEGACY 字段、指纹排除 default / notes)。
**dns**(`routing/dns.go`,对应 dns.mjs 的 buildDnsWithResolvers)及它的两个叶子模块 `routing/dnsupstream.go`(对应 dns-upstream.mjs:上游 DNS 记号 wan、直连 / 代理上游与备用上游、端口协议、`dnsServerEntry`)、
`routing/flip.go`(对应 flip.mjs:热切换开关 tag、`andRule`、`flipFlagMap`、占位规则集):备用上游并发竞速、站点集 / 兜底的热切换成对规则、按终端答解析(dns-terminal-direct)、
HTTPS / SVCB 空应答、dnsmasq 模式本地主机名、FakeIP(198.19.0.0/16)、IPv6 分层、规则归属表 `ruleOwners`。金标准 `testdata/dns_golden.json` 已换成新基线生成。
只有 Node 进程用、不属于 core 的没有移植:dns-upstream 的 regionDnsDefaults / regionDnsError、dns 的 directResolverServers / applyProxyUpstreamRoutes / dnsPolicyClasses、flip 的 flattenFlipRule。
**route**(`routing/route.go`,对应 routing.mjs 的 buildRoute 和 preMatchBypassRules):路由规则包热切换开关(v6 / QUIC 拒绝恒定成对写,挂在站点集 / 兜底的开关上)、
「IP 只管 IP、域名只管域名」(按 IP 判的那份规则带 `domain_regex` 的「连接没有域名」前提,前置自定义分流的规则集链接拆成域名 / IP 两条)、屏蔽 QUIC(UDP 443 reject)、
首包预判放行(bypass,排在 sniff 前面)、名单外终端的专用 DNS 入站、NTP 对时直连、订阅和节点站点直连的两份本地规则集、终端分流按 MAC 匹配。金标准 `testdata/route_golden.json` 已换成新基线生成。
没移植:preResolveRules(正式生成不启用,config.mjs 不传 resolvers,所以 buildRoute 也没有 resolvers 入参)。
`rulesets.go`(routeRulesetTags / dnsRulesetTags / policyOutboundOptions / splitRuleSetConditions)和 `urlhost.go`(extractHost,主机解析在 `internal/urlx`)已对 v0.1.318 的 routing-model.mjs 逐条核过,dns 的金标准里也覆盖到了。
**叶子模块**(ipx 对应 cidr.mjs、servers、directhosts、dnsrewrite、clientroutes)和 **dnsfilter**:用基线重新生成金标准,与此前提交的逐字节相同(dnsfilter)/ 逐条相同(叶子,0 条不一致),已确认和基线一致;
生成脚本现在直接读基线(ipx 用 cidr.mjs,不再用 backup 的 local-subnets.mjs)。directhosts 补了 config 装配要用的导出(`SharedCdnCidrs` / `IsSharedCdnCidr` / `NodeDirect*` 标签、占位值、`NodeDirectRuleSets`),
金标准里加了 300 条 isSharedCdnCidr 和约 50 种奇怪写法的订阅链接(0x7f.1、反斜杠、userinfo、非法 punycode、端口越界等)。nodeDirectSources 只有 client-build 用,没有移植。
**urlx**(`internal/urlx`,从 `routing/urlhost.go` 抽出,directhosts 订阅链接主机、dns 的 extractHost、dnsupstream 共用):金标准 `testdata/urlx_golden.json`(4000 条,Node 内置 URL 当标准答案),
另对 Node 做过 10 万条随机差分(语料避开下面的已知缺口)0 条不一致;当时的变异测试 28 个抓到 24 个,存活的 4 个是等价变异(空变异、IPv4 超长被末段上限覆盖、域名已小写所以 0X 到不了、punycode 溢出保护在 64 位下被后面的码点上限覆盖)。之后 xn-- 校验按 Node 实测改过一次(解出来只有 ASCII 的如 xn--a- 照收),该规则的变异测试没有重跑。
**urlx.Parse**(`internal/urlx/parse.go`):除主机外还给出用户名 / 密码 / 端口(缺省端口省掉)/ 路径(点段、百分号编码)/ 查询 / 片段,供 node-dns 的 DoH 地址解析用。金标准 `testdata/urlx_parts_golden.json`(3000 条,`gen-urlx-parts-golden.mjs` 生成),对 Node 另做过 10 万条随机差分 0 条不一致;变异测试 29 个抓到 25 个,存活 4 个都是等价变异或不支持项(空变异、前导零端口(digits 已去零)、路径编码集里的 `?`(切路径前已按查询分隔)、file 协议的权威部分(file 只填 Scheme / Hostname,DoH 只收 https))。非特殊协议下点段吃光路径时序列化成空串(Node 实测),特殊协议补 `/`。
**urlx / idna 的已知缺口**:没有 UTS46 字符映射表和双向规则。把这类字符(ﬁ、ǆ、ẞ、²、软连字符、零宽字符、希伯来字母混拉丁字母)放进随机语料(`gen-urlx-golden.mjs --wide`)约 3.7% 的条数与 Node 不一致,
表现是:Node 会映射或拒绝的写法 Go 放行并按原字符编码。实际影响只是订阅链接 / 上游地址里出现这种主机名时「站点直连」多收或漏收一个域名;补齐需要引入 Unicode 表(见 idna 包注释),目前没做。
**configDetailed**(`internal/config/build.go`,对应基线 `engine/config.mjs` 的 buildConfigDetailed,按原文件顺序逐段移植):
订阅和节点站点直连、链式节点并表、节点组 / 站点集 selector、节点出站与 endpoint、出站重名检查、终端分流、出口类别(v6 / QUIC 拒绝)、域名过滤、dns、route、
tun 入站(排除表挖洞、MAC 过滤、dns_mode)、入口原生旁路与热切换动态集、入站(dns-in / 名单外终端 dns-in-direct / 共享网络)、guardTerminalRules、experimental(clash_api / cache_file / FakeIP 缓存)。
返回 `{config, dnsRuleOwners, directHosts, failover}`。入参是新版 Node 发的那一份:基线的解构参数,加 `chainNodes`、`filterExpectedKey`、`platform`、`clientBindings`,`profile.clashApiSecret`。
- **链式代理**:基线的 `chain-proxy.mjs` 自己解析分享链接;新版 Node 在调用前就把候选节点算好当 `chainNodes` 传进来(index.mjs 的 `chainNodes: ze(profile)`),所以核心只移植了「进内核前的核对」(重名 / 上游不存在或是内置直连拒绝 / 成环,`config/chain.go`),没有移植 parseSubscription / parseHttpProxyLink。
- 金标准 `testdata/config_golden.json`(500 条,`gen-config-golden.mjs` 生成):语料随机造节点(8 种协议含 wireguard)、节点组(含故障转移、内置直连拒绝)、站点集、前置自定义分流(含 ipCidr 送节点的挖洞)、终端分流(ip / mac / bypass / admit)、共享网络、订阅(含节点 DNS)、域名过滤、链式代理(含成环)、热切换、FakeIP,并覆盖 hijack / dnsmasq / off 三种 DNS 模式,有 / 无 auto_redirect。
  480 条正常输出逐条相同,20 条报错(出站重名 / 域名过滤名单没准备好)报错文案逐字相同。
- 变异测试 40 个抓到 38 个:漏网的是空变异(预期)和「自定义规则与排除段有无交集」的判断(等价变异:落在排除表之外的洞不影响挖洞结果)。
- **阶段 D**:`testdata/tools/sbcheck.py` 用官方 sing-box 1.13.14 对金标准里的配置跑 `sing-box check`,300 条全过。检查前要剥掉官方版不认的字段(1.14 才有的 `dns_mode` / `dns_address` / `*_mac_address` / `source_mac_address`,以及上游补丁字段 `expected_status`),并把语料里的假 uuid / 密钥 / 证书换成合法值 —— 这是语料和版本差异,不是装配错误。
- **已知缺口**(基线里没有、只能从 Node 消费处推断,没有明文可对照):
  1. `clientBindings`:新版 Node 调 `normalizeClientRoutes(..., {ipv6Bindings})`(IPv6 开着且模式不是 bypass 时带上),核心现在收下但不用,终端分流不按 IPv6 绑定扩展来源。
  2. `platform`(openwrt / systemd / container):基线没有对应逻辑,核心收下不用。
  3. `ignoreProxyClients`(bypassPlan 选项,v0.1.318 之后才有)仍按旧实现保留。
  4. 上游 sing-box 补丁字段(如 urltest 的 `expected_status`)按基线 / groups 对齐的输出写,是否要在官方内核上降级由发布流程决定。
  5. v0.1.318 到当前上游之间 engine 的其余行为变化,仍需用 index.mjs 做一轮增量核对(第四节 4.4 的做法)。
**有明文基线的**之外还有一个已知缺口:`ignoreProxyClients`(bypassPlan 的选项)是 v0.1.318 之后才有的,按旧实现保留,没有明文可对照。
快照 v0.1.318 到上游当前 v0.1.342 之间,engine/ 可能还有行为变化,整体对齐完之后要用 index.mjs 里压缩的版本再做一轮增量核对。

## 构建
    sh core/scripts/build.sh amd64 out    # 或 arm64;产出 out/openbox-core 和 out/core-build.json

## configDetailed 拆解进度
Node 传入 `{platform, cacheFilePath, rulesetDir, selections, tlsCert?, nodes, userGroups, subscriptions, profile, systemDns,
localSubnets, directHostCidrs, ruleLists, nativeBypass, dnsFilter, inlineDirectHosts, chainNodes, filterExpectedKey?}`,
取回 `{config, dnsRuleOwners, directHosts, failover}`(比旧版 buildConfig 多了 platform / rulesetDir / inlineDirectHosts /
chainNodes / dnsRuleOwners,这几项没有旧代码可对照)。

- 阶段 A(叶子模块,有金标准):**已完成**(emit、ipx、clientroutes、servers、directhosts、dnsrewrite)
- 阶段 B:
  - dnsfilter:**已完成**,用基线重新生成金标准与已提交的逐字节相同
  - dns(`routing/dns.go` + `dnsupstream.go` + `flip.go`,对应基线 dns.mjs / dns-upstream.mjs / flip.mjs)及它用到的规则集函数
    (`routing/rulesets.go`:routeRulesetTags / dnsRulesetTags / policyOutboundOptions / splitRuleSetConditions)、
    `routing/urlhost.go`(extractHost,主机解析在 `internal/urlx`):**已按新基线对齐**,
    金标准 `testdata/dns_golden.json`(`gen-dns-golden.mjs` 生成,1000 条 buildDns + upstream / flip / 终端分流判定的直接对照),
    做过变异测试(28 个变异全部被抓到)
  - routing(`routing/route.go`,对应基线 routing.mjs 的 buildRoute / preMatchBypassRules;`routing/rulesets.go` 里补了 noDomainGuard / isIPRuleSetTag / policyRouteMatches):**已按新基线对齐**,
    金标准 `testdata/route_golden.json`(`gen-route-golden.mjs` 生成,1000 条 buildRoute + 400 条 preMatchBypassRules;终端分流先过真实的 normalizeClientRoutes),
    做过变异测试(26 个变异全部被抓到)。旧文件里的 preResolveRules 正式生成不启用(config.mjs 不传 resolvers),没有移植
- 阶段 C 的零件(config.mjs 要用、之前 Go 里没有的):
  - `internal/config/tunoptions.go`(tun-options.mjs:TunStack / TunMTU / TunTCPMss / 接口名)、`nodedns.go`(node-dns.mjs:ValidateNodeDNS / NormalizeNodeDNS / NodeDNSServers / PlanNodeDNS / WithNodeResolver)、
    `consts.go`(config.mjs 开头的常量、FlipDirFor、FindDuplicateTag;以及 TUN 排除表 / END_OF_ADDRESS_SPACE 等没有导出、不能直接对照的常量,抄自基线,留给整份配置的金标准验证):
    金标准 `testdata/configparts_golden.json`(`gen-configparts-golden.mjs` 生成,4602 条,直接 import 基线的 tun-options / node-dns / config;基线的 config.mjs 经 chain-proxy → subscription → clash 引了 npm 包 yaml 2.8.2,生成时要在 panel/server 下 npm install),
    变异测试 38 个抓到 35 个,存活 3 个是等价变异(空变异、MTU 为 0 时不特判结果相同、tun 是数组时当空对象结果相同)
  - `internal/clientroutes/sources.go`(client-routes.mjs:BypassSources / AdmitSources / AdmitDNSDirect / GuardTerminalRules / NotShareInbound):金标准并入 `leaf_golden.json`(新增 1188 条,旧用例 3676 条原样不变),变异测试 27 个抓到 26 个(存活的是空变异)
  - 还没做:chain-proxy(依赖 subscription.mjs / sharelink.mjs)、终端 IPv6 绑定(新版才有)、platform / clientBindings(基线没有)
- 阶段 C:buildConfig 装配(阶段 B 的零件基本已齐,见上),以及新增字段和 dnsRuleOwners
- 阶段 D:旧 JS 金标准 + 真实 sing-box 1.13.14 `check` + 对照 templates/reference-1.13.14.json
