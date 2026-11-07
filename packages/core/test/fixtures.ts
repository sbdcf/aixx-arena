import type { Question, QuestionType } from '../src/types.ts'

function defaultOptions(type: QuestionType): { key: string; text: string }[] {
  return type === 'judge'
    ? [
        { key: 'T', text: '正确' },
        { key: 'F', text: '错误' },
      ]
    : [
        { key: 'A', text: '选项 A' },
        { key: 'B', text: '选项 B' },
        { key: 'C', text: '选项 C' },
        { key: 'D', text: '选项 D' },
      ]
}

function defaultAnswer(type: QuestionType): string[] {
  if (type === 'judge') return ['T']
  if (type === 'multiple') return ['A', 'C']
  return ['A']
}

export function makeQuestion(overrides: Partial<Question> & { id: string; type: QuestionType }): Question {
  const base: Question = {
    schema_version: 1,
    id: overrides.id,
    type: overrides.type,
    stem: `题干 ${overrides.id}`,
    options: defaultOptions(overrides.type),
    answer: defaultAnswer(overrides.type),
    answer_status: 'verified',
  }
  return { ...base, ...overrides }
}

/** 造一批单/多/判混合题，用于组卷测试。 */
export function makePool(counts: { single: number; multiple: number; judge: number }): Question[] {
  const pool: Question[] = []
  for (let i = 0; i < counts.single; i++) {
    pool.push(makeQuestion({ id: `s-${String(i).padStart(2, '0')}`, type: 'single' }))
  }
  for (let i = 0; i < counts.multiple; i++) {
    pool.push(makeQuestion({ id: `m-${String(i).padStart(2, '0')}`, type: 'multiple' }))
  }
  for (let i = 0; i < counts.judge; i++) {
    pool.push(makeQuestion({ id: `j-${String(i).padStart(2, '0')}`, type: 'judge' }))
  }
  return pool
}
