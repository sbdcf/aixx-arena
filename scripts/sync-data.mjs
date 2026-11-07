/**
 * 把 data/questions/*.json 与 data/papers/*.json 打包成前端可直接 fetch 的单文件
 * packages/web/public/data/bank.json。
 *
 * 为什么打包成单文件：GitHub Pages 上没有目录列表，逐题 fetch 会产生 87 个请求；
 * 而一场练习最多用到 55 题，一次拉全量（约 150KB）明显更划算，也让离线缓存简单。
 *
 * 用法：& '<便携 node>' scripts/sync-data.mjs
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const questionsDir = join(root, 'data', 'questions')
const papersDir = join(root, 'data', 'papers')
const outDir = join(root, 'packages', 'web', 'public', 'data')
const outFile = join(outDir, 'bank.json')

async function readJsonFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).sort()
  const items = []
  for (const name of files) {
    const text = await readFile(join(dir, name), 'utf8')
    try {
      items.push(JSON.parse(text))
    } catch (error) {
      throw new Error(`${dir}/${name} 不是合法 JSON: ${error.message}`)
    }
  }
  return items
}

const questionList = await readJsonFiles(questionsDir)
const paperList = await readJsonFiles(papersDir)

// 只把可判分的题发给前端：不可判分的题在前端只会显示成「答了也不得分」，是纯粹的困惑源。
const questions = questionList.filter(
  (q) => q && q.answer_status === 'verified' && Array.isArray(q.answer) && q.answer.length > 0,
)
const dropped = questionList.length - questions.length

const papers = {}
for (const paper of paperList) {
  papers[paper.id] = paper
}

const bank = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  question_count: questions.length,
  questions,
  papers,
}

await mkdir(outDir, { recursive: true })
await writeFile(outFile, JSON.stringify(bank, null, 2), 'utf8')

console.log(`题库: ${questionList.length} 道，可判分 ${questions.length} 道（丢弃 ${dropped} 道）`)
console.log(`试卷: ${Object.keys(papers).join(', ')}`)
console.log(`写出: ${outFile}`)
