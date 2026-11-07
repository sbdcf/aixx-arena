import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DrawError, draw, drawRelay } from '../src/draw.ts'
import type { Paper } from '../src/types.ts'
import { makePool, makeQuestion } from './fixtures.ts'

const baseSpec = { min_available: 0, allow_partial: false }

test('同种子同卷', () => {
  const pool = makePool({ single: 20, multiple: 10, judge: 10 })
  const spec = { ...baseSpec, single: 5, multiple: 3, judge: 2 }
  const a = draw(pool, spec, 42)
  const b = draw(pool, spec, 42)
  assert.deepEqual(
    a.questions.map((q) => q.id),
    b.questions.map((q) => q.id),
  )
})

test('不同种子出不同的卷', () => {
  const pool = makePool({ single: 20, multiple: 10, judge: 10 })
  const spec = { ...baseSpec, single: 5, multiple: 3, judge: 2 }
  const a = draw(pool, spec, 1).questions.map((q) => q.id).join(',')
  const b = draw(pool, spec, 2).questions.map((q) => q.id).join(',')
  assert.notEqual(a, b)
})

test('题池顺序不影响结果（内部按 id 排序）', () => {
  const ordered = makePool({ single: 10, multiple: 5, judge: 5 })
  const shuffled = ordered.slice().reverse()
  const spec = { ...baseSpec, single: 3, multiple: 2, judge: 1 }
  assert.deepEqual(
    draw(ordered, spec, 7).questions.map((q) => q.id),
    draw(shuffled, spec, 7).questions.map((q) => q.id),
  )
})

test('只从 verified 且有答案的题里抽', () => {
  const pool = makePool({ single: 2, multiple: 0, judge: 0 })
  pool.push(makeQuestion({ id: 's-pending', type: 'single', answer_status: 'pending' }))
  pool.push(makeQuestion({ id: 's-empty', type: 'single', answer: [] }))
  const out = draw(pool, { ...baseSpec, single: 2 }, 1)
  assert.deepEqual(
    out.questions.map((q) => q.id).sort(),
    ['s-00', 's-01'],
  )
})

test('used_ids 里的题不会被再次抽到', () => {
  const pool = makePool({ single: 5, multiple: 0, judge: 0 })
  const out = draw(pool, { ...baseSpec, single: 3 }, 1, ['s-00', 's-01'])
  assert.equal(out.questions.some((q) => q.id === 's-00' || q.id === 's-01'), false)
})

test('题量不足且不允许降级时抛 INSUFFICIENT_POOL', () => {
  const pool = makePool({ single: 3, multiple: 0, judge: 0 })
  assert.throws(
    () => draw(pool, { ...baseSpec, single: 5 }, 1),
    (err: unknown) => err instanceof DrawError && err.code === 'INSUFFICIENT_POOL',
  )
})

test('允许降级时按比例缩卷并给出提示', () => {
  const pool = makePool({ single: 10, multiple: 10, judge: 10 })
  const out = draw(pool, { min_available: 0, allow_partial: true, single: 20, multiple: 20, judge: 20 }, 1)
  assert.equal(out.degraded, true)
  assert.equal(out.questions.length, 30)
  assert.equal(out.requested_count, 60)
  assert.ok(out.notice && out.notice.includes('30/60'))
})

test('可用题数低于 min_available 时拒绝组卷', () => {
  const pool = makePool({ single: 2, multiple: 0, judge: 0 })
  assert.throws(
    () => draw(pool, { ...baseSpec, single: 2, min_available: 5 }, 1),
    (err: unknown) => err instanceof DrawError && err.code === 'BELOW_MIN_AVAILABLE',
  )
})

test('题量为 0 时返回空卷且不算降级', () => {
  const pool = makePool({ single: 5, multiple: 0, judge: 0 })
  const out = draw(pool, { ...baseSpec }, 1)
  assert.equal(out.questions.length, 0)
  assert.equal(out.degraded, false)
})

test('taxonomy 过滤生效', () => {
  const pool = [
    makeQuestion({ id: 'a', type: 'single', taxonomy: ['t-db-cnki'] }),
    makeQuestion({ id: 'b', type: 'single', taxonomy: ['t-ai-tools'] }),
    makeQuestion({ id: 'c', type: 'single', taxonomy: ['t-db-cnki', 't-ai-tools'] }),
  ]
  const out = draw(pool, { ...baseSpec, single: 2, taxonomy: ['t-db-cnki'] }, 1)
  assert.deepEqual(out.questions.map((q) => q.id).sort(), ['a', 'c'])
})

test('难度过滤生效：缺 difficulty 的题被排除', () => {
  const pool = [
    makeQuestion({ id: 'd1', type: 'single', difficulty: 1 }),
    makeQuestion({ id: 'd3', type: 'single', difficulty: 3 }),
    makeQuestion({ id: 'none', type: 'single' }),
  ]
  const out = draw(pool, { ...baseSpec, single: 2, difficulty: [1, 3] }, 1)
  assert.deepEqual(out.questions.map((q) => q.id).sort(), ['d1', 'd3'])
})

test('接力三段的题互不重复', () => {
  const pool = makePool({ single: 40, multiple: 0, judge: 0 })
  const paper: Paper = {
    schema_version: 1,
    id: 'paper-relay',
    name: '接力',
    format: 'relay',
    duration_sec: 900,
    draw: null,
    legs: [
      { ...baseSpec, single: 5 },
      { ...baseSpec, single: 5 },
      { ...baseSpec, single: 5 },
    ],
    submit_mode: 'stream',
    scoring: { mode: 'per_question', points: { single: 1, multiple: 2, judge: 1 }, wrong_penalty: 0, unanswered: 0, total_normalize: 0 },
  }
  const out = drawRelay(pool, paper)
  const ids = out.legs.flat().map((q) => q.id)
  assert.equal(ids.length, 15)
  assert.equal(new Set(ids).size, 15)
})

test('接力某一棒抽不到题时直接报错，而不是开一局空棒', () => {
  const pool = makePool({ single: 5, multiple: 0, judge: 0 })
  const paper: Paper = {
    schema_version: 1,
    id: 'paper-relay',
    name: '接力',
    format: 'relay',
    duration_sec: 900,
    draw: null,
    legs: [
      { ...baseSpec, single: 5 },
      { ...baseSpec, single: 5 },
      { ...baseSpec, single: 5 },
    ],
    submit_mode: 'stream',
    scoring: { mode: 'per_question', points: { single: 1, multiple: 2, judge: 1 }, wrong_penalty: 0, unanswered: 0, total_normalize: 0 },
  }
  assert.throws(() => drawRelay(pool, paper), DrawError)
})
