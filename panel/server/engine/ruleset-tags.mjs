// 规则集名字的两个判断(纯函数):名字合不合法、是不是随包的 geosite / geoip。原在 system/rulesets.mjs,挪到 engine
// 是为了让生成配置的那套代码能打进 App(client-engine);system/rulesets.mjs 照旧转出这两个名字
const SAFE_TAG = /^[A-Za-z0-9._!@-]+$/
export const isSafeRulesetTag = tag => typeof tag === 'string' && SAFE_TAG.test(tag) && !tag.includes('..')
export const rulesetKind = tag => isSafeRulesetTag(tag) ? /^(geoip|geosite)-.+/.exec(tag)?.[1] || null : null
