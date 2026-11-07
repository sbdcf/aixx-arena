/**
 * 组卷（docs/design.md §5.3）。
 *
 * 三个不变量，改这个文件时先确认它们没被破坏：
 * 1. 只从 `answer_status === 'verified'` 且有答案的题里抽 —— 否则「答了也不判分」的题会污染满分分母。
 * 2. 同 seed 同卷 —— 刷新、重连、复盘都要能重现同一份题。
 * 3. 接力三段的题互不重复，靠 `used_ids` 串行传差集保证，不靠换种子碰运气。
 */

import type { DrawSpec, Paper, Question, QuestionType } from './types.ts'
import { isScorable } from './scoring.ts'
import { mulberry32, shuffle } from './rng.ts'

export type DrawErrorCode = 'INSUFFICIENT_POOL' | 'BELOW_MIN_AVAILABLE'

export class DrawError extends Error {
  code: DrawErrorCode

  constructor(code: DrawErrorCode, message: string) {
    super(message)
    this.name = 'DrawError'
    this.code = code
  }
}

export interface DrawResult {
  questions: Question[]
  degraded: boolean
  available_count: number
  requested_count: number
  /** "本卷 40/55 题有答案，满分按 40 题折算" */
  notice?: string
}

export interface DrawRelayResult {
  legs: Question[][]
  degraded: boolean
  notices: string[]
}

const TYPE_ORDER: QuestionType[] = ['single', 'multiple', 'judge']

function requestedByType(spec: DrawSpec): Record<QuestionType, number> {
  return { single: spec.single ?? 0, multiple: spec.multiple ?? 0, judge: spec.judge ?? 0 }
}

function sumByType(counts: Record<QuestionType, number>): number {
  return counts.single + counts.multiple + counts.judge
}

/** 单题是否满足组卷条件（题型以外的过滤条件都在这里）。 */
export function matchesDrawSpec(question: Question, spec: DrawSpec): boolean {
  if (!isScorable(question)) return false
  if (spec.taxonomy && spec.taxonomy.length > 0) {
    const tags = question.taxonomy ?? []
    if (!spec.taxonomy.some((tag) => tags.includes(tag))) return false
  }
  if (spec.difficulty && spec.difficulty.length > 0) {
    if (question.difficulty === undefined) return false
    if (!spec.difficulty.includes(question.difficulty)) return false
  }
  return true
}

/** 可抽的题池：过滤 + 去重 + 按 id 排序（排序是为了让「同种子同卷」不受题库文件顺序影响）。 */
export function eligiblePool(pool: readonly Question[], spec: DrawSpec, usedIds?: Iterable<string>): Question[] {
  const used = new Set(usedIds ?? [])
  return pool
    .filter((question) => !used.has(question.id) && matchesDrawSpec(question, spec))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 抽一卷。
 * @param pool 全量题库
 * @param spec 组卷参数
 * @param seed 全局种子；spec.seed 优先
 * @param usedIds 已用过的题 id（接力分棒时逐棒累加）
 */
export function draw(pool: readonly Question[], spec: DrawSpec, seed: number, usedIds?: Iterable<string>): DrawResult {
  const requested = requestedByType(spec)
  const requestedTotal = sumByType(requested)
  const eligible = eligiblePool(pool, spec, usedIds)

  const minAvailable = spec.min_available ?? 0
  if (eligible.length < minAvailable) {
    throw new DrawError(
      'BELOW_MIN_AVAILABLE',
      `可用题数 ${eligible.length} 少于下限 ${minAvailable}，拒绝组卷`,
    )
  }

  if (requestedTotal === 0) {
    return { questions: [], degraded: false, available_count: eligible.length, requested_count: 0 }
  }

  const buckets: Record<QuestionType, Question[]> = { single: [], multiple: [], judge: [] }
  for (const question of eligible) buckets[question.type].push(question)

  const totalTarget = Math.min(requestedTotal, eligible.length)
  if (totalTarget < requestedTotal && !spec.allow_partial) {
    throw new DrawError(
      'INSUFFICIENT_POOL',
      `需要 ${requestedTotal} 题，仅有 ${eligible.length} 题可用，且未允许降级组卷`,
    )
  }

  const targets = allocateTargets(requested, requestedTotal, totalTarget, buckets)
  const rand = mulberry32(spec.seed ?? seed)
  const questions: Question[] = []
  for (const type of TYPE_ORDER) {
    const picked = shuffle(buckets[type], rand).slice(0, targets[type])
    questions.push(...picked)
  }

  const degraded = questions.length < requestedTotal
  const result: DrawResult = {
    questions,
    degraded,
    available_count: eligible.length,
    requested_count: requestedTotal,
  }
  if (degraded) {
    result.notice = `本卷 ${questions.length}/${requestedTotal} 题有答案，满分按 ${questions.length} 题折算`
  }
  return result
}

/**
 * 按题型分配实际抽题数。
 * 先按比例 floor，再受各题型可用量约束，最后把剩余名额按 单选→多选→判断 顺序补满（§5.3 的「余数补到单选」）。
 */
function allocateTargets(
  requested: Record<QuestionType, number>,
  requestedTotal: number,
  totalTarget: number,
  buckets: Record<QuestionType, Question[]>,
): Record<QuestionType, number> {
  const targets: Record<QuestionType, number> = { single: 0, multiple: 0, judge: 0 }
  const ratio = totalTarget / requestedTotal

  for (const type of TYPE_ORDER) {
    targets[type] = Math.min(Math.floor(requested[type] * ratio), buckets[type].length)
  }

  let remaining = totalTarget - sumByType(targets)
  let guard = 0
  while (remaining > 0 && guard < 10_000) {
    let progressed = false
    for (const type of TYPE_ORDER) {
      if (remaining === 0) break
      if (targets[type] < buckets[type].length) {
        targets[type] += 1
        remaining -= 1
        progressed = true
      }
    }
    guard += 1
    if (!progressed) break
  }
  return targets
}

/**
 * 接力分棒：三段互不重复（§5.3）。
 * 每棒的种子 = (该棒 seed ?? 第一棒 seed ?? seedBase) + i * 1000，且把前几棒的题传给 usedIds。
 */
export function drawRelay(pool: readonly Question[], paper: Paper, seedBase = 2026): DrawRelayResult {
  const legs = paper.legs
  if (!legs || legs.length !== 3) {
    throw new DrawError('INSUFFICIENT_POOL', '接力卷必须在 paper.legs 里给出三段组卷参数')
  }

  const used = new Set<string>()
  const drawn: Question[][] = []
  const notices: string[] = []
  let degraded = false

  for (let i = 0; i < 3; i++) {
    const spec = legs[i]
    const seed = (spec.seed ?? legs[0].seed ?? seedBase) + i * 1000
    const result = draw(pool, spec, seed, used)
    if (result.questions.length === 0) {
      throw new DrawError('INSUFFICIENT_POOL', `第 ${i + 1} 棒抽到 0 题，接力赛无法开局`)
    }
    if (result.degraded) {
      degraded = true
      notices.push(`第 ${i + 1} 棒：${result.notice ?? '题量不足，已降级'}`)
    }
    for (const question of result.questions) used.add(question.id)
    drawn.push(result.questions)
  }

  return { legs: drawn, degraded, notices }
}

/** 按试卷配置组卷：relay 走分棒，其它走 draw。 */
export function drawPaper(pool: readonly Question[], paper: Paper, seedBase = 2026) {
  if (paper.format === 'relay') return drawRelay(pool, paper, seedBase)
  if (!paper.draw) throw new DrawError('INSUFFICIENT_POOL', `试卷 ${paper.id} 缺少 draw 配置`)
  return draw(pool, paper.draw, paper.draw.seed ?? seedBase)
}
