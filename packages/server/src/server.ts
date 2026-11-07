/**
 * 权威服务器：房间注册表 + 参与者注册表 + 协议路由。
 *
 * 架构约束（docs/design.md §7）：
 * - 单进程、单端口：HTTP 静态托管与 WebSocket 共用一个 http.Server；
 * - 判分/超时/状态迁移全部在服务端（core 的 reduce），客户端只能提交 qid/choice/seq；
 * - 每个参与者收到的 `room` 都是 `view(state, 自己, now)` 的个性化快照；
 * - `answer` / `explain` 只从 `reveal` 与 `ended.summary` 出去，server 不拼答案字段。
 */

import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { WebSocketServer } from 'ws'

import type {
  ClientMsg,
  DrawResult,
  FormatId,
  LogEntry,
  MatchState,
  Paper,
  ServerMsg,
} from './core.ts'
import { PROTOCOL_VERSION, drawPaper, initMatch, summarize } from './core.ts'
import type { Bank } from './data.ts'
import { DEFAULT_DATA_ROOT, DEFAULT_WEB_ROOT, loadBank } from './data.ts'
import type { DriverHooks } from './driver.ts'
import { MatchDriver } from './driver.ts'
import { createRequestHandler } from './http.ts'
import { Room, RoomError, isSupportedFormat, uniqueCode } from './rooms.ts'
import { Session } from './session.ts'
import type { SessionHooks } from './session.ts'

export const SERVER_VERSION = '0.1.1'

/** 断线后允许 resume 的宽限（任务契约：30s）。 */
const RECONNECT_GRACE_MS = 30_000
/** 心跳/同步周期。 */
const HEARTBEAT_INTERVAL_MS = 30_000
const SYNC_INTERVAL_MS = 30_000
const HELLO_TIMEOUT_MS = 10_000

export interface ServerOptions {
  port?: number
  host?: string
  webRoot?: string
  dataRoot?: string
  allowOrigin?: string
  maxRooms?: number
  /** 测试注入：绕过磁盘读取（临时试卷/小题库用）。 */
  bank?: Bank
  reconnectGraceMs?: number
  helloTimeoutMs?: number
}

export interface Participant {
  id: string
  name: string
  session: Session | null
  roomCode: string | null
  offlineTimer: NodeJS.Timeout | null
  last_seen: number
}

export interface ArenaServer {
  port: number
  host: string
  url: string
  http: HttpServer
  bank: Bank
  rooms: Map<string, Room>
  participants: Map<string, Participant>
  close: () => Promise<void>
}

function sanitizeName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : ''
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 16)
  return cleaned || '玩家'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function teamIdOfState(state: MatchState, participantId: string): string | undefined {
  for (const team of state.roster.teams) {
    if (team.member_ids.includes(participantId)) return team.id
  }
  return undefined
}

export async function startServer(options: ServerOptions = {}): Promise<ArenaServer> {
  const bank = options.bank ?? (await loadBank(options.dataRoot ?? DEFAULT_DATA_ROOT))
  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT
  const maxRooms = options.maxRooms ?? 100
  const graceMs = options.reconnectGraceMs ?? RECONNECT_GRACE_MS

  const rooms = new Map<string, Room>()
  const participants = new Map<string, Participant>()
  const sessions = new Set<Session>()
  const startedAt = Date.now()

  const roomOf = (participant: Participant): Room | undefined =>
    participant.roomCode ? rooms.get(participant.roomCode) : undefined

  const countOnline = (): number => {
    let count = 0
    for (const participant of participants.values()) if (participant.session) count += 1
    return count
  }

  function sendTo(participantId: string, message: ServerMsg): void {
    participants.get(participantId)?.session?.send(message)
  }

  function newParticipantId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = `p-${randomUUID().slice(0, 12)}`
      if (!participants.has(id)) return id
    }
    throw new Error('无法生成 participant id')
  }

  // ---------------------------------------------------------------- 大厅广播

  function broadcastLobby(room: Room): void {
    for (const member of room.members.values()) {
      if (!member.online) continue
      sendTo(member.id, room.lobbyFor(member.id))
    }
  }

  function roomLog(room: Room, entry: Omit<LogEntry, 'at'> & { at?: number }): void {
    room.log({ at: entry.at ?? Date.now(), ...entry })
  }

  // ------------------------------------------------------------ 断线 / 代交卷

  /**
   * 断线 / 离场后的「代交卷」。
   *
   * design §9.5：断线超宽限由服务端代交，已答内容照算。core 的 FINISH 事件就是
   * 「本人封卷」：封卷后不能再改，未作答题按不答分计；team-solo 全员封卷才结算，
   * solo 封卷立即结算。这里不伪造 SUBMIT —— 空 choice 在 stream 模式下会被判扣分。
   */
  function autoSubmitAll(participantId: string, room: Room, reason: string): void {
    const driver = room.driver
    if (!driver || driver.ended) return
    // 目前开放的赛制只有 team-solo / team-coop；写成 string 是为了 relay/buzz 上线后
    // 这里还能按 format 分支，而不用改类型（Room.format 是窄联合）。
    const format: string = room.format
    const isPlayer = driver.ctx.roster.teams.some((team) => team.member_ids.includes(participantId))
    if (isPlayer && (format === 'solo' || format === 'team-solo')) {
      driver.handle({ type: 'FINISH', at: Date.now(), actor_id: participantId })
      roomLog(room, { event: 'submit_all', participant_id: participantId, data: { reason, via: 'finish' } })
      return
    }
    roomLog(room, {
      event: 'submit_all_skipped',
      participant_id: participantId,
      data: { reason, because: isPlayer ? 'format_has_no_finish' : 'not_a_player' },
    })
  }

  function clearGrace(participant: Participant): void {
    if (participant.offlineTimer) {
      clearTimeout(participant.offlineTimer)
      participant.offlineTimer = null
    }
  }

  /**
   * 掉线后的清理：
   * - 大厅中：从房间/队伍移除，房主转移；
   * - 对局中：服务端代交卷、保留 roster（分数含该玩家），全部离线则结束对局。
   */
  function finalizeDisconnect(participant: Participant): void {
    if (participant.session) return
    const room = roomOf(participant)
    const at = Date.now()
    clearGrace(participant)

    if (room) {
      if (room.started && !room.driver?.ended) {
        autoSubmitAll(participant.id, room, 'disconnect')
        roomLog(room, { at, event: 'disconnect_timeout', participant_id: participant.id })
        room.setOnline(participant.id, false)
        room.driver?.broadcastRoom()
        if (room.onlineCount === 0) {
          roomLog(room, { at, event: 'all_offline', participant_id: participant.id })
          try {
            room.driver?.handle({ type: 'END', at, reason: 'all_done' })
          } catch {
            // 结束失败不影响清理
          }
        }
      } else {
        const wasHost = room.host_id === participant.id
        room.removeMember(participant.id)
        roomLog(room, { at, event: 'member_left', participant_id: participant.id, data: { reason: 'timeout' } })
        if (wasHost && room.size > 0) {
          roomLog(room, { at, event: 'host_transfer', participant_id: room.host_id })
        }
        if (room.size === 0) {
          room.driver?.dispose()
          rooms.delete(room.code)
        } else {
          broadcastLobby(room)
        }
      }
    }

    participant.roomCode = null
    participant.session = null
    participants.delete(participant.id)
  }

  function scheduleGrace(participant: Participant): void {
    clearGrace(participant)
    participant.offlineTimer = setTimeout(() => {
      participant.offlineTimer = null
      finalizeDisconnect(participant)
    }, graceMs)
    participant.offlineTimer.unref?.()
  }

  // -------------------------------------------------------------- 连接附着

  function driverHooks(room: Room): DriverHooks {
    return {
      sendTo: (participantId, message) => sendTo(participantId, message),
      onlineIds: () =>
        [...room.members.values()]
          .filter((member) => member.online && Boolean(participants.get(member.id)?.session))
          .map((member) => member.id),
      onlineOf: (participantId) => {
        const member = room.members.get(participantId)
        return Boolean(member?.online && participants.get(participantId)?.session)
      },
      log: (entry) => room.log(entry),
      onEnded: () => {
        if (!room.ended) {
          room.ended = true
          room.ended_at = Date.now()
          roomLog(room, { event: 'match_ended' })
        }
        room.driver?.dispose()
      },
    }
  }

  function attachSession(session: Session, participant: Participant): void {
    const previous = participant.session
    // 先改指向再踢旧连接：旧连接的 close 回调会看到 session 已换人而直接返回。
    clearGrace(participant)
    participant.session = session
    participant.last_seen = Date.now()
    session.participantId = participant.id
    session.name = participant.name
    session.roomCode = participant.roomCode
    if (previous && previous !== session) previous.kick('resumed')

    const room = roomOf(participant)
    if (room) {
      const member = room.members.get(participant.id)
      if (member) {
        member.online = true
        member.name = participant.name
      } else if (!room.started) {
        // 房间被解散过（理论上不会发生），清掉悬空 roomCode
        participant.roomCode = null
        session.roomCode = null
      }
    }
  }

  function sendSnapshots(session: Session, participant: Participant, room: Room | undefined): void {
    if (!room) return
    session.send(room.lobbyFor(participant.id))
    if (room.started && room.driver) {
      session.send({ t: 'paper', questions: room.questions })
      room.driver.broadcastRoom()
      if (room.driver.ended) session.send({ t: 'ended', summary: summarize(room.driver.state, room.driver.ctx) })
    }
  }

  // ---------------------------------------------------------------- 房间操作

  /** 组卷：relay 走分棒（三段），其余赛制走单卷组卷。 */
  function drawQuestions(paper: Paper): DrawResult {
    const drawn = drawPaper(bank.questions, paper)
    if ('questions' in drawn) return drawn
    // relay：drawPaper 返回三段，展开成顺序卷（core 的 relay 状态机会按 legs 再切一刀）
    const questions = drawn.legs.flat()
    if (questions.length === 0) throw new RoomError('BAD_MESSAGE', '该赛制暂未开放联机')
    return {
      questions,
      degraded: drawn.degraded,
      available_count: questions.length,
      requested_count: questions.length,
      ...(drawn.notices.length > 0 ? { notice: drawn.notices.join('；') } : {}),
    }
  }

  function createRoom(participant: Participant, format: string, paperId: string): Room {
    if (!isSupportedFormat(format)) throw new RoomError('BAD_MESSAGE', '该赛制暂未开放联机')
    if (rooms.size >= maxRooms) throw new RoomError('ROOM_FULL', `房间数已达上限（${maxRooms}）`)

    const paper: Paper | undefined = bank.papers.get(String(paperId))
    if (!paper) throw new RoomError('BAD_MESSAGE', `试卷不存在: ${String(paperId)}`)
    if (paper.format !== format) {
      throw new RoomError('BAD_MESSAGE', `试卷 ${paper.id} 的赛制是 ${paper.format}，与请求的 ${format} 不一致`)
    }

    // 先试组卷：题池不够/低于最低可用时立刻在 create 阶段失败，而不是开局才炸。
    let drawn: DrawResult
    try {
      drawn = drawQuestions(paper)
    } catch (error) {
      if (error instanceof RoomError) throw error
      throw new RoomError('BAD_MESSAGE', `组卷失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (drawn.questions.length === 0) throw new RoomError('BAD_MESSAGE', '试卷没有可用题目')

    const code = uniqueCode((candidate) => rooms.has(candidate))
    const room = new Room({ code, format, paper }, participant.id)
    room.addMember(participant.id, participant.name, Date.now())
    room.questions = room.toPaperQuestions(drawn.questions)
    roomLog(room, {
      event: 'room_created',
      participant_id: participant.id,
      data: { format, paper_id: paper.id, questions: room.questions.length, degraded: drawn.degraded },
    })
    if (drawn.degraded && drawn.notice) {
      roomLog(room, { event: 'degraded', participant_id: participant.id, data: { notice: drawn.notice } })
    }
    rooms.set(code, room)
    participant.roomCode = code
    return room
  }

  function checkStart(room: Room): void {
    if (room.started) throw new RoomError('BAD_MESSAGE', '房间已经开局')
    if (room.host_id === '' || !room.members.has(room.host_id)) throw new RoomError('NOT_AUTHORIZED', '房主不在房间内')

    const teams = room.teams.filter((team) => team.member_ids.length > 0)
    if (teams.length === 0) throw new RoomError('BAD_MESSAGE', '至少需要一支队伍才能开局')

    const waiting = [...room.members.values()].filter((member) => !room.teamOf(member.id))
    if (waiting.length > 0) {
      const names = waiting.map((member) => member.name).join('、')
      throw new RoomError('BAD_MESSAGE', `还有 ${waiting.length} 名玩家未分队（${names}），请先分队或让其离开`)
    }

    if (room.format === 'team-coop') {
      for (const team of teams) {
        if (team.member_ids.length !== 3) {
          throw new RoomError(
            'BAD_MESSAGE',
            `team-coop 需要每队满 3 人才能开局（队伍「${team.name}」当前 ${team.member_ids.length} 人）`,
          )
        }
      }
    }
  }

  function startMatch(room: Room): void {
    checkStart(room)
    const paper = room.paper
    let drawn: DrawResult
    try {
      drawn = drawQuestions(paper)
    } catch (error) {
      if (error instanceof RoomError) throw error
      throw new RoomError('BAD_MESSAGE', `组卷失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const at = Date.now()
    room.questions = room.toPaperQuestions(drawn.questions)
    const ctx = {
      paper,
      questions: drawn.questions,
      roster: room.roster(),
      ...(drawn.degraded && drawn.notice ? { degraded_notice: drawn.notice } : {}),
    }
    const state = initMatch(ctx, at)
    room.driver = new MatchDriver(ctx, state, driverHooks(room))
    room.started = true
    room.started_at = at
    roomLog(room, {
      event: 'match_started',
      participant_id: room.host_id,
      data: { questions: drawn.questions.length, teams: ctx.roster.teams.length },
    })

    for (const member of room.members.values()) {
      if (!member.online) continue
      if (!ctx.roster.teams.some((team) => team.member_ids.includes(member.id))) continue
      sendTo(member.id, { t: 'paper', questions: room.questions })
    }
    broadcastLobby(room)
    room.driver.start()
  }

  function dissolveRoom(room: Room, message: string): void {
    for (const member of room.members.values()) {
      if (member.online) sendTo(member.id, { t: 'error', code: 'ROOM_NOT_FOUND', message })
    }
    room.driver?.dispose()
    for (const member of room.members.values()) {
      const participant = participants.get(member.id)
      if (participant && participant.roomCode === room.code) {
        participant.roomCode = null
        if (participant.session) participant.session.roomCode = null
      }
    }
    room.members.clear()
    rooms.delete(room.code)
  }

  /** 主动离开：大厅中直接移除；对局中等同掉线（代交卷 + 保留分数）。 */
  function leaveRoom(participant: Participant, notify: boolean): void {
    const room = roomOf(participant)
    const at = Date.now()
    participant.roomCode = null
    if (participant.session) participant.session.roomCode = null
    if (!room) return

    if (room.started && !room.driver?.ended) {
      autoSubmitAll(participant.id, room, 'leave')
      room.setOnline(participant.id, false)
      roomLog(room, { at, event: 'leave', participant_id: participant.id })
      room.driver?.broadcastRoom()
      if (room.onlineCount === 0) {
        try {
          room.driver?.handle({ type: 'END', at, reason: 'all_done' })
        } catch {
          // 忽略
        }
      }
      return
    }

    const wasHost = room.host_id === participant.id
    room.removeMember(participant.id)
    roomLog(room, { at, event: 'member_left', participant_id: participant.id, data: { reason: 'leave' } })
    if (room.size === 0) {
      room.driver?.dispose()
      rooms.delete(room.code)
      return
    }
    if (wasHost) roomLog(room, { at, event: 'host_transfer', participant_id: room.host_id })
    if (notify) {
      sendTo(participant.id, { t: 'sync', server_at: Date.now() })
      if (!room.started) broadcastLobby(room)
    }
  }

  // -------------------------------------------------------------- 消息处理

  const sessionHooks: SessionHooks = {
    onMessage: (session, message) => {
      try {
        handleMessage(session, message)
      } catch (error) {
        if (error instanceof RoomError) {
          session.sendError(error.code, error.message)
          return
        }
        const room = session.participantId ? roomOf(participants.get(session.participantId) as Participant) : undefined
        if (room) roomLog(room, { event: 'internal_error', participant_id: session.participantId ?? undefined, data: { message: String(error) } })
        session.sendError('INTERNAL', '服务器内部错误')
      }
    },
    onClose: (session) => {
      sessions.delete(session)
      const participantId = session.participantId
      if (!participantId) return
      const participant = participants.get(participantId)
      if (!participant || participant.session !== session) return // 已被新连接接管
      participant.session = null
      participant.last_seen = Date.now()
      const room = roomOf(participant)
      if (room) {
        room.setOnline(participant.id, false)
        if (!room.started) broadcastLobby(room)
        room.driver?.broadcastRoom()
      }
      scheduleGrace(participant)
    },
  }

  function handleHello(session: Session, message: ClientMsg & { t: 'hello' }): void {
    if (session.handshaken) {
      session.sendError('NOT_AUTHORIZED', '重复握手')
      return
    }
    if (message.v !== PROTOCOL_VERSION) {
      session.sendError(
        'VERSION_MISMATCH',
        `协议版本不匹配：服务端 v${PROTOCOL_VERSION}，客户端 v${String(message.v)}`,
        true,
      )
      session.close(4003, 'version mismatch')
      return
    }

    const name = sanitizeName(message.name)
    const resumeId = typeof message.resume_id === 'string' ? message.resume_id : ''
    let participant = resumeId ? participants.get(resumeId) : undefined

    if (participant) {
      participant.name = name
    } else {
      participant = {
        id: newParticipantId(),
        name,
        session: null,
        roomCode: null,
        offlineTimer: null,
        last_seen: Date.now(),
      }
      participants.set(participant.id, participant)
    }

    session.markHelloDone()
    attachSession(session, participant)
    session.send({
      t: 'hello_ok',
      participant_id: participant.id,
      server_at: Date.now(),
      version: SERVER_VERSION,
      protocol: PROTOCOL_VERSION,
    })

    const room = roomOf(participant)
    if (room) {
      const member = room.members.get(participant.id)
      if (member) member.name = participant.name
      sendSnapshots(session, participant, room)
    }
  }

  function requireParticipant(session: Session): Participant | null {
    const participantId = session.participantId
    const participant = participantId ? participants.get(participantId) : undefined
    if (!participant) {
      session.sendError('NOT_AUTHORIZED', '请先发送 hello 完成握手')
      return null
    }
    return participant
  }

  function requireRoom(participant: Participant): Room {
    const room = roomOf(participant)
    if (!room) throw new RoomError('NOT_AUTHORIZED', '你还没有加入房间')
    return room
  }

  function requireDriver(room: Room): MatchDriver {
    if (!room.started || !room.driver) throw new RoomError('BAD_MESSAGE', '游戏还没有开始')
    return room.driver
  }

  function requireHost(participant: Participant, room: Room): void {
    if (room.host_id !== participant.id) throw new RoomError('NOT_AUTHORIZED', '只有房主可以执行这个操作')
  }

  function handleMessage(session: Session, message: ClientMsg): void {
    switch (message.t) {
      case 'hello':
        handleHello(session, message as ClientMsg & { t: 'hello' })
        return
      case 'ping':
        session.send({ t: 'pong', t0: typeof message.t0 === 'number' ? message.t0 : 0, server_at: Date.now() })
        return
      default:
        break
    }

    const participant = requireParticipant(session)
    if (!participant) return

    switch (message.t) {
      case 'create': {
        if (participant.roomCode) leaveRoom(participant, false)
        const room = createRoom(participant, message.format, message.paper_id)
        session.roomCode = room.code
        session.send(room.lobbyFor(participant.id))
        return
      }

      case 'join': {
        const code = typeof message.room_code === 'string' ? message.room_code.trim() : ''
        if (!/^\d{6}$/.test(code)) throw new RoomError('ROOM_NOT_FOUND', '房间码应为 6 位数字')
        const room = rooms.get(code)
        if (!room) throw new RoomError('ROOM_NOT_FOUND', '房间不存在或已关闭')
        if (room.started) throw new RoomError('ROOM_STARTED', '房间已经开局；掉线重连请使用 resume_id')

        if (participant.roomCode === code && room.hasMember(participant.id)) {
          room.setOnline(participant.id, true)
          session.roomCode = code
          broadcastLobby(room)
          return
        }
        if (participant.roomCode) leaveRoom(participant, false)
        if (room.isFull) throw new RoomError('ROOM_FULL', `房间已满（最多 ${room.capacity} 人）`)

        room.addMember(participant.id, participant.name, Date.now())
        participant.roomCode = code
        session.roomCode = code
        roomLog(room, { event: 'room_joined', participant_id: participant.id })
        broadcastLobby(room)
        return
      }

      case 'new_team': {
        const room = requireRoom(participant)
        const { team, switched } = room.createTeam(participant.id, typeof message.name === 'string' ? message.name : '')
        if (switched) roomLog(room, { at: Date.now(), event: 'team_switch', participant_id: participant.id, team_id: team.id })
        roomLog(room, { event: 'team_created', participant_id: participant.id, team_id: team.id })
        broadcastLobby(room)
        return
      }

      case 'join_team': {
        const room = requireRoom(participant)
        const code = typeof message.team_code === 'string' ? message.team_code.trim() : ''
        const { team, switched } = room.joinTeam(participant.id, code)
        if (switched) roomLog(room, { at: Date.now(), event: 'team_switch', participant_id: participant.id, team_id: team.id })
        roomLog(room, { event: 'team_joined', participant_id: participant.id, team_id: team.id })
        broadcastLobby(room)
        return
      }

      case 'ready': {
        const room = requireRoom(participant)
        if (typeof message.value !== 'boolean') throw new RoomError('BAD_MESSAGE', 'ready.value 应为布尔值')
        room.setReady(participant.id, message.value)
        broadcastLobby(room)
        return
      }

      case 'start': {
        const room = requireRoom(participant)
        requireHost(participant, room)
        startMatch(room)
        return
      }

      case 'submit': {
        const room = requireRoom(participant)
        const driver = requireDriver(room)
        if (driver.ended) throw new RoomError('BAD_MESSAGE', '对局已经结束')
        if (!driver.ctx.roster.teams.some((team) => team.member_ids.includes(participant.id))) {
          throw new RoomError('NOT_AUTHORIZED', '你不在本局名单中（观战）')
        }
        if (typeof message.qid !== 'string' || !message.qid) throw new RoomError('BAD_MESSAGE', '缺少题号 qid')
        if (typeof message.seq !== 'number' || !Number.isFinite(message.seq)) {
          throw new RoomError('BAD_MESSAGE', 'seq 必须是数字')
        }
        if (!isStringArray(message.choice)) throw new RoomError('BAD_MESSAGE', 'choice 必须是字符串数组')
        const at = Date.now()
        driver.handle({
          type: 'SUBMIT',
          at,
          actor_id: participant.id,
          team_id: room.teamOf(participant.id)?.id,
          qid: message.qid,
          seq: message.seq,
          choice: message.choice.slice(0, 16),
        })
        return
      }

      case 'advance': {
        const room = requireRoom(participant)
        const driver = requireDriver(room)
        if (driver.ended) throw new RoomError('BAD_MESSAGE', '对局已经结束')
        if (!driver.ctx.roster.teams.some((team) => team.member_ids.includes(participant.id))) {
          throw new RoomError('NOT_AUTHORIZED', '你不在本局名单中（观战）')
        }
        driver.handle({
          type: 'ADVANCE',
          at: Date.now(),
          actor_id: participant.id,
          team_id: room.teamOf(participant.id)?.id,
        })
        return
      }

      case 'set_answerer': {
        const room = requireRoom(participant)
        const driver = requireDriver(room)
        if (typeof message.member_id !== 'string' || !message.member_id) {
          throw new RoomError('BAD_MESSAGE', '缺少 member_id')
        }
        driver.handle({
          type: 'SET_ANSWERER',
          at: Date.now(),
          actor_id: participant.id,
          team_id: room.teamOf(participant.id)?.id,
          member_id: message.member_id,
        })
        return
      }

      case 'set_leg_order': {
        const room = requireRoom(participant)
        if (!isStringArray(message.order)) throw new RoomError('BAD_MESSAGE', 'order 必须是字符串数组')
        room.setLegOrder(participant.id, message.order)
        broadcastLobby(room)
        return
      }

      case 'submit_all': {
        const room = requireRoom(participant)
        const driver = requireDriver(room)
        if (driver.ended) throw new RoomError('BAD_MESSAGE', '对局已经结束')
        const format: string = room.format
        // 团队赛的「交卷」= 本队结束作答（core 用 END + reason 'self' + actor 表达）
        if (format === 'team-coop') {
          driver.handle({ type: 'END', at: Date.now(), reason: 'self', actor_id: participant.id })
          return
        }
        // 个人赛 / 团队个人赛 / 接力的「交卷」= 本人封卷（接力是一键交到第 3 棒结束）
        if (format === 'solo' || format === 'team-solo' || format === 'relay') {
          driver.handle({ type: 'FINISH', at: Date.now(), actor_id: participant.id })
          return
        }
        throw new RoomError('BAD_MESSAGE', '该赛制不支持「交卷」')
      }

      case 'feedback': {
        const room = roomOf(participant)
        if (!room) throw new RoomError('NOT_AUTHORIZED', '你还没有加入房间')
        if (typeof message.qid !== 'string' || !message.qid) throw new RoomError('BAD_MESSAGE', '缺少题号 qid')
        const reason = typeof message.reason === 'string' ? message.reason.slice(0, 500) : ''
        roomLog(room, {
          event: 'feedback',
          participant_id: participant.id,
          qid: message.qid,
          data: { reason },
        })
        return
      }

      case 'end': {
        const room = requireRoom(participant)
        requireHost(participant, room)
        if (!room.started || !room.driver) {
          dissolveRoom(room, '房间已被房主解散')
          return
        }
        room.driver.handle({ type: 'END', at: Date.now(), reason: 'host' })
        roomLog(room, { event: 'host_end', participant_id: participant.id })
        return
      }

      case 'leave': {
        leaveRoom(participant, true)
        return
      }

      case 'handoff': {
        const room = requireRoom(participant)
        const driver = requireDriver(room)
        if (driver.ended) throw new RoomError('BAD_MESSAGE', '对局已经结束')
        if (room.format !== 'relay') throw new RoomError('BAD_MESSAGE', '交棒（handoff）仅在接力赛可用')
        driver.handle({ type: 'HANDOFF', at: Date.now(), actor_id: participant.id })
        return
      }

      default: {
        const unknown = message as { t?: unknown }
        throw new RoomError('BAD_MESSAGE', `未知消息类型: ${String(unknown.t)}`)
      }
    }
  }

  // ------------------------------------------------------------- HTTP / WS

  const httpServer = createHttpServer(
    createRequestHandler({
      webRoot,
      ...(options.allowOrigin ? { allowOrigin: options.allowOrigin } : {}),
      healthz: () => ({
        ok: true,
        version: SERVER_VERSION,
        protocol: PROTOCOL_VERSION,
        uptime_sec: Math.floor((Date.now() - startedAt) / 1000),
        rooms: rooms.size,
        participants: countOnline(),
      }),
    }),
  )

  const wss = new WebSocketServer({ noServer: true })
  httpServer.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  })
  wss.on('connection', (ws) => {
    const session = new Session(ws, sessionHooks, {
      rateLimitPerSecond: 30,
      maxFrameBytes: 64 * 1024,
      helloTimeoutMs: options.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    })
    sessions.add(session)
  })

  const heartbeat = setInterval(() => {
    for (const session of sessions) session.heartbeat()
  }, HEARTBEAT_INTERVAL_MS)
  heartbeat.unref?.()

  const syncTimer = setInterval(() => {
    const serverAt = Date.now()
    for (const participant of participants.values()) {
      participant.session?.send({ t: 'sync', server_at: serverAt })
    }
  }, SYNC_INTERVAL_MS)
  syncTimer.unref?.()

  const port = options.port ?? 8787
  const host = options.host ?? '0.0.0.0'

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off('error', onError)
      reject(error)
    }
    httpServer.once('error', onError)
    httpServer.listen(port, host, () => {
      httpServer.off('error', onError)
      resolve()
    })
  })

  const address = httpServer.address() as AddressInfo | null
  const actualPort = address && typeof address === 'object' ? address.port : port

  async function close(): Promise<void> {
    clearInterval(heartbeat)
    clearInterval(syncTimer)
    for (const participant of participants.values()) clearGrace(participant)
    for (const room of rooms.values()) room.driver?.dispose()
    for (const session of [...sessions]) session.close(1001, 'server shutdown')
    await new Promise<void>((resolve) => {
      httpServer.closeAllConnections?.()
      httpServer.close(() => resolve())
    })
    await new Promise<void>((resolve) => {
      wss.close(() => resolve())
    })
  }

  return {
    port: actualPort,
    host,
    url: `http://127.0.0.1:${actualPort}`,
    http: httpServer,
    bank,
    rooms,
    participants,
    close,
  }
}
