/**
 * 按人答卷（`Sheet`）的共用逻辑。
 *
 * solo（赛制 1）与 team-solo（赛制 2）的作答/提交/判分规则完全一致，
 * 只在 `summarize` 上分叉（按人出成绩 vs 按队聚合）。design.md §5.6 明确要求
 * 「不做两份实现」——两份实现迟早会在 batch/stream 的细节上漂移。
 */

import type { Effects, MatchEvent, MatchStateBase, ReduceCtx } from '../state.ts'
import type { MatchSummary } from '../public.ts'
import type { ErrorCode, ServerMsg } from '../protocol.ts'
import { judge, normalizeChoice } from '../scoring.ts'

export interface SheetAnswer {
  choice: string[]
  at: number
  seq: number
}

export interface Sheet {
  answers: Record<string, SheetAnswer>
  /** 仅 stream 模式：提交即锁，不能回改 */
  locked: string[]
  /** 每个 participant 每局单调递增（§5.9），用于重连补发幂等 */
  last_seq: number
  /** 本人封卷时间（design §5.5.1：team-solo 各成员分别封卷，全员封卷才结算） */
  finished_at?: number
}

export type SheetState = MatchStateBase & { sheets: Record<string, Sheet> }

export function emptySheet(): Sheet {
  return { answers: {}, locked: [], last_seq: 0 }
}

export function initSheets(roster: { teams: { member_ids: string[] }[] }): Record<string, Sheet> {
  const sheets: Record<string, Sheet> = {}
  for (const team of roster.teams) {
    for (const memberId of team.member_ids) sheets[memberId] = emptySheet()
  }
  return sheets
}

export function errorTo(memberId: string, code: ErrorCode, message: string): {
  member_id: string
  messages: ServerMsg[]
} {
  return { member_id: memberId, messages: [{ t: 'error', code, message }] }
}

/** 结算时下发的逐题答案（不含题干与选项，题干在客户端本地本来就有一份） */
export function revealItems(ctx: ReduceCtx): { qid: string; answer: string[]; explain?: string }[] {
  return ctx.questions.map((q) => ({ qid: q.id, answer: q.answer, explain: q.explain }))
}

/**
 * SUBMIT 的共用实现：batch 逐题静默上报（可回改、不判分），stream 提交即锁（ack 带 correct）。
 */
export function applySubmit<S extends { sheets: Record<string, Sheet> }>(
  state: S,
  event: MatchEvent,
  ctx: ReduceCtx,
): { state: S; effects: Effects } {
  const actorId = event.actor_id
  const sheet = actorId ? state.sheets[actorId] : undefined
  if (!actorId || !sheet) {
    return {
      state,
      effects: { log: [{ at: event.at, event: 'submit_not_authorized', participant_id: actorId }] },
    }
  }

  const qid = event.qid
  if (!qid || !ctx.questions.some((q) => q.id === qid)) {
    return { state, effects: { to_member: [errorTo(actorId, 'BAD_MESSAGE', '未知题号')] } }
  }

  // 已封卷：封卷是不可逆动作，后续提交一律拒绝（不静默吞掉，免得客户端以为还在答）
  if (sheet.finished_at) {
    return {
      state,
      effects: {
        to_member: [
          {
            member_id: actorId,
            messages: [{ t: 'error', code: 'WINDOW_CLOSED', message: '你已封卷，等待队友完成' }],
          },
        ],
      },
    }
  }

  const seq = event.seq ?? sheet.last_seq + 1
  // 补发乱序 / 重放：静默丢弃，不回 ack（§5.9）
  if (seq <= sheet.last_seq) {
    return {
      state,
      effects: {
        log: [{ at: event.at, event: 'stale_seq', participant_id: actorId, qid, data: { seq, last_seq: sheet.last_seq } }],
      },
    }
  }

  const choice = normalizeChoice(event.choice ?? [])

  // stream：提交即锁，重复提交幂等（不再判分）
  if (ctx.paper.submit_mode === 'stream') {
    if (sheet.locked.includes(qid)) {
      return {
        state,
        effects: {
          to_member: [{ member_id: actorId, messages: [{ t: 'ack', seq, qid, accepted: false, locked: true }] }],
        },
      }
    }
    const question = ctx.questions.find((q) => q.id === qid)!
    const judged = judge({ question, choice, scoring: ctx.paper.scoring, answered: true })
    const nextSheet: Sheet = {
      ...sheet,
      answers: { ...sheet.answers, [qid]: { choice, at: event.at, seq } },
      locked: [...sheet.locked, qid],
      last_seq: seq,
    }
    return {
      state: { ...state, sheets: { ...state.sheets, [actorId]: nextSheet } },
      effects: {
        to_member: [
          {
            member_id: actorId,
            messages: [
              { t: 'ack', seq, qid, accepted: true, locked: true, correct: judged.correct, points: judged.points },
            ],
          },
        ],
      },
    }
  }

  // batch：逐题静默上报（可回改），不判分、不回 correct
  const nextSheet: Sheet = {
    ...sheet,
    answers: { ...sheet.answers, [qid]: { choice, at: event.at, seq } },
    last_seq: seq,
  }
  return {
    state: { ...state, sheets: { ...state.sheets, [actorId]: nextSheet } },
    effects: {
      to_member: [{ member_id: actorId, messages: [{ t: 'ack', seq, qid, accepted: true, locked: false }] }],
    },
  }
}

/**
 * FINISH = 本人封卷（design §5.5.1）。
 *
 * - 单人局（solo）：封卷即全场结算 `all_done`；
 * - 团队局（team-solo）：只封自己那一份，全员封卷才结算，早交的人收到 notice 等队友。
 *
 * 封卷之后 SUBMIT 会被拒（见上），所以「封卷」比「不交」更严格：
 * 它表达「我确定不再改了」，而不是「我先放着」。
 */
export function applyFinish<S extends SheetState>(
  state: S,
  event: MatchEvent,
  ctx: ReduceCtx,
  summarize: (state: S, ctx: ReduceCtx) => MatchSummary,
): { state: S; effects: Effects } {
  const actorId = event.actor_id
  const sheet = actorId ? state.sheets[actorId] : undefined
  if (!actorId || !sheet) {
    return {
      state,
      effects: { log: [{ at: event.at, event: 'finish_not_authorized', participant_id: actorId }] },
    }
  }
  if (sheet.finished_at) {
    return {
      state,
      effects: {
        to_member: [
          { member_id: actorId, messages: [{ t: 'notice', text: '你已经封卷，正在等队友完成' }] },
        ],
      },
    }
  }

  const sheets = { ...state.sheets, [actorId]: { ...sheet, finished_at: event.at } }
  const next = { ...state, sheets }
  const finished = Object.values(sheets).filter((item) => item.finished_at)
  if (finished.length === Object.keys(sheets).length) {
    return endSheetMatch(next, event.at, 'all_done', ctx, summarize)
  }
  return {
    state: next,
    effects: {
      to_member: [
        {
          member_id: actorId,
          messages: [
            { t: 'notice', text: `你已封卷，${finished.length}/${Object.keys(sheets).length} 人完成，等待队友` },
          ],
        },
      ],
      log: [{ at: event.at, event: 'sheet_finished', participant_id: actorId }],
    },
  }
}

/**
 * 结算：把 state 置 ended，广播 summary，并逐人下发 reveal。
 * `summarize` 由调用方传入（solo 按人、team-solo 按队）。
 */
export function endSheetMatch<S extends SheetState>(
  state: S,
  at: number,
  reason: MatchStateBase['end_reason'],
  ctx: ReduceCtx,
  summarize: (state: S, ctx: ReduceCtx) => MatchSummary,
): { state: S; effects: Effects } {
  const ended: S = { ...state, phase: 'ended', ended_at: at, end_reason: reason ?? 'self' }
  const summary = summarize(ended, ctx)
  const items = revealItems(ctx)

  const toMember = Object.keys(ended.sheets).map((memberId) => ({
    member_id: memberId,
    messages: [{ t: 'reveal', items }] as ServerMsg[],
  }))

  return {
    state: ended,
    effects: {
      broadcast: [{ t: 'ended', summary }],
      to_member: toMember,
      log: [{ at, event: 'match_ended', data: { reason: ended.end_reason } }],
    },
  }
}
