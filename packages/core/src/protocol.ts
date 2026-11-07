/**
 * 前后端共用的协议类型（docs/design.md §5.8 / §5.9）。
 *
 * 纪律：
 * - 全链路 snake_case，直接与磁盘 JSON、WS 帧同名同形。
 * - `ack` 永远不带 `answer` / `explain`；答案只能从 `reveal` 出。
 * - LocalDriver 必须合成同构的 ServerMsg —— UI 不允许区分消息来源。
 */

import type { FormatId, QuestionType } from './types.ts'
import type { MatchSummary, PeerInfo, PublicMatchState } from './public.ts'

/** 前后端不一致直接拒绝连接（FR-51）。 */
export const PROTOCOL_VERSION = 1

/**
 * 联机模式下发给客户端的一道题（v0.6 新增）。
 *
 * 只带题面与选项：`answer` / `explain` 永远不进这个类型，答案只能从 `reveal` 出。
 * `difficulty` / `taxonomy` / `source` 是题面徽标用的展示字段，缺省时前端不显示。
 */
export interface PaperQuestion {
  id: string
  type: QuestionType
  stem: string
  stem_images?: string[]
  options: { key: string; text: string }[]
  difficulty?: number
  taxonomy?: string[]
  source?: string
}

/** 大厅里的一支队伍（v0.6 新增）。`code` 只发给本队成员。 */
export interface LobbyTeam {
  id: string
  name: string
  captain_id: string
  code?: string
  /** relay：赛前棒次顺序（队长可调，开赛固化）；非 relay 为空/缺省 */
  leg_order?: string[]
  members: { id: string; name: string; ready: boolean; online: boolean }[]
}

export type ErrorCode =
  | 'BAD_MESSAGE'
  | 'VERSION_MISMATCH'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_STARTED'
  | 'TEAM_NOT_FOUND'
  | 'NOT_AUTHORIZED'
  | 'ALREADY_SUBMITTED'
  | 'WINDOW_CLOSED'
  | 'STALE_SEQ'
  | 'RATE_LIMITED'
  | 'INTERNAL'

export type ClientMsg =
  | { t: 'hello'; v: number; name: string; resume_id?: string }
  | { t: 'create'; format: FormatId; paper_id: string }
  | { t: 'join'; room_code: string }
  | { t: 'new_team'; name: string }
  | { t: 'join_team'; team_code: string }
  | { t: 'ready'; value: boolean }
  | { t: 'start' }
  | { t: 'submit'; qid: string; seq: number; choice: string[] }
  | { t: 'advance' }
  | { t: 'handoff' }
  | { t: 'submit_all' }
  | { t: 'end' }
  | { t: 'set_answerer'; member_id: string }
  | { t: 'set_leg_order'; order: string[] }
  | { t: 'ping'; t0: number }
  | { t: 'feedback'; qid: string; reason: string }
  | { t: 'leave' }

export type ServerMsg =
  | { t: 'hello_ok'; participant_id: string; server_at: number; version: string; protocol: number }
  | {
      /** 大厅状态：还没开局时只有它；开局后仍会随人员变动重发 */
      t: 'lobby'
      room_code: string
      format: FormatId
      paper_id: string
      host_id: string
      started: boolean
      viewer_id: string
      /** 自己所在的队伍（没分队时为 null） */
      team_id: string | null
      teams: LobbyTeam[]
      /** 未分队的散人 */
      waiting: { id: string; name: string; ready: boolean }[]
    }
  | { t: 'paper'; questions: PaperQuestion[] }
  | { t: 'room'; snapshot: PublicMatchState }
  | {
      t: 'question'
      index: number
      total: number
      qid: string
      type: QuestionType
      stem: string
      stem_images?: string[]
      options: { key: string; text: string }[]
      buffer_ms: number
      deadline_at: number
    }
  | {
      t: 'ack'
      seq: number
      qid: string
      accepted: boolean
      locked: boolean
      correct?: boolean
      points?: number
    }
  | { t: 'reveal'; items: { qid: string; answer: string[]; explain?: string }[] }
  | { t: 'peer'; members: PeerInfo[]; ready_count: number }
  | { t: 'score'; teams: { id: string; name: string; score: number }[] }
  | { t: 'sync'; server_at: number }
  | { t: 'notice'; text: string }
  | { t: 'ended'; summary: MatchSummary }
  | { t: 'error'; code: ErrorCode; message: string; fatal?: boolean }
  | { t: 'pong'; t0: number; server_at: number }
