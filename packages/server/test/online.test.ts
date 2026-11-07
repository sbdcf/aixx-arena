/**
 * 服务端联机验收（对应 task-3 的 10 条验收 + 掉线重连）。
 *
 * 全部用真实 WS 连接连 `startServer({ port: 0 })` 的随机端口；题库读真仓库数据，
 * 只有「超时」用例注入一张 0.3s 的临时试卷（不依赖 data/papers）。
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { Paper } from '../src/core.ts'
import type { Bank } from '../src/data.ts'
import { loadBank } from '../src/data.ts'
import type { ArenaServer } from '../src/server.ts'
import { startServer } from '../src/server.ts'
import type { AckMessage, EndedMessage, ErrorMessage, LobbyMessage, PaperMessage, Player, RoomMessage } from './helpers.ts'
import { TestClient, connectPlayer, createRoomAsHost, sleep } from './helpers.ts'

let bank: Bank

before(async () => {
  bank = await loadBank()
})

function launch(overrides: Partial<Parameters<typeof startServer>[0]> = {}): Promise<ArenaServer> {
  return startServer({ port: 0, host: '127.0.0.1', bank, ...overrides })
}

function trackClients(clients: TestClient[], server: ArenaServer, context: { after: (fn: () => unknown) => void }): void {
  context.after(async () => {
    for (const client of clients) client.close()
    await server.close()
  })
}

/** 组一支 1–3 人的 team-solo 队并开局，返回开局后的 paper/room。 */
async function startTeamSolo(
  server: ArenaServer,
  clients: TestClient[],
  names: string[],
): Promise<{ players: Player[]; paper: PaperMessage; rooms: RoomMessage[]; roomCode: string }> {
  const host = await createRoomAsHost(server.port, names[0] as string, 'paper-team-solo-10')
  clients.push(host.client)
  const players: Player[] = [host]

  for (const name of names.slice(1)) {
    const player = await connectPlayer(server.port, name)
    clients.push(player.client)
    player.client.send({ t: 'join', room_code: host.roomCode })
    await player.client.waitForType('lobby')
    player.client.send({ t: 'join_team', team_code: host.teamCode })
    await player.client.waitFor((message) => message.t === 'lobby' && message.viewer_id === player.participantId)
    players.push(player)
  }

  host.client.send({ t: 'start' })
  const paper = await host.client.waitForType('paper')
  const room = await host.client.waitForType('room')
  assert.equal(room.snapshot.phase, 'answering')

  const rooms: RoomMessage[] = [room]
  for (const player of players.slice(1)) {
    await player.client.waitForType('paper')
    rooms.push(await player.client.waitForType('room'))
  }
  return { players, paper, rooms, roomCode: host.roomCode }
}

test('1. hello_ok 带 participant_id；版本不符 → VERSION_MISMATCH fatal 并断开', async (t) => {
  const server = await launch()
  const clients: TestClient[] = []
  t.after(async () => {
    for (const client of clients) client.close()
    await server.close()
  })

  const good = await connectPlayer(server.port, '甲')
  clients.push(good.client)
  assert.match(good.participantId, /^p-/)

  const bad = await TestClient.open(server.port)
  clients.push(bad)
  bad.send({ t: 'hello', v: 99, name: '旧版本' })
  const error = await bad.waitForType('error')
  assert.equal(error.code, 'VERSION_MISMATCH')
  assert.equal(error.fatal, true)
  await bad.waitClosed()
})

test('2. create → lobby（6 位数字房间码，host_id 是自己）', async (t) => {
  const server = await launch()
  const clients: TestClient[] = []
  t.after(async () => {
    for (const client of clients) client.close()
    await server.close()
  })

  const host = await connectPlayer(server.port, '房主')
  clients.push(host.client)
  host.client.send({ t: 'create', format: 'team-solo', paper_id: 'paper-team-solo-10' })
  const lobby = await host.client.waitForType('lobby')

  assert.match(lobby.room_code, /^\d{6}$/)
  assert.equal(lobby.host_id, host.participantId)
  assert.equal(lobby.viewer_id, host.participantId)
  assert.equal(lobby.format, 'team-solo')
  assert.equal(lobby.paper_id, 'paper-team-solo-10')
  assert.equal(lobby.started, false)
  assert.equal(lobby.team_id, null)
  assert.deepEqual(lobby.teams, [])
})

test('3. join 错误房间码 → ROOM_NOT_FOUND', async (t) => {
  const server = await launch()
  const clients: TestClient[] = []
  t.after(async () => {
    for (const client of clients) client.close()
    await server.close()
  })

  const player = await connectPlayer(server.port, '乙')
  clients.push(player.client)
  player.client.send({ t: 'join', room_code: '000000' })
  const error = await player.client.waitForType('error')
  assert.equal(error.code, 'ROOM_NOT_FOUND')
})

test('4. 两人组队：new_team 拿到团队码，另一人 join_team 成功，双方 lobby 队伍成员正确', async (t) => {
  const server = await launch()
  const clients: TestClient[] = []
  t.after(async () => {
    for (const client of clients) client.close()
    await server.close()
  })

  const host = await createRoomAsHost(server.port, '队长', 'paper-team-solo-10')
  clients.push(host.client)
  assert.match(host.teamCode, /^\d{6}$/)

  const guest = await connectPlayer(server.port, '队员')
  clients.push(guest.client)
  guest.client.send({ t: 'join', room_code: host.roomCode })
  const guestLobby = await guest.client.waitForType('lobby')
  assert.equal(guestLobby.team_id, null)
  assert.equal(guestLobby.teams.length, 1)

  guest.client.send({ t: 'join_team', team_code: host.teamCode })
  const afterJoin = await guest.client.waitForType('lobby')
  assert.equal(afterJoin.teams.length, 1)
  const team = afterJoin.teams[0]
  assert.ok(team)
  assert.equal(team.id, guestLobby.teams[0]?.id)
  assert.deepEqual(team.members.map((member) => member.id).sort(), [host.participantId, guest.participantId].sort())
  assert.deepEqual(team.members.map((member) => member.name).sort(), ['队长', '队员'].sort())

  const hostLobby = await host.client.waitFor(
    (message): message is LobbyMessage => message.t === 'lobby' && (message.teams[0]?.members.length ?? 0) === 2,
  )
  assert.equal(hostLobby.teams[0]?.members.length, 2)
  // 队伍码只发给本队成员
  assert.equal(hostLobby.teams[0]?.code, host.teamCode)
  assert.equal(afterJoin.teams[0]?.code, host.teamCode)
  assert.equal(hostLobby.viewer_id, host.participantId)
})

test('5. 非房主 start → NOT_AUTHORIZED；房主 start → 每人收 paper + room（deadline_at 在未来）', async (t) => {
  const server = await launch()
  const clients: TestClient[] = []
  t.after(async () => {
    for (const client of clients) client.close()
    await server.close()
  })

  const host = await createRoomAsHost(server.port, '房主', 'paper-team-solo-10')
  clients.push(host.client)
  const guest = await connectPlayer(server.port, '队员')
  clients.push(guest.client)
  guest.client.send({ t: 'join', room_code: host.roomCode })
  await guest.client.waitForType('lobby')
  guest.client.send({ t: 'join_team', team_code: host.teamCode })
  await guest.client.waitFor((message) => message.t === 'lobby' && message.viewer_id === guest.participantId)

  guest.client.send({ t: 'start' })
  const denied = await guest.client.waitForType('error')
  assert.equal(denied.code, 'NOT_AUTHORIZED')

  host.client.send({ t: 'start' })
  const hostPaper = await host.client.waitForType('paper')
  const hostRoom = await host.client.waitForType('room')
  const guestPaper = await guest.client.waitForType('paper')
  const guestRoom = await guest.client.waitForType('room')

  assert.ok(hostPaper.questions.length > 0)
  assert.equal(hostPaper.questions.length, guestPaper.questions.length)
  assert.equal(hostPaper.questions.length, hostRoom.snapshot.total)
  for (const question of hostPaper.questions) {
    assert.equal(Object.prototype.hasOwnProperty.call(question, 'answer'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(question, 'explain'), false)
  }

  for (const room of [hostRoom, guestRoom]) {
    assert.equal(room.snapshot.phase, 'answering')
    assert.ok(room.snapshot.clock.deadline_at > room.snapshot.server_at)
    assert.equal(room.snapshot.viewer_id, room === hostRoom ? host.participantId : guest.participantId)
    assert.ok(room.snapshot.peers.every((peer) => peer.online))
    assert.deepEqual(room.snapshot.own.answers, {})
  }
})

test('6. team-solo：ack 带 correct/points；重复 seq 不回 ack；另一人看不到答案', async (t) => {
  const server = await launch()
  const clients: TestClient[] = []
  t.after(async () => {
    for (const client of clients) client.close()
    await server.close()
  })

  const host = await createRoomAsHost(server.port, '甲', 'paper-team-solo-10')
  clients.push(host.client)
  const guest = await connectPlayer(server.port, '乙')
  clients.push(guest.client)
  guest.client.send({ t: 'join', room_code: host.roomCode })
  await guest.client.waitForType('lobby')
  guest.client.send({ t: 'join_team', team_code: host.teamCode })
  await guest.client.waitFor((message) => message.t === 'lobby' && message.viewer_id === guest.participantId)

  host.client.send({ t: 'start' })
  const paper = await host.client.waitForType('paper')
  await guest.client.waitForType('paper')
  await host.client.waitForType('room')
  await guest.client.waitForType('room')

  const first = paper.questions[0]
  assert.ok(first)
  const question = bank.questions.find((candidate) => candidate.id === first.id)
  assert.ok(question)

  host.client.send({ t: 'submit', qid: first.id, seq: 1, choice: [...question.answer] })
  const ack = await host.client.waitForType('ack')
  assert.equal(ack.qid, first.id)
  assert.equal(ack.accepted, true)
  assert.equal(ack.correct, true)
  assert.equal(ack.points, 2)

  // 重复 seq：静默丢弃，不回 ack（也不回 error）
  const before = host.client.received.length
  host.client.send({ t: 'submit', qid: first.id, seq: 1, choice: [...question.answer] })
  await sleep(300)
  const dropped = host.client.since(before)
  assert.equal(dropped.some((message) => message.t === 'ack'), false)
  assert.equal(dropped.some((message) => message.t === 'error'), false)

  const guestRoom = await guest.client.waitFor(
    (message): message is RoomMessage =>
      message.t === 'room' && message.snapshot.peers.some((peer) => peer.id === host.participantId && peer.progress.answered === 1),
  )
  assert.equal(guestRoom.snapshot.own.answers[first.id], undefined)
  assert.equal(JSON.stringify(guestRoom.snapshot).includes('"answer"'), false)
  assert.equal(guestRoom.snapshot.own.locked.includes(first.id), false)

  const hostRoom = await host.client.waitFor(
    (message): message is RoomMessage => message.t === 'room' && message.snapshot.own.answers[first.id] !== undefined,
  )
  assert.deepEqual(hostRoom.snapshot.own.answers[first.id], question.answer)
})

test('7. team-coop：辅助位提交 → NOT_AUTHORIZED；主答 advance → 双方 current_index 递增', async (t) => {
  const server = await launch()
  const clients: TestClient[] = []
  t.after(async () => {
    for (const client of clients) client.close()
    await server.close()
  })

  const host = await createRoomAsHost(server.port, '主答', 'paper-team-coop-10')
  clients.push(host.client)
  const mates: Player[] = []
  for (const name of ['辅助一', '辅助二']) {
    const mate = await connectPlayer(server.port, name)
    clients.push(mate.client)
    mate.client.send({ t: 'join', room_code: host.roomCode })
    await mate.client.waitForType('lobby')
    mate.client.send({ t: 'join_team', team_code: host.teamCode })
    await mate.client.waitFor((message) => message.t === 'lobby' && message.viewer_id === mate.participantId)
    mates.push(mate)
  }

  host.client.send({ t: 'start' })
  const paper = await host.client.waitForType('paper')
  const startRoom = await host.client.waitForType('room')
  assert.equal(startRoom.snapshot.phase, 'answering')
  assert.equal(startRoom.snapshot.current_index, 0)

  const qid = paper.questions[0]?.id
  assert.ok(qid)
  const question = bank.questions.find((candidate) => candidate.id === qid)
  assert.ok(question)

  const helper = mates[0] as Player
  helper.client.send({ t: 'submit', qid, seq: 1, choice: [...question.answer] })
  const helperError = await helper.client.waitForType('error')
  assert.equal(helperError.code, 'NOT_AUTHORIZED')
  assert.match(helperError.message, /只有主答可以提交/)

  host.client.send({ t: 'submit', qid, seq: 1, choice: [...question.answer] })
  const ack = await host.client.waitForType('ack')
  assert.equal(ack.accepted, true)
  assert.equal(ack.correct, true)
  assert.equal(ack.points, 4)

  host.client.send({ t: 'advance' })
  const hostAdvanced = await host.client.waitFor(
    (message): message is RoomMessage => message.t === 'room' && message.snapshot.current_index === 1,
  )
  assert.equal(hostAdvanced.snapshot.current_index, 1)

  const mate2 = mates[1] as Player
  const mateAdvanced = await mate2.client.waitFor(
    (message): message is RoomMessage => message.t === 'room' && message.snapshot.current_index === 1,
  )
  assert.equal(mateAdvanced.snapshot.current_index, 1)
})

test('8. 超时：到 deadline_at 自动结束（end_reason = time）', async (t) => {
  const base = bank.papers.get('paper-team-solo-10')
  assert.ok(base)
  const timeoutPaper: Paper = {
    ...base,
    id: 'paper-test-timeout',
    name: '超时测试卷',
    duration_sec: 0.3,
    draw: { single: 1, multiple: 0, judge: 0, min_available: 1, allow_partial: true, seed: 11 },
  }
  const papers = new Map(bank.papers)
  papers.set(timeoutPaper.id, timeoutPaper)
  const tinyBank: Bank = { ...bank, papers }

  const server = await launch({ bank: tinyBank })
  const clients: TestClient[] = []
  t.after(async () => {
    for (const client of clients) client.close()
    await server.close()
  })

  const host = await createRoomAsHost(server.port, '超时玩家', 'paper-test-timeout')
  clients.push(host.client)
  host.client.send({ t: 'start' })
  const paper = await host.client.waitForType('paper')
  assert.equal(paper.questions.length, 1)

  const ended = await host.client.waitForType('ended', 6000)
  assert.equal(ended.summary.end_reason, 'time')
  assert.equal(ended.summary.format, 'team-solo')
  assert.ok(ended.summary.questions.length === 1)
})

test('9. 答案不泄漏：整局下行消息（ended 之前）不含 "answer"', async (t) => {
  const server = await launch()
  const clients: TestClient[] = []
  t.after(async () => {
    for (const client of clients) client.close()
    await server.close()
  })

  const host = await createRoomAsHost(server.port, '防泄漏甲', 'paper-team-solo-10')
  clients.push(host.client)
  const guest = await connectPlayer(server.port, '防泄漏乙')
  clients.push(guest.client)
  guest.client.send({ t: 'join', room_code: host.roomCode })
  await guest.client.waitForType('lobby')
  guest.client.send({ t: 'join_team', team_code: host.teamCode })
  await guest.client.waitFor((message) => message.t === 'lobby' && message.viewer_id === guest.participantId)

  host.client.send({ t: 'start' })
  const paper = await host.client.waitForType('paper')
  await guest.client.waitForType('paper')
  await host.client.waitForType('room')
  await guest.client.waitForType('room')

  const qid = paper.questions[0]?.id
  assert.ok(qid)
  const question = bank.questions.find((candidate) => candidate.id === qid)
  assert.ok(question)
  host.client.send({ t: 'submit', qid, seq: 1, choice: [...question.answer] })
  await host.client.waitForType('ack')
  host.client.send({ t: 'end' })
  const ended = await host.client.waitForType('ended')
  assert.equal(ended.summary.end_reason, 'host')
  await guest.client.waitForType('ended')

  for (const client of [host.client, guest.client]) {
    const endedIndex = client.received.findIndex((message) => message.t === 'ended')
    assert.ok(endedIndex > 0)
    for (const message of client.received.slice(0, endedIndex)) {
      assert.equal(JSON.stringify(message).includes('"answer"'), false, `泄漏消息: ${JSON.stringify(message).slice(0, 120)}`)
    }
    // ended.summary 是唯一允许带答案的地方
    assert.ok(ended.summary.questions.some((entry) => entry.answer.length > 0))
  }
})

test('10. /healthz 返回 200 且 ok=true', async (t) => {
  const server = await launch()
  t.after(async () => {
    await server.close()
  })

  const response = await fetch(`http://127.0.0.1:${server.port}/healthz`)
  assert.equal(response.status, 200)
  const payload = (await response.json()) as Record<string, unknown>
  assert.equal(payload.ok, true)
  assert.equal(payload.protocol, 1)
  assert.equal(payload.rooms, 0)
  assert.equal(typeof payload.uptime_sec, 'number')
})

test('附：掉线后用 resume_id 重连，接管连接并补发 lobby', async (t) => {
  const server = await launch()
  const clients: TestClient[] = []
  t.after(async () => {
    for (const client of clients) client.close()
    await server.close()
  })

  const host = await connectPlayer(server.port, '会重连的房主')
  clients.push(host.client)
  host.client.send({ t: 'create', format: 'team-solo', paper_id: 'paper-team-solo-10' })
  const firstLobby = await host.client.waitForType('lobby')

  host.client.close()
  await host.client.waitClosed()
  await sleep(150)

  const resumed = await TestClient.open(server.port)
  clients.push(resumed)
  resumed.send({ t: 'hello', v: 1, name: '会重连的房主', resume_id: host.participantId })
  const hello = await resumed.waitForType('hello_ok')
  assert.equal(hello.participant_id, host.participantId)

  const lobby = await resumed.waitForType('lobby')
  assert.equal(lobby.room_code, firstLobby.room_code)
  assert.equal(lobby.host_id, host.participantId)
  assert.equal(lobby.viewer_id, host.participantId)
})
