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

  // 正常：判分 + ack 带 correct/points + 广播实时榜；本棒内不锁（可继续改）
  const ok = reduceRelay(s0, sub('q1', ['A'], 'm1'), ctx)
  assert.equal(ok.state.teams.t1.answers.q1.correct, true)
  assert.equal(ok.state.teams.t1.answers.q1.points, 4)
  assert.deepEqual(ok.effects.to_member?.[0], {
    member_id: 'm1',
    messages: [{ t: 'ack', seq: 1, qid: 'q1', accepted: true, locked: false, correct: true, points: 4 }],
  })
  assert.deepEqual(ok.effects.broadcast?.[0], {
    t: 'score',
    teams: [
      { id: 't1', name: '一队', score: 4 },
      { id: 't2', name: '二队', score: 0 },
    ],
  })

  // 本棒内重复提交 = 覆写并重新判分（改答案 / 多选继续勾选都靠它）
  const again = reduceRelay(ok.state, sub('q1', ['B'], 'm1'), ctx)
  assert.equal(again.state.teams.t1.answers.q1.correct, false)
  assert.equal(again.state.teams.t1.answers.q1.points, -1)
  assert.deepEqual(again.effects.to_member?.[0], {
    member_id: 'm1',
    messages: [{ t: 'ack', seq: 1, qid: 'q1', accepted: true, locked: false, correct: false, points: -1 }],
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

test('relay 多选：先少选后补全会覆写重判（不再点一个就锁死）', () => {
  const multiQuestions = [
    makeQuestion({ id: 'q1', type: 'multiple', answer: ['A', 'C'] }),
    makeQuestion({ id: 'q2', type: 'single', answer: ['B'] }),
    makeQuestion({ id: 'q3', type: 'single', answer: ['C'] }),
    makeQuestion({ id: 'q4', type: 'single', answer: ['D'] }),
    makeQuestion({ id: 'q5', type: 'single', answer: ['A'] }),
    makeQuestion({ id: 'q6', type: 'single', answer: ['B'] }),
  ]
  const ctx = makeCtx({
    questions: multiQuestions,
    paper: makePaper({
      legs: [
        { single: 1, multiple: 1, judge: 0, min_available: 2, allow_partial: true },
        { single: 2, multiple: 0, judge: 0, min_available: 2, allow_partial: true },
        { single: 2, multiple: 0, judge: 0, min_available: 2, allow_partial: true },
      ],
    }),
  })
  const s0 = start(ctx)

  // 多选第一次只勾了 A（少选 = 错），第二次补上 C（完整答案 = 对）
  const partial = reduceRelay(s0, sub('q1', ['A'], 'm1'), ctx)
  assert.equal(partial.state.teams.t1.answers.q1.correct, false)
  assert.equal(partial.state.teams.t1.answers.q1.points, -1)

  const full = reduceRelay(partial.state, sub('q1', ['A', 'C'], 'm1', T0 + 2000), ctx)
  assert.equal(full.state.teams.t1.answers.q1.correct, true)
  assert.equal(full.state.teams.t1.answers.q1.points, 4)
  assert.deepEqual(full.effects.broadcast?.[0], {
    t: 'score',
    teams: [
      { id: 't1', name: '一队', score: 4 },
      { id: 't2', name: '二队', score: 0 },
    ],
  })
})

test('relay view.locked：本棒答案可改所以不锁，交棒后历史棒锁定，封卷后全锁', () => {
  const ctx = makeCtx()
  const s0 = start(ctx)

  const a1 = reduceRelay(s0, sub('q1', ['A'], 'm1'), ctx)
  const beforeHandoff = view(a1.state, 'm1', T0 + 1000)
  assert.deepEqual(beforeHandoff.own.locked, [])

  const handed = reduceRelay(a1.state, { type: 'HANDOFF', at: T0 + 2000, actor_id: 'm1' }, ctx)
  const afterHandoff = view(handed.state, 'm2', T0 + 2000)
  assert.deepEqual(afterHandoff.own.locked, ['q1'])

  // 第 2 棒再答一题 → 仍不锁；本队封卷后全部锁定
  const a3 = reduceRelay(handed.state, sub('q3', ['C'], 'm2', T0 + 2500), ctx)
  assert.deepEqual(view(a3.state, 'm2', T0 + 2500).own.locked, ['q1'])
  const finished = reduceRelay(a3.state, { type: 'FINISH', at: T0 + 3000, actor_id: 'm2' }, ctx)
  const locked = view(finished.state, 'm2', T0 + 3000).own.locked
  assert.equal(locked.length, 2)
  assert.ok(locked.includes('q1'))
  assert.ok(locked.includes('q3'))
})

test('relay leg_order：赛前指定的棒次优先，成员/去重后按默认序补齐', () => {
  const ctx = makeCtx({
    roster: {
      teams: [
        { id: 't1', name: '一队', member_ids: ['m1', 'm2', 'm3'], captain_id: 'm1', leg_order: ['m3', 'm1', 'm2'] },
        { id: 't2', name: '二队', member_ids: ['m4', 'm5'], captain_id: 'm4', leg_order: ['m5', 'm4'] },
      ],
      names: { m1: '甲', m2: '乙', m3: '丙', m4: '丁', m5: '戊' },
    },
  })
  const state = start(ctx)
  assert.deepEqual(state.teams.t1.leg_order, ['m3', 'm1', 'm2'])
  // 2 人队指定顺序后仍循环补齐第 3 棒
  assert.deepEqual(state.teams.t2.leg_order, ['m5', 'm4', 'm5'])
  assert.deepEqual(state.short_teams, ['t2'])

  // 首棒变成了 m3：只有 m3 能提交
  const viewM3 = view(state, 'm3', T0)
  if (viewM3.format !== 'relay') throw new Error('expected relay view')
  assert.equal(viewM3.own.can_submit, true)
  assert.equal(viewM3.current_answerer_id, 'm3')
  const denied = reduceRelay(state, sub('q1', ['A'], 'm1'), ctx)
  assert.equal(denied.effects.to_member?.[0]?.messages[0]?.t, 'error')

  // 顺序里混入非本队成员/重复项：过滤后仍按默认序补齐，保证一人一棒
  const dirty = makeCtx({
    roster: {
      teams: [{ id: 't1', name: '一队', member_ids: ['m1', 'm2', 'm3'], captain_id: 'm1', leg_order: ['m2', 'ghost', 'm2'] }],
      names: { m1: '甲', m2: '乙', m3: '丙' },
    },
  })
  const dirtyState = start(dirty)
  assert.deepEqual(dirtyState.teams.t1.leg_order, ['m2', 'm1', 'm3'])
})
