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
| routing | normalizePolicy normalizeRouting routingFingerprint migrateStoredRouting classes forwardPlan entryPlan bypassPlan | 占位 |
| groups | normalizeGroups builtinTags emitGroups | 占位 |
| config | configDetailed | 占位 |
| authz | checkActivationCode activationState authorizationState | 已实现(一律解锁) |

## 目录
- `cmd/openbox-core/` 入口与方法注册
- `internal/protocol/` 协议、hello、大小限制
- `internal/{routing,groups,config,authz}/` 各类方法
- `testdata/` 金标准:同一份输入喂旧版 Node 实现(backup 分支)得到的输出
- `scripts/` 构建脚本
- `singbox/` 预留

## 构建
    sh core/scripts/build.sh amd64 out    # 或 arm64;产出 out/openbox-core 和 out/core-build.json
