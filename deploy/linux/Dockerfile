# AI+信息素养训练场 · 联机后端
#
# 构建上下文是仓库根目录（aixx-arena/），因为服务器运行期需要：
#   packages/server/src  服务器源码
#   packages/core/src    状态机（源码级共享，见 docs/design.md §2）
#   packages/web/dist    前端产物（同端口托管，学生只记一个地址）
#   data/                题库与试卷（只读）
#
# 用法（在 aixx-arena/ 下）：
#   npm ci && npm run sync:data && npm run build:web
#   docker compose -f deploy/linux/docker-compose.yml up -d --build

FROM node:22-alpine

# ws 是唯一需要编译的依赖（其实也是纯 JS），alpine 下不需要额外工具链
WORKDIR /app

# 依赖：只装运行期需要的那个包
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci --omit=dev --ignore-scripts

# 源码与产物
COPY packages/core/src       packages/core/src
COPY packages/server/src     packages/server/src
COPY packages/web/dist       packages/web/dist
COPY data                    data

# 以非 root 运行
RUN addgroup -S arena && adduser -S arena -G arena && chown -R arena:arena /app
USER arena

ENV NODE_ENV=production
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/src/main.ts", "--port", "8787", "--host", "0.0.0.0", "--web-root", "packages/web/dist"]
