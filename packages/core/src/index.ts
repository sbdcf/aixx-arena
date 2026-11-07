/**
 * `@aixx/core` 的公开入口。
 *
 * 约定：核心逻辑（判分、组卷、抢答排序、状态机）只有这一份实现，前端 `LocalDriver`
 * 与后端 `server` 都从这里 import —— 见 docs/design.md §5 与 AC-11。
 * 包约束：零运行时依赖、可在浏览器与 Node 里同时运行，所以这里不出现任何 node:* 导入。
 */

export const CORE_PACKAGE_NAME = '@aixx/core' as const

/** 题库 / 试卷磁盘 JSON 的 schema_version 基线，见 docs/design.md §9。 */
export const CORE_SCHEMA_VERSION = 1 as const

/* ------------------------------------------------------------------ 类型 */

export type {
  AnswerStatus,
  BuzzConfig,
  Difficulty,
  DrawSpec,
  FormatId,
  Paper,
  Question,
  QuestionOption,
  QuestionType,
  ScoringConfig,
} from './types.ts'

/* ------------------------------------------------------------------ 随机 */

export { mulberry32, pickOne, shuffle } from './rng.ts'

/* ------------------------------------------------------------------ 判分 */

export type { JudgeInput, JudgeOutput } from './scoring.ts'
export {
  isChoiceCorrect,
  isScorable,
  judge,
  maxRawPoints,
  normalizeChoice,
  normalizeScore,
  pointsOf,
  questionMaxPoints,
} from './scoring.ts'

/* ------------------------------------------------------------------ 组卷 */

export type { DrawErrorCode, DrawRelayResult, DrawResult } from './draw.ts'
export {
  DrawError,
  draw,
  drawPaper,
  drawRelay,
  eligiblePool,
  matchesDrawSpec,
} from './draw.ts'

/* ------------------------------------------------------------------ 抢答 */

export type { BuzzRankEntry, BuzzRankInput, BuzzRankResult, BuzzSubmission } from './buzz.ts'
export { rankBuzz } from './buzz.ts'

/* ------------------------------------------------------------------ 对外视图 / 协议 */

export type {
  EndReason,
  LogEntry,
  MatchSummary,
  OwnView,
  PeerInfo,
  PublicBase,
  PublicMatchState,
  TeamResult,
} from './public.ts'

export type {
  ClientMsg,
  ErrorCode,
  LobbyTeam,
  PaperQuestion,
  ServerMsg,
} from './protocol.ts'
export { PROTOCOL_VERSION } from './protocol.ts'

/* ------------------------------------------------------------------ 状态机 */

export type {
  Effects,
  FormatSpec,
  MatchEvent,
  MatchState,
  MatchStateBase,
  ReduceCtx,
  Roster,
  RosterTeam,
} from './state.ts'

export type { Sheet, SheetAnswer, SoloState } from './formats/index.ts'
export { initMatch, isEnded, reduce, soloSpec, summarize, view } from './formats/index.ts'
