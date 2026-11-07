/**
 * 赛制注册表。
 *
 * 房间只持有一个 `MatchState` 判别联合，靠 `state.format` 收窄后转给对应 spec，
 * 因此 server / LocalDriver 两边都只调这里的 `reduce` / `view` / `initMatch`，不写五份分支。
 *
 * 已实现：solo / team-solo / team-coop（P1–P2）、relay（P4）、buzz（P5）。
 */

import type { Effects, MatchEvent, MatchState, MatchStateBase, ReduceCtx } from '../state.ts'
import type { MatchSummary, PublicMatchState } from '../public.ts'
import { soloSpec } from './solo.ts'
import { teamSoloSpec } from './teamSolo.ts'
import { teamCoopSpec } from './teamCoop.ts'
import { relaySpec } from './relay.ts'
import { buzzSpec } from './buzz.ts'

export { soloSpec, teamSoloSpec, teamCoopSpec, relaySpec, buzzSpec }
export type { Sheet, SheetAnswer } from './sheet.ts'
export type { SoloState } from './solo.ts'
export type { TeamSoloState } from './teamSolo.ts'
export type { CoopAnswer, CoopTeamState, TeamCoopState } from './teamCoop.ts'
export type { RelayAnswer, RelayTeamState, RelayState } from './relay.ts'
export type { BuzzPhase, BuzzQuestionResult, BuzzState, BuzzSubmissionRecord } from './buzz.ts'
export { splitLegQuestions } from './relay.ts'

export function initMatch(ctx: ReduceCtx, at: number): MatchState {
  switch (ctx.paper.format) {
    case 'solo':
      return soloSpec.init(ctx, at)
    case 'team-solo':
      return teamSoloSpec.init(ctx, at)
    case 'team-coop':
      return teamCoopSpec.init(ctx, at)
    case 'relay':
      return relaySpec.init(ctx, at)
    case 'buzz':
      return buzzSpec.init(ctx, at)
    default:
      throw new Error(`赛制尚未实现: ${ctx.paper.format}`)
  }
}

export function reduce(state: MatchState, event: MatchEvent, ctx: ReduceCtx): { state: MatchState; effects: Effects } {
  switch (state.format) {
    case 'solo':
      return soloSpec.reduce(state, event, ctx)
    case 'team-solo':
      return teamSoloSpec.reduce(state, event, ctx)
    case 'team-coop':
      return teamCoopSpec.reduce(state, event, ctx)
    case 'relay':
      return relaySpec.reduce(state, event, ctx)
    case 'buzz':
      return buzzSpec.reduce(state, event, ctx)
    default:
      throw new Error(`赛制尚未实现: ${(state as MatchStateBase).format}`)
  }
}

export function view(state: MatchState, viewerId: string | null, at: number): PublicMatchState {
  switch (state.format) {
    case 'solo':
      return soloSpec.view(state, viewerId, at)
    case 'team-solo':
      return teamSoloSpec.view(state, viewerId, at)
    case 'team-coop':
      return teamCoopSpec.view(state, viewerId, at)
    case 'relay':
      return relaySpec.view(state, viewerId, at)
    case 'buzz':
      return buzzSpec.view(state, viewerId, at)
    default:
      throw new Error(`赛制尚未实现: ${(state as MatchStateBase).format}`)
  }
}

export function isEnded(state: MatchState): boolean {
  switch (state.format) {
    case 'solo':
      return soloSpec.is_ended(state)
    case 'team-solo':
      return teamSoloSpec.is_ended(state)
    case 'team-coop':
      return teamCoopSpec.is_ended(state)
    case 'relay':
      return relaySpec.is_ended(state)
    case 'buzz':
      return buzzSpec.is_ended(state)
    default:
      return true
  }
}

/** 结算（服务端在 ended / 测试断言里用；本地模式由 driver 从 effects.ended 里拿） */
export function summarize(state: MatchState, ctx: ReduceCtx): MatchSummary {
  switch (state.format) {
    case 'solo':
      return soloSpec.summarize(state, ctx)
    case 'team-solo':
      return teamSoloSpec.summarize(state, ctx)
    case 'team-coop':
      return teamCoopSpec.summarize(state, ctx)
    case 'relay':
      return relaySpec.summarize(state, ctx)
    case 'buzz':
      return buzzSpec.summarize(state, ctx)
    default:
      throw new Error(`赛制尚未实现: ${(state as MatchStateBase).format}`)
  }
}
