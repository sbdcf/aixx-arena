/**
 * 对外可见的对局视图与结算类型（docs/design.md §5.5）。
 *
 * 这一层的存在意义是「答案不出现在任何会被广播的对象里」：
 * PublicXxx 可以发给所有人，MatchSummary 只在 ended 时下发（含答案，供成绩页复盘）。
 */

import type { FormatId, QuestionType } from './types.ts'

export type EndReason = 'time' | 'host' | 'self' | 'all_done'

export interface PeerInfo {
  id: string
  name: string
  team_id: string
  online: boolean
  ready: boolean
  progress: { answered: number; total: number }
  is_answerer: boolean
  /** 仅 relay 有意义：该成员当前是第几棒（0/1/2） */
  leg_index?: number
}

export interface OwnView {
  /** 视角主体：member = 本人（solo / team-solo），team = 本队（team-coop / relay / buzz） */
  scope: 'member' | 'team'
  /** 该视角下已提交的题；team 视角 = 本队共享答卷（三端一致） */
  answers: Record<string, string[]>
  locked: string[]
  /** 当前观众此刻能否提交（辅助位 / 非当前棒 = false，UI 据此禁用按钮） */
  can_submit: boolean
  /** 本人（member 视角）是否已封卷：封卷后只能看题、不能再改 */
  finished?: boolean
}

export interface PublicBase {
  format: FormatId
  phase: string
  /** 服务端（或 LocalDriver 的本地时钟）此刻的时间，客户端据此算偏移 */
  server_at: number
  clock: {
    started_at: number
    deadline_at: number
    /** relay：本棒截止 */
    leg_deadline_at?: number
    /** buzz：本题开抢截止 */
    submit_deadline_at?: number
    /** buzz：本题解析停留结束 */
    reveal_end_at?: number
  }
  /** null = 该赛制的题序游标在客户端 */
  current_index: number | null
  total: number
  viewer_id: string | null
  own: OwnView
  peers: PeerInfo[]
  scores?: { team_id: string; name: string; score: number }[]
  notice?: string
}

export type PublicMatchState =
  | (PublicBase & { format: 'solo' })
  | (PublicBase & { format: 'team-solo'; team: { id: string; answered: number; total: number } })
  | (PublicBase & { format: 'team-coop'; team_id: string; answerer_id: string })
  | (PublicBase & {
      format: 'relay'
      team_id: string
      leg_index: number
      leg_order: string[]
      current_answerer_id: string
    })
  | (PublicBase & { format: 'buzz'; q_index: number; n_at_open: number; submitted_teams: string[]; quota: number })

export interface TeamResult {
  id: string
  name: string
  score: number
  max_score: number
  members: { id: string; name: string; score: number; answered: number; correct: number }[]
  detail: {
    qid: string
    leg_index?: number
    choice: string[] | null
    correct: boolean
    points: number
    /** 断线补交的延迟毫秒数，复盘标黄 */
    late_by_ms?: number
  }[]
}

export interface MatchSummary {
  format: FormatId
  started_at: number
  ended_at: number
  end_reason: EndReason
  teams: TeamResult[]
  questions: { qid: string; type: QuestionType; answer: string[]; explain?: string; scored: boolean }[]
  /** 组卷降级提示（"本卷 40/55 题有答案"），原样带给成绩页 */
  degraded_notice?: string
  buzz_per_question?: {
    qid: string
    n_at_open: number
    quota: number
    close_reason: 'timeout' | 'all_submitted'
    ranking: { team_id: string; at: number; correct: boolean; rank: number; tied: boolean; awarded: number }[]
  }[]
}

export interface LogEntry {
  at: number
  /** room_created / join / early_submit / auto_submit / handoff / buzz_missed ... */
  event: string
  participant_id?: string
  team_id?: string
  qid?: string
  data?: Record<string, unknown>
}
