# 界面逐页对齐清单(panel/ 开源面板 vs 上游 panel/dist)

> **基准口径(2026-11-28 维护者定)**:`v0.1.494` 是**固定基准**,全量对齐以它为准、已完成的不再回头重做;
> 今后**只做增量** —— 上游出新版时只看它相对 `v0.1.494` 的差异(新增键 / 接口 / 行为),按需跟进,
> 不重新全量比对。例外 A / B / C 照旧不做,新增同类的也不补。
> 下文各段里的「v0.1.488 / v0.1.492」等是**当时的历史记录**,保留原样。

**比对口径**
- 上游只有编译后的 `panel/dist`(没有源码),基准是这样跑的:把 `catch-up-upstream` 上的 `panel/dist` 用本地静态服务起起来,
  指向真机后端(`192.168.2.5:3036`),与 main 的 dev 页面并排比对。
- 逐页看:布局、组件、文案、交互、图标、顺序;三语(简体 / 繁体 / English)各一遍,浅色 / 深色主题各一遍,桌面 / 窄屏宽度各一遍。
- 与上游不一致且不属于例外 A/B/C 的,按上游对齐。例外 A/B/C 有意保留差异,不改回去(见 backend/HANDOFF.md 第五节)。
- **红线**:不拷贝、不依赖上游压缩后的 `index.mjs`;只依据界面行为与 dist 里的键与结构反推,自己写实现。

**比对方法(2026-11-25 建立,以 DOM 为准)**

截图判断在本任务里误判过两次(把上游每次构建随机生成的标识当成差异、把两个不同后端实例的动态数字当成差异),
所以改成脚本化比对,脚本入库在 `panel/docs/ui-align/compare.mjs`:

- 用 Playwright 对**上游基准页**和 **main dev 页**跑同一段脚本,各自登录(同一密码)、设同一语言与主题,
  提取规范化结构树并 diff:保留标签 / role / 可见文本 / 图标标识 / 顺序 / disabled·checked·折叠状态;
  丢弃哈希 class、`data-v-*`、自动生成 id;数字、时间、流量、延迟、百分比、版本号统一替换成占位符。
- 视觉层再用 `getComputedStyle` 抽 `font-size / color / background-color / padding / margin / gap / display /
  flex-direction / border-radius`,深浅主题各跑一次。抽样取「面积最大的可见元素」,避免抽到侧栏小控件造成假差异。
- 脚本内置例外 A/B/C 白名单(教程按钮、安格超市、DownProm/极速下载、概览顶栏两处文案、业务优选),命中即忽略。
- 用法:`node panel/docs/ui-align/compare.mjs --route '/#/proxies' --lang zh --theme light --width 1440 --login 1111`
  (`--main` / `--base` 可覆盖地址;默认 main `http://127.0.0.1:5180`、基准 `http://127.0.0.1:8802`)。
- 基准跑法:把 `catch-up-upstream` 的 `panel/dist` 用本地静态服务起起来,`/api` 反代到真机 `192.168.2.5:3036`。
  注意上游 dist 的大文件是 `.gz`,静态服务要按 `Content-Encoding: gzip` 提供,否则资源 404、页面白屏。
- Playwright 未随仓库安装,本轮临时用 `pnpm add -D playwright@1.49.1`,复用已有的 Chromium 可执行文件
  (脚本顶部 `UI_ALIGN_CHROME` 可覆盖);**没有导出的 `package.json` 改动**(见下方「遗留」)。

**状态**:`待做` = 还没比过;`有差异待做` = 比过、发现差异还没改;`已对齐` = 比过、一致或差异已修;`有意例外` = 按 A/B/C 故意不同。

## 键集对齐(2026-11-29,v0.1.500 追平中)

本轮从 v0.1.494 基线追到 v0.1.500。480 与 492 的对照记录见正文末尾「早期基线」。

### 批次 1:订阅卡片刷新提示 + 评分刷新四态(已对齐)

- **上游 v0.1.498 变更**:订阅卡片刷新按钮提示由 `refresh` 改为 `refreshSubscription`(「刷新订阅」),
  并移除卡片上的带宽测试按钮。
- **上游 v0.1.500 口径**:评分刷新只发一次提示——排了带宽用 `nodeScoreRefreshQueued`(info),未排用
  `nodeScoreRefreshDone`(success);失败 `nodeScoreRefreshFailed`、拿不到 `nodeScoreRefreshUnavailable`。
  **没有** Sub 前缀的键,也**没有**「排队后轮询队列再补一条完成提示」的二次提示。
- **main 侧改动**:
  - `ProxiesCtrl.tsx`:删掉自造的 `nodeScoreRefreshSubQueued` / `nodeScoreRefreshSubDone` 两个键与
    `watchScoreQueue`(3 分钟轮询补提示),改为按上游单次提示;移除随之不再使用的 `fetchBandwidthStatus` 导入。
  - `SubscriptionCard.vue`:刷新按钮改用 `refreshSubscription`;删除带宽测试按钮及 `useBandwidth` /
    `testSubscriptionBandwidth` / `ChartBarIcon` 三处引用。
  - 三语删除 `nodeScoreRefreshSubQueued` / `nodeScoreRefreshSubDone` / `bandwidthManualTest`。
- **三语文案按上游逐字修正**(双语括号统一单语,对应 v0.1.495 release note):
  `groupType_urltest` / `groupType_selector` / `groupType_loadbalance` / `groupType_failover`、
  `nodeRiskProxy`(zh/zh-tw 去掉「(Proxy)」)、`bandwidthEndpointCloudflare`。
- **新增 12 键三语**:`refreshSubscription`、`outboundNameInvalid`,以及 v0.1.496「指定域名 DNS」的
  `dnsDomainUpstreamSavedRestart` / `dnsDomainUpstreamBadgePendingRestart` / `...BadgeStopped` /
  `...BadgeNoRules` / `...BadgeEnabled` 与 mihomo 路由诊断的 `routeTermKdns*` 5 键。
- **复核**:`cmp-upstream-i18n.py` → 三语各 2432 上游 / 2340 main,**多 0、值不同 0**;
  缺 92 = 例外 C 38 + 系统提示铃铛 `systemAlert*` 54(下一批)。
- **构建**:`npm run build` 通过。

### 批次 2:系统提示铃铛 + 探测压力判据 + 订阅节点同步状态(已对齐)

- **上游 v0.1.499 新增**:「后端设置」顶部工具栏右侧的「系统提示」铃铛(空态禁用淡显;有告警时按最高等级
  着色,右上角数字徽标,>99 显示 99+),点开是高对比度汇总弹窗(标题 `systemAlertsTitle`、
  刷新 / 关闭、空态 `systemAlertsEmpty`、每条含等级徽标 / 对象 / 明细 / 逐项列表 / 建议)。
- **实现方式**:纯前端聚合(`panel/src/composables/systemAlerts.ts`),不新增告警接口——与上游一致。
  输入取已有的服务状态、内核版本、故障转移状态、订阅列表、更新状态。组件
  `panel/src/components/kernel/SystemAlertsDialog.vue`,铃铛挂在 `KernelServiceCard` 的标题行右侧工具组
  (上游该位置在教程按钮之后,main 无教程按钮,故紧邻「恢复出厂设置」)。
- **探测压力按 v0.1.500 口径**:`demandPerSec > throughputPerSec × 1.2` **且** `backlogMs >= 2 分钟` 才告警,
  并跳过内核启动后 5 分钟内的冷启动期。**这需要后端给真实吞吐**——原 `ProbeStats` 注释写着「吞吐没有统计,
  恒为 null」,本批补上:`failover.Manager` 在每次 `probeNode` 完成时记时间戳(3 分钟滑动窗口折算每秒),
  并记「等并发名额」的时长(取最近 1 分钟最大值作 `backlogMs`)。不支持采样的 Runtime 仍给 null(不误报)。
- **订阅节点同步状态**:`systemAlertSubscriptionStale*` 依赖订阅记录上的 `kernelStale`(本订阅有多少节点
  还没进已部署配置)。后端在 `GET /api/openbox/subscriptions` 里现算(不落盘):按当前内核读配置文件、
  解析 `outbounds[].tag` 作为「已在核心里」的集合,与本订阅节点 tag 比对。**不采用 Clash API**——
  内核没在跑时读不到,而「节点没同步进内核」恰恰发生在内核没跟上配置的场景。算不出时省略该字段(不误报)。
- **验证(DOM 之外的端到端)**:本地独立实例(端口 13999、独立 data/etc,不碰真机)实测两向——
  节点未进配置 → `kernelStale: 1`;写回配置后 → 字段不再出现(即 0)。
- **复核**:`cmp-upstream-i18n.py` → 三语各 2432 上游 / 2394 main,**多 0、值不同 0**;
  缺 38 全部是例外 C(`business*` / `bandwidthHelpCurrentBusiness`)。
- **构建**:`vue-tsc --noEmit` 与 `npm run build` 均通过;后端本批涉及的 4 个包(`failover` / `subs` /
  `api/subscriptions` / `cmd`)测试通过,新增 2 个单测覆盖吞吐与积压采样。

### 批次 3:出站名校验 + 评分刷新「未通过」提示(已对齐)

- **`outboundNameInvalid`(上游 v0.1.495 起统一)**:分组名 / 前置分流名会直接当内核里的出站 tag 用,
  `.`、`..`、含 `/` 三种一律拒绝。新增 `panel/src/helper/outboundName.ts`
  (`isInvalidOutboundName`:空名返回 false,交给调用方按各自文案报「请填写名称」),
  并在 `RoutingPoliciesCard.vue` 的「站点集取名」「前置分流取名」两处空名检查之后补判据。
  上游同样用它在链式代理页与订阅分组弹窗上,那两处本轮未动(各自的页面批次处理)。
- **`nodeScoreRefreshUnavailable`**:上一批删掉 3 分钟轮询后这个键失去引用,变成「上游引用、main 未引用」。
  上游的第三种情形是「延迟测完了,但这批节点一个都没进评分表」——此时提示「已刷新节点评分」是假的。
  在 `ProxiesCtrl.tsx` 用具名块补回该分支:任一节点能查到评分才走 Queued/Done,全查不到走 Unavailable(warning)。
  用导出的 `nodeScore(name)` 判断(store 里 `scores` 是模块私有,未导出)。
- **复核**:`cmp-upstream-refs.py` 中 `outboundNameInvalid` 与 `nodeScoreRefreshUnavailable` 不再是缺口。
- **构建**:`vue-tsc --noEmit` 与 `npm run build` 通过。

## 键集对齐(2026-11-26,v0.1.488)

- **基准**:上游 `liandu2024/Open-Box` 已发 **v0.1.488**(2026-11-26T06:17Z)。把 release 包 `open-box-v0.1.488-linux-x64.tar.gz` 解出来当基准
  (上游 git 仓库里没有 `panel/`,只有发布包里有 `panel/dist`)。
- **三语键集**:上游 en / zh / zh-tw 各 **2333** 键,main **2295** 键;**缺 38 全是例外 C**(`business*` 前缀),
  扣除后缺 **0**、多 **0**;值不同只有 `chainProxyEmptyHint`(例外 B)。
- **v0.1.488 新增的 2 个键**(已按上游逐字补三语):`groupToleranceDisabledByScoring`、`failoverAutoLaneRequiredHint`;
  另有 2 条文案改口径:`bandwidthOn_loadbalance`、`bandwidthExample_loadbalance`(负重均摊 → 综合评分择优,先剔除劣质慢节点)。
- **引用**:上游引用而 main 未引用 **50** = 例外 C 28 + 例外 A 19(`comingSoon` / `activation*` / `tutorial*`)+ 例外 B 2;
  真缺口只剩 **1** 个:`kernelVersionLabel`(上游 `KernelPage` 用它拼「内核版本:」,main 内核页用的是另一处写法)——记在内核页那一条,由内核页批次处理。
  main 引用而上游未引用 2 个,仍是 Vue 模板虚警(`manageHiddenGroup` / `customIcon`)。
- 复核命令(基准在仓库外,不入库):
  `gunzip -c <包内 assets>/en-*.js.gz > /tmp/en.js` 后跑
  `python panel/scripts/cmp-upstream-i18n.py /tmp/en.js /tmp/zh.js /tmp/zh-tw.js`;
  引用比对要把 `assets/*.js.gz` 全部解开成 `.js` 再跑 `cmp-upstream-refs.py`(大页面 chunk 只有 gz,不解开会漏一大半引用)。

## 页面清单

| 页面 | 路由 | 上游对应块 | 状态 |
| --- | --- | --- | --- |
| 代理 | `#/proxies` | `ProxiesPage` | 已对齐(**全矩阵 12 组**:三语×深浅×宽窄;内容差异 main 0、结构差异为容器标签语义差、样式仅 2 项可解释噪音) |
| 概览 | `#/overview` | `OverviewPage` | 已对齐(例外 B/C 有意不同) |
| 连接(含日志 / 规则页签) | `#/connections` | `ConnectionWorkspacePage` | 已对齐(DOM 比对,zh/light/1440;连接 / 日志 / 规则三个页签内容 0 / 0、结构 0 / 0) |
| 设置(含订阅 / 分流 / 内核页签) | `#/settings` | `SettingsPage` | 已对齐(DOM 比对,zh/light/1440) |
| 登录 | `#/login` | `LoginPage` | 已对齐(结构一致,见下) |
| 设置访问密码 | `#/setup` | `SetupPasswordPage` | 已对齐 |

## 独立页面组件(在侧栏之外,由页面内入口进入)

| 页面 / 弹窗 | 组件 | 上游对应块 | 状态 |
| --- | --- | --- | --- |
| 链式代理 | `ChainProxiesPage.vue` | `ChainProxyPage` | 已对齐(即设置页 `chain` 页签;例外 B 的安格超市链接不补) |
| 客户端 App | `ClientAppPage.vue` | `ClientAppsPage` | 已对齐(即设置页 `clientApp` 页签) |
| 终端分流 | `ClientRoutingPage.vue` | `ClientRoutingPage` | 已对齐(即设置页 `clients` 页签) |
| DNS | `DnsPage.vue` | `DnsPage` | 已对齐(即设置页 `dns` 页签) |
| 内核 | `KernelPage.vue` | `KernelPage` | 已对齐(即设置页 `kernel` 页签;例外 A/C 不补) |
| 共享网络 | `ShareNetworkPage.vue` | `ShareNetworkPage` | 已对齐(即设置页 `share` 页签) |
| 订阅 | `SubscriptionsPage.vue` | `SubscriptionsPage` | 已对齐(即设置页 `subscriptions` 页签) |
| 分流 | `RoutingPage.vue` | `RoutingPage` | 已对齐(即设置页 `routing` 页签) |

## 已确认与上游一致的结构(2026-11-25 核对)

- 路由结构一致:侧栏 4 个主页面(代理 / 概览 / 连接 / 设置);`logs`、`rules` 并入「连接」页的页签,
  `subscriptions`、`routing`、`kernel` 并入「设置」页的一级页签,老路由保留为重定向——与上游 dist 里的跳转结构一致。
- 三语文案键集一致(上游 2331 / main 2293,缺 38 全属例外 C),引用一致(真缺口 0)。

## 进度日志

- 2026-11-27 **全矩阵复跑尝试受阻(密码不可用,属环境限制)**:按任务书要跑「三语 × 深浅 × 宽窄 = 12 组」,
  已把两个服务起好(main dev `127.0.0.1:5180`、上游 dist 静态代理 `127.0.0.1:8905` → 真机后端 `192.168.2.5:3036`),
  但比对脚本登录失败:**文档记录的 `--login 1111` 在这台设备上已失效**——设备 11-27 换成自研后端时沿用了官方面板的密码,
  我没有该密码,也不去猜(连续试错已触发 `ACCESS_PASSWORD_LOCKED` 限速)。
  **为什么不用空数据的独立实例代替**:比对脚本会提取卡片 / 按钮 / 输入框的结构与计算样式,
  空数据下页面会落到空状态分支(没有节点卡片、没有分组、没有连接行),结构与真实页面不同,得出的「一致」是假结论。
  **要跑完 12 组需要**:维护者提供当前访问密码,或同意我临时改一次密码后再改回(设备上有 `auth.json` 备份机制,可回滚)。
  在拿到密码前,本文档里各页的「已对齐」仍只代表 **zh/light/1440 一组**的结论,这一点在页面清单里已如实标注。

- 2026-11-25:建立本清单,确认路由结构与上游一致。逐页比对从「代理」页开始。
- 2026-11-25 **代理页**:用 DOM 对照而不是只看截图(截图判断反复出过错,以下结论都有 DOM / 代码证据)。
  - 页签、数量、搜索框占位文字、空状态文案:两页**完全一致**(`策略 (14) / 节点 (3) / 订阅 (2)`、「搜索 | 多个关键词用空格分隔」)。
  - **修正一处真实差异**:分组卡片标题上的「域名穿透 / 策略穿透」按钮,上游用
    `hover:bg-(--app-interactive-hover)!` + `whitespace-nowrap`,main 少了 `whitespace-nowrap`,
    且暗色 hover 底色写成了 `#4b4428`(上游 `--app-interactive-hover` 的暗色是 `#264b3d`,亮色 `#f1ead6` 本来一致)。
    已补齐 `whitespace-nowrap`(`ProxyGroup.vue` 两处),并把 `#4b4428` → `#264b3d`(`ProxyGroup.vue`、`ProxyNodeCard.vue`)。
    DOM 复核:`whiteSpace` 两页都是 `nowrap`,按钮类名与上游逐项一致。
  - 分组卡片图标(直连 `misc:dart` / 拒绝 `misc:cross`)与上游**一致**——两边都是后端返回的 `icon` 字段,`core/internal/groups/group.go` 补的正是这两个值,不是前端缺图标。
  - 侧栏顶部标识、侧栏底部资源块:与上游结构一致(同一张 `logo.png`、同样的 `alt="Open-Box"`、同样的「收起侧边栏」按钮)。
  - 未覆盖:三语 × 深浅主题 × 桌面/窄屏的组合矩阵,这一页只在中简体 + 浅色 + 1440 宽下逐项验过。
- 2026-11-25 **代理页(DOM 比对,取代上面的截图结论)**:建立 `panel/docs/ui-align/compare.mjs` 后重跑,
  在 `zh / light / 1440` 与 `zh / dark / 1440` 各一次。**发现并修掉 3 处真实差异**(截图那一轮全没看出来):
  1. **全局圆角偏大**:main 的圆角基数是 26、派生用乘系数(0.85/0.75/0.58),上游基数是 **16**、
     派生是 `字段=R / 卡片=R+1 / 面板=R+2 / 条=R*0.04`。实测面板 29px vs 26px、按钮 26px vs 15.1px、输入框 26px vs 15.1px。
     已按上游重写(`store/settings.ts` 默认值 16;`App.vue` 的 `appStyles` 改成 +1/+2 推导,补 `--app-radius-card` / `--app-radius-bar`)。
  2. **深色主题配色不同**:上游在 daisyUI forest 之上又覆盖了一层更藏青的底(`base-100 #263449`、`base-200 #1e293b`、`base-300 #131c2e`),
     main 直接用原版 forest(偏棕灰)。已在 `assets/main.css` 补上上游那组覆盖(含 `--app-divider-color` 等)。
  3. **页签间距**:上游 tablist 用 `app-inline-gap`(8px),main 用了 `app-card-gap`(12px)。已改回。
  - 剩余差异(全部已归因,不再处理):`card` 圆角 19px vs 18px(上游另一处 `corner-radius` 迁移逻辑,差 1px,视觉不可辨);
    `input` 右内边距 12px vs 32px(上游输入框不带「清空」按钮时不留右内边距,main 的 `TextInput` 统一留了 20px 给按钮,
    实测两边都显示清空按钮、按钮位置一致,只是内边距策略不同);`tab` 背景透明 vs 选中态上色(main 的 `menu-active` 叠了 `neutral` 底,
    上游由 `seg-highlight` 单独画,两者视觉结果在同色系内,属于实现方式不同)。
  - 噪音(脚本已忽略或不可消除):上游每次构建随机生成的 canary 标识、哈希 class;dev 模式下 Vite 会把小 SVG 内联成 data URI
    (生产构建与上游一致,产物文件名都相同 `dart-BMDI5Qb5.svg`,已验证)。
  - **比对工具的依赖**:`playwright` 只用于本地比对,**不进 `package.json`**(避免给面板增加一个几百 MB 的开发依赖);
    脚本放 `panel/docs/ui-align/`,需要时本地装一次即可。

- 2026-11-25 **概览页**:DOM 对照。
  - 卡片顺序与标题两边一致:`硬件负载 / 网络状态 / 流量洞察 / 节点评分`(侧栏里的系统资源块也在)。
  - 月份页签(`2026年10月 / 11月 / 12月`)、统计块(连接数 / 活跃终端 / 进站速率 / 进出站流量 / 运行时长)一致。
  - **有意差异(不改)**:
    - 上游多一张「业务优选」卡片 → 例外 C,main 整体不做;
    - 上游顶栏是「机场、VPS 安格超市 | 原生住宅 IP TOPIP」这类市场外链 → 例外 B,main 改成两个版本号。
      实测 main 显示「Open-Box v0.1.486」+「sing-box 1.14.4-openbox-60」;
      其中 `v0.1.486` 是**官方面板后端** `/api/openbox/activation` 自己给的 `defaults.left`,不是 main 写死的,所以版本号跟着后端走(当前真机是 v0.1.486 官方包)。
      口径:取「main 最新 release tag」,取不到退回构建时注入的版本;实现只在 `internal/api/activation` 一处(`LatestTag`,由 `main.go` 注入,10 分钟缓存 + 5 秒超时),不散落到前端。

- 2026-11-26 **代理页:三语 × 深浅主题矩阵**(脚本已能语言无关登录——登录按钮文案随语言变,按文案找会超时):
  | 语言 | 主题 | 结构差异 | 计算样式差异 | 结论 |
  | --- | --- | --- | --- | --- |
  | zh | light | 211 / 120 | 3 | 仅已归因项 |
  | zh-tw | light | 211 / 120 | 3 | 仅已归因项 |
  | en | light | 211 / 120 | 4 | 多 1 项 `tab.color`(见下) |
  | zh | dark | 211 / 120 | 4 | 多 1 项 `button.color`(见下) |
  | zh-tw | dark | 211 / 120 | 4 | 同上 |
  | en | dark | 211 / 120 | 5 | 上面两项都有 |
  三语的结构差异数完全相同(211/120),说明语言只影响文案、不影响结构;文案已全部占位符化。
  **把剩余 5 项逐一定性(DOM + 计算样式证据,不再改动)**:
  1. `card.radius` 19px vs 18px:差 1px,来自上游那套 `corner-radius` → `global-radius` 的迁移逻辑保留了一档偏移,视觉不可辨。
  2. `input.padding` 右内边距 12px vs 32px:main 的 `TextInput` 无论有没有「清空」按钮都留 20px 给按钮;上游只在实际显示按钮时留。
     实测两边都会显示清空按钮且按钮位置一致,只是内边距策略不同。
  3. `tab.bg` 透明 vs `rgb(74,93,128)`:**实测上游 `seg-highlight` 层的背景就是 `rgb(74,93,128)`(= `--color-neutral`)、文字 `neutral-content`,
     main 把同一个颜色画在 `menu-active` 元素自己身上**。视觉结果相同,只是「单独一层高亮」还是「元素自身上色」的实现差异。
  4. `tab.color`(en/light):同第 3 项,上游把前景色放在高亮层(`rgb(229,231,235)` = base-content),main 放在元素上。
  5. `button.color`(dark):同第 3 项,深色下 `neutral-content`(`#faf5e4`)与 base-content(`#e5e7eb`)的差别,背景已经一致。
  **结论**:代理页在 zh / zh-tw / en × light / dark 六种组合下,除上述「实现方式不同、视觉等价」的 5 项外没有其它差异。

- 2026-11-26 **代理页(维护者指出的回归,已修)**:折叠态分组的预览本该是**一排排小圆点**
  (16px 圆点、固定 4px 间距、按容器宽度自然换行、有多少排多少),main 却在卡片稍窄时退化成了**一条连续长条**。
  根因是 `ProxyPreview.vue` 的 `showDots` 条件写成了 `dots || (auto && 宽度够)`,而设置里默认是 `auto`,
  宽度不够就画长条;上游是 `forceDots || 类型 !== bar`——**除了显式选「长条」以外一律画圆点**。
  已按上游改回,并删掉随之无用的 `widthEnough`。
  验证(1440×900,同一后端):两页均 `dots=86 / bars=0`,圆点 16×16、`flex` + `gap 6px`、26 行,逐项一致。
  **教训**:之前用截图判断这一块时把长条当成了「实现方式不同」,实际是可辨的回归——这类「同一组件的两种渲染形态」
  必须查组件里的判定条件,不能靠肉眼归因。

- 2026-11-26 **侧栏底部「内核」那一行(新增对齐)**:上游在侧栏资源卡上方有一行
  `div.flex.items-center.gap-1.5.px-[12px][data-sidebar-kernel]`,内容是**内核图标 + 内核名**
  (名字表 `sing-box → Sing-Box` / `mihomo → Mihomo`),只在服务端回了 `core.kernel` 时显示;main 之前整行没有。
  已补:`components/kernel/KernelIcon.vue` + `sidebar/CommonCtrl.vue` 里的这一行。
  **图标来源(不用上游产物)**:sing-box 用 SagerNet/sing-box 的组织头像(即其 logo),Mihomo 用 MetaCubeX/mihomo 仓库的 `docs/logo.png`,
  都缩到 96px 入库。
  验证(1440×900,同一后端,当前内核 mihomo):两页 `data-sidebar-kernel` 行的类名、`gap 6px`、`padding 12px`、文字 `Mihomo`、
  图标 16×16、`alt=""`、`object-fit: contain` **逐字段一致**。

- 2026-11-26 **设置页(DOM 比对,zh/light/1440)**:结构行数 327 / 328,差异从 22 项降到 18 项,**计算样式只剩 1 项**(`card.radius` 19 vs 18,差 1px,与代理页同一原因)。
  **发现并修掉 1 处真实差异**:节点评分滑块的端点与单位,上游用 `qualityPoints` 键(中文「分」/ 英文「points」),
  写成 `0 分` / `100 分`;main 用的是百分比 `0%` / `100%`。已改为上游的写法(`unit`、`min-label`、`max-label` 三处)。
  实测两页现在都是 `0 分 / 100 分` + 两个快捷按钮 `30 分 / 80 分`,逐字一致。
  **剩余 18 / 19 项已归因**:`logo` 与 `mihomo` 图标的哈希名不同(同一张图);dev 模式下小 SVG 被内联成 data URI;
  上游用 `span` / main 用 `div` 做同样的文本容器(路径不同但文本一致)。

- 2026-11-26 **连接页(DOM 比对,zh/light/1440)**:结构行数 上游 3472 / main 2629,计算样式 2 项(1px 圆角 + 输入框右内边距,同代理页归因)。
  **差异性质**:把两侧的行按「去掉标签名」归一后逐项对照,文本与图标**一一对应**——`自建代理节点 / 美国节点 / 直连 / 国外 / Speed / stopwatch / 地球图标 / shield` 等
  在两侧的数量完全相同(81/34/10/60…)。侧独有的 1278 行里,540 行是纯容器(没有文本也没有图标,只是 `div` 套 `span` 的层级差异),
  其余主要是图片哈希名不同(`cross-BxkJ4uxz` vs `cross`)与 dev 模式把 `svg` 内联成 data URI。
  **仍未定位的 1 项**:上游在这一页渲染了 `cross` 图标 83 次、`dart` 34 次(每个「拒绝 / 直连」标签前一个),main 为 0。
  main 侧「拒绝」标签的父容器只有一个子元素(纯文字),上游有两个(图标 + 文字)。
  已确认:内核 `/proxies` 返回的 `REJECT` 本身**没有** `icon` 字段,所以这不是后端漏字段;上游是在前端某处把档案分组的 `icon` 合并进了出站表。
  我还没定位到那一处的确切代码位置(试过订阅页的默认分组构造,但那是分组编辑器用的,不是连接页的来源),**因此本页暂不标「已对齐」,留作下一批继续定位**,
  不凭推测改代码。
- 2026-11-25 **内核切换(设置页)**:对照上游 v0.1.487 的 `KernelSelect` 与切换弹窗,修掉两处差异。
  1. 下拉:原生 `<select>` 换成自定义弹出菜单(新增 `KernelSelect.vue`,复用 `useAnchoredDropdown`),触发按钮与每一项带图标、当前项打勾;
     名称写作 `Sing-Box`;sing-box 图标换成 `assets/sing-box.svg`(与上游内联 SVG 逐字相同,此前误用了 SagerNet 头像 png)。
  2. 弹窗:提示句不再加 `text-sm`(上游沿用基础字号);检查项标题 `font-medium`,状态文字 `text-sm`(原来 `text-xs`),
     详情行 `text-base-content/70 mt-1 space-y-1 text-xs`。
  不放「使用教程」按钮及教程视频相关面板与后端(例外 A)。
- 2026-11-25 **内核切换弹窗(提示句与检查列表的间距)**:上游 v0.1.487 的提示句 `<p>` 与检查列表 `<ul class="mt-2 …">` 直接相邻、中间没有 `gap`,
  间距只有 `mt-2`(8px);main 外层多套了一层 `flex flex-col gap-2`,叠加后是 16px。已去掉外层 `gap-2`,
  预检失败提示 `<p>`(上游没有,自研保留)单独加 `mt-2` 以保持它与上一行的间距。不放「使用教程」按钮及教程视频相关面板与后端(例外 A)。
- 2026-11-25 **按钮字重与描边(内核切换弹窗的「取消」「切换并重启」)**:上游 v0.1.487 全站 `#app-content .btn` 字重 400,
  非 link 按钮带 `1px solid var(--app-card-border)` 描边;main 缺这两条,字重落到 daisyUI 默认 600,「取消」也没有胶囊描边。
  已在 `main.css` 补上这两条,并带上上游对方形/圆形/紧凑图标 ghost 按钮与侧栏折叠按钮的例外(不描边、静止无底色)。
  不放「使用教程」按钮及教程视频相关面板与后端(例外 A)。

- 2026-11-26 **连接页:上一批留下的「拒绝/直连标签无图标」已定位并修好**。根因在 `store/proxies.ts`:
  上游遍历档案分组时,对带 `kind` 的内置分组(`builtin-direct` / `builtin-block`,档案里名字是中文「直连」「拒绝」)
  会**把它的图标按 kind 铺给所有同类出站**(`if (l.kind) for (...) sameKind.push(f)`),而内核 clash_api 里的出站名是
  `DIRECT` / `REJECT` / `REJECT-DROP`(名字对不上,靠 kind 才认得)。main 只给了「组自己」,而组名在 `proxyMap` 里
  根本不存在,于是图标从未落到 `REJECT` 上。
  已补:`outboundKindOf()`(Direct→direct;Block/Reject/RejectDrop→block)+ 按 kind 批量写 `icon` / `iconScale`。
  验证:两页「拒绝」标签各 83 个、**带图标的各 83 个**,逐项一致;`cross` 83↔83、`dart` 34↔34。
  **2026-11-27 全矩阵复跑(3×2×2 = 12 组,`matrix.mjs` 一条命令跑完)**:`zh / zh-tw / en` × `light / dark` × `1440 / 420`。**内容差异 main 侧 10 组为 0**,只有 `en/light/420` 与 `en/dark/420` 各 2 条(`span"({N}/{N})"`,英文窄屏分页文案);**结构差异 12 组全部为 `main 独有 162`、`上游独有 249`**,数值逐组相同。**这 162 条的根因已核实、且 main 是对的**:上游当前版本(v0.1.492 的 `panel/dist/assets/LatencyTag…js.gz` 解压后)根节点就是 `role: m.value?"group":void 0`(`m.value` = 带宽段已启用),main 的 `LatencyTag.vue` 写法与之逐字一致。**先前「main 多包一层 role=group、要删掉」的判断是错的,已回退**——上游开源期的旧 `panel/src`(2026-10-05 快照,连带宽段都还没有)不能当基准,当前基准只有 `panel/dist`。差异来自两侧带宽段开关的数据不同,不是代码不同。**因此本页标「内容已对齐;DOM 结构差异源自运行时带宽数据,非代码差异」。**

- 2026-11-26 **设置页全部 10 个页签的 DOM 比对**(zh/light/1440;`#/settings?tab=<t>`):
  | 页签 | 结构行数(上/下) | 侧独有 / main 独有 | 计算样式 | 结论 |
  | --- | --- | --- | --- | --- |
  | panel(后端设置) | 327 / 328 | 18 / 19 | 1 | 已对齐(仅 1px 圆角 + 图标哈希噪音) |
  | subscriptions | 186 / 186 | 2 / 2 | 1 | 已对齐(噪音) |
  | groups(节点组) | 206 / 197 | 33 / 24 | 1 | 已对齐(容器层级 + 图标哈希) |
  | routing(分流) | 274 / 271 | 44 / 41 | 1 | 已对齐(同上) |
  | clients(终端) | 156 / 156 | 2 / 2 | 2 | 已对齐 |
  | chain(链式代理) | 156 / 157 | 4 / 5 | 2 | 已对齐;**例外 B** 的「安格超市」链接不补 |
  | dns | 294 / 295 | 24 / 23 | 2 | 已对齐 |
  | kernel(内核) | 410 / 385 | 129 / 103 | 2 | 已对齐;差异含**例外 C**(「可靠性衰减」「可信度效期」)与**例外 A**(教程 youtube 图标),均不补 |
  | share(共享网络) | 156 / 156 | 2 / 2 | 2 | 已对齐 |
  | clientApp(客户端 App) | 327 / 326 | 142 / 140 | 6 | 已对齐(差异来自抽样/参数,见下) |

  - **内核页**逐项核过:上游独有的「可靠性衰减 / 可信度效期」是业务优选(C),`youtube` 图标是教程按钮(A),
    `openwrt/linux/docker` 是平台图标(`svg` 在 dev 下被内联,生产构建与上游一致),
    「内核版本:」与 main 的 `kernelVersionLabel` 是同一个键(上游同样不带冒号,冒号是拼接)。
    维护者刚做的内核切换/图标改动已在本次比对中生效,没有再发现差异。
  - **clientApp 页还剩 6 项计算样式差异**,需要单独一轮定位(下一批)。

  - **clientApp 页的 6 项计算样式差异已定性为「不是界面差异」**:我最初用 `#/settings?tab=clientApp` 打开,
    上游不认这个 key(它的 tab 枚举值不同),退化到了「面板设置」,于是两边内容完全不同、差异全是假的。
    改用两侧都打开 `#/settings` 再逐字比对正文:两边正文**逐字相同**
    (……「负载检测 负载较小 负载一般 负载较高 0% 100% 50% 90% 节点评分 评分较低 评分一般 评分优秀 0 分 100 分 30 分 80 分 IPv6 测试 测试站点」),
    说明页面对齐、先前那 6 项是抽样元素不同造成的假差异。
    **教训**:跨实现比对子页签不能靠 URL 参数(两边的 key 命名不同),要先落地同一入口再点同名页签。

- 2026-11-26 **连接页剩余那 1 项已定位到根因(但尚未实现,故本页仍不标已对齐)**:上游连接页有 81 个
  `.latency-tag`(每个带 `role="group"` 和 `aria-label=<节点名>`,即节点名旁边那枚延迟药丸),main 一个都没有。
  顺着 dist 追到了确切位置:连接列表的「策略 / 出站」列渲染的是一个组合组件
  `d(ct, { name, class: "inline-flex!", hideBandwidth: true })`——`ct` 同时负责**节点名 + 延迟标签**,
  并通过 `hideBandwidth` 只显示延迟、不显示带宽段;详情弹窗与日志页的链路也用同一套。
  main 的 `ProxyName.vue` 只渲染 `ProxyIcon` + 名字,**没有延迟标签,也不接受 `hideBandwidth`**。
  这不是「差一个属性」,而是「少了一整块子组件」,要做就得给 `ProxyName` 加一个可选的延迟药丸(读同一个
  `latency` 来源、同一套阈值着色),同时确认连接页三处调用点都传 `hideBandwidth`。
  我这一页已经误判过两次(先说「实现方式不同」、后把 `role="group"` 加到两个不在这条渲染链上的组件),
  所以**这次只记录根因,不再凭推测改**;下一批按上面的结构实现,并逐点验证 81 个全部出现。
  另外:我加过的 `role="group"` 与分组行 `role` 均已全部撤回,没有留在任何提交里。

- 2026-11-26 **连接页:节点名后的延迟药丸已补齐(实现完成,但本页仍无法端到端验证)**。
  按上一批定位到的结构实现:`ProxyName.vue` 新增 `hideBandwidth` / `groupName` 两个可选 props,
  `hideBandwidth` 为真时在名字后渲染 `<LatencyTag class="ml-1" :name :group-name>`(只显示延迟、不带带宽段);
  `ConnectionCard.tsx` 与 `ConnectionDetails.vue` 的四处调用点都传了 `hideBandwidth`。
  验证:代理页两边都是 **14** 个 `.latency-tag`(未回退);`vue-tsc` 与 `vite build` 通过。
  **无法端到端验证的原因(数据差异,不是界面差异)**:main 侧连到自研后端时**当前 0 条连接**
  (正文显示「按终端 (0 · 0)」),没有连接行就不会渲染药丸;上游基准连的是官方面板,连接列表里有 81 条历史连接,
  因此它显示 81 个。两边数据源不同,这一步只能在有真实连接的设备上确认。
  **仍不标「已对齐」**:结构已按上游实现,但 81 个药丸的出现未经端到端验证;记在这里等真机。

- 2026-11-26 **清单订正 + 窄屏/三语矩阵**:上面「独立页面组件」那 8 项其实都是**设置页的一级页签**
  (`share` / `chain` / `dns` / `kernel` / `clientApp` / `clients` / `subscriptions` / `routing`),
  上一批已用 DOM 比对逐个过了一遍,所以把状态从「待做」订正为「已对齐」,不再重复比对。
  **登录页**:两侧结构一致(标题「密码登录」、说明句、密码框 + 显示密码按钮 + 登录按钮),文案键同为 `passwordLogin*`。
  **窄屏(420×900)三组**:zh-tw/light、en/light、zh/dark。
  结构行数 上游 350~352 / main 289,差异全是已有的两类噪音(图标哈希、dev 内联 SVG)。
  **一处曾疑似差异、核实后不成立**:我一度以为 main 窄屏缺 `role=tablist`,复查发现是脚本点错元素导致状态异常——
  在窄屏下直接打开 `#/proxies`,`role=tablist` 为 **1**、内含 3 个 `role=tab`(策略/节点/订阅),与上游一致;
  桌面端同样一致。`ProxiesCtrl.tsx` 本来就带 `role="tablist"` / `role="tab"` / `aria-selected`,不需要改。
  计算样式差异仍是老几项(1px 圆角、输入框右内边距、选中态颜色画在高亮层还是元素自身),已归因。

- 2026-11-26 **连接药丸:确认无法在本环境端到端验证(第三次尝试,如实收口)**。
  按比对方法第 3c 条试了「拦截接口造数据」:只拦 `GET /api/controller/connections` 回一条带完整 `chains` 的假连接,
  期望「关闭」页签出现 1 行、1 个延迟药丸。结果:两个实例的**连接数都是 0**(上游基准连的官方面板、main 连自研后端),
  页面正文都显示「按终端 (0 · 0)」;伪造的连接行没有进入「关闭」历史列表(该列表来自后端自己的历史,不是这个接口)。
  加上此前的 `?tab=` 参数误用与点错元素,这一项已试了三种办法,都受**数据侧**限制:
  - 官方面板有 81 条历史连接 → 它显示 81 个药丸;
  - 自研后端两个实例都是 0 条 → 无从渲染。
  **结论**:`ProxyName` 的 `hideBandwidth` 结构与上游一致(上一批已实现、`tsc` + `build` 通过、代理页 14 个药丸未回退),
  但「连接列表里的药丸」只能在**有真实连接流量**的设备上确认。(此处的「先不虚标已对齐」后被第四次尝试推翻,见本段末尾) **2026-11-27 第四次尝试(有真实流量了,已验到)**:在设备上用长连接造出 4 条活跃连接(`连接数 4`、进站速率 1.4~1.6 MB/s),两端同时打开 `#/connections?tab=connections`:**两边都显示「连接数 4」、表格结构一致、`.latency-tag` 都是 0 个**——不是 main 少画,而是这一列的节点名使用 `ProxyName` 时不带 `show-latency`(上游同样不带),药丸只出现在「路由」页签的链路里。**顺带确认两点**:① 短连接采不到(`/connections` 回 `connections: null`),必须用长连接造数据;② 后端 `/api/controller/connections` 对内核对齐返回 `connections: null`,main 用 `data.connections?.map(...)` 安全兜住,不会因 null 崩。**结论**:这一项与上游**行为一致**,不是差异。**2026-11-28 状态订正**:本页(连接)已在第 52 行的状态表里标为「已对齐」,上面「保持『有差异待做』」那句是第四次尝试之前的阶段说法,已作废——验到真实流量后确认两边渲染一致,不是 main 少画。
  **运维提示**:要验证这一项,在设备上跑一段产生连接的流量(打开几个网站),再从面板进「连接」页看节点名旁边是否出现彩色延迟药丸。

---

## 模板字符串与条件分支键核对(2026-11-27)

任务书收尾要求「单独检索 dist 中模板字符串或变量拼接的键、仅在特定分支出现的引用」。做法与结论:

**一、模板字符串(反引号 + `${}`)拼出来的键**:从 53 个 dist js 里抽出 9 个模板前缀,逐个核 main:

| 前缀 | main 引用 | 结论 |
| --- | --- | --- |
| `bandwidthExample_` / `bandwidthOff_` / `bandwidthOn_` | 各 10 处 | **已覆盖**(`_{urltest,failover,loadbalance}` 三语都有) |
| `groupType_` | 25 处 | **已覆盖**(`_{selector,urltest,failover,loadbalance}` 等) |
| `obUpdateStage_` | 31 处 | **已覆盖**(starting/probing/downloading/…/cancelled 全在) |
| `businessOverview_` / `businessSettingsHelp_` / `businessOverviewReason_` | 0 | **正确**:属例外 C,不做 |

**二、条件分支(三元)里才出现的键引用**:抽出 18 个(去掉 `bottom` / `button` / `groups` 这类恰好同名的普通单词),
其余 15 个在 main 里均有引用:`bandwidthHelpCurrentTestDaily`、`bandwidthHelpLoading`、`bandwidthHelpSwitchOn`、`bandwidthHelpTitle`、
`connectionDeviceRenameByMAC`、`dnsUpstreamDohHost`、`dnsUpstreamDotHost`、`hidePassword`、`nodeScoreWeightValues`、`shareCodeAppHint`、
`subscriptionRefreshedDone`、`subscriptionRefreshedRestartRequired`、`tagCollapse` 等,**零缺口**。
## 最终差异清单(2026-11-27 更新至上游 v0.1.494)

### 「节点」页签只显示 1 个组 —— 不是缺陷(2026-11-28 排障结论)

有人报「节点页签下节点全没了」。逐层核对后确认**这是上游 v0.1.494 的正常行为**,不是 main 的 bug,
也不是数据被改坏:

1. **用官方 dist 复现**:把 `origin/catch-up-upstream`(`44bf5bd4`)的 `panel/dist` 起成基准页(8917),
   与 main 的 dev 页并排跑,两边页签计数完全相同 —— `策略 (14) / 节点 (1) / 订阅 (2)`。
2. **恢复出厂后仍然如此**:设备重置后再看,还是 `节点 (1)`;`openbox/groups` 与备份里的 sqlite 对比,
   从头到尾都是 3 个组(`直连` / `故障转移测试` / `拒绝`),没有被改动过。
3. **后端返回本身就是 1 个**:`GET /api/openbox/groups` 回
   `"availableGroups": ["故障转移测试"]`、`"availableNodes": [68 个节点,每个都带 subscription 归属]`。

**两个页签的根是两套数据**(这正是它看起来像「坏了」的原因):
- 「节点」页签 = `availableGroups` = 用户在**节点管理**里自建的组。官方数据只有 `故障转移测试` 能被列进来,
  所以是 `节点 (1)`。
- 「订阅」页签 = `availableNodes` = 68 个订阅节点,按订阅分组(`多宝` 51 + `自建` 12)。浏览器里实测
  订阅页签能渲染出节点卡片。

上游改版后把「节点」收敛成「用户自建组」,订阅节点改从「订阅」页签看;老版本那种「节点页签铺满所有节点」
的形态已经没有了。**不要为了让它「看起来像老版本」去改分类逻辑** —— 那会偏离上游。
若确实想让节点出现在「节点」页签,做法是在节点管理里新建组把节点挂进去(数据操作,不改代码)。


**2026-11-28 复跑(按 `origin/catch-up-upstream` = `44bf5bd4` 的真实 dist,`en-BeGnJsso.js`)**:
- **缺失**:扣除例外 C 后 **0**。
- **多出**:上一轮误加的 4 个键(`obUpdateChannelAuto` / `Direct` / `Mirror`、`obUpdateInstalledChannel`)
  在 v0.1.494 的 en 语言包里**根本不存在**,已连同配套代码删除(下拉框、「安装时通道」提示、
  `checkChannel` 字段、后端 enum 校验);删除后**多出 0**。
- **三语一致**:en / zh / zh-tw 各 **2315** 键,无重复,三语互比零差异。
- **接口**:上游 dist 里的 `/api/...` 字面量 42 条,main 未覆盖的 8 条全是例外 B(`overview-links`)、
  构建随机占位(`/api/v3/enclave/quorum-*`)或模板字符串误判(`update/notes` 实际有)。
- **页面清单**:24 处「已对齐」,无「有差异待做」。


**对齐基准**:上游 **v0.1.494**(2026-11-27T09:59Z;`catch-up-upstream` = `44bf5bd4`)。
键集与引用以上游语言包与 `panel/dist` 为准(上游自 v0.1.463 起 `panel/` 不入 git,只能按 dist 对)。

### 键集(三语,`cmp-upstream-i18n.py`)

- 上游三语各 **2369** 键,main **2331** 键,缺 **38** 个——**全部是例外 C(业务优选)**:`businessOverview*`(25 个)、
  `businessPreference`、`businessPreferenceMinutes`、`businessReliabilityHalfLife`、`businessPerformanceTtl`、
  `bandwidthHelpCurrentBusiness`、`businessSettingsHelp*`(8 个)。**扣除例外 C 后缺失 0**。
- **多出**:**无**。
- **值不同**:**无**。
- **值不同**:**无**。

**2026-11-28 补一个真缺口**:上面的键集核对漏了 4 个键——`obUpdateChannelAuto` / `obUpdateChannelDirect` / `obUpdateChannelMirror` / `obUpdateInstalledChannel`。它们**不属于任何例外**,上游在 `KernelPage` 里真实引用(内核页更新卡片上的通道下拉框 + 「安装时通道」提示),而 main 既没定义也没引用。已补齐:三语逐字取上游文案,`OpenboxUpdateCard.vue` 加通道下拉框(改动即把 `updates.openbox.checkChannel` 存进档案)并在升级时按所选通道 `startUpdate`,右上补「安装时通道」小字(取 `update/status` 的 `channel.mode`)。**补齐后重新核对**:上游候选键 2275、main 2319,**差 38 个全部是例外 C 的 `business*` 前缀**,真缺口 0。(`vue-tsc` 与 `npm run build` 均通过。)
- 三语一致:上游 zh / zh-tw 相对 en 既不缺也不多。

### 引用(`cmp-upstream-refs.py`)

- 上游引用、main 未引用:扣除例外 A(`activation*` / `comingSoon` / `tutorial*` / `marketPromo` /
  `clientDownloadFastWith` / `chainProxyEmptyHintSuffix`)与例外 C 之后 —— **真缺口 0**。
  最后 3 项 `nodeScoreRefreshQueued` / `SubDone` / `Unavailable` 也已在第 12 批接上
  (单节点排队 / 队列排完 / 3 分钟没排完三种情况)。
- main 引用、上游未引用:该方向对压缩产物**不可靠**(dist 走短名映射,字面量搜不到,已抽查 `systemCpuCoreLoad` 证伪),
  不作为差异依据。
- 模板拼接键(9 组:`bandwidthExample_` / `bandwidthOff_` / `bandwidthOn_` / `groupType_` / `obUpdateStage_` 等)
  逐组核过,main 键全齐、引用都在。

### 本轮(493 + 494)对齐了什么

- **v0.1.493**:`latencyReason*` 4 键;升级对话框三行(`source`/`transfer`/`attempts`);删除下载通道手动选择(4 键);
  测速站点预设 12 键(`bandwidthEndpoint*` / `bandwidthCustomUrl*`);10 处评分文案;
  后端加 `bandwidth.endpoint` / `endpointCustomUrl` 字段与 `TestEndpointURL()`,并修掉 `normalizeBandwidth` 丢字段的缺陷。
- **v0.1.494**:9 个 `nodeScore*` 键 + `scoreasc`/`scoredesc` + 3 个 `groupType_*_short`;
  `nodeScoreExcellentShort` 改「评分较高」、阈值默认 `[30,80]`→`[30,70]`;`groupType_failover_short` 英文 `Fallback`;
  内核页「检查更新」并入重启按钮(竖线分隔);悬浮窗加「节点评分」行;节点标签显示「延迟 | 评分」;
  组类型统一本地化(按上游映射表,含 `select`/`fallback` 别名);右上角「刷新评分」(测延迟 → 排队带宽 → 重拉评分);
  `directBypassNeedsFakeIp` 提示;`bandwidthManualCompleteRecovering` 降权措辞;`qualityBandwidthFailedUnweightedTip` 权重 0 措辞。

---

本次是基于 dist 反推与文档口径的**功能等价对齐**,不保证与闭源上游逐行一致。
- **第 12 批:把刷新评分的三条提示接完,引用缺口清零**
  ① `nodeScoreRefreshQueued`(单节点口径):只排上 1 个节点时用「已刷新 {name} 延迟,正在排队检测带宽」,
  多个节点才用带 `{queued}` 的 `nodeScoreRefreshSubQueued`。
  ② `nodeScoreRefreshSubDone`:排队后起一个 `watchScoreQueue`,每 5 秒 `fetchBandwidthStatus`,
  队列空了就重拉评分表并提示「已刷新」;`nodeScoreRefreshUnavailable`:超过 **3 分钟**仍没排完则提示「暂时拿不到」
  (带宽测速本身可能上百 MB,给足时间但不无限等)。
  验证:`vue-tsc` 与 `npm run build` 通过;**「上游引用、main 未引用」里非例外键已清零**,剩下全是例外 A
  (`comingSoon` / `activation*` / `tutorial*`)。
