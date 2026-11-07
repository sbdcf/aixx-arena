#!/usr/bin/env node
/**
 * import-questions.mjs
 *
 * 把「已确认题目」目录里通过校验的 *.json 原样导入 aixx-arena/data/questions/，
 * 并生成 _import-report.md。
 *
 * 用法（在仓库根目录）：
 *   node scripts/import-questions.mjs
 *   （可选第一个参数指定源目录，默认「仓库上一级/已确认题目」）
 *
 * 设计要点：
 *   - 幂等：重复执行只会覆盖同名文件与报告，不会产生重复文件。
 *   - 不修改题目内容：校验通过的题目用 JSON.parse → JSON.stringify(obj, null, 2) 原样写出，
 *     字段顺序保持源文件顺序，仅统一为 2 空格缩进 + 结尾换行。
 *   - 校验失败的文件不写入目标目录，只在报告里列明细；绝不擅自修改题目字段。
 *   - 退出码：全部通过 0；存在失败 1（仍会写报告）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ARENA_ROOT = resolve(__dirname, '..')
const DEFAULT_SRC_DIR = resolve(ARENA_ROOT, '..', '已确认题目')
const TAXONOMY_PATH = resolve(ARENA_ROOT, '..', 'aixx-guide', 'data', 'taxonomy.json')
const OUT_DIR = join(ARENA_ROOT, 'data', 'questions')
const REPORT_PATH = join(OUT_DIR, '_import-report.md')

const SRC_DIR = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_SRC_DIR

const QUESTION_TYPES = ['single', 'multiple', 'judge']
const ANSWER_STATUS = ['pending', 'verified', 'disputed', 'expired']

/** 读取分类法 topics 的 id 集合 */
function loadTopicIds() {
  if (!existsSync(TAXONOMY_PATH)) {
    throw new Error(`找不到分类法文件：${TAXONOMY_PATH}`)
  }
  const tax = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8'))
  const ids = new Set((tax.topics ?? []).map((t) => t.id))
  if (ids.size === 0) throw new Error(`分类法 topics 为空：${TAXONOMY_PATH}`)
  return ids
}

/**
 * 校验单道题。
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateQuestion(obj, fileName, topicIds) {
  const errors = []
  const warnings = []
  const fileId = fileName.replace(/\.json$/i, '')

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push('顶层不是 JSON 对象')
    return { errors, warnings }
  }

  // schema_version
  if (obj.schema_version !== 1) {
    errors.push(`schema_version 必须为 1，实际为 ${JSON.stringify(obj.schema_version)}`)
  }

  // id
  if (typeof obj.id !== 'string' || obj.id.trim() === '') {
    errors.push('id 缺失或不是非空字符串')
  } else if (obj.id !== fileId) {
    errors.push(`id "${obj.id}" 与文件名 "${fileId}" 不一致`)
  }

  // type
  const isTypeValid = QUESTION_TYPES.includes(obj.type)
  if (!isTypeValid) {
    errors.push(`type 必须属于 {single, multiple, judge}，实际为 ${JSON.stringify(obj.type)}`)
  }

  // stem
  if (typeof obj.stem !== 'string' || obj.stem.trim() === '') {
    errors.push('stem 缺失或为空')
  }

  // options
  const optionKeys = new Set()
  const options = obj.options
  if (!Array.isArray(options)) {
    errors.push('options 缺失或不是数组')
  } else {
    if (options.length < 2) errors.push(`options 至少 2 项，实际 ${options.length} 项`)
    const seen = new Set()
    options.forEach((opt, i) => {
      const where = `options[${i}]`
      if (opt === null || typeof opt !== 'object' || Array.isArray(opt)) {
        errors.push(`${where} 不是对象`)
        return
      }
      if (typeof opt.key !== 'string' || opt.key.trim() === '') {
        errors.push(`${where}.key 缺失或为空`)
        return
      }
      if (seen.has(opt.key)) {
        errors.push(`options 的 key 重复："${opt.key}"`)
      }
      seen.add(opt.key)
      optionKeys.add(opt.key)
      if (typeof opt.text !== 'string' || opt.text.trim() === '') {
        errors.push(`${where}（key=${opt.key}）的 text 缺失或为空`)
      }
    })
  }

  // answer
  const answer = obj.answer
  if (!Array.isArray(answer)) {
    errors.push('answer 缺失或不是数组')
  } else {
    if (answer.length === 0) errors.push('answer 为空')
    const seen = new Set()
    answer.forEach((key, i) => {
      if (typeof key !== 'string' || key.trim() === '') {
        errors.push(`answer[${i}] 不是非空字符串`)
        return
      }
      if (seen.has(key)) errors.push(`answer 中 key 重复："${key}"`)
      seen.add(key)
      if (options && optionKeys.size > 0 && !optionKeys.has(key)) {
        errors.push(`answer 中的 key "${key}" 不存在于 options[].key`)
      }
    })
    if (isTypeValid) {
      if ((obj.type === 'single' || obj.type === 'judge') && answer.length !== 1) {
        errors.push(`${obj.type} 的 answer 长度必须为 1，实际 ${answer.length}`)
      }
      if (obj.type === 'multiple' && answer.length < 2) {
        errors.push(`multiple 的 answer 长度必须 ≥ 2，实际 ${answer.length}`)
      }
    }
  }

  // answer_status
  if (obj.answer_status !== 'verified') {
    const hint = ANSWER_STATUS.includes(obj.answer_status) ? '' : '（不在已知取值内）'
    errors.push(`answer_status 必须为 "verified"，实际为 ${JSON.stringify(obj.answer_status)}${hint}`)
  }

  // taxonomy
  if (obj.taxonomy !== undefined && obj.taxonomy !== null) {
    if (!Array.isArray(obj.taxonomy)) {
      errors.push('taxonomy 不是数组')
    } else {
      for (const id of obj.taxonomy) {
        if (typeof id !== 'string' || id.trim() === '') {
          errors.push(`taxonomy 含非字符串 id：${JSON.stringify(id)}`)
        } else if (!topicIds.has(id)) {
          errors.push(`taxonomy id "${id}" 不在 taxonomy.json 的 topics 中（未改动题目内容）`)
        }
      }
      if (obj.taxonomy.length === 0) warnings.push('taxonomy 为空数组')
    }
  } else {
    warnings.push('缺少 taxonomy')
  }

  // difficulty / round / source 的类型与取值（Question 类型约束）
  if (obj.difficulty !== undefined && obj.difficulty !== null) {
    if (![1, 2, 3].includes(obj.difficulty)) {
      errors.push(`difficulty 必须为 1|2|3，实际为 ${JSON.stringify(obj.difficulty)}`)
    }
  } else {
    warnings.push('缺少 difficulty')
  }
  if (obj.round !== undefined && obj.round !== null && typeof obj.round !== 'string') {
    errors.push('round 不是字符串')
  }
  if (obj.source !== undefined && obj.source !== null && typeof obj.source !== 'string') {
    errors.push('source 不是字符串')
  }

  return { errors, warnings }
}

/** 加一计数 */
function inc(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

/** 排序后的 [key, count] 列表；数值 key 按数值升序，其余按出现次数降序再按名称 */
function sortedEntries(map, numeric = false) {
  const entries = [...map.entries()]
  if (numeric) {
    return entries.sort((a, b) => Number(a[0]) - Number(b[0]))
  }
  return entries.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
}

/** markdown 两列表格 */
function table2(headerA, headerB, entries, emptyText = '（无）') {
  if (entries.length === 0) return `${emptyText}\n`
  const lines = [`| ${headerA} | ${headerB} |`, '| --- | ---: |']
  for (const [k, v] of entries) lines.push(`| ${k} | ${v} |`)
  return lines.join('\n') + '\n'
}

function pct(n, total) {
  if (total === 0) return '0%'
  return `${((n / total) * 100).toFixed(1)}%`
}

/** 生成报告 markdown */
function buildReport({ total, passed, failed, byType, byDifficulty, byRound, bySource, byTopic, multiAnswerLen, errorRows, warningsRows, extraFiles }) {
  const now = new Date().toISOString()
  const lines = []
  lines.push('# 题目导入报告')
  lines.push('')
  lines.push(`- 源目录：\`${SRC_DIR}\``)
  lines.push(`- 目标目录：\`${OUT_DIR}\``)
  lines.push(`- 分类法：\`${TAXONOMY_PATH}\``)
  lines.push(`- 生成时间：${now}`)
  lines.push('')
  lines.push('## 总览')
  lines.push('')
  lines.push('| 指标 | 数值 |')
  lines.push('| --- | ---: |')
  lines.push(`| 源文件总数 | ${total} |`)
  lines.push(`| 校验通过（已导入） | ${passed} |`)
  lines.push(`| 校验失败（未导入） | ${failed} |`)
  lines.push('')
  lines.push('## 分布')
  lines.push('')
  lines.push('### 按题型')
  lines.push('')
  lines.push(table2('type', '数量', [...byType.entries()].sort((a, b) => QUESTION_TYPES.indexOf(a[0]) - QUESTION_TYPES.indexOf(b[0]))))
  lines.push('### 按难度')
  lines.push('')
  lines.push(table2('difficulty', '数量', sortedEntries(byDifficulty, true)))
  lines.push('### 按 round')
  lines.push('')
  lines.push(table2('round', '数量', sortedEntries(byRound)))
  lines.push('### 按来源')
  lines.push('')
  lines.push(table2('source', '数量', sortedEntries(bySource)))
  lines.push('### 按 topic')
  lines.push('')
  lines.push(table2('topic', '题数（一题可多 topic）', sortedEntries(byTopic)))
  lines.push('> 注：topic 计数按题目 `taxonomy` 数组逐项累计，因此总和可大于题目总数。')
  lines.push('')
  lines.push('### 多选答案个数分布')
  lines.push('')
  lines.push(table2('type:答案个数', '题数', sortedEntries(multiAnswerLen)))
  lines.push('## 校验失败明细')
  lines.push('')
  if (errorRows.length === 0) {
    lines.push('无。全部源文件通过校验。')
  } else {
    lines.push('| 文件 | 原因 |')
    lines.push('| --- | --- |')
    for (const row of errorRows) {
      lines.push(`| ${row.file} | ${row.errors.join('；').replace(/\|/g, '\\|')} |`)
    }
  }
  lines.push('')
  lines.push('## 校验告警（不阻断导入）')
  lines.push('')
  if (warningsRows.length === 0) {
    lines.push('无。')
  } else {
    lines.push('| 文件 | 告警 |')
    lines.push('| --- | --- |')
    for (const row of warningsRows) {
      lines.push(`| ${row.file} | ${row.warnings.join('；').replace(/\|/g, '\\|')} |`)
    }
  }
  lines.push('')
  if (extraFiles.length > 0) {
    lines.push('## 目标目录中的额外文件（非本次源文件，未删除）')
    lines.push('')
    for (const f of extraFiles) lines.push(`- ${f}`)
    lines.push('')
  }
  lines.push('## 说明')
  lines.push('')
  lines.push('- 校验通过的题目原样写入（字段顺序保持源文件顺序，2 空格缩进，结尾换行）。')
  lines.push('- 校验失败的题目不写入目标目录，题目内容未被改动。')
  lines.push('- 本报告每次运行覆盖写；题目文件按文件名覆盖写，脚本幂等。')
  lines.push('')
  return lines.join('\n')
}

function main() {
  if (!existsSync(SRC_DIR)) {
    console.error(`源目录不存在：${SRC_DIR}`)
    process.exit(2)
  }
  const topicIds = loadTopicIds()

  const files = readdirSync(SRC_DIR)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, 'en'))

  mkdirSync(OUT_DIR, { recursive: true })

  const seenIds = new Set()
  const byType = new Map()
  const byDifficulty = new Map()
  const byRound = new Map()
  const bySource = new Map()
  const byTopic = new Map()
  const multiAnswerLen = new Map()
  const errorRows = []
  const warningsRows = []
  let passed = 0
  let failed = 0

  for (const file of files) {
    const filePath = join(SRC_DIR, file)
    let obj
    try {
      obj = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch (err) {
      failed++
      errorRows.push({ file, errors: [`JSON 解析失败：${err.message}`] })
      continue
    }

    const { errors, warnings } = validateQuestion(obj, file, topicIds)

    // id 全局唯一（后出现的重复 id 判失败）
    if (typeof obj?.id === 'string' && obj.id !== '') {
      if (seenIds.has(obj.id)) errors.push(`id "${obj.id}" 与其他文件重复`)
      else seenIds.add(obj.id)
    }

    if (warnings.length > 0) warningsRows.push({ file, warnings })

    if (errors.length > 0) {
      failed++
      errorRows.push({ file, errors })
      continue
    }

    // 校验通过 → 原样写出（字段顺序与源文件一致）
    const outPath = join(OUT_DIR, file)
    writeFileSync(outPath, JSON.stringify(obj, null, 2) + '\n', 'utf8')
    passed++

    inc(byType, obj.type)
    if (obj.difficulty !== undefined && obj.difficulty !== null) inc(byDifficulty, String(obj.difficulty))
    if (typeof obj.round === 'string' && obj.round !== '') inc(byRound, obj.round)
    if (typeof obj.source === 'string' && obj.source !== '') inc(bySource, obj.source)
    for (const t of obj.taxonomy ?? []) inc(byTopic, t)
    inc(multiAnswerLen, `${obj.type}:${(obj.answer ?? []).length}`)
  }

  // 目标目录里不属于本次源文件的 *.json（只报告，不删除）
  const sourceSet = new Set(files)
  const extraFiles = readdirSync(OUT_DIR)
    .filter((f) => f.toLowerCase().endsWith('.json') && !sourceSet.has(f))
    .sort()

  const report = buildReport({
    total: files.length,
    passed,
    failed,
    byType,
    byDifficulty,
    byRound,
    bySource,
    byTopic,
    multiAnswerLen,
    errorRows,
    warningsRows,
    extraFiles,
  })
  writeFileSync(REPORT_PATH, report, 'utf8')

  // 控制台摘要
  console.log('='.repeat(60))
  console.log(`源目录   : ${SRC_DIR}`)
  console.log(`目标目录 : ${OUT_DIR}`)
  console.log(`报告     : ${REPORT_PATH}`)
  console.log('-'.repeat(60))
  console.log(`源文件总数 : ${files.length}`)
  console.log(`校验通过   : ${passed}`)
  console.log(`校验失败   : ${failed}`)
  console.log(`题型分布   : ${[...byType.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`)
  console.log(`难度分布   : ${sortedEntries(byDifficulty, true).map(([k, v]) => `${k}=${v}`).join(', ')}`)
  console.log(`topic 覆盖 : ${byTopic.size}/${topicIds.size} 个`)
  console.log(`多选答案个数: ${[...multiAnswerLen.entries()].filter(([k]) => k.startsWith('multiple:')).map(([k, v]) => `${k.split(':')[1]}=${v}`).join(', ')}`)
  console.log('='.repeat(60))

  if (failed > 0) {
    console.error(`存在 ${failed} 个校验失败文件，详见报告。`)
    process.exit(1)
  }
}

main()
