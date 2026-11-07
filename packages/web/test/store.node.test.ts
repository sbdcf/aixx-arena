/**
 * matchStore 集成测试（Node 里跑，不依赖 DOM）。
 *
 * 覆盖静态练习的完整链路：loadBank → 组卷 → LocalDriver → 提交 → 交卷 → 落盘 → 断点恢复。
 * 用内存版 localStorage + 假 fetch 顶掉浏览器环境。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Paper } from '@aixx/core'
import { makeQuestion } from '../../core/test/fixtures.ts'

const QUESTIONS = [
  makeQuestion({ id: 'q1', type: 'single', answer: ['A'] }),
  makeQuestion({ id: 'q2', type: 'multiple', answer: ['A', 'C'] }),
  makeQuestion({ id: 'q3', type: 'judge', answer: ['T'] }),
]

const PAPER: Paper = {
  schema_version: 1,
  id: 'paper-store-test',
  name: 'store 测试卷',
  format: 'solo',
  duration_sec: 600,
  draw: { single: 1, multiple: 1, judge: 1, min_available: 3, allow_partial: true, seed: 9 },
  submit_mode: 'stream',
  scoring: {
    mode: 'per_question',
    points: { single: 1, multiple: 2, judge: 1 },
    wrong_penalty: 0,
    unanswered: 0,
    total_normalize: 0,
  },
}

const BANK = {
  schema_version: 1,
  generated_at: '2026-11-06T00:00:00.000Z',
  question_count: QUESTIONS.length,
  questions: QUESTIONS,
  papers: { [PAPER.id]: PAPER },
}

class MemoryStorage {
  private map = new Map<string, string>()
  get length(): number {
    return this.map.size
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}

function installBrowserStubs(): MemoryStorage {
  const storage = new MemoryStorage()
  const globals = globalThis as unknown as Record<string, unknown>
  globals.localStorage = storage
  // Vue 的 runtime-dom 在模块初始化时会 doc.createElement('template')，给个最小可用的假 document 即可
  globals.document = {
    baseURI: 'http://localhost/',
    createElement: () => ({ style: {}, content: {}, setAttribute() {}, appendChild() {} }),
  }
  globals.fetch = async () => ({ ok: true, status: 200, json: async () => BANK })
  return storage
}

test('静态练习：开新局 → 答题 → 交卷 → 落盘 → 断点恢复', async () => {
  const storage = installBrowserStubs()
  const store = await import('../src/stores/matchStore.ts')
  const storageApi = await import('../src/storage/matchStorage.ts')

  // —— 开新局 ——
  const matchId = await store.createLocalMatch(PAPER.id)
  assert.match(matchId, /^local-/)
  const snapshot = store.match.snapshot
  assert.ok(snapshot)
  assert.equal(snapshot.total, 3)
  assert.equal(snapshot.own.can_submit, true)
  assert.equal(store.match.record?.questions.length, 3)

  // 组卷按种子固定：题目集合不该在刷新后改变
  const drawnIds = store.match.record!.questions.map((q) => q.id).sort()
  assert.deepEqual(drawnIds, ['q1', 'q2', 'q3'])

  // —— 答题：对 + 错 + 对 ——
  store.submitAnswer('q1', ['A'])
  store.submitAnswer('q2', ['A'])
  store.submitAnswer('q3', ['T'])
  assert.equal(Object.keys(store.match.snapshot!.own.answers).length, 3)
  // stream 模式：提交即锁定，ack 直接回对错
  assert.equal(store.match.acks.q1!.locked, true)
  assert.equal(store.match.acks.q1!.correct, true)
  assert.equal(store.match.acks.q2!.correct, false)

  // 中途落盘：未完成、未结算
  const midway = storageApi.loadMatch(matchId)
  assert.ok(midway)
  assert.equal(midway.finished, false)
  assert.equal(midway.summary, null)
  assert.ok(midway.state)

  // —— 交卷 ——
  store.submitAll()
  const summary = store.match.summary
  assert.ok(summary)
  assert.equal(summary.end_reason, 'self')
  assert.equal(summary.teams[0]!.score, 2) // 1 分 + 0 分 + 1 分
  assert.equal(summary.teams[0]!.max_score, 4)
  assert.equal(summary.teams[0]!.members[0]!.answered, 3)
  assert.equal(summary.teams[0]!.members[0]!.correct, 2)

  // 解析已进入 store，成绩页不必再依赖 driver
  assert.deepEqual(store.match.reveal.q2?.answer, ['A', 'C'])

  const finished = storageApi.loadMatch(matchId)
  assert.ok(finished)
  assert.equal(finished.finished, true)
  assert.ok(finished.summary)
  assert.equal(storageApi.listMatches().length, 1)

  // —— 断点恢复：新开一局只答一题，再从存储恢复 ——
  const secondId = await store.createLocalMatch(PAPER.id)
  store.submitAnswer('q1', ['A'])
  assert.equal(store.match.snapshot!.own.answers.q1?.length, 1)

  const resumed = store.resumeLocalMatch(secondId)
  assert.equal(resumed, true)
  assert.equal(store.match.snapshot!.own.answers.q1?.length, 1)
  assert.equal(Object.keys(store.match.snapshot!.own.answers).length, 1)

  // 清掉还在跑的定时器，免得测试进程被 600s 的 TICK 挂住
  store.activeDriver()?.dispose()
  assert.ok(storage.length >= 1)
})
