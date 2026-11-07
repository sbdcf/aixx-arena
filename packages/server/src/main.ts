/**
 * CLI 入口：`node src/main.ts --port 8787 --host 0.0.0.0 ...`
 *
 * 启动后打印本地与局域网地址（老师/学生用手机连 `http://<内网IP>:8787`）。
 */

import { networkInterfaces } from 'node:os'

import { DEFAULT_DATA_ROOT, DEFAULT_WEB_ROOT } from './data.ts'
import { SERVER_VERSION, startServer } from './server.ts'
import { PROTOCOL_VERSION } from './core.ts'
import { MAX_ROOM_MEMBERS, MAX_TEAM_MEMBERS } from './rooms.ts'

interface CliOptions {
  port: number
  host: string
  webRoot: string
  dataRoot: string
  allowOrigin?: string
  maxRooms: number
}

function usage(): string {
  return [
    '用法: node src/main.ts [选项]',
    '',
    '  --port <n>            监听端口，默认 8787，0 表示随机端口',
    '  --host <addr>         监听地址，默认 0.0.0.0（局域网可访问）',
    '  --web-root <dir>      前端静态目录，默认 packages/web/dist',
    '  --data-root <dir>     题库目录，默认 data（含 questions/ papers/）',
    '  --allow-origin <v>    /healthz 的 CORS 头，例如 "*"',
    '  --max-rooms <n>       最大房间数，默认 100',
    '  --help                显示这份帮助',
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    port: 8787,
    host: '0.0.0.0',
    webRoot: DEFAULT_WEB_ROOT,
    dataRoot: DEFAULT_DATA_ROOT,
    maxRooms: 100,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index] as string
    if (raw === '--help' || raw === '-h') {
      console.log(usage())
      process.exit(0)
    }
    const [flag, inlineValue] = raw.includes('=') ? (raw.split(/=(.*)/s) as [string, string]) : [raw, undefined]
    const take = (): string => {
      if (inlineValue !== undefined) return inlineValue
      index += 1
      const next = argv[index]
      if (next === undefined) throw new Error(`参数 ${flag} 缺少值`)
      return next
    }
    switch (flag) {
      case '--port': {
        const value = Number(take())
        if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('--port 应为 0–65535 的整数')
        options.port = value
        break
      }
      case '--host':
        options.host = take()
        break
      case '--web-root':
        options.webRoot = take()
        break
      case '--data-root':
        options.dataRoot = take()
        break
      case '--allow-origin':
        options.allowOrigin = take()
        break
      case '--max-rooms': {
        const value = Number(take())
        if (!Number.isInteger(value) || value <= 0) throw new Error('--max-rooms 应为正整数')
        options.maxRooms = value
        break
      }
      default:
        throw new Error(`未知参数: ${raw}\n\n${usage()}`)
    }
  }
  return options
}

function lanAddresses(): string[] {
  const result: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      result.push(entry.address)
    }
  }
  return result
}

async function main(): Promise<void> {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }

  let server
  try {
    server = await startServer({
      port: options.port,
      host: options.host,
      webRoot: options.webRoot,
      dataRoot: options.dataRoot,
      maxRooms: options.maxRooms,
      ...(options.allowOrigin ? { allowOrigin: options.allowOrigin } : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`启动失败: ${message}`)
    process.exit(1)
  }

  const bank = server.bank
  const lines = [
    `aixx-arena server v${SERVER_VERSION} (protocol v${PROTOCOL_VERSION})`,
    `  local    http://127.0.0.1:${server.port}`,
    ...lanAddresses().map((address) => `  lan      http://${address}:${server.port}`),
    `  web root ${options.webRoot}`,
    `  data     ${bank.data_root}`,
    `  bank     ${bank.questions.length} 题 / ${bank.papers.size} 卷`,
    `  capacity ${options.maxRooms} rooms × ${MAX_ROOM_MEMBERS} players（每队 ≤ ${MAX_TEAM_MEMBERS} 人）`,
    '  ws       /ws（upgrade 接受任意路径，便于反代）',
    'ready. Ctrl+C to stop.',
  ]
  console.log(lines.join('\n'))

  let closing = false
  const shutdown = (signal: string) => {
    if (closing) return
    closing = true
    console.log(`\n收到 ${signal}，正在关闭服务器…`)
    void server.close().then(() => process.exit(0))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

void main()
