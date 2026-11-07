/**
 * FINISH = 本人封卷（design §5.5.1）。
 *
 * 这组用例守的是三件事：
 * 1. 单人局封卷即结算（all_done），不用等到点；
 * 2. 团队个人赛各封各的，全员封卷才结算，早交的人只收到「等队友」；
 * 3. 封卷之后不能再改答案（否则「封卷」这个词就没意义了）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initMatch, reduce, view } from '../src/formats/index.ts'
import type { MatchEvent, ReduceCtx } from '../src/state.ts'
import type { ServerMsg } from '../src/protocol.ts'
import type { Paper } from '../src/types.ts'
import { makeQuestion } from './fixtures.ts'

const questions = [
  makeQuestion({ id: 'q1', type: 'single', answer: ['A'] }),
  makeQuestion({ id: 'q2', type: 'single', answer: ['B'] }),
]

function makePaper(format: Paper['format']): Paper {
  return {
    schema_version: 1,
    id: `paper-${format}`,
    name: '测试卷',
    format,
    duration_sec: 300,
    draw: null,
    submit_mode: 'stream',
    scoring: {
      mode: 'per_question',
      points: { single: 2, multiple: 2, judge: 2 },
      wrong_penalty: 0,
      unanswered: 0,
      total_normalize: 0,
    },
  }
}

function ctxOf(format: Paper['format'], members: string[]): ReduceCtx {
  return {
    paper: makePaper(format),
    questions,
    roster: {
      teams: [
        {
          id: 't1',
          name: '一队',
          member_ids: members,
          captain_id: members[0],
        },
      ],
      names: Object.fromEntries(members.map((id) => [id, `选手${id}`])),
    },
  }
}

const T0 = 1_700_000_000_000

const submit = (qid: string, choice: string[], actor: string, seq = 1): MatchEvent => ({
  type: 'SUBMIT',
  at: T0 + 1000,
  actor_id: actor,
  qid,
  choice,
  seq,
})

const finish = (actor: string): MatchEvent => ({ type: 'FINISH', at: T0 + 2000, actor_id: actor })

function messagesOf(effects: { to_member?: { member_id: string; messages: ServerMsg[] }[] }, memberId: string): ServerMsg[] {
  return (effects.to_member ?? []).filter((item) => item.member_id === memberId).flatMap((item) => item.messages)
}

test('solo：封卷立即结算，end_reason=all_done 且下发 reveal', () => {
  const ctx = ctxOf('solo', ['m1'])
  let state = initMatch(ctx, T0)
  const submitted = reduce(state, submit('q1', ['A'], 'm1'), ctx)
  state = submitted.state

  const result = reduce(state, finish('m1'), ctx)
  assert.equal(result.state.phase, 'ended')
  assert.equal(result.state.end_reason, 'all_done')
  assert.equal(result.state.ended_at, T0 + 2000)

  const summary = result.effects.broadcast?.find((message) => message.t === 'ended')
  assert.ok(summary && summary.t === 'ended')
  assert.equal(summary.summary.end_reason, 'all_done')
  assert.equal(summary.summary.teams[0]?.score, 2)

  const reveal = messagesOf(result.effects, 'm1').find((message) => message.t === 'reveal')
  assert.ok(reveal && reveal.t === 'reveal')
  assert.equal(reveal.items.length, 2)
})

test('solo：封卷后视图 own.finished=true、can_submit=false', () => {
  const ctx = ctxOf('solo', ['m1'])
  const state = initMatch(ctx, T0)
  const result = reduce(state, finish('m1'), ctx)
  const snapshot = view(result.state, 'm1', T0 + 3000)
  assert.equal(snapshot.own.finished, true)
  assert.equal(snapshot.own.can_submit, false)
})

test('重复封卷：未结束时只回提示不改时间，已结算后一切幂等', () => {
  // 已结算的局：任何事件都不再改变状态（design 「结束后幂等」）
  const soloCtx = ctxOf('solo', ['m1'])
  const once = reduce(initMatch(soloCtx, T0), finish('m1'), soloCtx)
  const twice = reduce(once.state, finish('m1'), soloCtx)
  assert.equal(twice.state.phase, 'ended')
  assert.equal(twice.state.ended_at, T0 + 2000, '第二次封卷不能改写 ended_at')
  assert.deepEqual(twice.effects, {})

  // 还没结算的局（team-solo 有人没交）：重复封卷只回提示，finished_at 不变
  const teamCtx = ctxOf('team-solo', ['m1', 'm2'])
  const first = reduce(initMatch(teamCtx, T0), finish('m1'), teamCtx)
  const second = reduce(first.state, finish('m1'), teamCtx)
  assert.equal(second.state.phase, 'answering')
  const notice = messagesOf(second.effects, 'm1').find((message) => message.t === 'notice')
  assert.ok(notice, '重复封卷要给人话提示')
  const sheet = (second.state as { sheets: Record<string, { finished_at?: number }> }).sheets['m1']
  assert.equal(sheet?.finished_at, T0 + 2000)
})

test('team-solo：一人封卷不结束全场，只回「等队友」；全员封卷才结算', () => {
  const ctx = ctxOf('team-solo', ['m1', 'm2'])
  let state = initMatch(ctx, T0)

  const first = reduce(state, finish('m1'), ctx)
  state = first.state
  assert.equal(state.phase, 'answering')

  const notice = messagesOf(first.effects, 'm1').find((message) => message.t === 'notice')
  assert.ok(notice && notice.t === 'notice')
  assert.match(notice.text, /1\/2/)

  const m1View = view(state, 'm1', T0 + 3000)
  const m2View = view(state, 'm2', T0 + 3000)
  assert.equal(m1View.own.finished, true)
  assert.equal(m1View.own.can_submit, false)
  assert.equal(m2View.own.finished, false)
  assert.equal(m2View.own.can_submit, true)

  const second = reduce(state, finish('m2'), ctx)
  assert.equal(second.state.phase, 'ended')
  assert.equal(second.state.end_reason, 'all_done')
})

test('team-solo：封卷之后提交被拒（WINDOW_CLOSED），答案不变', () => {
  const ctx = ctxOf('team-solo', ['m1', 'm2'])
  const answered = reduce(initMatch(ctx, T0), submit('q1', ['A'], 'm1'), ctx)
  const finished = reduce(answered.state, finish('m1'), ctx)
  const late = reduce(finished.state, submit('q2', ['B'], 'm1', 2), ctx)

  const error = messagesOf(late.effects, 'm1').find((message) => message.t === 'error')
  assert.ok(error && error.t === 'error')
  assert.equal(error.code, 'WINDOW_CLOSED')
  const sheet = (late.state as { sheets: Record<string, { answers: Record<string, unknown> }> }).sheets['m1']
  assert.deepEqual(Object.keys(sheet?.answers ?? {}), ['q1'])
})

test('team-solo：到点结算时封卷状态不影响已答成绩', () => {
  const ctx = ctxOf('team-solo', ['m1', 'm2'])
  const answered = reduce(initMatch(ctx, T0), submit('q1', ['A'], 'm1'), ctx)
  const finished = reduce(answered.state, finish('m1'), ctx)

  const state = finished.state
  const timeout = reduce(state, { type: 'TICK', at: state.deadline_at + 1 }, ctx)
  assert.equal(timeout.state.phase, 'ended')
  assert.equal(timeout.state.end_reason, 'time')
  const summary = timeout.effects.broadcast?.find((message) => message.t === 'ended')
  assert.ok(summary && summary.t === 'ended')
  assert.equal(summary.summary.teams[0]?.members.find((member) => member.id === 'm1')?.score, 2)
})

test('team-coop：FINISH 不是这个赛制的动作，状态不动', () => {
  const ctx = ctxOf('team-coop', ['m1', 'm2', 'm3'])
  const state = initMatch(ctx, T0)
  const result = reduce(state, finish('m1'), ctx)
  assert.equal(result.state.phase, state.phase)
  assert.deepEqual(result.effects, {})
})
