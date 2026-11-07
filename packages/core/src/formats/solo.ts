/**
 * 赛制 1：个人客观题（校赛，55 题 60 分钟）。
 *
 * 作答与提交规则在 `sheet.ts`（与赛制 2 共用），这里只保留 solo 特有部分：
 * - 题序游标在客户端，`ADVANCE` / `HANDOFF` / `SET_ANSWERER` 都无意义；
 * - `summarize` 按人出成绩（每人一条 TeamResult，id = member_id）。
 */

import type { Effects, FormatSpec, MatchEvent, MatchStateBase, ReduceCtx } from '../state.ts'
import type { MatchSummary, PeerInfo, PublicMatchState, TeamResult } from '../public.ts'
import { isScorable, judge, maxRawPoints, normalizeScore } from '../scoring.ts'
import { applyFinish, applySubmit, endSheetMatch, initSheets, type Sheet } from './sheet.ts'

export type { Sheet, SheetAnswer } from './sheet.ts'

export interface SoloState extends MatchStateBase {
  format: 'solo'
  sheets: Record<string, Sheet>
}

function init(ctx: ReduceCtx, at: number): SoloState {
  return {
    format: 'solo',
    roster: ctx.roster,
    phase: 'answering',
    started_at: at,
    deadline_at: at + ctx.paper.duration_sec * 1000,
    total: ctx.questions.length,
    notice: ctx.degraded_notice,
    sheets: initSheets(ctx.roster),
  }
}

function endMatch(state: SoloState, at: number, reason: SoloState['end_reason'], ctx: ReduceCtx) {
  return endSheetMatch(state, at, reason, ctx, summarize)
}

function reduce(state: SoloState, event: MatchEvent, ctx: ReduceCtx): { state: SoloState; effects: Effects } {
  if (state.phase === 'ended') return { state, effects: {} }

  switch (event.type) {
    case 'SUBMIT':
      return applySubmit(state, event, ctx)
    case 'FINISH':
      return applyFinish(state, event, ctx, summarize)
    case 'TICK':
      if (event.at >= state.deadline_at) return endMatch(state, state.deadline_at, 'time', ctx)
      return { state, effects: {} }
    case 'END':
      return endMatch(state, event.at, event.reason ?? 'self', ctx)
    default:
      return { state, effects: {} }
  }
}

function summarize(state: SoloState, ctx: ReduceCtx): MatchSummary {
  const scoring = ctx.paper.scoring
  const maxRaw = maxRawPoints(ctx.questions, scoring)
  const maxScore = scoring.total_normalize > 0 ? scoring.total_normalize : maxRaw
  const names = state.roster.names ?? {}

  // solo 按人出成绩：每个人各占一条 TeamResult（id = member_id），成绩页直接按人排名
  const teams: TeamResult[] = []
  for (const team of state.roster.teams) {
    for (const memberId of team.member_ids) {
      const sheet = state.sheets[memberId]
      let raw = 0
      let answered = 0
      let correct = 0
      const detail = ctx.questions.map((question) => {
        const record = sheet?.answers[question.id]
        const judged = judge({
          question,
          choice: record?.choice ?? [],
          scoring,
          answered: record !== undefined,
        })
        if (record !== undefined && judged.scored) answered += 1
        if (judged.correct) correct += 1
        raw += judged.points
        return {
          qid: question.id,
          choice: record ? [...record.choice] : null,
          correct: judged.correct,
          points: judged.points,
        }
      })

      const score = normalizeScore(raw, maxRaw, scoring)
      teams.push({
        id: memberId,
        name: names[memberId] ?? memberId,
        score,
        max_score: maxScore,
        members: [{ id: memberId, name: names[memberId] ?? memberId, score, answered, correct }],
        detail,
      })
    }
  }

  return {
    format: 'solo',
    started_at: state.started_at,
    ended_at: state.ended_at ?? state.deadline_at,
    end_reason: state.end_reason ?? 'time',
    teams,
    questions: ctx.questions.map((question) => ({
      qid: question.id,
      type: question.type,
      answer: question.answer,
      explain: question.explain,
      scored: isScorable(question),
    })),
    degraded_notice: ctx.degraded_notice,
  }
}

function view(state: SoloState, viewerId: string | null, at: number): PublicMatchState {
  const sheet = viewerId ? state.sheets[viewerId] : undefined
  const names = state.roster.names ?? {}

  const answers: Record<string, string[]> = {}
  for (const [qid, record] of Object.entries(sheet?.answers ?? {})) answers[qid] = [...record.choice]

  const peers: PeerInfo[] = []
  for (const team of state.roster.teams) {
    for (const memberId of team.member_ids) {
      const memberSheet = state.sheets[memberId]
      peers.push({
        id: memberId,
        name: names[memberId] ?? memberId,
        team_id: team.id,
        online: true,
        ready: true,
        progress: { answered: Object.keys(memberSheet?.answers ?? {}).length, total: state.total },
        is_answerer: memberId === viewerId,
      })
    }
  }

  return {
    format: 'solo',
    phase: state.phase,
    server_at: at,
    clock: { started_at: state.started_at, deadline_at: state.deadline_at },
    current_index: null,
    total: state.total,
    viewer_id: viewerId,
    own: {
      scope: 'member',
      answers,
      locked: [...(sheet?.locked ?? [])],
      can_submit: state.phase !== 'ended' && !sheet?.finished_at,
      finished: Boolean(sheet?.finished_at),
    },
    peers,
    notice: state.notice,
  }
}

export const soloSpec: FormatSpec<SoloState> = {
  id: 'solo',
  init,
  reduce,
  view,
  is_ended: (state) => state.phase === 'ended',
  summarize,
}
