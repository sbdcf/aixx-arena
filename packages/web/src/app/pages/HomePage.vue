<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { bankSummary, loadBank, paperMaxScore, paperQuestionCount, type Bank } from '@/data/bank.ts'
import { displayName, listMatches, loadProfile, removeMatch, type LocalMatchRecord } from '@/storage/matchStorage.ts'
import { createLocalMatch } from '@/stores/matchStore.ts'

interface ModeCard {
  format: string
  title: string
  paperId: string
  duration: string
  questions: string
  full: string
  available: boolean
  note: string
}

const router = useRouter()

const bank = ref<Bank | null>(null)
const summary = computed(() => (bank.value ? bankSummary(bank.value) : null))
const history = ref<LocalMatchRecord[]>([])
const profile = ref(loadProfile())
const starting = ref('')
const error = ref('')

const MODE_META: { format: string; title: string; paperId: string; available: boolean; note: string }[] = [
  {
    format: 'solo',
    title: '个人客观题（校赛）',
    paperId: 'paper-school-55',
    available: true,
    note: '55 题 · 60 分钟 · 交卷后统一判分',
  },
  {
    format: 'team-solo',
    title: '团队个人赛',
    paperId: 'paper-team-solo-10',
    available: true,
    note: '10 题 · 5 分钟 · 单人模拟（团队成绩按队汇总）',
  },
  {
    format: 'team-coop',
    title: '团队赛（1 答 2 辅）',
    paperId: 'paper-team-coop-10',
    available: true,
    note: '10 题 · 20 分钟 · 本地同屏演 1 答 2 辅，可换主答',
  },
  {
    format: 'relay',
    title: '接力赛',
    paperId: 'paper-relay-5x3',
    available: true,
    note: '3 棒 × 5 题 · 剩余时间继承（本地单人模拟三棒，联机三人接力）',
  },
  {
    format: 'buzz',
    title: '团队抢答',
    paperId: 'paper-buzz-01',
    available: true,
    note: '10 题 · 前 50% 提交且答对的队伍加分（本地单人模拟一队，联机多队同场抢）',
  },
]

const modes = computed<ModeCard[]>(() => {
  const papers = bank.value?.papers ?? {}
  return MODE_META.map((meta) => {
    const paper = papers[meta.paperId]
    if (!paper) return { ...meta, duration: '—', questions: '—', full: '—' }
    const minutes = Math.round(paper.duration_sec / 60)
    // 接力卷的 duration_sec 是「每棒时长」，不是全局时长
    const duration =
      paper.duration_sec > 0
        ? paper.format === 'relay'
          ? `每棒 ${minutes} 分钟`
          : `${minutes} 分钟`
        : '按题计时'
    return {
      ...meta,
      duration,
      questions: `${paperQuestionCount(paper)} 题`,
      full: `${paperMaxScore(paper)} 分`,
    }
  })
})

const todo = computed(() => history.value.filter((record) => !record.finished))
const done = computed(() => history.value.filter((record) => record.finished))

const nickname = computed(() => displayName(profile.value))

onMounted(async () => {
  history.value = listMatches()
  try {
    bank.value = await loadBank()
  } catch (loadError) {
    error.value = loadError instanceof Error ? loadError.message : String(loadError)
  }
})

async function start(mode: ModeCard): Promise<void> {
  if (!mode.available || starting.value) return
  starting.value = mode.paperId
  error.value = ''
  try {
    const matchId = await createLocalMatch(mode.paperId)
    router.push({ name: 'play', params: { matchId } })
  } catch (startError) {
    error.value = startError instanceof Error ? startError.message : String(startError)
  } finally {
    starting.value = ''
  }
}

function open(record: LocalMatchRecord): void {
  router.push({ name: record.finished ? 'result' : 'play', params: { matchId: record.match_id } })
}

function forget(record: LocalMatchRecord): void {
  removeMatch(record.match_id)
  history.value = listMatches()
}

function formatTime(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
</script>

<template>
  <main class="page">
    <div class="stack" style="gap: 22px">
      <section class="card" style="padding: 26px">
        <div class="row" style="flex-wrap: wrap; align-items: flex-end">
          <div style="flex: 1; min-width: 280px">
            <h1>信息素养 · 训练场</h1>
            <p class="muted" style="margin-top: 8px; max-width: 640px">
              面向「AI + 信息素养」大赛的五种赛制练习：个人客观题、团队个人赛、1 答 2 辅都能在本机直接练（同屏模拟），
              接力与抢答需要临时起一个对局后端把三台设备连起来。
            </p>
            <div class="row" style="margin-top: 14px; flex-wrap: wrap">
              <span class="tag tag-brand">当前：本地模式</span>
              <span class="tag">题库 {{ summary?.total ?? '—' }} 题</span>
              <span class="tag">考点 {{ summary?.topicCount ?? '—' }} 个</span>
              <span class="tag">试卷 {{ summary?.paperCount ?? '—' }} 份</span>
            </div>
          </div>
          <div class="row" style="gap: 8px">
            <RouterLink class="btn btn-ghost" to="/settings">设置称呼</RouterLink>
            <RouterLink class="btn" to="/join">联机大厅</RouterLink>
          </div>
        </div>
      </section>

      <div v-if="error" class="notice danger">{{ error }}</div>

      <section v-if="todo.length" class="card">
        <div class="card-head">
          <h2>继续上次练习</h2>
          <span class="spacer" />
          <span class="tag warn">有 {{ todo.length }} 场没交卷</span>
        </div>
        <div class="stack" style="gap: 10px">
          <div v-for="record in todo" :key="record.match_id" class="row" style="flex-wrap: wrap">
            <div style="flex: 1; min-width: 200px">
              <div style="font-weight: 600">{{ record.paper.name }}</div>
              <div class="tiny muted">
                开始于 {{ formatTime(record.created_at) }} · 停在第 {{ record.cursor + 1 }} 题
              </div>
            </div>
            <button class="btn btn-sm btn-primary" type="button" @click="open(record)">继续</button>
            <button class="btn btn-sm btn-ghost" type="button" @click="forget(record)">丢弃</button>
          </div>
        </div>
      </section>

      <section>
        <div class="row" style="margin-bottom: 12px">
          <h2>选择赛制</h2>
          <span class="spacer" />
          <span class="tiny muted">五种赛制都可离线自练；团队 / 接力 / 抢答多人联机需要后端</span>
        </div>

        <div class="mode-grid">
          <article v-for="mode in modes" :key="mode.format" class="mode-card">
            <div class="row">
              <h3>{{ mode.title }}</h3>
              <span class="spacer" />
              <span class="tag" :class="mode.available ? 'tag-ok' : ''">
                {{ mode.available ? '可练' : '待上线' }}
              </span>
            </div>
            <p class="small muted">{{ mode.note }}</p>
            <div class="mode-meta">
              <span class="tag">{{ mode.questions }}</span>
              <span class="tag">{{ mode.duration }}</span>
              <span class="tag">满分 {{ mode.full }}</span>
            </div>
            <div class="mode-foot">
              <button
                class="btn btn-primary"
                type="button"
                :disabled="!mode.available || starting === mode.paperId"
                @click="start(mode)"
              >
                {{ starting === mode.paperId ? '组卷中…' : mode.available ? '开始练习' : '需要联机后端' }}
              </button>
              <span v-if="!mode.available" class="tiny muted">部署后端后可用</span>
            </div>
          </article>
        </div>
      </section>

      <section v-if="done.length" class="card">
        <div class="card-head">
          <h2>历史成绩</h2>
          <span class="spacer" />
          <span class="tiny muted">只保存在本机浏览器</span>
        </div>
        <div class="stack" style="gap: 10px">
          <div v-for="record in done" :key="record.match_id" class="row" style="flex-wrap: wrap">
            <div style="flex: 1; min-width: 220px">
              <div style="font-weight: 600">{{ record.paper.name }}</div>
              <div class="tiny muted">{{ formatTime(record.created_at) }} 交卷</div>
            </div>
            <div class="mono" style="font-size: 16px; font-weight: 650">
              {{ record.summary?.teams[0]?.score ?? 0 }}
              <span class="small muted">/ {{ record.summary?.teams[0]?.max_score ?? 0 }}</span>
            </div>
            <button class="btn btn-sm" type="button" @click="open(record)">看成绩</button>
            <button class="btn btn-sm btn-ghost" type="button" @click="forget(record)">删除</button>
          </div>
        </div>
      </section>

      <section class="card card-tight">
        <div class="row" style="flex-wrap: wrap; gap: 12px">
          <span class="small muted">当前称呼：<b>{{ nickname }}</b></span>
          <RouterLink class="btn btn-sm btn-ghost" to="/settings">修改</RouterLink>
          <span class="spacer" />
          <span class="tiny muted">
            题库生成于 {{ summary ? new Date(summary.generatedAt).toLocaleString('zh-CN') : '—' }}
          </span>
        </div>
      </section>
    </div>
  </main>
</template>
