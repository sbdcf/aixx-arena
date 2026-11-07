/**
 * 赛制 3：团队赛（1 人主答 + 2 人辅助，20 分钟 10 题）。
 *
 * 与 solo / team-solo 的区别是「一份团队共享答卷 + 一个主答」：
 * - 只有 `answerer_id` 能提交；辅助位看得到题面与本队答题进度，但提交会被拒（`NOT_AUTHORIZED`）。
 * - 题序游标在 state 里（团队共享），由主答或队长 `ADVANCE` 推进；推满一队就交卷。
 * - 多队同场：一个房间可以有多支队，各自独立进度，全部交卷或全局到期才结算。
 */

import type { Effects, FormatSpec, MatchEvent, MatchStateBase, ReduceCtx } from '../state.ts'
import type { MatchSummary, PeerInfo, PublicBase, PublicMatchState, TeamResult } from '../public.ts'
import type { ServerMsg } from '../protocol.ts'
import { isScorable, judge, maxRawPoints, normalizeChoice, normalizeScore } from '../scoring.ts'
import { errorTo, revealItems } from './sheet.ts'

export interface CoopAnswer {
  choice: string[]
  at: number
  correct: boolean
  points: number
  /** 谁提交的（主答可能在比赛中被换人，复盘要能追） */
  by?: string
}

export interface CoopTeamState {
  answerer_id: string
  current_index: number
  answers: Record<string, CoopAnswer>
  locked: string[]
  finished_at?: number
}

export interface TeamCoopState extends MatchStateBase {
  format: 'team-coop'
  teams: Record<string, CoopTeamState>
  /** 满原始分（`init` 时从 ctx 固化）：`view` 拿不到 ctx，实时榜要靠它折算 */
  max_raw: number
  /** 折算目标分（total_normalize，0 = 不折算） */
  normalize_to: number
}

function init(ctx: ReduceCtx, at: number): TeamCoopState {
  const teams: Record<string, CoopTeamState> = {}
  for (const team of ctx.roster.teams) {
    teams[team.id] = {
      answerer_id: team.captain_id,
      current_index: 0,
      answers: {},
      locked: [],
    }
  }
  return {
    format: 'team-coop',
    roster: ctx.roster,
    phase: 'answering',
    started_at: at,
    deadline_at: at + ctx.paper.duration_sec * 1000,
    total: ctx.questions.length,
    notice: ctx.degraded_notice,
    teams,
    max_raw: maxRawPoints(ctx.questions, ctx.paper.scoring),
    normalize_to: ctx.paper.scoring.total_normalize ?? 0,
  }
}

function teamIdOf(state: TeamCoopState, actorId: string | undefined): string | undefined {
  if (!actorId) return undefined
  for (const team of state.roster.teams) {
    if (team.member_ids.includes(actorId)) return team.id
  }
  return undefined
}

function allFinished(state: TeamCoopState): boolean {
  const ids = Object.keys(state.teams)
  return ids.length > 0 && ids.every((id) => state.teams[id].finished_at !== undefined)
}

function endMatch(
  state: TeamCoopState,
  at: number,
  reason: TeamCoopState['end_reason'],
  ctx: ReduceCtx,
): { state: TeamCoopState; effects: Effects } {
  const ended: TeamCoopState = { ...state, phase: 'ended', ended_at: at, end_reason: reason ?? 'self' }
  const summary = summarize(ended, ctx)
  const items = revealItems(ctx)

  const toTeam = Object.keys(ended.teams).map((teamId) => ({
    team_id: teamId,
    messages: [{ t: 'reveal', items }] as ServerMsg[],
  }))

  return {
    state: ended,
    effects: {
      broadcast: [{ t: 'ended', summary }],
      to_team: toTeam,
      log: [{ at, event: 'match_ended', data: { reason: ended.end_reason } }],
    },
  }
}

/** 实时榜用的折算（与 `scoring.normalizeScore` 同口径，但只需要 state 里固化的两个数） */
function normalizeTeamScore(raw: number, maxRaw: number, target: number): number {
  if (target === 0 || maxRaw <= 0) return raw
  return Math.round((raw / maxRaw) * target)
}

function scoreBoard(state: TeamCoopState): { id: string; name: string; score: number }[] {
  return state.roster.teams.map((team) => {
    const teamState = state.teams[team.id]
    let raw = 0
    for (const answer of Object.values(teamState?.answers ?? {})) raw += answer.points
    return { id: team.id, name: team.name, score: normalizeTeamScore(raw, state.max_raw, state.normalize_to) }
  })
}

function handleSubmit(
  state: TeamCoopState,
  event: MatchEvent,
  ctx: ReduceCtx,
): { state: TeamCoopState; effects: Effects } {
  const actorId = event.actor_id
  const teamId = teamIdOf(state, actorId)
  if (!actorId || !teamId) {
    return { state, effects: { log: [{ at: event.at, event: 'submit_not_authorized', participant_id: actorId }] } }
  }

  const teamState = state.teams[teamId]
  if (teamState.finished_at !== undefined) {
    return {
      state,
      effects: { to_member: [errorTo(actorId, 'NOT_AUTHORIZED', '本队已交卷')] },
    }
  }
  if (teamState.answerer_id !== actorId) {
    // 辅助位点提交：给一个明确的提示，但不改变任何状态
    return {
      state,
      effects: { to_member: [errorTo(actorId, 'NOT_AUTHORIZED', '只有主答可以提交')] },
    }
  }

  const qid = event.qid
  const question = qid ? ctx.questions.find((q) => q.id === qid) : undefined
  if (!qid || !question) {
    return { state, effects: { to_member: [errorTo(actorId, 'BAD_MESSAGE', '未知题号')] } }
  }

  if (teamState.locked.includes(qid)) {
    return {
      state,
      effects: {
        to_member: [{ member_id: actorId, messages: [{ t: 'ack', seq: event.seq ?? 0, qid, accepted: false, locked: true }] }],
      },
    }
  }

  const choice = normalizeChoice(event.choice ?? [])
  const judged = judge({ question, choice, scoring: ctx.paper.scoring, answered: true })
  const nextTeam: CoopTeamState = {
    ...teamState,
    answers: {
      ...teamState.answers,
      [qid]: { choice, at: event.at, correct: judged.correct, points: judged.points, by: actorId },
    },
    locked: [...teamState.locked, qid],
  }
  const nextState: TeamCoopState = { ...state, teams: { ...state.teams, [teamId]: nextTeam } }

  return {
    state: nextState,
    effects: {
      to_member: [
        {
          member_id: actorId,
          messages: [
            {
              t: 'ack',
              seq: event.seq ?? 0,
              qid,
              accepted: true,
              locked: true,
              correct: judged.correct,
              points: judged.points,
            },
          ],
        },
      ],
      broadcast: [{ t: 'score', teams: scoreBoard(nextState) }],
    },
  }
}

function finishTeam(
  state: TeamCoopState,
  teamId: string,
  at: number,
  ctx: ReduceCtx,
): { state: TeamCoopState; effects: Effects } {
  const teamState = state.teams[teamId]
  if (teamState.finished_at !== undefined) return { state, effects: {} }

  const nextState: TeamCoopState = {
    ...state,
    teams: { ...state.teams, [teamId]: { ...teamState, finished_at: at } },
  }

  // 最后一队交卷 = 全场提前结束；否则只更新排行榜
  if (allFinished(nextState)) {
    return endMatch(nextState, at, 'all_done', ctx)
  }
  return {
    state: nextState,
    effects: {
      broadcast: [{ t: 'score', teams: scoreBoard(nextState) }],
      log: [{ at, event: 'team_finished', team_id: teamId }],
    },
  }
}

function handleAdvance(
  state: TeamCoopState,
  event: MatchEvent,
  ctx: ReduceCtx,
): { state: TeamCoopState; effects: Effects } {
  const actorId = event.actor_id
  const teamId = event.team_id ?? teamIdOf(state, actorId)
  if (!actorId || !teamId) return { state, effects: {} }

  const teamState = state.teams[teamId]
  if (!teamState || teamState.finished_at !== undefined) return { state, effects: {} }

  const captain = state.roster.teams.find((team) => team.id === teamId)?.captain_id
  if (actorId !== teamState.answerer_id && actorId !== captain) {
    return { state, effects: { to_member: [errorTo(actorId, 'NOT_AUTHORIZED', '只有主答或队长可以切题')] } }
  }

  const nextIndex = teamState.current_index + 1
  if (nextIndex >= state.total) return finishTeam(state, teamId, event.at, ctx)

  const nextState: TeamCoopState = {
    ...state,
    teams: { ...state.teams, [teamId]: { ...teamState, current_index: nextIndex } },
  }
  return { state: nextState, effects: {} }
}

function handleSetAnswerer(
  state: TeamCoopState,
  event: MatchEvent,
  ctx: ReduceCtx,
): { state: TeamCoopState; effects: Effects } {
  const actorId = event.actor_id
  const teamId = event.team_id ?? teamIdOf(state, actorId)
  const team = state.roster.teams.find((t) => t.id === teamId)
  const target = event.member_id
  if (!actorId || !teamId || !team || !target) return { state, effects: {} }

  // 队长换主答；掉线接管也走这条（服务端在断线超时后以队长身份注入）
  if (actorId !== team.captain_id) {
    return { state, effects: { to_member: [errorTo(actorId, 'NOT_AUTHORIZED', '只有队长可以换主答')] } }
  }
  if (!team.member_ids.includes(target)) {
    return { state, effects: { to_member: [errorTo(actorId, 'BAD_MESSAGE', '该成员不在本队')] } }
  }

  const teamState = state.teams[teamId]
  const nextState: TeamCoopState = {
    ...state,
    teams: { ...state.teams, [teamId]: { ...teamState, answerer_id: target } },
  }
  return {
    state: nextState,
    effects: { log: [{ at: event.at, event: 'set_answerer', team_id: teamId, participant_id: target, data: { by: actorId } }] },
  }
}

function reduce(state: TeamCoopState, event: MatchEvent, ctx: ReduceCtx): { state: TeamCoopState; effects: Effects } {
  if (state.phase === 'ended') return { state, effects: {} }

  switch (event.type) {
    case 'SUBMIT':
      return handleSubmit(state, event, ctx)
    case 'ADVANCE':
      return handleAdvance(state, event, ctx)
    case 'SET_ANSWERER':
      return handleSetAnswerer(state, event, ctx)
    case 'TICK':
      if (event.at >= state.deadline_at) return endMatch(state, state.deadline_at, 'time', ctx)
      return { state, effects: {} }
    case 'END':
      // 房主 end 传 reason:'host' → 全场结算；某队 submit_all 传 reason:'self' → 只结算该队
      if (event.reason === 'self' && event.actor_id) {
        const teamId = teamIdOf(state, event.actor_id)
        if (teamId) return finishTeam(state, teamId, event.at, ctx)
      }
      return endMatch(state, event.at, event.reason ?? 'host', ctx)
    default:
      return { state, effects: {} }
  }
}

function summarize(state: TeamCoopState, ctx: ReduceCtx): MatchSummary {
  const scoring = ctx.paper.scoring
  const maxRaw = maxRawPoints(ctx.questions, scoring)
  const maxScore = scoring.total_normalize > 0 ? scoring.total_normalize : maxRaw
  const names = state.roster.names ?? {}

  const teams: TeamResult[] = state.roster.teams.map((team) => {
    const teamState = state.teams[team.id]
    let raw = 0
    let correct = 0
    let answered = 0

    const detail = ctx.questions.map((question) => {
      const record = teamState?.answers[question.id]
      const judged = judge({ question, choice: record?.choice ?? [], scoring, answered: record !== undefined })
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

    const members = team.member_ids.map((memberId) => {
      const own = Object.values(teamState?.answers ?? {}).filter((answer) => answer.by === memberId)
      return {
        id: memberId,
        name: names[memberId] ?? memberId,
        score: normalizeScore(
          own.reduce((sum, answer) => sum + answer.points, 0),
          maxRaw,
          scoring,
        ),
        answered: own.length,
        correct: own.filter((answer) => answer.correct).length,
      }
    })

    return {
      id: team.id,
      name: team.name,
      score: normalizeScore(raw, maxRaw, scoring),
      max_score: maxScore,
      members,
      detail,
    }
  })

  return {
    format: 'team-coop',
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

function view(state: TeamCoopState, viewerId: string | null, at: number): PublicMatchState {
  const names = state.roster.names ?? {}
  const teamId = teamIdOf(state, viewerId ?? undefined)
  const teamState = teamId ? state.teams[teamId] : undefined

  const answers: Record<string, string[]> = {}
  for (const [qid, record] of Object.entries(teamState?.answers ?? {})) answers[qid] = [...record.choice]

  const peers: PeerInfo[] = []
  for (const team of state.roster.teams) {
    for (const memberId of team.member_ids) {
      const isThisTeam = team.id === teamId
      peers.push({
        id: memberId,
        name: names[memberId] ?? memberId,
        team_id: team.id,
        online: true,
        ready: true,
        progress: {
          answered: isThisTeam ? Object.keys(teamState?.answers ?? {}).length : 0,
          total: state.total,
        },
        is_answerer: memberId === teamState?.answerer_id,
      })
    }
  }

  const base: PublicBase = {
    format: 'team-coop',
    phase: state.phase,
    server_at: at,
    clock: { started_at: state.started_at, deadline_at: state.deadline_at },
    current_index: teamState?.current_index ?? 0,
    total: state.total,
    viewer_id: viewerId,
    own: {
      scope: 'team',
      answers,
      locked: [...(teamState?.locked ?? [])],
      can_submit:
        state.phase !== 'ended' &&
        teamState?.finished_at === undefined &&
        viewerId !== null &&
        teamState?.answerer_id === viewerId,
    },
    peers,
    scores: scoreBoard(state).map((team) => ({ team_id: team.id, name: team.name, score: team.score })),
    notice: state.notice,
  }

  return {
    ...base,
    format: 'team-coop',
    team_id: teamId ?? '',
    answerer_id: teamState?.answerer_id ?? '',
  }
}

export const teamCoopSpec: FormatSpec<TeamCoopState> = {
  id: 'team-coop',
  init,
  reduce,
  view,
  is_ended: (state) => state.phase === 'ended',
  summarize,
}
