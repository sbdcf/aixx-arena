import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initMatch, reduce, view, soloSpec, type SoloState } from '../src/formats/index.ts'
import type { Effects, MatchEvent, ReduceCtx } from '../src/state.ts'
import type { Paper } from '../src/types.ts'
import { makeQuestion } from './fixtures.ts'

const questions = [
  makeQuestion({ id: 'q1', type: 'single', answer: ['A'] }),
  makeQuestion({ id: 'q2', type: 'multiple', answer: ['A', 'C'] }),
  makeQuestion({ id: 'q3', type: 'judge', answer: ['T'] }),
]

function makePaper(overrides: Partial<Paper> = {}): Paper {
  return {
    schema_version: 1,
    id: 'paper-test-solo',
    name: '测试卷',
    format: 'solo',
    duration_sec: 60,
    draw: null,
    submit_mode: 'batch',
    scoring: {
      mode: 'per_question',
      points: { single: 1, multiple: 2, judge: 1 },
      wrong_penalty: 0,
      unanswered: 0,
      total_normalize: 100,
    },
    ...overrides,
  }
}

function makeCtx(overrides: Partial<ReduceCtx> = {}): ReduceCtx {
  return {
    paper: makePaper(),
    questions,
    roster: {
      teams: [{ id: 't1', name: '一队', member_ids: ['m1'], captain_id: 'm1' }],
      names: { m1: '小明' },
    },
    ...overrides,
  }
}

const T0 = 1_700_000_000_000

function start(ctx = makeCtx()): SoloState {
  const state = initMatch(ctx, T0)
  if (state.format !== 'solo') throw new Error('expected solo state')
  return state
}

function sub(qid: string, choice: string[], seq: number, actor = 'm1'): MatchEvent {
  return { type: 'SUBMIT', at: T0 + 1000, actor_id: actor, qid, choice, seq }
}

test('init：开赛即固化总题数、截止时间与每人的空答卷', () => {
  const ctx = makeCtx()
  const state = start(ctx)
  assert.equal(state.format, 'solo')
  assert.equal(state.phase, 'answering')
  assert.equal(state.total, 3)
  assert.equal(state.deadline_at, T0 + 60_000)
  assert.deepEqual(Object.keys(state.sheets), ['m1'])
  assert.deepEqual(state.sheets.m1.answers, {})
})

test('view：只带本人答卷，队友进度可见，游标为 null', () => {
  const snapshot = view(start(), 'm1', T0 + 500)
  assert.equal(snapshot.format, 'solo')
  assert.equal(snapshot.server_at, T0 + 500)
  assert.equal(snapshot.current_index, null)
  assert.equal(snapshot.total, 3)
  assert.equal(snapshot.viewer_id, 'm1')
  assert.deepEqual(snapshot.clock, { started_at: T0, deadline_at: T0 + 60_000 })
  assert.deepEqual(snapshot.own, {
    scope: 'member',
    answers: {},
    locked: [],
    can_submit: true,
    finished: false,
  })
  assert.equal(snapshot.peers.length, 1)
  assert.equal(snapshot.peers[0].name, '小明')
  assert.deepEqual(snapshot.peers[0].progress, { answered: 0, total: 3 })
})

test('batch：逐题静默上报，ack 不带 correct，且答案可回改', () => {
  const ctx = makeCtx()
  const first = reduceSolo(start(ctx), sub('q1', ['A'], 1), ctx)
  assert.deepEqual(first.effects.to_member?.[0].messages, [
    { t: 'ack', seq: 1, qid: 'q1', accepted: true, locked: false },
  ])
  assert.deepEqual(first.state.sheets.m1.answers.q1.choice, ['A'])

  // 回改：batch 模式允许改答案
  const second = reduceSolo(first.state, sub('q1', ['B'], 2), ctx)
  assert.deepEqual(second.state.sheets.m1.answers.q1.choice, ['B'])
  assert.equal(second.state.sheets.m1.last_seq, 2)
})

test('batch：seq 不递增的补发被静默丢弃，不改状态也不回 ack', () => {
  const ctx = makeCtx()
  const once = reduceSolo(start(ctx), sub('q1', ['A'], 5), ctx)
  const replay = reduceSolo(once.state, sub('q1', ['B'], 5), ctx)
  assert.equal(replay.state.sheets.m1.answers.q1.choice[0], 'A')
  // note: 不要用 assert.deepEqual 比较 effects —— node:assert 的断言签名会把
  // actual 收窄成 expected 的类型，后面再读其它字段就会报「属性不存在」。
  assert.equal(replay.effects.log?.[0].event, 'stale_seq')
  assert.equal(replay.effects.to_member, undefined)
})

test('stream：提交即锁，ack 带对错与得分，重复提交幂等', () => {
  const ctx = makeCtx({ paper: makePaper({ submit_mode: 'stream' }) })
  const first = reduceSolo(start(ctx), sub('q1', ['A'], 1), ctx)
  assert.deepEqual(first.effects.to_member?.[0].messages, [
    { t: 'ack', seq: 1, qid: 'q1', accepted: true, locked: true, correct: true, points: 1 },
  ])
  assert.deepEqual(first.state.sheets.m1.locked, ['q1'])

  const again = reduceSolo(first.state, sub('q1', ['B'], 2), ctx)
  assert.deepEqual(again.effects.to_member?.[0].messages, [
    { t: 'ack', seq: 2, qid: 'q1', accepted: false, locked: true },
  ])
  // 锁定后改答案无效
  assert.deepEqual(again.state.sheets.m1.answers.q1.choice, ['A'])
})

test('未知题号回 BAD_MESSAGE，越权提交只记日志', () => {
  const ctx = makeCtx()
  const bad = reduceSolo(start(ctx), sub('nope', ['A'], 1), ctx)
  assert.deepEqual(bad.effects.to_member?.[0].messages, [
    { t: 'error', code: 'BAD_MESSAGE', message: '未知题号' },
  ])

  const stranger = reduceSolo(start(ctx), sub('q1', ['A'], 1, 'ghost'), ctx)
  assert.equal(stranger.effects.to_member, undefined)
  assert.equal(stranger.effects.log?.[0].event, 'submit_not_authorized')
})

test('TICK：未到期不动，到期自动交卷（end_reason=time）', () => {
  const ctx = makeCtx()
  const state = start(ctx)

  const early = reduceSolo(state, { type: 'TICK', at: T0 + 59_999 }, ctx)
  assert.equal(early.state.phase, 'answering')

  const late = reduceSolo(state, { type: 'TICK', at: T0 + 60_500 }, ctx)
  assert.equal(late.state.phase, 'ended')
  assert.equal(late.state.end_reason, 'time')
  // 结束时刻取 deadline，而不是迟到的 TICK 时刻
  assert.equal(late.state.ended_at, T0 + 60_000)
})

test('END：广播 summary + 逐人 reveal，结束后重复事件幂等', () => {
  const ctx = makeCtx()
  const answered = reduceSolo(start(ctx), sub('q1', ['A'], 1), ctx)
  const ended = reduceSolo(answered.state, { type: 'END', at: T0 + 10_000, reason: 'self' }, ctx)

  const broadcast = ended.effects.broadcast ?? []
  assert.equal(broadcast.length, 1)
  const message = broadcast[0]
  assert.equal(message.t, 'ended')
  if (message.t !== 'ended') throw new Error('unreachable')
  assert.equal(message.summary.end_reason, 'self')
  assert.equal(message.summary.teams.length, 1)

  const reveal = ended.effects.to_member?.[0].messages[0]
  assert.ok(reveal)
  assert.equal(reveal.t, 'reveal')
  if (reveal.t !== 'reveal') throw new Error('unreachable')
  assert.deepEqual(
    reveal.items.map((item) => item.qid),
    ['q1', 'q2', 'q3'],
  )
  assert.deepEqual(reveal.items[0].answer, ['A'])

  const after = reduceSolo(ended.state, { type: 'END', at: T0 + 20_000, reason: 'host' }, ctx)
  assert.equal(after.effects.broadcast, undefined)
  assert.equal(after.state.end_reason, 'self')
})

test('summarize：只答对 1 道单选时按 100 分制折算为 25 分', () => {
  const ctx = makeCtx()
  const answered = reduceSolo(start(ctx), sub('q1', ['A'], 1), ctx)
  const ended = reduceSolo(answered.state, { type: 'END', at: T0 + 10_000, reason: 'self' }, ctx)
  const message = ended.effects.broadcast?.[0]
  if (!message || message.t !== 'ended') throw new Error('unreachable')

  const team = message.summary.teams[0]
  assert.equal(team.name, '小明')
  // 原始满分 = 1 + 2 + 1 = 4，答对 1 分 → 25
  assert.equal(team.score, 25)
  assert.equal(team.max_score, 100)
  assert.equal(team.members[0].answered, 1)
  assert.equal(team.members[0].correct, 1)
  assert.deepEqual(
    team.detail.map((d) => [d.qid, d.choice, d.correct, d.points]),
    [
      ['q1', ['A'], true, 1],
      ['q2', null, false, 0],
      ['q3', null, false, 0],
    ],
  )
})

test('summarize：无答案的题不进满分分母，questions 标 scored=false', () => {
  const pending = makeQuestion({ id: 'q4', type: 'single', answer: [], answer_status: 'pending' })
  const ctx = makeCtx({ questions: [...questions, pending] })
  const state = start(ctx)
  const ended = reduceSolo(state, { type: 'END', at: T0 + 10_000, reason: 'self' }, ctx)
  const message = ended.effects.broadcast?.[0]
  if (!message || message.t !== 'ended') throw new Error('unreachable')

  assert.equal(message.summary.questions.length, 4)
  assert.equal(message.summary.questions[3].scored, false)
  // 满分仍是 4 分题折算 100
  assert.equal(message.summary.teams[0].max_score, 100)
  assert.equal(message.summary.teams[0].score, 0)
})

test('结束后 view 的 can_submit 变 false，phase 变 ended', () => {
  const ctx = makeCtx()
  const state = start(ctx)
  const ended = reduceSolo(state, { type: 'END', at: T0 + 10_000, reason: 'self' }, ctx)
  const snapshot = view(ended.state, 'm1', T0 + 10_000)
  assert.equal(snapshot.phase, 'ended')
  assert.equal(snapshot.own.can_submit, false)
})

test('spec 元数据：id / is_ended 一致', () => {
  assert.equal(soloSpec.id, 'solo')
  assert.equal(soloSpec.is_ended(start()), false)
})

/** 测试助手：把 MatchState 收窄回 SoloState，省掉每个用例里的 format 断言 */
function reduceSolo(
  state: ReturnType<typeof start>,
  event: MatchEvent,
  ctx: ReduceCtx,
): { state: ReturnType<typeof start>; effects: Effects } {
  const result = reduce(state, event, ctx)
  if (result.state.format !== 'solo') throw new Error('expected solo state')
  return { state: result.state, effects: result.effects }
}