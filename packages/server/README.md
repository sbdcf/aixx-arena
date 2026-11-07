# @aixx/server — aixx-arena 联机服务端

单进程、权威（authoritative）的联机服务器：同一个端口同时提供

- **HTTP 静态托管**：`packages/web/dist` 的前端（SPA，`index.html` 兜底）
- **`GET /healthz`**：探活与容量信息（JSON）
- **WebSocket**：`/ws`（upgrade 接受任意路径，方便放在 nginx 等反代后面）

对局规则完全复用 `packages/core` 的状态机（`initMatch` / `reduce` / `view` / `summarize`），
服务端只做「连接、房间、大厅、消息路由、定时器、快照下发」，不重复实现判分逻辑。

面向部署者与学生的完整说明见仓库根 `README.md`；本文件是服务端开发者说明，并会作为便携包里的 `README.txt` 正文。

当前开放联机的赛制：**team-solo（团队个人赛）**、**team-coop（协作答题）**、**relay（接力）**、
**buzz（抢答）**。solo（校赛模拟）只在纯静态模式提供，`create` 时会拒绝。

- 依赖：Node.js ≥ 22.18（原生执行 `.ts`）
- 运行时依赖：仅 `ws`

---

## 一、本地怎么跑

```bash
# 在仓库根
npm ci
npm run sync:data     # data/ → packages/web/public/data/bank.json
npm run build:web     # → packages/web/dist

# 起服务端（默认 0.0.0.0:8787，题库读仓库 data/）
npm run start:server
```

也可以进 `packages/server` 单独起：`npm start`（等价于 `node src/main.ts`）。

启动成功会打印：

```
aixx-arena server v0.1.1 (protocol v1)
  local    http://127.0.0.1:8787
  lan      http://192.168.x.x:8787
  web root <repo>/packages/web/dist
  data     <repo>/data
  bank     87 题 / 5 卷
  capacity 100 rooms × 12 players（每队 ≤ 3 人）
  ws       /ws（upgrade 接受任意路径，便于反代）
ready. Ctrl+C to stop.
```

浏览器打开 `http://127.0.0.1:8787` 即可。题库/试卷从 `data/questions/*.json` 与
`data/papers/*.json` 读取（只收 `answer_status === "verified"` 且有答案的题）；
题库改动后重新 `npm run sync:data` 生成前端用的 `bank.json`。

### 跑测试

```bash
npm test                                    # 全量（core + web 逻辑 + server）
npm run test:core                           # 只跑 core
node --import ./packages/web/test/loader.mjs --test --experimental-test-isolation=none \
  packages/server/test/online.test.ts       # 只跑联机验收
```

> `--import ./packages/web/test/loader.mjs` 把 `@aixx/core` 指到 `packages/core/src/index.ts`；
> 服务端源码本身用相对路径 import core，所以 `node src/main.ts` 不依赖 loader。

---

## 二、参数表

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--port <n>` | `8787` | 监听端口；`0` = 随机端口（测试用） |
| `--host <addr>` | `0.0.0.0` | 监听地址；仅本机访问可设 `127.0.0.1` |
| `--web-root <dir>` | `<repo>/packages/web/dist` | 前端静态目录；默认按 `src/` 位置解析，与 cwd 无关 |
| `--data-root <dir>` | `<repo>/data` | 题库目录（含 `questions/`、`papers/`） |
| `--allow-origin <v>` | 无 | 给 `/healthz` 加 CORS 头（如 `*`），便于静态站探活 |
| `--max-rooms <n>` | `100` | 最大房间数，超出后 `create` 回 `ROOM_FULL` |
| `--help` / `-h` | — | 打印帮助 |

同时支持 `--flag=value` 写法。单房间容量 12 人，每队最多 3 人；
team-solo 每队 1–3 人；team-coop 开局要求每队正好 3 人；接力不足 3 人时按顺序循环排棒。
**所有赛制都要求在场玩家先全部分队**，否则 `start` 返回 `BAD_MESSAGE`。

---

## 三、局域网联机（学生手机/平板连老师的电脑）

1. 服务端保持默认 `--host 0.0.0.0` 启动。
2. 在同一 Wi-Fi / 同一局域网的电脑上查内网 IPv4（启动日志里的 `lan` 行已列出）：

   ```powershell
   ipconfig | Select-String "IPv4"
   ```

3. 学生浏览器打开 `http://<内网IP>:8787`，例如 `http://192.168.1.23:8787`。
4. 若打不开：
   - Windows 防火墙放行 Node（首次启动会弹窗，选「允许专用网络」），或手动放行 8787/TCP；
   - 确认手机与电脑在同一网段，且路由器没开「AP 隔离」；
   - 有些校园网/访客 Wi-Fi 禁止终端互访，可改用手机热点。

本服务只监听明文 `http`/`ws`，没有登录体系，**只适合教室/家庭等可信局域网**；
需要公网访问时在反代层加 TLS 与鉴权。

---

## 四、HTTP / WS 接口

| 路径 | 说明 |
| --- | --- |
| `GET /healthz` | `{ok, version, protocol, uptime_sec, rooms, participants}`；`rooms` = 房间总数，`participants` = 当前在线连接数 |
| `GET /` 及其它 GET | 托管 `--web-root`；无扩展名的前端路由回 `index.html`；越界路径 404 |
| `WS /ws` | 联机主通道；upgrade 接受任意路径（方便反代） |

WebSocket 协议见 `packages/core/src/protocol.ts`（`PROTOCOL_VERSION = 1`）。要点：

- 首帧必须是 `hello {v, name, resume_id?}`。版本不符回 `VERSION_MISMATCH`（fatal）并断开。
- 掉线后 30s 内可用同一个 `resume_id` 重连：服务端接管连接（旧连接被踢）、补发
  `lobby` / `paper` / `room` 快照；超时未回则视为退出，个人赛按 `FINISH` 封卷处理。
- 大厅以 `lobby` 为唯一状态源：人员、队伍、准备状态任何变化都会重发全房；
  `LobbyTeam.code` 只填给本队成员。
- 开局瞬间每人收到一次 `paper`（整卷题面，**不含 `answer` / `explain`**），
  之后每次状态机 `reduce` 后都会重发个性化 `room` 快照（`view(state, 自己, now)`）。
- `answer` / `explain` 只出现在 `reveal` 与 `ended.summary` 中；`paper` / `room` /
  `ack` / `lobby` 一律不含答案字段（`test/online.test.ts` 有一条端到端断言）。
- `seq` 每人每局单调递增，`seq <= last_seq` 静默丢弃、不回 `ack`（只记日志）。
- 答案只在服务端判分；客户端只上报 `qid` / `choice` / `seq`。
- 超时只在服务端判定：房间定时器到最近 deadline 后送 `{type:'TICK'}` 给状态机结算
  （迟到 TICK 也接受），对局以 `ended.summary.end_reason = "time"` 结束。
- 限流：每连接每秒最多 30 条消息，超出回 `RATE_LIMITED` 并丢弃（不关连接）；
  单帧上限 64KB；非法 JSON 回 `BAD_MESSAGE`。
- `ping {t0}` → `pong {t0, server_at}`；服务端每 30s 广播一次 `sync {server_at}` 校时。

---

## 五、源码结构

| 文件 | 职责 |
| --- | --- |
| `src/main.ts` | CLI 入口：解析参数、启动、打印本地/局域网地址、优雅关闭 |
| `src/server.ts` | 核心编排：房间/参与者注册表、消息路由、大厅与对局生命周期、掉线宽限、健康检查、心跳与 `sync` |
| `src/rooms.ts` | 房间数据模型：成员、队伍、队伍码、`lobby` 快照、`roster`、题面裁剪 |
| `src/session.ts` | 单条 WS 连接：握手超时、帧大小、JSON 解析、限流、错误发送、关闭码 |
| `src/driver.ts` | 把 `core` 的 `reduce/effects` 映射为「发给谁 + 定时器 + 日志」，并生成个性化 `room` 快照 |
| `src/http.ts` | 同端口 HTTP：`/healthz`、静态托管、MIME、SPA 兜底 |
| `src/data.ts` | 读取并校验 `data/questions`、`data/papers`；默认路径按仓库位置解析 |
| `src/core.ts` | 队内唯一 core 入口（相对路径 re-export），避免依赖 loader/包解析 |
| `test/helpers.ts` | 测试用 WS 客户端（游标式 `waitFor`、`connectPlayer`、`createRoomAsHost`） |
| `test/online.test.ts` | 联机验收（建房/入队/开赛/提交/断线重连/限流/答案不泄漏） |

---

## 六、有意偏离契约的地方 / 已知限制

1. **队伍码 / 房间码用 6 位数字**（设计文档早期写的是 32 字符字母表）——数字码更好念、
   适合课堂口头传达。
2. **「交卷」统一落成 core 的 `FINISH`（本人封卷）**：solo / team-solo 先封本人卷，
   全员封卷或到期才结算；team-coop 的 `submit_all` 映射 `END{reason:'self'}`（只结算本队）；
   relay 的 `submit_all` 连续交棒到第 3 棒；buzz 没有交卷概念，`submit_all` 回 `BAD_MESSAGE`。
3. **开局要求所有玩家都已分队**（契约只要求「至少一队且有队员」）：未分队的人
   不在 roster 里、收不到 `paper`，等于观众；这里对所有赛制都要求全员分队，否则 `start`
   直接报错，把「选手/观众」语义讲清楚。未分队者在对局中提交会被拒 `NOT_AUTHORIZED`。
4. **房主掉线超过 30s** 且大厅尚未开局时，房主自动转给下一位在线（其次离线）成员，
   日志记 `host_transfer`。
5. **题库不做热加载**：启动时一次性读入，房间持开局题面快照；改题需重启（同 seed 同卷的可重现性优先）。
6. **未实现持久化**：房间、日志、成绩都在内存里，进程退出即丢；结束后由客户端
   `ended.summary` 自行保存（前端已有 `matchStorage`）。断线重连宽限 30s，不是跨进程恢复。
