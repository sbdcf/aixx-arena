#!/usr/bin/env node
/**
 * verify-data.mjs —— 独立验收脚本（不 import 生成脚本，自带断言）
 *
 * 核对：
 *  1) data/questions 中题目文件数 = 87，每个文件可 parse、id 与文件名一致、关键字段合法；
 *  2) data/papers 中恰好 5 份试卷，逐份按 design.md §9.2 校验；
 *  3) 每份试卷的 draw/legs 题量能被真实题库满足。
 *
 * 用法（在仓库根目录）：
 *   node scripts/verify-data.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ARENA_ROOT = resolve(__dirname, '..')
const QUESTIONS_DIR = join(ARENA_ROOT, 'data', 'questions')
const PAPERS_DIR = join(ARENA_ROOT, 'data', 'papers')
const TAXONOMY_PATH = resolve(ARENA_ROOT, '..', 'aixx-guide', 'data', 'taxonomy.json')

const EXPECTED_QUESTION_COUNT = 87
const EXPECTED_PAPER_IDS = [
  'paper-school-55',
  'paper-team-solo-10',
  'paper-team-coop-10',
  'paper-relay-5x3',
  'paper-buzz-01',
]
const QUESTION_TYPES = ['single', 'multiple', 'judge']
const FORMATS = ['solo', 'team-solo', 'team-coop', 'relay', 'buzz']
const SUBMIT_MODES = ['batch', 'stream']

let failures = 0
let checks = 0
function check(cond, label, detail = '') {
  checks++
  if (cond) {
    console.log(`  ✓ ${label}`)
  } else {
    failures++
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

// ---------- 1. 题库 ----------
console.log('\n[1/3] 题库 data/questions')
const topicIds = new Set(JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8')).topics.map((t) => t.id))
const qFiles = readdirSync(QUESTIONS_DIR).filter((f) => f.endsWith('.json')).sort()
check(qFiles.length === EXPECTED_QUESTION_COUNT, `题目文件数 = ${EXPECTED_QUESTION_COUNT}`, `实际 ${qFiles.length}`)

const pool = { single: 0, multiple: 0, judge: 0 }
const ids = new Set()
const knownTax = new Set()
let qOk = 0
for (const f of qFiles) {
  const errs = []
  let q
  try {
    q = JSON.parse(readFileSync(join(QUESTIONS_DIR, f), 'utf8'))
  } catch (e) {
    check(false, `${f} 可 JSON.parse`, e.message)
    continue
  }
  if (q.schema_version !== 1) errs.push('schema_version≠1')
  if (q.id !== f.replace(/\.json$/, '')) errs.push('id≠文件名')
  if (!QUESTION_TYPES.includes(q.type)) errs.push('type 非法')
  if (typeof q.stem !== 'string' || !q.stem.trim()) errs.push('stem 空')
  if (!Array.isArray(q.options) || q.options.length < 2) errs.push('options<2')
  const keys = new Set((q.options ?? []).map((o) => o.key))
  if (keys.size !== (q.options ?? []).length) errs.push('options key 重复')
  if (!Array.isArray(q.answer) || q.answer.length === 0) errs.push('answer 空')
  else {
    if (q.answer.some((k) => !keys.has(k))) errs.push('answer 含未知 key')
    if ((q.type === 'single' || q.type === 'judge') && q.answer.length !== 1) errs.push(`${q.type} answer 长度≠1`)
    if (q.type === 'multiple' && q.answer.length < 2) errs.push('multiple answer 长度<2')
  }
  if (q.answer_status !== 'verified') errs.push('answer_status≠verified')
  for (const t of q.taxonomy ?? []) {
    if (!topicIds.has(t)) errs.push(`未知 taxonomy:${t}`)
    else knownTax.add(t)
  }
  if (ids.has(q.id)) errs.push('id 重复')
  ids.add(q.id)
  if (errs.length === 0) {
    qOk++
    pool[q.type]++
  } else {
    check(false, `${f} 字段校验`, errs.join('；'))
  }
}
check(qOk === qFiles.length, '全部题目字段校验通过', `${qOk}/${qFiles.length}`)
check(ids.size === qFiles.length, 'id 全局唯一', `${ids.size} 个唯一 id`)

// 「不修改题目内容」：与源目录逐字段语义比对（key 顺序也一致）
const SRC_DIR = resolve(ARENA_ROOT, '..', '已确认题目')
if (existsSync(SRC_DIR)) {
  const srcFiles = readdirSync(SRC_DIR).filter((f) => f.endsWith('.json'))
  const mismatched = qFiles.filter((f) => {
    try {
      const a = JSON.stringify(JSON.parse(readFileSync(join(SRC_DIR, f), 'utf8')))
      const b = JSON.stringify(JSON.parse(readFileSync(join(QUESTIONS_DIR, f), 'utf8')))
      return a !== b
    } catch {
      return true
    }
  })
  check(srcFiles.length === qFiles.length && mismatched.length === 0, '题目内容与源文件逐字段一致（未改动）', mismatched.join(',') || `源 ${srcFiles.length} / 目标 ${qFiles.length}`)
}
check(knownTax.size === topicIds.size, `taxonomy 12 个 topic 全覆盖`, `覆盖 ${knownTax.size}/${topicIds.size}`)
console.log(`  题型池：single=${pool.single}, multiple=${pool.multiple}, judge=${pool.judge}`)

// ---------- 2. 试卷 §9.2 ----------
console.log('\n[2/3] 试卷 data/papers（design.md §9.2 加载期校验）')
const pFiles = readdirSync(PAPERS_DIR).filter((f) => f.endsWith('.json')).sort()
check(pFiles.length === EXPECTED_PAPER_IDS.length, `试卷文件数 = ${EXPECTED_PAPER_IDS.length}`, `实际 ${pFiles.length}`)
const loadedPapers = new Map()
for (const f of pFiles) {
  let p
  try {
    p = JSON.parse(readFileSync(join(PAPERS_DIR, f), 'utf8'))
  } catch (e) {
    check(false, `${f} 可 JSON.parse`, e.message)
    continue
  }
  loadedPapers.set(p.id, p)
  const errs = []
  if (p.schema_version !== 1) errs.push('schema_version≠1')
  if (!FORMATS.includes(p.format)) errs.push('format 非法')
  if (!(typeof p.duration_sec === 'number' && p.duration_sec >= 0)) errs.push('duration_sec 非法')
  if (!SUBMIT_MODES.includes(p.submit_mode)) errs.push('submit_mode 非法')
  if (typeof p.id !== 'string' || !p.id) errs.push('id 缺失')
  if (typeof p.name !== 'string' || !p.name) errs.push('name 缺失')
  if (p.id !== f.replace(/\.json$/, '')) errs.push('id≠文件名')

  const drawErrs = (d, label) => {
    const local = []
    if (!d || typeof d !== 'object') return [`${label} 缺失`]
    let total = 0
    for (const t of QUESTION_TYPES) {
      if (!Number.isInteger(d[t]) || d[t] < 0) local.push(`${label}.${t} 非法`)
      else total += d[t]
    }
    if (total <= 0) local.push(`${label} 总数=0`)
    if (!Number.isInteger(d.min_available) || d.min_available < 0) local.push(`${label}.min_available 非法`)
    if (typeof d.allow_partial !== 'boolean') local.push(`${label}.allow_partial 非布尔`)
    if (!(d.seed === null || d.seed === undefined || Number.isInteger(d.seed))) local.push(`${label}.seed 非法`)
    return local
  }

  if (p.format === 'relay') {
    if (p.draw !== null) errs.push('relay draw 不为 null')
    if (!Array.isArray(p.legs) || p.legs.length !== 3) errs.push('relay legs 不是 3 段')
    else p.legs.forEach((leg, i) => errs.push(...drawErrs(leg, `legs[${i}]`)))
    if (!(p.duration_sec > 0)) errs.push('relay duration_sec 不为正')
  } else {
    if (p.draw === null) errs.push('非 relay draw 为 null')
    else errs.push(...drawErrs(p.draw, 'draw'))
    if (p.legs !== undefined && p.legs !== null) errs.push('非 relay 带 legs')
  }

  const s = p.scoring
  if (!s || !['per_question', 'correct_minus_wrong'].includes(s.mode)) errs.push('scoring.mode 非法')
  else {
    for (const t of QUESTION_TYPES) if (typeof s.points?.[t] !== 'number') errs.push(`points.${t} 非数字`)
    for (const k of ['wrong_penalty', 'unanswered', 'total_normalize']) if (typeof s[k] !== 'number') errs.push(`${k} 非数字`)
  }

  if (p.format === 'buzz') {
    const b = p.buzz
    if (!b || typeof b !== 'object') errs.push('buzz 配置缺失')
    else {
      for (const k of ['buffer_ms', 'submit_window_sec', 'qualify_ratio', 'correct_points', 'wrong_points', 'reveal_sec', 'tie_window_ms']) {
        if (typeof b[k] !== 'number') errs.push(`buzz.${k} 非数字`)
      }
      if (!(b.qualify_ratio > 0 && b.qualify_ratio <= 1)) errs.push('qualify_ratio ∉ (0,1]')
      if (!(b.buffer_ms >= 0)) errs.push('buffer_ms<0')
      if (!(b.tie_window_ms >= 0)) errs.push('tie_window_ms<0')
      if (!['strict', 'fill'].includes(b.qualify_fill)) errs.push('qualify_fill 非法')
      if (typeof b.close_on_all_submitted !== 'boolean') errs.push('close_on_all_submitted 非布尔')
    }
    if (p.submit_mode !== 'stream') errs.push('buzz submit_mode≠stream')
  } else if (p.buzz !== undefined) errs.push('非 buzz 带 buzz')

  // 容量核对
  const specs = p.format === 'relay' ? (p.legs ?? []) : [p.draw]
  specs.forEach((d, i) => {
    if (!d) return
    for (const t of QUESTION_TYPES) {
      if ((d[t] ?? 0) > pool[t]) errs.push(`draw 需求 ${t}=${d[t]} > 池 ${pool[t]}`)
    }
  })

  if (errs.length === 0) console.log(`  ✓ ${f} 通过 §9.2 校验`)
  else check(false, `${f} 通过 §9.2 校验`, errs.join('；'))
}
check(EXPECTED_PAPER_IDS.every((id) => loadedPapers.has(id)), '五份试卷 id 齐全', `实际 ${[...loadedPapers.keys()].join(',')}`)

// 题量断言
const size = (p) =>
  p.format === 'relay'
    ? p.legs.reduce((s, d) => s + d.single + d.multiple + d.judge, 0)
    : p.draw.single + p.draw.multiple + p.draw.judge
const expectedSizes = {
  'paper-school-55': 55,
  'paper-team-solo-10': 10,
  'paper-team-coop-10': 10,
  'paper-relay-5x3': 15,
  'paper-buzz-01': 10,
}
for (const [id, n] of Object.entries(expectedSizes)) {
  const p = loadedPapers.get(id)
  check(p ? size(p) === n : false, `${id} 题量 = ${n}`, p ? `实际 ${size(p)}` : '缺失')
}

// buzz 关键字段断言
const buzz = loadedPapers.get('paper-buzz-01')
if (buzz) {
  console.log('\n[3/3] buzz 关键配置核对')
  const expectedBuzz = {
    buffer_ms: 1000,
    submit_window_sec: 20,
    qualify_ratio: 0.5,
    qualify_fill: 'strict',
    correct_points: 4,
    wrong_points: -1,
    reveal_sec: 5,
    close_on_all_submitted: false,
    tie_window_ms: 5,
  }
  for (const [k, v] of Object.entries(expectedBuzz)) {
    check(buzz.buzz?.[k] === v, `buzz.${k} = ${JSON.stringify(v)}`, `实际 ${JSON.stringify(buzz.buzz?.[k])}`)
  }
  check(buzz.duration_sec === 0, 'buzz duration_sec = 0', `实际 ${buzz.duration_sec}`)
  check(buzz.draw?.single === 5 && buzz.draw?.multiple === 3 && buzz.draw?.judge === 2, 'buzz draw = 5/3/2（共 10 题）')
  check(buzz.submit_mode === 'stream', 'buzz submit_mode = stream', buzz.submit_mode)
}

// relay 断言
const relay = loadedPapers.get('paper-relay-5x3')
if (relay) {
  check(relay.draw === null, 'relay 顶层 draw = null')
  check(Array.isArray(relay.legs) && relay.legs.length === 3, 'relay legs 恰好 3 段')
  check(relay.legs.every((l) => l.single === 3 && l.multiple === 1 && l.judge === 1), 'relay 每段 3/1/1 = 5 题')
}

console.log('\n' + '='.repeat(60))
console.log(`断言 ${checks} 项，失败 ${failures} 项`)
if (failures === 0) {
  console.log('RESULT: PASS —— 题库 87 题 + 5 份试卷全部通过验收。')
  process.exit(0)
} else {
  console.log('RESULT: FAIL')
  process.exit(1)
}
