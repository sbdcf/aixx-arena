import { reactive } from 'vue'
import {
  draw,
  drawRelay,
  type MatchSummary,
  type PaperQuestion,
  type PublicMatchState,
  type ServerMsg,
} from '@aixx/core'
import { LocalDriver } from '@/drivers/localDriver.ts'
import { ServerDriver } from '@/drivers/serverDriver.ts'
import { loadBank } from '@/data/bank.ts'
import {
  displayName,
  loadMatch,
  loadProfile,
  loadRoomSession,
  saveMatch,
  saveRoomResult,
  saveRoomSession,
  type LocalMatchRecord,
} from '@/storage/matchStorage.ts'

/**
 * 当前对局的唯一状态源。
 *
 * 刻意不引 Pinia：这里只有一个全局对局，`reactive()` 单例足够，
 * 少一个依赖就少一处构建与版本风险（design.md §6.3）。
 */
export interface AckInfo {
  accepted: boolean
  locked: boolean
  correct?: boolean
  points?: number
}

export const match = reactive({
  matchId: '',
  /** local = 浏览器里跑状态机；room = 连服务端，本地只收帧 */
  mode: 'local' as 'local' | 'room',
  loading: false,
  error: '',
  /** 服务端给的一句人话提示（封卷等队友、房间人数不够等） */
  notice: '',
  snapshot: null as PublicMatchState | null,
  summary: null as MatchSummary | null,
  acks: {} as Record<string, AckInfo>,
  reveal: {} as Record<string, { answer: string[]; explain?: string }>,
  /** 客户端题号游标：solo 的题序在客户端，不在状态机里 */
  cursor: 0,
  flags: [] as string[],
  record: null as LocalMatchRecord | null,
})

export type Lobby = Extract<ServerMsg, { t: 'lobby' }>

/** 联机侧的状态：连接 + 大厅（页面只读它和 match） */
export const room = reactive({
  serverUrl: '',
  nickname: '',
  participantId: '',
  connected: false,
  detail: '',
  clockOffset: 0,
  lobby: null as Lobby | null,
  paperQuestions: [] as PaperQuestion[],
  error: '',
})

let driver: LocalDriver | null = null
let roomDriver: ServerDriver | null = null
let buildingRoomRecord = false

export function activeDriver(): LocalDriver | null {
  return driver
}

function persist(): void {
  // 联机对局的权威状态在服务端，本机不落 state（只备份 summary 供成绩页刷新后复盘）
  if (match.mode === 'room') return
  const record = match.record
  if (!record) return
  record.state = driver?.stateForSave() ?? null
  record.summary = match.summary
  record.cursor = match.cursor
  record.flags = [...match.flags]
  record.finished = match.summary !== null
  saveMatch(record)
}

/** 服务端时钟 → 本机时钟：快照里的绝对时间统一平移，倒计时组件就不用认识时钟偏移 */
function localizeClock(snapshot: PublicMatchState): PublicMatchState {
  if (match.mode !== 'room' || !room.clockOffset) return snapshot
  const shift = (value: number): number => value - room.clockOffset
  const clock = { ...snapshot.clock }
  clock.started_at = shift(clock.started_at)
  clock.deadline_at = shift(clock.deadline_at)
  if (clock.leg_deadline_at !== undefined) clock.leg_deadline_at = shift(clock.leg_deadline_at)
  if (clock.submit_deadline_at !== undefined) clock.submit_deadline_at = shift(clock.submit_deadline_at)
  if (clock.reveal_end_at !== undefined) clock.reveal_end_at = shift(clock.reveal_end_at)
  return { ...snapshot, clock, server_at: Date.now() }
}

function handleMessage(message: ServerMsg): void {
  switch (message.t) {
    case 'hello_ok':
      room.participantId = message.participant_id
      room.connected = true
      room.detail = '已连接'
      break
    case 'lobby':
      room.lobby = message
      room.error = ''
      if (message.started) void buildRoomRecord()
      break
    case 'paper':
      room.paperQuestions = message.questions
      void buildRoomRecord()
      break
    case 'room':
      match.snapshot = localizeClock(message.snapshot)
      if (message.snapshot.format === 'team-coop') {
        // 团队赛的题序游标在状态机里（团队共享），页面的 cursor 只是它的投影
        match.cursor = message.snapshot.current_index ?? 0
      } else if (message.snapshot.format === 'relay') {
        // 接力的游标 = 前面几棒的题量 + 棒内题号（交棒后自动跳到下一棒第一题）
        const legIndex = message.snapshot.leg_index ?? 0
        const start = legOffset(match.record, legIndex)
        match.cursor = start + (message.snapshot.current_index ?? 0)
      } else if (message.snapshot.format === 'buzz') {
        // 抢答的题序完全由状态机推进（缓冲 / 开抢 / 公布三拍），页面只跟随
        match.cursor = message.snapshot.current_index ?? 0
      } else if (match.cursor >= message.snapshot.total) {
        match.cursor = Math.max(0, message.snapshot.total - 1)
      }
      persist()
      break
    case 'ack':
      match.acks[message.qid] = {
        accepted: message.accepted,
        locked: message.locked,
        correct: message.correct,
        points: message.points,
      }
      break
    case 'reveal':
      for (const item of message.items) {
        match.reveal[item.qid] = { answer: [...item.answer], explain: item.explain }
      }
      persist()
      // 联机模式下 reveal 是成绩页「正确答案 / 解析」的唯一来源，每来一条就更新备份
      if (match.mode === 'room') saveRoomResultNow()
      break
    case 'ended':
      match.summary = message.summary
      if (match.mode === 'room') saveRoomResultNow()
      persist()
      break
    case 'notice':
      // 封卷等人、组队提示一类「不报错但要说一声」的服务端通知
      match.notice = message.text
      break
    case 'error':
      if (match.mode === 'room') room.error = message.message
      else match.error = message.message
      break
    default:
      break
  }
}

/**
 * 联机成绩的本地备份。服务端不存历史，成绩页刷新/换设备就靠它；
 * reveal（正确答案 + 解析）单独带一份，因为服务端下发的题面里没有答案。
 */
function saveRoomResultNow(): void {
  const record = match.record
  // ended 一定先于 reveal 到达（core 先广播 ended 再逐人发 reveal），所以没有 summary 就先不写
  if (!record || !match.summary) return
  const viewerId = record.viewer_id
  const team = record.roster.teams.find((item) => item.member_ids.includes(viewerId))
  saveRoomResult(record.match_id, {
    summary: match.summary,
    questions: record.questions,
    paper_name: record.paper.name,
    team_id: team?.id,
    reveal: { ...match.reveal },
  })
}

/**
 * 联机开局时把「大厅 + 整卷题面」拼成与本地记录同形的对象，
 * 这样对局页 / 成绩页不用写 `if (mode === 'room')`（design.md §6.2 的不变式）。
 */
async function buildRoomRecord(): Promise<void> {
  const lobby = room.lobby
  if (!lobby || lobby.started === false || room.paperQuestions.length === 0) return
  if (match.record && match.matchId === lobby.room_code && match.mode === 'room') return
  if (buildingRoomRecord) return
  buildingRoomRecord = true
  try {
    const bank = await loadBank().catch(() => null)
    const paperMeta = bank?.papers?.[lobby.paper_id]
    const names: Record<string, string> = {}
    const teams = lobby.teams.map((team) => {
      for (const member of team.members) names[member.id] = member.name
      return {
        id: team.id,
        name: team.name,
        captain_id: team.captain_id,
        member_ids: team.members.map((member) => member.id),
      }
    })
    const record: LocalMatchRecord = {
      version: 1,
      match_id: lobby.room_code,
      paper: {
        ...(paperMeta ?? {}),
        id: lobby.paper_id,
        name: paperMeta?.name ?? lobby.paper_id,
        format: lobby.format,
      } as LocalMatchRecord['paper'],
      questions: room.paperQuestions as unknown as LocalMatchRecord['questions'],
      roster: { teams, names },
      viewer_id: lobby.viewer_id,
      nickname: room.nickname,
      state: null,
      summary: null,
      created_at: Date.now(),
      saved_at: Date.now(),
      cursor: 0,
      flags: [],
      finished: false,
    }
    match.mode = 'room'
    match.record = record
    match.matchId = lobby.room_code
    match.error = ''
    match.cursor = 0
    saveRoomSession({
      server_url: room.serverUrl,
      nickname: room.nickname,
      room_code: lobby.room_code,
      participant_id: room.participantId,
    })
  } finally {
    buildingRoomRecord = false
  }
}

/* ==================================================================== 联机大厅 */

export const roomState = room

export function connectRoom(serverUrl: string, nickname: string): void {
  roomDriver?.dispose()
  room.serverUrl = serverUrl
  room.nickname = nickname
  room.lobby = null
  room.paperQuestions = []
  room.error = ''
  roomDriver = new ServerDriver({
    serverUrl,
    name: nickname,
    onMessage: handleMessage,
    onStatus: (status) => {
      room.connected = status.connected
      room.detail = status.detail
      room.clockOffset = status.clockOffset
    },
  })
  roomDriver.connect()
}

export function disconnectRoom(): void {
  roomDriver?.dispose()
  roomDriver = null
  room.lobby = null
  room.connected = false
  room.detail = '已断开'
}

export function createRoom(format: string, paperId: string): void {
  roomDriver?.createRoom(format, paperId)
}

export function joinRoom(roomCode: string): void {
  roomDriver?.joinRoom(roomCode.trim())
}

export function newTeam(name: string): void {
  roomDriver?.newTeam(name)
}

export function joinTeamByCode(teamCode: string): void {
  roomDriver?.joinTeam(teamCode.trim())
}

export function setReady(value: boolean): void {
  roomDriver?.setReady(value)
}

/** relay：队长在开局前调整本队棒次（服务端校验必须是队员全排列） */
export function setLegOrder(order: string[]): void {
  roomDriver?.setLegOrder(order)
}

export function startRoomMatch(): void {
  roomDriver?.startMatch()
}

export function leaveRoom(): void {
  roomDriver?.leave()
  disconnectRoom()
  match.mode = 'local'
  match.record = null
  match.snapshot = null
  match.error = ''
}

/** 刷新页面 / 换了路由后回到房间：靠 sessionStorage 里的房间号 + 服务端 30s 宽限 */
export function resumeRoomSession(matchIdValue: string): boolean {
  const session = loadRoomSession()
  if (!session || session.room_code !== matchIdValue) return false
  connectRoom(session.server_url, session.nickname)
  // 连接建立后 hello 会带 resume_id，服务端据此把人塞回原位置
  setTimeout(() => joinRoom(matchIdValue), 300)
  return true
}

function attach(record: LocalMatchRecord): void {
  match.mode = 'local'
  roomDriver?.dispose()
  roomDriver = null
  if (driver) {
    driver.dispose()
    driver = null
  }
  match.record = record
  match.matchId = record.match_id
  match.error = ''
  match.snapshot = null
  match.acks = {}
  match.reveal = {}
  match.cursor = record.cursor
  match.flags = [...record.flags]
  match.summary = record.summary

  // 已结束的对局不需要再起驱动：复盘完全靠 summary
  if (record.finished && record.summary) {
    for (const item of record.summary.questions) {
      if (item.answer?.length) match.reveal[item.qid] = { answer: item.answer, explain: item.explain }
    }
    return
  }

  driver = new LocalDriver({
    matchId: record.match_id,
    viewerId: record.viewer_id,
    ctx: {
      paper: record.paper,
      questions: record.questions,
      roster: record.roster,
      degraded_notice: record.notice,
    },
    state: record.state,
  })
  driver.on(handleMessage)
  driver.start()
}

/**
 * 静态练习的名册。
 *
 * - solo / team-solo：一队一人 —— 练习者自己就是「本人」，团队赛的个人对抗在本地只能模拟成
 *   单人作答（官方赛制里同队三人各自打同一份卷，本地没有第二台设备可模拟）；
 * - team-coop：一队三人 —— 自己是队长兼主答，另两位是虚拟辅助。换主答时 UI 会进入
 *   「辅助位只读」状态，正好用来演示 1 答 2 辅的分工。
 */
function buildRoster(format: string, viewerId: string, nickname: string): LocalMatchRecord['roster'] {
  if (format === 'team-coop') {
    const auxA = `${viewerId}-aux-a`
    const auxB = `${viewerId}-aux-b`
    return {
      teams: [{ id: 'local-team', name: '本地练习队', member_ids: [viewerId, auxA, auxB], captain_id: viewerId }],
      names: { [viewerId]: nickname, [auxA]: '辅助甲', [auxB]: '辅助乙' },
    }
  }
  return {
    teams: [{ id: 'local-team', name: nickname, member_ids: [viewerId], captain_id: viewerId }],
    names: { [viewerId]: nickname },
  }
}

/** relay：前面几棒的题量之和（题量按 paper.legs 的题型数算，缺 legs 时按均分兜底） */
export function legOffset(record: LocalMatchRecord | null, legIndex: number): number {
  const legs = record?.paper.legs
  if (!legs) return legIndex * Math.max(1, Math.round((record?.questions.length ?? 0) / 3))
  let offset = 0
  for (let index = 0; index < Math.min(legIndex, legs.length); index += 1) {
    offset += (legs[index].single ?? 0) + (legs[index].multiple ?? 0) + (legs[index].judge ?? 0)
  }
  return offset
}

/** relay：第 legIndex 棒的题量 */
export function legSize(record: LocalMatchRecord | null, legIndex: number): number {
  const legs = record?.paper.legs
  if (!legs) return Math.max(1, Math.round((record?.questions.length ?? 0) / 3))
  const leg = legs[legIndex]
  if (!leg) return 0
  return (leg.single ?? 0) + (leg.multiple ?? 0) + (leg.judge ?? 0)
}

/** 接力交棒（HANDOFF）；本棒选手提前把人交出去 */
export function handoffQuestion(): void {
  if (match.mode === 'room') roomDriver?.handoff()
  else driver?.handoff?.()
}

/** 开一局新的静态练习（solo / team-solo / team-coop / relay）。返回 matchId 供路由跳转。 */
export async function createLocalMatch(paperId: string): Promise<string> {
  match.loading = true
  match.error = ''
  try {
    const bank = await loadBank()
    const paper = bank.papers[paperId]
    if (!paper) throw new Error(`没有这张试卷：${paperId}`)

    let questions: LocalMatchRecord['questions']
    let notice: string | undefined
    if (paper.legs) {
      // 接力卷没有顶层 draw：三段分别组卷，展开成顺序卷（状态机内部再按 legs 切分）
      const relayed = drawRelay(bank.questions, paper)
      questions = relayed.legs.flat()
      notice = relayed.notices.length > 0 ? relayed.notices.join('；') : undefined
    } else if (paper.draw) {
      const seed = paper.draw.seed ?? Math.floor(Math.random() * 2 ** 31)
      const drawn = draw(bank.questions, paper.draw, seed)
      questions = drawn.questions
      notice = drawn.notice
    } else {
      throw new Error('这份试卷没有可用的组卷参数，暂不支持在此开练')
    }

    const profile = loadProfile()
    const viewerId = `local-${Math.random().toString(36).slice(2, 10)}`
    const nickname = displayName(profile)
    const record: LocalMatchRecord = {
      version: 1,
      match_id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      paper,
      questions,
      roster: buildRoster(paper.format, viewerId, nickname),
      viewer_id: viewerId,
      nickname,
      notice,
      state: null,
      summary: null,
      created_at: Date.now(),
      saved_at: Date.now(),
      cursor: 0,
      flags: [],
      finished: false,
    }

    attach(record)
    // attach 里已经 init 了驱动，这里补一次持久化把 state 落盘
    persist()
    saveMatch(record)
    return record.match_id
  } finally {
    match.loading = false
  }
}

/** 断点恢复 */
export function resumeLocalMatch(matchId: string): boolean {
  const record = loadMatch(matchId)
  if (!record) {
    match.error = '本地没有找到这场练习的记录（可能换了浏览器或清了缓存）'
    return false
  }
  attach(record)
  return true
}

/** 只读打开（成绩页、复盘） */
export function openLocalMatch(matchId: string): LocalMatchRecord | null {
  return loadMatch(matchId)
}

export function submitAnswer(qid: string, choice: string[]): void {
  if (match.mode === 'room') roomDriver?.submit(qid, choice)
  else driver?.submit(qid, choice)
}

export function goTo(index: number): void {
  const total = match.snapshot?.total ?? match.record?.questions.length ?? 0
  if (total <= 0) return
  match.cursor = Math.min(Math.max(0, index), total - 1)
  persist()
}

export function nextQuestion(): void {
  goTo(match.cursor + 1)
}

export function prevQuestion(): void {
  goTo(match.cursor - 1)
}

export function toggleFlag(qid: string): void {
  const at = match.flags.indexOf(qid)
  if (at >= 0) match.flags.splice(at, 1)
  else match.flags.push(qid)
  persist()
}

export function submitAll(): void {
  if (match.mode === 'room') roomDriver?.submitAll()
  else driver?.submitAll()
}

/** 团队赛推进题序：游标在状态机里，这里不能自己改 match.cursor（等 room 快照回填） */
export function advanceQuestion(): void {
  if (match.mode === 'room') roomDriver?.advance()
  else driver?.advance?.()
}

/** 换主答（本地演示 / 联机时由队长操作） */
export function switchAnswerer(memberId: string): void {
  if (match.mode === 'room') roomDriver?.setAnswerer(memberId)
  else driver?.setAnswerer?.(memberId)
}

