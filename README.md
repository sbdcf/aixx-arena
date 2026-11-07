# AI+信息素养 · 训练场

**给「AI+信息素养」大赛用的训练与模拟赛系统：87 道题、5 套卷、5 种赛制；断网也能练，一台 Windows 电脑就能让整间教室联机比赛。**

它把「刷题 — 模拟赛 — 看解析 — 导出成绩」做成了一个网页应用。学生打开浏览器就能用，不需要注册账号；老师在自己电脑上双击一个文件，把局域网地址发到班级群，就能开一场多人比赛。

| 你是 | 建议从这里开始 |
| --- | --- |
| 学生 / 参赛同学 | 打开老师给的网址，直接刷题；或在「联机大厅」输入 6 位房间号进房 |
| 老师 / 教练 | [5 分钟先玩起来](#5-分钟先玩起来不用后端) → [部署后端环境（零基础版）](#部署后端环境零基础版) 的**路线 A** |
| 开发者 / 社团维护者 | [维护者：数据、测试与打包](#维护者数据测试与打包) + [`docs/design.md`](docs/design.md) |

**它为什么适合课堂**

- **离线优先**：纯静态托管就能练全部五种赛制；团队、接力、抢答在本地退化为单人模拟。
- **一台电脑就够**：Windows 便携包自带 Node 运行时，解压、双击，不装环境、不要管理员权限、不连外网。
- **判分只有一处**：同一套 TypeScript 状态机既跑在浏览器里，也跑在服务端；联机时服务端权威判分，答案不下发。
- **不绑平台**：没有数据库、没有账号、没有第三方服务；唯一运行期依赖是 `ws`。

## 目录

- [这是什么](#这是什么)
- [5 分钟先玩起来（不用后端）](#5-分钟先玩起来不用后端)
- [五赛制一览](#五赛制一览)
- [部署后端环境（零基础版）](#部署后端环境零基础版)
- [系统设计](#系统设计)
- [维护者：数据、测试与打包](#维护者数据测试与打包)
- [文档地图与版本](#文档地图与版本)

## 这是什么

「AI+信息素养」训练场是一个纯前端 + 轻后端的比赛训练系统。前端是 Vue 3 单页应用，后端是 Node 22 写的 WebSocket 服务，两端共用 `packages/core` 里的赛制状态机与判分函数。

三种使用方式，按需要选一种：

| 方式 | 需要准备什么 | 能做什么 |
| --- | --- | --- |
| **纯静态** | 任意静态托管（GitHub Pages、校内 web 目录、对象存储），或本机一个静态文件服务 | 五种赛制单人练习、自动判分、逐题解析、成绩导出 |
| **Windows 便携包** | 解压一个 zip，双击 `start.cmd` | 上述全部 + **教室多人联机**（团队个人赛 / 团队赛 / 接力 / 抢答） |
| **Linux 服务器** | Docker，或 Node.js 22.18+ | 同上，可长期运行、用 Nginx 反代 HTTPS |

**它不适合做什么**

- 不是正式考试系统：没有账号、没有防作弊、题库与答案随包分发；成绩只存在学生自己的浏览器里。
- 不是题库管理后台：改题要编辑 `data/questions/*.json`，再重新构建（或重新打便携包）。
- 不承诺公网可用：它是给教室、机房、家庭局域网设计的；搬到公网需要自己加 TLS、鉴权和备份。

## 5 分钟先玩起来（不用后端）

### 路线 1：Windows 便携包（最省事，老师 / 有 Windows 电脑的同学）

1. 从本仓库的 [Releases](../../releases/latest) 下载 `aixx-server-win-v0.1.zip`（也可以让老师把解压后的文件夹直接发给你），解压到任意目录，例如 `D:\aixx-server-win`。
2. 双击目录里的 `start.cmd`。第一次运行时 Windows 可能弹出「是否允许访问网络」，勾选「**专用网络**」并允许。
3. 窗口里出现 `ready. Ctrl+C to stop.` 就是启动成功。**这个黑窗口不要关**，关了服务就停了。
4. 本机浏览器打开 `http://127.0.0.1:8787/`；要让同教室的学生连，把窗口里 `lan` 那行地址（形如 `http://192.168.1.23:8787`）发给他们。
5. 首页点任意一张赛制卡片就能开始单人练习；要多人比赛，点顶部「**联机大厅**」。

> 便携包不会自动打开浏览器，也不会自动配置防火墙——第一次的「允许访问」弹窗要选对。详细步骤和故障排查见 [部署后端环境（零基础版）](#部署后端环境零基础版)。

### 路线 2：只想要一个静态网页（不联机）

1. 把 `packages/web/dist/` 整个目录上传到任意静态托管（GitHub Pages、校内 web 目录、对象存储都可以）。
2. 访问 `index.html` 所在地址即可。`base: './'` + hash 路由，放在子目录也能用。
3. 想先在本地看效果：

   ```bash
   npm ci
   npm run sync:data
   npm run build:web
   npm run preview:web
   ```

> 不要直接双击 `dist/index.html`：`file://` 协议下浏览器会拦截读取题库 JSON，页面起不来。必须通过 `http://` 访问。

### 路线 3：开发者本地跑前后端

```bash
npm ci
npm run start:server    # 终端 1：后端，默认 http://127.0.0.1:8787
npm run dev:web         # 终端 2：前端开发服务器（热更新），按提示访问
```

进入「联机大厅」时，「服务器地址」填 `http://127.0.0.1:8787`（只填 origin，不要带 `/#/join` 之类的路径）。

**第一次打开你会看到**：首页五张赛制卡片（都可离线自练）、题库概况、最近练习与历史成绩；右上角导航可以进「联机大厅」「设置」「关于」。答题页左边是题号面板，中间是题目，顶部是倒计时与交卷按钮。

## 五赛制一览

| # | 赛制 | 怎么玩 | 默认题量 / 时长 | 纯静态单人 | 多人联机 |
| --- | --- | --- | --- | --- | --- |
| 1 | 个人客观题（校赛模拟） | 整卷作答，可回改，交卷后统一判分 | 55 题 / 60 分钟 | ✅ | —（联机大厅不开放此赛制） |
| 2 | 团队个人赛 | 队内各人独立作答，按队汇总总分 | 10 题 / 5 分钟 | ✅ 单人模拟 | ✅ 每队 1–3 人 |
| 3 | 团队赛（1 答 2 辅） | 1 人主答提交，队友同屏看题；可中途换主答 | 10 题 / 20 分钟 | ✅ 本地同屏模拟 | ✅ 每队必须正好 3 人 |
| 4 | 接力赛 | 3 棒 × 5 题，上一棒没花完的时间继承给下一棒 | 每棒 5 分钟 | ✅ 一人三棒 | ✅ 建议每队 3 人，不足按顺序循环排棒 |
| 5 | 团队抢答 | 多队同场，按服务端收到时间排序，前 50% 抢到且答对才加分 | 10 题，逐题推进 | ✅ 模拟一队 | ✅ 建议 ≥ 2 队 |

**几个容易踩的点**

- **抢答没有「交卷」按钮**：每道题按「看题缓冲 → 抢答窗口 → 公布答案」自动推进，题目走完自动结束；其他四种赛制才有交卷按钮。
- **开赛前所有在场同学都要分队**：房间页显示「还没分队的同学」时，房主点「开始比赛」会被服务端拒绝；让他们先入队，或者先离开房间。
- **团队赛（1 答 2 辅）必须凑满 3 人**，少一个都不让开；其余联机赛制每队至少 1 人。
- **时间与分值都参数化**：题量、时长、分值、抢答名额比例写在 `data/papers/*.json` 里，改规则不用改代码；官方细则未公布前，以试卷里的参数为准。
- **断线 30 秒内可连回**：服务端保留宽限，重连后下发快照继续答题；接力赛掉线会按超时自动交棒。

## 部署后端环境（零基础版）

这一章写给**没有写过代码**的老师：只要会解压文件、双击图标、在浏览器里输入地址，就能把「AI+信息素养训练场」的联机后端在教室里跑起来。启动、连接、建房、组队、开赛的流程都在一台 Windows 11 电脑上实测过，控制台输出和按钮文案是实测/源码复制，不是示意。

如果你已经会用 Node、Docker、nginx，可以直接跳到「路线 B」和「附录」。

### 先理解三件事

整套系统只有三个角色，用教室里的东西打比方就懂了：

| 名字 | 是什么 | 类比 |
| --- | --- | --- |
| 前端 | 浏览器里打开的那个网页，题目、按钮、计时器都在这里 | 学生手里的**试卷和答题卡** |
| 后端 | 一台电脑上跑着的小程序，负责收答案、算分、发榜 | 讲台上的**监考老师 + 计分板** |
| 局域网 | 同一个路由器（同一个 Wi-Fi）下的设备才能互相访问 | 同一间**教室**，出了门就听不见 |

```
 学生手机 ─┐
 学生电脑 ─┼── 同一个 Wi-Fi / 路由器 ──→ 老师电脑上开着的「后端」（一个黑窗口）
 投影/大屏 ─┘                                   ↑
                                          题目和成绩都从这里发出去
```

三个关键结论：

1. **前端不用装。** 后端会顺便把网页一起发给学生，学生只要浏览器输一个地址。
2. **后端要有人开。** 双击 `start.cmd` 就等于「上课了，计分板开机」，关掉窗口就等于「下课，计分板断电」。
3. **必须在同一个 Wi-Fi。** 学生用 4G/5G 流量、或连了隔壁办公室的 Wi-Fi，就一定连不上——这不是软件坏了，是「不在同一间教室」。

### 先选路线

| 你的情况 | 选哪条路线 | 需要会什么 |
| --- | --- | --- |
| 只想自己出题练手、给学生发个链接自己练 | **路线 C：纯静态托管** | 会传文件 |
| 教室里几十人同时联机比赛（**主推**） | **路线 A：Windows 便携包** | 会解压、会双击 |
| 机房有台常年开着的服务器，或买了云主机 | **路线 B：Linux 服务器** | 会敲 Linux 命令 |
| 已有 GitHub Pages 之类的静态站，只想要前端 | **路线 C：纯静态托管** | 会传文件 |

> 一句话选择：**只要能进教室，就用路线 A。** 它不需要装 Node、不需要装 Docker、不需要管理员权限、不需要联网（除了教室自己的 Wi-Fi）。

### 路线 A：Windows 便携包（零编程，主推）

#### A1 准备四样东西

- [ ] 一个压缩包 `aixx-server-win.zip`（老师或维护者发给你；仓库里的 `release\aixx-server-win\` 就是解压后的同款目录，自己压成 zip 也行）
- [ ] 一台 **Windows 10 / 11，64 位** 的电脑（老师的笔记本就行，台式机更好）
- [ ] 一个能用的 **路由器 / Wi-Fi**（学生和这台电脑连同一个）
- [ ] 一个浏览器（Edge 或 Chrome，装上就行）

**不需要**：不需要装 Node.js、不需要装 Docker、不需要注册账号、不需要联网激活、不需要管理员权限。

> 放行防火墙那一步 Windows 可能会要求点「是」提权，这是系统行为，正常操作即可。

#### A2 解压到哪个目录

**做什么**：右键压缩包 →「全部解压缩…」→ 目标填 `D:\`，解压后得到一个文件夹 `D:\aixx-server-win`。

**你应该看到**：文件夹里有这些内容（缺一个都不行）：

```
D:\aixx-server-win\
  start.cmd          ← 双击这个
  README.txt         ← 服务端简版说明（本页更完整）
  package.json
  runtime\node.exe   ← 便携版 Node，不用安装
  packages\server\    ← 后端程序
  packages\core\      ← 判分规则
  packages\web\dist\  ← 网页（前端）
  data\questions\     ← 题库
  data\papers\        ← 试卷
  node_modules\ws\    ← 唯一的依赖
```

整个文件夹约 **84 MB**，155 个文件。

**目录怎么选**（很重要，选错会出现「莫名其妙打不开」）：

| 推荐 / 避免 | 路径示例 | 原因 |
| --- | --- | --- |
| ✅ 推荐 | `D:\aixx-server-win` | 短、纯英文、无空格 |
| ❌ 避免 | `C:\Users\张三\桌面\...` | 桌面常被 OneDrive 同步，文件可能被「挪走」 |
| ❌ 避免 | `C:\Program Files\...` | 需要管理员权限，且路径带空格 |
| ❌ 避免 | `D:\我的比赛\训练场\` | 中文路径在命令行里容易出乱码 |
| ❌ 避免 | OneDrive / 坚果云 同步目录 | 同步会锁文件、拖慢启动 |

**出错怎么办**：解压报「文件被占用」就先关掉所有 `cmd` 黑窗口；磁盘空间不足时留意解压后约 84 MB，留 200 MB 就够。也不要直接在压缩包预览窗口里双击 `start.cmd`——那会解压到临时目录，一关窗口数据就没了。

#### A3 双击 start.cmd

**做什么**：打开 `D:\aixx-server-win`，双击 `start.cmd`。

**如果看不到 `.cmd` 后缀**（Windows 默认隐藏已知扩展名，文件名可能只显示 `start`）：

- Windows 11：文件资源管理器 →「查看」→「显示」→ 勾上「文件扩展名」
- Windows 10：文件资源管理器 →「查看」选项卡 → 勾上「文件扩展名」

然后确认你要双击的是 `start.cmd`（图标是一个带齿轮的小窗口），而不是 `README.txt`。

**你应该看到**：一个黑底白字的窗口弹出来，里面开始滚动文字。**这个窗口不要关**，关了服务就停了，学生就掉线了。

**出错怎么办**：

- 窗口一闪就没了：先看 A10 表格里「双击闪退」那一条。
- 弹窗提示「Windows 已保护你的电脑」：点「更多信息」→「仍要运行」。
- 双击后只是用记事本打开了脚本：说明你点的是别的文件，或者 `.cmd` 关联被改坏了，用「右键 → 打开方式 → 命令提示符」也可以临时跑。

#### A4 你应该看到什么

窗口里会打印一段启动信息。下面是**实测输出**（IP 和路径会随你的电脑变，其余文字一致）：

```
AI+信息素养训练场 · 联机后端

aixx-arena server v0.1.0 (protocol v1)
  local    http://127.0.0.1:8787
  lan      http://192.168.1.23:8787
  web root packages\web\dist
  data     D:\aixx-server-win\data
  bank     87 题 / 5 卷
  capacity 100 rooms × 12 players（每队 ≤ 3 人）
  ws       /ws（upgrade 接受任意路径，便于反代）
ready. Ctrl+C to stop.
```

逐行解释，你只需要看其中三行：

| 行 | 意思 | 你要做什么 |
| --- | --- | --- |
| `local http://127.0.0.1:8787` | 只在这台电脑上能打开的地址 | 老师自己测试用 |
| `lan http://192.168.1.23:8787` | **学生要输入的地址**（同一 Wi-Fi 下） | 抄到黑板上 / 投到屏幕上 |
| `bank 87 题 / 5 卷` | 题库加载成功：87 道题、5 套卷子 | 数字不对说明 `data` 目录不完整 |
| `capacity 100 rooms × 12 players` | 最多 100 个房间，每房 12 人 | 教室够用，不用管 |
| `ready. Ctrl+C to stop.` | **服务已就绪** | 可以喊学生进来了 |

**注意事项**：

1. `lan` 那一行可能**不止一条**（电脑同时插网线、连 Wi-Fi、装了 VMware/VirtualBox 虚拟网卡时都会打印）。**选和学生手机同一网段的那个**，通常是 `192.168.x.x` 或 `172.16.x.x`、`10.x.x.x`。分不清就按 A10 的「查看本机 IP」操作。
2. 如果 `lan` 显示的是 `169.254.x.x`，说明这台电脑根本没连上路由器，先检查 Wi-Fi/网线。
3. 窗口里出现红色报错、或者没有 `ready.` 这一行，说明启动失败，对照 A10 排查。

**自测（强烈建议，10 秒）**：在这台电脑的浏览器里打开 `http://127.0.0.1:8787/healthz`，应该看到一行 JSON：

```json
{"ok":true,"version":"0.1.0","protocol":1,"uptime_sec":12,"rooms":0,"participants":0}
```

看到 `"ok":true` 就说明后端活着，可以继续。看不到就说明窗口已关或启动失败。

#### A5 Windows 防火墙弹窗：只点一次

**做什么**：第一次双击 `start.cmd` 时，Windows 大概率会弹一个「Windows 安全警报 / 是否允许此应用访问网络」的框，里面列着 `node.exe`，勾选框是「专用网络」和「公用网络」。

**正确操作**：勾上「**专用网络**」（教室 Wi-Fi 属于专用网络；不确定就把两个都勾上）→ 点「允许访问」。

**为什么**：不点允许，老师自己电脑能打开页面，但**学生的手机/电脑一定打不开**。这是零基础部署最常见的一个坑。

**如果你当时点了「取消」，或者根本没看到弹窗**，Win11 手动放行步骤（不同 Windows 版本菜单文字略有差异，找不到入口时直接在开始菜单搜索「允许应用通过防火墙」）：

1. 开始菜单 →「设置」→「隐私和安全性」→「Windows 安全中心」
2. 「防火墙和网络保护」→「允许应用通过防火墙」
3. 点「更改设置」（需要管理员权限，会弹 UAC，点「是」）
4. 点「允许其他应用」→「浏览…」
5. 选中 `D:\aixx-server-win\runtime\node.exe` →「添加」
6. 在列表里找到刚加的 `node.exe`，把「专用」和「公用」两列都勾上 →「确定」

> 列表里可能已经有好几个 `node.exe`（装过别的工具留下的）。勾哪个都能放行，不必删。

**教育网/公司网提醒**：有些学校网络开启了「客户端隔离 / AP 隔离」，同一个 Wi-Fi 下设备互相看不见。这种网络无论怎么放行都连不上，换手机热点或让网管关掉隔离。

#### A6 学生怎么连

**做什么**（把下面几句直接念给学生）：

1. 手机或电脑连上**和老师同一间教室的 Wi-Fi**（不要用流量）。
2. 打开浏览器（微信里点开链接不算，要点右上角「在浏览器中打开」）。
3. 地址栏输入老师写在黑板上的地址，例如：`http://192.168.1.23:8787`
4. 回车。

**你应该看到**：页面顶部是「信息素养训练场」，中间是「信息素养 · 训练场」，有五张赛制卡片。

**地址怎么填才对**：

| ✅ 正确 | ❌ 错误 |
| --- | --- |
| `http://192.168.1.23:8787` | `192.168.1.23:8787`（手机浏览器一般也能补全，但别赌） |
| 只填协议 + IP + 端口 | `http://192.168.1.23:8787/#/join`（带路径） |
| 用 `http://` | `https://`（本服务没有证书，会报错） |

> 多打一个 `/#/join` 通常也能进，但在「联机大厅」里填服务器地址时**只能填到端口**，不能带 `/#/`。所以统一教学生：**地址只写到端口号为止**。

**出错怎么办**：页面转圈/提示「无法访问此网站」→ 见 A10 前三条（九成是防火墙或不在一张网）。

#### A7 进「联机大厅」

**做什么**：在打开的页面里，点顶部导航的「**联机大厅**」，或者点首页大按钮「**联机大厅**」。

**你应该看到**：页面标题「联机大厅」，下面分三块：

1. 「**1. 连接后端**」：有「服务器地址」「你的称呼」两个输入框，一个「连接后端」按钮，旁边有个状态标签，现在是「**未连接**」。
2. 「**2. 开一个房间（房主）**」：四个建房按钮。
3. 「**2'. 加入房间（队员）**」：一个 6 位数字的房间号输入框和「进入房间」按钮。

**服务器地址填什么**：

- 填 **A4 里那条 `lan` 地址**，例如 `http://192.168.1.23:8787`
- 输入框里的灰色示例是 `http://192.168.1.20:8787`，那只是格式示例，**不要照抄**
- 提示文字写着「填 origin（协议 + 主机 + 端口），不带路径」，照做即可
- 称呼随便填（最多 16 个字），会显示给队友看

填好后点「**连接后端**」。**你应该看到**：状态标签从「未连接」变成「**已连接**」，按钮文字变成「已连接」，页面下方出现建房/进房的操作区。

**出错怎么办**：

- 点完还是「未连接」：地址少了 `http://`、端口打错（8787）、或者带上了 `/#/join`。清空重填。
- 提示「地址格式不对」：检查有没有多打空格、中文冒号「：」。
- 一直转圈：后端窗口可能已经关了，回 A4 重新双击 `start.cmd`。

#### A8 建房、组队、开赛（老师视角逐步）

下面每一步都对应**页面上真实存在的按钮**，按顺序做即可。以「团队赛（1 答 2 辅）」为例。

**第 1 步：房主建房（房主自己也要找队伍加入）**

房主既负责建房也参赛。建房后房主要么自己「新建队伍」当队长，要么用别人的团队码入队。至少要有 1 支有人的队伍；**所有在场同学都必须先分到队里**，否则房主点「开始比赛」会被服务端拒绝。

在「2. 开一个房间（房主）」里点一个按钮，四个按钮原文是：

| 按钮文字 | 对应赛制 | 建议人数 |
| --- | --- | --- |
| 开团队个人赛房间（10 题 · 5 分钟） | 团队个人赛，各人各答，按队汇总 | 每队 1–3 人 |
| 开团队赛房间（1 答 2 辅 · 10 题 · 20 分钟） | 团队赛，1 人主答 2 人辅助 | **每队必须正好 3 人** |
| 开接力赛房间（3 棒 × 5 题 · 每棒 5 分钟） | 接力赛，剩余时间继承 | 每队 3 人最佳 |
| 开抢答赛房间（10 题 · 多队同场抢答） | 抢答赛，多队同场 | 建议 ≥2 队 |

**你应该看到**：跳到一个新页面，大字号显示「房间号」和一串 **6 位数字**，旁边有「复制房间号」按钮；上方标签显示「等待开始」「你是房主」。

**第 2 步：把房间号告诉学生**

点「复制房间号」，粘到黑板/投影/微信群。**房间号只有 6 位数字。**

**第 3 步：学生进房**

学生在大厅的「2'. 加入房间（队员）」里，把 6 位房间号填进输入框（框里灰字是「6 位数字」），点「**进入房间**」。

**你应该看到**：学生进入房间页，出现在「还没分队的同学」名单里。

**第 4 步：建队 + 团队码**

- 队长（可以是学生，也可以是老师）在「新建队伍」框里填队伍名（框里灰字是「队伍名（你是队长）」），点「**新建**」。
- **你应该看到**：页面上出现队伍卡片，卡片上写着「**团队码**」和一串 6 位数字，队长自己带「队长」标记。
- 队员在「用团队码入队」框里填这 6 位数字，点「**加入**」。

页面上的原话是：「团队码由队长在自己的队伍卡片里看到。」

**第 5 步：准备**

每个人在自己那队里点「**我准备好了**」，按钮变成「**取消准备**」，房主那侧的成员名字后面从「未准备」变成「已准备」。

> 准备是给房主看的信号，**不是开赛的硬性条件**——房主随时能点开始。但建议等大家都准备好，否则有人还在加载页面就已经开考了。

**第 6 步：房主开赛**

房主在「开赛」区点「**开始比赛**」。按钮可点与否，取决于队伍人数：

| 赛制 | 什么时候能点 |
| --- | --- |
| 团队赛（1 答 2 辅） | 每支队都必须正好 3 人，少一个都点不动 |
| 团队个人赛 / 接力赛 / 抢答赛 | 每支队至少 1 人即可 |

点不动时页面上会给出原因，例如「至少需要一支队伍」「『第一队』还差 1 人（1 答 2 辅必须凑满 3 人）」，接力赛还会提示某队人数不足、将按人数循环排棒次。

> 注意：上面说的是按钮什么时候能点。真正开赛时服务端还会再检查一次「所有在场同学都已分队」，若还有人在「还没分队的同学」名单里，会报「还有 N 名玩家未分队」，让他们先入队或先离开房间。

**你应该看到**：全场同时跳到答题页，顶部开始倒计时，所有人题目一致。

**学生那边看到的**：非房主在「开赛」区看到一行提示「等房主点开始。房主是 xxx。」——这就是正常的。

#### A9 比赛结束与成绩

**怎么交卷**：

- 个人赛/团队个人赛：到时间自动交卷，或点顶部「**交卷**」→ 弹窗「确认交卷？」→「确认交卷」。
- 团队赛（1 答 2 辅）：按钮文字是「**本队交卷**」，全队一起结束。
- 接力赛：顶部按钮是「**结束本队作答**」；当前这一棒还可以点「**交棒给 XXX**」（本地三棒练习时显示「**提前交棒**」），把剩余时间交给下一棒。
- 抢答赛：**没有交卷按钮**。每道题按「看题缓冲 → 抢答窗口 → 公布答案」自动推进，题目走完自动结束。

**成绩存在哪（重要）**：

- 服务端**不保存**任何成绩，关掉窗口就全没了。
- 成绩保存在**每个学生自己那台设备的浏览器**里（本地存储）。刷新页面、关掉浏览器再打开，首页「历史成绩」里还在。
- 成绩页有「**导出 CSV**」「**导出 JSON**」两个按钮，文件名形如 `成绩-<卷名>-20261106-1530.csv`。
- 联机比赛中，房主的成绩页还会显示「**全部队伍**」的排名。

**老师要收全班成绩怎么办**：让每个学生在成绩页点「**导出 CSV**」，把文件发给你（微信/邮件/U 盘都行）。因为成绩不上服务器，这是唯一可靠的收集方式。**建议赛前就和学生说好这一步。**

**怎么结束整场**：

- 直接关掉 `start.cmd` 那个黑窗口，或在窗口里按 `Ctrl + C` → 服务立即停止，所有房间消失。
- 下次上课重新双击 `start.cmd` 即可，房间号、团队码都会重新生成。

#### A10 常见故障表

| 现象 | 最可能的原因 | 怎么修 |
| --- | --- | --- |
| 老师自己打不开 `127.0.0.1:8787` | 黑窗口关了 / 启动失败 | 重新双击 `start.cmd`，看窗口里有没有 `ready.` |
| 学生打不开 lan 地址，老师本机能打开 | 防火墙没放行 | 按 A5 手动放行 `runtime\node.exe`，或换手机热点试试 |
| 学生打不开，提示「无法访问此网站」 | 不在同一 Wi-Fi / 用了流量 / 学校网络隔离 | 让学生连教室 Wi-Fi；关掉「访客网络」；实在不行用手机热点 |
| 大厅状态一直是「未连接」 | 地址填错：少了 `http://`、端口不是 8787、带了 `/#/join` | 清空重填 `http://IP:8787` |
| 点「连接后端」提示「地址格式不对」 | 用了中文冒号、多了空格、用了 `https://` | 手动重敲一遍 |
| 页面能打开，但点按钮没反应/报错 | 前端是旧版本，和后端不匹配 | 重新跑一次打包（见附录），或换用配套的 `packages\web\dist` |
| 建房按钮点了报「房间数已达上限」 | 房间数到顶（默认 100） | 关掉旧窗口重开；或按下面「换端口/改房间数」的命令加大上限 |
| 启动窗口出现 `启动失败: listen EADDRINUSE: address already in use ...` | 8787 端口被别的程序占了（可能上次的窗口没关干净） | 关掉所有黑窗口重试；还不行就换端口（见下） |
| 双击 `start.cmd` 窗口一闪就消失 | 缺 `runtime\node.exe` / 解压不完整 / 路径带中文或空格 | 重新解压到 `D:\aixx-server-win`；确认 `runtime\node.exe` 存在 |
| 学生页面显示「掉线」 | 网络抖动、手机锁屏、走到 Wi-Fi 边缘 | 等服务端 30 秒宽限内恢复；恢复不了就重新进房（未开赛时） |

**换端口 / 改房间数**（零基础也能做）：打开 `D:\aixx-server-win` 文件夹，在资源管理器**地址栏**输入 `cmd` 回车，在打开的窗口里粘贴下面这行并回车；看到 `ready.` 后，把 `lan` 地址的端口换成 9000 再发给学生：

```bat
runtime\node.exe packages\server\src\main.ts --port 9000 --max-rooms 30 --web-root packages\web\dist
```

**查看本机 IP**（分不清 lan 该用哪个时）：在上面的命令行窗口里输入 `ipconfig` 回车，找「IPv4 地址」，选和学生手机同一网段的那个（一般是 `192.168.` 开头）。也可以用 `ipconfig | findstr IPv4` 只看 IP 行。

**确认端口被谁占了**（进阶）：`netstat -ano | findstr :8787` 看最后一列的进程号，再 `taskkill /PID 进程号 /F` 结束它。

#### A11 零基础 FAQ

**Q：一定要装 Node.js 吗？需要联网吗？需要账号吗？**
都不用。包里自带 `runtime\node.exe`，双击 `start.cmd` 用的就是它；运行不需要外网、不需要账号，真正需要的只是「老师电脑和学生设备连同一个路由器」。装 Node 只在「重新打包」时才用（附录），零基础同学永远用不到。

**Q：最多能来多少人？能开几个房间？**
单机默认 **100 个房间 × 每房 12 人**，每个房间独立房间号，可以几个班同时用一台电脑。但真正的瓶颈是教室 Wi-Fi，建议一场先控制在 40 人以内，稳了再放大。

**Q：数据存在哪里？会不会丢？关掉窗口后学生正在做的题会怎样？**
题库/试卷在包里 `data` 目录（只读）；比赛过程只在服务器内存，**关窗口即全部消失**；成绩在各人浏览器本地，不清缓存就一直在，可以导出 CSV/JSON。所以务必等所有人交卷后再关窗口，重要成绩当场导出。

**Q：老师电脑锁屏 / 合盖会怎样？**
只关屏幕没问题。但**睡眠 / 休眠 / 合盖**会让服务暂停，学生会全部掉线。赛前把电源计划里的「睡眠」改成「从不」，并插上电源。

**Q：可以用手机热点吗？**
可以。老师手机开热点，老师电脑连热点，学生也连同一个热点。手机热点通常允许设备互访；如果个别手机热点开了「AP 隔离」就连不上，换成教室路由器。

**Q：能不能直接放到公网，让校外学生练？**
**不建议**。这个服务默认没有账号、没有鉴权、没有 HTTPS，任何人拿到地址都能建房、看题。确实需要公网时，至少加反向代理 + 访问控制 + HTTPS（wss）。

### 路线 B：Linux 服务器（机房 / 云主机长期开）

> 这一段面向有一点 Linux 基础的同学。本机是 Windows 环境，下面命令按仓库里的 `deploy/linux/README.md`、`deploy/linux/Dockerfile`、`deploy/linux/docker-compose.yml` 整理，**未在真实 Linux 上逐条实跑**，执行时以文件内容为准。

前置：服务器是 **Linux x64**。B0 不需要预装任何东西；B1/B2 需要 Node.js **≥ 22.18**，并把仓库 `git clone` 到 `/srv/aixx-arena`。

#### B0 直接用发布包（最省事，x64）

从 [Releases](../../releases/latest) 下载 `aixx-server-linux-v0.1.tar.gz`，解压后执行：

```bash
tar -xzf aixx-server-linux-v0.1.tar.gz
cd aixx-server-linux
bash start.sh
```

包内自带 Node 22，不依赖系统 Node；窗口打印 `lan http://...:8787` 后，学生用浏览器打开它即可。换端口用 `PORT=9000 bash start.sh`，停止按 `Ctrl+C`。包只支持 x64；ARM64 请走 B1/B2。

#### B1 Docker Compose（推荐）

```bash
#在 aixx-arena/ 仓库根目录执行
npm ci
npm run sync:data
npm run build:web
docker compose -f deploy/linux/docker-compose.yml up -d --build
curl http://localhost:8787/healthz
```

- 看到 `{"ok":true,...}` 即成功。
- 改对外端口：`ARENA_PORT=9000 docker compose -f deploy/linux/docker-compose.yml up -d`
- 改房间上限：`ARENA_MAX_ROOMS=30 docker compose -f deploy/linux/docker-compose.yml up -d`（compose 会把它作为 `--max-rooms 30` 传给服务端）
- 看日志：`docker compose -f deploy/linux/docker-compose.yml logs -f arena`
- 更新代码后重建：同上 `up -d --build`
- 注意：服务端只认命令行参数，不读环境变量；compose 文件里已经把 `ARENA_MAX_ROOMS` 映射成 `--max-rooms`，`ARENA_ALLOW_ORIGIN` 不再使用。

#### B2 不用 Docker：Node 直跑

```bash
#在 aixx-arena/ 仓库根目录
npm ci                   # 构建前端需要 vite，别加 --omit=dev
npm run sync:data        # 把 data/ 题库同步成前端 bank.json
npm run build:web        # 生成 packages/web/dist
node packages/server/src/main.ts --port 8787 --host 0.0.0.0 --web-root packages/web/dist
```

前台跑，关掉终端就停；适合先试通。若想只装运行期依赖，可以先在别的机器构建好 `packages/web/dist` 再拷过来，然后 `npm ci --omit=dev`。

#### B3 开机自启（systemd 常驻）

`/etc/systemd/system/aixx-arena.service`：

```ini
[Unit]
Description=aixx-arena online server
After=network-online.target

[Service]
WorkingDirectory=/srv/aixx-arena
ExecStart=/usr/bin/node packages/server/src/main.ts --port 8787 --host 0.0.0.0 --web-root packages/web/dist
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now aixx-arena
systemctl status aixx-arena --no-pager
curl http://127.0.0.1:8787/healthz
```

注意 `User=www-data` 需要对 `/srv/aixx-arena/data` 有读权限。

#### B4 反向代理与 HTTPS（wss 的坑）

用 nginx 反代时，**WebSocket 必须单独放行**，否则页面能开、点了「连接后端」永远转圈：

```nginx
location /ws {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
location / {
    proxy_pass http://127.0.0.1:8787;
}
```

**混合内容坑**：页面是 `https://` 时，浏览器会拦截页面对 `ws://` 的连接。此时必须在 nginx 上配 TLS，让学生填 `https://域名`，WebSocket 自动走 `wss://`。要么就干脆只用 `http://` 内网访问。

### 路线 C：纯静态托管（只放前端）

**能做什么**：把 `packages/web/dist` 里的所有文件上传到任意静态托管（GitHub Pages、校园网文件服务器、Nginx 静态目录），学生打开网址就能练。

**怎么做**：取仓库里 `packages/web/dist` 整个目录（不是 `src`），原样上传到静态托管的根目录；如果要放在子路径（如 `https://xx.github.io/aixx/`），直接放进去即可——前端用的是相对路径 + hash 路由，不需要改配置。学生访问 `https://xx.github.io/aixx/`。

**能力边界（按当前代码实际情况）**：

| 能力 | 纯静态 | 需要后端 |
| --- | --- | --- |
| 首页 5 种赛制单人练习（含接力/抢答的单人模拟） | ✅ 可以 | — |
| 成绩记录、逐题复盘、导出 CSV/JSON | ✅ 可以 | — |
| 多人同房、团队码、真实接力交棒、多队同场抢答、房主控场 | ❌ 不可以 | ✅ 需要 |

**常见错误**：把 `index.html` 放在电脑上**双击打开**（`file:///...`）。浏览器会拦截读取题库文件，页面一片空白。必须通过 `http://` 或 `https://` 访问。

**混合模式（静态站 + 教室后端）**：页面放在 GitHub Pages（https），后端在教室（http），浏览器会因混合内容拦截 `ws://`，连不上。要么页面也放内网 http 服务器，要么给后端配 HTTPS。

### 部署前检查清单

开赛前一天，逐条打勾：

- [ ] 压缩包已解压到 `D:\aixx-server-win`（纯英文、无空格、不在 OneDrive 同步目录）
- [ ] `D:\aixx-server-win\runtime\node.exe` 存在（文件管理器里能看到）
- [ ] `data\questions` 有 87 个题目文件、`data\papers` 有 5 个试卷文件
- [ ] 双击 `start.cmd`，窗口出现 `bank 87 题 / 5 卷` 和 `ready.`
- [ ] 浏览器打开 `http://127.0.0.1:8787/healthz` 返回 `"ok":true`
- [ ] 防火墙已放行（A5），没有「是否允许访问」的弹窗悬着
- [ ] 找一台**别的设备**（学生手机）连同一 Wi-Fi，打开 `http://lan地址/healthz` 也能看到 `"ok":true`
- [ ] 教室路由器没有开「访客网络 / AP 隔离」
- [ ] 老师电脑已插电源，电源计划里「睡眠」设为「从不」
- [ ] 提前跟学生说好：连教室 Wi-Fi、地址怎么输、成绩要自己导出 CSV

### 开赛前 10 分钟检查清单

- [ ] 双击 `start.cmd`，把 `lan` 地址抄到黑板/投影（只写到端口）
- [ ] 老师自己打开 `http://127.0.0.1:8787/healthz`，确认 `"ok":true`
- [ ] 老师手机连 Wi-Fi，打开 `http://lan地址/healthz`，确认能开
- [ ] 用一台学生设备完整走一遍：进大厅 → 填地址 →「连接后端」→「已连接」
- [ ] 建一间测试房，用第二台设备输房间号+团队码入队，确认「开始比赛」能点，然后「离开房间」
- [ ] 确认备用方案（手机热点、备用端口），并关掉占带宽的下载/同步工具

### 出问题按这个顺序查

按顺序来，**每步只做一件事**，前一步不通就别看后面的：

| 顺序 | 查什么 | 一句话命令 / 观察点 |
| --- | --- | --- |
| 1 | 程序还在跑吗 | 黑窗口还在？最后一行是不是 `ready. Ctrl+C to stop.` |
| 2 | 本机能访问吗 | 浏览器开 `http://127.0.0.1:8787/healthz`，有没有 `"ok":true` |
| 3 | 别的设备能访问吗 | 学生手机开 `http://lan地址:8787/healthz`，能开→服务没问题；打不开而第 2 步能开→九成是防火墙，回 A5 |
| 4 | 端口对吗 | 地址里的端口和窗口打印的 `lan` 端口一致？8787 有没有被别的程序占？ |
| 5 | 地址对吗 | 只填 `http://IP:端口`，不带 `/#/join`、不带空格、不用 `https` |
| 6 | 页面正常吗 | 页面能开但按钮报错 → 前端旧构建，重新打包或换配套 `web\dist` |
| 7 | 房间能建吗 | 报「房间数已达上限」→ 重开窗口或加 `--max-rooms` |
| 8 | 赛制能用吗 | 联机只有 4 种（团队个人/团队/接力/抢答）；「个人客观题」只能单人练，不能联机 |

### 参数表与容量

改参数的方式只有两种：改 `start.cmd`，或在文件夹里开 `cmd` 手动执行（A10 有步骤）。所有参数都支持 `--参数 值` 和 `--参数=值` 两种写法。

| 参数 | 默认值 | 含义 | 什么时候改 |
| --- | --- | --- | --- |
| `--port` | `8787` | 监听端口；填 `0` 表示随机分配 | 8787 被占用时改成 9000 |
| `--host` | `0.0.0.0` | 监听地址；`0.0.0.0` 局域网可访问，`127.0.0.1` 只允许本机 | 想禁止学生访问时改 `127.0.0.1` |
| `--web-root` | `packages/web/dist` | 前端静态目录 | 一般不动 |
| `--data-root` | `data` | 题库目录（含 `questions/`、`papers/`） | 题库放到别处时改 |
| `--allow-origin` | 空 | 只给 `/healthz` 加 CORS 头，例如 `"*"` | 用外部监控探活时 |
| `--max-rooms` | `100` | 最大房间数，超出后建房返回「房间数已达上限」 | 想限制同时开赛班级数时 |
| `--help` | — | 打印帮助后退出 | 忘了参数时看 |

容量上限（硬编码在程序里）：

| 项目 | 上限 |
| --- | --- |
| 单个后端实例的房间数 | 默认 100（可用 `--max-rooms` 改） |
| 每个房间人数 | 12 人 |
| 每支队伍人数 | 最多 3 人（团队赛 1 答 2 辅要求正好 3 人） |
| 联机开放赛制 | 团队个人赛、团队赛（1 答 2 辅）、接力赛、抢答赛（**4 种**） |
| 只能单人练的赛制 | 个人客观题（校赛，55 题 60 分钟） |

查看当前负载：浏览器打开 `http://IP:8787/healthz`，`rooms` 是当前房间数，`participants` 是在线人数。

### 安全提醒（请一定读）

- 这个服务**没有账号、没有密码、没有鉴权**。同一网络里任何人知道地址，都能建房、看题、改称呼。
- **只适合教室 / 内网**。不要做路由器端口映射、不要用内网穿透工具直接暴露到公网。
- 确实要给校外用，至少要做到：反向代理 + 访问控制（如 Nginx basic auth 或校园统一认证）+ HTTPS（wss），并限制 `--max-rooms`。
- 服务端**不持久化**任何对局数据，重启即清空，不要当成绩数据库；前端要离线判分，构建产物里的 `data/bank.json` 含答案与解析（打开浏览器开发者工具就能看到），原始 `data/questions/*.json` 不通过 web 服务暴露。**不适合作为正式考试的唯一依据**，建议当训练和模拟赛用。

### 附录：维护者重新打包（零基础同学可跳过）

只有需要**修改题目/前端**并重新生成发布包时才用这一段。需要一台装了 Node.js ≥ 22.18 的电脑（`node -v` 能看到版本号）。

```powershell
#在 aixx-arena\ 仓库根目录执行
npm ci
npm run sync:data      # 题库 JSON → packages/web/public/data/bank.json
npm run build:web      # 前端 → packages\web\dist
npm run pack:win       # 生成 Windows 便携包 → release\aixx-server-win
```

关键点：

- `pack:win` 默认用「当前运行 npm 的 `node.exe` 所在目录」作为运行时，一般不用设置；想固定到另一个 Node 版本时再指定：

```powershell
$env:ARENA_NODE_DIR = 'C:\path\to\node-v22-win-x64'
npm run pack:win
```

- 官方 Node 压缩包解压后即可作为 `ARENA_NODE_DIR`（目录里要有 `node.exe`）。产物在 `aixx-arena\release\aixx-server-win\`，整个目录拷走/压缩即可分发；分发前先按 A4 自测一遍 `start.cmd`。包内 `README.txt` 由脚本自动拼接 `packages\server\README.md` 生成，所以改完服务端说明后重新打包即可同步。

## 系统设计
本节回答「怎么搭」：为什么是这套架构、核心逻辑长什么样、前后端各自负责什么。代码级完整契约在 `docs/design.md`，文末附节号索引。
### 设计总览
**设计目标**

- **没网也能练**：纯静态托管就能跑完五个赛制；团队、接力、抢答在本地退化为单人模拟。
- **有网就联机**：一台普通电脑起后端，教室同场跑赛制 2–5，不需要账号、数据库或第三方服务。
- **规则参数化**：题量、时长、分值、抢答名额比例都写在试卷 JSON 里，改规则不改代码。
- **好交接**：社团学生维护，依赖能少一个就少一个；离线可用，能塞进一个 U 盘带进教室。

**从需求继承的硬约束**

| 约束 | 对设计的直接影响 |
| --- | --- |
| 静态模式必须永远完整可用 | 核心逻辑不能依赖服务端；前端自带运行时 |
| 有服务端则服务端判分 | 后端加载题库，且要能剥离答案后再下发 |
| Linux 服务器 + Windows 个人电脑双部署 | 后端同时托管前端静态文件（免跨域、免 TLS） |
| 电脑优先 | 三栏布局（题号面板 / 主区 / 状态条），键盘全覆盖 |
| 无账号 | 身份靠客户端持久化的 `participant_id` + 服务端内存会话 |
| 一房多队、上限自适应 | 房间是一等对象，队伍是房间内集合，容量靠配置 |
| 断线 30s 续 / 超时自动交 | 服务端持有宽限计时器，重连发快照而不是重放事件 |
| 题库后期补充 | 组卷支持降级；扩容只需往 `data/questions/` 丢 JSON 再 `sync:data` |
| 接力 / 抢答是多队同场 | 这两个赛制的状态是「每队一份进度」，不是「房间一份」 |

**一句话**：同一套 `core` 状态机与判分函数，既在浏览器里跑（`LocalDriver` 驱动），也在服务器上跑（`MatchDriver` 驱动）；区别只在「谁给时间、谁持有题库、谁判分」。
### 总体架构
**四种运行形态**

```
形态 A｜纯静态：browser ── 静态资源 + 题库 JSON ──> LocalDriver ──> core 状态机
形态 B｜单机局域网：browser ── http/ws 同源 ──> arena-server ──> MatchDriver ──> core
                    └─ 同时托管前端静态资源（推荐形态）
形态 C｜Linux 服务器：browser ── https/wss ──> Nginx ──> arena-server ──> MatchDriver
形态 D｜静态前端 + 独立后端：browser ── https(页面) + wss(隧道) ──> arena-server
                    └─ 后端不托管页面：跨域 + 跨协议，限制最多
```

**四种形态的能力边界**

| 形态 | 页面从哪来 | 可用赛制 | 需要后端 |
| --- | --- | --- | --- |
| A 纯静态 | 任意静态托管 | 1–5（团队 / 接力 / 抢答为单人模拟） | 否 |
| B 单机局域网 | 后端同端口托管 | 2–5 真联机（赛制 1 仍在本地） | 是 |
| C Linux 服务器 | Nginx 或 Node 直出 | 同上 | 是 |
| D 静态前端 + 独立后端 | 静态托管 | 同上，但后端必须 https + wss 隧道 | 是 |

**谁驱动、谁判分**

| 驱动 | 位置 | 时钟来源 | 判分位置 | 持久化 |
| --- | --- | --- | --- | --- |
| `LocalDriver` | 浏览器 | 本地 `Date.now()` + 绝对截止时刻 | 前端（core 同一函数） | localStorage |
| `MatchDriver` | Node 服务端 | 服务端单一时钟 | 服务端（core 同一函数） | 内存 |

形态 D 是最容易被写成「支持」的一格：GitHub Pages 是 https，浏览器不允许它连 `ws://` 局域网地址（混合内容硬拦截），所以形态 D 只在「后端走 https 隧道」时成立。**平时练习直接用形态 B**：老师在自己电脑上双击，把局域网地址发群里，学生打开就是同源页面。
### 核心设计决策及理由
**状态机是纯函数**

```ts
reduce(state: S, event: MatchEvent, ctx: ReduceCtx): { state: S; effects: Effects }
```

- **不读系统时间**：时间由 `event.at` 传入，测试可以精确构造「第 3 分 12 秒交棒」，不用 mock 时钟。
- **不产生副作用**：网络发送、定时器设置、日志都是 `effects` 里的声明，由驱动方执行。
- **可序列化**：`state` 是纯数据，能直接存 localStorage，也能当重连快照发出去。
- 因此五个赛制、所有超时边界、抢答排序都能在无网络、无时钟依赖的单测里验证；静态模式与联机模式的规则不会漂移。

**判分只在服务端（联机时），下发前裁答案**

- 服务端持有完整题库与答案；下发题面只走 `Room.toPaperQuestions()`，白名单字段：`id / type / stem / stem_images / options / difficulty / taxonomy`，`answer` / `explain` 从不下行。
- `ack` 永不携带 `answer` / `explain`，只带 `correct` / `points`；答案只能从 `reveal` 出。`reveal` 范围跟着封卷范围走：solo / team-solo 只发本人，team-coop / relay 只发该队，buzz 在本题关闭后全房广播；全场结束统一发 `summary`（含逐题答案，供成绩页）。
- 静态模式没有保密需求，答案随题库进前端；但判分仍走同一个 `judge()`。联机时前端是不可信输入，答案一旦下行就等于把卷子送出去；而「前后端 import 同一份判分实现」是验收项 AC-11 的契约点。

**全链路 snake_case，不设字段转换层**

磁盘 JSON、WS 帧、TS 接口三者字段同名同形，零转换、零映射。题库与试卷由教练手改 JSON，磁盘上已经是 `snake_case`；再加一层 mapper 等于给每个字段准备一个写错的机会。

- 数据字段 `snake_case`；函数与局部变量 `camelCase`；类型 `PascalCase`；常量 `UPPER_SNAKE`。
- 时间单位写进字段名：`*_at` 是 epoch 毫秒，`*_sec` 是秒，`*_ms` 是毫秒；禁止 `timeout`、`duration` 这种不带单位的字段。

**solo 与 team-solo 共用一段答卷逻辑**

两者 `Sheet` 同构，只在 `summarize` 上分叉：solo 按人出成绩，team-solo 按队聚合（团队分 = Σ 成员分）。实现放在 `packages/core/src/formats/sheet.ts`，不做两份。
### 技术栈
选型总原则：**能少一个依赖就少一个**。项目由社团学生维护、要离线可用、要装进 U 盘，任何「顺便引入」的库都会变成交接成本。

| 层 | 选型 | 版本基线 | 理由 |
| --- | --- | --- | --- |
| 语言 | TypeScript（`strict: true`） | 5.6+ | 前后端共享类型，协议字段写错在编译期暴露 |
| 包管理 | npm workspaces | 10.x | npm 自带，少一个工具依赖；与 CI、Docker 构建一致；registry 固定 npmmirror |
| 前端框架 | Vue 3（`<script setup>`） | 3.5+ | 中文资料多、SFC 上手快；响应式模型贴合「倒计时 + 状态广播」 |
| 构建 / 路由 | Vite 6 + vue-router 4（hash 模式） | 6.x / 4.x | 静态产物、`base` 可配子路径；静态托管没有服务端重写，hash 免 404 |
| 状态 / 样式 | `reactive()` 单例 + 原生 CSS 变量 | — | 全局只有一个「当前对局」，Pinia 的模块拆分没有收益；视觉简单，不需要组件库 |
| 后端运行时 | Node.js | 22 LTS | 单进程足够撑一场比赛；可随便携包直接分发 `node.exe` |
| WS 库 | `ws` | 8.x | 事实标准、协议透明、可直接抓帧调试 |
| 参数校验 | 手写校验（`packages/server/src/session.ts`） | — | 消息种类少、错误文案要中文，schema 库收益不如三行 `if` |
| 测试 | **`node:test` 内置** + TS 直跑 | Node 22.18+ | Node 22 原生执行 `.ts`（type stripping），省掉 Vitest 依赖与转译层 |
| 前端逻辑测试 | `node:test` + `packages/web/test/loader.mjs` | — | loader 把 `@aixx/core`、`@/` 重定向到源码，`localStorage` / `fetch` / `document` 用内存替身 |
| E2E 回归 | 无头浏览器 + DevTools 协议 | — | 开发期用临时脚本做点击 + 截图核对，脚本未入库；不引 Playwright |

前端明确不引入：UI 组件库、CSS 框架、图标库（用内联 SVG）、国际化库（中文单语）。
### 被否决的方案与理由
| 方案 | 否决理由 |
| --- | --- |
| Socket.IO | 自带协议封装与降级逻辑，包体大、帧不可见、调试难；本项目消息量很小，不需要 |
| 数据库（SQLite / Postgres） | 需求明确无长期成绩；引入后部署门槛与运维成本陡增 |
| Supabase / Firebase Realtime | 无法做权威裁决（抢答排序、接力计时必须在自己的服务端） |
| Next.js / SSR | 纯静态优先，SSR 增加部署形态与构建复杂度，零收益 |
| UI 组件库（Element Plus / Ant Design） | 题库站视觉简单，组件库带来体积与样式覆盖成本；自写 CSS 变量更可控 |
| 前端直接置入赛制逻辑 | 会导致前端一套、后端一套，规则必然漂移（AC-11 会失败） |
| `snake_case` ↔ `camelCase` 转换层 | 磁盘已是 snake_case；加一层 mapper 等于给每个字段准备一个写错的机会 |
### 仓库与目录结构
```
aixx-arena/
├─ package.json / .npmrc / tsconfig.base.json  # workspaces 根、npmmirror、共享编译选项
├─ docs/                       # requirements.md（需求基线 v0.3）、design.md（技术方案）
├─ data/                       # 题库与试卷的唯一起源（87 题 + 5 卷）
│  ├─ questions/               # 单题一 JSON（q-tmp-*.json，全部 verified）+ _import-report.md
│  └─ papers/                  # 校赛 55 / 团队个人 10 / 团队 10 / 接力 5×3 / 抢答 10
├─ packages/
│  ├─ core/   # 纯逻辑、零运行时依赖：types / scoring / draw / buzz / rng / public / protocol / state / formats / test
│  ├─ web/    # Vue 3 前端：router（7 页）/ drivers / stores / storage / components / public/data/bank.json / test
│  └─ server/ # Node 22 联机后端：main / server / rooms / session / driver / http / data / core / test
├─ deploy/                     # linux/{Dockerfile,docker-compose.yml,README.md}、windows/README.md
└─ scripts/                    # 导题、生成试卷、sync-data、verify-data、pack-release
```

**依赖方向（强约束）**：`web → core`、`server → core`，`core` 不依赖任何人；`web` 与 `server` 之间零代码依赖，只共享 `core` 里的类型与协议。
### 数据契约
#### 题目（`Question`）
| 字段 | 类型 / 取值 | 说明 |
| --- | --- | --- |
| `schema_version` | `1` | 结构版本，加载期校验 |
| `id` | `string` | 题目唯一 id |
| `type` | `'single' \| 'multiple' \| 'judge'` | 单选 / 多选 / 判断 |
| `stem` / `stem_images` | `string` / `string[]?` | 题干与题干图 |
| `options` | `{ key: string; text: string }[]` | 选项 |
| `answer` | `string[]` | 正确答案 |
| `answer_status` | `'pending' \| 'verified' \| 'disputed' \| 'expired'` | 只有 `verified` 参与组卷与计分 |
| `explain` / `taxonomy` | `string?` / `string[]?` | 解析 / 考点标签 |
| `difficulty` | `1 \| 2 \| 3`（可选） | 难度 |
| `exam_year` / `round` / `score` | 可选 | 来源年份 / 轮次 / 原始分值 |
| `title` | `string?` | 可选标题 |
#### 试卷（`Paper`）
| 字段 | 类型 / 取值 | 说明 |
| --- | --- | --- |
| `schema_version` | `1` | 结构版本 |
| `id` / `name` | `string` | 试卷 id 与显示名 |
| `format` | `'solo' \| 'team-solo' \| 'team-coop' \| 'relay' \| 'buzz'` | 赛制 |
| `duration_sec` | `number` | 全局时长；buzz 为 0（每题自己的窗口），relay 为单棒 X 秒 |
| `draw` | `DrawSpec \| null` | relay 卷为 `null`，题量全部落在 `legs` |
| `legs` | `[DrawSpec, DrawSpec, DrawSpec]?` | relay 三棒各自的组卷规则 |
| `submit_mode` | `'batch' \| 'stream'` | 交卷时判分 / 逐题即时判分 |
| `scoring` | `ScoringConfig` | 判分配置 |
| `buzz` | `BuzzConfig?` | 仅 `format='buzz'` 必填 |

三个内嵌配置块：

- `DrawSpec`：`single` / `multiple` / `judge` 题数、`taxonomy?`、`difficulty?`、`min_available`、`allow_partial`、`seed?`（`null` = 用运行时种子）。
- `ScoringConfig`：`mode`（`per_question` / `correct_minus_wrong`）、`points`（按题型给分）、`wrong_penalty`、`unanswered`、`total_normalize`（0 = 不折算百分制）。
- `BuzzConfig`：`buffer_ms` 禁抢缓冲、`submit_window_sec` 开抢窗口、`qualify_ratio`（0.5）、`qualify_fill`（`strict` / `fill`）、`correct_points`、`wrong_points`、`reveal_sec`、`close_on_all_submitted`、`tie_window_ms`（默认 5）。

> 没有 `judge_location` 字段（v0.1 有、v0.2 删）：判分位置不是试卷属性，而是运行模式的推论。写进试卷只会制造「配置说前端判、实际有后端」的矛盾。
#### 对局状态、事件与效果
`MatchStateBase`（五个赛制都继承它）：

| 字段 | 说明 |
| --- | --- |
| `format` | 判别字段，房间只持有一个 `MatchState` 联合类型，不写五份分支 |
| `roster` | 开赛瞬间固化的成员快照（`teams[{id,name,member_ids,captain_id}]` + `names?`），开赛后不再变动 |
| `phase` / `started_at` / `deadline_at` | 阶段与绝对时间锚点 |
| `ended_at?` / `end_reason?` / `total` / `notice?` | 结束时间与原因（`time / host / self / all_done`）、本局题量、组卷降级提示 |

`MatchEvent`：

| 字段 | 说明 |
| --- | --- |
| `type` | `START` / `SUBMIT` / `ADVANCE` / `HANDOFF` / `SET_ANSWERER` / `FINISH` / `TICK` / `END` |
| `at` | epoch 毫秒，由驱动注入，状态机不读系统时间 |
| `actor_id?` / `team_id?` / `qid?` / `choice?` | 提交类事件的载荷 |
| `member_id?` | `SET_ANSWERER` 的目标成员 |
| `reason?` / `seq?` | 结束原因；客户端自增序号，仅 `SUBMIT` 需要，每 participant 每局从 1 单调递增 |

`Effects`：`broadcast?`（`Outgoing[]`）、`to_team?`（按队定向）、`to_member?`（按人定向）、`timers?`（`{ key, at }[]`，绝对时刻，驱动负责设 / 清）、`log?`。`ReduceCtx`：`paper`、`questions`（已组卷，接力已按棒切分）、`roster`、`degraded_notice?`。

`FormatSpec`：`init(ctx, at)`、`reduce(state, event, ctx)`、`view(state, viewer_id, at)`、`is_ended(state)`、`summarize(state, ctx)`。`view` 不收 `ctx`——`roster` 已固化进 state，重连快照必须自足。
#### 加载期校验规则
`scripts/verify-data.mjs` 与启动加载共用同一套规则，任何一项失败即启动 / 校验失败：

- `schema_version === 1`；`format` 属于已知集合；`duration_sec >= 0`；`submit_mode` 属于已知集合。
- **`draw` 与 `legs` 二选一恰好一个非空**：非 relay 卷 `draw` 非空、`legs` 为空或缺省，各题型数量 ≥ 0 且总数 > 0；relay 卷 `draw === null`、`legs` 恰好 3 段，每段各题型 ≥ 0 且**每段**总数 > 0。
- relay 的 `duration_sec > 0`（单棒 X 秒，全局 = 3X）。
- buzz 必须有 `buzz` 配置：`qualify_ratio ∈ (0,1]`、`tie_window_ms >= 0`、`buffer_ms >= 0`，且 `submit_mode === 'stream'`（抢答没有「交卷时再判」的语义）。
- 试卷引用的题库容量在运行时校验（组卷时检测池容量）。
### 判分与组卷
#### 判分 `judge()`
```ts
judge({ question, choice, scoring, answered }): { correct, points, scored }
```

- `answer_status !== 'verified'` 或 `answer` 为空 → `scored: false, points: 0`，并从满分分母中剔除。
- 单选 / 判断：`choice.length === 1 && choice[0] === answer[0]`。
- 多选：集合相等才算对（排序后比较）；少选 / 多选 / 错选都算答错。
- 未答：`points = scoring.unanswered`（默认 0），`correct: false`；答错：`points = scoring.mode === 'correct_minus_wrong' ? -wrong_penalty : 0`。
- 百分制折算：`normalize(raw, max_raw) = round(raw / max_raw * total_normalize)`，`max_raw` 只累计 `scored: true` 的题。校赛 55 题卷 `max_raw = 30×1 + 15×2 + 10×1 = 70`，再折算成 100 分。
#### 组卷 `draw()`
```ts
draw(pool, spec, seed, used_ids?): { questions, degraded, available_count, requested_count, notice? }
```

- 只从 `answer_status === 'verified'` 且有答案的题里抽，并排除 `used_ids`；`mulberry32` 按 `(spec.seed ?? seed)` 初始化，保证同种子同卷。
- 题量不足且 `allow_partial`：按比例缩减各题型 `floor(need * available / requested)`，余数补到单选；否则抛 `INSUFFICIENT_POOL`。可用数 < `min_available` → 拒绝组卷。
- 降级会在卷首明示，例如「本卷 40/55 题有答案，满分按 40 题折算」；提示落到 `summary.degraded_notice`。
- **接力分棒**：三段种子为 `(spec.seed ?? legs[0].seed ?? 2026) + i * 1000`，`used_ids` 串行传差集，保证三段互不重复；不靠「换个种子碰运气」。每段题数可以不同，但必须都 > 0。
### 五个赛制
五个赛制都注册在 `packages/core/src/formats/index.ts`，对外统一暴露 `initMatch / reduce / view / isEnded / summarize`。

| 赛制 | `format` | 预置卷面 | 判分模式 |
| --- | --- | --- | --- |
| 个人客观题（校赛） | `solo` | 55 题（单选 30 / 多选 15 / 判断 10），60 分钟，满分 100 | batch |
| 团队个人赛 | `team-solo` | 10 题（6 / 2 / 2），5 分钟 | stream |
| 团队赛（1 答 2 辅） | `team-coop` | 10 题（6 / 2 / 2），20 分钟 | stream |
| 接力赛 | `relay` | 3 棒 × 5 题（每棒 3 / 1 / 1），每棒 5 分钟 | stream |
| 团队抢答 | `buzz` | 10 题（5 / 3 / 2），每题独立窗口 | stream |

**`solo`（赛制 1）**

- 状态：`sheets: Record<member_id, Sheet>`，`Sheet` 含 `answers{choice, at, seq}`、`locked`、`judged`（交卷时才计算）。
- 事件与规则：`START` → `SUBMIT` / `TICK` → `FINISH`（本人封卷）→ `END`。batch 模式 `SUBMIT` 只记录不判分；stream 模式立即判分并锁题；`TICK` 到 `deadline_at` 发 `END{reason:'time'}`；`END` 逐人补判；`TICK` 幂等，已 `ended` 则忽略。
- 卷面：单选 1 分、多选 2 分、判断 1 分，不答不扣分，折算成 100 分。

**`team-solo`（赛制 2）**

- 状态：与 solo 同构的 `sheets`，每人一份；`ADVANCE` 无意义（游标在各自客户端）。
- 事件与规则：`START` / `SUBMIT` / `TICK` / `FINISH` / `END`。只走 stream，立即判分回 `ack(correct)`；**全员封卷或全局到期**才结算；团队总分 = Σ 成员分；配置写成 batch 会在加载校验阶段被拒绝。
- 卷面：每题 2 分，答错 −1，满分 20。

**`team-coop`（赛制 3）**

- 状态：每队 `CoopTeamState{ answerer_id, current_index, answers, locked }`，团队共享游标。
- 事件与规则：`START` / `SUBMIT` / `ADVANCE` / `SET_ANSWERER` / `TICK` / `END`。只有该队 `answerer_id` 能提交，提交后本题锁定（锁定 ≠ 移出题面）；主答或队长 `ADVANCE` 推进，最后一题再推进等价于本队交卷；队长或房主可换主答（掉线接管），写日志。
- 卷面：每题 4 分，答错 −1。

**`relay`（赛制 4）**

- 状态：`leg_order`（恰好 3 个成员 id，开赛固化）、`leg_index`、棒内 `current_index`、`leg_started_at`、`leg_budget_sec`、`carry_sec`、`answers`、`finished_at?`；另有 `leg_question_ids` 三棒题目切分。
- 时间继承（关键）：`carry = max(0, budget_sec - (at - leg_started_at) / 1000)`，下一棒 `budget = 300 + carry`，`leg_started_at = at`；全局 `deadline_at = 开赛时刻 + 3X × 1000`，**不随交棒变化**。用 `ceil` 会让队伍凭空多出 1 秒，所以必须直接截断。
- 事件与规则：`START` / `SUBMIT` / `ADVANCE` / `HANDOFF` / `TICK` / `END`。只能提交本棒题目；棒内推满后 `ADVANCE` 等价 `HANDOFF`；本棒超时由 `TICK` 强制交棒；第 3 棒 `HANDOFF` 即该队结束。不足 3 人按顺序循环补齐（如 `[A, B, A]`），日志记 `relay_short_team`。
- 卷面：每题 4 分，答错 −1，满分 60。

**`buzz`（赛制 5）**

- 状态：`qids`、`q_index`、`phase`（`buffer` / `open` / `closed` / `reveal` / `ended`）、`open_at`、`submit_deadline_at`、`reveal_end_at`、`n_at_open`、`close_reason?`、`announced`、`qualify_ratio` / `reveal_ms`（从试卷固化）、`submissions`、`scores`、`per_question`。
- 事件与规则：`START` / `TICK` / `SUBMIT` / `END`；没有「交卷」概念。`buffer_ms` 内禁抢，但**题面先推**（玩家有看题时间），由 `TICK` 触发 `announceQuestion()`；缓冲结束转 `open`，`n_at_open` 记下此刻队数；窗口结束或全员已交 → `closed` → `rankBuzz` → 计分 → `reveal`（停留 `reveal_sec`）→ 下一题或结束。`buffer` 或 `closed` 期的提交丢弃，日志记 `early_submit`。
- 卷面：每题答对 +4、答错 −1，未获名额 0 分；10 题满分 40。
#### 抢答排序 `rankBuzz`
```ts
rankBuzz({ submissions, n_at_open, qualify_ratio, qualify_fill, tie_window_ms, correct_points, wrong_points })
```

1. 按 `at` 升序；`at` 相同时按 `team_id` 字典序（保证确定性，不依赖 V8 排序稳定性）。
2. 聚簇：`at[i] - at[i-1] <= tie_window_ms`（默认 5ms）并入同一簇，簇的 `rank` = 簇首下标 + 1。
3. 名额 `quota = Math.ceil(n_at_open * qualify_ratio)`；N=3 → 2，N=4 → 2，N=5 → 3。
4. `in_quota = rank <= quota`；若某簇跨越名额边界，**整簇计入**（`boundary_tie_expanded = true`），但总数不超过 `n_at_open`。
5. `strict`：名额内答对得分、答错得 `wrong_points`、未交 0，名额外的答对也是 0。`fill`：名额内没答对留下的空位，按排名顺延给后面答对的队，补满为止。

**时间口径**：排序用的 `at` 一律是**服务端收包时刻**，不信任客户端时间戳；窗口内重连成功再提交，`at` 用真实收包时刻。断线宽限 30s 长于开抢窗口（默认 20s），所以抢答的宽限自动提交**不产生提交记录**，该队本题 0 分，日志记 `buzz_missed`——补交只会污染按提交时间排序的名额判定。
#### 谁推进题序
v0.1 有「下一题」这个交互却没有对应事件，导致 team-coop / relay 的题序无人推进；v0.2 补了 `ADVANCE`，并明确游标归属：

| 赛制 | 题序游标在哪 | 谁推进 | 「下一题」怎么做 |
| --- | --- | --- | --- |
| `solo` | 客户端本地 | 选手自己 | 不发事件；服务端只在 `END` 时按 qid 收卷 |
| `team-solo` | 每人客户端本地 | 各自选手 | 不发事件 |
| `team-coop` | state（团队共享） | 主答或队长 | `ADVANCE`：`current_index + 1`；到 `total - 1` 后再推进 ≡ 本队交卷 |
| `relay` | state（当前棒） | 当前棒选手 | `ADVANCE`：棒内 `current_index + 1`；到本棒最后一题后再推进 ≡ `HANDOFF` |
| `buzz` | state（全局） | 状态机自己 | 无需事件；`TICK` 驱动 buffer → open → closed → reveal → 下一题 |

solo / team-solo 的游标不进状态机，因为它们对判分毫无影响（交卷按 qid 对齐），放进状态机只会让两端游标同步变成新的故障点。
#### 交卷与结束语义
`submit_all` 是**协议消息**，落到状态机是 `FINISH` / `END` 两类事件：

| 赛制 | 谁的「交卷」 | 触发事件 | 结算范围 |
| --- | --- | --- | --- |
| solo | 本人 | `submit_all` → `FINISH`（本人封卷）；单人即全员封卷 → 立即 `END{reason:'all_done'}` | 该 participant |
| team-solo | 每个成员各自交 | `FINISH` 封卷；**全员封卷或全局到期**才结算 | 该 member（团队分 = Σ 成员分） |
| team-coop | 该队主答 | `submit_all` → `END{reason:'self'}`（只结算该队）；最后一题再推进也可封卷 | 该 team |
| relay | 当前棒选手 | `submit_all` → `FINISH`，连续交棒直至第 3 棒结束；或第 3 棒 `HANDOFF` | 该 team |
| buzz | 无「交卷」概念 | 题序走完（最后一题 reveal 结束） | 全部 team |

- **`FINISH` = 本人封卷**：只影响自己的答卷（`sheet.finished_at`）；已封卷再 `SUBMIT` 回 `WINDOW_CLOSED`；未到齐时给本人发 `notice`「你已封卷，X/Y 人完成，等待队友」。
- **房主 `end`**：任何赛制、任何时刻立即结算全场，`END{reason:'host'}`；未封卷的答卷按「截至此刻已答内容」结算。
- **重复交卷幂等**：已封卷的 scope 再收 `submit_all` 直接忽略，不回错误。
### 公共视图与结算
联机时前端只拿到裁剪后的公共视图，不含答案：

| 对象 | 关键字段 |
| --- | --- |
| `PublicBase` | `format`、`phase`、`server_at`（客户端据此算时钟偏移）、`clock{started_at, deadline_at, leg_deadline_at?, submit_deadline_at?, reveal_end_at?}`、`current_index`（`null` = 游标在客户端）、`total`、`viewer_id`、`own`、`peers`、`scores?`、`notice?` |
| `OwnView` | `scope`（`member` / `team`）、`answers`（该视角已提交的题）、`locked`、`can_submit`（辅助位 / 非当前棒为 false）、`finished?` |
| `PeerInfo` | `id`、`name`、`team_id`、`online`、`ready`、`progress{answered,total}`、`is_answerer`、`leg_index?`（仅 relay） |
| `PublicMatchState` | `PublicBase` + 各赛制附加字段：team-solo 的 `team`；team-coop 的 `team_id / answerer_id`；relay 的 `leg_index / leg_order / current_answerer_id`；buzz 的 `q_index / n_at_open / submitted_teams / quota` |
| `TeamResult` | `id`、`name`、`score`、`max_score`、`members[{id,name,score,answered,correct}]`、`detail[{qid, leg_index?, choice, correct, points, late_by_ms?}]` |
| `MatchSummary` | `format`、`started_at` / `ended_at`、`end_reason`、`teams`、`questions[{qid,type,answer,explain?,scored}]`、`degraded_notice?`、`buzz_per_question?`（每题 `n_at_open / quota / close_reason` 与完整 `ranking`） |

`late_by_ms` 记录断线补交的延迟，复盘时标黄；`buzz_per_question` 支撑抢答复盘（每题谁第几、是否并列、得了多少分）。
### 通信协议
#### 帧格式
纯 JSON 文本帧（无二进制），每帧 ≤ 64KB，不做分片。`protocol` 是整数版本号，前后端不一致直接拒绝连接（`VERSION_MISMATCH`）。
#### 消息
- 客户端 → 服务端：`hello`（`v` / `name` / `resume_id?`）、`create`、`join`、`new_team`、`join_team`、`ready`、`start`、`submit`、`advance`、`handoff`、`submit_all`、`end`、`set_answerer`、`ping`、`feedback`、`leave`。
- 服务端 → 客户端：`hello_ok`、`lobby`、`paper`、`room`、`question`、`ack`、`reveal`、`peer`、`score`、`sync`、`notice`、`ended`、`error`、`pong`。
- `lobby` 是开局前唯一状态源（房间号、赛制、试卷、房主、队伍、团队码只发本队成员、未分队散人）；`paper` 是开局瞬间的整卷题面（`PaperQuestion{id,type,stem,stem_images?,options,difficulty?,taxonomy?,source?}`，不含 `answer` / `explain`），solo / team-solo / team-coop 用整卷，relay / buzz 用 `question` 逐题推送；`notice` 是给单个玩家的人话提示，前端只显示成横幅，不参与状态判断。
#### 消息时机表
| 赛制 / 模式 | `submit` 后的 `ack` | `reveal` 时机 | 快照里带 answer? |
| --- | --- | --- | --- |
| solo（batch） | `{accepted:true, locked:false}`，**不带 correct** | 交卷后一次性全卷 | ❌ |
| team-solo（stream） | `{accepted, locked:true, correct, points}` | 交卷后一次性全卷 | ❌ |
| team-coop（stream） | 同上 | 交卷后一次性全卷 | ❌ |
| relay（stream） | 同上 | 交卷后一次性全卷 | ❌ |
| buzz（stream） | `{accepted, locked:true, correct}` | 本题 `closed` 后立即 `reveal`（含解析），停留 `reveal_sec` | ❌ |

- **`seq` 语义**：每 participant 每局从 1 单调递增。服务端保存 `last_seq`，`seq <= last_seq` → `STALE_SEQ`（丢弃、不回 ack）；接受后回 `ack{seq}`。这样重连补发天然幂等。
- **`LocalDriver` 必须合成同构消息**：内部跑 `reduce`，把 `effects` 转成与 `ServerMsg` 完全相同的对象，自己维护 `seq`。UI 拿到的消息流，两种模式逐字段一致。
- **UI 不得直接读 `MatchState`**，只能读 `room.snapshot` 与过程消息；这是代码评审清单上的审计点。
#### 错误码
| code | 含义 | 客户端行为 |
| --- | --- | --- |
| `BAD_MESSAGE` | 不是合法 JSON / 缺 `t` / 未知消息类型 / 参数类型不符 | 提示并忽略 |
| `VERSION_MISMATCH` | protocol 不一致 | 提示刷新 / 升级，断开 |
| `ROOM_NOT_FOUND` | 房间码不存在 | 回到输入页 |
| `ROOM_FULL` | 超出上限 | 提示房间已满 |
| `ROOM_STARTED` | 已开始，不可加入 | 提示等下一局 |
| `TEAM_NOT_FOUND` | 团队码错误 | 重输 |
| `NOT_AUTHORIZED` | 越权提交 / 交棒 / 推进 | 提示「不是你答题」 |
| `ALREADY_SUBMITTED` | 重复提交（stream） | 忽略（幂等） |
| `WINDOW_CLOSED` | 不在作答窗口 | 忽略 |
| `STALE_SEQ` | 补交序号过旧 | 丢弃 |
| `RATE_LIMITED` | 频率超限 | 退避重试 |
| `INTERNAL` | 服务端内部错误 | 提示稍后重试，并把服务端日志给维护者 |
### 前端设计
#### 路由（hash 模式）
| 路径 | 页面 | 说明 |
| --- | --- | --- |
| `#/` | Home | 五张赛制卡片（可离线 / 需联机）+ 题库概况 +「继续上次练习」+ 历史成绩 |
| `#/play/:match_id` | Play | 对局主界面；本地与联机共用，联机时 `match_id` 就是房间号 |
| `#/result/:match_id` | Result | 成绩 + 教练视角（多队）+ 逐题解析 + 导出 CSV / JSON + 纠错反馈 |
| `#/join` | Join | 联机大厅：后端地址、称呼、开房（四个联机赛制）、输房间号加入 |
| `#/room/:code` | Room | 房间大厅：房间号 / 队伍与团队码 / 新建与加入队伍 / 准备 / 房主开赛 |
| `#/settings` | Settings | 称呼、交卷后自动展开解析、清空本机记录 |
| `#/about` | About | 五赛制规则、部署指引、数据与纠错说明 |
#### 布局与交互（电脑优先）
```
┌────────────────────────────────────────────────┐
│ 顶部：赛事名 · 第 12/55 题 · 剩 42:31 · 交卷    │
├────────────┬───────────────────────────────────┤
│ 题号面板    │ 题干（可含图）                     │
│ 240px      │ A ○ …  B ○ …  C ○ …                │
│ 5×11 格     │ 上一题  标记  下一题                │
├────────────┴───────────────────────────────────┤
│ 底部：解析（交卷后）／队伍状态（联机）             │
└────────────────────────────────────────────────┘
```

- 键盘：`←/→` 切题（接力夹在本棒内），`A–H` 选项（多选可反复切换，交卷前可改）。**不做快捷键交卷**：交卷不可逆，必须走确认弹层。
- `<1100px` 题号面板收为顶部抽屉；手机竖屏退化为单列 + 底部固定「上一题 / 题号 / 下一题」。
#### 状态与本地存储
不引 Pinia：全局只有一个「当前对局」，一个 `reactive()` 单例就够。

| 状态块 | 内容 |
| --- | --- |
| `match` | `mode`（`local` / `room`）、`record`（试卷 + 题目 + roster + viewer）、`snapshot`、`cursor`、`flags`（标记存疑）、`acks`、`reveal`、`summary`、`notice`、`error` |
| `room` | `serverUrl`、`nickname`、`participantId`、`connected`、`clockOffset`、`lobby`、`paperQuestions`、`error` |

| 键 | 存储 | 内容 |
| --- | --- | --- |
| `arena:match:<match_id>` | localStorage | 本地对局：`{version, paper, questions, roster, viewer_id, nickname, state, summary, cursor, flags, finished, created_at, saved_at}` |
| `arena:profile` | localStorage | 称呼、交卷后自动展开解析 |
| `arena:room-result:<room_code>` | localStorage | 联机成绩页的本地备份（含 `reveal` 的答案与解析） |
| `arena:room-session` | sessionStorage | 当前房间的 `{server_url, nickname, room_code, participant_id}`，用于刷新 / 换设备回到房间 |

恢复顺序：进入 `#/play/:match_id` 先试联机房间（`hello{resume_id}` 接管），失败再退回本地断点；首页「继续上次练习」列出 `finished = false` 的本地对局。单局约 150KB，localStorage 足够放几十局。本地练习的 `roster` 由 `buildRoster(format, viewerId, nickname)` 造：team-coop 是 1 主答 + 2 个虚拟辅助，relay 是本人连当三棒，buzz 是一队一票；占位成员只存在于本地状态，不写入任何服务端数据。
#### 两个 Driver
```ts
export interface Driver {
  readonly matchId: string
  start(): void                    // 开赛 / 断点恢复后立刻补一帧 room 快照
  submit(qid: string, choice: string[]): void
  submitAll(): void                // solo/team-solo = 封卷；team-coop = 本队交卷
  end(): void; advance?(): void; setAnswerer?(memberId: string): void; handoff?(): void
  on(handler: (message: ServerMsg) => void): () => void
  dispose(): void; snapshot(): PublicMatchState | null; summary(): MatchSummary | null
}
```

- `LocalDriver`：内部跑 `reduce` + `setTimeout(TICK)`，把 `effects` 合成与 `ServerMsg` 同构的消息派发；状态写 localStorage 供断点续做。
- `ServerDriver`：只转发 WS，本地不跑状态机；靠 `room` / `question` / `ack` 驱动 UI；`ping/pong` 估时钟偏移（10s 一次），断线指数退避重连。
- **关键不变量**：UI 组件只消费 `ServerMsg`，不关心消息来自哪个 Driver，所以对局页、成绩页一行不改就能从本地切到联机（AC-11）。
#### 计时器渲染
倒计时组件只做展示：每 200ms 刷新 `deadline_at - now`，只在秒数变化时改文本。真正「时间到」由状态机的绝对 `deadline_at` 决定——`LocalDriver` 到点送 `TICK`，服务端到点结算——浏览器定时器偏几百毫秒不影响判分，刷新页面也能立刻对上。联机快照里的绝对时间先减去 `matchStore` 估计的时钟偏移再交给组件。
### 后端设计
#### 进程模型与模块职责
单进程、单事件循环、内存态。`http.Server` 同时承载静态资源、`/healthz` 与 `/ws` 升级。默认 `--max-rooms 100`、每房 ≤ 12 人（每队 ≤ 3 人）；教室场景通常一个房间一支队伍，连接数远低于 Node 单实例压力上限。

| 模块 | 职责 |
| --- | --- |
| `main.ts` | 解析 CLI（`--port/--host/--web-root/--data-root/--allow-origin/--max-rooms`）、打印 local/lan 地址与容量、优雅退出 |
| `server.ts` | 参与者注册表、协议路由、大厅与对局生命周期、断线宽限与 resume 接管、心跳与 `sync` |
| `rooms.ts` | 6 位房间码 / 团队码、容量校验、`questions` 快照、`toPaperQuestions()`（裁答案）、`lobbyFor()`、房间日志 |
| `session.ts` | 单连接：hello 超时、帧大小与 JSON 校验、限流、错误码与关闭 |
| `driver.ts` | `MatchDriver`：调 core `reduce`、把 `effects` 落成广播 / 定时器 / 日志、每事件后重播快照、按最近 deadline 送 `TICK` |
| `http.ts` | 静态托管、`/healthz`、SPA 兜底、MIME、路径越界防护 |
| `data.ts` | 启动时读 `data/questions/*.json` 与 `data/papers/*.json` 进内存，提供可判分题池 |
| `core.ts` | 相对路径 re-export `packages/core/src/index.ts`，绕开 node_modules 解析 |
#### 房间生命周期
```
创建（房主） → 等待（成员加入 / 分队 / 就绪） → 进行中 → 已结束
                     ↘ 房主离开 → 移交下一位队长
                     ↘ 无人 → 房间与定时器一起销毁
```

- 房间码 **6 位数字**（`000000`–`999999`），建房查重重试；团队码同为 6 位数字、房间内唯一，只发给本队成员。
- 房主离开后按队伍顺序移交下一位在线队长。大厅阶段成员全部离开即销毁；对局中全员离线 → 以 `all_done` 结束该局，房间保留（便于回看成绩），等成员陆续离开后自然回收。销毁时清空驱动器定时器。
#### 定时器、题库加载、判分保护
- **定时器**：每房间只保留 **1 个** `setTimeout`，指向 `state` 里最近的一个 deadline；触发时发 `TICK` → reduce → 若有新 deadline 则重设。deadline 列表由状态机通过 `effects.timers` 声明，驱动取最小值，避免「每题一个 timer、每题清理」的泄漏风险。
- **题库加载**：启动时一次性读 `--data-root`（默认 `<repo>/data`）下的题库与试卷，坏 JSON 直接启动失败（宁可起不来，也不要带着半份题库跑）；**不做热加载**（同 seed 同卷的可重现性不能受重启时机影响）；每局创建时抽题、裁面并把题面存进房间，之后题库文件怎么改都不影响进行中的对局与重连快照。
- **判分保护**：服务端持有完整题库（`ctx.questions`），判分只发生在服务端；下发题目一律走 `Room.toPaperQuestions()`，`answer` / `explain` 从不下行；`ack` 不带答案，答案只从 `reveal` 出。联机测试会断言整局下行 JSON 不含 `"answer"`。
#### 断线宽限
- 每个 participant 记 `{session, team_id, last_seen_at, offlineTimer}`；断开后启动 30s 宽限（`RECONNECT_GRACE_MS`）。
- 宽限内 `hello{resume_id}` 重连 → 绑定新连接、踢掉旧连接、补发当前 `room` 快照（含题面与倒计时锚点）。
- 宽限超时按阶段处理：**大厅阶段**从队伍 / 房间移除，房主移交，房间空则销毁；**对局阶段** solo / team-solo 派 `FINISH`（日志 `submit_all` + `via:'finish'`），其它赛制记 `submit_all_skipped`，由 `TICK` 继续推进（接力强制交棒、抢答记 `buzz_missed`）。
- 全部成员离线 → 以 `all_done` 结束该局。抢答不接受宽限期补交。
#### 安全
| 项 | 措施 |
| --- | --- |
| 房间码爆破 | 6 位数字（10^6），建房查重重试；加入失败只回 `ROOM_NOT_FOUND`，不回「码存在但没权限」 |
| 消息洪水 / 消息体 | 每连接 30 msg/s 令牌桶，超出回 `RATE_LIMITED`；单帧 ≤ 64KB（`maxFrameBytes`），超限断开 |
| 输入注入 | 手写校验：必须合法 JSON、必须带已知 `t`；昵称限长并去控制字符 |
| 越权 | 先查「参与者 → 房间 → 队伍 / 角色」再交给状态机；主答 / 队长 / 房主权限在 core 里再判一次 |
| 时间欺骗 | 不信任客户端时间戳，只用服务端 `Date.now()`；重连补偿由 `ping/pong` 单向下发 |
| 跨站 | 无 Cookie、无凭据；WS 校验 `Origin` 与 `--allow-origin` 白名单（默认同源） |
| 答案泄漏 | 题面投影与 `ack` 均不含 `answer` / `explain`，测试断言整局下行 JSON 无 `"answer"` |
#### 静态托管与可观测性
- 后端托管构建产物（默认 `packages/web/dist`，可 `--web-root` 指定），`index.html` 兜底 SPA 路由，做 MIME 与路径越界防护。Windows 便携包一个目录（`runtime/node.exe` + 源码 + `dist` + `data` + `node_modules/ws` + `start.cmd`），双击后 `http://<局域网IP>:8787` 同时给页面和 WS（同源，免跨域免 TLS）。
- `GET /healthz` → `{ ok, version, protocol, uptime_sec, rooms, participants }`；非空 `--allow-origin` 时附带 CORS 头，静态站跨域也能探活。
- 启动日志：版本、协议号、local/lan 地址、`web root`、题库与试卷数、容量上限。房间日志每房最多 500 条（建房、分队、就绪、开赛、越权、超时、重连、结算），供排障。
### 数据文件与部署形态
- `data/questions/`：87 道已确认题（单选 36 / 多选 33 / 判断 18，覆盖 12 个考点），单题一 JSON；`data/papers/`：5 份预置卷，参数全部在 JSON 里，改规则不改代码。
- `npm run sync:data` 把题库与试卷合成 `packages/web/public/data/bank.json`（87 题 + 5 卷约 160KB），静态模式一次 fetch；`npm run verify:data` 执行 27 项一致性断言，与启动加载共用校验规则。

| 形态 | 构建 / 产物 | 建议 |
| --- | --- | --- |
| 纯静态 | `npm run build:web` → `packages/web/dist/` | 自主练习首选；`base: './'` + hash 路由，子路径直接可用 |
| Windows 便携 | `npm run pack:win` → `release/aixx-server-win/` | 教室 / 宿舍临时开局首选；随包带 `node.exe`，学生机器无需装环境 |
| Linux 服务器 | `deploy/linux/docker-compose.yml` 构建 | 长期 / 公网；建议前置 Nginx 做 TLS，`/ws` 需 `Upgrade` 头与长 `proxy_read_timeout` |
| 静态前端 + 独立后端 | 静态站 + 独立服务 | 只在有 https 隧道时使用 |

具体操作步骤见 `deploy/windows/README.md` 与 `deploy/linux/README.md`。
### 权限矩阵
| 操作 | 房主 | 队长 | 主答 / 当前棒 | 普通成员 |
| --- | --- | --- | --- | --- |
| 开始对局 / 结束对局 | ✅ | ❌ | ❌ | ❌ |
| 指定主答（team-coop） | ✅ | ✅（本队） | ❌ | ❌ |
| 推进下一题（team-coop） | ❌ | ✅（本队） | ✅（本队） | ❌ |
| 提交答案（solo / team-solo） | — | — | 本人 | 本人 |
| 提交答案（team-coop / buzz） | ❌ | ❌ | ✅ | ❌ |
| 提交答案（relay） | ❌ | ❌ | ✅（当前棒） | ❌ |
| 交棒（relay） | ❌ | ❌ | ✅（当前棒） | ❌ |
| 反馈题目 | ✅ | ✅ | ✅ | ✅ |

权限检查分两处：`server.ts` 查房间与房间级动作（开赛 / 结束），`rooms.ts` 查队伍级角色（队长 / 团队码）；**赛制内的角色**（主答、当前棒）由 core 的状态机再判一次并回 `NOT_AUTHORIZED`——两层都判，避免绕过前端只判一次就放行。
### 测试策略
| 层 | 工具 | 覆盖重点 |
| --- | --- | --- |
| core 单测 | `node:test` | 判分边界（多选少选 / 错选 / 未答）、组卷降级、接力三段不重复、五个状态机的全部时间边界（截止前 1ms / 恰好 / 后 1ms）、`rankBuzz` 的并列与名额、接力 carry 计算、`FINISH` 封卷语义 |
| web 逻辑 | `node:test` + `loader.mjs` | `LocalDriver` 的消息序列与断点续做、`matchStore` 的开局 / 答题 / 交卷 / 落盘全链路（内存 localStorage + 假 fetch + 假 document） |
| server 集成 | `node:test` + 真实 `ws` 客户端 | 建房 / 加入 / 开题 / 提交 / 断线重连 / 超时自动提交 / 限流 / 重放 seq，断言整局下行帧不含 `answer` |
| 页面 | 无头浏览器 + DevTools 协议截图核对 | 首页卡片、对局页三栏（含团队 / 接力 / 抢答视角）、成绩页复盘与导出，联机全流程真点一遍 |
| 契约 | `node:test` | 同一 `judge()` 在前后端跑同一组用例结果一致（AC-11）；同一事件序列下 `LocalDriver` 与 `ServerDriver` 产出的 `ServerMsg` 序列一致 |

当前实际：`npm test` 104 条（core 88 + web 逻辑 5 + server 11），`npm run typecheck` 覆盖 core 与 server；核心单测不 mock 时间，直接构造事件序列（例如 `HANDOFF` 发生在 180 秒时，下一棒 `leg_budget_sec = 300 + 120`，而全局 `deadline_at` 不变）。


### 实施路线与当前完成状态
| 阶段 | 交付物 | 完成判据（当时快照） |
| --- | --- | --- |
| P0 基础设施 ✅ | workspaces、`tsconfig.base.json`、类型 / 判分 / 组卷 / 抢答排序、87 题 + 5 卷 | `npm test` 37 条全绿；`typecheck` exit 0；`verify:data` 27 项 PASS |
| P1 静态站 + 赛制 1 ✅ | web 骨架（hash 路由、无 UI 库 / 无状态库）、`solo`、`LocalDriver`、对局页 / 成绩页 / 断点续做 | 56 条全绿；`vite build` 61 modules，含 87 题 5 卷的 `bank.json` |
| P2 赛制 2 / 3 静态 ✅ | `teamSolo` / `teamCoop`、`sheet.ts` 抽公共答卷、同屏 1 答 2 辅、`ADVANCE` / `SET_ANSWERER` | 70 条全绿；build 64 modules；辅助位只读、换主答、成员成绩条核对通过 |
| P3 后端 + 联机 2 / 3 ✅ | server 全套、`ServerDriver`、房间大厅、`FINISH` 封卷、双部署产物 | 88 条全绿；`/healthz` 200；端到端建房→组队→开赛→答题→交卷→成绩，下行帧不含 `answer` |
| P4 接力 ✅ | `relay` 三棒切分、carry 时间继承、`handoff` 路由、交棒 UI | 96 条全绿；联机第 2 棒接手显示剩余 09:56，验证时间继承 |
| P5 抢答 ✅ | `buzz` 三拍状态机、`rankBuzz`、题面先出、实时榜 | 104 条全绿；双队脚本 `n_at_open=2 quota=1`，乙 +4、甲 0，`max_score` 40 |
| P6 收尾 ✅（回放留作后续） | 成绩导出 CSV / JSON、教练视角、纠错入口、便携包 | 104 条全绿；`pack:win` 后 `/healthz`、`/`、`/data/bank.json` 均 200 |

**顺序理由**：P0 把判分与组卷钉死（所有赛制都依赖）；P1 先上线解决「没地方练」；P3 才引入网络复杂度，此时状态机已被单测覆盖，后端只是「接线」。
### 风险与易错点
**风险与待定**

| 项 | 状态与处理 |
| --- | --- |
| 题库答案 `verified` 数量 | ✅ 已解除：87 道全部 verified（单选 36 / 多选 33 / 判断 18，12 个考点），55 题卷容量充足 |
| 接力 / 抢答官方细则 | 未查到总则；全部参数化，拿到规程只改 JSON |
| 单文件打包（Node SEA） | 已放弃：便携包直接带 `runtime/node.exe`，构建链路简单、版本可控 |
| GitHub Pages 国内可达性 / 手机端 | Pages 已知不稳，文档同时给「本地静态包」；手机端只保证能答题与交卷，不做专项优化 |
| 形态 D 的混合内容限制 | 已定：只在有隧道时提供，主推形态 B |

**十个最容易写错的地方**

1. 接力 carry 不能用已用时间算：`carry = max(0, budget_sec - elapsed_sec)`，用 `ceil` 会让队伍凭空多出 1 秒。
2. 抢答名额按 `Math.ceil`：N=3 名额 2、N=4 名额 2、N=5 名额 3；用 `round` 会在奇数队伍上偏错方向。
3. 同一毫秒并列：`at` 差值 `<= tie_window_ms`（5ms）视为并列，整簇计入名额；聚簇必须从**已排序**序列上做，排序键要带 `team_id` 兜底。
4. 多选比较前必须排序：`[...choice].sort().join()` vs `[...answer].sort().join()`。
5. `TICK` 幂等：同一 `at` 重复 `TICK` 不得重复结算（用 `phase` 判断，不是用时间判断）。
6. 进行中对局必须自洽：房间持有开赛时的题面快照与 `roster`，判分用 `ctx.questions`，不要每次回头读磁盘。
7. hash 路由 + GitHub Pages：不要用 history 模式，否则刷新 `/play/xxx` 直接 404。
8. https 页面连 `ws://` 一定失败：这是规范要求，不是「可能被拦」；形态 D 必须两端都加密。
9. `seq` 必须每 participant 独立计数：全局共享一个计数器会在多标签页重连时把对方消息挤成 `STALE_SEQ`。
10. `leg_order` 要固化：不要在 `HANDOFF` 时去查「房间当前成员里下一个是谁」，掉线 / 被踢 / 换队都会让结果与重连快照不一致。
### 版本记录
| 版本 | 日期 | 关键变化 |
| --- | --- | --- |
| v0.1 | 2026-11-06 | 首版：四种运行形态、纯函数状态机、core / 前端 / 后端分包、协议草案 |
| v0.2 | 2026-11-06 | 补齐契约：`PublicMatchState`、`ADVANCE`、`rankBuzz`、`seq`；修掉三处自相矛盾；补形态 D |
| v0.3 | 2026-11-06 | 二轮复审：relay 棒内题号、五个赛制的交卷触发点、`OwnView.scope/can_submit`、buzz 时间锚点；修「断线宽限比开抢窗口还长」 |
| v0.4–v0.7 | 2026-11-06 | 随 P0–P3 实作回写：`Roster.names`、`ReduceCtx`、`view(state, viewer_id, at)`、`sheet.ts`、`FINISH`、`notice`、6 位房间码 / 团队码 |
| v0.8 | 2026-11-06 | P4 实作回写：分棒组卷、`handoff` 路由、本棒倒计时用 `clock.leg_deadline_at`、单人队循环排棒 |
| v0.9 | 2026-11-06 | P5 实作回写：题面缓冲期先推（`announced`）、`qualify_ratio` / `reveal_ms` 固化、开局 `TICK`、抢答无交卷；P6 成绩导出与教练视角 |
| v1.0 | 2026-11-06 | 整理版：技术选型并入架构章、删除开发机环境内容；目录树、测试策略、实施路线按实现重写；变更历史压缩为一页 |

原则：**文档与实现不一致时，以实现为准并回写文档**。每轮实作后把「写代码时发现文档不够用」的点补进对应章节，而不是堆在末尾列表里。
### 代码级契约索引（`docs/design.md`）
| 节 | 主题 |
| --- | --- |
| §2.2 / §2.3 / §2.4 | 纯函数状态机、技术栈、被否决方案 |
| §3 / §4 | 命名与数据契约、仓库结构与依赖方向 |
| §5.1 | 题库与试卷类型（`Question` / `Paper` / 三个配置块） |
| §5.2 / §5.3 | 判分引擎 `judge()`、组卷 `draw()` 与接力分棒 |
| §5.4 / §5.5 | 赛制状态机契约、公共视图与结算类型 |
| §5.5.1 | 交卷与结束语义（`FINISH` / `END` / reveal 范围） |
| §5.6 / §5.7 | 五个赛制的状态与事件、`rankBuzz` 排序算法 |
| §5.8 / §5.9 | 协议类型、消息时机表 |
| §6 | 前端设计（路由 / 布局 / 状态 / Driver / 存储 / 计时器） |
| §7 / §8 | 后端设计（进程 / 模块 / 房间 / 定时器 / 宽限 / 安全）、协议细节（帧 / 时序 / 错误码） |
| §9 / §10 | 数据文件与加载期校验、权限矩阵与两层鉴权 |
| §11 | 部署方案（四种形态的具体命令与 Nginx 要点） |
| §12 / §13 | 测试策略、实施路线 |
| §15 / §16 | 易错点、版本记录 |


## 维护者：数据、测试与打包

### 开发环境

- Node.js **≥ 22.18**（`package.json` 的 `engines`；服务端直接执行 `.ts`，不需要编译）。
- npm 10.x。仓库用 npm workspaces 管理 `packages/core`、`packages/web`、`packages/server`。
- 不需要数据库、Docker 或任何账号；运行期第三方依赖只有 `ws`。

```bash
npm ci          # 安装依赖
npm test        # 全部测试
npm run typecheck
```

### 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run sync:data` | 把 `data/` 里的题库与试卷同步成前端可加载的 `packages/web/public/data/bank.json` |
| `npm run verify:data` | 校验题库：87 题 + 5 卷，27 项数据断言 |
| `npm test` | 全部 104 条测试（core 88 + web 5 + server 11） |
| `npm run test:core` | 只跑核心状态机 / 判分 / 组卷单测 |
| `npm run typecheck` | `packages/core` + `packages/server` 类型检查 |
| `npm run dev:web` | 前端开发服务器（Vite，热更新） |
| `npm run build:web` | 构建前端到 `packages/web/dist/` |
| `npm run preview:web` | 本地预览构建产物 |
| `npm run start:server` | 启动联机后端（默认 `0.0.0.0:8787`） |
| `npm run pack:win` | 打 Windows 便携包到 `release/aixx-server-win/` |

### 数据与合规

- 题库：`data/questions/` 共 **87 道**（单选 36 / 多选 33 / 判断 18），覆盖 **12 个考点**，全部为已核对答案的 `verified` 题目；`data/papers/` 有 **5 套试卷**，定义各赛制的题量、时长、分值与抢答参数。
- 题目来自比赛官网例题与公开资料整理，题库整理遵循同级备考站约定的 **CC BY-NC-SA 4.0**；仓库本身尚未附带 `LICENSE` 文件，对外分发或商用前请先确认授权范围。
- 题目 JSON 里带 `answer` 与 `explain` 明文：它适合训练与复盘，不适合作为正式考试的唯一依据。联机时服务端会剥离答案后再下发题面。
- **没有账号体系，也不上传数据**：练习记录存在浏览器 `localStorage`；联机对局、房间、成绩只在服务端内存里，进程退出即消失。成绩要留存，请在成绩页当场导出 CSV / JSON。
- 成绩页每题都有「**报错 / 提 issue**」入口，会带上题目 ID 与当前答案，方便把疑问题反馈给题库维护者。
- 改题流程：编辑 `data/questions/*.json` → `npm run verify:data` → `npm run sync:data` → 重新 `npm run build:web`（发布便携包还要 `npm run pack:win`）。题库不做热加载，改完要重启服务端。

### 测试与验收

发布前至少跑完这三步：

```bash
npm run verify:data    # 断言 27 项，失败 0 项
npm test               # 104 pass / 0 fail
npm run typecheck      # exit 0
```

测试覆盖四层：

- **core 单测**：判分边界、组卷与降级、时间边界、`rankBuzz` 名额与同毫秒聚簇、接力 carry、封卷结算。
- **web 逻辑**：`LocalDriver` 的消息序列、断点续做、`matchStore` 的落盘与恢复、`localStorage` 键。
- **server 集成**：真实 WebSocket 建房 / 入队 / 开赛 / 提交 / 断线重连 / 重放 `seq` / 限流，并断言下行帧不含 `answer`。
- **契约一致性**：同一 `judge()` 在前后端跑同一组用例；同一事件序列下两种驱动产出的消息流一致。

手工冒烟（发布便携包后）：

```powershell
# 在包目录
.\start.cmd
# 另开一个窗口
curl.exe http://127.0.0.1:8787/healthz
```

`/healthz` 返回 `{"ok":true,"version":"0.1.0","protocol":1,...}` 即正常；再打开首页确认有「5 种赛制卡片」，点「联机大厅」建一个房间、能看到房间号。

### 重新打 Windows 便携包

```bash
npm ci
npm run sync:data
npm run build:web
npm run pack:win
```

- 便携包默认使用「当前运行 npm 的 `node.exe` 所在目录」作为运行时；要固定到另一个 Node 版本时设置 `ARENA_NODE_DIR`。
- 产物在 `release/aixx-server-win/`，约 **84MB**（大头是 `runtime/node.exe`），可 zip 后拷 U 盘。
- 包里的 `README.txt` 由 `packages/server/README.md` 加固定抬头生成；要改包内说明，改那份 README 后重新打包，不要手改 `release/`。
- `scripts/pack-release.mjs` 会跳过 `data/questions/_import-report.md`（内部导题报告不进分发）。
- 打完后务必双击 `start.cmd` 自测一次：窗口出现 `ready.`、`/healthz` 返回 200、能建房间并让两个浏览器加入。

### 仓库结构

```
aixx-arena/
├─ packages/
│  ├─ core/            状态机、判分、组卷（前后端共用，纯函数）
│  ├─ web/             Vue 3 前端；LocalDriver（离线）/ ServerDriver（联机）
│  └─ server/          Node 22 + ws 联机后端；同端口托管前端
├─ data/
│  ├─ questions/       87 道题（JSON）
│  └─ papers/          5 套试卷（题量、时长、分值、抢答参数）
├─ scripts/            导题、组卷、数据校验、同步、打包
├─ deploy/
│  ├─ windows/         Windows 便携包打包与教室排查
│  └─ linux/           Dockerfile、docker-compose、Linux 部署
├─ docs/
│  ├─ design.md        代码级完整设计（本 README「系统设计」章的来源）
│  └─ requirements.md  需求基线 v0.3
├─ release/            打包产物（aixx-server-win/）
└─ README.md           本文件：总入口
```

## 文档地图与版本

| 文档 | 什么时候看 |
| --- | --- |
| **`README.md`（本文件）** | 第一次接触：玩法、零基础部署、架构摘要 |
| [`docs/design.md`](docs/design.md) | 改代码、查协议 / 状态机 / 数据契约的完整细节；与 README 冲突时以实现与本文为准 |
| [`docs/requirements.md`](docs/requirements.md) | 需求基线与验收标准（v0.3） |
| [`deploy/windows/README.md`](deploy/windows/README.md) | 打便携包、教室连不上时的排查表 |
| [`deploy/linux/README.md`](deploy/linux/README.md) | Docker Compose、Node 直跑、systemd、Nginx / wss |
| [`packages/server/README.md`](packages/server/README.md) | 服务端参数、HTTP/WS 接口、开发者说明（也会进便携包的 `README.txt`） |

**版本**：服务端 `0.1.0` / 协议 `1`；设计文档 v1.0（2026-11-06）；本 README 同步于 2026-11-07。

**维护约定**：改实现或改部署方式时，同时更新本 README 的对应章节和 `docs/design.md`；如果两者暂时不一致，先按代码实际行为修文档，再回头统一措辞。README 面向「第一次来的人」，尽量用操作步骤和原始界面文案，不要求读者懂编程。
