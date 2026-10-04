// 命令行 `open-box`(openwrt/bin/open-box)读面板访问密码用:只读打开数据库,把 config/access-password 打到 stdout。
// 忘了密码的人登上路由器(SSH / LuCI 都得是 root)就能看到——面板密码本来就是明文存在这台机器上的,
// 能读这个文件的人早已能控制整台路由器,这里不多泄露任何东西。
// 退出码:0 = 打印了密码;3 = 还没设置过密码(首次打开面板时设置);1 = 读不了(数据库不在 / 打不开)。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ACCESS_PASSWORD_KEY = 'config/access-password'

// 和 index.mjs 的 parseStoredString 同一个口径:前端(VueUse)存的是 JSON 字符串,带着引号
export const parseStoredString = (value) => {
  if (typeof value !== 'string' || value === '') return ''
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed === 'string') return parsed
    } catch { /* 按原样返回 */ }
  }
  return value
}

export const readAccessPassword = async (dbPath) => {
  if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在:${dbPath}`)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5000 })
  try {
    const row = db.prepare('SELECT value FROM app_storage WHERE key = ?').get(ACCESS_PASSWORD_KEY)
    return parseStoredString(row ? row.value : '')
  } finally {
    db.close()
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const dbPath = process.argv[2] || process.env.ZASHBOARD_DB_PATH || '/opt/open-box/data/openbox.sqlite'
  try {
    const password = await readAccessPassword(dbPath)
    if (!password) process.exit(3)
    process.stdout.write(`${password}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`)
    process.exit(1)
  }
}
