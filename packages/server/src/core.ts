/**
 * 服务端对 `@aixx/core` 的唯一入口。
 *
 * 为什么用相对路径而不是 `@aixx/core`：npm workspaces 把包软链到 `node_modules`，
 * 而 Node 22 的 type stripping 明确拒绝对 node_modules 下的 `.ts` 做剥离
 * （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）。相对路径解析到真实源码目录，
 * 于是 `node src/main.ts` 不需要任何 loader 就能跑；测试里的 loader 也只影响裸包名解析。
 *
 * 这里集中转出一份，server 内部所有文件只 import `./core.ts`，将来 core 换导出面
 * （比如 relay/buzz 实装）时只需改这一个文件。
 */

export {
  PROTOCOL_VERSION,
  DrawError,
  drawPaper,
  initMatch,
  isEnded,
  isScorable,
  reduce,
  summarize,
  view,
} from '../../core/src/index.ts'

export type {
  ClientMsg,
  DrawErrorCode,
  DrawRelayResult,
  DrawResult,
  Effects,
  ErrorCode,
  FormatId,
  LogEntry,
  LobbyTeam,
  MatchEvent,
  MatchState,
  MatchSummary,
  Paper,
  PaperQuestion,
  PeerInfo,
  PublicMatchState,
  Question,
  ReduceCtx,
  Roster,
  RosterTeam,
  ServerMsg,
} from '../../core/src/index.ts'
