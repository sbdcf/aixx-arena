<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { mixedContentRisk, normalizeServerUrl, SERVER_URL } from '@/env.ts'
import { loadProfile, saveProfile } from '@/storage/matchStorage.ts'
import { connectRoom, createRoom, disconnectRoom, joinRoom, room } from '@/stores/matchStore.ts'

const router = useRouter()

const profile = loadProfile()
const nickname = ref(profile.nickname)
const serverInput = ref(SERVER_URL)
const roomCode = ref('')
const busy = ref(false)
const paper = reactive({
  'team-solo': 'paper-team-solo-10',
  'team-coop': 'paper-team-coop-10',
  relay: 'paper-relay-5x3',
  buzz: 'paper-buzz-01',
} as Record<string, string>)

const parsed = computed(() => normalizeServerUrl(serverInput.value))
const origin = computed(() => ('origin' in parsed.value ? parsed.value.origin : ''))
const addressError = computed(() => ('error' in parsed.value ? parsed.value.error : ''))
const risk = computed(() => mixedContentRisk(origin.value))
const canConnect = computed(() => Boolean(origin.value) && !addressError.value)

/** 服务端一旦把人塞进房间，就跳大厅页（房间号在 lobby 里，不靠本地猜） */
watch(
  () => room.lobby?.room_code,
  (code) => {
    if (!code) return
    busy.value = false
    void router.push({ name: 'room', params: { code } })
  },
)

function prepare(): boolean {
  if (!canConnect.value) {
    room.error = addressError.value || '先填一个服务器地址'
    return false
  }
  saveProfile({ ...loadProfile(), nickname: nickname.value.trim() })
  if (!room.connected) {
    connectRoom(origin.value, nickname.value.trim() || '我')
  }
  return true
}

/** 只连不建房：先确认地址对不对、后端通不通 */
function connectOnly(): void {
  prepare()
}

function host(format: 'team-solo' | 'team-coop' | 'relay' | 'buzz'): void {
  if (!prepare()) return
  busy.value = true
  // 连接是异步的：服务器地址刚连上时 create 会排队，连上后按序补发
  setTimeout(() => createRoom(format, paper[format] ?? 'paper-team-solo-10'), 400)
}

function join(): void {
  if (!prepare()) return
  const code = roomCode.value.trim()
  if (!/^\d{6}$/.test(code)) {
    room.error = '房间号是 6 位数字'
    return
  }
  busy.value = true
  setTimeout(() => joinRoom(code), 400)
}

function disconnect(): void {
  disconnectRoom()
}
</script>

<template>
  <main class="page">
    <div class="stack" style="gap: 16px">
      <section class="card">
        <h1>联机大厅</h1>
        <p class="muted" style="margin-top: 8px">
          团队对抗、接力与抢答需要一台对局后端：在教室的一台电脑上跑起来，其他人用手机或电脑连上去。
          后端可以跑在 Windows（双击一个 exe）或 Linux（docker compose up）上，部署方式见仓库 deploy/。
        </p>
        <div class="row" style="margin-top: 12px; gap: 8px; flex-wrap: wrap">
          <span class="badge" :class="room.connected ? 'ok' : ''">{{ room.connected ? '已连接' : '未连接' }}</span>
          <span class="tiny muted">{{ room.detail || '填写服务器地址后连接' }}</span>
        </div>
      </section>

      <section class="card">
        <div class="card-head"><h2>1. 连接后端</h2></div>
        <div class="stack" style="gap: 14px">
          <div class="field">
            <label for="server">服务器地址</label>
            <input id="server" v-model="serverInput" class="input mono" placeholder="http://192.168.1.20:8787" />
            <span class="tiny muted">填 origin（协议 + 主机 + 端口），不带路径；页面本身由后端托管时可以用当前地址。</span>
          </div>
          <div v-if="addressError" class="notice danger">{{ addressError }}</div>
          <div v-else-if="origin" class="notice ok">将连接：<span class="mono">{{ origin }}</span></div>
          <div v-if="risk" class="notice warn">{{ risk }}</div>

          <div class="field">
            <label for="nickname">你的称呼</label>
            <input id="nickname" v-model="nickname" class="input" maxlength="16" placeholder="输入昵称，联机时显示给队友" />
          </div>

          <div class="row">
            <button class="btn" type="button" :disabled="!canConnect || room.connected" @click="connectOnly">
              {{ room.connected ? '已连接' : '连接后端' }}
            </button>
            <span class="tiny muted">只验证地址能不能连上；开房间、进房间时会自动连。</span>
          </div>
        </div>
      </section>

      <div class="grid-two">
        <section class="card">
          <div class="card-head"><h2>2. 开一个房间（房主）</h2></div>
          <p class="small muted">房主负责选赛制、开始比赛、必要时终止全场。开局后房主也在自己的队伍里答题。</p>
          <div class="stack" style="gap: 10px; margin-top: 12px">
            <button class="btn btn-primary" type="button" :disabled="busy || !canConnect" @click="host('team-solo')">
              开团队个人赛房间（10 题 · 5 分钟）
            </button>
            <button class="btn btn-primary" type="button" :disabled="busy || !canConnect" @click="host('team-coop')">
              开团队赛房间（1 答 2 辅 · 10 题 · 20 分钟）
            </button>
            <button class="btn btn-primary" type="button" :disabled="busy || !canConnect" @click="host('relay')">
              开接力赛房间（3 棒 × 5 题 · 每棒 5 分钟）
            </button>
            <button class="btn btn-primary" type="button" :disabled="busy || !canConnect" @click="host('buzz')">
              开抢答赛房间（10 题 · 多队同场抢答）
            </button>
            <span class="tiny muted">开局后把房间号贴在教室屏幕上，队员用房间号进来再分队。</span>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>2'. 加入房间（队员）</h2></div>
          <p class="small muted">输入房主给的 6 位房间号；进房后再用队长给的 6 位团队码入队。</p>
          <div class="stack" style="gap: 10px; margin-top: 12px">
            <div class="field">
              <label for="room">房间号</label>
              <input id="room" v-model="roomCode" class="input mono" maxlength="6" placeholder="6 位数字" />
            </div>
            <button class="btn" type="button" :disabled="busy || !canConnect" @click="join">进入房间</button>
          </div>
        </section>
      </div>

      <div v-if="room.error" class="notice danger">{{ room.error }}</div>
      <div v-if="room.connected" class="row">
        <span class="tiny muted">已连上后端；如果页面卡住，可断开重来。</span>
        <span class="spacer" />
        <button class="btn btn-ghost btn-sm" type="button" @click="disconnect">断开</button>
      </div>

      <section class="card card-tight">
        <div class="panel-title">联机模式下会发生什么</div>
        <div class="stack" style="gap: 8px">
          <div class="small">· 一房多队：一个房间容纳多支队伍，同一套题同时开赛</div>
          <div class="small">· 判分与计时都在服务端：客户端拿不到答案，交卷后才下发解析</div>
          <div class="small">· 断线 30 秒内可连回继续答题，超时按已答内容自动交卷</div>
          <div class="small">· 接力（三人三棒、剩余时间继承）与抢答均已上线；也可先本地单人模拟</div>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.grid-two {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 16px;
}
</style>
