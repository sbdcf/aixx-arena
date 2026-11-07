import {
  initMatch,
  isEnded,
  reduce,
  view,
  type MatchEvent,
  type MatchState,
  type MatchSummary,
  type PublicMatchState,
  type ReduceCtx,
  type ServerMsg,
} from '@aixx/core'
import type { Driver } from './types.ts'

export interface LocalDriverOptions {
  matchId: string
  /** 本浏览器里就是「本人」；联机时会换成服务端分配的 participant id */
  viewerId: string
  ctx: ReduceCtx
  /** 断点恢复：直接接着这份状态跑（组卷结果一并恢复，不会换题） */
  state?: MatchState | null
  /** 注入时钟，方便测试里把时间拨快 */
  now?: () => number
}

/**
 * 静态模式的驱动：在浏览器里跑与后端完全相同的 `reduce`。
 *
 * 它一个人演两个角色 —— 既是客户端（发 SUBMIT），又是「服务端」（收 SUBMIT 后推进状态、
 * 把 effects 合成为 ServerMsg 广播回来），所以 UI 看到的消息序列与联机时同构。
 */
export class LocalDriver implements Driver {
  readonly matchId: string

  private readonly viewerId: string
  private readonly ctx: ReduceCtx
  private readonly now: () => number

  private state: MatchState
  private seq: number
  private handlers = new Set<(message: ServerMsg) => void>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastSnapshot: PublicMatchState | null = null
  private lastSummary: MatchSummary | null = null
  private disposed = false

  constructor(options: LocalDriverOptions) {
    this.matchId = options.matchId
    this.viewerId = options.viewerId
    this.ctx = options.ctx
    this.now = options.now ?? (() => Date.now())
    this.state = options.state ?? initMatch(options.ctx, this.now())
    this.seq = this.currentSeq()
  }

  start(): void {
    if (this.disposed) return
    // 先送一个「此刻的 TICK」：buzz 在缓冲期靠它把题面推下去
    this.dispatch({ type: 'TICK', at: this.now() })
    this.publishRoom()
    this.scheduleTick()
  }

  submit(qid: string, choice: string[]): void {
    if (this.disposed || isEnded(this.state)) return
    this.seq += 1
    this.dispatch({ type: 'SUBMIT', at: this.now(), actor_id: this.viewerId, qid, choice, seq: this.seq })
  }

  submitAll(): void {
    if (this.disposed || isEnded(this.state)) return
    // team-coop 的 submit_all 语义是「本队交卷」：状态机靠 reason:'self' + actor 区分
    this.dispatch({ type: 'END', at: this.now(), actor_id: this.viewerId, reason: 'self' })
  }

  /** 团队赛推进题序（只有主答 / 队长会真正生效，越权由状态机拒绝） */
  advance(): void {
    if (this.disposed || isEnded(this.state)) return
    this.dispatch({ type: 'ADVANCE', at: this.now(), actor_id: this.viewerId })
  }

  /** 换主答：本地模式由本人（队长）操作，联机时服务端还会校验房主身份 */
  setAnswerer(memberId: string): void {
    if (this.disposed || isEnded(this.state)) return
    this.dispatch({ type: 'SET_ANSWERER', at: this.now(), actor_id: this.viewerId, member_id: memberId })
  }

  /** 接力交棒：把本棒剩余时间交给下一棒（越权/非当前棒由状态机拒绝） */
  handoff(): void {
    if (this.disposed || isEnded(this.state)) return
    this.dispatch({ type: 'HANDOFF', at: this.now(), actor_id: this.viewerId })
  }

  end(): void {
    if (this.disposed || isEnded(this.state)) return
    this.dispatch({ type: 'END', at: this.now(), reason: 'host' })
  }

  on(handler: (message: ServerMsg) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  dispose(): void {
    this.disposed = true
    this.handlers.clear()
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  snapshot(): PublicMatchState | null {
    return this.lastSnapshot
  }

  summary(): MatchSummary | null {
    return this.lastSummary
  }

  /** 断点续做时把状态机内部状态写回存储用 */
  stateForSave(): MatchState {
    return this.state
  }

  private currentSeq(): number {
    const sheets = (this.state as { sheets?: Record<string, { last_seq?: number }> }).sheets
    return sheets?.[this.viewerId]?.last_seq ?? 0
  }

  private dispatch(event: MatchEvent): void {
    const { state, effects } = reduce(this.state, event, this.ctx)
    this.state = state

    for (const message of effects.broadcast ?? []) this.emit(message)
    for (const entry of effects.to_member ?? []) {
      if (entry.member_id !== this.viewerId) continue
      for (const message of entry.messages) this.emit(message)
    }
    for (const entry of effects.to_team ?? []) {
      // 本地模式一队一人，队伍消息等同本人消息；联机驱动会按队伍路由
      for (const message of entry.messages) this.emit(message)
    }

    this.publishRoom()

    if (isEnded(this.state)) {
      this.clearTimer()
      return
    }
    this.scheduleTick()
  }

  private publishRoom(): void {
    const snapshot = view(this.state, this.viewerId, this.now())
    this.lastSnapshot = snapshot
    this.emit({ t: 'room', snapshot })
  }

  private emit(message: ServerMsg): void {
    if (message.t === 'ended') this.lastSummary = message.summary
    for (const handler of [...this.handlers]) handler(message)
  }

  /**
   * 定时器只有一种：到 cutoff 送 TICK。
   * reduce 侧对 TICK 是幂等的（`at >= deadline_at` 才结算，重复 TICK 无副作用），
   * 所以这里不需要精确对齐，只要「不早于截止」即可。
   */
  private scheduleTick(): void {
    this.clearTimer()
    if (this.disposed || isEnded(this.state)) return
    const deadline = this.state.deadline_at
    const delay = Math.max(0, deadline - this.now()) + 20
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.disposed || isEnded(this.state)) return
      this.dispatch({ type: 'TICK', at: this.now() })
      // 若早到（TICK 未触发结算）则继续等
      if (!isEnded(this.state)) this.scheduleTick()
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
