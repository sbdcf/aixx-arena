import assert from 'node:assert/strict'
import { test } from 'node:test'

import { initMatch, reduce, view } from '../src/formats/index.ts'
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
    id: 'paper-test-team-coop',
    name: '团队赛测试卷',
    format: 'team-coop',
    duration_sec: 1200,
    draw: null,
    submit_mode: 'stream',
    scoring: {
      mode: 'per_question',
      points: { single: 1, multiple: 2, judge: 1 },
      wrong_penalty: 0,
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
      teams: [{ id: 't1', name: '一队', member_ids: ['m1', 'm2', 'm3'], captain_id: 'm1' }],
      names: { m1: '主答', m2: '辅助甲', m3: '辅助乙' },
    },
    ...overrides,
  }
}

const T0 = 1_700_000_000_000

function start(ctx = makeCtx()) {
  const state = initMatch(ctx, T0)
  if (state.format !== 'team-coop') throw new Error('expected team-coop')
  return state
}

function reduceCoop(
  state: ReturnType<typeof start>,
  event: MatchEvent,
  ctx: ReduceCtx,
): { state: ReturnType<typeof start>; effects: Effects } {
  const result = reduce(state, event, ctx)
  if (result.state.format !== 'team-coop') throw new Error('expected team-coop state')
  return { state: result.state, effects: result.effects }
}

function sub(qid: string, choice: string[], actor: string, seq = 1): MatchEvent {
  return { type: 'SUBMIT', at: T0 + 1000, actor_id: actor, qid, choice, seq }
}

function advance(actor: string, at = T0 + 2000): MatchEvent {
  return { type: 'ADVANCE', at, actor_id: actor }
}

test('team-coop init：每队 answerer = 队长，游标 0', () => {
  const state = start()
  assert.equal(state.format, 'team-coop')
  assert.equal(state.deadline_at, T0 + 1_200_000)
  assert.equal(state.total, 3)
  assert.equal(state.teams.t1.answerer_id, 'm1')
  assert.equal(state.teams.t1.current_index, 0)
  assert.equal(state.max_raw, 4)
})

test('team-coop：辅助位提交被拒，主答提交判分并锁定', () => {
  const ctx = makeCtx()
  const s0 = start(ctx)

  const aux = reduceCoop(s0, sub('q1', ['A'], 'm2'), ctx)
  assert.deepEqual(aux.effects.to_member?.[0], {
    member_id: 'm2',
    messages: [{ t: 'error', code: 'NOT_AUTHORIZED', message: '只有主答可以提交' }],
  })
  assert.deepEqual(aux.state.teams.t1.answers, {})

  const ok = reduceCoop(s0, sub('q1', ['A'], 'm1'), ctx)
  assert.deepEqual(ok.effects.to_member?.[0].messages, [
    { t: 'ack', seq: 1, qid: 'q1', accepted: true, locked: true, correct: true, points: 1 },
  ])
  assert.deepEqual(ok.state.teams.t1.locked, ['q1'])
  // 广播实时榜（给全房）
  const scoreMsg = ok.effects.broadcast?.[0]
  if (!scoreMsg || scoreMsg.t !== 'score') throw new Error('unreachable')
  assert.deepEqual(scoreMsg.teams, [{ id: 't1', name: '一队', score: 1 }])

  // 同一题重复提交：幂等，不重复计分
  const again = reduceCoop(ok.state, sub('q1', ['A'], 'm1', 2), ctx)
  assert.equal(again.effects.to_member?.[0].messages[0].t, 'ack')
  assert.deepEqual(again.state.teams.t1.answers.q1.choice, ['A'])
})

test('team-coop：ADVANCE 只有主答或队长能推，推满一队 = 该队交卷', () => {
  const ctx = makeCtx()
  const s0 = start(ctx)

  const byAux = reduceCoop(s0, advance('m2'), ctx)
  assert.equal(byAux.state.teams.t1.current_index, 0)
  assert.deepEqual(byAux.effects.to_member?.[0].messages[0], {
    t: 'error',
    code: 'NOT_AUTHORIZED',
    message: '只有主答或队长可以切题',
  })

  const s1 = reduceCoop(s0, advance('m1'), ctx)
  assert.equal(s1.state.teams.t1.current_index, 1)
  const s2 = reduceCoop(s1.state, advance('m1'), ctx)
  assert.equal(s2.state.teams.t1.current_index, 2)

  // 第 3 次 ADVANCE：超过末题 ≡ 交卷（唯一一队 → 全场结束）
  const s3 = reduceCoop(s2.state, advance('m1'), ctx)
  assert.equal(s3.state.phase, 'ended')
  assert.equal(s3.state.end_reason, 'all_done')
  const ended = s3.effects.broadcast?.[0]
  if (!ended || ended.t !== 'ended') throw new Error('unreachable')
  assert.equal(ended.summary.format, 'team-coop')
  assert.equal(ended.summary.end_reason, 'all_done')
})

test('team-coop：队长可换主答，换人后辅助位变主答', () => {
  const ctx = makeCtx()
  const s0 = start(ctx)

  // 辅助不能换主答
  const denied = reduceCoop(s0, { type: 'SET_ANSWERER', at: T0 + 500, actor_id: 'm2', member_id: 'm3' }, ctx)
  assert.equal(denied.effects.to_member?.[0].messages[0].t, 'error')

  const changed = reduceCoop(
    s0,
    { type: 'SET_ANSWERER', at: T0 + 500, actor_id: 'm1', team_id: 't1', member_id: 'm3' },
    ctx,
  )
  assert.equal(changed.state.teams.t1.answerer_id, 'm3')
  assert.equal(changed.effects.log?.[0].event, 'set_answerer')

  // m3 现在能提交，m1 不能
  const byM3 = reduceCoop(changed.state, sub('q3', ['T'], 'm3'), ctx)
  assert.equal(byM3.effects.to_member?.[0].messages[0].t, 'ack')
  const byM1 = reduceCoop(changed.state, sub('q3', ['T'], 'm1'), ctx)
  assert.equal(byM1.effects.to_member?.[0].messages[0].t, 'error')
})

test('team-coop：view 的 own.scope=team、辅助 can_submit=false、current_index 共享', () => {
  const ctx = makeCtx()
  const s0 = start(ctx)
  const s1 = reduceCoop(s0, sub('q1', ['A'], 'm1'), ctx).state
  const s2 = reduceCoop(s1, advance('m1'), ctx).state

  const answererView = view(s2, 'm1', T0 + 3000)
  assert.equal(answererView.format, 'team-coop')
  if (answererView.format !== 'team-coop') return
  assert.equal(answererView.own.scope, 'team')
  assert.equal(answererView.own.can_submit, true)
  assert.deepEqual(answererView.own.answers, { q1: ['A'] })
  assert.equal(answererView.current_index, 1)
  assert.equal(answererView.answerer_id, 'm1')
  assert.equal(answererView.team_id, 't1')

  const auxView = view(s2, 'm2', T0 + 3000)
  assert.equal(auxView.own.can_submit, false)
  // 辅助看到的是同一份本队答卷
  assert.deepEqual(auxView.own.answers, { q1: ['A'] })
})

test('team-coop TICK：到点结算，reason=time', () => {
  const ctx = makeCtx()
  const tick = reduceCoop(start(ctx), { type: 'TICK', at: T0 + 1_200_000 + 1 }, ctx)
  assert.equal(tick.state.phase, 'ended')
  assert.equal(tick.state.ended_at, T0 + 1_200_000)
  assert.equal(tick.state.end_reason, 'time')
})

test('team-coop 多队同场：一队交卷不结束全场，全部交卷或房主 end 才结束', () => {
  const ctx = makeCtx({
    roster: {
      teams: [
        { id: 't1', name: '一队', member_ids: ['m1', 'm2', 'm3'], captain_id: 'm1' },
        { id: 't2', name: '二队', member_ids: ['n1', 'n2', 'n3'], captain_id: 'n1' },
      ],
      names: { m1: '主答', n1: '二队主答' },
    },
  })
  let state = start(ctx)

  // t1 推满 3 题 → 交卷，但 t2 未完成 → 全场未结束
  for (let i = 0; i < 3; i++) state = reduceCoop(state, advance('m1', T0 + 1000 * (i + 1)), ctx).state
  assert.equal(state.teams.t1.finished_at, T0 + 3000)
  assert.equal(state.phase, 'answering')

  // 房主 end → 全场结束，未交卷的 t2 按已答内容结算
  const ended = reduceCoop(state, { type: 'END', at: T0 + 4000, reason: 'host' }, ctx)
  assert.equal(ended.state.phase, 'ended')
  assert.equal(ended.state.end_reason, 'host')
  const msg = ended.effects.broadcast?.[0]
  if (!msg || msg.t !== 'ended') throw new Error('unreachable')
  assert.equal(msg.summary.teams.length, 2)
})
