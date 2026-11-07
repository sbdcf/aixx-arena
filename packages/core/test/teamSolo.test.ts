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
    id: 'paper-test-team-solo',
    name: '团队个人赛测试卷',
    format: 'team-solo',
    duration_sec: 300,
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
      teams: [
        { id: 't1', name: '一队', member_ids: ['m1', 'm2'], captain_id: 'm1' },
        { id: 't2', name: '二队', member_ids: ['m3'], captain_id: 'm3' },
      ],
      names: { m1: '小明', m2: '小红', m3: '小林' },
    },
    ...overrides,
  }
}

const T0 = 1_700_000_000_000

function start(ctx = makeCtx()) {
  const state = initMatch(ctx, T0)
  if (state.format !== 'team-solo') throw new Error('expected team-solo')
  return state
}

function reduceTeamSolo(
  state: ReturnType<typeof start>,
  event: MatchEvent,
  ctx: ReduceCtx,
): { state: ReturnType<typeof start>; effects: Effects } {
  const result = reduce(state, event, ctx)
  if (result.state.format !== 'team-solo') throw new Error('expected team-solo state')
  return { state: result.state, effects: result.effects }
}

function sub(qid: string, choice: string[], seq: number, actor: string): MatchEvent {
  return { type: 'SUBMIT', at: T0 + 1000, actor_id: actor, qid, choice, seq }
}

test('team-solo init：截止时间、成员空答卷、总题数', () => {
  const state = start()
  assert.equal(state.format, 'team-solo')
  assert.equal(state.deadline_at, T0 + 300_000)
  assert.equal(state.total, 3)
  assert.deepEqual(Object.keys(state.sheets).sort(), ['m1', 'm2', 'm3'])
  assert.deepEqual(state.sheets.m1, { answers: {}, locked: [], last_seq: 0 })
})

test('team-solo：队内各自作答，互不可见；团队进度按题去重', () => {
  const ctx = makeCtx()
  const s0 = start(ctx)
  const s1 = reduceTeamSolo(s0, sub('q1', ['A'], 1, 'm1'), ctx)
  const s2 = reduceTeamSolo(s1.state, sub('q1', ['A'], 1, 'm2'), ctx).state

  const snapshot = view(s2, 'm1', T0 + 2000)
  assert.equal(snapshot.format, 'team-solo')
  if (snapshot.format !== 'team-solo') return
  // 自己视角只看得到自己的答案
  assert.deepEqual(snapshot.own.answers, { q1: ['A'] })
  // 两人都答了 q1 → 团队进度仍算 1 题
  assert.deepEqual(snapshot.team, { id: 't1', answered: 1, total: 3 })
  assert.equal(snapshot.peers.length, 3)
})

test('team-solo：stream 提交即锁，ack 带对错，重复提交幂等', () => {
  const ctx = makeCtx()
  const first = reduceTeamSolo(start(ctx), sub('q2', ['A', 'C'], 1, 'm1'), ctx)
  assert.deepEqual(first.effects.to_member?.[0].messages, [
    { t: 'ack', seq: 1, qid: 'q2', accepted: true, locked: true, correct: true, points: 2 },
  ])
  assert.deepEqual(first.state.sheets.m1.locked, ['q2'])

  const again = reduceTeamSolo(first.state, sub('q2', ['A', 'B'], 2, 'm1'), ctx)
  assert.deepEqual(again.effects.to_member?.[0].messages, [
    { t: 'ack', seq: 2, qid: 'q2', accepted: false, locked: true },
  ])
  assert.deepEqual(again.state.sheets.m1.answers.q2.choice, ['A', 'C'])
})

test('team-solo summarize：团队总分 = Σ 成员分，满分按人数放大', () => {
  const ctx = makeCtx()
  let state = start(ctx)
  state = reduceTeamSolo(state, sub('q1', ['A'], 1, 'm1'), ctx).state
  state = reduceTeamSolo(state, sub('q2', ['A', 'C'], 1, 'm2'), ctx).state
  state = reduceTeamSolo(state, sub('q3', ['T'], 1, 'm3'), ctx).state

  const ended = reduceTeamSolo(state, { type: 'END', at: T0 + 10_000, reason: 'self' }, ctx)
  const endedMsg = ended.effects.broadcast?.[0]
  if (!endedMsg || endedMsg.t !== 'ended') throw new Error('unreachable')
  const summary = endedMsg.summary

  assert.equal(summary.format, 'team-solo')
  assert.equal(summary.teams.length, 2)

  const t1 = summary.teams.find((team) => team.id === 't1')!
  // 小明答对单选 +1，小红答对多选 +2
  assert.equal(t1.score, 3)
  // 单个成员满分 4（1+2+1），两人队 = 8
  assert.equal(t1.max_score, 8)
  assert.deepEqual(
    t1.members.map((member) => [member.id, member.score, member.correct]),
    [
      ['m1', 1, 1],
      ['m2', 2, 1],
    ],
  )

  const t2 = summary.teams.find((team) => team.id === 't2')!
  assert.equal(t2.score, 1)
  assert.equal(t2.max_score, 4)
})

test('team-solo END：广播 ended，并给每个成员发 reveal', () => {
  const ctx = makeCtx()
  const ended = reduceTeamSolo(start(ctx), { type: 'END', at: T0 + 10_000, reason: 'self' }, ctx)
  const endedMsg = ended.effects.broadcast?.[0]
  if (!endedMsg || endedMsg.t !== 'ended') throw new Error('unreachable')
  assert.equal(endedMsg.summary.end_reason, 'self')
  assert.equal(ended.effects.to_member?.length, 3)
  assert.equal(ended.effects.to_member?.[0].messages[0].t, 'reveal')
  assert.equal(ended.state.phase, 'ended')

  // 结束后再提交：幂等忽略
  const after = reduceTeamSolo(ended.state, sub('q1', ['A'], 9, 'm1'), ctx)
  assert.deepEqual(after.effects, {})
})

test('team-solo TICK：到点用 deadline_at 结算，reason=time', () => {
  const ctx = makeCtx()
  const tick = reduceTeamSolo(start(ctx), { type: 'TICK', at: T0 + 300_000 + 500 }, ctx)
  assert.equal(tick.state.phase, 'ended')
  assert.equal(tick.state.ended_at, T0 + 300_000)
  assert.equal(tick.state.end_reason, 'time')
})
