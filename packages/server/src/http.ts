/**
 * 同端口 HTTP 层（docs/design.md §7）：
 *   GET /healthz   健康检查 + 房间/在线人数
 *   其余 GET       托管 `--web-root`（Vite 构建产物），SPA 路由用 index.html 兜底
 *
 * WebSocket 的升级不在这里处理：server.ts 拿到 http.Server 后自己挂 upgrade，
 * 这样 `/ws` 或任意反代路径都能用，也方便未来把静态资源丢给 CDN。
 */

import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

export interface HealthPayload {
  ok: true
  version: string
  protocol: number
  uptime_sec: number
  rooms: number
  participants: number
}

export interface HttpHandlerOptions {
  webRoot: string
  /** 非空时给 /healthz 加 CORS 头，方便静态站跨域探活。 */
  allowOrigin?: string
  healthz: () => HealthPayload
  /** 测试/排障用：请求日志回调。 */
  accessLog?: (line: string) => void
}

function contentType(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function setCors(res: ServerResponse, allowOrigin: string | undefined): void {
  if (!allowOrigin) return
  res.setHeader('Access-Control-Allow-Origin', allowOrigin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

/** 把 URL path 解析成 webRoot 下的绝对文件路径；越界返回 null。 */
function resolveStaticPath(webRoot: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const root = resolve(webRoot)
  const target = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`)
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

async function tryRead(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null
    throw error
  }
}

export function createRequestHandler(options: HttpHandlerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const root = resolve(options.webRoot)

  return (req, res) => {
    const method = req.method ?? 'GET'
    const url = req.url ?? '/'
    const pathname = url.split('?')[0] ?? '/'

    if (options.accessLog) options.accessLog(`${method} ${url}`)

    if (pathname === '/healthz') {
      if (method !== 'GET' && method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('Allow', 'GET, HEAD')
        res.end()
        return
      }
      setCors(res, options.allowOrigin)
      const payload = options.healthz()
      if (method === 'HEAD') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end()
        return
      }
      sendJson(res, 200, payload)
      return
    }

    if (method === 'OPTIONS') {
      setCors(res, options.allowOrigin)
      res.statusCode = 204
      res.end()
      return
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET, HEAD, OPTIONS')
      res.end()
      return
    }

    void serveStatic(root, pathname, method, res).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, message: String(error) })
      else res.end()
    })
  }
}

async function serveStatic(root: string, pathname: string, method: string, res: ServerResponse): Promise<void> {
  const target = resolveStaticPath(root, pathname)
  let file = target
  let body: Buffer | null = null

  if (file) body = await tryRead(file)
  if (file && body) {
    res.statusCode = 200
    res.setHeader('Content-Type', contentType(file))
    res.setHeader('Cache-Control', file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600')
    res.end(method === 'HEAD' ? undefined : body)
    return
  }

  // SPA 兜底：没有扩展名的路由（/play、/room/123）返回 index.html。
  const hasExtension = extname(pathname) !== ''
  if (!hasExtension) {
    file = join(root, 'index.html')
    body = await tryRead(file)
    if (body) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.end(method === 'HEAD' ? undefined : body)
      return
    }
  }

  res.statusCode = 404
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end('404 Not Found')
}
