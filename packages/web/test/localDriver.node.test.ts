/**
 * LocalDriver 端到端测试（不依赖 DOM）。
 *
 * 目的：验证「静态模式 = 浏览器里跑同一份 reduce」这件事真的成立 ——
 * 消息序列、判分、断点续做、到点自动交卷都走同一条链路。
 * 运行：node --test --experimental-test-isolation=none packages/web/test/localDriver.node.test.ts
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  draw,
  initMatch,
  type MatchSummary,
  type Paper,
  type PublicMatchState,
  type ReduceCtx,
  type ServerMsg,
} from '@aixx/core'
import { makePool } from '../../core/test/fixtures.ts'
import { LocalDriver } from '../src/drivers/localDriver.ts'

const T0 = 1_700_000_000_000

function makePaper(overrides: Partial<Paper> = {}): Paper {
  return {
    schema_version: 1,
    id: 'paper-e2e-solo',
    name: '端到端测试卷',
    format: 'solo',
    duration_sec: 60,
    draw: { single: 1, multiple: 1, judge: 1, min_available: 3, allow_partial: true, seed: 7 },
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

function makeCtx(): ReduceCtx {
  const paper = makePaper()
  const pool = makePool({ single: 1, multiple: 1, judge: 1 })
  const { questions } = draw(pool, paper.draw!, 7)
  return {
    paper,
    questions,
    roster: {
      teams: [{ id: 't-local', name: '本机队', member_ids: ['p1'], captain_id: 'p1' }],
      names: { p1: '测试同学' },
    },
  }
}

function collect(driver: LocalDriver): { messages: ServerMsg[]; lastRoom: () => PublicMatchState | null } {
  const messages: ServerMsg[] = []
  driver.on((message) => messages.push(message))
  return {
    messages,
    lastRoom: () => {
      const rooms = messages.filter((m) => m.t === 'room')
      const last = rooms.at(-1)
      return last && last.t === 'room' ? last.snapshot : null
    },
  }
}

test('batch 赛制 1：答题 → 交卷 → 出分，消息流与联机同构', () => {
  const ctx = makeCtx()
  const clock = { now: T0 }
  const driver = new LocalDriver({ matchId: 'm1', viewerId: 'p1', ctx, now: () => clock.now })
  const { messages, lastRoom } = collect(driver)
  driver.start()

  const first = driver.snapshot()
  assert.ok(first)
  assert.equal(first.total, 3)
  assert.equal(first.own.can_submit, true)
  assert.equal(first.viewer_id, 'p1')

  const [single, multiple] = ctx.questions
  assert.ok(single && multiple)

  driver.submit(single.id, single.answer)
  const ack = messages.filter((m) => m.t === 'ack').at(-1)
  assert.ok(ack && ack.t === 'ack')
  assert.equal(ack.accepted, true)
  // batch 模式只存答案，不回对错（否则前端就能反推答案）
  assert.equal(ack.locked, false)
  assert.equal('correct' in ack, false)

  // 答错一题（多选全对才得分）
  driver.submit(multiple.id, ['B'])
  driver.submitAll()

  const summary = driver.summary()
  assert.ok(summary)
  assert.equal(summary.format, 'solo')
  assert.equal(summary.end_reason, 'self')
  assert.equal(summary.teams.length, 1)

  const result = summary.teams[0]!
  assert.equal(result.id, 'p1')
  assert.equal(result.score, 25) // 对 1 分 / 满 4 分 × 100
  assert.equal(result.max_score, 100)
  assert.equal(result.members[0]!.answered, 2)
  assert.equal(result.members[0]!.correct, 1)

  const reveals = messages.filter((m) => m.t === 'reveal')
  assert.equal(reveals.length, 1)
  const reveal = reveals[0]
  assert.ok(reveal && reveal.t === 'reveal')
  assert.equal(reveal.items.length, 3)
  assert.deepEqual(reveal.items[0]!.answer, single.answer)

  const room = lastRoom()
  assert.ok(room)
  assert.equal(room.phase, 'ended')
  assert.equal(room.own.can_submit, false)

  driver.dispose()
})

test('到点自动交卷：迟到 TICK 按 deadline_at 结算，按已答内容给分', async () => {
  const ctx = makeCtx()
  const state = initMatch(ctx, T0)
  const driver = new LocalDriver({
    matchId: 'm2',
    viewerId: 'p1',
    ctx,
    state,
    now: () => T0 + 61_000, // 已经超过 60s 时长
  })
  const { messages } = collect(driver)
  driver.start()

  await new Promise((resolve) => setTimeout(resolve, 120))

  const summary = driver.summary()
  assert.ok(summary)
  assert.equal(summary.end_reason, 'time')
  assert.equal(summary.ended_at, T0 + 60_000)
  assert.equal(summary.teams[0]!.score, 0) // 一题没答，未答不计分

  const reveal = messages.filter((m) => m.t === 'reveal')
  assert.equal(reveal.length, 1)
  driver.dispose()
})

test('断点续做：恢复 state 后 seq 接上，旧答案不丢', () => {
  const ctx = makeCtx()
  const first = new LocalDriver({ matchId: 'm3', viewerId: 'p1', ctx, now: () => T0 })
  first.start()
  first.submit(ctx.questions[0]!.id, ctx.questions[0]!.answer)
  const saved = first.stateForSave()
  first.dispose()

  const second = new LocalDriver({ matchId: 'm3', viewerId: 'p1', ctx, state: saved, now: () => T0 + 1_000 })
  const { messages } = collect(second)
  second.start()

  const restored = second.snapshot()
  assert.ok(restored)
  assert.equal(Object.keys(restored.own.answers).length, 1)

  second.submit(ctx.questions[1]!.id, ['A'])
  const snapshot = second.snapshot()
  assert.ok(snapshot)
  assert.equal(Object.keys(snapshot.own.answers).length, 2)

  // 没有因为 seq 回退而被静默丢弃
  const errors = messages.filter((m) => m.t === 'error')
  assert.equal(errors.length, 0)

  second.submitAll()
  const summary: MatchSummary | null = second.summary()
  assert.ok(summary)
  assert.equal(summary.teams[0]!.members[0]!.answered, 2)
  second.dispose()
})

test('team-coop：主答提交、推进题序；换主答后原主答变只读', () => {
  const paper = makePaper({ id: 'paper-e2e-coop', name: '端到端团队卷', format: 'team-coop', duration_sec: 600, submit_mode: 'stream' })
  const pool = makePool({ single: 2, multiple: 0, judge: 0 })
  const { questions } = draw(pool, { single: 2, multiple: 0, judge: 0, min_available: 2, allow_partial: true, seed: 11 }, 11)
  const ctx: ReduceCtx = {
    paper,
    questions,
    roster: {
      teams: [{ id: 't1', name: '本机队', member_ids: ['p1', 'p2', 'p3'], captain_id: 'p1' }],
      names: { p1: '队长', p2: '辅助甲', p3: '辅助乙' },
    },
  }
  const driver = new LocalDriver({ matchId: 'm4', viewerId: 'p1', ctx, now: () => T0 })
  const { messages } = collect(driver)
  driver.start()

  const opened = driver.snapshot()
  assert.ok(opened && opened.format === 'team-coop')
  assert.equal(opened.answerer_id, 'p1')
  assert.equal(opened.current_index, 0)
  assert.equal(opened.own.scope, 'team')
  assert.equal(opened.own.can_submit, true)

  const [first] = questions
  assert.ok(first)
  driver.submit(first.id, first.answer)

  // 推进题序：游标由状态机持有，页面只是投影
  driver.advance()
  const advanced = driver.snapshot()
  assert.ok(advanced && advanced.format === 'team-coop')
  assert.equal(advanced.current_index, 1)

  // 换主答：p1 变辅助 → 只读
  driver.setAnswerer('p2')
  const switched = driver.snapshot()
  assert.ok(switched && switched.format === 'team-coop')
  assert.equal(switched.answerer_id, 'p2')
  assert.equal(switched.own.can_submit, false)

  // 辅助位提交会被状态机拒绝，但不会崩
  const second = questions[1]!
  driver.submit(second.id, second.answer)
  const errors = messages.filter((m) => m.t === 'error')
  assert.equal(errors.length, 1)
  const error = errors[0]
  assert.ok(error && error.t === 'error')
  assert.equal(error.code, 'NOT_AUTHORIZED')

  driver.dispose()
})
