# 「AI+信息素养」竞赛训练平台 — 技术方案设计

> 版本 **v1.0（整理版）**　｜　日期 2026-11-06　｜　状态：与实现一致（P0–P6 已落地）
>
> 上游：`docs/requirements.md` v0.3（需求基线，已拍板）
>
> 本文是代码级的技术方案与完整契约来源：架构形态、技术栈、core 契约、前后端实现、协议、数据文件、部署与测试策略。
> 面向使用者与部署者的整合版见仓库根 `README.md`（其中「系统设计」章是本文的摘要；两者不一致时以实现与本文为准，并回写 README）。
> 阅读顺序建议：§1 约束 → §2 架构与选型 → §3 契约命名 → §5 core → §6 前端 / §7 后端 → §8 协议。
>
> v1.0 整理说明：把「技术选型」并入 §2 架构章（2.3 技术栈 / 2.4 被否决方案），使"为什么这样搭"在一章内读完；
> 删除与具体开发机相关的记录（工具链路径、本地构建限制一类内容属于环境，不属于方案本身）；
> §4 目录树、§12 测试策略、§13 实施路线按当前实现重写；§16 变更历史压缩为一页版本记录。

---

## 0. 本文定位

需求文档回答「做什么」，本文回答「怎么搭」。

仓库根 `README.md` 是面向学生、老师和部署者的总入口（含整合版「系统设计」章与零基础部署手册）；本文保留代码级完整契约与实现细节，是改代码前要读的那一份。

具体到：架构形态与技术选型、仓库结构、模块边界、核心包接口与数据契约、五个赛制的状态机、通信协议、部署形态、测试策略、实施顺序与版本演进。

**不包含**：逐任务的 TDD 步骤（实作已完成，代码即证据）、UI 视觉稿、题库内容。

---

## 1. 约束回顾（从需求文档继承）

| 约束 | 对设计的直接影响 |
| --- | --- |
| 静态模式必须永远完整可用 | 核心逻辑不能依赖服务端；前端自带运行时 |
| 有服务端则服务端判分 | 后端必须加载题库，且要能剥离答案后再下发 |
| Linux 服务器 + Windows 个人电脑双部署 | 后端要能同时托管前端静态文件（免跨域、免 TLS） |
| 电脑优先 | 三栏布局（题号面板 / 主区 / 状态条），键盘全覆盖 |
| 无账号 | 身份靠客户端持久化的 `participant_id` + 服务端内存会话 |
| 一房多队、上限自适应 | 房间是一等对象，队伍是房间内集合，容量靠配置 |
| 断线 30s 续 / 超时自动交 | 服务端持有宽限计时器，重连发快照而非重放事件 |
| 题库后期补充 | 组卷支持降级（可判分题不足时按比例缩卷并明示）；题库扩容只需往 `data/questions/` 丢 JSON 再 `sync:data` |
| 接力/抢答是**多队同场** | 这两个赛制的状态是「每队一份进度」，不是「房间一份」 |

---

## 2. 总体架构

### 2.1 四种运行形态，一套代码

```
形态 A：纯静态（GitHub Pages）
  browser ── 静态资源 + 题库 JSON ──> LocalDriver ──> core 状态机

形态 B：单机局域网（Windows 双击启动）
  browser ── http/ws 同源 ──> arena-server ──> MatchDriver ──> core 状态机
                               └─ 同时托管静态资源

形态 C：服务器（Linux + Docker）
  browser ── https/wss ──> Nginx ──> arena-server ──> MatchDriver ──> core 状态机

形态 D：静态前端 + 独立后端（GitHub Pages 页面连自建服务）
  browser ── https(页面) + wss(隧道) ──> arena-server
           └─ 无后端托管静态资源；跨域 + 跨协议，限制最多（见 §11.4）
```

四种形态共用 `packages/core` 的**同一套赛制状态机与判分函数**。区别只在「谁驱动它」：

| 驱动 | 位置 | 时钟来源 | 判分位置 | 持久化 |
| --- | --- | --- | --- | --- |
| `LocalDriver` | 浏览器 | 本地 `Date.now()` + 绝对截止时刻 | 前端（core 同一函数） | localStorage |
| `MatchDriver` | Node | 服务端单一时钟 | 服务端（core 同一函数） | 内存 |

**形态 D 是官方文档里最容易被写成"支持"的一格**：GitHub Pages 是 https，浏览器不允许它连 `ws://` 局域网地址（混合内容硬拦截）。所以形态 D 只在「后端走 https 隧道」或「页面也是后端托管的」时才成立。**平时练习推荐直接用形态 B**：老师在自己电脑上双击，把局域网地址发群里，学生用手机/电脑打开就是同源页面，没有跨域也没有证书问题。

### 2.2 核心设计决策：状态机是纯函数

所有赛制实现为：

```ts
reduce(state: S, event: MatchEvent, ctx: ReduceCtx): { state: S; effects: Effects }
```

- **不读系统时间**：时间由 `event.at` 传入。测试可以精确构造「第 3 分 12 秒交棒」。
- **不产生副作用**：网络发送、定时器设置、日志都是 `effects` 里的声明，由驱动方执行。
- **可序列化**：`state` 是纯数据，能直接存 localStorage 或发快照。

这条决定了整个项目的可测性。五个赛制、所有超时边界、抢答排序，都能在无网络、无时钟依赖的单测里验证。

### 2.3 技术栈

选型的总原则：**能少一个依赖就少一个**。这个项目由社团学生维护、要离线可用、要能塞进一个 U 盘带进教室，任何「顺便引入」的库都会变成交接成本。

| 层 | 选型 | 版本基线 | 理由 |
| --- | --- | --- | --- |
| 语言 | TypeScript（`strict: true`） | 5.6+ | 前后端共享类型，协议字段写错在编译期就暴露 |
| 包管理 | npm workspaces | 10.x | npm 自带 workspaces，少一个工具依赖；与 CI、Docker 构建保持一致。registry 用 npmmirror（`.npmrc` 固定，国内拉包快） |
| 前端框架 | Vue 3（`<script setup>`） | 3.5+ | 中文资料多、SFC 上手快、社团交接成本低；响应式模型贴合「倒计时 + 状态广播」 |
| 构建 | Vite | 6.x | 静态产物、`base` 可配子路径（GitHub Pages 子目录要它）、开发热更新 |
| 路由 | vue-router（**hash 模式**） | 4.x | 静态托管没有服务端重写，hash 模式免 404 配置 |
| 状态 | 无状态库（Vue `reactive()` 单例） | — | 全局只有一个「当前对局」，Pinia 的模块拆分与 devtools 在这里没有收益（实现见 `packages/web/src/stores/matchStore.ts`） |
| 样式 | 原生 CSS + CSS 变量 + 少量工具类 | — | 无构建期依赖、产物最小；视觉简单，不需要组件库 |
| 后端运行时 | Node.js | 22 LTS | 单进程足够撑一场比赛；同版本可随便携包直接分发 `node.exe` |
| WS 库 | `ws` | 8.x | 事实标准、协议透明、可直接抓帧调试 |
| 参数校验 | 手写校验（`packages/server/src/session.ts`） | — | 消息种类少、错误文案要中文；引入 schema 库的收益不如三行 `if` |
| 测试 | **`node:test` 内置** + TS 直跑（非 Vitest） | Node 22.18+ | Node 22 原生支持直接执行 `.ts`（type stripping），省掉 vitest 依赖与转译层 |
| 测试（前端逻辑） | `node:test` + `packages/web/test/loader.mjs` | — | 前端逻辑（driver / store / 存储）在 Node 里就能跑：loader 把 `@aixx/core` 与 `@/` 重定向到源码，`localStorage` / `fetch` / `document` 用内存替身顶掉。**不能直接让 `@aixx/core` 走 node_modules** —— Node 不会对 node_modules 下的 `.ts` 做 type stripping |
| E2E 回归 | 无头浏览器 + DevTools 协议（脚本化点击 + 截图） | — | 不引 Playwright：五条主流程用 CDP 驱动即可，零额外依赖、脚本可随时改 |

**前端不引入的**：UI 组件库、CSS 框架、图标库（用内联 SVG）、国际化库（中文单语）。

### 2.4 被否决的方案与理由

| 方案 | 否决理由 |
| --- | --- |
| Socket.IO | 自带协议封装与降级逻辑，包体大、帧不可见、调试难；本项目的消息量很小，不需要 |
| 数据库（SQLite/Postgres） | 需求明确无长期成绩；引入后部署门槛与运维成本陡增 |
| Supabase / Firebase Realtime | 无法做权威裁决（抢答排序、接力计时必须在自己的服务端） |
| Next.js / SSR | 纯静态优先，SSR 增加部署形态与构建复杂度，零收益 |
| UI 组件库（Element Plus / Ant Design） | 题库站视觉简单，组件库带来体积与样式覆盖成本；自写 CSS 变量更可控 |
| 前端直接置入赛制逻辑 | 会导致前端一套、后端一套，规则必然漂移（AC-11 会失败） |
| snake_case ↔ camelCase 转换层 | 题库与试卷由教练手改 JSON，磁盘已是 snake_case；再加一层 mapper，等于给每个字段准备一个写错的机会。**全链路 snake_case，不设转换层** |

---

## 3. 命名与数据契约

命名在这里不是风格问题，而是**契约问题**：磁盘 JSON、WS 帧、TS 接口三者同名同形，才能做到零转换、零映射、零"这个字段前端叫什么来着"。

- **数据契约一律 `snake_case`**：磁盘 JSON、WS 帧、TS 接口字段同名同形，零转换。
- 函数名与局部变量 `camelCase`；类型名 `PascalCase`；常量 `UPPER_SNAKE`。
- 时间单位**全部写进字段名**：`*_at` 是 epoch 毫秒，`*_sec` 是秒，`*_ms` 是毫秒。禁止叫 `timeout`、`duration` 这种不带单位的字段。

---

## 4. 仓库与目录结构

```
aixx-arena/
├─ package.json                     # npm workspaces 根；脚本：test / typecheck / dev:web / build:web / pack:win …
├─ .npmrc                           # registry=https://registry.npmmirror.com
├─ tsconfig.base.json               # 共享编译选项（strict、NodeNext、allowImportingTsExtensions…）
├─ README.md                        # 三条快速开始路径 + 五赛制能力表
├─ docs/
│  ├─ requirements.md               # 需求基线 v0.3（已拍板）
│  └─ design.md                     # 本文
├─ data/                            # 题库与试卷的唯一起源（其余产物都从它生成）
│  ├─ questions/                    # 单题一 JSON（87 道，q-tmp-*.json）+ _import-report.md
│  └─ papers/                       # 5 份试卷配置
│     ├─ paper-school-55.json
│     ├─ paper-team-solo-10.json
│     ├─ paper-team-coop-10.json
│     ├─ paper-relay-5x3.json
│     └─ paper-buzz-01.json
├─ packages/
│  ├─ core/                         # 纯逻辑，零运行时依赖
│  │  ├─ src/
│  │  │  ├─ types.ts                # Question / Paper / DrawSpec / ScoringConfig / BuzzConfig
│  │  │  ├─ scoring.ts              # 判分纯函数（judge / normalizeScore / maxRawPoints）
│  │  │  ├─ draw.ts                 # 组卷（降级、固定种子、题型配额、跨分棒去重）
│  │  │  ├─ buzz.ts                 # rankBuzz：名额、5ms 并列聚簇、strict/fill
│  │  │  ├─ rng.ts                  # mulberry32 确定性随机
│  │  │  ├─ public.ts               # 公共视图类型（PublicMatchState / OwnView / MatchSummary）
│  │  │  ├─ protocol.ts             # ClientMsg / ServerMsg / ErrorCode
│  │  │  ├─ state.ts                # MatchEvent / Effects / ReduceCtx / FormatSpec / MatchState 联合
│  │  │  ├─ index.ts                # 对外出口（web 与 server 都从这里 import）
│  │  │  └─ formats/
│  │  │     ├─ index.ts             # 注册表 + initMatch / reduce / view / isEnded / summarize 分发
│  │  │     ├─ sheet.ts             # solo 与 team-solo 共用的答卷逻辑（含 FINISH 封卷）
│  │  │     ├─ solo.ts              # 赛制 1
│  │  │     ├─ teamSolo.ts          # 赛制 2（按队汇总）
│  │  │     ├─ teamCoop.ts          # 赛制 3（1 答 2 辅，团队共享游标）
│  │  │     ├─ relay.ts             # 赛制 4（三棒、剩余时间继承）
│  │  │     └─ buzz.ts              # 赛制 5（缓冲→开抢→公布）
│  │  └─ test/                      # 11 个测试文件（scoring / draw / buzz / solo / team* / relay / finish / formatBuzz）
│  ├─ web/
│  │  ├─ index.html
│  │  ├─ vite.config.ts             # base:'./'、@aixx/core 与 @ 别名
│  │  ├─ public/data/bank.json      # sync-data 生成：题库 + 试卷单文件（静态模式下一次 fetch）
│  │  ├─ src/
│  │  │  ├─ main.ts / router.ts / env.ts
│  │  │  ├─ app/App.vue             # 顶栏 + 模式标签（本地 / 联机 · 房间）
│  │  │  ├─ app/pages/              # Home / Play / Result / Join / Room / Settings / About
│  │  │  ├─ drivers/
│  │  │  │  ├─ types.ts             # Driver 接口：页面只消费 ServerMsg
│  │  │  │  ├─ localDriver.ts       # 静态模式：自己跑 reduce + 送 TICK
│  │  │  │  └─ serverDriver.ts      # 房间模式：一条 WS + 重连 + 时钟偏移
│  │  │  ├─ stores/matchStore.ts    # reactive() 单例：本地/联机双模式、快照投影、落盘
│  │  │  ├─ storage/matchStorage.ts # localStorage 对局记录、room session、房间成绩
│  │  │  ├─ components/             # QuestionCard / QuestionPalette / CountdownTimer
│  │  │  ├─ data/bank.ts            # 题库加载、试卷题目数与满分推算
│  │  │  └─ styles/base.css         # CSS 变量 + 组件样式（无 UI 库）
│  │  └─ test/                      # loader.mjs + driver/store 逻辑测试
│  └─ server/
│     ├─ src/
│     │  ├─ main.ts                 # CLI 参数（--port/--host/--web-root/--data-root/--max-rooms）与启动
│     │  ├─ server.ts               # 房间与参与者注册表、协议路由、开赛/结算生命周期
│     │  ├─ rooms.ts                # 6 位房间码/团队码、容量、roster、个性化大厅快照
│     │  ├─ session.ts              # 会话、hello 超时、帧上限、限流、断线宽限
│     │  ├─ driver.ts               # MatchDriver：把 events 喂 core、把 effects 落地、广播快照
│     │  ├─ http.ts                 # 静态托管 + SPA 兜底 + /healthz
│     │  ├─ data.ts                 # 题库/试卷加载（只读副本，客户端拿不到 answer）
│     │  └─ core.ts                 # 相对路径 re-export core（绕开 node_modules 解析）
│     └─ test/                      # helpers.ts + online.test.ts（11 条联机验收）
├─ deploy/
│  ├─ linux/{Dockerfile,docker-compose.yml,README.md}
│  └─ windows/README.md             # 便携包怎么用、连不上怎么排查
└─ scripts/
   ├─ import-questions.mjs          # 已确认题目 → data/questions
   ├─ generate-papers.mjs           # 生成 5 份试卷 + §9.2 自检
   ├─ sync-data.mjs                 # data/ → packages/web/public/data/bank.json
   ├─ verify-data.mjs               # 题库/试卷一致性断言
   └─ pack-release.mjs              # 打 Windows 便携包（node.exe + 代码 + 数据 + ws）
```

**依赖方向（强约束）**：`web → core`、`server → core`，`core` 不依赖任何人；`web` 与 `server` 之间零代码依赖，只共享 `core` 里的类型与协议。

---

## 5. 核心包设计（packages/core）

### 5.1 题库与试卷类型

```ts
export type QuestionType = 'single' | 'multiple' | 'judge'

export interface Question {
  schema_version: 1
  id: string
  type: QuestionType
  title?: string
  stem: string
  stem_images?: string[]
  options: { key: string; text: string }[]
  answer: string[]
  answer_status: 'pending' | 'verified' | 'disputed' | 'expired'
  explain?: string
  taxonomy?: string[]
  difficulty?: 1 | 2 | 3
  score?: number
  exam_year?: number
  round?: string
}

export type FormatId = 'solo' | 'team-solo' | 'team-coop' | 'relay' | 'buzz'

export interface DrawSpec {
  single?: number
  multiple?: number
  judge?: number
  taxonomy?: string[]
  difficulty?: (1 | 2 | 3)[]
  min_available: number
  allow_partial: boolean
  seed?: number | null
}

export interface ScoringConfig {
  mode: 'per_question' | 'correct_minus_wrong'
  points: Record<QuestionType, number>
  wrong_penalty: number
  unanswered: number
  total_normalize: number       // 0 = 不折算
}

export interface BuzzConfig {
  buffer_ms: number             // 题面广播后禁抢缓冲
  submit_window_sec: number     // 开抢窗口
  qualify_ratio: number         // 0.5
  qualify_fill: 'strict' | 'fill'
  correct_points: number
  wrong_points: number
  reveal_sec: number
  close_on_all_submitted: boolean
  tie_window_ms: number         // 并列判定窗口，默认 5
}

export interface Paper {
  schema_version: 1
  id: string
  name: string
  format: FormatId
  duration_sec: number          // 全局时长；buzz 为 0（每题自己的窗口）
  draw: DrawSpec | null         // relay 卷为 null，题量全部落在 legs
  legs?: [DrawSpec, DrawSpec, DrawSpec] | null
  submit_mode: 'batch' | 'stream'
  scoring: ScoringConfig
  buzz?: BuzzConfig             // 仅 format='buzz' 必填
}
```

**没有 `judge_location` 字段**（v0.1 有、v0.2 删）。判分位置不是试卷属性，而是运行模式的推论：只要连了后端就在服务端判（需求 D13）。写进试卷只会制造"配置说前端判、实际有后端"的矛盾。

### 5.2 判分引擎

```ts
export interface JudgeInput {
  question: Question
  choice: string[]
  scoring: ScoringConfig
  answered: boolean
}
export interface JudgeOutput {
  correct: boolean
  points: number        // 可为负（答错扣分）
  scored: boolean       // false = 该题无已验证答案，不计分
}
export function judge(input: JudgeInput): JudgeOutput
```

规则：
- `answer_status !== 'verified'` 或 `answer` 为空 → `scored: false, points: 0`，从满分分母中剔除。
- 单选/判断：`choice.length === 1 && choice[0] === answer[0]`。
- 多选：集合相等（排序后比）才算对；少选/多选/错选均视为答错。
- 未答：`points = scoring.unanswered`（默认 0），`correct: false`。
- 答错：`points = scoring.mode === 'correct_minus_wrong' ? -wrong_penalty : 0`。
- 百分制折算：`normalize(raw, max_raw)` → `round(raw / max_raw * total_normalize)`，`max_raw` 只累计 `scored: true` 的题。

**这个函数是 AC-11 的契约点**：前端与后端必须 import 同一个实现。

### 5.3 组卷

```ts
export interface DrawResult {
  questions: Question[]
  degraded: boolean
  available_count: number
  requested_count: number
  notice?: string          // "本卷 40/55 题有答案，满分按 40 题折算"
}

export function draw(
  pool: Question[],
  spec: DrawSpec,
  seed: number,
  used_ids?: Iterable<string>,   // 已用过的 qid，接力分棒时逐棒累加
): DrawResult
```

- 只从 `answer_status === 'verified'` 且有 `answer` 的题里抽，且排除 `used_ids` 里的题。
- 按 `(spec.seed ?? seed)` 初始化 mulberry32，保证同种子同卷。
- 不足时：若 `allow_partial`，按比例缩减各题型（`floor(need * available / requested)`，余数补到单选）；否则抛 `INSUFFICIENT_POOL`。
- 可用数 < `min_available` → 拒绝组卷。

**接力分棒（v0.2 定）**：

```ts
function drawRelay(pool: Question[], paper: Paper): { legs: Question[][]; degraded: boolean; notice?: string } {
  const used = new Set<string>()
  const legs: Question[][] = []
  for (let i = 0; i < 3; i++) {
    const spec = paper.legs![i]
    const seed = (spec.seed ?? paper.legs![0].seed ?? 2026) + i * 1000
    const r = draw(pool, spec, seed, used)
    r.questions.forEach(q => used.add(q.id))
    legs.push(r.questions)
  }
  return { legs, ... }
}
```

- 三段互不重复由 `used_ids` **串行传差集**保证，不靠"换个种子碰运气"。
- 每段题数可以不同（默认各 5 题），但必须都 > 0。

### 5.4 赛制状态机契约

```ts
export type EndReason = 'time' | 'host' | 'self' | 'all_done'

export interface MatchEvent {
  type: 'START' | 'SUBMIT' | 'ADVANCE' | 'HANDOFF' | 'SET_ANSWERER' | 'FINISH' | 'TICK' | 'END'
  at: number                    // epoch ms，由驱动注入
  actor_id?: string             // 谁触发（成员 id）
  team_id?: string
  qid?: string
  choice?: string[]
  member_id?: string            // SET_ANSWERER 的目标
  reason?: EndReason
  /** 客户端自增序号，仅 SUBMIT 需要（每 participant 每局单调递增，§5.9） */
  seq?: number
}

/** 开赛瞬间固化进 state 的成员快照；开赛后不再变动 */
export interface Roster {
  teams: {
    id: string
    name: string
    member_ids: string[]
    captain_id: string
  }[]
  /** 成员显示名；缺省回退成 id（静态模式的占位成员可以不给） */
  names?: Record<string, string>
}

export interface ReduceCtx {
  paper: Paper
  questions: Question[]         // 已组卷；接力已按棒切分
  roster: Roster                // 由驱动构造（服务端=房间成员；静态=虚构成员，见 §6.5）
  degraded_notice?: string      // 组卷降级提示，落到 summary.degraded_notice
}

export interface Effects {
  broadcast?: Outgoing[]
  to_team?: { team_id: string; messages: Outgoing[] }[]
  to_member?: { member_id: string; messages: Outgoing[] }[]
  timers?: { key: string; at: number }[]   // 绝对时刻；驱动负责设/清
  log?: LogEntry[]
}

export interface FormatSpec<S extends MatchStateBase> {
  id: FormatId
  init(ctx: ReduceCtx, at: number): S
  reduce(state: S, event: MatchEvent, ctx: ReduceCtx): { state: S; effects: Effects }
  /** 剥离答案、按视角裁剪后的状态；roster 已在 state 里，不需要 ctx。
   *  `at` 由驱动传入（view 同样不许读系统时间，`server_at` 才可复现） */
  view(state: S, viewer_id: string | null, at: number): PublicMatchState
  is_ended(state: S): boolean
  summarize(state: S, ctx: ReduceCtx): MatchSummary
}
```

**两个关键修正（相对 v0.1）**：

1. `view` 不再收 `ctx`，`roster` 在 `init` 时**固化进 state**。理由：重连快照必须自足（服务端不能保证重连时房间成员还和开赛时一致），且 `LocalDriver` 也必须能构造它。代价是开赛后不许有人加入/退出/换队——这本来就是赛制要求（`ROOM_STARTED` 拒绝加入）。
2. `state` 统一带 `format` 判别字段，房间只持有一个 `MatchState` 联合类型，不写五份分支：

```ts
export interface MatchStateBase {
  format: FormatId
  roster: Roster
  phase: string
  started_at: number
  deadline_at: number
  ended_at?: number
  end_reason?: EndReason
  /** 本局题量（view 拿不到 ctx，必须能给出 PublicBase.total） */
  total: number
  /** 组卷降级提示（"本卷 40/55 题有答案"），init 时从 ctx 固化进来 */
  notice?: string
}

export type MatchState =
  | SoloState
  | TeamSoloState
  | TeamCoopState
  | RelayState
  | BuzzState        // 各自 extends MatchStateBase

export function reduce(state: MatchState, event: MatchEvent, ctx: ReduceCtx): { state: MatchState; effects: Effects }
// 内部：const spec = registry[state.format]；按 state.format 收窄后再调 spec.reduce
```

**事件推进表（v0.2 新增，补 v0.1 的缺口）**：v0.1 有「进入下一题」这个交互，却没有对应事件，导致 team-coop / relay 的题序无人推进。

| 赛制 | 题序游标在哪 | 谁推进 | 「下一题」怎么做 |
| --- | --- | --- | --- |
| `solo` | 客户端本地 | 选手自己 | 不发事件；服务端只在 `END` 时按 qid 收卷 |
| `team-solo` | 每人客户端本地 | 各自选手 | 不发事件 |
| `team-coop` | **state（团队共享）** | 主答或队长 | `ADVANCE`：`current_index + 1`；到 `total - 1` 后再 `ADVANCE` ≡ 本队 `submit_all` |
| `relay` | **state（当前棒）** | 当前棒选手 | `ADVANCE`：棒内 `current_index + 1`；到本棒最后一题后再 `ADVANCE` ≡ `HANDOFF` |
| `buzz` | state（全局） | 状态机自己 | 无需事件；`TICK` 驱动 buffer→open→closed→reveal→下一题 |

`solo` / `team-solo` 的游标不进状态机，是因为它们的题序对判分毫无影响（交卷时按 qid 对齐），放进状态机只会让两端的游标同步变成一个新的故障点。

### 5.5 公共视图与结算类型

v0.1 只写了这些类型的名字，v0.2 把字段补齐。

```ts
export interface PeerInfo {
  id: string
  name: string
  team_id: string
  online: boolean
  ready: boolean
  progress: { answered: number; total: number }   // 队友进度（FR-22）
  is_answerer: boolean
  leg_index?: number                              // 仅 relay
}

export interface OwnView {
  /** 视角主体：member=本人（solo / team-solo），team=本队（team-coop / relay / buzz） */
  scope: 'member' | 'team'
  /** 该视角下已提交的题；team 视角 = 本队共享答卷（三端一致） */
  answers: Record<string, string[]>
  locked: string[]
  /** 当前观众此刻能否提交（辅助 / 非当前棒 = false，UI 据此禁用按钮） */
  can_submit: boolean
  /** 本人是否已封卷（team-solo 早交的人要看到「等队友」而不是以为还能改） */
  finished?: boolean
}

export interface PublicBase {
  format: FormatId
  phase: string
  server_at: number                   // 服务端此刻的时间，客户端据此算偏移
  clock: {
    started_at: number
    deadline_at: number
    leg_deadline_at?: number          // relay：本棒截止
    submit_deadline_at?: number       // buzz：本题开抢截止
    reveal_end_at?: number            // buzz：本题解析停留结束
  }
  current_index: number | null        // null = 该赛制的游标在客户端
  total: number
  viewer_id: string | null
  own: OwnView
  peers: PeerInfo[]
  scores?: { team_id: string; name: string; score: number }[]
  notice?: string
}

export type PublicMatchState =
  | (PublicBase & { format: 'solo' })
  | (PublicBase & { format: 'team-solo'; team: { id: string; answered: number; total: number } })
  | (PublicBase & { format: 'team-coop'; team_id: string; answerer_id: string })
  | (PublicBase & { format: 'relay'; team_id: string; leg_index: number; leg_order: string[]; current_answerer_id: string })
  | (PublicBase & { format: 'buzz'; q_index: number; n_at_open: number; submitted_teams: string[]; quota: number })

export interface TeamResult {
  id: string
  name: string
  score: number
  max_score: number
  members: { id: string; name: string; score: number; answered: number; correct: number }[]
  detail: {
    qid: string
    leg_index?: number
    choice: string[] | null
    correct: boolean
    points: number
    late_by_ms?: number        // 断线补交的延迟，复盘标黄
  }[]
}

export interface MatchSummary {
  format: FormatId
  started_at: number
  ended_at: number
  end_reason: EndReason
  teams: TeamResult[]
  questions: { qid: string; type: QuestionType; answer: string[]; explain?: string; scored: boolean }[]
  degraded_notice?: string
  buzz_per_question?: {
    qid: string
    n_at_open: number
    quota: number
    close_reason: 'timeout' | 'all_submitted'
    ranking: { team_id: string; at: number; correct: boolean; rank: number; tied: boolean; awarded: number }[]
  }[]
}

export interface LogEntry {
  at: number
  event: string               // room_created / join / early_submit / auto_submit / handoff / ...
  participant_id?: string
  team_id?: string
  qid?: string
  data?: Record<string, unknown>
}
```

### 5.5.1 交卷与结束语义（v0.3 新增，v0.7 补 `FINISH`）

v0.2 只给 solo 写了 `END`，于是 §5.9 里「team-solo / team-coop / relay 交卷后一次性 reveal」没有任何动作能触发。补齐如下（`submit_all` 是**协议消息**，落到状态机是 `FINISH` / `END` 两类事件）：

| 赛制 | 谁的「交卷」 | 触发事件 | 结算范围 |
| --- | --- | --- | --- |
| solo | 本人 | `submit_all` → `FINISH`（本人封卷）；单人即全员封卷 → 立即 `END{reason:'all_done'}` | 该 participant |
| team-solo | 每个成员各自交 | `submit_all` → 该成员 `FINISH` 封卷；**全员封卷或全局到期**才结算 | 该 member（团队分 = Σ 成员分） |
| team-coop | 该队主答 | `submit_all` → `END{reason:'self'}`（只结算该队），或最后一题再 `ADVANCE` → 该队封卷；全部队封卷或到期 → 全场结算 | 该 team |
| relay | 当前棒选手 | `submit_all` → `FINISH`，连续交棒直至第 3 棒结束；或第 3 棒 `HANDOFF` | 该 team |
| buzz | 无「交卷」概念 | 题序走完（最后一题 reveal 结束） | 全部 team |

- **`FINISH` = 本人封卷**：只影响自己的答卷（`sheet.finished_at`），已封卷再 `SUBMIT` 回 `WINDOW_CLOSED`；未到齐时向本人发 `notice`「你已封卷，X/Y 人完成，等待队友」，UI 显示「已封卷」并禁用选项。
- **房主 `end`**：任何赛制、任何时刻 → 立即结算全场，`END{reason:'host'}`；未封卷的答卷按「截至此刻已答内容」结算。
- **`reveal` 的广播范围跟着封卷范围走**：solo / team-solo 只发给本人；team-coop / relay 只发给该队；buzz 在本题 `closed` 即刻全房广播。全场 `ended` 时再统一发 `summary`（内含逐题答案，供成绩页）。
- **重复交卷**：已封卷的 scope 再收 `submit_all` → 忽略（幂等），不回错误。

### 5.6 五个赛制的状态与事件

#### solo（赛制 1，校赛）

```ts
interface Sheet {
  answers: Record<string, { choice: string[]; at: number; seq: number }>
  locked: string[]                       // 仅 stream
  judged?: Record<string, { correct: boolean; points: number; scored: boolean }>  // END 时算
}
interface SoloState extends MatchStateBase {
  format: 'solo'
  sheets: Record<string /* member_id */, Sheet>
}
```

```
START   : phase='answering', deadline_at = at + duration_sec*1000
SUBMIT  : batch  → 记入 answers[qid]（**不判分**），ack{accepted:true}
          stream → 已锁则拒绝；否则 judge，记 locked + ack{correct, points}
ADVANCE : 无意义（游标在客户端）
TICK    : at >= deadline_at → END{reason:'time'}
END     : 逐人 judge 未判的题 → phase='ended'，产出 MatchSummary
TICK 幂等：phase 已是 ended 则忽略
```

#### team-solo（赛制 2，个人对抗）

```ts
interface TeamSoloState extends MatchStateBase {
  format: 'team-solo'
  sheets: Record<string /* member_id */, Sheet>   // 与 solo 同构
}
```

```
START   : 所有人同一 deadline_at
SUBMIT  : 校验 actor_id 属于某成员的 sheet → stream 立即 judge → ack(correct)
          （batch 不用于此赛制，配置写错则在 validate 阶段拒绝）
ADVANCE : 无（每人本地游标）
TICK    : 到期 → 逐队结算，团队总分 = Σ 成员分
```

> `solo` 与 `team-solo` 的 sheet 逻辑是同一段代码，只在 `summarize` 上分叉：solo 按人出成绩，team-solo 按队聚合。不做两份实现。

#### team-coop（赛制 3，团队对抗）

```ts
interface CoopTeamState {
  answerer_id: string
  current_index: number
  answers: Record<string, { choice: string[]; at: number; correct: boolean; points: number }>
  locked: string[]
}
interface TeamCoopState extends MatchStateBase {
  format: 'team-coop'
  teams: Record<string /* team_id */, CoopTeamState>
}
```

```
START   : 每队 answerer_id = captain_id，current_index = 0
SUBMIT  : 仅该队 answerer_id 可提交；stream 立即判分；本题锁定（锁定 ≠ 移出题面）
ADVANCE : 仅该队 answerer_id 或 captain_id → current_index+1；到末尾 → 该队交卷
SET_ANSWERER : 队长或房主 → 换主答（掉线接管），写日志
TICK    : 全局到期 → 所有队结算
```

#### relay（赛制 4，接力）

```ts
interface RelayTeamState {
  leg_order: string[]        // 恰好 3 个 member_id；开赛瞬间固化（优先用赛前指定顺序）
  leg_index: 0 | 1 | 2
  current_index: number      // 棒内题号，交棒时归零
  leg_started_at: number
  leg_budget_sec: number     // 本棒预算 = X + carry
  carry_sec: number
  answers: Record<string, { choice: string[]; at: number; correct: boolean; points: number; by: string; leg_index: number }>
  finished_at?: number
}
interface RelayState extends MatchStateBase {
  format: 'relay'
  leg_question_ids: [string[], string[], string[]]   // 三棒共用的题目切分
  teams: Record<string /* team_id */, RelayTeamState>
}
```

```
START   : 所有队 leg_index=0，budget=X，leg_started_at=at
          global deadline_at = at + 3X*1000
SUBMIT  : 仅当前棒选手、且 qid ∈ leg_question_ids[leg_index]
          同一 qid 可在本棒内反复提交：覆写并重新判分（多选逐次勾选即逐次覆写）
          本棒内已答不锁定；交棒后历史棒不可再提交
ADVANCE : 仅当前棒选手。current_index += 1
          若 current_index > 本棒题数-1 → 等价 HANDOFF；否则只前进（不动时间预算）
HANDOFF : 仅当前棒选手（或 TICK 强制 / 断线 30s 自动 / 棒尾 ADVANCE 等价触发）
          carry = max(0, budget_sec - (at - leg_started_at)/1000)
          下一人 = leg_order[leg_index+1]，budget = X + carry，leg_started_at = at
          leg_index += 1，current_index = 0
          第 3 棒 HANDOFF → 该队 ended（finished_at = at）
TICK    : (at - leg_started_at)/1000 >= leg_budget_sec → 强制 HANDOFF
          at >= deadline_at → 全部结算
```

**棒次到人的映射（v0.2 定，v1.1 支持赛前指定）**：
- 开赛前，队长可在房间大厅用 `set_leg_order` 指定本队棒次（必须是本队队员的一个排列），开赛瞬间固化。
- 开赛时 `leg_order` = 队伍成员；未指定时顺序为「队长在首位，其余按加入顺序」，取前 3 人。
- 不足 3 人（2 人队）：按顺序循环补齐，例如 `[A, B, A]`，并在开局日志里写 `relay_short_team`。
- 掉线 30s 自动交棒：按连续交棒处理，时间照走；最后一棒掉线 → 该队直接结算。

#### buzz（赛制 5，抢答）

```ts
interface BuzzState extends MatchStateBase {
  format: 'buzz'
  qids: string[]
  q_index: number
  phase: 'buffer' | 'open' | 'closed' | 'reveal' | 'ended'
  open_at: number
  submit_deadline_at: number
  reveal_end_at: number
  n_at_open: number                        // 本题开抢瞬间的队数（roster 里有成员的队）
  close_reason?: 'timeout' | 'all_submitted'
  announced: boolean                       // 题面是否已推（缓冲期先推，见下）
  qualify_ratio: number                    // 从 paper.buzz 固化（view 拿不到 ctx）
  reveal_ms: number                        // 解析停留时长，同样固化
  submissions: { team_id: string; at: number; choice: string[]; correct: boolean; late: boolean }[]
  scores: Record<string, number>
  per_question: NonNullable<MatchSummary['buzz_per_question']>
}
```

```
START   : q_index=0 → buffer，open_at = at + buffer_ms
TICK    : phase=buffer 且未 announce → 推题面 { question, buffer_ms, deadline_at: open_at }
          phase=buffer 且 at >= open_at → open，n_at_open=队数，submit_deadline_at = open_at + window
          phase=open  且 (at >= submit_deadline_at 或 全员已交) → closed → rankBuzz → 计分 → reveal
          phase=reveal 且 at >= reveal_end_at → 下一题 buffer，或 ended
SUBMIT  : phase=buffer → 丢弃 + log early_submit
          phase!=open → 丢弃（WINDOW_CLOSED）
          该队本题已交 → 丢弃（幂等）
          记录 { team_id, at, choice, correct: judge(...) }，回 ack{correct} 并广播 score
结算    : 调 rankBuzz()（§5.7），名额内答对 → +correct_points，答错 → +wrong_points
          未获名额 → 0
```

**题面先出（v0.9）**：缓冲期就必须把题面推下去（玩家有 `buffer_ms` 看题时间），所以 `BuzzState` 带 `announced`，由 `TICK` 触发 `announceQuestion()`；开抢时只在 `!announced` 时兜底补推。两个驱动器的 `start()` 都先送一个开局 `TICK`，否则状态机没有任何事件可推题面。

**提前关闭（v0.2 新增，v0.3 修正）**：`close_on_all_submitted` 默认 `true`（抢答卷配置里显式关掉，让每道题都跑满 20s 窗口，更像现场抢答）。
- 「全员」= `n_at_open` 支队中，**本题窗口内已产生有效提交**的队数。全部提交则立即 `closed`。
- **掉线队不参与本题排名**：断线宽限 30s 长于开抢窗口（默认 20s），等宽限到期时窗口早已关闭——服务端此时再"补交"一个迟到的答案没有意义，只会污染排序。故 buzz 的断线自动提交**不产生提交记录**，该队本题 0 分，日志记 `buzz_missed`。
- 若该队在窗口内重连成功，按正常路径提交，`at` 用真实收包时刻。
- 因此「提前关闭」不会因为有人掉线而永远等不到。

### 5.7 抢答排序：独立纯函数 `rankBuzz`

v0.1 把排序逻辑写在状态机注释里，既没法单测，也没有并列规则。v0.2 抽成函数：

```ts
export interface BuzzSubmission { team_id: string; at: number; correct: boolean }

export interface BuzzRankInput {
  submissions: BuzzSubmission[]
  n_at_open: number
  qualify_ratio: number          // 0.5
  qualify_fill: 'strict' | 'fill'
  tie_window_ms: number          // 默认 5
  correct_points: number
  wrong_points: number
}

export interface BuzzRankResult {
  quota: number                  // ceil(n_at_open * ratio)
  ranking: {
    team_id: string
    at: number
    correct: boolean
    rank: number                 // 并列者同名次
    tied: boolean
    in_quota: boolean
    awarded: number
  }[]
  boundary_tie_expanded: boolean // 名额边界被并列撑开
}

export function rankBuzz(input: BuzzRankInput): BuzzRankResult
```

算法（必须按这个顺序实现，否则并发结果不可复现）：

1. 按 `at` 升序；`at` 相同时按 `team_id` 字典序（保证确定性，不依赖 V8 排序稳定性）。
2. 聚簇：若 `at[i] - at[i-1] <= tie_window_ms` 则并入同一簇；簇的 `rank` = 簇首下标 + 1。
3. `quota = Math.ceil(n_at_open * qualify_ratio)`。
4. `in_quota = rank <= quota`。**若某簇跨越名额边界，整簇计入**（`boundary_tie_expanded = true`），但计入后总数不超过 `n_at_open`。
5. `strict`：名额内答对得分、答错得 `wrong_points`、未交 0；名额外的答对也是 0。
6. `fill`：名额内没答对留下的空位，按排名顺延给后面答对的队，补满名额为止。

**为什么必须用 `ceil`**：N=3 → 2 个名额，N=4 → 2，N=5 → 3。「前 50%」对奇数队伍必须偏向抢答方。

### 5.8 协议类型

```ts
export type ClientMsg =
  | { t: 'hello'; v: number; name: string; resume_id?: string }
  | { t: 'create'; format: FormatId; paper_id: string }
  | { t: 'join'; room_code: string }
  | { t: 'new_team'; name: string }
  | { t: 'join_team'; team_code: string }
  | { t: 'ready'; value: boolean }
  | { t: 'start' }
  | { t: 'submit'; qid: string; seq: number; choice: string[] }
  | { t: 'advance' }                     // 团队下一题
  | { t: 'handoff' }                     // 接力交棒
  | { t: 'submit_all' }                  // 本人/本队交卷
  | { t: 'end' }                         // 房主终止全局
  | { t: 'set_answerer'; member_id: string }
  | { t: 'set_leg_order'; order: string[] }   // 接力赛前分配本队棒次（仅队长，未开赛）
  | { t: 'ping'; t0: number }
  | { t: 'feedback'; qid: string; reason: string }
  | { t: 'leave' }

export type ServerMsg =
  | { t: 'hello_ok'; participant_id: string; server_at: number; version: string; protocol: number }
  | { t: 'lobby'; room_code: string; format: FormatId; paper_id: string; host_id: string;
      started: boolean; viewer_id: string; team_id: string | null; teams: LobbyTeam[];
      waiting: { id: string; name: string; ready: boolean }[] }
  | { t: 'paper'; questions: PaperQuestion[] }
  | { t: 'room'; snapshot: PublicMatchState }
  | { t: 'question'; index: number; total: number; qid: string; type: QuestionType;
      stem: string; stem_images?: string[]; options: { key: string; text: string }[];
      buffer_ms: number; deadline_at: number }
  | { t: 'ack'; seq: number; qid: string; accepted: boolean; locked: boolean;
      correct?: boolean; points?: number }
  | { t: 'reveal'; items: { qid: string; answer: string[]; explain?: string }[] }
  | { t: 'peer'; members: PeerInfo[]; ready_count: number }
  | { t: 'score'; teams: { id: string; name: string; score: number }[] }
  | { t: 'sync'; server_at: number }
  | { t: 'notice'; text: string }
  | { t: 'ended'; summary: MatchSummary }
  | { t: 'error'; code: ErrorCode; message: string; fatal?: boolean }
  | { t: 'pong'; t0: number; server_at: number }
```

`protocol` 是整数版本号，前后端不一致直接拒绝连接（FR-51）。

**v0.6 新增两条消息（P3 联机所需，7 处说明凑齐才不至于边写边猜）：**

- `lobby`：开局前的唯一状态源。字段：房间号、赛制、试卷、房主、是否已开赛、观众 id、自己所在队伍、全部队伍（`LobbyTeam{id,name,code?,members[],leg_order?}`，`code` 只发给本队成员；relay 的 `leg_order` 是当前棒次顺序，队员为 `members` 的 id）、未分队散人。任何人员/准备/棒次变化都重发给全房。
- `paper`：开局瞬间发给每位选手的整卷题面。元素是 `PaperQuestion{id,type,stem,stem_images?,options,difficulty?,taxonomy?,source?}` —— **没有 `answer` / `explain`**，答案只能从 `reveal` 出。solo / team-solo / team-coop 需要整卷（选手要自由翻题），relay / buzz 用 `question` 逐题推送。

`question` 逐题推送只给 relay / buzz 用：`buffer_ms` 是禁抢缓冲，`deadline_at` 是本题作答截止（绝对毫秒）。

**v0.7 新增 `notice`**：服务端给单个玩家的一句人话提示（「你已封卷，1/2 人完成，等待队友」「轮到你了：第 2 棒，剩余 596 秒」）。前端只把它显示成一条横幅，不参与状态判断——状态判断永远看快照。

### 5.9 消息时机表（v0.2 新增）

v0.1 说「UI 只消费 ServerMsg」，但 batch 模式既不产生 `ack` 也不产生 `reveal`，`seq` 与答案下发时机三处说法不一。没有这张表，「两个 Driver 共用一套 UI」这个不变量在静态模式就不成立，组件里迟早长出 `if (mode === 'local')`。

| 赛制 / 模式 | `submit` 后的 `ack` | `reveal` 时机 | 快照 `room` 里带 answer? |
| --- | --- | --- | --- |
| solo（batch） | `{accepted:true, locked:false}`，**不带 correct** | 交卷后一次性全卷 | ❌ |
| team-solo（stream） | `{accepted, locked:true, correct, points}` | 交卷后一次性全卷 | ❌ |
| team-coop（stream） | 同上 | 交卷后一次性全卷 | ❌ |
| relay（stream，本棒内可覆写） | `{accepted:true, locked:false, correct, points}`；同题重复提交覆写并重判；交棒后历史棒再提交被拒（`BAD_MESSAGE`） | 交卷后一次性全卷 | ❌ |
| buzz（stream） | `{accepted, locked:true, correct}` | 本题 `closed` 后立即 `reveal`（含解析），停留 `reveal_sec` | ❌ |

补充规则：

- **`ack` 永不携带 `answer` / `explain`**，只带 `correct` / `points`。答案只能从 `reveal` 出。
- **`seq` 语义**：每个 participant 在每个 match 内**单调递增**，从 1 开始。服务端保存 `last_seq`，`seq <= last_seq` → `STALE_SEQ`（丢弃，不回 ack）；接受后 `last_seq = seq` 并回 `ack{seq}`。这样重连补发天然幂等。
- **`LocalDriver` 必须合成同构消息**：它内部跑 `reduce`，然后把 `effects` 转成与 ServerMsg 完全相同的对象，自己维护一个 `seq` 计数器。UI 拿到的消息流，两种模式**逐字段一致**。
- **UI 不得直接读 `MatchState`**，只能读 `room.snapshot` 与过程消息。这是审计点，写入代码评审清单。
- **relay 是 stream 的「棒内可改」变体**：本棒内同一题可反复提交并覆写重判（`locked:false`），多选因此能逐次勾选、答错能改；交棒瞬间把此前各题锁进历史棒，之后不可再改。`OwnView.locked` 只列已交棒历史棒的 qid（封卷后列全部）。

---

## 6. 前端设计（packages/web）

### 6.1 路由（hash 模式）

| 路径 | 页面 | 说明 |
| --- | --- | --- |
| `#/` | Home | 五张赛制卡片（可离线 / 需联机状态）+ 题库概况 + 「继续上次练习」+ 历史成绩 |
| `#/play/:match_id` | Play | 对局主界面；本地与联机共用同一套组件，`match_id` 在联机时就是房间号 |
| `#/result/:match_id` | Result | 成绩 + 教练视角（多队时）+ 逐题解析 + 导出 CSV/JSON + 纠错反馈 |
| `#/join` | Join | 联机大厅：后端地址、称呼、开房（四个赛制）、输房间号加入 |
| `#/room/:code` | Room | 房间大厅：房间号 / 队伍与团队码 / 新建与加入队伍 / 准备 / 房主开赛 |
| `#/settings` | Settings | 称呼、交卷后自动展开解析、清空本机记录 |
| `#/about` | About | 五赛制规则、部署指引、数据与纠错说明 |

### 6.2 布局（电脑优先）

```
┌──────────────────────────────────────────────────────────┐
│ 顶部状态条：赛事名 · 第 12/55 题 · 剩 42:31 · 队伍分 · 交卷 │
├────────────┬─────────────────────────────────────────────┤
│ 题号面板    │ 题干（可含图）                                 │
│ 240px      │ A ○ …                                        │
│ 5×11 格     │ B ○ …                                        │
│ 已答/存疑/  │ C ○ …                                        │
│ 未答 三色   │ 上一题  标记  下一题                            │
├────────────┴─────────────────────────────────────────────┤
│ 底部：解析（交卷后）／队伍状态（联机）                        │
└──────────────────────────────────────────────────────────┘
```
- 键盘：`←/→` 切题（接力夹在本棒内），`A–H` 选项（多选可反复切换；接力本棒内可改答案，交棒后锁定）。
- **不做快捷键交卷**：交卷是不可逆动作，必须走确认弹层，避免误触。
- `<1100px` 时题号面板收为顶部抽屉；手机竖屏退化为单列 + 底部固定「上一题 / 题号 / 下一题」。

### 6.3 状态管理

不引 Pinia：全局只有一个「当前对局」，一个 `reactive()` 单例就够（`packages/web/src/stores/matchStore.ts`）。

| 状态块 | 内容 |
| --- | --- |
| `match` | `mode: 'local' \| 'room'`、`record`（试卷 + 题目 + roster + viewer）、`snapshot`（最新公共视图）、`cursor`（当前题号；团队/接力/抢答由服务端投影）、`flags`（标记存疑）、`acks`、`reveal`、`summary`、`notice`、`error` |
| `room` | `serverUrl`、`nickname`、`participantId`、`connected`、`clockOffset`、`lobby`、`paperQuestions`、`error` |

持久化（`packages/web/src/storage/matchStorage.ts`）：

| 键 | 存储 | 内容 |
| --- | --- | --- |
| `arena:match:<match_id>` | localStorage | 本地对局：`{version, paper, questions, roster, viewer_id, nickname, state, summary, cursor, flags, finished, created_at, saved_at}` |
| `arena:profile` | localStorage | 称呼、交卷后自动展开解析 |
| `arena:room-result:<room_code>` | localStorage | 联机成绩页的本地备份（含 `reveal` 的答案与解析） |
| `arena:room-session` | sessionStorage | 当前房间的 `{server_url, nickname, room_code, participant_id}`，用于刷新/换设备回到房间 |

### 6.4 两个 Driver

```ts
export interface Driver {
  readonly matchId: string
  start(): void                                   // 开赛/断点恢复后立刻补一帧 room 快照
  submit(qid: string, choice: string[]): void
  submitAll(): void                               // solo/team-solo = 封卷；team-coop = 本队交卷
  end(): void                                     // 房主结束 / 本地提前收卷
  advance?(): void                                // 团队共享游标（team-coop）
  setAnswerer?(memberId: string): void            // 换主答（team-coop）
  handoff?(): void                                // 交棒（relay）
  setLegOrder?(order: string[]): void             // 接力赛前分配本队棒次（队长；仅联机大厅）
  on(handler: (message: ServerMsg) => void): () => void
  dispose(): void
  snapshot(): PublicMatchState | null             // 页面初始化用，避免等第一帧
  summary(): MatchSummary | null
}
```

- `LocalDriver`：内部跑 `reduce` + `setTimeout(TICK)`，把 `effects` 合成与 `ServerMsg` 同构的消息派发；状态写 `localStorage` 供断点续做。
- `ServerDriver`：只转发 WS；本地不跑状态机，靠 `room` / `question` / `ack` 消息驱动 UI；`ping/pong` 估时钟偏移，断线指数退避重连。

**关键不变量**：UI 组件只消费 `ServerMsg`，不关心消息来自哪个 Driver。所以对局页、成绩页一行不改就能从本地切到联机（AC-11）。

### 6.5 本地练习的成员从哪来（v0.2 新增）

v0.1 完全没有回答这个问题，而 `reduce` 需要 `Roster`。本地练习由 `buildRoster(format, viewerId, nickname)` 造一个：

| 赛制 | 本地 roster | 界面提示 |
| --- | --- | --- |
| solo | 1 队 1 人（本人） | 无 |
| team-solo | 1 队 1 人（本人） | 「单人模拟（团队成绩按队汇总）」；联机时才是「队内各自作答（按队汇总）」 |
| team-coop | 1 队 3 人：本人为队长/主答 + `${viewerId}-aux-a` 辅助甲、`${viewerId}-aux-b` 辅助乙（无提交权，可切过去看只读态） | 「本地练习里另两位是虚拟辅助」 |
| relay | 1 队 3 人：本人依次担任 3 棒（`leg_order = [本人, 本人, 本人]`，按钮显示「提前交棒」） | 「三棒都由你一个人打，联机时三人轮换」 |
| buzz | 1 队 1 人（一队一票） | 「本地单人模拟一队，联机多队同场抢」 |

占位成员只存在于本地状态，不写入任何服务端数据。所有赛制的本地练习页与联机页共用同一套组件。

### 6.6 本地存储与恢复

- 本地对局键：`arena:match:<match_id>`；联机成绩备份：`arena:room-result:<room_code>`；房间会话：sessionStorage `arena:room-session`。
- 写入时机：每次快照变化，以及交卷/封卷/公布等关键节点（`persist()`）。
- 恢复：进入 `#/play/:match_id` 时先试联机房间（`resumeRoomSession` → 服务端 `hello{resume_id}` 接管），失败再退回本地断点（`resumeLocalMatch`）。
- 首页「继续上次练习」列出未结束的本地对局（`finished = false`），可继续或丢弃。
- 剩余时间按 `deadline_at - now` 计算；本地模式发现已过期时 `LocalDriver` 会补 `TICK` 让状态机按 `deadline_at` 结算（不会因为页面关着而少判）。
- 容量：单局约 150KB（含题目 JSON）；浏览器 localStorage 上限足够放几十局。

### 6.7 计时器渲染

倒计时组件（`CountdownTimer.vue`）**只做展示**：200ms 定时刷新 `deadline_at - now`，只在秒数变化时改文本。

真正「时间到」由状态机的绝对 `deadline_at` 决定——`LocalDriver` 到点送 `TICK`，服务端到点结算——所以浏览器定时器偏几百毫秒也不影响判分，刷新页面也能立刻对上。联机模式的时钟偏移由 `ServerDriver` 的 `ping/pong` 估计（10s 一次），快照里的绝对时间在 `matchStore` 里先减去偏移再交给组件。

---

## 7. 后端设计（packages/server）

### 7.1 进程模型

单进程、单事件循环、内存态。`http.Server` 同时承载：静态资源、`/healthz`、`/ws` 升级。

单进程足够：默认 `--max-rooms 100`、每房 ≤ 12 人（每队 ≤ 3 人），教室场景通常是一个房间一支队伍；连接数远低于 Node 单实例压力上限。多房间的定时器合并到「每房一个最近 deadline 定时器」。

### 7.2 模块职责

| 模块 | 职责 |
| --- | --- |
| `main.ts` | 解析 CLI（`--port/--host/--web-root/--data-root/--allow-origin/--max-rooms`）、打印 local/lan 地址与容量、优雅退出 |
| `server.ts` | 编排：参与者注册表、协议路由（`hello/create/join/team/ready/start/submit/...`）、大厅与对局生命周期、断线宽限与 resume 接管、心跳与 `sync` |
| `rooms.ts` | `Room` 对象：成员/队伍/团队码、容量校验、`questions` 快照、`toPaperQuestions()`（裁答案）、`lobbyFor()`（按人下发）、房间日志（≤ 500 条） |
| `session.ts` | 单连接：hello 超时、帧大小与 JSON 校验、30 msg/s 限流、错误码与关闭 |
| `driver.ts` | `MatchDriver`：调 core `reduce`、把 `effects` 落成广播/定时器/日志、每事件后重播 room 快照、按最近 deadline 送 `TICK` |
| `http.ts` | 静态托管（内置）、`/healthz`、SPA 兜底、MIME、路径越界防护 |
| `data.ts` | 启动时读 `data/questions/*.json` 与 `data/papers/*.json` 进内存，提供可判分题池 |
| `core.ts` | 相对路径 re-export `packages/core/src/index.ts`，供服务端直接 import 源码 |

### 7.3 房间生命周期

```
创建（房主） → 等待（成员加入 / 分队 / 就绪） → 进行中 → 已结束
                     ↘ 房主离开 → 移交下一位队长
                     ↘ 无人 → 房间与定时器一起销毁
```
- 房间码：**6 位数字**（`000000`–`999999`），建房时查重重试；团队码同为 6 位数字、房间内唯一，只发给本队成员。
- 房主：建房者；房主离开或宽限期超时后，按队伍顺序移交下一位在线的队长。
- 房间销毁：大厅阶段成员全部离开即销毁；对局中全员离线 → 以 `all_done` 结束该局，房间保留（便于回看成绩），等成员陆续离开后自然回收。
- 销毁时清空驱动器的定时器，防止泄漏。

### 7.4 定时器策略

每房间只保留 **1 个** `setTimeout`，指向 `state` 里最近的一个 deadline。触发时发 `TICK` → reduce → 若有新 deadline 则重设。deadline 列表由状态机通过 `effects.timers` 声明，驱动取最小值。这避免了「每题一个 timer、每题清理」的泄漏风险。

### 7.5 题库加载

- 启动时一次性读 `--data-root`（默认 `<repo>/data`）下的 `questions/*.json` 与 `papers/*.json`，坏 JSON 直接启动失败（宁可起不来，也不要带着半份题库跑）。
- **不做热加载**：单机规模只有几十题、几份卷，热更新的收益抵不上「同 seed 同卷」的可重现性被重启时机影响。
- 每局在创建时抽题、裁面并把题面存进房间（`Room.questions`），之后无论题库文件怎么改，进行中的对局与重连快照都自洽。
- 组卷只从「`answer_status: verified` 且答案非空」的题池里抽；容量不足时按 §5.3 降级。

### 7.6 判分与答案保护

- 服务端持有完整题库（`ctx.questions`），判分只发生在服务端。
- 下发题目一律走 `Room.toPaperQuestions()`：只保留 `id/type/stem/stem_images/options/difficulty/taxonomy`，**`answer` / `explain` 从不下行**。
- `ack` 永不携带答案；答案只从 `reveal` 出（§5.9）；`paper` 消息同理只给题面，前端拿不到判分依据。

### 7.7 断线宽限

- 每个 `participant` 记录 `{session, team_id, last_seen_at, offlineTimer}`。
- 连接断开 → 启动 30s 宽限计时器（`RECONNECT_GRACE_MS`）。宽限期内 `hello{resume_id}` 重连 → 绑定新连接、踢掉旧连接、补发当前 `room` 快照（含题面与倒计时锚点）。
- 宽限超时后按所处阶段分别处理：
  - **大厅阶段**：从队伍/房间移除；房主离开则移交；房间空则销毁。
  - **对局阶段**：`autoSubmitAll()` 对该玩家派 `FINISH`（`solo` / `team-solo`，日志 `submit_all` + `via:'finish'`），标记离线、重播快照；其它赛制记 `submit_all_skipped`，由状态机的 `TICK` 继续推进（接力按本棒超时强制交棒、抢答本题视为未提交记 `buzz_missed`）。全部成员离线 → 以 `all_done` 结束该局。
- 抢答不接受宽限期补交：窗口已过，补交会污染「按提交时间排序」的名额判定。

### 7.8 安全

| 项 | 措施 |
| --- | --- |
| 房间码爆破 | 6 位数字（10^6），建房查重重试；加入失败只回 `ROOM_NOT_FOUND`，不回「码存在但没权限」 |
| 消息洪水 | 每连接 30 msg/s 令牌桶，超出回 `RATE_LIMITED` |
| 消息体 | 单帧 ≤ 64KB（`maxFrameBytes`），超限断开 |
| 输入注入 | 手写校验（`session.ts`）：必须合法 JSON、必须带已知 `t`；昵称长度限制并去控制字符 |
| 越权 | 每个动作先查「参与者 → 房间 → 队伍/角色」，再交给状态机；主答/队长/房主权限在 core 里也要再判一次 |
| 时间欺骗 | 不信任客户端时间戳，只用服务端 `Date.now()`（重连补偿由 `ping/pong` 单向下发） |
| 跨站 | 无 Cookie、无凭据；WS 校验 `Origin` 与 `--allow-origin` 白名单（默认同源） |
| 答案泄漏 | 题面投影（`toPaperQuestions`）与 `ack` 均不含 `answer`/`explain`，服务端测试断言整局下行 JSON 无 `"answer"` |

### 7.9 静态托管

后端 `http.ts` 托管构建产物（默认 `packages/web/dist`，可用 `--web-root` 指定），`index.html` 兜底 SPA 路由，并做 MIME 与路径越界防护。这样：

- Windows 场景：便携包一个目录（`runtime/node.exe` + 源码 + `dist` + `data`），双击 `start.cmd`，`http://<局域网IP>:8787` 同时给页面和 WS（同源，免跨域免 TLS）。
- Linux 场景：可以让 Node 直接对外，也可以前置 Nginx 做 TLS（推荐，见 §11.3）。

### 7.10 可观测性

- `GET /healthz` → `{ ok, version, protocol, uptime_sec, rooms, participants }`；非空 `--allow-origin` 时附带 CORS 头，静态站跨域也能探活。
- 启动日志：版本、协议号、local/lan 地址、`web root`、题库与试卷数、容量上限。
- 房间日志：内存里每房最多 500 条（建房、分队、就绪、开赛、越权、超时、重连、结算），对局内「报错 / 提 issue」也落在这里，供后续排障面板使用。

---

## 8. 通信协议细节

### 8.1 帧格式

纯 JSON 文本帧（无二进制）。每帧 ≤ 64KB。不做分片。

### 8.2 时序：建局 → 加入 → 开题 → 交卷

```
宿主            服务端                        队员
 │ hello{name}    │                             │
 │───────────────>│ hello_ok{pid, server_at}     │
 │ create{...}    │                             │
 │───────────────>│ room{snapshot}               │
 │                │                             │
 │                │<────────────── hello{name}   │
 │                │──────────────> hello_ok     │
 │                │<────────────── join{code}   │
 │                │──────────────> room{snap}   │
 │                │<────────────── join_team{code}│
 │                │──────────────> peer         │
 │ start          │                             │
 │───────────────>│ question{deadline_at} → 广播 │
 │                │<────────────── submit{seq}  │
 │                │──────────────> ack{correct} │
 │                │  (交卷) reveal{items} 广播   │
```

### 8.3 错误码

| code | 含义 | 客户端行为 |
| --- | --- | --- |
| `BAD_MESSAGE` | 不是合法 JSON / 缺 `t` / 未知消息类型 / 参数类型不符 | 提示并忽略 |
| `VERSION_MISMATCH` | protocol 不一致 | 提示刷新/升级，断开 |
| `ROOM_NOT_FOUND` | 房间码不存在 | 回到输入页 |
| `ROOM_FULL` | 超出上限 | 提示房间已满 |
| `ROOM_STARTED` | 已开始，不可加入 | 提示等下一局 |
| `TEAM_NOT_FOUND` | 团队码错误 | 重输 |
| `NOT_AUTHORIZED` | 越权提交/交棒/推进 | 提示"不是你答题" |
| `ALREADY_SUBMITTED` | 重复提交（stream） | 忽略（幂等） |
| `WINDOW_CLOSED` | 不在作答窗口 | 忽略 |
| `STALE_SEQ` | 补交序号过旧 | 丢弃 |
| `RATE_LIMITED` | 频率超限 | 退避重试 |

---

## 9. 数据文件

### 9.1 试卷配置示例（五个）

`data/papers/paper-school-55.json`
```jsonc
{ "schema_version":1, "id":"paper-school-55", "name":"校赛模拟 55 题", "format":"solo",
  "duration_sec":3600,
  "draw":{"single":30,"multiple":15,"judge":10,"min_available":40,"allow_partial":true,"seed":null},
  "submit_mode":"batch",
  "scoring":{"mode":"per_question","points":{"single":1,"multiple":2,"judge":1},
             "wrong_penalty":0,"unanswered":0,"total_normalize":100} }
```

`data/papers/paper-team-solo-10.json`
```jsonc
{ "schema_version":1, "id":"paper-team-solo-10", "name":"个人对抗 10 题", "format":"team-solo",
  "duration_sec":300,
  "draw":{"single":6,"multiple":2,"judge":2,"min_available":10,"allow_partial":true,"seed":2026},
  "submit_mode":"stream",
  "scoring":{"mode":"correct_minus_wrong","points":{"single":2,"multiple":2,"judge":2},
             "wrong_penalty":1,"unanswered":0,"total_normalize":0} }
```

`data/papers/paper-team-coop-10.json`
```jsonc
{ "schema_version":1, "id":"paper-team-coop-10", "name":"团队对抗 10 题", "format":"team-coop",
  "duration_sec":1200,
  "draw":{"single":6,"multiple":2,"judge":2,"min_available":10,"allow_partial":true,"seed":2026},
  "submit_mode":"stream",
  "scoring":{"mode":"correct_minus_wrong","points":{"single":4,"multiple":4,"judge":4},
             "wrong_penalty":1,"unanswered":0,"total_normalize":0} }
```

`data/papers/paper-relay-5x3.json`
```jsonc
{ "schema_version":1, "id":"paper-relay-5x3", "name":"接力赛 5 分钟×3", "format":"relay",
  "duration_sec":300,
  "draw":null,
  "legs":[
    {"single":3,"multiple":1,"judge":1,"min_available":5,"allow_partial":true,"seed":2026},
    {"single":3,"multiple":1,"judge":1,"min_available":5,"allow_partial":true,"seed":2027},
    {"single":3,"multiple":1,"judge":1,"min_available":5,"allow_partial":true,"seed":2028}
  ],
  "submit_mode":"stream",
  "scoring":{"mode":"correct_minus_wrong","points":{"single":4,"multiple":4,"judge":4},
             "wrong_penalty":1,"unanswered":0,"total_normalize":0} }
```

> v0.1 的 relay 示例写的是顶层 `draw` 三个题型都为 0，同时校验规则要求「总数 > 0」——这份示例卷会被自己的加载校验判为非法。v0.2 改成 `draw: null`，题量全部落在 `legs`。

`data/papers/paper-buzz-01.json`
```jsonc
{ "schema_version":1, "id":"paper-buzz-01", "name":"抢答赛 10 题", "format":"buzz",
  "duration_sec":0,
  "draw":{"single":5,"multiple":3,"judge":2,"min_available":10,"allow_partial":true,"seed":null},
  "submit_mode":"stream",
  "scoring":{"mode":"per_question","points":{"single":0,"multiple":0,"judge":0},
             "wrong_penalty":0,"unanswered":0,"total_normalize":0},
  "buzz":{"buffer_ms":1000,"submit_window_sec":20,"qualify_ratio":0.5,"qualify_fill":"strict",
          "correct_points":4,"wrong_points":-1,"reveal_sec":5,
          "close_on_all_submitted":false,"tie_window_ms":5} }
```

> 抢答卷的实际数值以 `data/papers/paper-buzz-01.json` 为准（10 题、答错 −1）；上面的示例已同步成同一份。`paper-school-55` 的 `min_available` 取 40 是**有意**的：现有 87 题足够 55 题满卷，但阈值放低一档，题库临时缺题时也能降级出卷（卷首会提示"本卷 X/Y 题有答案"）。

### 9.2 加载期校验（v0.2 修正）

启动加载时执行（`scripts/verify-data.mjs` 用同一套规则做离线校验），任何一项失败 → 启动/校验失败：

- `schema_version === 1`
- `format` 属于已知集合
- `duration_sec >= 0`；`submit_mode` 属于已知集合
- **`draw` 与 `legs` 二选一恰好一个非空**：
  - 非 relay：`draw` 非空、`legs` 为空/缺省、`draw` 各题型数量 ≥ 0 且总数 > 0
  - relay：`draw === null`、`legs` 恰好 3 段、每段各题型数量 ≥ 0 且**每段**总数 > 0
- `relay` 的 `duration_sec > 0`（单棒 X 秒，全局 = 3X）
- `buzz` 必须有 `buzz` 配置，`qualify_ratio ∈ (0,1]`，`tie_window_ms >= 0`，`buffer_ms >= 0`
- `buzz` 必须 `submit_mode === 'stream'`（抢答没有"交卷时再判"的语义）
- 试卷引用的题库在运行时校验（组卷时检测池容量）

---

## 10. 权限矩阵

| 操作 | 房主 | 队长 | 主答/当前棒 | 普通成员 |
| --- | --- | --- | --- | --- |
| 开始对局 | ✅ | ❌ | ❌ | ❌ |
| 结束对局 | ✅ | ❌ | ❌ | ❌ |
| 指定主答（team-coop） | ✅ | ✅（本队） | ❌ | ❌ |
| 推进下一题（team-coop） | ❌ | ✅（本队） | ✅（本队） | ❌ |
| 提交答案（solo / team-solo） | — | — | 本人 | 本人 |
| 提交答案（team-coop / buzz） | ❌ | ❌ | ✅ | ❌ |
| 提交答案（relay） | ❌ | ❌ | ✅（当前棒） | ❌ |
| 交棒（relay） | ❌ | ❌ | ✅（当前棒） | ❌ |
| 分配棒次（relay，赛前） | ❌ | ✅（本队） | ❌ | ❌ |
| 反馈题目 | ✅ | ✅ | ✅ | ✅ |

权限检查分两处：`server.ts` 查「是不是这个房间的人」与房间级动作（开赛/结束），`rooms.ts` 查队伍级角色（队长/团队码）；**赛制内的角色**（主答、当前棒）由 core 的状态机再判一次并回 `NOT_AUTHORIZED`——两层都判，避免前端绕过后端只判一次就放行。

---

## 11. 部署方案

> **实作现状（v1.0，P0–P6 全部落地）**：落地形态与下面的描述一致，要点如下 ——
> - 纯静态：`npm run build:web` → `packages/web/dist/`（`base: './'` + hash 路由，子路径可用），托管方式随用户选。
> - Windows 便携包：`npm run pack:win` → `release/aixx-server-win/`，内含 `runtime/node.exe` + 服务端源码 + `web/dist` + `data/` + `node_modules/ws` + `start.cmd`。**没有走 Node SEA 单文件**：SEA 需要下载同版本 Node 二进制并做注入，收益是「少一个 node.exe」，代价是构建链路脆；教室场景直接把 node.exe 一起拷更稳。说明见 `deploy/windows/README.md`。
> - Linux：`deploy/linux/{Dockerfile,docker-compose.yml}`，构建上下文是仓库根（运行期要 `packages/core/src` 与 `packages/web/dist`）。
> - 统一入口：服务端同端口托管前端，学生只记一个 `http://<ip>:8787`；`/healthz` 返回版本、协议号、房间数与人数。

### 11.1 纯静态（GitHub Pages）

```bash
npm run sync:data     # data/ → packages/web/public/data/bank.json
npm run build:web     # 产物 packages/web/dist（base:'./' + hash 路由，可放子目录）
# dist/ 整目录丢到任意静态托管（gh-pages 分支、校内 web 目录、对象存储均可）
```
- 题库随构建进 `packages/web/public/data/bank.json`（构建前 `sync-data.mjs` 生成，87 题 + 5 卷约 160KB）。
- 未配置后端时联机入口置灰（大厅页提示"需要一台临时服务器"）。
- 无后端 → 无 HTTPS 要求、无跨域问题。
- 子路径部署不需要改配置：`base: './'` + hash 路由，`https://<user>.github.io/<repo>/` 直接可用。

### 11.2 Windows 单机（教室/宿舍临时开局，**主要推荐**）

发布物（`npm run pack:win` 生成，`release/aixx-server-win/`）：

```
aixx-server-win/
├─ runtime/node.exe         # 同版本 Node，随包分发，学生机器无需装环境
├─ packages/core/src/       # 状态机源码（Node 22 直接执行 .ts）
├─ packages/server/src/
├─ packages/web/dist/       # 前端构建产物，服务端同端口托管
├─ data/{questions,papers}/
├─ node_modules/ws/
├─ start.cmd                # 双击即用：chcp 65001 + 8787 起服（不自动开浏览器，按窗口提示访问）
└─ README.txt
```

`start.cmd` 以 8787 起服并 `pause`（关窗即停），控制台打印：

```
aixx-arena server v0.1.0 (protocol v1)
local http://127.0.0.1:8787
lan   http://192.168.1.23:8787     ← 这一行发给学生
bank 87 题 / 5 卷
capacity 100 rooms × 12 players（每队 ≤ 3 人）
```

首次运行需允许 Windows 防火墙（`deploy/windows/README.md` 有排查表：端口占用、防火墙、手机连不上）。

### 11.3 Linux 服务器

`deploy/linux/docker-compose.yml`（构建上下文是**仓库根**，因为运行期要 `packages/core/src` 与 `packages/web/dist`）：

```yaml
services:
  arena:
    build:
      context: ../..
      dockerfile: deploy/linux/Dockerfile
    ports: ["${ARENA_PORT:-8787}:8787"]
    environment:
      ARENA_ALLOW_ORIGIN: ""     # 前端由本服务托管，默认不需要 CORS
      ARENA_MAX_ROOMS: "100"
    command: [node, packages/server/src/main.ts, --port, "8787", --host, 0.0.0.0, --web-root, packages/web/dist]
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
```

Nginx 反代要点：`/ws` 需 `proxy_http_version 1.1`、`Upgrade`/`Connection` 头、`proxy_read_timeout 3600s`；TLS 用 certbot。
完整步骤（含非 Docker + systemd、参数表）见 `deploy/linux/README.md`。

### 11.4 形态 D：静态前端 + 独立后端

静态站不认识任何后端，联机地址由用户在「联机大厅」填写（也可构建期用 `VITE_SERVER_URL` 给个默认值）。
地址只接受 **origin**（`http(s)://host:port`），路径一律丢掉：前端自己派生 `ws(s)://host:port/ws`。
`normalizeServerUrl()` 负责校验并给出人话错误；`mixedContentRisk()` 在 https 页面填 http 地址时提前警告。

| 页面协议 | 后端协议 | 可行性 | 说明 |
| --- | --- | --- | --- |
| `https://sbdcf.github.io/...` | `https://` + `wss://`（cloudflared / ngrok 隧道） | ✅ | 需额外装隧道工具 |
| `https://sbdcf.github.io/...` | `http://` + `ws://`（局域网） | ❌ | 浏览器按混合内容直接拦截，UI 明确报「需 https 后端」 |
| `http://192.168.1.23:8787`（后端托管） | 同源 `ws://` | ✅ | **平时练习用这个** |
| `http://localhost:5173`（开发） | `ws://localhost:8787` | ✅ | 开发期需服务端 `--allow-origin` 放行 |

因此文档里统一口径：**「自主练习」用形态 A；「联机练习」用形态 B（一台电脑当服务器）；形态 D 只在有隧道时提**。

### 11.5 版本

- `version` = 服务端 `SERVER_VERSION`（当前 `0.1.0`），随包/随镜像一起发；`/healthz` 与 `hello_ok` 都带它。
- `protocol` = 整数，协议不兼容时 +1；`hello` 里前端带上自己认识的版本，不一致直接回 `VERSION_MISMATCH`。
- 握手失败时前端提示：「服务端协议 v2，当前页面 v1，请刷新页面或更新服务端」。

---

## 12. 测试策略

| 层 | 工具 | 覆盖重点 |
| --- | --- | --- |
| core 单测 | `node:test` | 判分边界（多选少选/错选/未答）、组卷降级、接力三段不重复、五个状态机的**全部时间边界**（截止前 1ms / 恰好 / 后 1ms）、`rankBuzz` 的并列与名额、接力 carry 计算、FINISH 封卷语义 |
| web 逻辑（driver / store / 存储） | `node:test` + `packages/web/test/loader.mjs` | LocalDriver 的消息序列与断点续做、matchStore 的开局/答题/交卷/落盘全链路（内存 localStorage + 假 fetch + 假 document） |
| server 集成 | `node:test` + 真实 `ws` 客户端 | 建房/加入/开题/提交/断线重连/超时自动提交/限流/重放 seq，并断言整局下行帧不含 `answer` |
| 页面 | 无头浏览器 + DevTools 协议截图核对 | 首页卡片、对局页三栏（含团队/接力/抢答视角）、成绩页复盘与导出，以及联机全流程真点一遍 |
| 契约 | `node:test` | 同一 `judge()` 在前后端两端跑同一组用例，结果必须一致（AC-11）；同一事件序列下 `LocalDriver` 与 `ServerDriver` 产出的 ServerMsg 序列一致 |

> 当前实际：`npm test` 104 条（core 88 + web 逻辑 5 + server 11），`npm run typecheck` 覆盖 core 与 server。

**核心单测的写法**：不 mock 时间，直接构造事件序列。

```ts
const s0 = init(ctx, 1000)
const r1 = reduce(s0, { type: 'START', at: 1000 }, ctx)
const r2 = reduce(r1.state, { type: 'HANDOFF', at: 1000 + 180_000, actor_id: 'a' }, ctx)
assert.equal(r2.state.teams['t1'].leg_budget_sec, 300 + 120)   // 用 3:00，省下 2:00
assert.equal(r2.state.deadline_at, 1000 + 3 * 300 * 1000)      // 全局截止不随交棒变化
```

---

## 13. 实施路线

| 阶段 | 交付物 | 完成判据 |
| --- | --- | --- |
| **P0 基础设施** ✅ 已完成 | npm workspaces、`tsconfig.base.json`、`core/types.ts`、`rng.ts`、`scoring.ts`、`draw.ts`、`buzz.ts`、`index.ts` 导出；题库 87 题导入 + 5 份试卷配置 | `npm test` 37 条全绿、`npm run typecheck` exit 0、`npm run verify:data` 27 项断言 PASS |
| **P1 静态站 + 赛制 1** ✅ 已完成 | `web` 骨架（hash 路由、无 UI 库/无状态库）、`solo` 状态机、`LocalDriver`、对局页、答题卡、成绩页与逐题复盘、断点续做、题目纠错入口 | `npm test` 56 条全绿（core 52 + web 4）；`vite build` 61 modules 出 `dist/`（含 `bank.json` 87 题 5 卷）；浏览器自动化截图核对首页 / 对局页（55 题、12 题已答、答题卡状态）/ 成绩页（76/100、42 对 13 错、逐题解析）；AC-1/2/3/13 走通 |
| **P2 赛制 2/3 静态** ✅ 已完成 | `teamSolo` / `teamCoop` 状态机（`formats/sheet.ts` 抽公共答卷逻辑）、同屏模式（`buildRoster`：team-coop = 1 队长 + 2 虚拟辅助）、`ADVANCE` / `SET_ANSWERER`、对局页团队视角（换主答、辅助位只读、题板锁定、本队交卷）、成绩页成员成绩条 | `npm test` 70 条全绿（core 62 + web 8）；`tsc` exit 0；`vite build` 64 modules；截图核对：团队赛对局页（第 3/10 题、已答 3、换主答下拉）、辅助位只读（橙色提示条 + 选项/按钮全禁用）、成绩页（30/40，成员条：队长 30 分 / 辅助甲 0 / 辅助乙 0） |
| **P3 后端 + 联机 2/3** ✅ 已完成 | `server` 全套（`main.ts`/`server.ts`/`rooms.ts`/`session.ts`/`driver.ts`/`http.ts`/`data.ts`/`core.ts`）、`ServerDriver`、房间大厅（建房 / 6 位团队码入队 / 准备 / 房主开赛 / 断线 30s resume）、`FINISH` 封卷事件、双部署产物 | `npm test` 88 条全绿（core 69 + web 8 + server 11）；`tsc -p core && tsc -p server` exit 0；本地起服 `/healthz` 200；WS 端到端跑通「建房→组队→开赛→答题→交卷→成绩」且下行帧不含 answer；浏览器自动化点完「联机大厅→连接→建房→组队→开赛→答题→交卷→成绩页」并截图核对大厅 / 联机对局 / 联机成绩（−1/20、逐题正确答案与解析来自 reveal） |
| **P4 接力** ✅ 已完成 | `relay` 状态机（三棒切分、`carry = max(0, X - 已用秒)` 时间继承、提前交棒 / 推满本棒交棒 / 本棒超时强制交棒）、服务端开放 relay 房间（含 `handoff` 路由与分棒组卷）、交棒 UI（棒次条、本棒倒计时、交棒按钮、上一题夹在本棒内）、首页/大厅/房间页接力入口 | `npm test` 96 条全绿（core 77 + web 8 + server 11）；`tsc -p core && tsc -p server` exit 0；`vite build` 69 modules；自动化联机全流程「开接力房→建队→开赛→第 1 棒答满交棒→第 2 棒接手（本棒剩余 09:56，验证时间继承）→第 3 棒→结束本队作答→成绩页 9/60」；本地接力「一人连打三棒」同样走到成绩页；截图核对第 1 棒 / 第 2 棒 / 成绩页 |
| **P5 抢答** ✅ 已完成 | `buzz` 状态机（缓冲→开抢→公布三拍、题面先出、`rankBuzz` 名额判定、`buzz_per_question` 复盘）、服务端开放 buzz 房间、抢答 UI（禁抢倒计时、一队一票、提交即锁、名额提示、实时榜取代答题卡）、首页/大厅/房间页抢答入口 | `npm test` 104 条全绿（core 85 + web 8 + server 11）；`tsc -p core && tsc -p server` exit 0；`vite build` 70 modules；WS 端到端双队脚本跑通「建房→两队入队→开赛→题面不含 answer→开抢 `n_at_open=2 quota=1`→乙先交甲后交→只有乙 +4、甲 0→reveal→下一题→end」（`max_score` 40）；截图核对缓冲期（准备中、开抢倒计时）、开抢（实时榜）、公布（正确答案 / 你的选择 / 实时榜 −1） |
| **P6 收尾** ✅ 已完成（回放留作后续） | 成绩导出（CSV / JSON，学生自存，无需账号）、教练视角（联机成绩页「全部队伍」按分降序）、纠错入口（静态预填 issue / 联机写服务端日志）、双部署产物与 README | `npm test` 104 条全绿；`tsc -p core && tsc -p server` exit 0；`vite build` 70 modules；自动化冒烟「成绩页导出 CSV / JSON 无异常、按钮与复盘仍在」；`npm run pack:win` 产出便携包，本地起服后 `/healthz`、`/`、`/data/bank.json` 均 200 |

**顺序理由**：P0 把判分与组卷钉死（所有赛制都依赖）；P1 先上线解决"没地方练"；P3 才引入网络复杂度，且此时状态机已被单测覆盖，后端只是"接线"。

> 表中「`npm test` N 条」是**各阶段完成时的快照**，用来证明该阶段自身验收通过；当前全量以 §12 为准（104 条）。

---

## 14. 风险与待定

| 项 | 状态 | 处理 |
| --- | --- | --- |
| 题库答案 `verified` 数量 ✅ 已解除 | 用户已整理 87 道（全部 verified，题型 single 36 / multiple 33 / judge 18，12 个 topic 全覆盖） | 已导入 `data/questions/`；55 题卷的 draw(30/15/10) 容量充足，不再需要降级 |
| 接力/抢答官方细则 | 未查到总则 | 全部参数化；拿到规程只改 JSON |
| 单文件打包（Node SEA） | 已放弃 | 便携包直接带 `runtime/node.exe`：构建链路简单、版本可控，代价只是多一个文件 |
| GitHub Pages 国内可达性 | 已知不稳 | 文档同时给"本地静态包"打开方式 |
| 形态 D 的混合内容限制 | 已定 | 只在有隧道时提供，主推形态 B |
| 手机端体验 | 降级处理 | 只保证能答题与交卷，不做专项优化 |

---

## 15. 附录：几个容易写错的地方

1. **接力 carry 不能用已用时间算**：`carry = max(0, budget_sec - elapsed_sec)`，其中 `elapsed_sec = (HANDOFF.at - leg_started_at)/1000`。用 `ceil` 会让队伍凭空多出 1 秒。
2. **抢答名额按 `Math.ceil`**：N=3 时名额 2，N=4 时 2，N=5 时 3。`Math.round` 在 N=3 时给 2、N=6 时给 3、N=5 时错成 3 与 ceil 相同——差异集中在奇数队伍，必须用 ceil 保证"前 50%"略偏向抢答方。
3. **同一毫秒并列**：`at` 差值 `<= tie_window_ms` 视为并列，整簇计入名额；聚簇必须从**已排序**序列上做，且排序键要带 `team_id` 兜底。
4. **多选比较前必须排序**：`[...choice].sort().join()` vs `[...answer].sort().join()`。
5. **TICK 幂等**：同一 `at` 重复 TICK 不得重复结算（用 `phase` 判断，而不是时间判断）。
6. **进行中对局必须自洽**：房间持有开赛时的题面快照与 `roster`，判分用 `ctx.questions`；不要每次判分都回头读磁盘题库。
7. **hash 路由 + GitHub Pages**：不要用 history 模式，否则刷新 `/play/xxx` 直接 404。
8. **https 页面连 `ws://` 一定失败**：不是"可能被拦"，是规范要求。形态 D 必须两端都加密，或干脆用形态 B。
9. **`seq` 必须每个 participant 独立计数**：全局共享一个计数器会在多标签页重连时把对方的消息挤成 `STALE_SEQ`。
10. **`leg_order` 要固化**：不要在 HANDOFF 时去查"房间当前成员里下一个是谁"——掉线、被踢、换队都会让这个查询给出不同结果，而重连快照必须与当时的判定一致。开赛前可由队长用 `set_leg_order` 指定，开赛瞬间固化成 state；`RoomTeam.leg_order` 只是大厅展示，开赛后不再影响判定。

---

## 16. 版本记录

| 版本 | 日期 | 关键变化 |
| --- | --- | --- |
| v0.1 | 2026-11-06 | 首版方案：四种运行形态、纯函数状态机、core / 前端 / 后端分包、协议草案 |
| v0.2 | 2026-11-06 | 补齐契约：`PublicMatchState`、`ADVANCE`、`rankBuzz`、`seq`；修掉三处自相矛盾（试卷校验、batch 提交、接力双真相源）；补第四种形态 D |
| v0.3 | 2026-11-06 | 二轮复审：relay 棒内题号、五个赛制的交卷触发点、`OwnView.scope/can_submit`、buzz 时间锚点；修「断线宽限比开抢窗口还长」 |
| v0.4–v0.7 | 2026-11-06 | 随 P0–P3 实作回写：`Roster.names` / `ReduceCtx` / `view(state, viewer_id, at)`、`formats/sheet.ts` 抽公共答卷、`FINISH` 封卷事件、`notice` 消息、`RoomResultRecord.reveal`、服务端 CLI 与同端口静态托管、6 位房间码 / 团队码 |
| v0.8 | 2026-11-06 | P4 实作回写：服务端分棒组卷（`legs` → `drawRelay().legs.flat()`）、`handoff` 路由、交棒一切以快照为准、本棒倒计时用 `clock.leg_deadline_at`、单人队循环排棒 |
| v0.9 | 2026-11-06 | P5 实作回写：题面在缓冲期先推（`announced`）、`qualify_ratio` / `reveal_ms` 固化进 state、开局 TICK、抢答无交卷、实时榜取代答题卡；P6 完成成绩导出（CSV / JSON）与教练视角 |
| v1.0 | 2026-11-06 | 整理版：技术选型并入 §2 架构章（2.3 技术栈 / 2.4 被否决方案），删除开发机环境相关章节；§4 目录树、§12 测试策略、§13 实施路线按实际实现重写；变更历史压缩为本表 |
| v1.1 | 2026-11-07 | 接力赛修复：本棒内可反复提交/覆写答案并重判（多选逐次勾选、答错可改），交棒后历史棒锁定；新增 `set_leg_order` 消息与 `LobbyTeam/RosterTeam.leg_order`，队长可赛前分配棒次 |

原则：**文档与实现不一致时，以实现为准并回写文档**。每一轮实作后，把"写代码时发现文档不够用"的点直接补进对应章节，而不是堆在末尾列表里。
