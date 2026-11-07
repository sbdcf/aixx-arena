import assert from 'node:assert/strict'
import { test } from 'node:test'

import { rankBuzz, type BuzzRankInput, type BuzzSubmission } from '../src/buzz.ts'

const T0 = 1_700_000_000_000

function submit(team_id: string, offsetMs: number, correct = true): BuzzSubmission {
  return { team_id, at: T0 + offsetMs, correct }
}

function rank(overrides: Partial<BuzzRankInput> = {}): BuzzRankInput {
  return {
    submissions: [],
    n_at_open: 4,
    qualify_ratio: 0.5,
    qualify_fill: 'strict',
    tie_window_ms: 5,
    correct_points: 4,
    wrong_points: -1,
    ...overrides,
  }
}

test('排序键是 (at, team_id)：同一毫秒不依赖 V8 排序的稳定性', () => {
  const result = rankBuzz(
    rank({ submissions: [submit('t3', 100), submit('t1', 50), submit('t2', 50)] }),
  )
  assert.deepEqual(
    result.ranking.map((entry) => entry.team_id),
    ['t1', 't2', 't3'],
  )
  assert.deepEqual(
    result.ranking.map((entry) => entry.rank),
    [1, 1, 3],
    't1/t2 同毫秒且差 0 ≤ 5ms，同簇同名次；t3 另起一簇',
  )
})

test('quota 用 Math.ceil：5 队 × 0.5 = 3 个名额', () => {
  const result = rankBuzz(rank({ n_at_open: 5, submissions: [] }))
  assert.equal(result.quota, 3)
})

test('5ms 内算并列，超过 5ms 另起一簇', () => {
  const result = rankBuzz(
    rank({
      submissions: [submit('t1', 100), submit('t2', 105), submit('t3', 111)],
    }),
  )
  assert.deepEqual(
    result.ranking.map((entry) => entry.rank),
    [1, 1, 3],
  )
  assert.deepEqual(
    result.ranking.map((entry) => entry.tied),
    [true, true, false],
  )
})

test('并列簇整簇计入名额，即使簇跨过名额边界', () => {
  // 4 队 × 0.5 = 2 个名额；三队落在 5ms 内 → 第一簇有 3 队，整簇都算入围
  const result = rankBuzz(
    rank({
      n_at_open: 4,
      submissions: [submit('t1', 100), submit('t2', 102), submit('t3', 104), submit('t4', 200)],
    }),
  )
  assert.equal(result.quota, 2)
  assert.equal(result.boundary_tie_expanded, true)
  assert.deepEqual(
    result.ranking.map((entry) => entry.in_quota),
    [true, true, true, false],
  )
  assert.deepEqual(
    result.ranking.map((entry) => entry.awarded),
    [4, 4, 4, 0],
  )
})

test('strict：名额内答对加分、答错扣分；名额外答对也不加分', () => {
  const result = rankBuzz(
    rank({
      n_at_open: 2,
      submissions: [submit('t1', 100, false), submit('t2', 150, true), submit('t3', 200, true)],
    }),
  )
  assert.equal(result.quota, 1)
  assert.deepEqual(
    result.ranking.map((entry) => `${entry.team_id}:${entry.in_quota}:${entry.awarded}`),
    ['t1:true:-1', 't2:false:0', 't3:false:0'],
  )
})

test('fill：名额内答错留下的空位顺延给名额外答对的队', () => {
  const result = rankBuzz(
    rank({
      n_at_open: 4,
      qualify_fill: 'fill',
      submissions: [submit('t1', 100, false), submit('t2', 150, true), submit('t3', 200, true)],
    }),
  )
  assert.equal(result.quota, 2)
  // t1 入围但答错 → 空出一个名额，顺延给名额外第一个答对的 t3（t2 本来就在名额内）
  assert.deepEqual(
    result.ranking.map((entry) => `${entry.team_id}:${entry.in_quota}:${entry.awarded}`),
    ['t1:true:-1', 't2:true:4', 't3:false:4'],
  )
})

test('fill 也只补答对的队：名额外答错的不加分', () => {
  const result = rankBuzz(
    rank({
      n_at_open: 2,
      qualify_fill: 'fill',
      submissions: [submit('t1', 100, false), submit('t2', 150, false), submit('t3', 200, true)],
    }),
  )
  // quota = 1；t1 入围错，空位顺延给 t3（名额外第一个答对的）
  assert.deepEqual(
    result.ranking.map((entry) => `${entry.team_id}:${entry.awarded}`),
    ['t1:-1', 't2:0', 't3:4'],
  )
})

test('名额未用满时没人加分，空场也不报错', () => {
  const result = rankBuzz(rank({ n_at_open: 4, submissions: [] }))
  assert.equal(result.quota, 2)
  assert.deepEqual(result.ranking, [])
  assert.equal(result.boundary_tie_expanded, false)
})

test('ratio = 1 时全队入围；wrong_points = 0 时答错不扣分', () => {
  const result = rankBuzz(
    rank({
      n_at_open: 3,
      qualify_ratio: 1,
      wrong_points: 0,
      submissions: [submit('t1', 100, false), submit('t2', 200, true), submit('t3', 300, false)],
    }),
  )
  assert.equal(result.quota, 3)
  assert.deepEqual(
    result.ranking.map((entry) => entry.awarded),
    [0, 4, 0],
  )
})
