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
]

function makePaper(overrides: Partial<Paper> = {}): Paper {
  return {
    schema_version: 1,
    id: 'paper-test-buzz',
    name: '抢答赛测试卷',
    format: 'buzz',
    duration_sec: 0,
    draw: { single: 3, multiple: 0, judge: 0, min_available: 1, allow_partial: true },
    submit_mode: 'stream',
    scoring: {
      mode: 'correct_minus_wrong',
      points: { single: 4, multiple: 4, judge: 4 },
      wrong_penalty: 0,
      unanswered: 0,
      total_normalize: 0,
    },
    buzz: {
      buffer_ms: 1000,
      submit_window_sec: 20,
      qualify_ratio: 0.5,
      qualify_fill: 'strict',
      correct_points: 4,
      wrong_points: -1,
      reveal_sec: 5,
      close_on_all_submitted: false,
      tie_window_ms: 5,
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
        { id: 't1', name: '一队', member_ids: ['m1', 'm2'], captain_id: 'm1' },
        { id: 't2', name: '二队', member_ids: ['m3', 'm4'], captain_id: 'm3' },
        { id: 't3', name: '三队', member_ids: ['m5'], captain_id: 'm5' },
      ],
      names: { m1: '甲', m2: '乙', m3: '丙', m4: '丁', m5: '戊' },
    },
    ...overrides,
  }
}

const T0 = 1_700_000_000_000
const OPEN_AT = T0 + 1000
const DEADLINE = OPEN_AT + 20_000

function start(ctx = makeCtx()) {
  const state = initMatch(ctx, T0)
  if (state.format !== 'buzz') throw new Error('expected buzz')
  return state
}

function reduceBuzz(
  state: ReturnType<typeof start>,
  event: MatchEvent,
  ctx: ReduceCtx,
): { state: ReturnType<typeof start>; effects: Effects } {
  const result = reduce(state, event, ctx)
  if (result.state.format !== 'buzz') throw new Error('expected buzz state')
  return { state: result.state, effects: result.effects }
}

function tick(at: number): MatchEvent {
  return { type: 'TICK', at }
}

function sub(qid: string, choice: string[], actor: string, at: number, seq = 1): MatchEvent {
  return { type: 'SUBMIT', at, actor_id: actor, qid, choice, seq }
}

test('buzz init：缓冲期开局，定时器指向开抢时刻', () => {
  const ctx = makeCtx()
  const state = start(ctx)
  assert.equal(state.phase, 'buffer')
  assert.equal(state.q_index, 0)
  assert.equal(state.total, 3)
  assert.equal(state.open_at, OPEN_AT)
  assert.equal(state.submit_deadline_at, DEADLINE)
  assert.equal(state.deadline_at, OPEN_AT, '缓冲期的截止 = 开抢时刻，驱动器据此送第一个 TICK')
  assert.deepEqual(state.scores, { t1: 0, t2: 0, t3: 0 })

  const snapshot = view(state, 'm1', T0)
  assert.equal(snapshot.format, 'buzz')
  if (snapshot.format !== 'buzz') return
  assert.equal(snapshot.phase, 'buffer')
  assert.equal(snapshot.own.can_submit, false, '缓冲期不能交')
  assert.equal(snapshot.own.scope, 'team')
})

test('buffer 期提交被拒并记 early_submit；TICK 到点广播题面但不含答案', () => {
  const ctx = makeCtx()
  let { state } = { state: start(ctx) }

  const early = reduceBuzz(state, sub('q1', ['A'], 'm1', T0 + 300), ctx)
  assert.equal(early.state.phase, 'buffer')
  const earlyError = early.effects.to_member?.[0]?.messages?.[0]
  assert.equal(earlyError?.t, 'error')
  assert.equal((earlyError as { code?: string }).code, 'WINDOW_CLOSED')
  assert.equal(early.effects.log?.[0]?.event, 'early_submit')

  const opened = reduceBuzz(state, tick(OPEN_AT), ctx)
  state = opened.state
  assert.equal(state.phase, 'open')
  assert.equal(state.n_at_open, 3)
  assert.equal(state.deadline_at, DEADLINE)

  const message = opened.effects.broadcast?.find((item) => item.t === 'question')
  assert.ok(message)
  if (message?.t !== 'question') return
  assert.equal(message.qid, 'q1')
  assert.equal(message.deadline_at, DEADLINE)
  assert.equal('answer' in message, false, '题面消息绝不能带答案')
  assert.equal('explain' in message, false, '解析留到 reveal')

  const snapshot = view(state, 'm1', OPEN_AT + 100)
  if (snapshot.format !== 'buzz') throw new Error('expected buzz view')
  assert.equal(snapshot.own.can_submit, true)
  assert.equal(snapshot.quota, 2, '3 队 × 0.5 向上取整 = 2 个名额')
})

test('open 期提交：ack 带对错、同队二次提交被锁', () => {
  const ctx = makeCtx()
  const opened = reduceBuzz(start(ctx), tick(OPEN_AT), ctx)

  const first = reduceBuzz(opened.state, sub('q1', ['A'], 'm1', OPEN_AT + 500, 1), ctx)
  const ack = first.effects.to_team?.[0]?.messages?.[0]
  assert.equal(ack?.t, 'ack')
  if (ack?.t !== 'ack') return
  assert.equal(ack.accepted, true)
  assert.equal(ack.correct, true, '抢答是 stream 赛制，判完就把对错告诉本队')
  assert.equal(first.state.scores.t1, 0, '得分要等排序结算，不在提交时加')

  const again = reduceBuzz(first.state, sub('q1', ['B'], 'm2', OPEN_AT + 600, 2), ctx)
  const locked = again.effects.to_member?.[0]?.messages?.[0]
  assert.equal(locked?.t, 'ack')
  if (locked?.t !== 'ack') return
  assert.equal(locked.accepted, false)
  assert.equal(locked.locked, true)
  assert.equal(again.state.submissions.length, 1, '每队每题只留一条')
})

test('到点结算：按收包时刻排序，名额内答对加分，名额顺延关掉', () => {
  const ctx = makeCtx()
  let state = reduceBuzz(start(ctx), tick(OPEN_AT), ctx).state
  state = reduceBuzz(state, sub('q1', ['A'], 'm1', OPEN_AT + 1000), ctx).state
  state = reduceBuzz(state, sub('q1', ['B'], 'm3', OPEN_AT + 1400), ctx).state // 答错，但抢到名额
  state = reduceBuzz(state, sub('q1', ['A'], 'm5', OPEN_AT + 2000), ctx).state // 答对，排第 3，名额之外

  const closed = reduceBuzz(state, tick(DEADLINE), ctx)
  state = closed.state
  assert.equal(state.phase, 'reveal')
  assert.equal(state.close_reason, 'timeout')
  assert.equal(state.deadline_at, DEADLINE + 5000, '进入 reveal 后定时器指向解析结束')

  // 一队答对 +4；二队抢到名额但答错 −1；三队答对但名额之外不得分（strict）
  assert.deepEqual(state.scores, { t1: 4, t2: -1, t3: 0 })

  const reveal = closed.effects.broadcast?.find((item) => item.t === 'reveal')
  assert.ok(reveal, 'closed 即刻公布答案')
  if (reveal?.t !== 'reveal') return
  assert.deepEqual(reveal.items[0]?.answer, ['A'])

  const score = closed.effects.broadcast?.find((item) => item.t === 'score')
  assert.ok(score)

  const result = state.per_question[0]
  assert.equal(result?.quota, 2)
  assert.equal(result?.n_at_open, 3)
  assert.deepEqual(
    result?.ranking.map((entry) => `${entry.rank}:${entry.team_id}:${entry.awarded}`),
    ['1:t1:4', '2:t2:-1', '3:t3:0'],
  )
})

test('5ms 内的并列按整簇计入，簇跨越名额边界时整簇都进', () => {
  const ctx = makeCtx()
  let state = reduceBuzz(start(ctx), tick(OPEN_AT), ctx).state
  // 三队都在 5ms 内到达 → 同一名次，整簇计入（即便名额只有 2）
  state = reduceBuzz(state, sub('q1', ['A'], 'm1', OPEN_AT + 2000), ctx).state
  state = reduceBuzz(state, sub('q1', ['A'], 'm3', OPEN_AT + 2002), ctx).state
  state = reduceBuzz(state, sub('q1', ['A'], 'm5', OPEN_AT + 2004), ctx).state

  const closed = reduceBuzz(state, tick(DEADLINE), ctx)
  state = closed.state
  assert.deepEqual(state.scores, { t1: 4, t2: 4, t3: 4 })
  assert.equal(state.per_question[0]?.ranking.every((entry) => entry.rank === 1), true)
  assert.equal(state.per_question[0]?.ranking.every((entry) => entry.tied), true)
})

test('close_on_all_submitted：本队都交齐就立刻关窗', () => {
  const ctx = makeCtx({ paper: makePaper({ buzz: { ...makePaper().buzz!, close_on_all_submitted: true } }) })
  let state = reduceBuzz(start(ctx), tick(OPEN_AT), ctx).state
  state = reduceBuzz(state, sub('q1', ['A'], 'm1', OPEN_AT + 100), ctx).state
  state = reduceBuzz(state, sub('q1', ['A'], 'm3', OPEN_AT + 200), ctx).state
  const closed = reduceBuzz(state, sub('q1', ['A'], 'm5', OPEN_AT + 300), ctx)
  assert.equal(closed.state.phase, 'reveal')
  assert.equal(closed.state.close_reason, 'all_submitted')
  assert.equal(closed.state.per_question[0]?.close_reason, 'all_submitted')
})

test('reveal 停留结束 → 下一题回到缓冲期，最后一题结算后整场结束', () => {
  const ctx = makeCtx()
  let state = reduceBuzz(start(ctx), tick(OPEN_AT), ctx).state
  state = reduceBuzz(state, sub('q1', ['A'], 'm1', OPEN_AT + 500), ctx).state
  const closed = reduceBuzz(state, tick(DEADLINE), ctx)
  state = closed.state
  assert.equal(state.phase, 'reveal')

  const revealEnd = state.reveal_end_at
  const next = reduceBuzz(state, tick(revealEnd), ctx)
  state = next.state
  assert.equal(state.phase, 'buffer')
  assert.equal(state.q_index, 1)
  assert.equal(state.open_at, revealEnd + 1000)
  assert.deepEqual(state.submissions, [])

  // 第 2、3 题快速走完
  for (const qid of ['q2', 'q3']) {
    const open = reduceBuzz(state, tick(state.open_at), ctx)
    state = open.state
    const answered = reduceBuzz(state, sub(qid, ['A'], 'm1', state.open_at + 500), ctx)
    state = answered.state
    const done = reduceBuzz(state, tick(state.submit_deadline_at), ctx)
    state = done.state
    if (state.q_index < state.qids.length - 1 || state.phase === 'reveal') {
      const advanced = reduceBuzz(state, tick(state.reveal_end_at), ctx)
      state = advanced.state
    }
  }

  assert.equal(state.phase, 'ended')
  assert.equal(state.end_reason, 'all_done')

  const summary = summarize(state, ctx)
  assert.equal(summary.format, 'buzz')
  assert.equal(summary.buzz_per_question?.length, 3)
  assert.equal(summary.teams.length, 3)
  assert.equal(summary.teams[0]?.max_score, 3 * 4, '满分 = 题数 × 答对分')
  assert.equal(summary.questions.length, 3)
})

test('END 立即结束整场（房主中止）', () => {
  const ctx = makeCtx()
  const opened = reduceBuzz(start(ctx), tick(OPEN_AT), ctx)
  const ended = reduceBuzz(opened.state, { type: 'END', at: OPEN_AT + 5000, reason: 'host' }, ctx)
  assert.equal(ended.state.phase, 'ended')
  assert.equal(ended.state.end_reason, 'host')
  const endedMessage = ended.effects.broadcast?.find((item) => item.t === 'ended')
  assert.ok(endedMessage)
  assert.equal(ended.effects.broadcast?.some((item) => item.t === 'reveal'), false, '中止不公布答案')
})
