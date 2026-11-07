#!/usr/bin/env node
/**
 * generate-papers.mjs
 *
 * 生成 aixx-arena/data/papers/ 下五份试卷配置，并在写出前按 design.md §9.2 的
 * 加载期校验规则自检 + 核对题库容量是否满足 draw。
 *
 * 用法（在仓库根目录）：
 *   node scripts/generate-papers.mjs
 *
 * 幂等：重复执行按固定文件名覆盖写。题库题目内容不做任何改动。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ARENA_ROOT = resolve(__dirname, '..')
const QUESTIONS_DIR = join(ARENA_ROOT, 'data', 'questions')
const PAPERS_DIR = join(ARENA_ROOT, 'data', 'papers')

const FORMATS = ['solo', 'team-solo', 'team-coop', 'relay', 'buzz']
const SUBMIT_MODES = ['batch', 'stream']
const QUESTION_TYPES = ['single', 'multiple', 'judge']

/** 五份试卷定义（字段与 design.md §5.1 Paper / §9.1 示例一致） */
const PAPERS = [
  {
    schema_version: 1,
    id: 'paper-school-55',
    name: '校赛模拟 55 题',
    format: 'solo',
    duration_sec: 3600,
    draw: { single: 30, multiple: 15, judge: 10, min_available: 40, allow_partial: true, seed: null },
    submit_mode: 'batch',
    scoring: {
      mode: 'per_question',
      points: { single: 1, multiple: 2, judge: 1 },
      wrong_penalty: 0,
      unanswered: 0,
      total_normalize: 100,
    },
  },
  {
    schema_version: 1,
    id: 'paper-team-solo-10',
    name: '个人对抗 10 题',
    format: 'team-solo',
    duration_sec: 300,
    draw: { single: 6, multiple: 2, judge: 2, min_available: 10, allow_partial: true, seed: 2026 },
    submit_mode: 'stream',
    scoring: {
      mode: 'correct_minus_wrong',
      points: { single: 2, multiple: 2, judge: 2 },
      wrong_penalty: 1,
      unanswered: 0,
      total_normalize: 0,
    },
  },
  {
    schema_version: 1,
    id: 'paper-team-coop-10',
    name: '团队对抗 10 题',
    format: 'team-coop',
    duration_sec: 1200,
    draw: { single: 6, multiple: 2, judge: 2, min_available: 10, allow_partial: true, seed: 2026 },
    submit_mode: 'stream',
    scoring: {
      mode: 'correct_minus_wrong',
      points: { single: 4, multiple: 4, judge: 4 },
      wrong_penalty: 1,
      unanswered: 0,
      total_normalize: 0,
    },
  },
  {
    schema_version: 1,
    id: 'paper-relay-5x3',
    name: '接力赛 5 分钟×3',
    format: 'relay',
    duration_sec: 300,
    draw: null,
    legs: [
      { single: 3, multiple: 1, judge: 1, min_available: 5, allow_partial: true, seed: 2026 },
      { single: 3, multiple: 1, judge: 1, min_available: 5, allow_partial: true, seed: 2027 },
      { single: 3, multiple: 1, judge: 1, min_available: 5, allow_partial: true, seed: 2028 },
    ],
    submit_mode: 'stream',
    scoring: {
      mode: 'correct_minus_wrong',
      points: { single: 4, multiple: 4, judge: 4 },
      wrong_penalty: 1,
      unanswered: 0,
      total_normalize: 0,
    },
  },
  {
    schema_version: 1,
    id: 'paper-buzz-01',
    name: '抢答赛 10 题',
    format: 'buzz',
    duration_sec: 0,
    draw: { single: 5, multiple: 3, judge: 2, min_available: 10, allow_partial: true, seed: null },
    submit_mode: 'stream',
    scoring: {
      mode: 'per_question',
      points: { single: 0, multiple: 0, judge: 0 },
      wrong_penalty: 0,
      unanswered: 0,
      total_normalize: 0,
    },
    buzz: {
      buffer_ms: 1000,
      submit_window_sec: 20,
      qualify_ratio: 0.5,
      qualify_fill: 'strict',
      correct_points: 4,
      wrong_points: -1,
      reveal_sec: 5,
      close_on_all_submitted: false,
      tie_window_ms: 5,
    },
  },
]

/** design.md §9.2 加载期校验 */
function validatePaper(p) {
  const errs = []
  if (p.schema_version !== 1) errs.push('schema_version 必须为 1')
  if (!FORMATS.includes(p.format)) errs.push(`format 非法：${JSON.stringify(p.format)}`)
  if (typeof p.duration_sec !== 'number' || p.duration_sec < 0) errs.push('duration_sec 必须 ≥ 0')
  if (!SUBMIT_MODES.includes(p.submit_mode)) errs.push(`submit_mode 非法：${JSON.stringify(p.submit_mode)}`)
  if (typeof p.id !== 'string' || p.id === '') errs.push('id 缺失')
  if (typeof p.name !== 'string' || p.name === '') errs.push('name 缺失')

  const checkDraw = (d, label) => {
    if (d === null || typeof d !== 'object') {
      errs.push(`${label} 不是对象`)
      return
    }
    let total = 0
    for (const t of QUESTION_TYPES) {
      const n = d[t]
      if (!Number.isInteger(n) || n < 0) errs.push(`${label}.${t} 必须为 ≥ 0 的整数，实际 ${JSON.stringify(n)}`)
      else total += n
    }
    if (total <= 0) errs.push(`${label} 的题型总数必须 > 0`)
    if (!Number.isInteger(d.min_available) || d.min_available < 0) errs.push(`${label}.min_available 非法`)
    if (typeof d.allow_partial !== 'boolean') errs.push(`${label}.allow_partial 必须为布尔`)
    if (!(d.seed === null || d.seed === undefined || Number.isInteger(d.seed))) errs.push(`${label}.seed 非法`)
  }

  const isRelay = p.format === 'relay'
  if (isRelay) {
    if (p.draw !== null) errs.push('relay 的顶层 draw 必须为 null')
    if (!Array.isArray(p.legs) || p.legs.length !== 3) errs.push('relay 的 legs 必须恰好 3 段')
    else p.legs.forEach((leg, i) => checkDraw(leg, `legs[${i}]`))
    if (!(p.duration_sec > 0)) errs.push('relay 的 duration_sec 必须 > 0（单棒时长）')
  } else {
    if (p.draw === null || p.draw === undefined) errs.push('非 relay 的 draw 不能为空')
    else checkDraw(p.draw, 'draw')
    if (p.legs !== undefined && p.legs !== null) errs.push('非 relay 的 legs 必须为空/缺省')
  }

  const s = p.scoring
  if (s === null || typeof s !== 'object') {
    errs.push('scoring 缺失')
  } else {
    if (!['per_question', 'correct_minus_wrong'].includes(s.mode)) errs.push('scoring.mode 非法')
    for (const t of QUESTION_TYPES) {
      if (typeof s.points?.[t] !== 'number') errs.push(`scoring.points.${t} 必须为数字`)
    }
    for (const k of ['wrong_penalty', 'unanswered', 'total_normalize']) {
      if (typeof s[k] !== 'number') errs.push(`scoring.${k} 必须为数字`)
    }
    if (!(s.total_normalize >= 0)) errs.push('scoring.total_normalize 必须 ≥ 0')
  }

  if (p.format === 'buzz') {
    const b = p.buzz
    if (b === null || typeof b !== 'object') {
      errs.push('buzz 卷必须有 buzz 配置')
    } else {
      for (const k of ['buffer_ms', 'submit_window_sec', 'qualify_ratio', 'correct_points', 'wrong_points', 'reveal_sec']) {
        if (typeof b[k] !== 'number') errs.push(`buzz.${k} 必须为数字`)
      }
      if (!(typeof b.qualify_ratio === 'number' && b.qualify_ratio > 0 && b.qualify_ratio <= 1)) {
        errs.push('buzz.qualify_ratio 必须 ∈ (0,1]')
      }
      if (!(typeof b.buffer_ms === 'number' && b.buffer_ms >= 0)) errs.push('buzz.buffer_ms 必须 ≥ 0')
      if (!(typeof b.tie_window_ms === 'number' && b.tie_window_ms >= 0)) errs.push('buzz.tie_window_ms 必须 ≥ 0')
      if (!['strict', 'fill'].includes(b.qualify_fill)) errs.push('buzz.qualify_fill 必须为 strict|fill')
      if (typeof b.close_on_all_submitted !== 'boolean') errs.push('buzz.close_on_all_submitted 必须为布尔')
    }
    if (p.submit_mode !== 'stream') errs.push('buzz 卷必须 submit_mode === "stream"')
  } else if (p.buzz !== undefined) {
    errs.push('非 buzz 卷不应带 buzz 配置')
  }
  return errs
}

/** 读取题库池的题型计数 */
function loadPool() {
  if (!existsSync(QUESTIONS_DIR)) {
    throw new Error(`题库目录不存在：${QUESTIONS_DIR}，请先运行 import-questions.mjs`)
  }
  const counts = { single: 0, multiple: 0, judge: 0 }
  const files = readdirSync(QUESTIONS_DIR).filter((f) => f.endsWith('.json'))
  for (const f of files) {
    const q = JSON.parse(readFileSync(join(QUESTIONS_DIR, f), 'utf8'))
    if (counts[q.type] !== undefined) counts[q.type]++
  }
  return { counts, total: files.length }
}

/** 核对 draw 是否能被真实题库满足 */
function checkCapacity(p, pool) {
  const errs = []
  const specs = p.format === 'relay' ? (p.legs ?? []).map((d, i) => [`legs[${i}]`, d]) : [['draw', p.draw]]
  for (const [label, d] of specs) {
    if (!d) continue
    for (const t of QUESTION_TYPES) {
      const need = d[t] ?? 0
      if (need > pool.counts[t]) {
        errs.push(`${label}.${t} 需要 ${need} 题，题库仅 ${pool.counts[t]} 题`)
      }
    }
    const need = (d.single ?? 0) + (d.multiple ?? 0) + (d.judge ?? 0)
    if (need > pool.total) {
      errs.push(`${label} 共需 ${need} 题，题库仅 ${pool.total} 题`)
    }
    if (d.min_available > need) {
      errs.push(`${label}.min_available=${d.min_available} 大于该卷题量 ${need}（§9.1 示例 paper-school-55 即如此：40 < 55，仅提示）`)
    }
  }
  return errs
}

/** 抽题总量（relay 为三段之和） */
function paperQuestionCount(p) {
  if (p.format === 'relay') {
    return (p.legs ?? []).reduce((sum, d) => sum + (d.single ?? 0) + (d.multiple ?? 0) + (d.judge ?? 0), 0)
  }
  return (p.draw?.single ?? 0) + (p.draw?.multiple ?? 0) + (p.draw?.judge ?? 0)
}

function main() {
  const pool = loadPool()
  console.log(`题库池：${pool.total} 题（single=${pool.counts.single}, multiple=${pool.counts.multiple}, judge=${pool.counts.judge}）`)
  mkdirSync(PAPERS_DIR, { recursive: true })

  let failed = 0
  for (const paper of PAPERS) {
    const errs = validatePaper(paper)
    const capErrs = checkCapacity(paper, pool)
    const blocking = capErrs.filter((e) => !e.includes('仅提示'))
    errs.push(...blocking)
    if (errs.length > 0) {
      failed++
      console.error(`✗ ${paper.id}: ${errs.join('；')}`)
      continue
    }
    const outPath = join(PAPERS_DIR, `${paper.id}.json`)
    writeFileSync(outPath, JSON.stringify(paper, null, 2) + '\n', 'utf8')
    console.log(`✓ ${paper.id}  题量=${paperQuestionCount(paper)}  format=${paper.format}  duration=${paper.duration_sec}s  submit=${paper.submit_mode}  → ${outPath}`)
  }

  if (failed > 0) {
    console.error(`有 ${failed} 份试卷未通过自检，未写出。`)
    process.exit(1)
  }
  console.log(`共写出 ${PAPERS.length} 份试卷配置到 ${PAPERS_DIR}`)
}

main()
