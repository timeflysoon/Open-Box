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
- `internal/emit/` 节点 → sing-box 出站 / endpoint(configDetailed 的第一块,已对照旧实现)
- `internal/jsx/` 复刻旧 Node 实现用到的 JS 语义(Number() 转换、trim、undefined 与 null 的区别)
- `testdata/` 金标准:同一份输入喂旧版 Node 实现(backup 分支)得到的输出;
  `gen-golden.mjs`、`gen-plans-golden.mjs`、`gen-groups-golden.mjs`、`gen-emit-golden.mjs` 可重新生成(用法见脚本开头注释)
- `scripts/` 构建脚本
- `singbox/` 预留

## 构建
    sh core/scripts/build.sh amd64 out    # 或 arm64;产出 out/openbox-core 和 out/core-build.json

## configDetailed 拆解进度
Node 传入 `{platform, cacheFilePath, rulesetDir, selections, tlsCert?, nodes, userGroups, subscriptions, profile, systemDns,
localSubnets, directHostCidrs, ruleLists, nativeBypass, dnsFilter, inlineDirectHosts, chainNodes, filterExpectedKey?}`,
取回 `{config, dnsRuleOwners, directHosts, failover}`(比旧版 buildConfig 多了 platform / rulesetDir / inlineDirectHosts /
chainNodes / dnsRuleOwners,这几项没有旧代码可对照)。

- 阶段 A(叶子模块,有金标准):emit(节点→出站/endpoint)已完成;client-routes、servers、direct-hosts、local-subnets、dns-rewrite 待做
- 阶段 B:dns、dns-filter、routing(buildRoute)、routing-model 里剩余的函数
- 阶段 C:buildConfig 装配,以及新增字段和 dnsRuleOwners
- 阶段 D:旧 JS 金标准 + 真实 sing-box 1.13.14 `check` + 对照 templates/reference-1.13.14.json
