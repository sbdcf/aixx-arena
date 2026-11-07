<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  joinTeamByCode,
  leaveRoom,
  newTeam,
  resumeRoomSession,
  room,
  setReady,
  startRoomMatch,
} from '@/stores/matchStore.ts'

const route = useRoute()
const router = useRouter()
const code = computed(() => String(route.params.code ?? ''))
const teamName = ref('')
const teamCode = ref('')
const missing = ref('')

const lobby = computed(() => (room.lobby && room.lobby.room_code === code.value ? room.lobby : null))
const formatLabel = computed(() => {
  switch (lobby.value?.format) {
    case 'team-solo':
      return '团队个人赛（10 题 · 5 分钟 · 各成员各自作答）'
    case 'team-coop':
      return '团队赛（10 题 · 20 分钟 · 1 人主答 2 人辅助）'
    case 'relay':
      return '接力赛（3 棒 × 5 题 · 每棒 5 分钟 · 剩余时间继承）'
    case 'buzz':
      return '团队抢答（10 题 · 多队同场 · 前 50% 提交且答对加分）'
    default:
      return lobby.value?.format ?? ''
  }
})
const isHost = computed(() => Boolean(lobby.value && room.participantId && lobby.value.host_id === room.participantId))
const myTeam = computed(() => lobby.value?.teams.find((team) => team.id === lobby.value?.team_id) ?? null)
const myReady = computed(() => {
  const team = myTeam.value
  if (!team) return false
  return team.members.some((member) => member.id === lobby.value?.viewer_id && member.ready)
})
const totalPeople = computed(() => (lobby.value?.teams ?? []).reduce((sum, team) => sum + team.members.length, 0) + (lobby.value?.waiting.length ?? 0))
const canStart = computed(() => {
  const current = lobby.value
  if (!current) return false
  if (current.format === 'team-coop') {
    return current.teams.length > 0 && current.teams.every((team) => team.members.length === 3)
  }
  return current.teams.length > 0 && current.teams.every((team) => team.members.length >= 1)
})
const startHint = computed(() => {
  const current = lobby.value
  if (!current) return ''
  if (current.teams.length === 0) return '至少需要一支队伍'
  if (current.format === 'team-coop') {
    const bad = current.teams.find((team) => team.members.length !== 3)
    return bad ? `「${bad.name}」还差 ${3 - bad.members.length} 人（1 答 2 辅必须凑满 3 人）` : '可以开始'
  }
  if (current.format === 'relay') {
    const short = current.teams.filter((team) => team.members.length < 3)
    if (short.length > 0) {
      return `接力建议每队 3 人；${short.map((team) => `「${team.name}」${team.members.length} 人`).join('、')}将按人数循环排棒次`
    }
    return '可以开始'
  }
  if (current.format === 'buzz') {
    return current.teams.length < 2 ? '抢答建议至少 2 支队伍（单人也会按 1 个名额开赛）' : '可以开始'
  }
  return '可以开始'
})

onMounted(() => {
  if (lobby.value) return
  const ok = resumeRoomSession(code.value)
  if (!ok) missing.value = '这个房间不在本机记录里：回大厅重新输入房间号，或让房主再发一次房间号。'
})

watch(
  () => lobby.value?.started,
  (started) => {
    if (started) void router.replace({ name: 'play', params: { matchId: code.value } })
  },
)

function copyCode(): void {
  void navigator.clipboard?.writeText(code.value)
}

function createTeam(): void {
  newTeam(teamName.value.trim() || '我的队伍')
  teamName.value = ''
}

function joinTeam(): void {
  if (!/^\d{6}$/.test(teamCode.value.trim())) {
    missing.value = '团队码是 6 位数字'
    return
  }
  joinTeamByCode(teamCode.value)
  teamCode.value = ''
  missing.value = ''
}

function toggleReady(): void {
  setReady(!myReady.value)
}

function start(): void {
  startRoomMatch()
}

function quit(): void {
  leaveRoom()
  void router.push({ name: 'join' })
}
</script>

<template>
  <main class="page">
    <div v-if="!lobby" class="stack" style="gap: 14px">
      <div class="card">
        <h1>房间 {{ code }}</h1>
        <p class="muted" style="margin-top: 8px">{{ missing || '正在连回这个房间…' }}</p>
        <div class="row" style="margin-top: 16px">
          <RouterLink class="btn" to="/join">回联机大厅</RouterLink>
          <RouterLink class="btn btn-ghost" to="/">本地练习</RouterLink>
        </div>
      </div>
    </div>

    <div v-else class="stack" style="gap: 16px">
      <section class="card">
        <div class="row" style="flex-wrap: wrap; gap: 12px">
          <div>
            <div class="tiny muted">房间号</div>
            <div class="room-code">{{ code }}</div>
          </div>
          <div style="margin-left: 16px">
            <div class="tiny muted">赛制</div>
            <div style="font-weight: 600">{{ formatLabel }}</div>
          </div>
          <span class="spacer" />
          <span class="badge" :class="room.connected ? 'ok' : ''">{{ room.connected ? '已连接' : '重连中…' }}</span>
          <button class="btn btn-ghost btn-sm" type="button" @click="copyCode">复制房间号</button>
        </div>
        <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap">
          <span class="badge">{{ lobby.teams.length }} 支队伍</span>
          <span class="badge">{{ totalPeople }} 人</span>
          <span class="badge">{{ lobby.started ? '已开赛' : '等待开始' }}</span>
          <span v-if="isHost" class="badge ok">你是房主</span>
        </div>
        <div v-if="room.detail && !room.connected" class="notice warn" style="margin-top: 12px">{{ room.detail }}</div>
        <div v-if="room.error" class="notice danger" style="margin-top: 12px">{{ room.error }}</div>
      </section>

      <section class="card">
        <div class="card-head"><h2>队伍</h2></div>
        <div class="team-grid">
          <div v-for="team in lobby.teams" :key="team.id" class="team-card" :class="{ mine: team.id === lobby.team_id }">
            <div class="row">
              <b>{{ team.name }}</b>
              <span class="spacer" />
              <span v-if="team.id === lobby.team_id" class="badge ok">我的队</span>
            </div>
            <div v-if="team.code" class="row" style="margin-top: 8px">
              <span class="tiny muted">团队码</span>
              <span class="spacer" />
              <span class="mono strong">{{ team.code }}</span>
            </div>
            <div class="stack" style="gap: 6px; margin-top: 10px">
              <div v-for="member in team.members" :key="member.id" class="row member-line">
                <span class="dot" :class="{ on: member.ready, off: !member.online }" />
                <span>{{ member.name }}</span>
                <span v-if="member.id === team.captain_id" class="tiny muted">队长</span>
                <span class="spacer" />
                <span class="tiny muted">{{ member.online ? (member.ready ? '已准备' : '未准备') : '掉线' }}</span>
              </div>
            </div>
          </div>
          <div v-if="lobby.teams.length === 0" class="team-card empty-card">还没有队伍，先建一支</div>
        </div>
      </section>

      <div class="grid-two">
        <section class="card">
          <div class="card-head"><h2>我的操作</h2></div>
          <div class="stack" style="gap: 12px">
            <div v-if="!myTeam" class="stack" style="gap: 10px">
              <div class="field">
                <label for="team-name">新建队伍</label>
                <div class="row">
                  <input id="team-name" v-model="teamName" class="input" maxlength="16" placeholder="队伍名（你是队长）" />
                  <button class="btn" type="button" @click="createTeam">新建</button>
                </div>
              </div>
              <div class="field">
                <label for="team-code">用团队码入队</label>
                <div class="row">
                  <input id="team-code" v-model="teamCode" class="input mono" maxlength="6" placeholder="6 位数字" />
                  <button class="btn" type="button" @click="joinTeam">加入</button>
                </div>
                <span class="tiny muted">团队码由队长在自己的队伍卡片里看到。</span>
              </div>
            </div>
            <div v-else class="stack" style="gap: 10px">
              <div class="small">你已在「{{ myTeam.name }}」里。准备好了就点下面，等房主开赛。</div>
              <button class="btn" :class="myReady ? '' : 'btn-primary'" type="button" @click="toggleReady">
                {{ myReady ? '取消准备' : '我准备好了' }}
              </button>
            </div>
            <div v-if="missing" class="notice danger">{{ missing }}</div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>开赛</h2></div>
          <div class="stack" style="gap: 10px">
            <div v-if="lobby.started" class="notice ok">已经开赛，正在进入对局…</div>
            <template v-else>
              <div class="small muted">{{ startHint }}</div>
              <button v-if="isHost" class="btn btn-primary" type="button" :disabled="!canStart" @click="start">开始比赛</button>
              <div v-else class="small muted">等房主点开始。房主是 {{ lobby.host_id }}。</div>
            </template>
            <hr class="hr" style="margin: 6px 0" />
            <button class="btn btn-ghost btn-sm" type="button" @click="quit">离开房间</button>
          </div>
        </section>
      </div>

      <section v-if="lobby.waiting.length" class="card card-tight">
        <div class="panel-title">还没分队的同学</div>
        <div class="row" style="flex-wrap: wrap; gap: 8px; margin-top: 8px">
          <span v-for="person in lobby.waiting" :key="person.id" class="badge">{{ person.name }}</span>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.room-code {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 34px;
  font-weight: 700;
  letter-spacing: 6px;
}
.team-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.team-card {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px;
  background: var(--surface);
}
.team-card.mine {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}
.team-card.empty-card {
  color: var(--muted);
  font-size: 14px;
}
.member-line {
  font-size: 14px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  display: inline-block;
}
.dot.on {
  background: #2e9e5b;
}
.dot.off {
  background: #c94b4b;
}
.grid-two {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}
</style>
