/**
 * 题库 / 试卷加载（`--data-root`）。
 *
 * 目录约定与 `scripts/sync-data.mjs`、`scripts/verify-data.mjs` 一致：
 *   <data-root>/questions/*.json  一题一文件
 *   <data-root>/papers/*.json     一卷一文件
 *
 * 只读、启动时一次性读进内存：单机 87 题 / 5 卷，热更新没有意义，反而会让
 * 「同 seed 同卷」的可重现性依赖重启时机。
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Paper, Question } from './core.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 仓库根（aixx-arena），从 packages/server/src 往上三层。 */
export const REPO_ROOT = resolve(HERE, '../../..')

/** 默认题库目录：aixx-arena/data。 */
export const DEFAULT_DATA_ROOT = join(REPO_ROOT, 'data')

/** 默认静态站点目录：aixx-arena/packages/web/dist。 */
export const DEFAULT_WEB_ROOT = join(REPO_ROOT, 'packages', 'web', 'dist')

export interface Bank {
  data_root: string
  questions: Question[]
  papers: Map<string, Paper>
  loaded_at: number
}

async function readJsonDir<T>(dir: string): Promise<T[]> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new Error(code === 'ENOENT' ? `数据目录不存在: ${dir}` : `无法读取数据目录 ${dir}: ${String(error)}`)
  }

  const items: T[] = []
  for (const name of names) {
    const file = join(dir, name)
    try {
      items.push(JSON.parse(await readFile(file, 'utf8')) as T)
    } catch (error) {
      throw new Error(`数据文件不是合法 JSON: ${file} (${String(error)})`)
    }
  }
  return items
}

export async function loadBank(dataRoot: string = DEFAULT_DATA_ROOT): Promise<Bank> {
  const root = resolve(dataRoot)
  const questions = await readJsonDir<Question>(join(root, 'questions'))
  const paperList = await readJsonDir<Paper>(join(root, 'papers'))

  if (questions.length === 0) throw new Error(`题库为空: ${join(root, 'questions')}`)
  if (paperList.length === 0) throw new Error(`试卷为空: ${join(root, 'papers')}`)

  const papers = new Map<string, Paper>()
  for (const paper of paperList) {
    if (!paper || typeof paper.id !== 'string' || !paper.id) {
      throw new Error(`试卷缺少 id: ${join(root, 'papers')}`)
    }
    if (papers.has(paper.id)) throw new Error(`试卷 id 重复: ${paper.id}`)
    papers.set(paper.id, paper)
  }

  return { data_root: root, questions, papers, loaded_at: Date.now() }
}

/** 只保留可判分题的题池（组卷内部还会再过滤一次，这里提前收缩）。 */
export function scorableQuestions(bank: Bank): Question[] {
  return bank.questions.filter((question) => question.answer_status === 'verified' && (question.answer?.length ?? 0) > 0)
}
