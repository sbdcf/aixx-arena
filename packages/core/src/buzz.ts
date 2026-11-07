/**
 * 抢答排序与计分（docs/design.md §5.7）。
 *
 * 抽成独立纯函数的原因：并发下的「谁排第几、名额边界被并列撑开到哪」是最容易写错、
 * 又最难在真实对局里复现的部分。放在这里就能用固定的提交序列反复验证。
 *
 * 三个必须按顺序实现的点（§15 第 2、3 条）：
 * - quota 用 Math.ceil，不用 round（N=5 时要 3 个名额）；
 * - 并列判定是 `at[i] - at[i-1] <= tie_window_ms`，且聚簇必须发生在已排序序列上；
 * - 排序键是 (at, team_id)，不依赖 V8 的排序稳定性。
 */

export interface BuzzSubmission {
  team_id: string
  /** 服务端收到的时刻（epoch ms） */
  at: number
  correct: boolean
}

export interface BuzzRankInput {
  submissions: BuzzSubmission[]
  /** 本题开始时有资格的队伍数（不是房间队伍总数） */
  n_at_open: number
  qualify_ratio: number
  qualify_fill: 'strict' | 'fill'
  tie_window_ms: number
  correct_points: number
  wrong_points: number
}

export interface BuzzRankEntry {
  team_id: string
  at: number
  correct: boolean
  /** 并列者同名次 */
  rank: number
  tied: boolean
  in_quota: boolean
  awarded: number
}

export interface BuzzRankResult {
  quota: number
  ranking: BuzzRankEntry[]
  /** 名额边界被并列撑开 */
  boundary_tie_expanded: boolean
}

export function rankBuzz(input: BuzzRankInput): BuzzRankResult {
  const sorted = input.submissions.slice().sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at
    return a.team_id < b.team_id ? -1 : a.team_id > b.team_id ? 1 : 0
  })

  const nAtOpen = Math.max(1, input.n_at_open)
  const quota = Math.ceil(nAtOpen * input.qualify_ratio)

  // 1) 聚簇：rank = 簇首下标 + 1
  const ranks: number[] = []
  const clusterEnd: number[] = []
  let clusterStart = 0
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].at - sorted[i - 1].at > input.tie_window_ms) clusterStart = i
    ranks[i] = clusterStart + 1
    clusterEnd[i] = clusterStart
  }
  // clusterEnd 先存簇首下标，回填成簇末下标
  for (let i = 0; i < sorted.length; i++) {
    let end = i
    while (end + 1 < sorted.length && ranks[end + 1] === ranks[i]) end++
    clusterEnd[i] = end
  }

  // 2) 名额：rank <= quota 即入围；簇跨越名额边界时整簇计入
  let boundaryTieExpanded = false
  const inQuota: boolean[] = []
  for (let i = 0; i < sorted.length; i++) {
    const inside = ranks[i] <= quota
    inQuota[i] = inside
    if (inside && clusterEnd[i] > quota - 1) boundaryTieExpanded = true
  }

  // 3) 计分
  const awarded: number[] = sorted.map(() => 0)
  if (input.qualify_fill === 'strict') {
    for (let i = 0; i < sorted.length; i++) {
      if (!inQuota[i]) continue
      awarded[i] = sorted[i].correct ? input.correct_points : input.wrong_points
    }
  } else {
    // fill：名额内答错留下的空位，按名次顺延给名额外答对的队，补满名额为止
    const correctInQuota = sorted.filter((s, i) => inQuota[i] && s.correct).length
    let vacancies = Math.max(0, quota - correctInQuota)
    const filled = new Set<string>()
    for (let i = 0; i < sorted.length && vacancies > 0; i++) {
      if (inQuota[i] || !sorted[i].correct) continue
      filled.add(sorted[i].team_id)
      vacancies -= 1
    }
    for (let i = 0; i < sorted.length; i++) {
      if (inQuota[i]) {
        awarded[i] = sorted[i].correct ? input.correct_points : input.wrong_points
      } else if (sorted[i].correct && filled.has(sorted[i].team_id)) {
        awarded[i] = input.correct_points
      }
    }
  }

  const tiedFlags = sorted.map((_, i) => {
    const rank = ranks[i]
    return sorted.some((__, j) => ranks[j] === rank && j !== i)
  })

  return {
    quota,
    boundary_tie_expanded: boundaryTieExpanded,
    ranking: sorted.map((submission, i) => ({
      team_id: submission.team_id,
      at: submission.at,
      correct: submission.correct,
      rank: ranks[i],
      tied: tiedFlags[i],
      in_quota: inQuota[i],
      awarded: awarded[i],
    })),
  }
}
