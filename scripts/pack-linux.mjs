/**
 * 打一个 Linux x64 便携包（内含 Node 22 linux-x64 运行时，不依赖系统装 Node）。
 *
 * 目录结构、数据与前端产物与 Windows 便携包一致，只把 runtime/node.exe 换成
 * runtime/node，并提供 start.sh（启动时自动 chmod +x，解压后无需手动加权限）。
 *
 * 用法（在仓库根目录）：
 *   node scripts/pack-linux.mjs
 *
 * 默认从 _work/node-linux/node-v<版本>-linux-x64 取 Linux 版 Node；也可用
 * 环境变量 ARENA_NODE_LINUX_DIR 指定目录（目录下应有 bin/node 与 LICENSE）。
 */
import { access, cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'release', 'aixx-server-linux')
const nodeDir =
  process.env.ARENA_NODE_LINUX_DIR ?? join(root, '_work', 'node-linux', 'node-v22.23.4-linux-x64')

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function copy(from, to) {
  const source = join(root, from)
  if (!(await exists(source))) throw new Error(`缺少打包源：${source}`)
  await cp(source, join(outDir, to), { recursive: true })
}

async function main() {
  const nodeBin = join(nodeDir, 'bin', 'node')
  if (!(await exists(nodeBin))) {
    throw new Error(`找不到 Linux 版 Node：${nodeBin}（可用 ARENA_NODE_LINUX_DIR 指定）`)
  }

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  // 1. Node 运行时（只带 node 与许可证；npm 用不上）
  await mkdir(join(outDir, 'runtime'), { recursive: true })
  await cp(nodeBin, join(outDir, 'runtime', 'node'))
  for (const extra of ['LICENSE', 'README.md']) {
    const from = join(nodeDir, extra)
    if (await exists(from)) await cp(from, join(outDir, 'runtime', extra))
  }

  // 2. 源码与产物
  await copy('packages/core/src', 'packages/core/src')
  await copy('packages/server/src', 'packages/server/src')
  await copy('packages/web/dist', 'packages/web/dist')
  await copy('data/questions', 'data/questions')
  await rm(join(outDir, 'data', 'questions', '_import-report.md'), { force: true }) // 内部导题报告不进分发
  await copy('data/papers', 'data/papers')

  // 3. 唯一第三方依赖
  await mkdir(join(outDir, 'node_modules'), { recursive: true })
  await cp(join(root, 'node_modules/ws'), join(outDir, 'node_modules/ws'), { recursive: true })

  // 4. 运行期 package.json：声明 ESM，start 指向包内 runtime/node
  const manifest = {
    name: 'aixx-arena-server',
    version: '0.1.1',
    private: true,
    type: 'module',
    description: 'AI+信息素养训练场 · 联机后端（Linux 便携包）',
    scripts: {
      start: 'runtime/node packages/server/src/main.ts --port 8787 --host 0.0.0.0 --web-root packages/web/dist',
    },
  }
  await writeFile(join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // 5. 启动脚本：LF 换行；先补可执行位，避免 zip/unzip 丢权限
  const startSh = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'cd "$(dirname "$0")"',
    'chmod +x runtime/node 2>/dev/null || true',
    'PORT="${PORT:-8787}"',
    'echo "AI+信息素养训练场 · 联机后端"',
    'echo',
    'exec runtime/node packages/server/src/main.ts --port "$PORT" --host 0.0.0.0 --web-root packages/web/dist',
    '',
  ].join('\n')
  await writeFile(join(outDir, 'start.sh'), startSh, 'utf8')

  // 6. 说明
  const readme = await readFile(join(root, 'packages/server/README.md'), 'utf8').catch(() => '')
  await writeFile(
    join(outDir, 'README.txt'),
    [
      'AI+信息素养训练场 · 联机后端（Linux x64 便携包）',
      '',
      '■ 怎么用',
      '  1) 解压到一个目录，例如 /opt/aixx-server-linux。',
      '  2) 在该目录执行：bash start.sh',
      '     窗口里会打印两个地址：',
      '       local http://127.0.0.1:8787   （服务器本机浏览器）',
      '       lan   http://192.168.x.x:8787 （同一间教室/局域网）',
      '  3) 学生浏览器打开 lan 那个地址，进「联机大厅」，服务器地址就填它。',
      '  4) 房主建房 → 把房间号贴到教室屏幕 → 队员输房间号进房、用团队码入队 → 房主开赛。',
      '  5) 换端口：PORT=9000 bash start.sh；停止：Ctrl+C。',
      '',
      '■ 防火墙',
      '  Ubuntu/Debian: sudo ufw allow 8787/tcp',
      '  firewalld:     sudo firewall-cmd --add-port=8787/tcp --permanent && sudo firewall-cmd --reload',
      '  云服务器还要在安全组放行对应端口。',
      '',
      '■ 依赖',
      '  包内已带 Node 22（runtime/node），不需要系统预装 Node。',
      '  仅支持 Linux x64；ARM64 请用源码运行或 Docker 部署。',
      '',
      '■ 更多说明',
      '  见下方「服务端 README」；完整文档在仓库根 README.md 与 docs/design.md。',
      readme,
    ].join('\n'),
    'utf8',
  )

  console.log(`Linux 便携包已生成：${outDir}`)
  console.log('解压后执行 bash start.sh 即可启动（默认 http://localhost:8787）。')
}

await main()
