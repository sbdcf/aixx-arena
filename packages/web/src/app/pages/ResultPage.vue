<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { MatchSummary, Question, TeamResult } from '@aixx/core'
import { openLocalMatch, createLocalMatch } from '@/stores/matchStore.ts'
import { loadRoomResult } from '@/storage/matchStorage.ts'

const route = useRoute()
const router = useRouter()

const summary = ref<MatchSummary | null>(null)
const questions = ref<Question[]>([])
const paperName = ref('')
const paperId = ref('')
const onlyWrong = ref(false)
const notFound = ref('')
/** 联机时自己所在队伍的 id（本地练习没有多队，留空） */
const myTeamId = ref('')

const matchId = computed(() => String(route.params.matchId ?? ''))

onMounted(() => {
  const record = openLocalMatch(matchId.value)
  if (record && record.summary) {
    summary.value = record.summary
    questions.value = record.questions
    paperName.value = record.paper.name
    paperId.value = record.paper.id
    return
  }
  // 联机对局：服务端不存历史，靠交卷时写下的本地备份
  const roomResult = loadRoomResult(matchId.value)
  if (!roomResult) {
    notFound.value = '没有找到这场练习的成绩记录（可能已删除，或换了浏览器）'
    return
  }
  summary.value = roomResult.summary
  // 联机题面不带答案：把交卷后下发的 reveal 合并回题目，复盘页才能显示正确答案与解析
  questions.value = roomResult.questions.map((question) => {
    const reveal = roomResult.reveal?.[question.id]
    if (!reveal) return question
    return { ...question, answer: reveal.answer, explain: reveal.explain ?? question.explain }
  })
  paperName.value = roomResult.paper_name
  myTeamId.value = roomResult.team_id ?? ''
})

const me = computed<TeamResult | null>(() => {
  const result = summary.value
  if (!result) return null
  if (myTeamId.value) {
    const mine = result.teams.find((team) => team.id === myTeamId.value)
    if (mine) return mine
  }
  return result.teams[0] ?? null
})

/** 团队赛要交代「这几个人分别答成什么样」；单人局 members 只有一项，不显示 */
const memberRows = computed(() => (me.value && me.value.members.length > 1 ? me.value.members : []))
const isTeam = computed(
  () =>
    summary.value?.format === 'team-solo' ||
    summary.value?.format === 'team-coop' ||
    summary.value?.format === 'relay' ||
    summary.value?.format === 'buzz',
)
const formatText = computed(() => {
  switch (summary.value?.format) {
    case 'solo':
      return '个人客观题'
    case 'team-solo':
      return '团队个人赛（团队总分 = 成员得分之和）'
    case 'team-coop':
      return '团队赛（1 答 2 辅，按队汇总）'
    case 'relay':
      return '接力赛（3 棒 · 剩余时间继承，按队汇总）'
    case 'buzz':
      return '团队抢答（前 50% 提交且答对加分，按队汇总）'
    default:
      return ''
  }
})

interface ReviewRow {
  question: Question
  choice: string[] | null
  correct: boolean
  points: number
  index: number
}

const rows = computed<ReviewRow[]>(() => {
  const result = summary.value
  if (!result) return []
  const detail = new Map(me.value?.detail.map((item) => [item.qid, item]) ?? [])
  return questions.value.map((question, index) => {
    const record = detail.get(question.id)
    return {
      question,
      choice: record?.choice ?? null,
      correct: record?.correct ?? false,
      points: record?.points ?? 0,
      index,
    }
  })
})

const visibleRows = computed(() => (onlyWrong.value ? rows.value.filter((row) => !row.correct) : rows.value))

const stats = computed(() => {
  const list = rows.value
  const answered = list.filter((row) => row.choice && row.choice.length > 0).length
  const correct = list.filter((row) => row.correct).length
  return {
    total: list.length,
    answered,
    correct,
    wrong: answered - correct,
    blank: list.length - answered,
  }
})

const durationText = computed(() => {
  const result = summary.value
  if (!result) return '—'
  const seconds = Math.max(0, Math.round((result.ended_at - result.started_at) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
})

const endReasonText = computed(() => {
  switch (summary.value?.end_reason) {
    case 'time':
      return '时间到自动交卷'
    case 'self':
      return '主动交卷'
    case 'host':
      return '由房主结束'
    case 'all_done':
      return '答完自动结算'
    default:
      return '—'
  }
})

const typeLabel: Record<string, string> = { single: '单选', multiple: '多选', judge: '判断' }

function choiceText(choice: string[] | null): string {
  return choice && choice.length > 0 ? choice.join('、') : '未答'
}

function titleOf(question: Question): string {
  return question.title || question.stem.slice(0, 40)
}

function feedbackUrl(question: Question): string {
  const title = `题目纠错：${question.id}`
  // 联机题面里没有 answer（服务端只发裁剪后的题面），这里必须容错
  const answerText = Array.isArray(question.answer) && question.answer.length > 0 ? question.answer.join('、') : '（未获取到，请以题库文件为准）'
  const body = [
    `题目 ID：${question.id}`,
    `题目：${question.stem}`,
    `当前答案：${answerText}`,
    '',
    '问题描述：（请补充：答案错误 / 选项错误 / 题干有歧义 …）',
    '',
    `来源页面：${location.href}`,
  ].join('\n')
  return `https://github.com/sbdcf/Guide-of-National-College-Student-Information-Literacy-Competition/issues/new?title=${encodeURIComponent(
    title,
  )}&body=${encodeURIComponent(body)}`
}

async function retry(): Promise<void> {
  if (!paperId.value) return
  const nextId = await createLocalMatch(paperId.value)
  router.push({ name: 'play', params: { matchId: nextId } })
}

/** 教练/学生自存：把这场成绩导出成文件（不依赖任何后端或账号） */
function downloadText(filename: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function timestamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

function exportCsv(): void {
  const header = ['序号', '题目ID', '题型', '题干', '正确答案', '我的答案', '结果', '得分']
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`
  const lines = [header.map(escape).join(',')]
  for (const row of rows.value) {
    lines.push(
      [
        String(row.index + 1),
        row.question.id,
        typeLabel[row.question.type] ?? row.question.type,
        row.question.stem,
        choiceText(row.question.answer),
        choiceText(row.choice),
        row.choice?.length ? (row.correct ? '答对' : '答错') : '未答',
        String(row.points),
      ]
        .map(escape)
        .join(','),
    )
  }
  downloadText(`成绩-${paperName.value || paperId.value}-${timestamp()}.csv`, 'text/csv', lines.join('\r\n'))
}

function exportJson(): void {
  const payload = {
    exported_at: new Date().toISOString(),
    match_id: matchId.value,
    paper: { id: paperId.value, name: paperName.value },
    summary: summary.value,
    my_team_id: myTeamId.value || null,
    rows: rows.value.map((row) => ({
      index: row.index + 1,
      id: row.question.id,
      type: row.question.type,
      stem: row.question.stem,
      answer: row.question.answer,
      choice: row.choice,
      correct: row.correct,
      points: row.points,
      explain: row.question.explain ?? null,
    })),
  }
  downloadText(`成绩-${paperName.value || paperId.value}-${timestamp()}.json`, 'application/json', JSON.stringify(payload, null, 2))
}

/** 联机多队同场时，房主（教练）能看到全场排名，而不是只看到自己队 */
const teamRows = computed(() => {
  const teams = summary.value?.teams ?? []
  if (teams.length < 2) return []
  return [...teams].sort((a, b) => b.score - a.score)
})
</script>

<template>
  <main class="page">
    <div v-if="notFound" class="empty">
      <p>{{ notFound }}</p>
      <RouterLink class="btn" to="/" style="margin-top: 14px">回到首页</RouterLink>
    </div>

    <div v-else-if="!summary" class="empty">正在读取成绩…</div>

    <div v-else class="stack" style="gap: 18px">
      <section class="card">
        <div class="score-hero">
          <div>
            <div class="tiny muted">{{ paperName }}</div>
            <div>
              <span class="score-number">{{ me?.score ?? 0 }}</span>
              <span class="score-unit">/ {{ me?.max_score ?? 0 }} 分</span>
            </div>
            <div class="tiny muted" style="margin-top: 6px">{{ endReasonText }} · 用时 {{ durationText }}</div>
          </div>
          <span class="spacer" />
          <div class="row" style="gap: 10px; flex-wrap: wrap">
            <RouterLink class="btn" to="/">回到首页</RouterLink>
            <button class="btn" type="button" @click="exportCsv">导出 CSV</button>
            <button class="btn" type="button" @click="exportJson">导出 JSON</button>
            <button class="btn btn-primary" type="button" @click="retry">再练一次</button>
          </div>
        </div>
        <hr class="hr" style="margin: 4px 0 18px" />
        <div class="stat-grid">
          <div class="stat">
            <div class="stat-value">{{ stats.answered }}<span class="small muted"> / {{ stats.total }}</span></div>
            <div class="stat-label">已作答</div>
          </div>
          <div class="stat">
            <div class="stat-value" style="color: var(--ok)">{{ stats.correct }}</div>
            <div class="stat-label">答对</div>
          </div>
          <div class="stat">
            <div class="stat-value" style="color: var(--danger)">{{ stats.wrong }}</div>
            <div class="stat-label">答错</div>
          </div>
          <div class="stat">
            <div class="stat-value">{{ stats.blank }}</div>
            <div class="stat-label">未作答</div>
          </div>
          <div class="stat">
            <div class="stat-value">{{ stats.total > 0 ? Math.round((stats.correct / stats.total) * 100) : 0 }}%</div>
            <div class="stat-label">正确率</div>
          </div>
        </div>
        <div v-if="summary.degraded_notice" class="notice warn" style="margin-top: 14px">
          {{ summary.degraded_notice }}
        </div>

        <div v-if="isTeam" class="stack" style="gap: 8px; margin-top: 18px">
          <div class="row" style="flex-wrap: wrap; gap: 8px">
            <span class="small muted">{{ formatText }}</span>
            <span class="spacer" />
            <span class="tiny muted">满分 {{ me?.max_score ?? 0 }} 分（按队员人数合计）</span>
          </div>
          <div v-if="memberRows.length" class="member-grid">
            <div v-for="member in memberRows" :key="member.id" class="member-row">
              <span>{{ member.name }}</span>
              <span class="spacer" />
              <span class="tiny muted">答 {{ member.answered }} · 对 {{ member.correct }}</span>
              <span class="mono" style="font-weight: 650">{{ member.score }} 分</span>
            </div>
          </div>
        </div>

        <div v-if="teamRows.length" class="stack" style="gap: 8px; margin-top: 16px">
          <div class="row" style="flex-wrap: wrap; gap: 8px">
            <span class="small muted">全部队伍</span>
            <span class="tiny muted">（联机同场时按分数降序，方便教练看全班）</span>
            <span class="spacer" />
          </div>
          <div class="member-grid">
            <div v-for="(team, index) in teamRows" :key="team.id" class="member-row">
              <span class="mono">{{ index + 1 }}.</span>
              <span>{{ team.name }}</span>
              <span class="spacer" />
              <span class="tiny muted">{{ team.members.length }} 人</span>
              <span class="mono" style="font-weight: 650">{{ team.score }} / {{ team.max_score }}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>逐题复盘</h2>
          <span class="spacer" />
          <label class="row small" style="gap: 7px; cursor: pointer">
            <input v-model="onlyWrong" type="checkbox" />
            只看错题
          </label>
        </div>

        <div class="stack" style="gap: 10px">
          <article
            v-for="row in visibleRows"
            :key="row.question.id"
            class="review-item"
            :class="row.correct ? 'right' : 'wrong'"
          >
            <div class="row" style="gap: 8px; flex-wrap: wrap">
              <span class="q-index">第 {{ row.index + 1 }} 题</span>
              <span class="tag">{{ typeLabel[row.question.type] ?? row.question.type }}</span>
              <span class="tag" :class="row.correct ? 'tag-ok' : 'tag-danger'">
                {{ row.correct ? '答对' : row.choice?.length ? '答错' : '未答' }}
              </span>
              <span class="tiny muted mono">{{ row.points > 0 ? `+${row.points}` : row.points }}</span>
              <span class="spacer" />
              <a class="btn btn-sm btn-ghost" :href="feedbackUrl(row.question)" target="_blank" rel="noreferrer">
                报错 / 提 issue
              </a>
            </div>

            <div class="review-stem">{{ row.question.stem }}</div>

            <div class="answer-line">
              <span class="answer-right"><b>正确答案：</b>{{ choiceText(row.question.answer) }}</span>
              <span :class="row.correct ? '' : 'answer-yours'">
                <b>你的选择：</b>{{ choiceText(row.choice) }}
              </span>
            </div>

            <div v-if="row.question.explain" class="explain">{{ row.question.explain }}</div>
            <div v-if="row.question.title" class="tiny muted" style="margin-top: 8px">
              来源：{{ row.question.title }}
            </div>
          </article>
        </div>

        <div v-if="visibleRows.length === 0" class="empty" style="margin-top: 12px">没有错题，全部答对了。</div>
      </section>
    </div>
  </main>
</template>
