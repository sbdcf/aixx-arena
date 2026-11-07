/**
 * 一条 WebSocket 连接的传输层：帧大小、限流、JSON 解析、握手超时、心跳。
 *
 * 业务语义（hello 版本校验、房间、状态机）一概不在这里 —— session 只保证
 * 「上来的东西是合法 JSON 对象且不过量」，把 `ClientMsg` 交给 server.ts。
 */

import type { RawData, WebSocket } from 'ws'

import type { ClientMsg, ErrorCode, ServerMsg } from './core.ts'

export interface SessionHooks {
  onMessage: (session: Session, message: ClientMsg) => void
  onClose: (session: Session) => void
}

export interface SessionOptions {
  /** 每连接每秒允许的消息数（含非法帧）。 */
  rateLimitPerSecond?: number
  /** 单帧字节上限。 */
  maxFrameBytes?: number
  /** 建立连接后多久内必须 hello。 */
  helloTimeoutMs?: number
  /** 连接 id 生成器（测试可注入）。 */
  nextId?: () => string
}

const DEFAULT_RATE_LIMIT = 30
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024
const DEFAULT_HELLO_TIMEOUT_MS = 10_000
let connectionSeq = 0

function defaultNextId(): string {
  connectionSeq += 1
  return `c${connectionSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (Buffer.isBuffer(data)) return data
  return Buffer.from(data as ArrayBuffer)
}

export class Session {
  readonly id: string
  readonly ws: WebSocket
  readonly openedAt = Date.now()

  participantId: string | null = null
  roomCode: string | null = null
  /** 玩家昵称（hello 后写入）。 */
  name = ''

  alive = true

  private readonly hooks: SessionHooks
  private readonly rateLimitPerSecond: number
  private readonly maxFrameBytes: number
  private readonly helloTimeout: NodeJS.Timeout
  private readonly messageTimes: number[] = []
  private closed = false
  private helloDone = false

  constructor(ws: WebSocket, hooks: SessionHooks, options: SessionOptions = {}) {
    this.ws = ws
    this.hooks = hooks
    this.id = (options.nextId ?? defaultNextId)()
    this.rateLimitPerSecond = options.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES

    this.helloTimeout = setTimeout(() => {
      if (this.helloDone || this.closed) return
      this.sendError('BAD_MESSAGE', '握手超时：请先发送 hello', true)
      this.close(4002, 'hello timeout')
    }, options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS)
    this.helloTimeout.unref?.()

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        this.sendError('BAD_MESSAGE', '不支持二进制帧')
        return
      }
      this.handleFrame(data)
    })
    ws.on('pong', () => {
      this.alive = true
    })
    ws.on('close', () => {
      this.closed = true
      clearTimeout(this.helloTimeout)
      this.hooks.onClose(this)
    })
    ws.on('error', () => {
      // ws 在 TCP 异常时先发 error 再发 close；close 里会做清理。
    })
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === 1
  }

  get handshaken(): boolean {
    return this.helloDone
  }

  /** 标记 hello 已完成（版本不符时会直接 close，不标记）。 */
  markHelloDone(): void {
    this.helloDone = true
    clearTimeout(this.helloTimeout)
  }

  send(message: ServerMsg): boolean {
    if (!this.isOpen) return false
    try {
      this.ws.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  sendError(code: ErrorCode, message: string, fatal = false): void {
    this.send({ t: 'error', code, message, ...(fatal ? { fatal: true } : {}) })
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.helloTimeout)
    try {
      this.ws.close(code, reason)
    } catch {
      this.ws.terminate()
    }
  }

  /** 踢掉旧连接（resume 接管时用 4001，便于前端区分「被顶号」）。 */
  kick(reason = 'resumed'): void {
    this.sendError('NOT_AUTHORIZED', '连接已被新会话接管', true)
    this.close(4001, reason)
  }

  /** 每 30s 调一次：上一轮没回 pong 的直接断开，避免半开连接占名额。 */
  heartbeat(): void {
    if (this.closed) return
    if (!this.alive) {
      this.ws.terminate()
      return
    }
    this.alive = false
    try {
      this.ws.ping()
    } catch {
      // 忽略：close 事件会收尾
    }
  }

  private handleFrame(data: RawData): void {
    let buffer: Buffer
    try {
      buffer = toBuffer(data)
    } catch {
      this.sendError('BAD_MESSAGE', '无法读取消息帧')
      return
    }

    if (buffer.byteLength > this.maxFrameBytes) {
      this.sendError('BAD_MESSAGE', `消息过大：单帧上限 ${Math.round(this.maxFrameBytes / 1024)}KB`)
      return
    }

    // 限流在 JSON.parse 之前：解析本身也是 CPU 开销。
    if (!this.allowRate()) {
      this.sendError('RATE_LIMITED', '消息过于频繁，请稍后重试')
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(buffer.toString('utf8'))
    } catch {
      this.sendError('BAD_MESSAGE', '消息不是合法的 JSON')
      return
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.sendError('BAD_MESSAGE', '消息必须是 JSON 对象')
      return
    }
    const message = parsed as { t?: unknown }
    if (typeof message.t !== 'string') {
      this.sendError('BAD_MESSAGE', '消息缺少 t 字段')
      return
    }

    this.hooks.onMessage(this, parsed as ClientMsg)
  }

  private allowRate(): boolean {
    const now = Date.now()
    while (this.messageTimes.length > 0 && now - (this.messageTimes[0] as number) > 1000) {
      this.messageTimes.shift()
    }
    if (this.messageTimes.length >= this.rateLimitPerSecond) return false
    this.messageTimes.push(now)
    return true
  }
}
