/**
 * 房间（大厅 + 队伍）的纯数据模型。
 *
 * 这里不碰 WebSocket、不碰定时器，所有「谁能做什么」的裁决仍留在 server.ts：
 * 房间只负责维护成员/队伍/房主这些会被重发的状态，以及构造 `lobby` 消息。
 */

import { randomInt } from 'node:crypto'

import type {
  ErrorCode,
  FormatId,
  LogEntry,
  LobbyTeam,
  MatchState,
  Paper,
  PaperQuestion,
  PublicMatchState,
  Question,
  Roster,
  RosterTeam,
  ServerMsg,
} from './core.ts'
import type { MatchDriver } from './driver.ts'

export type LobbyMessage = Extract<ServerMsg, { t: 'lobby' }>

/** 已开放联机的赛制；其余 format 在 create 时直接拒绝。 */
export const SUPPORTED_FORMATS = ['team-solo', 'team-coop', 'relay', 'buzz'] as const
export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number]

export const MAX_ROOM_MEMBERS = 12
/** team-solo 每队 1–3 人，team-coop 每队 3 人；两种赛制的硬上限都是 3。 */
export const MAX_TEAM_MEMBERS = 3
export const MIN_TEAM_MEMBERS = 1
/** team-coop 要求满编才开局。 */
export const TEAM_COOP_TEAM_SIZE = 3
/** 房间/队伍码长度。 */
export const CODE_LENGTH = 6

export function isSupportedFormat(format: unknown): format is SupportedFormat {
  return typeof format === 'string' && (SUPPORTED_FORMATS as readonly string[]).includes(format)
}

/** 6 位数字码（任务契约要求数字码；design.md 的字母表以任务契约为准）。 */
export function randomCode(): string {
  let code = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) code += String(randomInt(0, 10))
  return code
}

export function uniqueCode(taken: (code: string) => boolean): string {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const code = randomCode()
    if (!taken(code)) return code
  }
  throw new Error('无法生成唯一数字码')
}

export class RoomError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface RoomMember {
  id: string
  name: string
  ready: boolean
  online: boolean
  joined_at: number
}

export interface RoomTeam {
  id: string
  name: string
  code: string
  captain_id: string
  member_ids: string[]
}

export interface RoomOptions {
  code: string
  format: SupportedFormat
  paper: Paper
  capacity?: number
  created_at?: number
}

const MAX_LOGS = 500

export class Room {
  readonly code: string
  readonly format: SupportedFormat
  readonly paper: Paper
  readonly created_at: number
  readonly capacity: number
  readonly members = new Map<string, RoomMember>()
  readonly teams: RoomTeam[] = []
  readonly logs: LogEntry[] = []

  host_id: string
  started = false
  ended = false
  started_at: number | null = null
  ended_at: number | null = null
  /** 开局时由 drawPaper 组出的题（已裁掉答案字段）。 */
  questions: PaperQuestion[] = []
  driver: MatchDriver | null = null

  constructor(options: RoomOptions, hostId: string) {
    this.code = options.code
    this.format = options.format
    this.paper = options.paper
    this.created_at = options.created_at ?? Date.now()
    this.capacity = options.capacity ?? MAX_ROOM_MEMBERS
    this.host_id = hostId
  }

  get size(): number {
    return this.members.size
  }

  get onlineCount(): number {
    let count = 0
    for (const member of this.members.values()) if (member.online) count += 1
    return count
  }

  get isFull(): boolean {
    return this.members.size >= this.capacity
  }

  get isActive(): boolean {
    return this.started && !this.ended
  }

  hasMember(participantId: string): boolean {
    return this.members.has(participantId)
  }

  member(participantId: string): RoomMember | undefined {
    return this.members.get(participantId)
  }

  addMember(participantId: string, name: string, at: number): RoomMember {
    if (this.started) throw new RoomError('ROOM_STARTED', '房间已经开局，无法加入')
    const existing = this.members.get(participantId)
    if (existing) {
      existing.online = true
      return existing
    }
    if (this.isFull) throw new RoomError('ROOM_FULL', `房间已满（最多 ${this.capacity} 人）`)
    const member: RoomMember = { id: participantId, name, ready: false, online: true, joined_at: at }
    this.members.set(participantId, member)
    return member
  }

  /** 返回房主是否发生了转移。空房间由调用方负责删除。 */
  removeMember(participantId: string): boolean {
    if (!this.members.delete(participantId)) return false
    this.leaveTeam(participantId)
    if (this.host_id !== participantId) return false
    const next = this.pickNextHost()
    if (next) this.host_id = next
    return Boolean(next)
  }

  private pickNextHost(): string | null {
    for (const member of this.members.values()) if (member.online) return member.id
    for (const member of this.members.values()) return member.id
    return null
  }

  setOnline(participantId: string, online: boolean): void {
    const member = this.members.get(participantId)
    if (member) member.online = online
  }

  teamOf(participantId: string): RoomTeam | undefined {
    return this.teams.find((team) => team.member_ids.includes(participantId))
  }

  teamById(teamId: string): RoomTeam | undefined {
    return this.teams.find((team) => team.id === teamId)
  }

  teamByCode(code: string): RoomTeam | undefined {
    return this.teams.find((team) => team.code === code)
  }

  createTeam(participantId: string, name: string): { team: RoomTeam; switched: boolean } {
    if (this.started) throw new RoomError('ROOM_STARTED', '房间已经开局，无法分队')
    if (!this.members.has(participantId)) throw new RoomError('NOT_AUTHORIZED', '你不在这个房间里')
    const trimmed = name.trim().slice(0, 16)
    if (!trimmed) throw new RoomError('BAD_MESSAGE', '队伍名不能为空')

    const previous = this.teamOf(participantId)
    const switched = Boolean(previous)
    this.leaveTeam(participantId)

    const code = uniqueCode((candidate) => Boolean(this.teamByCode(candidate)))
    const team: RoomTeam = {
      id: `team-${code}`,
      name: trimmed,
      code,
      captain_id: participantId,
      member_ids: [participantId],
    }
    this.teams.push(team)
    return { team, switched }
  }

  joinTeam(participantId: string, teamCode: string): { team: RoomTeam; switched: boolean } {
    if (this.started) throw new RoomError('ROOM_STARTED', '房间已经开局，无法换队')
    if (!this.members.has(participantId)) throw new RoomError('NOT_AUTHORIZED', '你不在这个房间里')

    const team = this.teamByCode(teamCode)
    if (!team) throw new RoomError('TEAM_NOT_FOUND', '队伍不存在，检查队伍码')
    if (team.member_ids.includes(participantId)) return { team, switched: false }
    if (team.member_ids.length >= MAX_TEAM_MEMBERS) {
      throw new RoomError('ROOM_FULL', `队伍已满（最多 ${MAX_TEAM_MEMBERS} 人）`)
    }

    const previous = this.teamOf(participantId)
    this.leaveTeam(participantId)
    team.member_ids.push(participantId)
    return { team, switched: Boolean(previous) }
  }

  leaveTeam(participantId: string): void {
    for (const team of this.teams) {
      const index = team.member_ids.indexOf(participantId)
      if (index < 0) continue
      team.member_ids.splice(index, 1)
      if (team.captain_id === participantId && team.member_ids.length > 0) {
        team.captain_id = team.member_ids[0] as string
      }
      this.pruneEmptyTeams()
      return
    }
  }

  private pruneEmptyTeams(): void {
    for (let index = this.teams.length - 1; index >= 0; index -= 1) {
      if (this.teams[index]?.member_ids.length === 0) this.teams.splice(index, 1)
    }
  }

  setReady(participantId: string, value: boolean): void {
    const member = this.members.get(participantId)
    if (!member) throw new RoomError('NOT_AUTHORIZED', '你不在这个房间里')
    if (this.started) throw new RoomError('BAD_MESSAGE', '已经开局，无法改准备状态')
    member.ready = value
  }

  /** 大厅快照：`code` 只填给本队成员；`teams` 是全房公开信息。 */
  lobbyFor(viewerId: string): LobbyMessage {
    const viewerTeam = this.teamOf(viewerId)
    const teams: LobbyTeam[] = this.teams.map((team) => ({
      id: team.id,
      name: team.name,
      captain_id: team.captain_id,
      ...(team.id === viewerTeam?.id ? { code: team.code } : {}),
      members: team.member_ids
        .map((memberId) => this.members.get(memberId))
        .filter((member): member is RoomMember => Boolean(member))
        .map((member) => ({ id: member.id, name: member.name, ready: member.ready, online: member.online })),
    }))

    const waiting = [...this.members.values()]
      .filter((member) => !this.teamOf(member.id))
      .map((member) => ({ id: member.id, name: member.name, ready: member.ready }))

    return {
      t: 'lobby',
      room_code: this.code,
      format: this.format as FormatId,
      paper_id: this.paper.id,
      host_id: this.host_id,
      started: this.started,
      viewer_id: viewerId,
      team_id: viewerTeam?.id ?? null,
      teams,
      waiting,
    }
  }

  /** 交给 initMatch 的 roster：队伍 id/name/captain_id/member_ids 全部用真实值。 */
  roster(): Roster {
    const names: Record<string, string> = {}
    for (const member of this.members.values()) names[member.id] = member.name
    const teams: RosterTeam[] = this.teams
      .filter((team) => team.member_ids.length > 0)
      .map((team) => ({
        id: team.id,
        name: team.name,
        captain_id: team.captain_id,
        member_ids: [...team.member_ids],
      }))
    return { teams, names }
  }

  /** 把抽到的题裁成可下发的题面（绝不带 answer/explain）。 */
  toPaperQuestions(questions: Question[]): PaperQuestion[] {
    return questions.map((question) => ({
      id: question.id,
      type: question.type,
      stem: question.stem,
      ...(question.stem_images ? { stem_images: question.stem_images } : {}),
      options: question.options.map((option) => ({ key: option.key, text: option.text })),
      ...(question.difficulty ? { difficulty: question.difficulty } : {}),
      ...(question.taxonomy ? { taxonomy: question.taxonomy } : {}),
    }))
  }

  log(entry: LogEntry): void {
    this.logs.push(entry)
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS)
  }

  /** 房间摘要（/healthz 之后可能的排障面板用）。 */
  summary(): { code: string; format: FormatId; started: boolean; ended: boolean; members: number; online: number } {
    return {
      code: this.code,
      format: this.format as FormatId,
      started: this.started,
      ended: this.ended,
      members: this.members.size,
      online: this.onlineCount,
    }
  }

  /** 当前对局状态（未开局为 null）。 */
  get state(): MatchState | null {
    return this.driver?.state ?? null
  }

  snapshotFor(participantId: string): PublicMatchState | null {
    return this.driver?.snapshotFor(participantId) ?? null
  }
}
