/**
 * 赛制 4：接力赛（3 人 × X 分钟 × X 题，上一人剩余时间继承）。
 *
 * 核心是一条时间守恒式：`carry = max(0, 本棒预算 - 本棒已用秒数)`，下一棒 `预算 = X + carry`。
 * 只要每一步都按这个式子交棒，全场截止恒等于 `started_at + 3X*1000`（§15 第 1 条：
 * 不能用 `ceil(已用秒数)` 反算，否则队伍会凭空多出 1 秒）。
 *
 * 与 team-coop 一样是「多队同场、每队一份进度」：一个房间可以有多支队，各自独立交棒，
 * 全部队跑完或全局到期才结算。
 */

import type { Effects, FormatSpec, MatchEvent, MatchStateBase, ReduceCtx } from '../state.ts'
import type { MatchSummary, PeerInfo, PublicBase, PublicMatchState, TeamResult } from '../public.ts'
import type { ServerMsg } from '../protocol.ts'
import { isScorable, judge, maxRawPoints, normalizeChoice, normalizeScore } from '../scoring.ts'
import { errorTo, revealItems } from './sheet.ts'

const LEGS = 3

export interface RelayAnswer {
  choice: string[]
  at: number
  correct: boolean
  points: number
  /** 谁交的（这一棒是谁在答；复盘要能追到人） */
  by: string
  leg_index: number
}

export interface RelayTeamState {
  /** 恰好 3 个 member_id，开赛固化（2 人队循环补齐，如 [A,B,A]） */
  leg_order: string[]
  leg_index: number
  /** 棒内题号，交棒时归零 */
  current_index: number
  leg_started_at: number
  /** 本棒预算 = X + carry */
  leg_budget_sec: number
  carry_sec: number
  answers: Record<string, RelayAnswer>
  finished_at?: number
}

export interface RelayState extends MatchStateBase {
  format: 'relay'
  /** 三棒共用的题目切分（与 ctx.questions 的顺序一致） */
  leg_question_ids: [string[], string[], string[]]
  teams: Record<string, RelayTeamState>
  /** `init` 时从 ctx 固化：`view` 拿不到 ctx，实时榜要靠它折算 */
  max_raw: number
  normalize_to: number
  /** 人数不足 3 人、靠循环补齐的队伍，结算日志里带上 */
  short_teams: string[]
}

function legCounts(ctx: ReduceCtx): [number, number, number] {
  const legs = ctx.paper.legs
  if (!legs || legs.length !== LEGS) {
    throw new Error('relay 试卷缺少 legs（必须恰好 3 段）')
  }
  return legs.map((leg) => (leg.single ?? 0) + (leg.multiple ?? 0) + (leg.judge ?? 0)) as [number, number, number]
}

export function splitLegQuestions(ctx: ReduceCtx): [string[], string[], string[]] {
  const counts = legCounts(ctx)
  const total = counts[0] + counts[1] + counts[2]
  if (total !== ctx.questions.length) {
    throw new Error(`relay 题量不符：试卷 legs 合计 ${total} 题，实际组卷 ${ctx.questions.length} 题`)
  }
  const ids: string[][] = []
  let cursor = 0
  for (const count of counts) {
    ids.push(ctx.questions.slice(cursor, cursor + count).map((question) => question.id))
    cursor += count
  }
  return ids as [string[], string[], string[]]
}

/** 棒次顺序：队长在首位，其余按加入顺序；不足 3 人循环补齐 */
function buildLegOrder(team: { id: string; member_ids: string[]; captain_id: string }): { order: string[]; short: boolean } {
  if (team.member_ids.length === 0) throw new Error(`队伍 ${team.id} 没有成员`)

  const captain = team.member_ids.includes(team.captain_id) ? team.captain_id : team.member_ids[0]
  const ordered = [captain, ...team.member_ids.filter((id) => id !== captain)]
  const order = ordered.slice(0, LEGS)
  while (order.length < LEGS) order.push(ordered[order.length % ordered.length])
  return { order, short: ordered.length < LEGS }
}

function makeTeamState(
  team: { id: string; member_ids: string[]; captain_id: string },
  legSec: number,
  at: number,
): { state: RelayTeamState; short: boolean } {
  const { order, short } = buildLegOrder(team)
  return {
    state: {
      leg_order: order,
      leg_index: 0,
      current_index: 0,
      leg_started_at: at,
      leg_budget_sec: legSec,
      carry_sec: 0,
      answers: {},
    },
    short,
  }
}

function init(ctx: ReduceCtx, at: number): RelayState {
  const legSec = ctx.paper.duration_sec
  if (!(legSec > 0)) throw new Error('relay 试卷的 duration_sec 必须 > 0（单棒 X 秒）')

  const legQuestionIds = splitLegQuestions(ctx)
  const teams: Record<string, RelayTeamState> = {}
  const shortTeams: string[] = []

  for (const team of ctx.roster.teams) {
    const built = makeTeamState(team, legSec, at)
    teams[team.id] = built.state
    if (built.short) shortTeams.push(team.id)
  }

  return {
    format: 'relay',
    roster: ctx.roster,
    phase: 'answering',
    started_at: at,
    // 全局截止 = at + 3X：交棒只在队伍内部重分配时间，不改变总量
    deadline_at: at + legSec * LEGS * 1000,
    total: ctx.questions.length,
    notice: ctx.degraded_notice,
    leg_question_ids: legQuestionIds,
    teams,
    max_raw: maxRawPoints(ctx.questions, ctx.paper.scoring),
    normalize_to: ctx.paper.scoring.total_normalize ?? 0,
    short_teams: shortTeams,
  }
}

function teamIdOf(state: RelayState, actorId: string | undefined): string | undefined {
  if (!actorId) return undefined
  for (const team of state.roster.teams) {
    if (team.member_ids.includes(actorId)) return team.id
  }
  return undefined
}

function answererOf(teamState: RelayTeamState): string | undefined {
  return teamState.leg_order[teamState.leg_index]
}

function legOf(state: RelayState, qid: string): number {
  for (let index = 0; index < LEGS; index += 1) {
    if (state.leg_question_ids[index].includes(qid)) return index
  }
  return -1
}

function allFinished(state: RelayState): boolean {
  const ids = Object.keys(state.teams)
  return ids.length > 0 && ids.every((id) => state.teams[id].finished_at !== undefined)
}

/** 实时榜用的折算（与 `scoring.normalizeScore` 同口径，但只需要 state 里固化的两个数） */
function normalizeTeamScore(raw: number, maxRaw: number, target: number): number {
  if (target === 0 || maxRaw <= 0) return raw
  return Math.round((raw / maxRaw) * target)
}

function rawOf(teamState: RelayTeamState | undefined): number {
  let raw = 0
  for (const answer of Object.values(teamState?.answers ?? {})) raw += answer.points
  return raw
}

function scoreBoard(state: RelayState): { id: string; name: string; score: number }[] {
  return state.roster.teams.map((team) => ({
    id: team.id,
    name: team.name,
    score: normalizeTeamScore(rawOf(state.teams[team.id]), state.max_raw, state.normalize_to),
  }))
}

function endMatch(
  state: RelayState,
  at: number,
  reason: RelayState['end_reason'],
  ctx: ReduceCtx,
): { state: RelayState; effects: Effects } {
  const ended: RelayState = { ...state, phase: 'ended', ended_at: at, end_reason: reason ?? 'self' }
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
      log: [
        {
          at,
          event: 'match_ended',
          data: {
            reason: ended.end_reason,
            ...(ended.short_teams.length > 0 ? { relay_short_team: ended.short_teams } : {}),
          },
        },
      ],
    },
  }
}

/** 交棒：把本棒剩余时间结转到下一棒；第 3 棒结束后该队结算 */
function performHandoff(
  state: RelayState,
  teamId: string,
  at: number,
  ctx: ReduceCtx,
): { state: RelayState; effects: Effects } {
  const teamState = state.teams[teamId]
  if (!teamState || teamState.finished_at !== undefined) return { state, effects: {} }
  if (state.phase === 'ended') return { state, effects: {} }

  const elapsedSec = (at - teamState.leg_started_at) / 1000
  const carry = Math.max(0, teamState.leg_budget_sec - elapsedSec)

  if (teamState.leg_index >= LEGS - 1) return finishTeam(state, teamId, at, ctx)

  const nextLeg = teamState.leg_index + 1
  const budget = ctx.paper.duration_sec + carry
  const nextLegState: RelayTeamState = {
    ...teamState,
    leg_index: nextLeg,
    current_index: 0,
    leg_started_at: at,
    leg_budget_sec: budget,
    carry_sec: carry,
  }
  const nextState: RelayState = { ...state, teams: { ...state.teams, [teamId]: nextLegState } }
  const toMember = nextLegState.leg_order[nextLeg]
  const fromMember = answererOf(teamState)

  return {
    state: nextState,
    effects: {
      to_team: [
        {
          team_id: teamId,
          messages: [
            {
              t: 'notice',
              text: `第 ${nextLeg + 1} 棒：${nextLegState.leg_order[nextLeg]} 上场，剩余 ${Math.ceil(budget)} 秒（继承 ${Math.ceil(carry)} 秒）`,
            },
          ],
        },
      ],
      to_member: [
        {
          member_id: toMember,
          messages: [
            {
              t: 'notice',
              text: `轮到你了：第 ${nextLeg + 1} 棒，剩余 ${Math.ceil(budget)} 秒`,
            },
          ],
        },
      ],
      timers: [{ key: `relay:${teamId}`, at: at + budget * 1000 }],
      log: [
        {
          at,
          event: 'handoff',
          team_id: teamId,
          participant_id: toMember,
          data: { from: fromMember, to: toMember, leg_index: nextLeg, carry_sec: carry, budget_sec: budget },
        },
      ],
    },
  }
}

/** 本队跑完 3 棒：只给该队发 reveal；全部队跑完则全场结算 */
function finishTeam(
  state: RelayState,
  teamId: string,
  at: number,
  ctx: ReduceCtx,
): { state: RelayState; effects: Effects } {
  const teamState = state.teams[teamId]
  if (!teamState || teamState.finished_at !== undefined) return { state, effects: {} }

  const nextState: RelayState = {
    ...state,
    teams: { ...state.teams, [teamId]: { ...teamState, finished_at: at } },
  }

  if (allFinished(nextState)) return endMatch(nextState, at, 'all_done', ctx)

  return {
    state: nextState,
    effects: {
      broadcast: [{ t: 'score', teams: scoreBoard(nextState) }],
      to_team: [{ team_id: teamId, messages: [{ t: 'reveal', items: revealItems(ctx) }] }],
      log: [{ at, event: 'team_finished', team_id: teamId }],
    },
  }
}

function handleSubmit(
  state: RelayState,
  event: MatchEvent,
  ctx: ReduceCtx,
): { state: RelayState; effects: Effects } {
  const actorId = event.actor_id
  const teamId = teamIdOf(state, actorId)
  if (!actorId || !teamId) {
    return { state, effects: { log: [{ at: event.at, event: 'submit_not_authorized', participant_id: actorId }] } }
  }

  const teamState = state.teams[teamId]
  if (teamState.finished_at !== undefined) {
    return { state, effects: { to_member: [errorTo(actorId, 'NOT_AUTHORIZED', '本队已完成接力')] } }
  }
  const answerer = answererOf(teamState)
  if (answerer !== actorId) {
    return { state, effects: { to_member: [errorTo(actorId, 'NOT_AUTHORIZED', '现在不是你这一棒')] } }
  }

  const qid = event.qid
  const question = qid ? ctx.questions.find((item) => item.id === qid) : undefined
  if (!qid || !question) {
    return { state, effects: { to_member: [errorTo(actorId, 'BAD_MESSAGE', '未知题号')] } }
  }
  if (!state.leg_question_ids[teamState.leg_index].includes(qid)) {
    return { state, effects: { to_member: [errorTo(actorId, 'BAD_MESSAGE', '这一棒的题目里没有这个题号')] } }
  }
  if (teamState.answers[qid] !== undefined) {
    return {
      state,
      effects: {
        to_member: [
          { member_id: actorId, messages: [{ t: 'ack', seq: event.seq ?? 0, qid, accepted: false, locked: true }] },
        ],
      },
    }
  }

  const choice = normalizeChoice(event.choice ?? [])
  const judged = judge({ question, choice, scoring: ctx.paper.scoring, answered: true })
  const nextTeam: RelayTeamState = {
    ...teamState,
    answers: {
      ...teamState.answers,
      [qid]: {
        choice,
        at: event.at,
        correct: judged.correct,
        points: judged.points,
        by: actorId,
        leg_index: teamState.leg_index,
      },
    },
  }
  const nextState: RelayState = { ...state, teams: { ...state.teams, [teamId]: nextTeam } }

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

function handleAdvance(
  state: RelayState,
  event: MatchEvent,
  ctx: ReduceCtx,
): { state: RelayState; effects: Effects } {
  const actorId = event.actor_id
  const teamId = teamIdOf(state, actorId)
  if (!actorId || !teamId) return { state, effects: {} }

  const teamState = state.teams[teamId]
  if (!teamState || teamState.finished_at !== undefined) return { state, effects: {} }
  if (answererOf(teamState) !== actorId) {
    return { state, effects: { to_member: [errorTo(actorId, 'NOT_AUTHORIZED', '现在不是你这一棒')] } }
  }

  const legIds = state.leg_question_ids[teamState.leg_index]
  const nextIndex = teamState.current_index + 1
  // 推过本棒末题 ≡ 交棒（§5.4 推进表）
  if (nextIndex >= legIds.length) return performHandoff(state, teamId, event.at, ctx)

  const nextState: RelayState = {
    ...state,
    teams: { ...state.teams, [teamId]: { ...teamState, current_index: nextIndex } },
  }
  return { state: nextState, effects: {} }
}

/** `submit_all`：当前棒选手一键交到第 3 棒结束（§5.5.1） */
function handleFinish(
  state: RelayState,
  event: MatchEvent,
  ctx: ReduceCtx,
): { state: RelayState; effects: Effects } {
  const actorId = event.actor_id
  const teamId = teamIdOf(state, actorId)
  if (!actorId || !teamId) return { state, effects: {} }

  let current = state
  let effects: Effects = {}
  const merged: Effects = { broadcast: [], to_team: [], to_member: [], log: [] }

  const step = (result: { state: RelayState; effects: Effects }) => {
    current = result.state
    effects = result.effects
    if (effects.broadcast) merged.broadcast = [...(merged.broadcast ?? []), ...effects.broadcast]
    if (effects.to_team) merged.to_team = [...(merged.to_team ?? []), ...effects.to_team]
    if (effects.to_member) merged.to_member = [...(merged.to_member ?? []), ...effects.to_member]
    if (effects.log) merged.log = [...(merged.log ?? []), ...effects.log]
  }

  const teamState = current.teams[teamId]
  if (!teamState || teamState.finished_at !== undefined) return { state, effects: {} }
  if (answererOf(teamState) !== actorId) {
    return { state, effects: { to_member: [errorTo(actorId, 'NOT_AUTHORIZED', '现在不是你这一棒')] } }
  }

  // 连续交棒到第 3 棒结束；`performHandoff` 在第 3 棒会走 finishTeam
  for (let guard = 0; guard < LEGS; guard += 1) {
    step(performHandoff(current, teamId, event.at, ctx))
    if (current.phase === 'ended') break
    if (current.teams[teamId].finished_at !== undefined) break
  }

  return {
    state: current,
    effects: {
      broadcast: merged.broadcast,
      to_team: merged.to_team,
      to_member: merged.to_member,
      timers: effects.timers,
      log: merged.log,
    },
  }
}

/** TICK：本棒超预算 → 强制交棒；全局到期 → 结算 */
function handleTick(state: RelayState, event: MatchEvent, ctx: ReduceCtx): { state: RelayState; effects: Effects } {
  if (event.at >= state.deadline_at) return endMatch(state, state.deadline_at, 'time', ctx)

  let current = state
  const merged: Effects = { broadcast: [], to_team: [], to_member: [], timers: [], log: [] }

  for (const team of state.roster.teams) {
    const teamState = current.teams[team.id]
    if (!teamState || teamState.finished_at !== undefined) continue
    const deadline = teamState.leg_started_at + teamState.leg_budget_sec * 1000
    if (event.at < deadline) continue

    const result = performHandoff(current, team.id, Math.min(deadline, state.deadline_at), ctx)
    current = result.state
    if (result.effects.broadcast) merged.broadcast = [...(merged.broadcast ?? []), ...result.effects.broadcast]
    if (result.effects.to_team) merged.to_team = [...(merged.to_team ?? []), ...result.effects.to_team]
    if (result.effects.to_member) merged.to_member = [...(merged.to_member ?? []), ...result.effects.to_member]
    if (result.effects.timers) merged.timers = [...(merged.timers ?? []), ...result.effects.timers]
    if (result.effects.log) merged.log = [...(merged.log ?? []), ...result.effects.log]
  }

  return {
    state: current,
    effects: {
      broadcast: merged.broadcast,
      to_team: merged.to_team,
      to_member: merged.to_member,
      timers: merged.timers,
      log: merged.log,
    },
  }
}

function reduce(state: RelayState, event: MatchEvent, ctx: ReduceCtx): { state: RelayState; effects: Effects } {
  if (state.phase === 'ended') return { state, effects: {} }

  switch (event.type) {
    case 'SUBMIT':
      return handleSubmit(state, event, ctx)
    case 'ADVANCE':
      return handleAdvance(state, event, ctx)
    case 'HANDOFF':
      {
        const teamId = teamIdOf(state, event.actor_id)
        if (!teamId) return { state, effects: {} }
        const teamState = state.teams[teamId]
        if (teamState && answererOf(teamState) !== event.actor_id) {
          return {
            state,
            effects: { to_member: [errorTo(event.actor_id ?? '', 'NOT_AUTHORIZED', '现在不是你这一棒')] },
          }
        }
        return performHandoff(state, teamId, event.at, ctx)
      }
    case 'FINISH':
      return handleFinish(state, event, ctx)
    case 'TICK':
      return handleTick(state, event, ctx)
    case 'END':
      if (event.reason === 'self' && event.actor_id) {
        const teamId = teamIdOf(state, event.actor_id)
        if (teamId) return finishTeam(state, teamId, event.at, ctx)
      }
      return endMatch(state, event.at, event.reason ?? 'host', ctx)
    default:
      return { state, effects: {} }
  }
}

function summarize(state: RelayState, ctx: ReduceCtx): MatchSummary {
  const scoring = ctx.paper.scoring
  const maxRaw = state.max_raw
  const maxScore = scoring.total_normalize > 0 ? scoring.total_normalize : maxRaw
  const names = state.roster.names ?? {}

  const teams: TeamResult[] = state.roster.teams.map((team) => {
    const teamState = state.teams[team.id]
    let raw = 0

    const detail = ctx.questions.map((question) => {
      const record = teamState?.answers[question.id]
      const legIndex = legOf(state, question.id)
      const judged = judge({ question, choice: record?.choice ?? [], scoring, answered: record !== undefined })
      raw += judged.points
      return {
        qid: question.id,
        ...(legIndex >= 0 ? { leg_index: legIndex } : {}),
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
    format: 'relay',
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

function view(state: RelayState, viewerId: string | null, at: number): PublicMatchState {
  const names = state.roster.names ?? {}
  const teamId = teamIdOf(state, viewerId ?? undefined)
  const teamState = teamId ? state.teams[teamId] : undefined
  const legIndex = teamState?.leg_index ?? 0
  const answerer = teamState ? answererOf(teamState) : undefined

  const answers: Record<string, string[]> = {}
  for (const [qid, record] of Object.entries(teamState?.answers ?? {})) answers[qid] = [...record.choice]

  const peers: PeerInfo[] = []
  for (const team of state.roster.teams) {
    for (const memberId of team.member_ids) {
      const progressTeam = state.teams[team.id]
      const isActiveLeg = progressTeam?.leg_order[progressTeam.leg_index] === memberId
      peers.push({
        id: memberId,
        name: names[memberId] ?? memberId,
        team_id: team.id,
        online: true,
        ready: true,
        progress: {
          answered: Object.values(progressTeam?.answers ?? {}).filter((answer) => answer.by === memberId).length,
          total: state.total,
        },
        is_answerer: Boolean(teamId && team.id === teamId && isActiveLeg),
        leg_index: progressTeam ? progressTeam.leg_order.indexOf(memberId) : 0,
      })
    }
  }

  const base: PublicBase = {
    format: 'relay',
    phase: state.phase,
    server_at: at,
    clock: {
      started_at: state.started_at,
      deadline_at: state.deadline_at,
      ...(teamState ? { leg_deadline_at: teamState.leg_started_at + teamState.leg_budget_sec * 1000 } : {}),
    },
    current_index: teamState?.current_index ?? 0,
    total: state.total,
    viewer_id: viewerId,
    own: {
      scope: 'team',
      answers,
      locked: Object.keys(answers),
      can_submit:
        Boolean(teamState) &&
        teamState?.finished_at === undefined &&
        state.phase !== 'ended' &&
        answerer === (viewerId ?? undefined),
      finished: teamState?.finished_at !== undefined,
    },
    peers,
    scores: scoreBoard(state).map((row) => {
      const team = state.roster.teams.find((item) => item.id === row.id)
      return { team_id: row.id, name: team?.name ?? row.id, score: row.score }
    }),
    ...(state.notice ? { notice: state.notice } : {}),
  }

  return {
    ...base,
    format: 'relay',
    team_id: teamId ?? '',
    leg_index: legIndex,
    leg_order: teamState?.leg_order ?? [],
    current_answerer_id: answerer ?? '',
  }
}

function isEnded(state: RelayState): boolean {
  return state.phase === 'ended'
}

export const relaySpec: FormatSpec<RelayState> = {
  id: 'relay',
  init,
  reduce,
  view,
  is_ended: isEnded,
  summarize,
}
