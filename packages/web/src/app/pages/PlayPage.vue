<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CountdownTimer from '@/components/CountdownTimer.vue'
import QuestionCard from '@/components/QuestionCard.vue'
import QuestionPalette from '@/components/QuestionPalette.vue'
import {
  advanceQuestion,
  goTo,
  handoffQuestion,
  legOffset,
  legSize,
  match,
  nextQuestion,
  prevQuestion,
  resumeLocalMatch,
  resumeRoomSession,
  submitAll,
  submitAnswer,
  switchAnswerer,
  toggleFlag,
} from '@/stores/matchStore.ts'

const route = useRoute()
const router = useRouter()

const confirmOpen = ref(false)
const notFound = ref('')

const matchId = computed(() => String(route.params.matchId ?? ''))
const record = computed(() => (match.matchId === matchId.value ? match.record : null))
const questions = computed(() => record.value?.questions ?? [])
const total = computed(() => match.snapshot?.total ?? questions.value.length)
const current = computed(() => questions.value[match.cursor] ?? null)
const selected = computed(() => {
  const qid = current.value?.id
  if (!qid) return []
  return match.snapshot?.own.answers[qid] ?? []
})
const answeredCount = computed(() => Object.values(match.snapshot?.own.answers ?? {}).filter((v) => v.length > 0).length)
const canSubmit = computed(() => match.snapshot?.own.can_submit ?? false)
/** 本人已封卷（team-solo 早交的人要看到「等队友」，而不是以为还能改） */
const ownFinished = computed(() => match.snapshot?.own.finished === true)
const progress = computed(() => (total.value > 0 ? Math.round((answeredCount.value / total.value) * 100) : 0))
const deadlineAt = computed(() => match.snapshot?.clock.deadline_at ?? null)
const reveal = computed(() => {
  const qid = current.value?.id
  return qid ? match.reveal[qid] ?? null : null
})
const flagged = computed(() => {
  const qid = current.value?.id
  return qid ? match.flags.includes(qid) : false
})

/** ===== 团队赛（team-coop）专用视角 ===== */
const format = computed(() => record.value?.paper.format ?? 'solo')
const isCoop = computed(() => format.value === 'team-coop')
/** team-solo 在本地是「单人模拟」，但成绩按团队口径汇总，文案要说清 */
const isTeamSolo = computed(() => format.value === 'team-solo')
/** 联机模式：同一份卷是真的三个人各答各的，不再写「单人模拟」 */
const isOnline = computed(() => match.mode === 'room')
const soloScopeText = computed(() => {
  if (isBuzz.value) return '全队一起抢答（一队一票）'
  if (isCoop.value) return '1 人主答 · 2 人辅助'
  if (isRelay.value) return '三人三棒 · 剩余时间继承'
  if (!isTeamSolo.value) return '本人作答'
  return isOnline.value ? '队内各自作答（按队汇总）' : '单人模拟（团队成绩按队汇总）'
})
/** 交卷语义来自试卷配置：stream = 提交即判分不可改，batch = 可回改、交卷统一判分 */
const submitModeText = computed(() =>
  record.value?.paper.submit_mode === 'stream' ? '提交即判分 · 不可修改' : '交卷后统一判分 · 可回改',
)
/** 底部提示要跟着交卷语义走，不然 stream 卷写「可随时回改」就是骗人 */
const footerHint = computed(() => {
  if (isBuzz.value) return '题面先出、缓冲期禁抢；开抢后点选项即提交，提交即锁定，下一题自动开始'
  if (isCoop.value) return '团队赛题序由主答推进，不能回头'
  if (isRelay.value) return '本棒答完点「下一题」，推过本棒最后一题就交棒'
  return record.value?.paper.submit_mode === 'stream' ? '点选项即提交，判分后不可修改' : '选择即保存，可随时回改'
})
/** 扣分口径也来自试卷：抢答卷把它写在 buzz 里，其余赛制在 scoring 里 */
const penaltyText = computed(() => {
  const paper = record.value?.paper
  if (!paper) return '不扣分'
  // 抢答卷的加减分写在 buzz 里，其余赛制在 scoring 里
  if (paper.format === 'buzz' && paper.buzz) {
    const wrong = paper.buzz.wrong_points ?? 0
    return wrong < 0 ? `答错 ${wrong} 分 · 答对 +${paper.buzz.correct_points}` : '不扣分'
  }
  const penalty = paper.scoring?.wrong_penalty ?? 0
  return penalty > 0 ? `答错 −${penalty} 分` : '不扣分'
})

const isRelay = computed(() => format.value === 'relay')

/** ===== 抢答赛（buzz）专用视角 ===== */
const isBuzz = computed(() => format.value === 'buzz')
const buzzView = computed(() => {
  const snapshot = match.snapshot
  return snapshot && snapshot.format === 'buzz' ? snapshot : null
})
const buzzPhase = computed(() => (isBuzz.value ? (match.snapshot?.phase ?? 'buffer') : ''))
const buzzStatusText = computed(() => {
  switch (buzzPhase.value) {
    case 'buffer':
      return '准备中 · 题面先出，倒计时结束才能抢'
    case 'open':
      return '抢答中 · 提交即锁定'
    case 'reveal':
      return '本题已公布 · 稍后自动进入下一题'
    case 'ended':
      return '本场已结束'
    default:
      return ''
  }
})
/** 抢答的倒计时：缓冲期数到开抢，开抢后数到窗口关闭，公布期数到下一题 */
const buzzDeadlineAt = computed(() => {
  const clock = match.snapshot?.clock
  if (!clock) return null
  if (buzzPhase.value === 'buffer') return clock.deadline_at ?? null
  if (buzzPhase.value === 'open') return clock.submit_deadline_at ?? null
  if (buzzPhase.value === 'reveal') return clock.reveal_end_at ?? null
  return clock.deadline_at ?? null
})
const buzzTimerLabel = computed(() => {
  if (buzzPhase.value === 'buffer') return '开抢倒计时'
  if (buzzPhase.value === 'open') return '抢答剩余'
  if (buzzPhase.value === 'reveal') return '下一题'
  return '剩余时间'
})
/** 实时榜：按分数从高到低，同分保持队伍顺序 */
const buzzScores = computed(() => {
  const scores = match.snapshot?.scores ?? []
  return [...scores].sort((a, b) => b.score - a.score)
})
/** 本队在本题的提交结果（ack 带对错，得分要看公布后的实时榜） */
const buzzAck = computed(() => {
  const qid = current.value?.id
  return qid ? match.acks[qid] ?? null : null
})
const buzzSubmitted = computed(() => {
  const qid = current.value?.id
  if (!qid) return false
  const teams = buzzView.value?.submitted_teams ?? []
  return teams.includes(myTeamId.value)
})
const myTeamId = computed(() => record.value?.roster.teams[0]?.id ?? '')

const coopView = computed(() => {
  const snapshot = match.snapshot
  return snapshot && snapshot.format === 'team-coop' ? snapshot : null
})

/** ===== 接力赛（relay）专用视角 ===== */
const relayView = computed(() => {
  const snapshot = match.snapshot
  return snapshot && snapshot.format === 'relay' ? snapshot : null
})
const legIndex = computed(() => relayView.value?.leg_index ?? 0)
const legStart = computed(() => legOffset(record.value, legIndex.value))
const legLength = computed(() => legSize(record.value, legIndex.value))
const legAnswererId = computed(() => relayView.value?.current_answerer_id ?? '')
const legAnswererName = computed(() => {
  const id = legAnswererId.value
  if (!id) return ''
  const peer = match.snapshot?.peers.find((item) => item.id === id)
  return peer?.name ?? id
})
const nextLegAnswererName = computed(() => {
  const order = relayView.value?.leg_order ?? []
  const id = order[legIndex.value + 1]
  if (!id) return ''
  const peer = match.snapshot?.peers.find((item) => item.id === id)
  return peer?.name ?? id
})
/** 接力看本棒截止；其他赛制看全局截止 */
const activeDeadlineAt = computed(() => (isRelay.value ? (match.snapshot?.clock.leg_deadline_at ?? null) : deadlineAt.value))
/** 本棒内已答几题（答题卡上的进度对接力更有意义的是「本棒」） */
/** 本地接力只有一个人：三棒都由自己打，文案要说明白，别让人以为是别人 */
const relaySoloDrill = computed(() => {
  const order = relayView.value?.leg_order ?? []
  return order.length > 0 && new Set(order).size === 1
})
const legAnsweredCount = computed(() => {
  let count = 0
  for (let index = legStart.value; index < legStart.value + legLength.value; index += 1) {
    const qid = questions.value[index]?.id
    if (qid && (match.snapshot?.own.answers[qid] ?? []).length > 0) count += 1
  }
  return count
})
const answererId = computed(() => coopView.value?.answerer_id ?? '')
const answererName = computed(() => {
  const id = answererId.value
  if (!id) return ''
  const peer = match.snapshot?.peers.find((item) => item.id === id)
  return peer?.name ?? id
})
const teamMembers = computed(() => {
  const team = record.value?.roster.teams[0]
  if (!team) return []
  const names = record.value?.roster.names ?? {}
  return team.member_ids.map((id) => ({ id, name: names[id] ?? id }))
})
const isCaptain = computed(() => {
  const team = record.value?.roster.teams[0]
  return Boolean(team && record.value && team.captain_id === record.value.viewer_id)
})
/** 自己现在不是主答（辅助位）：能看到题，但不能选、不能交。只对多人协作赛制有意义 */
const readOnly = computed(
  () =>
    (isCoop.value || isRelay.value) &&
    Boolean(match.snapshot && !canSubmit.value && match.snapshot.phase !== 'ended'),
)
const atLast = computed(() => total.value > 0 && match.cursor >= total.value - 1)

onMounted(() => {
  if (!match.snapshot || match.matchId !== matchId.value) {
    // 先试联机房间（刷新页面/换设备回到房间），再退回本地断点
    const inRoom = resumeRoomSession(matchId.value)
    if (!inRoom && !resumeLocalMatch(matchId.value)) {
      notFound.value = match.error || '没有找到这场练习'
    }
  }
  if (match.summary) router.replace({ name: 'result', params: { matchId: matchId.value } })
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})

watch(
  () => match.summary,
  (summary) => {
    if (summary) router.replace({ name: 'result', params: { matchId: matchId.value } })
  },
)

function select(choice: string[]): void {
  const qid = current.value?.id
  if (!qid || !canSubmit.value) return
  submitAnswer(qid, choice)
}

function askSubmit(): void {
  if (!canSubmit.value) return
  confirmOpen.value = true
}

function doSubmit(): void {
  confirmOpen.value = false
  submitAll()
}

function goPrev(): void {
  if (isCoop.value) return
  // 接力：只能在本棒范围内回看，交棒之后前一棒的题不再可见
  if (isRelay.value && match.cursor <= legStart.value) return
  prevQuestion()
}

function goNext(): void {
  if (isCoop.value) {
    // 团队赛只有「往前推」：到末题再点就是本队交卷
    if (atLast.value) askSubmit()
    else advanceQuestion()
    return
  }
  if (isRelay.value) {
    // 接力同样由状态机推进：推过本棒末题 ≡ 交棒
    advanceQuestion()
    return
  }
  nextQuestion()
}

/** 本棒提前交棒（下一棒接手剩余时间） */
function doHandoff(): void {
  handoffQuestion()
}

function jumpTo(index: number): void {
  if (isCoop.value) return
  if (isRelay.value && (index < legStart.value || index >= legStart.value + legLength.value)) return
  goTo(index)
}

function changeAnswerer(event: Event): void {
  const target = event.target as HTMLSelectElement
  if (target.value) switchAnswerer(target.value)
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
  if (confirmOpen.value) return
  if (event.key === 'ArrowRight') {
    event.preventDefault()
    goNext()
    return
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    goPrev()
    return
  }
  if (/^[a-h]$/i.test(event.key) && current.value) {
    const key = event.key.toUpperCase()
    const exists = current.value.options.some((option) => option.key === key)
    if (!exists) return
    event.preventDefault()
    if (current.value.type === 'multiple') {
      select(selected.value.includes(key) ? selected.value.filter((item) => item !== key) : [...selected.value, key].sort())
    } else {
      select([key])
    }
  }
}
</script>

<template>
  <main class="page page-wide">
    <div v-if="notFound" class="empty">
      <p>{{ notFound }}</p>
      <RouterLink class="btn" to="/" style="margin-top: 14px">回到首页</RouterLink>
    </div>

    <div v-else-if="!record" class="empty">正在恢复这场练习…</div>

    <div v-else class="stack" style="gap: 14px">
      <div class="card card-tight">
        <div class="row" style="flex-wrap: wrap; gap: 14px">
          <div>
            <div style="font-weight: 650">{{ record.paper.name }}</div>
            <div v-if="isBuzz" class="tiny muted">
              第 {{ match.cursor + 1 }} / {{ total }} 题 · {{ buzzStatusText }}
              <template v-if="buzzView"> · 本题名额 {{ buzzView.quota }} 队 / 开抢时 {{ buzzView.n_at_open }} 队在线</template>
            </div>
            <div v-else-if="isRelay" class="tiny muted">
              第 {{ legIndex + 1 }} / 3 棒 · 本棒 {{ match.cursor - legStart + 1 }} / {{ legLength }} 题 ·
              已答 {{ legAnsweredCount }} / {{ legLength }} · 本棒时间到自动交棒
              <template v-if="relaySoloDrill">（本地练习：三棒都由你一个人打，联机时三人轮换）</template>
            </div>
            <div v-else class="tiny muted">
              已答 {{ answeredCount }} / {{ total }} · 剩余时间归零会自动交卷
            </div>
          </div>
          <span class="spacer" />
          <CountdownTimer
            :deadline-at="isBuzz ? buzzDeadlineAt : activeDeadlineAt"
            :label="isBuzz ? buzzTimerLabel : isRelay ? '本棒剩余' : '剩余时间'"
          />
          <button
            v-if="isRelay && canSubmit && legIndex < 2"
            class="btn"
            type="button"
            @click="doHandoff"
          >
            {{ relaySoloDrill ? '提前交棒' : `交棒给 ${nextLegAnswererName}` }}
          </button>
          <button v-if="!isBuzz" class="btn btn-primary" type="button" :disabled="!canSubmit" @click="askSubmit">
            {{ ownFinished ? '已封卷' : isCoop ? '本队交卷' : isRelay ? '结束本队作答' : '交卷' }}
          </button>
          <span v-else-if="buzzSubmitted" class="pill">{{ buzzAck?.correct ? '已抢答 · 答对' : '已抢答 · 答错' }}</span>
        </div>
        <div class="progress-bar" style="margin-top: 12px">
          <span :style="{ width: `${isBuzz ? ((match.cursor + (buzzPhase === 'reveal' ? 1 : 0)) / Math.max(1, total)) * 100 : progress}%` }" />
        </div>
      </div>

      <div v-if="readOnly && isRelay" class="notice warn">
        现在由 <b>{{ legAnswererName }}</b> 作答（第 {{ legIndex + 1 }} 棒），你在等接棒：可以看题，但不能替这一棒选。
      </div>
      <div v-else-if="readOnly" class="notice warn">
        现在由主答 <b>{{ answererName }}</b> 作答，你是辅助位：可以看题、可以存疑，但不能代替主答选择或交卷。
      </div>
      <div v-if="record.notice" class="notice warn">{{ record.notice }}</div>
      <div v-if="match.notice" class="notice warn">{{ match.notice }}</div>
      <div v-if="match.error" class="notice danger">{{ match.error }}</div>

      <div class="play-grid">
        <aside class="card card-tight play-aside">
          <div class="panel-title">本场信息</div>
          <div class="stack" style="gap: 8px">
            <div class="row"><span class="small muted">题型构成</span><span class="spacer" /><span class="small">{{ total }} 题</span></div>
            <div v-if="isRelay" class="row">
              <span class="small muted">棒次</span><span class="spacer" />
              <span class="small">第 {{ legIndex + 1 }} / 3 棒（{{ legLength }} 题）</span>
            </div>
            <div v-if="isRelay" class="row">
              <span class="small muted">本棒作答</span><span class="spacer" /><span class="small">{{ legAnswererName }}</span>
            </div>
            <div class="row">
              <span class="small muted">作答</span><span class="spacer" />
              <span class="small">{{ soloScopeText }}</span>
            </div>
            <div class="row"><span class="small muted">交卷</span><span class="spacer" /><span class="small">{{ submitModeText }}</span></div>
            <div class="row"><span class="small muted">扣分</span><span class="spacer" /><span class="small">{{ penaltyText }}</span></div>
            <div v-if="isCoop" class="row">
              <span class="small muted">当前主答</span><span class="spacer" /><span class="small">{{ answererName }}</span>
            </div>
          </div>
          <div v-if="isCoop && isCaptain" class="stack" style="gap: 6px; margin-top: 12px">
            <label class="small muted" for="answerer">换主答</label>
            <select id="answerer" class="input" :value="answererId" @change="changeAnswerer">
              <option v-for="member in teamMembers" :key="member.id" :value="member.id">{{ member.name }}</option>
            </select>
            <div v-if="!isOnline" class="tiny muted">本地练习里另两位是虚拟辅助，切过去就能看到「辅助位只读」的样子。</div>
          </div>
          <hr class="hr" style="margin: 12px 0" />
          <div class="tiny muted" style="line-height: 1.7">
            快捷键：<span class="kbd">A</span>–<span class="kbd">H</span> 选项 · <span class="kbd">←</span>
            <span class="kbd">→</span> 切题
          </div>
        </aside>

        <section class="card">
          <QuestionCard
            v-if="current"
            :question="current"
            :index="match.cursor"
            :total="total"
            :selected="selected"
            :disabled="!canSubmit"
            :reveal="reveal"
            :flagged="flagged"
            @select="select"
            @toggle-flag="toggleFlag(current.id)"
          />
          <div v-if="isBuzz" class="q-actions">
            <span class="tiny muted">{{ footerHint }}</span>
          </div>
          <div v-else class="q-actions">
            <button
              class="btn"
              type="button"
              :disabled="isCoop || (isRelay ? match.cursor <= legStart : match.cursor <= 0)"
              @click="goPrev"
            >
              上一题
            </button>
            <button
              class="btn"
              type="button"
              :disabled="!canSubmit || (!isCoop && !isRelay && match.cursor >= total - 1)"
              @click="goNext"
            >
              {{
                isCoop
                  ? atLast
                    ? '结束本队作答'
                    : '下一题'
                  : isRelay
                    ? match.cursor >= legStart + legLength - 1
                      ? '交棒'
                      : '下一题'
                    : '下一题'
              }}
            </button>
            <span class="spacer" />
            <span class="tiny muted">{{ footerHint }}</span>
          </div>
        </section>

        <aside class="card card-tight play-aside">
          <div v-if="isBuzz" class="stack" style="gap: 8px">
            <div class="panel-title">实时榜</div>
            <div v-for="(team, index) in buzzScores" :key="team.team_id" class="row">
              <span class="small muted">{{ index + 1 }}. {{ team.name }}</span>
              <span class="spacer" />
              <b class="small">{{ team.score }}</b>
            </div>
            <div class="tiny muted" style="line-height: 1.6; margin-top: 4px">
              本题名额 {{ buzzView?.quota ?? 0 }} 队：前 ⌈开抢队数 × 50%⌉ 名内答对才加分，答错扣分。
            </div>
          </div>
          <QuestionPalette
            v-else
            :total="total"
            :current="match.cursor"
            :answered="match.snapshot?.own.answers ?? {}"
            :questions="questions"
            :flags="match.flags"
            :interactive="!isCoop && !isBuzz"
            @go="jumpTo"
          />
        </aside>
      </div>
    </div>

    <div v-if="confirmOpen" class="overlay" @click.self="confirmOpen = false">
      <div class="dialog">
        <h3>{{ isCoop ? '确认本队交卷？' : '确认交卷？' }}</h3>
        <p class="small muted">
          已答 {{ answeredCount }} / {{ total }} 题，还有
          <b>{{ total - answeredCount }}</b> 题空着。交卷后不能再改，答案与解析会立即公布。
        </p>
        <div class="dialog-actions">
          <button class="btn" type="button" @click="confirmOpen = false">再检查一下</button>
          <button class="btn btn-primary" type="button" @click="doSubmit">确认交卷</button>
        </div>
      </div>
    </div>
  </main>
</template>
