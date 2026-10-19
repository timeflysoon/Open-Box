// 后端设置「使用教程」弹窗的视频列表接口(上游 server/api/tutorial-videos.mjs,v0.1.341)。
//   GET  /api/openbox/tutorial-videos          已知列表(老的在前),马上回
//   POST /api/openbox/tutorial-videos/refresh  现在去查一次频道;查不到就回原来的列表 + error
// 和 clientApp.ts 一样自带 requestJson,不动 openbox.ts,避免和以后从上游同步的内容冲突。
import { fetchServerApi } from '@/store/auth'

export interface OpenboxTutorialVideo {
  id: string
  title: string
}

export interface OpenboxTutorialVideos {
  videos: OpenboxTutorialVideo[]
  // 上次查频道成功的时间(毫秒);没查过是 0
  updatedAt: number
  // 超过这么久没查就该再查一次;0 = 每次打开弹窗都查
  staleAfterMs: number
  error?: string
}

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

export const fetchTutorialVideos = () => requestJson<OpenboxTutorialVideos>('/api/openbox/tutorial-videos')

export const refreshTutorialVideos = () =>
  requestJson<OpenboxTutorialVideos>('/api/openbox/tutorial-videos/refresh', { method: 'POST' })
