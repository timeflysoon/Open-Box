// Open-Box 客户端(手机 / 电脑 App)和「激活」相关接口的前端封装。
// 对照后端 server/api/{client-app,client-config,activation}.mjs(上游 v0.1.304)。只涉及登录后的 /api/openbox/*
// 接口;App 自己用的 /client/v1/* 公开接口不在面板里调。
//
// 和 openbox.ts 一样走 fetchServerApi,这样 401/403 的处理和面板其余部分一致。
// requestJson 在 openbox.ts 里没有导出,这里照它的行为写了一份(错误体 {error} 优先于 {message}),
// 不去改 openbox.ts,避免和以后从上游同步的内容冲突。
import { fetchServerApi } from '@/store/auth'

// ---- 通用 ----

const extractErrorMessage = (data: unknown): string => {
  if (!data || typeof data !== 'object') return ''
  if ('error' in data && data.error) return String(data.error)
  if ('message' in data && data.message) return String(data.message)
  return ''
}

const requestJson = async <T>(input: string, init?: RequestInit): Promise<T> => {
  const response = await fetchServerApi(input, {
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...init?.headers,
    },
    ...init,
  })

  const data = await response.json().catch(() => null)

  if (!response.ok) {
    throw new Error(extractErrorMessage(data) || `request failed: ${response.status}`)
  }

  return data as T
}

// ---- 客户端 App(server/api/client-app.mjs)----

// 地区分流的一组 / 路由器标识:内部字段由 engine/share-regions.mjs、engine/server-info.mjs 定义,
// 这里先不展开,界面用到哪个字段再补类型。
export type OpenboxShareRegion = Record<string, unknown>
export type OpenboxServerInfo = Record<string, unknown>

// 按出口 IP 判出的国家;没判过时接口回 null
export interface OpenboxEgressCountry {
  ip: string
  country: string
  at: number
}

export interface OpenboxClientAppInfo {
  // 这台路由器的 ID:随机 32 位十六进制,第一次用到时生成,出现在「App 码」里
  routerId: string
  routerName: string
  // IPv4 在前;进 App 码,App 在家时靠它判断「到家了」
  lanAddresses: string[]
  // 家里局域网的 IPv4 网段(192.168.5.0/24 这样)。发给 App 时每组最前面自动带「这些网段 → 回路由器」,只读
  lanSubnets: string[]
  panelPort: number
  // 地区分流现值(没改过就是默认值)/ 是不是用户改过 / 默认值
  shareRegions: OpenboxShareRegion[]
  shareRegionsCustomized: boolean
  defaultShareRegions: OpenboxShareRegion[]
  // 路由器标识:存着的原样(空对象 = 全用默认值);serverInfoDefaults 是默认名称
  serverInfo: OpenboxServerInfo
  serverInfoDefaults: { name: string }
  egressCountry: OpenboxEgressCountry | null
}

export const fetchClientAppInfo = () =>
  requestJson<OpenboxClientAppInfo>('/api/openbox/client-app/info')

// 按出口 IP 判一次国家。出口 IP 没变就直接用上次的;内核没起 / 面板不在路由器上时后端回 503
export const detectEgressCountry = () =>
  requestJson<OpenboxEgressCountry>('/api/openbox/client-app/egress-country', { method: 'POST' })

// ---- 本地分流(客户端配置,server/api/client-config.mjs)----

// 后端的 publicDevice():不带 token 和密钥。lastSyncAt / lastSyncFrom 是后端每次被 App 同步时写的,其余字段不展开。
export interface OpenboxClientDevice {
  id?: string
  lastSyncAt?: number
  lastSyncFrom?: string
  [key: string]: unknown
}

// 出「码」要的全部材料。界面拿去拼二维码 / 复制链接 / 导出文件里的 importCode(三者是同一个码)
export interface OpenboxClientConfigIssue {
  device: OpenboxClientDevice
  // 同步开关(电源图标)。关着时 App 用的公开接口一律回 403 { error: 'disabled' }
  enabled: boolean
  token: string
  // 32 字节密钥:配置用它 AES-256-GCM 加密。属于凭据,不要写日志、不要进导出
  key: string
  routerId: string
  routerName: string
  lanAddresses: string[]
  panelPort: number
}

// 注意:没有码时这个 GET 会让后端现场生成一套(并存库),不是纯读取。
export const fetchClientConfig = () =>
  requestJson<OpenboxClientConfigIssue>('/api/openbox/client-config')

export const setClientConfigEnabled = (enabled: boolean) =>
  requestJson<{ enabled: boolean }>('/api/openbox/client-config/enabled', {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })

// 导出文件:配置 + 路由器编出来的规则集(base64)。geosite / geoip 随 App 安装包带,文件里只有摘要。
// 导出文件里要再放一个 importCode(见后端头注释),让手机导入等于扫了码——码的格式由界面按 App 的约定拼,这里不管。
export type OpenboxClientBundle = Record<string, unknown>

export const fetchClientConfigFile = () =>
  requestJson<OpenboxClientBundle>('/api/openbox/client-config/file')

// ---- 激活(server/api/activation.mjs)----
// 概览页顶栏默认放站点推广;输入内置激活码后顶栏左右两边换成自己填的文字(留空 = 默认的版本号)。
// 状态存在路由器上。后端用 400 回「激活码不对」{ error: 'invalid activation code' } 和「还没激活」{ error: 'not activated' }。

// TODO:响应体由后端 respond() 生成,字段还没对照过,先只声明确定的 activated。
export interface OpenboxActivation {
  activated: boolean
  [key: string]: unknown
}

export const fetchActivation = () => requestJson<OpenboxActivation>('/api/openbox/activation')

export const activate = (code: string, left: string, right: string) =>
  requestJson<OpenboxActivation>('/api/openbox/activation', {
    method: 'POST',
    body: JSON.stringify({ code, left, right }),
  })

// 已经激活时改两边的文字,不用再输激活码
export const updateActivationText = (left: string, right: string) =>
  requestJson<OpenboxActivation>('/api/openbox/activation', {
    method: 'PUT',
    body: JSON.stringify({ left, right }),
  })

export const deactivate = () =>
  requestJson<OpenboxActivation>('/api/openbox/activation', { method: 'DELETE' })
