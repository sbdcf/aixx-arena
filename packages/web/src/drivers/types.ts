import type { MatchSummary, PublicMatchState, ServerMsg } from '@aixx/core'

/**
 * 驱动层契约。
 *
 * 这是 P1 里最重要的一条不变式：**页面只认 ServerMsg，不认状态机**。
 * 本地练习由 LocalDriver 在浏览器里跑同一份 reduce，联机对局由 ServerDriver 收 WS 帧；
 * 两者产出的消息同构，所以对局页、成绩页一行都不用改就能从静态切到联机（AC-11）。
 */
export interface Driver {
  readonly matchId: string
  /** 开赛（或断点恢复）后立刻补一帧 room 快照 */
  start(): void
  submit(qid: string, choice: string[]): void
  /** 交卷：solo = 以当前答案结算；team-coop = 本队交卷 */
  submitAll(): void
  /** 主动结束（房主 / 本地提前收卷） */
  end(): void
  /** 团队赛推进题序（团队共享游标）；个人赛无意义 */
  advance?(): void
  /** 团队赛换主答（掉线接管 / 本地同名演示） */
  setAnswerer?(memberId: string): void
  /** 接力赛交棒（本棒选手把剩余时间交给下一棒）；第 3 棒交棒 = 本队结束 */
  handoff?(): void
  on(handler: (message: ServerMsg) => void): () => void
  dispose(): void
  /** 当前快照（页面初始化时用，避免等第一帧） */
  snapshot(): PublicMatchState | null
  summary(): MatchSummary | null
}
