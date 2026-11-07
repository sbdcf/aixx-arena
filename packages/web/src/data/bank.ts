import type { DrawSpec, Paper, Question } from '@aixx/core'

/**
 * 静态模式的数据来源：scripts/sync-data.mjs 把 data/questions/*.json 与 data/papers/*.json
 * 合成一个 bank.json。整包一次拉完（约 150KB），比逐题 87 个请求划算得多，
 * 而且 GitHub Pages 也不给目录列表。
 */
export interface Bank {
  schema_version: number
  generated_at: string
  question_count: number
  questions: Question[]
  papers: Record<string, Paper>
}

let cache: Promise<Bank> | null = null

export function loadBank(): Promise<Bank> {
  if (cache) return cache
  // 用 document.baseURI 解析，GitHub Pages 的子路径部署（base './'）也不会拼错
  const url = new URL('data/bank.json', document.baseURI).href
  cache = fetch(url, { cache: 'no-cache' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`题库加载失败：HTTP ${response.status}`)
      return (await response.json()) as Bank
    })
    .catch((error: unknown) => {
      cache = null
      throw error instanceof Error ? error : new Error(String(error))
    })
  return cache
}

/** 首页与设置页要展示的题库概况，不阻塞渲染 */
export function bankSummary(bank: Bank) {
  const byType = { single: 0, multiple: 0, judge: 0 } as Record<string, number>
  const topics = new Set<string>()
  for (const question of bank.questions) {
    byType[question.type] = (byType[question.type] ?? 0) + 1
    for (const topic of question.taxonomy ?? []) topics.add(topic)
  }
  return {
    total: bank.questions.length,
    byType,
    topicCount: topics.size,
    paperCount: Object.keys(bank.papers).length,
    generatedAt: bank.generated_at,
  }
}

function countOf(spec: DrawSpec | null | undefined): number {
  if (!spec) return 0
  return (spec.single ?? 0) + (spec.multiple ?? 0) + (spec.judge ?? 0)
}

/** 本卷实际题量（接力卷的题量不在顶层 draw 里） */
export function paperQuestionCount(paper: Paper): number {
  if (paper.legs) return paper.legs.reduce((sum, leg) => sum + countOf(leg), 0)
  return countOf(paper.draw)
}

/**
 * 卷面满分。有折算目标就以折算值为准（成绩页分母一致）；
 * 抢答卷没有全局时长、每题按 buzz.correct_points 计，满分 = 题数 × 答对分（只算全对）；
 * 其余按组卷配置的题型构成乘单题分值估算 —— 首页只用来展示「满分 XX」，不做判分。
 */
export function paperMaxScore(paper: Paper): number {
  const scoring = paper.scoring
  if (scoring.total_normalize > 0) return scoring.total_normalize
  if (paper.buzz) return paperQuestionCount(paper) * paper.buzz.correct_points
  const specs: (DrawSpec | null | undefined)[] = paper.legs ? [...paper.legs] : [paper.draw]
  let total = 0
  for (const spec of specs) {
    if (!spec) continue
    total += (spec.single ?? 0) * scoring.points.single
    total += (spec.multiple ?? 0) * scoring.points.multiple
    total += (spec.judge ?? 0) * scoring.points.judge
  }
  return total
}
