/**
 * 赛制 5：团队抢答（docs/design.md §5.6 buzz / §5.7 rankBuzz）。
 *
 * 一题四拍：`buffer`（题面广播后的禁抢缓冲）→ `open`（开抢窗口，各队并行提交）
 * → `closed`（按服务端收包时刻排序，前 ceil(N × ratio) 名额内答对加分）
 * → `reveal`（公布答案与得分，停留若干秒）→ 下一题。
 *
 * 三条纪律：
 * 1. **时间边界只用状态里的绝对时刻**（`open_at` / `submit_deadline_at` / `reveal_end_at`），
 *    迟到的 TICK 只会重复确认同一状态，不会把阶段推歪；
 * 2. **排序与计分全交给 `rankBuzz()`**，这里不重复实现「谁算并列」；
 * 3. **`deadline_at` 在每个阶段都指向下一个边界**，驱动器的通用定时器因此能驱动整场抢答，
 *    不需要为 buzz 额外写定时逻辑。
 *
 * 与设计的已知偏差（记在 design.md §16.7）：`n_at_open` 由 roster 推断（有成员的队），
 * 而不是实时在线队数——core 是纯函数、拿不到连接状态；影响仅是名额基数，
 * 「掉线队不参与排序」仍由「它交不上来」自然保证。
 */

import type { BuzzConfig, Question } from '../types.ts'
import { judge, isScorable, normalizeChoice } from '../scoring.ts'
import { rankBuzz, type BuzzRankEntry } from '../buzz.ts'
import type { Effects, MatchEvent, MatchStateBase, ReduceCtx } from '../state.ts'
import type { EndReason, MatchSummary, PeerInfo, PublicBase, PublicMatchState, TeamResult } from '../public.ts'
import type { ServerMsg } from '../protocol.ts'

export type BuzzPhase = 'buffer' | 'open' | 'closed' | 'reveal' | 'ended'

export interface BuzzSubmissionRecord {
  team_id: string
  /** 服务端收包时刻 */
  at: number
  choice: string[]
  correct: boolean
  /** 本题结算后回填：名次、是否在名额内、得了多少分 */
  rank?: number
  tied?: boolean
  in_quota?: boolean
  awarded?: number
}

export interface BuzzQuestionResult {
  qid: string
  n_at_open: number
  quota: number
  close_reason: 'timeout' | 'all_submitted'
  ranking: BuzzRankEntry[]
}

export interface BuzzState extends MatchStateBase {
  format: 'buzz'
  qids: string[]
  q_index: number
  phase: BuzzPhase
  /** 本题开抢时刻（缓冲结束） */
  open_at: number
  /** 本题提交截止 */
  submit_deadline_at: number
  /** 本题解析停留结束 */
  reveal_end_at: number
  n_at_open: number
  close_reason?: 'timeout' | 'all_submitted'
  /** 本题题面是否已广播（buffer 期先出题、后开抢，见 §5.8） */
  announced: boolean
  /** 本题的提交（结算后带名次与得分） */
  submissions: BuzzSubmissionRecord[]
  /** 已结算的每题提交，供成绩页复盘 */
  submissions_by_question: Record<string, BuzzSubmissionRecord[]>
  scores: Record<string, number>
  per_question: BuzzQuestionResult[]
  /** 名额比例固化进 state（view 读不到 ctx，却要给出 quota） */
  qualify_ratio: number
  /** reveal 停留毫秒，同样固化 */
  reveal_ms: number
}

function configOf(ctx: ReduceCtx): BuzzConfig {
  const config = ctx.paper.buzz
  if (!config) throw new Error('buzz 试卷缺少 buzz 配置（见 design §9.1）')
  return config
}

function teamOf(state: BuzzState, memberId: string | null): string | null {
  if (!memberId) return null
  for (const team of state.roster.teams) {
    if (team.member_ids.includes(memberId)) return team.id
  }
  return null
}

/** 开抢瞬间有资格的队：有成员的队都算（见文件头「已知偏差」） */
function eligibleTeams(ctx: ReduceCtx): number {
  return ctx.roster.teams.filter((team) => team.member_ids.length > 0).length
}

function init(ctx: ReduceCtx, at: number): BuzzState {
  const config = configOf(ctx)
  const qids = ctx.questions.map((question) => question.id)
  const scores: Record<string, number> = {}
  for (const team of ctx.roster.teams) scores[team.id] = 0

  // 开局即进入第 1 题的缓冲期；deadline_at 指向「开抢时刻」，驱动器的定时器据此送第一个 TICK
  const openAt = at + Math.max(0, config.buffer_ms)
  return {
    format: 'buzz',
    roster: ctx.roster,
    phase: 'buffer',
    started_at: at,
    deadline_at: openAt,
    total: qids.length,
    notice: ctx.degraded_notice,
    qids,
    q_index: 0,
    open_at: openAt,
    submit_deadline_at: openAt + config.submit_window_sec * 1000,
    reveal_end_at: 0,
    n_at_open: 0,
    announced: false,
    submissions: [],
    submissions_by_question: {},
    scores,
    per_question: [],
    qualify_ratio: config.qualify_ratio,
    reveal_ms: Math.max(0, config.reveal_sec) * 1000,
  }
}

function questionOf(ctx: ReduceCtx, state: BuzzState): Question | undefined {
  const qid = state.qids[state.q_index]
  return ctx.questions.find((question) => question.id === qid)
}

/** 题面广播：只带题面与选项，答案只能从 reveal 出（§5.8） */
function questionMessage(state: BuzzState, ctx: ReduceCtx, config: BuzzConfig): ServerMsg | null {
  const question = questionOf(ctx, state)
  if (!question) return null
  return {
    t: 'question',
    index: state.q_index,
    total: state.qids.length,
    qid: question.id,
    type: question.type,
    stem: question.stem,
    stem_images: question.stem_images,
    options: question.options,
    buffer_ms: config.buffer_ms,
    deadline_at: state.submit_deadline_at,
  }
}

/** 本题提交是否已经收齐（`close_on_all_submitted` 用） */
function allSubmitted(state: BuzzState, ctx: ReduceCtx): boolean {
  const config = configOf(ctx)
  if (!config.close_on_all_submitted) return false
  const n = Math.max(1, state.n_at_open)
  return state.submissions.length >= Math.min(n, eligibleTeams(ctx))
}

/** 结算本题：排序 → 计分 → 公布答案 */
function closeQuestion(
  state: BuzzState,
  at: number,
  reason: 'timeout' | 'all_submitted',
  ctx: ReduceCtx,
): { state: BuzzState; effects: Effects } {
  const config = configOf(ctx)
  const question = questionOf(ctx, state)
  const ranked = rankBuzz({
    submissions: state.submissions.map((item) => ({ team_id: item.team_id, at: item.at, correct: item.correct })),
    n_at_open: Math.max(1, state.n_at_open),
    qualify_ratio: config.qualify_ratio,
    qualify_fill: config.qualify_fill,
    tie_window_ms: config.tie_window_ms,
    correct_points: config.correct_points,
    wrong_points: config.wrong_points,
  })

  const byTeam = new Map(ranked.ranking.map((entry) => [entry.team_id, entry]))
  const submissions = state.submissions.map((item) => {
    const entry = byTeam.get(item.team_id)
    return {
      ...item,
      rank: entry?.rank,
      tied: entry?.tied,
      in_quota: entry?.in_quota,
      awarded: entry?.awarded ?? 0,
    }
  })

  const scores = { ...state.scores }
  for (const item of submissions) scores[item.team_id] = (scores[item.team_id] ?? 0) + (item.awarded ?? 0)

  const qid = state.qids[state.q_index] ?? ''
  const result: BuzzQuestionResult = {
    qid,
    n_at_open: state.n_at_open,
    quota: ranked.quota,
    close_reason: reason,
    ranking: ranked.ranking,
  }

  const revealEndAt = at + state.reveal_ms
  const next: BuzzState = {
    ...state,
    phase: 'reveal',
    close_reason: reason,
    submissions,
    submissions_by_question: { ...state.submissions_by_question, [qid]: submissions },
    scores,
    per_question: [...state.per_question, result],
    reveal_end_at: revealEndAt,
    // 下一次定时器：解析停留结束
    deadline_at: revealEndAt,
  }

  const effects: Effects = {
    broadcast: [
      {
        t: 'reveal',
        items: question ? [{ qid: question.id, answer: question.answer, explain: question.explain }] : [],
      },
      {
        t: 'score',
        teams: state.roster.teams.map((team) => ({ id: team.id, name: team.name, score: scores[team.id] ?? 0 })),
      },
    ],
    log: [
      {
        at,
        event: 'buzz_closed',
        qid,
        data: {
          reason,
          quota: ranked.quota,
          n_at_open: state.n_at_open,
          boundary_tie_expanded: ranked.boundary_tie_expanded,
          ranking: ranked.ranking.map((entry) => `${entry.rank}:${entry.team_id}:${entry.awarded}`),
        },
      },
    ],
  }
  return { state: next, effects }
}

function endMatch(state: BuzzState, at: number, reason: EndReason, ctx: ReduceCtx): { state: BuzzState; effects: Effects } {
  const ended: BuzzState = {
    ...state,
    phase: 'ended',
    ended_at: at,
    end_reason: reason,
    deadline_at: at,
  }
  const summary = summarize(ended, ctx)
  return {
    state: ended,
    effects: {
      broadcast: [{ t: 'ended', summary }],
      log: [{ at, event: 'match_ended', data: { reason, scores: ended.scores } }],
    },
  }
}

/** 进入下一题（或整场结束） */
function nextQuestion(state: BuzzState, at: number, ctx: ReduceCtx): { state: BuzzState; effects: Effects } {
  const config = configOf(ctx)
  const nextIndex = state.q_index + 1
  if (nextIndex >= state.qids.length) return endMatch(state, at, 'all_done', ctx)

  const openAt = at + Math.max(0, config.buffer_ms)
  const next: BuzzState = {
    ...state,
    phase: 'buffer',
    q_index: nextIndex,
    open_at: openAt,
    submit_deadline_at: openAt + config.submit_window_sec * 1000,
    reveal_end_at: 0,
    close_reason: undefined,
    submissions: [],
    n_at_open: 0,
    announced: false,
    deadline_at: openAt,
  }
  return {
    state: next,
    effects: {
      log: [{ at, event: 'buzz_question', data: { index: nextIndex, qid: next.qids[nextIndex] } }],
    },
  }
}

/** buffer 期先把题面推下去（禁抢），到 open_at 只切阶段，不重复推题 */
function announceQuestion(state: BuzzState, at: number, ctx: ReduceCtx): { state: BuzzState; effects: Effects } {
  const config = configOf(ctx)
  const next: BuzzState = { ...state, announced: true }
  const message = questionMessage(next, ctx, config)
  return {
    state: next,
    effects: {
      broadcast: message ? [message] : [],
      log: [
        {
          at,
          event: 'buzz_announce',
          qid: next.qids[next.q_index],
          data: { open_at: next.open_at, buffer_ms: config.buffer_ms },
        },
      ],
    },
  }
}

function openQuestion(state: BuzzState, at: number, ctx: ReduceCtx): { state: BuzzState; effects: Effects } {
  const config = configOf(ctx)
  const next: BuzzState = {
    ...state,
    phase: 'open',
    n_at_open: eligibleTeams(ctx),
    deadline_at: state.submit_deadline_at,
    announced: true,
  }
  // 兜底：若题面还没推过（例如驱动器没在开局送 TICK），开抢时补推一次
  const message = state.announced ? null : questionMessage(next, ctx, config)
  return {
    state: next,
    effects: {
      broadcast: message ? [message] : [],
      log: [
        {
          at,
          event: 'buzz_open',
          qid: next.qids[next.q_index],
          data: { n_at_open: next.n_at_open, deadline_at: next.submit_deadline_at },
        },
      ],
    },
  }
}

function handleSubmit(state: BuzzState, event: MatchEvent, ctx: ReduceCtx): { state: BuzzState; effects: Effects } {
  const memberId = event.actor_id ?? ''
  const teamId = teamOf(state, memberId)
  const qid = state.qids[state.q_index] ?? ''

  if (!teamId) {
    return {
      state,
      effects: { to_member: [{ member_id: memberId, messages: [{ t: 'error', code: 'NOT_AUTHORIZED', message: '你不在任何队伍里' }] }] },
    }
  }
  if (state.phase === 'buffer') {
    // 抢跑：丢弃并记账，但不判罚（缓冲期的意义就是给网络留余量）
    return {
      state,
      effects: {
        to_member: [{ member_id: memberId, messages: [{ t: 'error', code: 'WINDOW_CLOSED', message: '还没开始抢答，题面刚要出现' }] }],
        log: [{ at: event.at, event: 'early_submit', participant_id: memberId, team_id: teamId, qid }],
      },
    }
  }
  if (state.phase !== 'open') {
    return {
      state,
      effects: {
        to_member: [{ member_id: memberId, messages: [{ t: 'error', code: 'WINDOW_CLOSED', message: '本题的抢答窗口已经关闭' }] }],
      },
    }
  }
  if (state.submissions.some((item) => item.team_id === teamId)) {
    return {
      state,
      effects: {
        to_member: [
          {
            member_id: memberId,
            messages: [{ t: 'ack', seq: event.seq ?? 0, qid, accepted: false, locked: true }],
          },
        ],
      },
    }
  }

  const question = questionOf(ctx, state)
  if (!question) {
    return { state, effects: {} }
  }

  const choice = normalizeChoice(event.choice ?? [])
  const verdict = judge({ question, choice, scoring: ctx.paper.scoring, answered: choice.length > 0 })
  const record: BuzzSubmissionRecord = { team_id: teamId, at: event.at, choice, correct: verdict.correct }

  const next: BuzzState = { ...state, submissions: [...state.submissions, record] }
  // 抢答是 stream：判完就把对错告诉本队（窗口内只有本队看得到）
  const ack: ServerMsg = {
    t: 'ack',
    seq: event.seq ?? 0,
    qid,
    accepted: true,
    locked: true,
    correct: verdict.correct,
  }

  const effects: Effects = {
    to_team: [{ team_id: teamId, messages: [ack] }],
    log: [
      {
        at: event.at,
        event: 'buzz_submit',
        participant_id: memberId,
        team_id: teamId,
        qid,
        data: { rank: next.submissions.length, correct: verdict.correct },
      },
    ],
  }

  if (allSubmitted(next, ctx)) {
    const closed = closeQuestion(next, event.at, 'all_submitted', ctx)
    return { state: closed.state, effects: mergeEffects(effects, closed.effects) }
  }
  return { state: next, effects }
}

function mergeEffects(a: Effects, b: Effects): Effects {
  return {
    broadcast: [...(a.broadcast ?? []), ...(b.broadcast ?? [])],
    to_team: [...(a.to_team ?? []), ...(b.to_team ?? [])],
    to_member: [...(a.to_member ?? []), ...(b.to_member ?? [])],
    timers: [...(a.timers ?? []), ...(b.timers ?? [])],
    log: [...(a.log ?? []), ...(b.log ?? [])],
  }
}

function reduce(state: BuzzState, event: MatchEvent, ctx: ReduceCtx): { state: BuzzState; effects: Effects } {
  if (state.phase === 'ended') return { state, effects: {} }

  switch (event.type) {
    case 'START':
      return { state, effects: {} }
    case 'TICK': {
      if (state.phase === 'buffer') {
        if (event.at >= state.open_at) return openQuestion(state, event.at, ctx)
        // 还没到开抢点：先把题面推下去，让玩家有缓冲期看题
        if (!state.announced) return announceQuestion(state, event.at, ctx)
        return { state, effects: {} }
      }
      if (state.phase === 'open' && event.at >= state.submit_deadline_at) {
        return closeQuestion(state, state.submit_deadline_at, 'timeout', ctx)
      }
      if (state.phase === 'reveal' && event.at >= state.reveal_end_at) {
        return nextQuestion(state, state.reveal_end_at, ctx)
      }
      return { state, effects: {} }
    }
    case 'SUBMIT':
      return handleSubmit(state, event, ctx)
    case 'END':
      return endMatch(state, event.at, event.reason === 'time' ? 'time' : event.reason === 'all_done' ? 'all_done' : 'host', ctx)
    default:
      // buz 没有「下一题」「交棒」「换主答」「交卷」：全部由计时器推进
      return { state, effects: {} }
  }
}

function view(state: BuzzState, viewerId: string | null, at: number): PublicMatchState {
  const names = state.roster.names ?? {}
  const teamId = teamOf(state, viewerId)
  const currentQid = state.qids[state.q_index] ?? ''

  const answers: Record<string, string[]> = {}
  const locked: string[] = []
  const mine = teamId ? state.submissions_by_question : {}
  for (const [qid, list] of Object.entries(mine)) {
    const own = list.find((item) => item.team_id === teamId)
    if (!own) continue
    answers[qid] = [...own.choice]
    locked.push(qid)
  }
  if (teamId) {
    const current = state.submissions.find((item) => item.team_id === teamId)
    if (current && !answers[currentQid]) {
      answers[currentQid] = [...current.choice]
      locked.push(currentQid)
    }
  }

  const peers: PeerInfo[] = []
  for (const team of state.roster.teams) {
    for (const memberId of team.member_ids) {
      const submitted = state.submissions.some((item) => item.team_id === team.id)
      peers.push({
        id: memberId,
        name: names[memberId] ?? memberId,
        team_id: team.id,
        online: true,
        ready: true,
        progress: { answered: submitted ? 1 : 0, total: state.total },
        is_answerer: false,
      })
    }
  }

  const base: PublicBase = {
    format: 'buzz',
    phase: state.phase,
    server_at: at,
    clock: {
      started_at: state.started_at,
      deadline_at: state.deadline_at,
      submit_deadline_at: state.phase === 'open' || state.phase === 'reveal' ? state.submit_deadline_at : state.open_at,
      reveal_end_at: state.phase === 'reveal' ? state.reveal_end_at : undefined,
    },
    current_index: state.q_index,
    total: state.total,
    viewer_id: viewerId,
    own: {
      scope: 'team',
      answers,
      locked,
      can_submit: state.phase === 'open' && teamId !== null && !state.submissions.some((item) => item.team_id === teamId),
    },
    peers,
    scores: state.roster.teams.map((team) => ({ team_id: team.id, name: team.name, score: state.scores[team.id] ?? 0 })),
    notice: state.notice,
  }

  return {
    ...base,
    format: 'buzz',
    q_index: state.q_index,
    n_at_open: state.n_at_open,
    submitted_teams: state.submissions.map((item) => item.team_id),
    quota: Math.ceil(Math.max(1, state.n_at_open) * state.qualify_ratio),
  }
}

function summarize(state: BuzzState, ctx: ReduceCtx): MatchSummary {
  const config = configOf(ctx)
  const teams: TeamResult[] = state.roster.teams.map((team) => {
    const detail: TeamResult['detail'] = []
    for (const question of ctx.questions) {
      const list = state.submissions_by_question[question.id] ?? []
      const own = list.find((item) => item.team_id === team.id)
      detail.push({
        qid: question.id,
        choice: own ? [...own.choice] : null,
        correct: own?.correct ?? false,
        points: own?.awarded ?? 0,
      })
    }
    const correct = detail.filter((item) => item.correct).length
    return {
      id: team.id,
      name: team.name,
      score: state.scores[team.id] ?? 0,
      max_score: state.total * config.correct_points,
      members: team.member_ids.map((memberId) => ({
        id: memberId,
        name: state.roster.names?.[memberId] ?? memberId,
        score: 0,
        answered: detail.filter((item) => item.choice !== null).length,
        correct: 0,
      })),
      detail,
    }
  })

  return {
    format: 'buzz',
    started_at: state.started_at,
    ended_at: state.ended_at ?? state.started_at,
    end_reason: state.end_reason ?? 'all_done',
    teams,
    questions: ctx.questions.map((question) => ({
      qid: question.id,
      type: question.type,
      answer: question.answer,
      explain: question.explain,
      scored: isScorable(question),
    })),
    degraded_notice: ctx.degraded_notice,
    buzz_per_question: state.per_question.map((item) => ({
      qid: item.qid,
      n_at_open: item.n_at_open,
      quota: item.quota,
      close_reason: item.close_reason,
      ranking: item.ranking.map((entry) => ({
        team_id: entry.team_id,
        at: entry.at,
        correct: entry.correct,
        rank: entry.rank,
        tied: entry.tied,
        awarded: entry.awarded,
      })),
    })),
  }
}

function isEnded(state: BuzzState): boolean {
  return state.phase === 'ended'
}

export const buzzSpec = {
  id: 'buzz' as const,
  init,
  reduce,
  view,
  is_ended: isEnded,
  summarize,
}
