# AI+信息素养训练场 · Windows 部署

目标场景是「教练在教室的一台电脑上双击启动，学生用手机/电脑连同一局域网练」。
所以这里不要求装 Docker、不要求管理员权限、不要求系统里装过 Node。

## 一、生成便携包

在 `aixx-arena/` 下：

```powershell
# 前端产物要先构建（需要 Node.js 22+）
npm run sync:data
npm run build:web

# 打便携包（默认取当前运行 npm 的 node.exe 所在目录）
npm run pack:win

# 想换一个 Node 版本时，用 ARENA_NODE_DIR 指定：
$env:ARENA_NODE_DIR = 'C:\path\to\node-v22-win-x64'; npm run pack:win
```

产物在 `release/aixx-server-win/`：

| 内容 | 说明 |
| --- | --- |
| `runtime/node.exe` | 随包的 Node 22 运行时（学生机器无需装 Node） |
| `packages/server/src` | 服务器源码 |
| `packages/core/src` | 状态机（源码级共享） |
| `packages/web/dist` | 前端产物（服务端同端口托管） |
| `data/` | 87 题 + 5 份试卷 |
| `node_modules/ws` | 唯一的第三方依赖 |
| `start.cmd` | 双击启动 |

整个目录约 84MB（2026-11-06 实测 155 个文件，大头是 node.exe），可以 zip 后拷到教室电脑、放 U 盘、或者丢进网盘。

## 二、教室里怎么用

1. 双击 `start.cmd`，窗口里会打印：

   ```
   local http://127.0.0.1:8787
   lan   http://192.168.x.x:8787
   ```

2. 学生浏览器打开 **lan 那个地址** → 「联机大厅」→ 服务器地址就填它。
3. 房主「开一个房间」→ 房间号贴到教室屏幕 → 队员输房间号进房、用 6 位团队码入队 →
   **所有在场同学都先分到队里**（还有散人时服务端会拒绝开赛）→ 房主「开始比赛」。
   团队赛（1 答 2 辅）每队必须正好 3 人；准备按钮只是给房主的信号，不是硬条件。
4. 关掉窗口就结束。**成绩不落服务器**：交卷后各自浏览器里留一份备份，成绩页刷新还在。

## 三、连不上时的排查顺序

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 学生打不开 lan 地址 | Windows 防火墙拦了 | 第一次启动时弹的「允许访问」要勾「专用网络」；已误点「取消」就去防火墙里放行 node.exe |
| 大厅显示「未连接」 | 地址填错 | 只填 origin（`http://192.168.x.x:8787`），不要带 `/#/` 路径 |
| 房间建不起来 | 房间数到上限 | `runtime\node.exe packages\server\src\main.ts --max-rooms 20` |
| 页面能开但联机报错 | 前端是旧构建 | 重新 `npm run build:web` 再 `npm run pack:win` |

## 四、只想要前端（不上后端）

`packages/web/dist/` 整个目录丢到任意静态托管即可（GitHub Pages / Nginx / 对象存储）。
`vite.config.ts` 里 `base: './'` + hash 路由，所以放在子路径也能用；
此时五种赛制都可离线自练（团队 / 接力 / 抢答是单人模拟），多人同场联机才需要后端。
