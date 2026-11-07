/**
 * 测试用的 WS 客户端：消息队列 + 顺序等待 + 原始消息留存（泄漏断言用）。
 *
 * 每个 `waitFor` 只向后消费：一旦匹配到某条消息，游标移到它之后，
 * 之后再等同类消息不会拿到旧的那条。
 */

import { WebSocket } from 'ws'

import type { ClientMsg, ServerMsg } from '../src/core.ts'

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type RoomMessage = Extract<ServerMsg, { t: 'room' }>
export type LobbyMessage = Extract<ServerMsg, { t: 'lobby' }>
export type PaperMessage = Extract<ServerMsg, { t: 'paper' }>
export type AckMessage = Extract<ServerMsg, { t: 'ack' }>
export type ErrorMessage = Extract<ServerMsg, { t: 'error' }>
export type EndedMessage = Extract<ServerMsg, { t: 'ended' }>

export class TestClient {
  readonly ws: WebSocket
  readonly received: ServerMsg[] = []
  closed = false

  private cursor = 0
  private readonly waiters: Array<{
    predicate: (message: ServerMsg) => boolean
    resolve: (message: ServerMsg) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }> = []

  constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerMsg
      this.received.push(message)
      for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.waiters[index]
        if (!waiter || !waiter.predicate(message)) continue
        this.waiters.splice(index, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(message)
      }
    })
    ws.on('close', () => {
      this.closed = true
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('连接已关闭'))
      }
    })
    ws.on('error', () => {
      // 测试里由 waitFor/close 体现
    })
  }

  static async open(port: number): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const client = new TestClient(ws)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 打开超时')), 3000)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    return client
  }

  send(message: ClientMsg | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(message))
  }

  sendRaw(text: string): void {
    this.ws.send(text)
  }

  waitFor<T extends ServerMsg>(predicate: (message: ServerMsg) => message is T, timeoutMs?: number): Promise<T>
  waitFor(predicate: (message: ServerMsg) => boolean, timeoutMs?: number): Promise<ServerMsg>
  waitFor(
    predicate: (message: ServerMsg) => boolean,
    timeoutMs = 4000,
  ): Promise<ServerMsg> {
    for (let index = this.cursor; index < this.received.length; index += 1) {
      const message = this.received[index]
      if (message && predicate(message)) {
        this.cursor = index + 1
        return Promise.resolve(message)
      }
    }
    return new Promise<ServerMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.timer === timer)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error(`等待消息超时（已收到 ${this.received.map((m) => m.t).join(',')}）`))
      }, timeoutMs)
      this.waiters.push({
        predicate,
        resolve: (message) => {
          const index = this.received.lastIndexOf(message)
          this.cursor = index >= 0 ? index + 1 : this.cursor
          resolve(message)
        },
        reject,
        timer,
      })
    })
  }

  waitForType<T extends ServerMsg['t']>(type: T, timeoutMs = 4000): Promise<Extract<ServerMsg, { t: T }>> {
    return this.waitFor((message) => message.t === type, timeoutMs) as Promise<Extract<ServerMsg, { t: T }>>
  }

  /** 从 `fromIndex` 起的所有消息（泄漏/静默断言用）。 */
  since(fromIndex: number): ServerMsg[] {
    return this.received.slice(fromIndex)
  }

  messagesOfType<T extends ServerMsg['t']>(type: T): Extract<ServerMsg, { t: T }>[] {
    return this.received.filter((message) => message.t === type) as Extract<ServerMsg, { t: T }>[]
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      this.ws.terminate()
    }
  }

  async waitClosed(timeoutMs = 3000): Promise<void> {
    if (this.closed) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待连接关闭超时')), timeoutMs)
      this.ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

export interface Player {
  client: TestClient
  participantId: string
}

/** 建立连接并完成 hello。 */
export async function connectPlayer(port: number, name: string, options: { resume?: string; version?: number } = {}): Promise<Player> {
  const client = await TestClient.open(port)
  client.send({
    t: 'hello',
    v: options.version ?? 1,
    name,
    ...(options.resume ? { resume_id: options.resume } : {}),
  })
  const hello = await client.waitForType('hello_ok')
  return { client, participantId: hello.participant_id }
}

/** 走完「创建房间 + 建队」的最短路径，返回房主视角。 */
export async function createRoomAsHost(port: number, name: string, paperId = 'paper-team-solo-10'): Promise<Player & { roomCode: string; teamCode: string }> {
  const player = await connectPlayer(port, name)
  player.client.send({ t: 'create', format: paperId.includes('coop') ? 'team-coop' : 'team-solo', paper_id: paperId })
  const lobby = await player.client.waitForType('lobby')
  player.client.send({ t: 'new_team', name: '红队' })
  const teamLobby = await player.client.waitForType('lobby')
  const team = teamLobby.teams[0]
  if (!team?.code) throw new Error('新队伍没有拿到队伍码')
  return { ...player, roomCode: lobby.room_code, teamCode: team.code }
}
