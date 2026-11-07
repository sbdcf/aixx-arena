/**
 * 赛制状态机契约（docs/design.md §5.4）。
 *
 * 硬约束（改这里之前先想清楚）：
 * 1. `reduce` 是纯函数：不读系统时间（时间只能从 `event.at` 来）、不产生副作用（网络/定时器/日志都进 `effects`）。
 * 2. 定时器一律是「绝对 deadline + TICK」，驱动负责把 TICK 在正确时刻送进来；这样重复 TICK 是幂等的。
 * 3. 前端 `LocalDriver` 与后端 `room` 调的是同一份 `reduce`，否则两套规则必然漂移（AC-11）。
 */

import type { FormatId, Paper, Question } from './types.ts'
import type { EndReason, LogEntry, MatchSummary, PublicMatchState } from './public.ts'
import type { ServerMsg } from './protocol.ts'

export interface MatchEvent {
  type: 'START' | 'SUBMIT' | 'FINISH' | 'ADVANCE' | 'HANDOFF' | 'SET_ANSWERER' | 'TICK' | 'END'
  /** epoch ms，由驱动注入 —— 状态机内部不读 Date.now() */
  at: number
  /** 谁触发（成员 id） */
  actor_id?: string
  team_id?: string
  qid?: string
  choice?: string[]
  /** SET_ANSWERER 的目标成员 */
  member_id?: string
  reason?: EndReason
  /** 客户端自增序号，仅 SUBMIT 需要 */
  seq?: number
}

export interface RosterTeam {
  id: string
  name: string
  member_ids: string[]
  captain_id: string
  /** relay：队长赛前指定的棒次顺序（member_ids 的一个排列）；缺省按队长首位 + 加入顺序 */
  leg_order?: string[]
}

/** 开赛瞬间固化进 state 的成员快照；开赛后不再变动（重连快照自足）。 */
export interface Roster {
  teams: RosterTeam[]
  /** 成员显示名；缺省回退成 id（静态模式的占位成员可以不给） */
  names?: Record<string, string>
}

export interface ReduceCtx {
  paper: Paper
  /** 已组卷；接力已按棒切分进 state，这里仍是全量顺序卷 */
  questions: Question[]
  /** 由驱动构造（服务端 = 房间成员；静态 = LocalDriver 自己造，见 §6.5） */
  roster: Roster
  /** 组卷降级提示，放到 summary.degraded_notice */
  degraded_notice?: string
}

export interface Effects {
  broadcast?: ServerMsg[]
  to_team?: { team_id: string; messages: ServerMsg[] }[]
  to_member?: { member_id: string; messages: ServerMsg[] }[]
  /** 绝对时刻；驱动负责设/清定时器 */
  timers?: { key: string; at: number }[]
  log?: LogEntry[]
}

/**
 * 所有赛制状态共有的字段。
 * `total` / `notice` 不在 §5.4 的原始定义里：`view(state, viewer_id)` 拿不到 ctx，
 * 却必须给出 `PublicBase.total` 与组卷提示，所以在 init 时固化进 state。
 */
export interface MatchStateBase {
  format: FormatId
  roster: Roster
  phase: string
  started_at: number
  deadline_at: number
  ended_at?: number
  end_reason?: EndReason
  /** 本局题量（view 需要，不能依赖 ctx） */
  total: number
  notice?: string
}

export interface FormatSpec<S extends MatchStateBase> {
  id: FormatId
  init(ctx: ReduceCtx, at: number): S
  reduce(state: S, event: MatchEvent, ctx: ReduceCtx): { state: S; effects: Effects }
  /** 剥离答案、按视角裁剪后的状态；roster 已在 state 里，不需要 ctx。
   *  `at` 由驱动传入（view 同样不许读系统时间，`server_at` 才可复现）。 */
  view(state: S, viewer_id: string | null, at: number): PublicMatchState
  is_ended(state: S): boolean
  summarize(state: S, ctx: ReduceCtx): MatchSummary
}

/** 五种赛制状态，房间只持有一个判别联合（P2：solo / team-solo / team-coop；P4：relay；P5：buzz）。 */
export type MatchState =
  | import('./formats/solo.ts').SoloState
  | import('./formats/teamSolo.ts').TeamSoloState
  | import('./formats/teamCoop.ts').TeamCoopState
  | import('./formats/relay.ts').RelayState
  | import('./formats/buzz.ts').BuzzState
