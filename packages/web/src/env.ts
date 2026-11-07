/**
 * 运行形态判定（docs/design.md §2 四形态、§7.6 形态 D）。
 *
 * 静态站默认「本地模式」：题库试题全部随静态包发下去，判分在浏览器里做，
 * 不需要任何后端。只有把 `VITE_SERVER_URL` 指向一个对局后端时，才进入联机模式。
 */

export const APP_VERSION = '0.1.0'

/** 联机后端 origin（形如 https://arena.example.com）；为空 = 纯静态本地模式 */
export const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim() || ''

export const MODE_LABEL = SERVER_URL ? '联机模式' : '本地模式'

/**
 * 把用户输入的地址规范成 origin。
 * 只接受 http(s) 且丢掉路径：联机后端永远挂在 origin 根上，
 * 这样 https 页面连 http 后端时能更早、更明确地报「混合内容」而不是连上后诡异失败。
 */
export function normalizeServerUrl(raw: string): { origin: string } | { error: string } {
  const text = raw.trim()
  if (!text) return { origin: '' }
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return { error: '地址格式不对，示例：http://192.168.1.20:8787' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: '只支持 http / https 地址' }
  }
  return { origin: url.origin }
}

/** https 页面连 http 后端会被浏览器拦截（混合内容），提前给出人话提示 */
export function mixedContentRisk(origin: string): string | null {
  if (!origin) return null
  if (location.protocol === 'https:' && origin.startsWith('http://')) {
    return '当前页面是 https，连 http:// 后端会被浏览器当成混合内容拦掉。请给后端配 https，或在本地用 http 打开页面。'
  }
  return null
}
