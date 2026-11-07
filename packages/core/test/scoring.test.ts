import assert from 'node:assert/strict'
import { test } from 'node:test'

import { judge, maxRawPoints, normalizeScore } from '../src/scoring.ts'
import type { ScoringConfig } from '../src/types.ts'
import { makeQuestion, makePool } from './fixtures.ts'

const perQuestion: ScoringConfig = {
  mode: 'per_question',
  points: { single: 1, multiple: 2, judge: 1 },
  wrong_penalty: 1,
  unanswered: 0,
  total_normalize: 0,
}

const minusWrong: ScoringConfig = { ...perQuestion, mode: 'correct_minus_wrong' }

test('单选答对得分', () => {
  const question = makeQuestion({ id: 'q1', type: 'single', answer: ['B'] })
  const out = judge({ question, choice: ['B'], scoring: perQuestion, answered: true })
  assert.deepEqual(out, { correct: true, points: 1, scored: true })
})

test('单选答错在 per_question 下是 0 分', () => {
  const question = makeQuestion({ id: 'q2', type: 'single', answer: ['B'] })
  const out = judge({ question, choice: ['C'], scoring: perQuestion, answered: true })
  assert.deepEqual(out, { correct: false, points: 0, scored: true })
})

test('±分制答错扣分，扣的是 wrong_penalty', () => {
  const question = makeQuestion({ id: 'q3', type: 'single', answer: ['B'] })
  const out = judge({ question, choice: ['C'], scoring: minusWrong, answered: true })
  assert.equal(out.points, -1)
  assert.equal(out.correct, false)
})

test('多选全对才得分，且不要求选择顺序', () => {
  const question = makeQuestion({ id: 'q4', type: 'multiple', answer: ['C', 'A'] })
  const out = judge({ question, choice: ['A', 'C'], scoring: perQuestion, answered: true })
  assert.deepEqual(out, { correct: true, points: 2, scored: true })
})

test('多选少选算答错（不是部分得分）', () => {
  const question = makeQuestion({ id: 'q5', type: 'multiple', answer: ['A', 'C'] })
  const out = judge({ question, choice: ['A'], scoring: perQuestion, answered: true })
  assert.equal(out.correct, false)
  assert.equal(out.points, 0)
})

test('多选多选（选了不在答案里的项）算答错', () => {
  const question = makeQuestion({ id: 'q6', type: 'multiple', answer: ['A', 'C'] })
  const out = judge({ question, choice: ['A', 'C', 'D'], scoring: perQuestion, answered: true })
  assert.equal(out.correct, false)
})

test('重复选择不影响判定', () => {
  const question = makeQuestion({ id: 'q7', type: 'multiple', answer: ['A', 'C'] })
  const out = judge({ question, choice: ['A', 'C', 'A'], scoring: perQuestion, answered: true })
  assert.equal(out.correct, true)
})

test('判断题答对', () => {
  const question = makeQuestion({ id: 'q8', type: 'judge', answer: ['T'] })
  const out = judge({ question, choice: ['T'], scoring: perQuestion, answered: true })
  assert.deepEqual(out, { correct: true, points: 1, scored: true })
})

test('未作答取 unanswered 配置，且算已判分', () => {
  const question = makeQuestion({ id: 'q9', type: 'single' })
  const out = judge({ question, choice: [], scoring: { ...perQuestion, unanswered: 0.5 }, answered: false })
  assert.equal(out.points, 0.5)
  assert.equal(out.scored, true)
})

test('没有 verified 答案的题不计分、不进分母', () => {
  const question = makeQuestion({ id: 'q10', type: 'single', answer_status: 'pending' })
  const out = judge({ question, choice: ['A'], scoring: perQuestion, answered: true })
  assert.deepEqual(out, { correct: false, points: 0, scored: false })
})

test('答案数组为空的题即使标了 verified 也不计分', () => {
  const question = makeQuestion({ id: 'q11', type: 'single', answer: [] })
  const out = judge({ question, choice: ['A'], scoring: perQuestion, answered: true })
  assert.equal(out.scored, false)
})

test('满分分母只累计可判分的题', () => {
  const pool = makePool({ single: 2, multiple: 1, judge: 1 })
  pool.push(makeQuestion({ id: 'pending-1', type: 'single', answer_status: 'pending' }))
  // 2*1 + 1*2 + 1*1 = 5
  assert.equal(maxRawPoints(pool, perQuestion), 5)
})

test('百分制折算四舍五入', () => {
  // 40/55 * 100 = 72.727 -> 73
  assert.equal(normalizeScore(40, 55, { ...perQuestion, total_normalize: 100 }), 73)
  // 77/100 * 100 = 77
  assert.equal(normalizeScore(77, 100, { ...perQuestion, total_normalize: 100 }), 77)
})

test('total_normalize 为 0 时不做折算', () => {
  assert.equal(normalizeScore(40, 55, perQuestion), 40)
})

test('负分也能折算且保持符号', () => {
  assert.equal(normalizeScore(-2, 60, { ...perQuestion, total_normalize: 100 }), -3)
})
