import type { MatchState, MatchSummary, Paper, Question, Roster } from '@aixx/core'

/**
 * 静态模式的断点续做。全部落在 localStorage：
 * - 题目、试卷、名单、状态机内部 state 一起存，恢复时不用重新组卷（组卷有随机种子，重抽会换题）；
 * - 本地模式没有保密需求（答案本来就在浏览器里），所以存内部 state 而不是裁剪后的快照，
 *   恢复出来和没关过页面完全一致。
 */

export interface LocalMatchRecord {
  version: 1
  match_id: string
  paper: Paper
  questions: Question[]
  roster: Roster
  viewer_id: string
  nickname: string
  /** 组卷降级提示（"本卷 40/55 题有答案"），原样带进对局页与成绩页 */
  notice?: string
  /** 状态机内部状态；开赛后才写入 */
  state: MatchState | null
  summary: MatchSummary | null
  created_at: number
  saved_at: number
  /** 客户端游标（题号下标）与存疑标记，纯 UI 状态，不进状态机 */
  cursor: number
  flags: string[]
  finished: boolean
}

const MATCH_PREFIX = 'arena:match:'
const PROFILE_KEY = 'arena:profile'

export function matchKey(matchId: string): string {
  return `${MATCH_PREFIX}${matchId}`
}

function safeParse<T>(text: string | null): T | null {
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export function saveMatch(record: LocalMatchRecord): void {
  record.saved_at = Date.now()
  try {
    localStorage.setItem(matchKey(record.match_id), JSON.stringify(record))
  } catch (error) {
    // 配额满（题库大的时候本地存储确实可能爆）不应该打断考试，只提示
    console.warn('本地存储写入失败，断点续做可能不可用', error)
  }
}

export function loadMatch(matchId: string): LocalMatchRecord | null {
  const record = safeParse<LocalMatchRecord>(localStorage.getItem(matchKey(matchId)))
  if (!record || record.version !== 1 || record.match_id !== matchId) return null
  return record
}

export function removeMatch(matchId: string): void {
  localStorage.removeItem(matchKey(matchId))
}

/** 首页「继续练习」列表：未完成的排前面，各自按保存时间倒序 */
export function listMatches(): LocalMatchRecord[] {
  const records: LocalMatchRecord[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(MATCH_PREFIX)) continue
    const record = safeParse<LocalMatchRecord>(localStorage.getItem(key))
    if (record && record.version === 1) records.push(record)
  }
  records.sort((a, b) => Number(a.finished) - Number(b.finished) || b.saved_at - a.saved_at)
  return records
}

export interface Profile {
  nickname: string
  /** 交卷后是否默认展开解析 */
  autoExplain: boolean
}

const DEFAULT_PROFILE: Profile = { nickname: '', autoExplain: true }

export function loadProfile(): Profile {
  return { ...DEFAULT_PROFILE, ...(safeParse<Partial<Profile>>(localStorage.getItem(PROFILE_KEY)) ?? {}) }
}

export function saveProfile(profile: Profile): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile))
  } catch {
    /* 忽略：设置项丢了不影响考试 */
  }
}

export function displayName(profile: Profile): string {
  return profile.nickname.trim() || '我'
}

/**
 * 联机房间的会话信息（sessionStorage）。
 *
 * 只存「怎么找回这个房间」，不存对局状态 —— 对局权威在服务端。
 * 刷新页面后靠它 + 服务端 30s 宽限期 resume（design.md §7.7）。
 */
export interface RoomSession {
  server_url: string
  nickname: string
  room_code: string
  participant_id: string
}

const ROOM_SESSION_KEY = 'arena:room-session'

export function saveRoomSession(session: RoomSession): void {
  try {
    sessionStorage.setItem(ROOM_SESSION_KEY, JSON.stringify(session))
  } catch {
    /* 存不下就退化成「刷新后回大厅」，不影响答题 */
  }
}

export function loadRoomSession(): RoomSession | null {
  return safeParse<RoomSession>(sessionStorage.getItem(ROOM_SESSION_KEY))
}

export function clearRoomSession(): void {
  sessionStorage.removeItem(ROOM_SESSION_KEY)
}

/** 联机成绩的本地备份：成绩页刷新后靠它复盘（服务端不存历史） */
export interface RoomResultRecord {
  summary: MatchSummary
  /** 题面（服务端发的 paper 消息），复盘页要显示题干与选项 */
  questions: Question[]
  paper_name: string
  /** 自己所在的队伍 id：成绩页要先把「我的队」挑出来 */
  team_id?: string
  /** 交卷后服务端逐人下发的正确答案与解析（题面里没有，联机模式靠它复盘） */
  reveal?: Record<string, { answer: string[]; explain?: string }>
}

export function saveRoomResult(roomCode: string, record: RoomResultRecord): void {
  try {
    localStorage.setItem(`arena:room-result:${roomCode}`, JSON.stringify(record))
  } catch {
    /* 忽略 */
  }
}

export function loadRoomResult(roomCode: string): RoomResultRecord | null {
  return safeParse<RoomResultRecord>(localStorage.getItem(`arena:room-result:${roomCode}`))
}
