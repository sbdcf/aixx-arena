/**
 * 对局驱动器：把 `@aixx/core` 的纯函数状态机接到 WS 广播上。
 *
 * 只做四件事（其余都在 core 里）：
 * 1. 把客户端消息翻译成 `MatchEvent` 后调 `reduce`；
 * 2. 把 `Effects` 映射到具体收件人（broadcast / to_team / to_member）；
 * 3. 按 `effects.timers` 与 `state.deadline_at` 设 setTimeout，到点补 `TICK`；
 * 4. 每次 reduce 后给房内每个在线参与者重发个性化 `room` 快照。
 *
 * 答案纪律由 core 保证：`ack`/`room` 的类型里没有 answer，只有 `reveal` 和
 * `ended.summary` 带答案。驱动器不拼任何答案字段。
 */

import type { LogEntry, MatchEvent, MatchState, PublicMatchState, ReduceCtx, ServerMsg } from './core.ts'
import { isEnded, reduce, view } from './core.ts'

export interface DriverHooks {
  /** 发给某个参与者（离线/已断开时由 host 侧静默丢弃）。 */
  sendTo: (participantId: string, message: ServerMsg) => void
  /** 当前房内在线的参与者 id 列表（broadcast 用）。 */
  onlineIds: () => string[]
  /** 某人是否在线（room 快照的 peers.online 用）。 */
  onlineOf: (participantId: string) => boolean
  /** 追加房间日志（内存，供排障/复盘）。 */
  log: (entry: LogEntry) => void
  /** 对局从「进行中」变为「已结束」时回调一次（含定时器触发的超时结束）。 */
  onEnded?: () => void
}

const MAX_TIMER_DELAY = 2_147_483_647

export class MatchDriver {
  state: MatchState
  readonly ctx: ReduceCtx
  private readonly hooks: DriverHooks
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private disposed = false

  constructor(ctx: ReduceCtx, state: MatchState, hooks: DriverHooks) {
    this.ctx = ctx
    this.state = state
    this.hooks = hooks
  }

  get ended(): boolean {
    return isEnded(this.state)
  }

  /** 开局后调用：先送一个「此刻的 TICK」，让需要立刻推题的赛制（buzz 缓冲期）出手；
   *  再按 state 里的 deadline 设第一个定时器，并广播首帧 room。 */
  start(): void {
    this.handle({ type: 'TICK', at: Date.now() })
    this.scheduleDeadline()
    this.broadcastRoom()
  }

  handle(event: MatchEvent): void {
    if (this.disposed || this.ended) return
    const at = Number.isFinite(event.at) ? event.at : Date.now()
    const wasEnded = this.ended

    let result: { state: MatchState; effects: import('./core.ts').Effects }
    try {
      result = reduce(this.state, { ...event, at }, this.ctx)
    } catch (error) {
      this.hooks.log({ at, event: 'reduce_error', data: { message: String(error) } })
      throw error
    }

    this.state = result.state
    this.applyEffects(result.effects)

    if (this.ended) this.clearTimers()
    else this.scheduleDeadline()

    this.broadcastRoom()
    if (!wasEnded && this.ended) this.hooks.onEnded?.()
  }

  /** 房间快照：先取 core 的个性化视图，再把 peers.online 换成真实连接状态。 */
  snapshotFor(participantId: string): PublicMatchState {
    const at = Date.now()
    const snapshot = view(this.state, participantId, at)
    return {
      ...snapshot,
      peers: snapshot.peers.map((peer) => ({ ...peer, online: this.hooks.onlineOf(peer.id) })),
      server_at: at,
    }
  }

  broadcastRoom(): void {
    if (this.disposed) return
    const at = Date.now()
    for (const participantId of this.hooks.onlineIds()) {
      const snapshot = view(this.state, participantId, at)
      this.hooks.sendTo(participantId, {
        t: 'room',
        snapshot: {
          ...snapshot,
          peers: snapshot.peers.map((peer) => ({ ...peer, online: this.hooks.onlineOf(peer.id) })),
          server_at: at,
        },
      })
    }
  }

  /** 重连补发用：把当前 room 快照发给一个人。 */
  sendRoomTo(participantId: string): void {
    this.hooks.sendTo(participantId, { t: 'room', snapshot: this.snapshotFor(participantId) })
  }

  dispose(): void {
    this.disposed = true
    this.clearTimers()
  }

  private applyEffects(effects: import('./core.ts').Effects): void {
    for (const message of effects.broadcast ?? []) {
      for (const participantId of this.hooks.onlineIds()) this.hooks.sendTo(participantId, message)
    }

    for (const item of effects.to_team ?? []) {
      const team = this.ctx.roster.teams.find((candidate) => candidate.id === item.team_id)
      if (!team) continue
      for (const memberId of team.member_ids) {
        for (const message of item.messages) this.hooks.sendTo(memberId, message)
      }
    }

    for (const item of effects.to_member ?? []) {
      for (const message of item.messages) this.hooks.sendTo(item.member_id, message)
    }

    for (const timer of effects.timers ?? []) this.scheduleTimer(timer.key, timer.at)

    for (const entry of effects.log ?? []) this.hooks.log(entry)
  }

  private scheduleDeadline(): void {
    const deadline = this.state.deadline_at
    if (typeof deadline === 'number' && Number.isFinite(deadline) && deadline > 0) {
      this.scheduleTimer('deadline', deadline)
    }
  }

  /**
   * 每个 key 只保留一个定时器：重复调度会先清掉旧的。
   * 到点不判断「是否还来得及」，直接补 TICK —— core 用 deadline_at 结算，迟到的 TICK 也安全。
   */
  private scheduleTimer(key: string, at: number): void {
    if (this.disposed) return
    const previous = this.timers.get(key)
    if (previous) clearTimeout(previous)

    const delay = Math.min(Math.max(0, at - Date.now()), MAX_TIMER_DELAY)
    const timer = setTimeout(() => {
      this.timers.delete(key)
      if (this.disposed) return
      this.hooks.log({ at, event: 'tick', data: { key } })
      this.handle({ type: 'TICK', at })
    }, delay)
    // 不要让定时器单独把进程钉住；http server 自己会 keep-alive。
    timer.unref?.()
    this.timers.set(key, timer)
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
