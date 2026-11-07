import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initMatch, reduce, summarize, view } from '../src/formats/index.ts'
import type { Effects, MatchEvent, ReduceCtx } from '../src/state.ts'
import type { Paper } from '../src/types.ts'
import { makeQuestion } from './fixtures.ts'

const questions = [
  makeQuestion({ id: 'q1', type: 'single', answer: ['A'] }),
  makeQuestion({ id: 'q2', type: 'single', answer: ['B'] }),
  makeQuestion({ id: 'q3', type: 'single', answer: ['C'] }),
  makeQuestion({ id: 'q4', type: 'single', answer: ['D'] }),
  makeQuestion({ id: 'q5', type: 'single', answer: ['A'] }),
  makeQuestion({ id: 'q6', type: 'single', answer: ['B'] }),
]

const LEG_SEC = 300

function makePaper(overrides: Partial<Paper> = {}): Paper {
  return {
    schema_version: 1,
    id: 'paper-test-relay',
    name: '接力赛测试卷',
    format: 'relay',
    duration_sec: LEG_SEC,
    draw: null,
    legs: [
      { single: 2, multiple: 0, judge: 0, min_available: 2, allow_partial: true },
      { single: 2, multiple: 0, judge: 0, min_available: 2, allow_partial: true },
      { single: 2, multiple: 0, judge: 0, min_available: 2, allow_partial: true },
    ],
    submit_mode: 'stream',
    scoring: {
      mode: 'correct_minus_wrong',
      points: { single: 4, multiple: 4, judge: 4 },
      wrong_penalty: 1,
      unanswered: 0,
      total_normalize: 0,
    },
    ...overrides,
  }
}

function makeCtx(overrides: Partial<ReduceCtx> = {}): ReduceCtx {
  return {
    paper: makePaper(),
    questions,
    roster: {
      teams: [
        { id: 't1', name: '一队', member_ids: ['m1', 'm2', 'm3'], captain_id: 'm1' },
        { id: 't2', name: '二队', member_ids: ['m4', 'm5'], captain_id: 'm4' },
      ],
      names: { m1: '甲', m2: '乙', m3: '丙', m4: '丁', m5: '戊' },
    },
    ...overrides,
  }
}

const T0 = 1_700_000_000_000

function start(ctx = makeCtx()) {
  const state = initMatch(ctx, T0)
  if (state.format !== 'relay') throw new Error('expected relay')
  return state
}

function reduceRelay(
  state: ReturnType<typeof start>,
  event: MatchEvent,
  ctx: ReduceCtx,
): { state: ReturnType<typeof start>; effects: Effects } {
  const result = reduce(state, event, ctx)
  if (result.state.format !== 'relay') throw new Error('expected relay state')
  return { state: result.state, effects: result.effects }
}

function sub(qid: string, choice: string[], actor: string, at = T0 + 1000, seq = 1): MatchEvent {
  return { type: 'SUBMIT', at, actor_id: actor, qid, choice, seq }
}

test('relay init：三棒切分、队长在首棒、全局截止 = 3X', () => {
  const state = start()
  assert.deepEqual(state.leg_question_ids, [
    ['q1', 'q2'],
    ['q3', 'q4'],
    ['q5', 'q6'],
  ])
  assert.equal(state.deadline_at, T0 + LEG_SEC * 3 * 1000)
  assert.deepEqual(state.teams.t1.leg_order, ['m1', 'm2', 'm3'])
  assert.equal(state.teams.t1.leg_index, 0)
  assert.equal(state.teams.t1.current_index, 0)
  assert.equal(state.teams.t1.leg_budget_sec, LEG_SEC)
  assert.equal(state.teams.t1.carry_sec, 0)
  // 2 人队循环补齐
  assert.deepEqual(state.teams.t2.leg_order, ['m4', 'm5', 'm4'])
  assert.deepEqual(state.short_teams, ['t2'])
  assert.equal(state.max_raw, 24)
})

test('relay 提交：只有当前棒选手、且只能交本棒的题', () => {
  const ctx = makeCtx()
  const s0 = start(ctx)

  // 二棒选手提前交：拒绝
  const early = reduceRelay(s0, sub('q1', ['A'], 'm2'), ctx)
  assert.deepEqual(early.effects.to_member?.[0], {
    member_id: 'm2',
    messages: [{ t: 'error', code: 'NOT_AUTHORIZED', message: '现在不是你这一棒' }],
  })
  assert.deepEqual(early.state.teams.t1.answers, {})

  // 当前棒选手交了别棒的题：拒绝
  const wrongLeg = reduceRelay(s0, sub('q3', ['C'], 'm1'), ctx)
  assert.deepEqual(wrongLeg.effects.to_member?.[0], {
    member_id: 'm1',
    messages: [{ t: 'error', code: 'BAD_MESSAGE', message: '这一棒的题目里没有这个题号' }],
  })

  // 正常：判分 + ack 带 correct/points + 广播实时榜
  const ok = reduceRelay(s0, sub('q1', ['A'], 'm1'), ctx)
  assert.equal(ok.state.teams.t1.answers.q1.correct, true)
  assert.equal(ok.state.teams.t1.answers.q1.points, 4)
  assert.deepEqual(ok.effects.to_member?.[0], {
    member_id: 'm1',
    messages: [{ t: 'ack', seq: 1, qid: 'q1', accepted: true, locked: true, correct: true, points: 4 }],
  })
  assert.deepEqual(ok.effects.broadcast?.[0], {
    t: 'score',
    teams: [
      { id: 't1', name: '一队', score: 4 },
      { id: 't2', name: '二队', score: 0 },
    ],
  })

  // 重复提交：accepted:false locked:true
  const again = reduceRelay(ok.state, sub('q1', ['A'], 'm1'), ctx)
  assert.deepEqual(again.effects.to_member?.[0]?.messages[0], {
    t: 'ack',
    seq: 1,
    qid: 'q1',
    accepted: false,
    locked: true,
  })
})

test('relay 推满本棒 ≡ 交棒：carry = 预算 - 已用秒数，下一棒预算 = X + carry', () => {
  const ctx = makeCtx()
  const s0 = start(ctx)

  const a1 = reduceRelay(s0, sub('q1', ['A'], 'm1', T0 + 60_000), ctx)
  const step1 = reduceRelay(a1.state, { type: 'ADVANCE', at: T0 + 60_000, actor_id: 'm1' }, ctx)
  assert.equal(step1.state.teams.t1.current_index, 1)
  const a2 = reduceRelay(step1.state, sub('q2', ['B'], 'm1', T0 + 120_000), ctx)
  // 已用 120 秒 → carry = 300 - 120 = 180；推过末题自动交棒
  const handed = reduceRelay(a2.state, { type: 'ADVANCE', at: T0 + 120_000, actor_id: 'm1' }, ctx)

  assert.equal(handed.state.teams.t1.leg_index, 1)
  assert.equal(handed.state.teams.t1.current_index, 0)
  assert.equal(handed.state.teams.t1.leg_started_at, T0 + 120_000)
  assert.equal(handed.state.teams.t1.carry_sec, 180)
  assert.equal(handed.state.teams.t1.leg_budget_sec, LEG_SEC + 180)
  assert.equal(handed.state.teams.t1.leg_order[1], 'm2')
  // 时间守恒：全局截止不因交棒而改变
  assert.equal(handed.state.deadline_at, T0 + LEG_SEC * 3 * 1000)
  // 交棒提示发给新一棒
  assert.equal(handed.effects.to_member?.[0]?.member_id, 'm2')
  assert.deepEqual(handed.effects.log?.[0]?.data, {
    from: 'm1',
    to: 'm2',
    leg_index: 1,
    carry_sec: 180,
    budget_sec: 480,
  })
})

test('relay HANDOFF 事件同样交棒；非当前棒不能交棒', () => {
  const ctx = makeCtx()
  const s0 = start(ctx)

  const denied = reduceRelay(s0, { type: 'HANDOFF', at: T0 + 10_000, actor_id: 'm2' }, ctx)
  assert.equal(denied.effects.to_member?.[0]?.messages[0]?.t, 'error')
  assert.equal(denied.state.teams.t1.leg_index, 0)

  const ok = reduceRelay(s0, { type: 'HANDOFF', at: T0 + 10_000, actor_id: 'm1' }, ctx)
  assert.equal(ok.state.teams.t1.leg_index, 1)
  assert.equal(ok.state.teams.t1.carry_sec, 290)
  assert.equal(ok.state.teams.t1.leg_budget_sec, LEG_SEC + 290)
})

test('relay TICK：本棒超预算强制交棒且 carry 归零；全局到期结算 time', () => {
  const ctx = makeCtx()
  const s0 = start(ctx)

  // 300 秒到点：强制交棒，carry = 0
  const tick = reduceRelay(s0, { type: 'TICK', at: T0 + LEG_SEC * 1000 }, ctx)
  assert.equal(tick.state.teams.t1.leg_index, 1)
  assert.equal(tick.state.teams.t1.carry_sec, 0)
  assert.equal(tick.state.teams.t1.leg_budget_sec, LEG_SEC)
  assert.equal(tick.state.teams.t1.leg_started_at, T0 + LEG_SEC * 1000)

  // 全局到期：结算 time，summary 里 15... 这里是 6 题
  const ended = reduceRelay(s0, { type: 'TICK', at: T0 + LEG_SEC * 3 * 1000 }, ctx)
  assert.equal(ended.state.phase, 'ended')
  assert.equal(ended.state.end_reason, 'time')
  assert.equal(ended.state.ended_at, T0 + LEG_SEC * 3 * 1000)
  const summary = summarize(ended.state, ctx)
  assert.equal(summary.format, 'relay')
  assert.equal(summary.teams.length, 2)
  assert.equal(summary.questions.length, 6)
  assert.deepEqual(ended.effects.broadcast?.[0]?.t, 'ended')
  // 到期结算：每个成员一条 reveal（只发该队）
  assert.equal(ended.effects.to_team?.length, 2)
})

test('relay 第三棒交棒 → 本队结算（先给该队 reveal）；最后一队结算后全场 all_done', () => {
  const ctx = makeCtx()
  let state = start(ctx)

  // 一队：第 1、2 棒各交一次，第 3 棒再交 → 队完成
  state = reduceRelay(state, { type: 'HANDOFF', at: T0 + 10_000, actor_id: 'm1' }, ctx).state
  state = reduceRelay(state, { type: 'HANDOFF', at: T0 + 20_000, actor_id: 'm2' }, ctx).state
  const first = reduceRelay(state, { type: 'HANDOFF', at: T0 + 30_000, actor_id: 'm3' }, ctx)
  assert.equal(first.state.teams.t1.finished_at, T0 + 30_000)
  assert.equal(first.state.phase, 'answering')
  assert.deepEqual(first.effects.to_team?.[0]?.team_id, 't1')
  assert.equal(first.effects.to_team?.[0]?.messages[0]?.t, 'reveal')

  // 二队连交两次（第 3 棒是 m4 循环补齐）→ 全场结束
  const second = reduceRelay(first.state, { type: 'HANDOFF', at: T0 + 40_000, actor_id: 'm4' }, ctx)
  assert.equal(second.state.teams.t2.leg_index, 1)
  const third = reduceRelay(second.state, { type: 'HANDOFF', at: T0 + 50_000, actor_id: 'm5' }, ctx)
  assert.equal(third.state.teams.t2.leg_index, 2)
  const last = reduceRelay(third.state, { type: 'HANDOFF', at: T0 + 60_000, actor_id: 'm4' }, ctx)
  assert.equal(last.state.phase, 'ended')
  assert.equal(last.state.end_reason, 'all_done')
  assert.equal(last.effects.broadcast?.[0]?.t, 'ended')
})

test('relay submit_all（FINISH）：当前棒选手一键交到第 3 棒结束', () => {
  const ctx = makeCtx()
  const s0 = start(ctx)

  // 非当前棒不能交卷
  const denied = reduceRelay(s0, { type: 'FINISH', at: T0 + 5_000, actor_id: 'm2' }, ctx)
  assert.equal(denied.effects.to_member?.[0]?.messages[0]?.t, 'error')

  const allDone = reduceRelay(s0, { type: 'FINISH', at: T0 + 5_000, actor_id: 'm1' }, ctx)
  // 一键交到第 3 棒结束：一队完成，二队还没动 → 全场仍在进行
  assert.equal(allDone.state.teams.t1.finished_at, T0 + 5_000)
  assert.equal(allDone.state.teams.t1.leg_index, 2)
  assert.equal(allDone.state.phase, 'answering')
})

test('relay view：can_submit 只对当前棒；leg_index / current_answerer_id / 队伍分', () => {
  const ctx = makeCtx()
  const s0 = start(ctx)

  const viewM1 = view(s0, 'm1', T0)
  assert.equal(viewM1.format, 'relay')
  if (viewM1.format !== 'relay') throw new Error('expected relay view')
  assert.equal(viewM1.team_id, 't1')
  assert.equal(viewM1.leg_index, 0)
  assert.deepEqual(viewM1.leg_order, ['m1', 'm2', 'm3'])
  assert.equal(viewM1.current_answerer_id, 'm1')
  assert.equal(viewM1.own.scope, 'team')
  assert.equal(viewM1.own.can_submit, true)
  assert.equal(viewM1.clock.leg_deadline_at, T0 + LEG_SEC * 1000)

  const viewM2 = view(s0, 'm2', T0)
  assert.equal(viewM2.own.can_submit, false)
  if (viewM2.format !== 'relay') throw new Error('expected relay view')
  assert.equal(viewM2.current_answerer_id, 'm1')

  // 交棒后轮到 m2
  const handed = reduceRelay(s0, { type: 'HANDOFF', at: T0 + 10_000, actor_id: 'm1' }, ctx)
  const viewAfter = view(handed.state, 'm2', T0 + 10_000)
  assert.equal(viewAfter.own.can_submit, true)
  if (viewAfter.format !== 'relay') throw new Error('expected relay view')
  assert.equal(viewAfter.leg_index, 1)
  assert.equal(viewAfter.current_answerer_id, 'm2')
  assert.equal(viewAfter.clock.leg_deadline_at, T0 + 10_000 + (LEG_SEC + 290) * 1000)
  // 队伍分：一队 0 分
  assert.deepEqual(viewAfter.scores?.[0], { team_id: 't1', name: '一队', score: 0 })
})
