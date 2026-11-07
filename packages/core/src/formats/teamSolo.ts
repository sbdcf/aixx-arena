/**
 * 赛制 2：团队个人赛（5 分钟 10 题，队内各自作答，团队总分为成员之和）。
 *
 * 与 solo 共用 `sheet.ts` 的作答/提交规则，差别只有两处：
 * - `summarize` 按队聚合（`teams[].members` 给出每个成员的得分与答对题数）；
 * - 视图多一个 `team` 字段，让 UI 能显示「本队进度」。
 */

import type { Effects, FormatSpec, MatchEvent, MatchStateBase, ReduceCtx } from '../state.ts'
import type { MatchSummary, PeerInfo, PublicMatchState, PublicBase, TeamResult } from '../public.ts'
import { isScorable, judge, maxRawPoints, normalizeScore } from '../scoring.ts'
import { applyFinish, applySubmit, endSheetMatch, initSheets, type Sheet } from './sheet.ts'

export interface TeamSoloState extends MatchStateBase {
  format: 'team-solo'
  sheets: Record<string, Sheet>
}

function init(ctx: ReduceCtx, at: number): TeamSoloState {
  return {
    format: 'team-solo',
    roster: ctx.roster,
    phase: 'answering',
    started_at: at,
    deadline_at: at + ctx.paper.duration_sec * 1000,
    total: ctx.questions.length,
    notice: ctx.degraded_notice,
    sheets: initSheets(ctx.roster),
  }
}

function reduce(state: TeamSoloState, event: MatchEvent, ctx: ReduceCtx): { state: TeamSoloState; effects: Effects } {
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
      // 每人本地游标：ADVANCE 无意义；team-solo 不设主答，SET_ANSWERER 也忽略
      return { state, effects: {} }
  }
}

function endMatch(state: TeamSoloState, at: number, reason: TeamSoloState['end_reason'], ctx: ReduceCtx) {
  return endSheetMatch(state, at, reason, ctx, summarize)
}

function summarize(state: TeamSoloState, ctx: ReduceCtx): MatchSummary {
  const scoring = ctx.paper.scoring
  const maxRaw = maxRawPoints(ctx.questions, scoring)
  const maxMemberScore = scoring.total_normalize > 0 ? scoring.total_normalize : maxRaw
  const names = state.roster.names ?? {}

  const teams: TeamResult[] = []
  for (const team of state.roster.teams) {
    const memberResults: TeamResult['members'] = []

    for (const memberId of team.member_ids) {
      const sheet = state.sheets[memberId]
      let raw = 0
      let answered = 0
      let correct = 0
      for (const question of ctx.questions) {
        const record = sheet?.answers[question.id]
        const judged = judge({ question, choice: record?.choice ?? [], scoring, answered: record !== undefined })
        if (record !== undefined && judged.scored) answered += 1
        if (judged.correct) correct += 1
        raw += judged.points
      }
      memberResults.push({
        id: memberId,
        name: names[memberId] ?? memberId,
        score: normalizeScore(raw, maxRaw, scoring),
        answered,
        correct,
      })
    }

    // 团队总分 = Σ 成员分（design §5.6）；满分同比例放大
    const teamScore = memberResults.reduce((sum, member) => sum + member.score, 0)
    // 逐题明细取「答得最多的那位成员」，其余成员明细在 member_details 里（P6 教练视图会用）
    const lead = [...team.member_ids].sort((a, b) => {
      const da = Object.keys(state.sheets[a]?.answers ?? {}).length
      const db = Object.keys(state.sheets[b]?.answers ?? {}).length
      return db - da || a.localeCompare(b)
    })[0]

    teams.push({
      id: team.id,
      name: team.name,
      score: teamScore,
      max_score: maxMemberScore * team.member_ids.length,
      members: memberResults,
      detail: detailOf(state.sheets[lead], ctx, scoring),
    })
  }

  return {
    format: 'team-solo',
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

function detailOf(
  sheet: Sheet | undefined,
  ctx: ReduceCtx,
  scoring: ReduceCtx['paper']['scoring'],
): TeamResult['detail'] {
  return ctx.questions.map((question) => {
    const record = sheet?.answers[question.id]
    const judged = judge({ question, choice: record?.choice ?? [], scoring, answered: record !== undefined })
    return {
      qid: question.id,
      choice: record ? [...record.choice] : null,
      correct: judged.correct,
      points: judged.points,
    }
  })
}

function teamOf(state: TeamSoloState, viewerId: string | null) {
  if (!viewerId) return undefined
  return state.roster.teams.find((team) => team.member_ids.includes(viewerId))
}

function view(state: TeamSoloState, viewerId: string | null, at: number): PublicMatchState {
  const sheet = viewerId ? state.sheets[viewerId] : undefined
  const names = state.roster.names ?? {}
  const team = teamOf(state, viewerId)

  const answers: Record<string, string[]> = {}
  for (const [qid, record] of Object.entries(sheet?.answers ?? {})) answers[qid] = [...record.choice]

  const peers: PeerInfo[] = []
  for (const rosterTeam of state.roster.teams) {
    for (const memberId of rosterTeam.member_ids) {
      const memberSheet = state.sheets[memberId]
      peers.push({
        id: memberId,
        name: names[memberId] ?? memberId,
        team_id: rosterTeam.id,
        online: true,
        ready: true,
        progress: { answered: Object.keys(memberSheet?.answers ?? {}).length, total: state.total },
        is_answerer: memberId === viewerId,
      })
    }
  }

  const base: PublicBase = {
    format: 'team-solo',
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

  // 本队进度条：队内已答题数取「去重后的题目集合」（不同成员答同一题只算一次进度）
  const teamAnswered = new Set<string>()
  if (team) {
    for (const memberId of team.member_ids) {
      for (const qid of Object.keys(state.sheets[memberId]?.answers ?? {})) teamAnswered.add(qid)
    }
  }

  return {
    ...base,
    format: 'team-solo',
    team: { id: team?.id ?? '', answered: teamAnswered.size, total: state.total },
  }
}

export const teamSoloSpec: FormatSpec<TeamSoloState> = {
  id: 'team-solo',
  init,
  reduce,
  view,
  is_ended: (state) => state.phase === 'ended',
  summarize,
}
