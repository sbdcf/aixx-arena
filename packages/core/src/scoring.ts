/**
 * 判分引擎（docs/design.md §5.2）。
 *
 * 这个文件是 AC-11 的契约点：前端 `LocalDriver` 与后端 `server` 必须 import 同一份实现，
 * 不允许任何一方另写一套「差不多的」判分，否则静态练习与联机成绩会出现口径差。
 */

import type { Question, QuestionType, ScoringConfig } from './types.ts'

export interface JudgeInput {
  question: Question
  /** 选手选择的 option key 列表；未答传空数组 */
  choice: string[]
  scoring: ScoringConfig
  /** 是否作答过（区分「没点过」与「点了但全取消」） */
  answered: boolean
}

export interface JudgeOutput {
  correct: boolean
  /** 可为负（答错扣分） */
  points: number
  /** false = 该题无已验证答案，不计分，也不进满分分母 */
  scored: boolean
}

/** 去重、去空、排序 —— 多选题比较前的固定动作（§15 第 4 条）。 */
export function normalizeChoice(choice: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const key of choice) {
    if (typeof key === 'string' && key.length > 0) seen.add(key)
  }
  return [...seen].sort()
}

/** 该题是否有可判分的答案。 */
export function isScorable(question: Question): boolean {
  return question.answer_status === 'verified' && Array.isArray(question.answer) && question.answer.length > 0
}

/** 选项集合是否与答案集合一致（单选/判断退化为单元素比较）。 */
export function isChoiceCorrect(question: Question, choice: readonly string[]): boolean {
  if (!isScorable(question)) return false
  const mine = normalizeChoice(choice)
  const answer = normalizeChoice(question.answer)
  if (question.type === 'multiple') return mine.join('|') === answer.join('|')
  return mine.length === 1 && answer.length === 1 && mine[0] === answer[0]
}

export function judge(input: JudgeInput): JudgeOutput {
  const { question, scoring } = input

  // 1) 无答案的题：不计分、不进分母，让「40/55 题有答案」的卷子依然能给满分
  if (!isScorable(question)) {
    return { correct: false, points: 0, scored: false }
  }

  // 2) 没答：按配置的不答分（默认 0），算作已判分的题
  if (!input.answered) {
    return { correct: false, points: scoring.unanswered ?? 0, scored: true }
  }

  // 3) 答对
  if (isChoiceCorrect(question, input.choice)) {
    const points = scoring.points[question.type] ?? 0
    return { correct: true, points, scored: true }
  }

  // 4) 答错：±分制才扣分，其它模式 0 分（多选题少选也算答错）
  //    注意不能写 -penalty：penalty 为 0 时会得到 -0，而 -0 在序列化后仍是 0、
  //    在 deepEqual 里却不等于 0，是排查起来很费时间的假失败。
  const penalty = scoring.mode === 'correct_minus_wrong' ? (scoring.wrong_penalty ?? 0) : 0
  return { correct: false, points: penalty > 0 ? -penalty : 0, scored: true }
}

/** 单题的满分值（用于拼满分分母）。 */
export function questionMaxPoints(question: Question, scoring: ScoringConfig): number {
  if (!isScorable(question)) return 0
  return scoring.points[question.type] ?? 0
}

/** 整卷的原始满分：只累计可判分的题。 */
export function maxRawPoints(questions: readonly Question[], scoring: ScoringConfig): number {
  let total = 0
  for (const question of questions) total += questionMaxPoints(question, scoring)
  return total
}

/**
 * 百分制折算。total_normalize 为 0 时原样返回。
 * 四舍五入到整数分：`round(raw / max_raw * total_normalize)`（§5.2 最后一条）。
 */
export function normalizeScore(raw: number, maxRaw: number, scoring: ScoringConfig): number {
  const target = scoring.total_normalize ?? 0
  if (target === 0 || maxRaw <= 0) return raw
  return Math.round((raw / maxRaw) * target)
}

/** 题型 → 分值，方便在 UI 上显示「单选 1 分 / 多选 2 分」。 */
export function pointsOf(type: QuestionType, scoring: ScoringConfig): number {
  return scoring.points[type] ?? 0
}
