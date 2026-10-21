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
| routing | normalizePolicy normalizeRouting routingFingerprint migrateStoredRouting classes forwardPlan bypassPlan | 已实现(对照旧 Node 的金标准测试) |
| routing | entryPlan | 已实现 blacklist 模式(旧代码里没有对照;whitelist 暂不做) |
| groups | normalizeGroups builtinTags emitGroups | 已实现(对照旧 Node 的金标准测试,含逐字节键序) |
| config | configDetailed | 占位(正在分阶段拆解,见下) |
| authz | checkActivationCode activationState authorizationState | 已实现(一律解锁) |

## 目录
- `cmd/openbox-core/` 入口与方法注册
- `internal/protocol/` 协议、hello、大小限制
- `internal/{routing,groups,config,authz}/` 各类方法
- `internal/emit/` 节点 → sing-box 出站 / endpoint
- `internal/ipx/` Node 同款 isIPv4/isIPv6 正则 + CIDR 运算(解析、重叠、包含、挖洞)
- `internal/clientroutes/` 终端分流;`internal/servers/` 共享网络服务端入站;`internal/directhosts/` 订阅和节点站点直连;
  `internal/dnsrewrite/` DNS 重写;`internal/idna/` 域名转 punycode
- `internal/leafgolden/` 只有测试:上面几个叶子包统一对照旧实现的金标准
- `internal/jsx/` 复刻旧 Node 实现用到的 JS 语义(Number() 转换、trim、undefined 与 null 的区别)
- `testdata/` 金标准:同一份输入喂旧版 Node 实现(backup 分支)得到的输出;
  `gen-golden.mjs`、`gen-plans-golden.mjs`、`gen-groups-golden.mjs`、`gen-emit-golden.mjs`、`gen-leaf-golden.mjs`、`gen-dns-golden.mjs`、`gen-route-golden.mjs` 可重新生成(用法见脚本开头注释)
- `scripts/` 构建脚本
- `singbox/` 预留

## 对照基准(基线)
以 catch-up-upstream 分支 `panel/server/engine/` 里的明文源码为准(v0.1.318 快照,提交 0c9d530;它不随同步更新,
`index.mjs` 里压缩的 v0.1.342 只做增量核对)。早先的金标准是用 backup 分支(9 月 13 日)的旧版生成的,正在逐个模块改用新基线重新生成。
已按新基线对齐:clientroutes(终端分流的 match / admit)、emit(http 出站、hysteria2 端口跳跃、detour、ws 的 alpn 限制)、groups(手动页签、可接受状态码、链式节点不进动态组、静态组可选内置直连/拒绝)。routing 的模型、迁移、指纹和 plans(classes、forwardPlan、bypassPlan、entryPlan 含 whitelist;备注、随包规则库缺失规则集的过滤、LEGACY 字段、指纹排除 default / notes)。
**尚未对齐**:`routing/dns.go`、`routing/route.go`(还是按 backup 旧版移植的,金标准测试已暂时跳过;上游 dns.mjs 多了上游 DNS 备用、按终端答解析、
HTTPS 记录规则、规则归属表等,routing.mjs 改成「IP 只管 IP、域名只管域名」)。pre_resolve / rulesets.go / urlhost.go 同理待核。
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
  - dnsfilter:**已完成**
  - dns(`routing/dns.go`,对应旧 dns.mjs 的 buildDnsWithResolvers)及它用到的规则集函数
    (`routing/rulesets.go`:routeRulesetTags / dnsRulesetTags / policyOutboundOptions / splitRuleSetConditions)、
    `routing/urlhost.go`(extractHost:按 WHATWG 规则取 `new URL().hostname`,对 Node 做过两万条差分):**已完成**,
    金标准 `testdata/dns_golden.json`(`gen-dns-golden.mjs` 生成),做过变异测试
  - routing(`routing/route.go`,对应旧 routing.mjs 的 buildRoute):**已完成**,金标准 `testdata/route_golden.json`
    (`gen-route-golden.mjs` 生成),做过变异测试。旧文件里的 preResolveRules 正式生成不启用(config.mjs 不传 resolvers),没有移植
- 阶段 C:buildConfig 装配(阶段 B 的零件已齐),以及新增字段和 dnsRuleOwners
- 阶段 D:旧 JS 金标准 + 真实 sing-box 1.13.14 `check` + 对照 templates/reference-1.13.14.json
