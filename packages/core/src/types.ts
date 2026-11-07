/**
 * 题库与试卷的类型定义。
 * 命名约定见 docs/design.md §3.1：数据契约一律 snake_case，且磁盘 JSON、WS 帧、TS 接口三处同名同形。
 * 不要在这里引入任何运行时依赖 —— core 包的约束是「零运行时依赖」。
 */

export type QuestionType = 'single' | 'multiple' | 'judge'

export type AnswerStatus = 'pending' | 'verified' | 'disputed' | 'expired'

export type Difficulty = 1 | 2 | 3

export type FormatId = 'solo' | 'team-solo' | 'team-coop' | 'relay' | 'buzz'

export interface QuestionOption {
  key: string
  text: string
}

export interface Question {
  schema_version: 1
  id: string
  type: QuestionType
  title?: string
  stem: string
  stem_images?: string[]
  options: QuestionOption[]
  answer: string[]
  answer_status: AnswerStatus
  explain?: string
  taxonomy?: string[]
  difficulty?: Difficulty
  score?: number
  exam_year?: number
  round?: string
}

/** 组卷参数。题量为 0 / 缺省表示该题型不抽。 */
export interface DrawSpec {
  single?: number
  multiple?: number
  judge?: number
  taxonomy?: string[]
  difficulty?: Difficulty[]
  min_available: number
  allow_partial: boolean
  seed?: number | null
}

/**
 * 计分规则。
 * - per_question：答对得分、答错 0、不答 unanswered
 * - correct_minus_wrong：答对得分、答错 -wrong_penalty、不答 unanswered
 */
export interface ScoringConfig {
  mode: 'per_question' | 'correct_minus_wrong'
  points: Record<QuestionType, number>
  wrong_penalty: number
  unanswered: number
  /** 0 = 不折算；非 0 时按百分制折算到该值 */
  total_normalize: number
}

/** 抢答赛制参数（仅 format === 'buzz' 时必填）。 */
export interface BuzzConfig {
  /** 题面广播后禁抢缓冲（ms） */
  buffer_ms: number
  /** 开抢窗口（秒） */
  submit_window_sec: number
  /** 0.5 = 前 50% */
  qualify_ratio: number
  qualify_fill: 'strict' | 'fill'
  correct_points: number
  wrong_points: number
  /** 公布答案与得分（秒） */
  reveal_sec: number
  close_on_all_submitted: boolean
  /** 视为并列的时间窗（ms），默认 5 */
  tie_window_ms: number
}

export interface Paper {
  schema_version: 1
  id: string
  name: string
  format: FormatId
  /** 全局时长（秒）；buzz 为 0（每题自带窗口） */
  duration_sec: number
  /** relay 卷为 null，题量全部落在 legs */
  draw: DrawSpec | null
  legs?: [DrawSpec, DrawSpec, DrawSpec] | null
  submit_mode: 'batch' | 'stream'
  scoring: ScoringConfig
  buzz?: BuzzConfig
}
