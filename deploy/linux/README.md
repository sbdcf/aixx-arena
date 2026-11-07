# AI+信息素养训练场 · 联机后端（Linux）

这个目录只放部署相关文件，镜像内容来自仓库里的源码与构建产物：

```
aixx-arena/
├── packages/{core,server}/src     服务器与状态机源码（源码级共享）
├── packages/web/dist              前端构建产物（服务端同端口托管）
├── data/{questions,papers}        题库与试卷（只读）
├── deploy/linux/Dockerfile        本文件所在目录
└── deploy/linux/docker-compose.yml
```

## 一、docker compose（推荐）

在仓库根目录 `aixx-arena/` 执行：

```bash
# 1. 先构建前端（本机需 Node 22+）
npm ci
npm run sync:data
npm run build:web

# 2. 起服务
docker compose -f deploy/linux/docker-compose.yml up -d --build

# 3. 看到的就是这个地址
curl http://localhost:8787/healthz
```

教室/机房场景把 `8787` 换成任意可用端口即可，学生浏览器访问
`http://<服务器IP>:8787`，进「联机大厅」把这个地址填进「服务器地址」。

## 二、不用 Docker（直接在服务器上跑）

服务器上有 Node 22.18+ 就行：

```bash
npm ci                                     # 构建前端需要 devDependencies
npm run sync:data && npm run build:web     # 前端产物在 packages/web/dist
node packages/server/src/main.ts --port 8787 --host 0.0.0.0 --web-root packages/web/dist
```

如果前端已经在别的机器上构建好，只把 `packages/web/dist` 拷过来，也可以 `npm ci --omit=dev` 省掉构建依赖。

长期跑建议交给 systemd：

```ini
[Unit]
Description=AIXX Arena server
After=network.target

[Service]
WorkingDirectory=/srv/aixx-arena
ExecStart=/usr/bin/node packages/server/src/main.ts --port 8787 --host 0.0.0.0 --web-root packages/web/dist
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

## 三、HTTPS / 反代（可选）

前端是纯静态 + WebSocket，反代要记得放行 Upgrade：

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

注意：**https 页面连 ws:// 会被浏览器当混合内容拦掉**，走 HTTPS 时反代必须也上 TLS（wss）。

## 四、参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--port` | 8787 | 监听端口 |
| `--host` | 0.0.0.0 | 想只给本机用填 127.0.0.1 |
| `--web-root` | `<仓库>/packages/web/dist` | 前端产物目录；不传也会用这个默认值（不是「只提供 API/WS」） |
| `--data-root` | `<仓库>/data` | 题库与试卷目录 |
| `--allow-origin` | 空 | 给 `/healthz` 与 OPTIONS 预检加 CORS 头；联机走 WebSocket，不受 CORS 限制 |
| `--max-rooms` | 100 | 房间上限，超出后建房返回 `ROOM_FULL` |

容量口径（设计 §7.1）：单实例默认 `--max-rooms 100`、每房 ≤12 人、每队 ≤3 人；
启动日志会打印实际生效的上限。
