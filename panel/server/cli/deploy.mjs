// 命令行触发一次「生成配置并启动内核」,和面板里点「启动 / 重启」走的是同一条流水线
// (api/deploy-runner.mjs 的 runDeploy)。给 update.sh 用:升级前内核在跑的话,换完文件、
// 面板起来后调它把内核按新版本重新生成配置再拉起来,不用用户再进面板点一次。
//
// 和面板进程共用同一个 sqlite(node:sqlite 自带锁,短事务并发没问题)。环境变量与
// openwrt/initd/openbox-panel 一致:ZASHBOARD_DB_PATH、OPENBOX_ROOT。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createStore } from '../store/openbox-store.mjs'
import { createRealContext } from '../system/context-real.mjs'
import { createPaths } from '../system/paths.mjs'
import { detectPlatform } from '../system/platform.mjs'
import { runDeploy } from '../api/deploy-runner.mjs'
import { settleRegionBeforeDeploy } from '../system/router-region.mjs'
import { retryBusy } from '../system/sqlite-busy.mjs'
import { registerBundledGeoTags } from '../system/geodata-tags.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const dbPath = process.env.ZASHBOARD_DB_PATH || path.join(rootDir, 'data', 'zashboard.sqlite')
const openboxRoot = process.env.OPENBOX_ROOT || '/opt/open-box'

// 和面板进程同时开这个库:面板每分钟 flush 流量记录、启动时清理旧记录,升级刚换完文件那会儿磁盘也忙,写锁可能被占好几秒。
// 以前只等 5 秒,撞上就在写部署状态时抛异常、整个进程退出,升级后内核一直没起来(GitHub #535)。现在 sqlite 自己等锁等到
// 60 秒;它为了避免死锁直接回 BUSY、不走等待的那种情况,这里再按间隔重试到同一个期限
const BUSY_WAIT_MS = 60_000
const db = new DatabaseSync(dbPath, { timeout: BUSY_WAIT_MS })
const getStmt = db.prepare('SELECT value FROM app_storage WHERE key = ?')
const setStmt = db.prepare('INSERT INTO app_storage (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
const delStmt = db.prepare('DELETE FROM app_storage WHERE key = ?')
const platform = detectPlatform()
const store = createStore({
  get: retryBusy((k) => getStmt.get(k)?.value ?? null, { waitMs: BUSY_WAIT_MS }),
  set: retryBusy((k, v) => setStmt.run(k, v, Date.now()), { waitMs: BUSY_WAIT_MS }),
  del: retryBusy((k) => delStmt.run(k), { waitMs: BUSY_WAIT_MS }),
}, { platform })

const ctx = createRealContext()
const paths = createPaths(openboxRoot, { platform })
// 随包规则库里有哪些规则集:站点集引用着、包里已经没有的跳过并提示,不让内核起不来(system/geodata-tags.mjs)
await registerBundledGeoTags(ctx, paths, { log: (m) => console.error(m) })
// 路由器在哪还没判出来(新装 / 升级后第一次):部署之前先判一次,配置直接按那个地区的 DNS 默认值生成(system/router-region.mjs)。
// 最多等 8 秒,判不出照常部署
try {
  const settled = await settleRegionBeforeDeploy({ store, ctx, paths })
  if (settled) console.error(`[dns-region] 部署前判出:出口 IP ${settled.ip} → 路由器在${settled.region === 'intl' ? '中国大陆之外' : '中国大陆'}`)
} catch {
  // 判不出不耽误部署
}
const result = await runDeploy({ store, ctx, paths })
console.log(JSON.stringify(result))
process.exit(result.ok ? 0 : 1)
