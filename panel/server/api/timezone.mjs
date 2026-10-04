// 后端设置 · 时区(用户 2026-10-03)。读 / 改路由器的系统时区,实现在 system/timezone.mjs。
//   GET /api/openbox/system/timezone        → { zone, offset, local, platform, zones, countries }
//   PUT /api/openbox/system/timezone {zone}  → 改完返回同样的形状
// zones 是可选的时区名单(随包的 tz-posix.json;OpenWrt 要它查 POSIX 串,两个平台用同一份名单);countries 是时区 → 国家代码,
// 下拉框按本地化的国家名搜索用(tz-countries.json)
import express from 'express'
import {
  TIMEZONES, TIMEZONE_COUNTRIES, applySystemTimezone, canonicalTimezone, describeTimezone, isKnownTimezone, readSystemTimezone,
} from '../system/timezone.mjs'

export const registerTimezoneRoutes = (app, { ctx, platform } = {}) => {
  const router = express.Router({ caseSensitive: true })
  router.use(express.json({ limit: '4kb' }))

  const state = async () => {
    const { zone } = await readSystemTimezone(ctx, platform)
    return { ...describeTimezone(zone), platform, zones: TIMEZONES, countries: TIMEZONE_COUNTRIES }
  }

  router.get('/system/timezone', async (_req, res) => {
    try {
      res.json(await state())
    } catch (err) {
      res.status(500).json({ message: err instanceof Error ? err.message : String(err) })
    }
  })

  router.put('/system/timezone', async (req, res) => {
    const asked = req.body && req.body.zone
    const zone = canonicalTimezone(asked)
    if (!isKnownTimezone(zone)) return res.status(400).json({ message: `不认识的时区:${asked}` })
    try {
      await applySystemTimezone(ctx, platform, zone)
      res.json(await state())
    } catch (err) {
      res.status(500).json({ message: err instanceof Error ? err.message : String(err) })
    }
  })

  app.use('/api/openbox', router)
}
