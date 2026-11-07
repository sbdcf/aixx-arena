import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@aixx/core'

/**
 * 联机驱动：只负责「一条 WS 连接 + 帧的收发与重连」，不认识任何赛制规则。
 *
 * 与 LocalDriver 的分工：本地驱动在浏览器里跑 reduce，这条只是搬运。
 * 两者的输出都是 ServerMsg —— 页面不区分消息来源（design.md §6.2）。
 *
 * 重连：服务端认 `resume_id`（participant_id），30s 内重连可以接着答；
 * 这里用退避重试（1s/2s/4s/8s/最长 10s）自动接管，页面不用写重连逻辑。
 */
export interface ServerDriverOptions {
  /** 形如 http://192.168.1.5:8787 或 https://arena.example.com */
  serverUrl: string
  name: string
  onMessage: (message: ServerMsg) => void
  onStatus?: (status: ServerStatus) => void
}

export interface ServerStatus {
  connected: boolean
  /** 正在重连 / 被服务端踢掉时的原因 */
  detail: string
  /** 最近一次测得的服务端时钟偏移（毫秒，server - local） */
  clockOffset: number
}

function wsUrl(serverUrl: string): string {
  const base = serverUrl.replace(/\/+$/, '')
  if (base.startsWith('wss://')) return `${base}/ws`
  if (base.startsWith('https://')) return `${base.replace(/^https:\/\//, 'wss://')}/ws`
  if (base.startsWith('http://')) return `${base.replace(/^http:\/\//, 'ws://')}/ws`
  // 只给了主机名或 IP
  return `ws://${base}/ws`
}

export class ServerDriver {
  readonly matchId = ''
  private readonly options: ServerDriverOptions
  private socket: WebSocket | null = null
  private handlers = new Set<(message: ServerMsg) => void>()
  private status: ServerStatus = { connected: false, detail: '未连接', clockOffset: 0 }
  private participantId = ''
  private retry = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private pending: ClientMsg[] = []
  /** 答案的单调 seq：同一毫秒里连答两题也不会撞号（服务端按 seq 单调判 STALE_SEQ） */
  private seq = 0

  private nextSeq(): number {
    this.seq = Math.max(Date.now(), this.seq + 1)
    return this.seq
  }

  constructor(options: ServerDriverOptions) {
    this.options = options
    this.handlers.add(options.onMessage)
    if (options.onStatus) this.emitStatus = options.onStatus
  }

  private emitStatus: (status: ServerStatus) => void = () => {}

  get participant(): string {
    return this.participantId
  }

  get connection(): ServerStatus {
    return this.status
  }

  on(handler: (message: ServerMsg) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  connect(): void {
    if (this.disposed) return
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return
    this.setStatus(false, this.retry > 0 ? `正在重连（第 ${this.retry} 次）…` : '正在连接…')
    let socket: WebSocket
    try {
      socket = new WebSocket(wsUrl(this.options.serverUrl))
    } catch (error) {
      this.setStatus(false, `地址不可用：${String(error)}`)
      this.scheduleRetry()
      return
    }
    this.socket = socket
    socket.onopen = () => {
      this.retry = 0
      this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.options.name, resume_id: this.participantId || undefined })
      const queued = this.pending.splice(0)
      for (const message of queued) this.send(message)
    }
    socket.onmessage = (event) => {
      let message: ServerMsg
      try {
        message = JSON.parse(String(event.data)) as ServerMsg
      } catch {
        return
      }
      this.handle(message)
    }
    socket.onerror = () => {
      this.setStatus(false, '连接出错（检查地址 / 端口 / 防火墙）')
    }
    socket.onclose = (event) => {
      this.socket = null
      if (this.pingTimer) {
        clearInterval(this.pingTimer)
        this.pingTimer = null
      }
      if (this.disposed) return
      this.setStatus(false, event.reason ? `连接已断开：${event.reason}` : '连接已断开，正在重连…')
      this.scheduleRetry()
    }
  }

  private handle(message: ServerMsg): void {
    if (message.t === 'hello_ok') {
      this.participantId = message.participant_id
      this.setStatus(true, '已连接')
      this.startPing()
    }
    if (message.t === 'pong') {
      const rtt = Date.now() - message.t0
      this.status = { ...this.status, clockOffset: message.server_at - (message.t0 + rtt / 2) }
    }
    if (message.t === 'sync') {
      this.status = { ...this.status, clockOffset: message.server_at - Date.now() }
    }
    if (message.t === 'error') {
      if (message.fatal) {
        this.disposed = true
        this.setStatus(false, message.message)
      } else {
        this.setStatus(this.status.connected, message.message)
      }
    }
    for (const handler of this.handlers) handler(message)
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => this.send({ t: 'ping', t0: Date.now() }), 10_000)
    this.send({ t: 'ping', t0: Date.now() })
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer) return
    this.retry += 1
    const delay = Math.min(10_000, 1000 * 2 ** (this.retry - 1))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private setStatus(connected: boolean, detail: string): void {
    this.status = { ...this.status, connected, detail }
    this.emitStatus(this.status)
  }

  send(message: ClientMsg): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
      return
    }
    // 没连上时把「建队 / 准备 / 开局」这类意图排队，连上后按序补发；答案类不排队
    if (!['hello', 'submit', 'submit_all', 'advance', 'handoff', 'set_answerer', 'ping'].includes(message.t)) {
      this.pending.push(message)
    }
  }

  /* ===== 大厅动作 ===== */

  createRoom(format: string, paperId: string): void {
    this.send({ t: 'create', format: format as never, paper_id: paperId })
  }

  joinRoom(roomCode: string): void {
    this.send({ t: 'join', room_code: roomCode })
  }

  newTeam(name: string): void {
    this.send({ t: 'new_team', name })
  }

  joinTeam(teamCode: string): void {
    this.send({ t: 'join_team', team_code: teamCode })
  }

  setReady(value: boolean): void {
    this.send({ t: 'ready', value })
  }

  /** relay：队长赛前调整本队棒次（服务端校验全排列） */
  setLegOrder(order: string[]): void {
    this.send({ t: 'set_leg_order', order })
  }

  startMatch(): void {
    this.send({ t: 'start' })
  }

  leave(): void {
    this.send({ t: 'leave' })
  }

  /* ===== 对局动作（与 LocalDriver 同名同义） ===== */

  submit(qid: string, choice: string[]): void {
    // seq 用「毫秒时间戳 + 自增」：刷新页面后仍然单调递增，同一毫秒连答也不会被 STALE_SEQ 误杀
    this.send({ t: 'submit', qid, seq: this.nextSeq(), choice })
  }

  submitAll(): void {
    this.send({ t: 'submit_all' })
  }

  advance(): void {
    this.send({ t: 'advance' })
  }

  setAnswerer(memberId: string): void {
    this.send({ t: 'set_answerer', member_id: memberId })
  }

  handoff(): void {
    this.send({ t: 'handoff' })
  }

  end(): void {
    this.send({ t: 'end' })
  }

  feedback(qid: string, reason: string): void {
    this.send({ t: 'feedback', qid, reason })
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    try {
      this.socket?.close(1000, 'bye')
    } catch {
      // 已经关了就算了
    }
    this.socket = null
    this.handlers.clear()
  }
}
