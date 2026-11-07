/**
 * 打一个「拷到 U 盘就能用」的 Windows 便携包。
 *
 * 目标目录 release/aixx-server-win/ 里全部是运行期需要的东西：
 *   runtime/node.exe       便携 Node 22（从当前 Node 安装目录拷贝，不依赖系统装过 Node）
 *   packages/core/src     状态机（服务端要 imports 它，源码级共享，见 design §2）
 *   packages/server/src   服务器本体
 *   packages/web/dist     前端构建产物（服务端同端口托管）
 *   data/questions|papers 题库与试卷（服务端只读）
 *   node_modules/ws       唯一一个第三方依赖
 *   start.cmd             双击启动
 *
 * 用法（在 aixx-arena 目录）：
 *   node scripts/pack-release.mjs
 * 便携 Node 目录默认取「当前运行本脚本的 node.exe 所在目录」；要换版本时用
 * 环境变量 ARENA_NODE_DIR 指定。 */
import { access, cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'release', 'aixx-server-win')
const nodeDir = process.env.ARENA_NODE_DIR ?? dirname(process.execPath)

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
  const nodeExe = join(nodeDir, 'node.exe')
  if (!(await exists(nodeExe))) throw new Error(`找不到便携 Node：${nodeExe}（可用 ARENA_NODE_DIR 指定）`)

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  // 1. Node 运行时（只带 node.exe 与许可证；npm 用不上）
  await mkdir(join(outDir, 'runtime'), { recursive: true })
  await cp(nodeExe, join(outDir, 'runtime', 'node.exe'))
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

  // 4. 运行期 package.json：声明 ESM，并把 start 指到便携 node
  const manifest = {
    name: 'aixx-arena-server',
    version: '0.1.0',
    private: true,
    type: 'module',
    description: 'AI+信息素养训练场 · 联机后端（便携包）',
    scripts: { start: 'runtime\\node.exe packages\\server\\src\\main.ts' },
  }
  await writeFile(join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // 5. 双击启动：默认 8787，同端口托管前端
  const startCmd = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'cd /d "%~dp0"',
    'echo AI+信息素养训练场 · 联机后端',
    'echo.',
    'runtime\\node.exe packages\\server\\src\\main.ts --port 8787 --host 0.0.0.0 --web-root packages\\web\\dist',
    'echo.',
    'echo 服务已停止。按任意键关闭窗口。',
    'pause >nul',
    '',
  ].join('\r\n')
  await writeFile(join(outDir, 'start.cmd'), startCmd, 'utf8')

  // 6. 说明
  const readme = await readFile(join(root, 'packages/server/README.md'), 'utf8').catch(() => '')
  await writeFile(
    join(outDir, 'README.txt'),
    [
      'AI+信息素养训练场 · 联机后端（Windows 便携包）',
      '',
      '■ 怎么用',
      '  1) 双击 start.cmd。窗口里会打印两个地址：',
      '       local http://127.0.0.1:8787   （本机浏览器）',
      '       lan   http://192.168.x.x:8787 （同一间教室的其它电脑/手机）',
      '  2) 学生浏览器打开 lan 那个地址，进「联机大厅」，服务器地址就填它。',
      '  3) 房主建房 → 把房间号贴到教室屏幕 → 队员输房间号进房、用团队码入队 → 房主开赛。',
      '  4) 关窗口即停止；对局数据不落库，成绩在各自浏览器里（交卷时本地备份）。',
      '',
      '■ 换端口 / 限制房间数',
      '  runtime\\node.exe packages\\server\\src\\main.ts --port 9000 --max-rooms 20',
      '',
      '■ 防火墙',
      '  第一次启动时 Windows 可能弹「允许访问」，请勾选「专用网络」。',
      '  教室局域网连不上，多半是这一步没允许。',
      '',
      '■ 更多说明',
      '  见下方「服务端 README」；完整文档在仓库根 README.md 与 docs/design.md。',
      readme ? '' : '',
      readme,
    ].join('\r\n'),
    'utf8',
  )

  console.log(`便携包已生成：${outDir}`)
  console.log('双击 start.cmd 即可启动（默认 http://localhost:8787）。')
}

await main()
