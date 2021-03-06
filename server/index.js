const express = require('express')
const consola = require('consola')
const { Nuxt, Builder } = require('nuxt')
const app = express()
const socket = require('socket.io')
const _nano = require('nano')
const sha = require('js-sha256')
const _ = require('lodash')

const IDs = {
  images: 'images',
  isCreated: 'isCreated',
  roomNo: 'roomNo',
  roomName: 'roomName',
  password: 'password',
  system: 'system',
  chatLog: 'chatLog',
  chits: 'chits',
  status: 'status',
  map: 'map'
}

// Import and Set Nuxt.js options
const config = require('../nuxt.config.js')
config.dev = process.env.NODE_ENV !== 'production'
process.env.CONSOLA_LEVEL = 6

// 自作ライブラリはnuxtのあとに入れる必要がある。
// import dicebot
const dicebot = require('./dicebot').dicebot()

// import constants
// 変更される可能性があるオブジェクトはこちらで参照する
const constantsF = require('./constants.js').constants
// 変更されないリテラルなどはこちらから参照する
const constants = constantsF()

// db connection
const dbUrl = 'http://' + constants.DB_USERPASS + '@' + constants.DB_HOST + ':' + constants.DB_PORT
const nano = _nano(dbUrl)
let dbMaster
const rooms = []
let images = {}

/**
 * _rooms に各部屋の情報のセットアップをする
 * @param {Array} _rooms 部屋の配列
 * @param {Boolean} reCreate 初期化フラグ
 * @param {Number} i 部屋番号
 */
const setRoom = async function (_rooms, reCreate, i) {
  const roomDbName = constants.DB_PREFIX + '_room_' + i
  let roomDb
  if (reCreate) {
    // init room DB
    consola.info(`create ${roomDbName}`)
    await nano.db.destroy(roomDbName).catch(() => {})
    await nano.db.create(roomDbName)
    roomDb = await nano.db.use(roomDbName)
    const initdata = constantsF().INITDATA
    // TODO : 配列にぶちこんで全部並列に実行する
    await roomDb.insert({ value: initdata.room.isCreated }, IDs.isCreated)
    await roomDb.insert({ value: i }, IDs.roomNo)
    await roomDb.insert({ value: initdata.room.roomName }, IDs.roomName)
    await roomDb.insert({ value: initdata.room.password }, IDs.password)
    await roomDb.insert({ value: initdata.room.system }, IDs.system)
    await roomDb.insert({ value: initdata.room.chatLog }, IDs.chatLog)
    await roomDb.insert({ value: initdata.room.chits }, IDs.chits)
    await roomDb.insert({ value: initdata.room.status }, IDs.status)
    await roomDb.insert({ value: initdata.room.map }, IDs.map)
  } else {
    roomDb = await nano.db.use(roomDbName)
  }

  consola.info({
    message: 'chash room Data',
    badge: true
  })
  const roomData = {}
  const isCreated = roomDb.get(IDs.isCreated)
  const roomNo = roomDb.get(IDs.roomNo)
  const roomName = roomDb.get(IDs.roomName)
  const password = roomDb.get(IDs.password)
  const system = roomDb.get(IDs.system)
  const chatLog = roomDb.get(IDs.chatLog)
  const chits = roomDb.get(IDs.chits)
  const status = roomDb.get(IDs.status)
  const map = roomDb.get(IDs.map)

  roomData.isCreated = await isCreated
  roomData.roomNo = await roomNo
  roomData.roomName = await roomName
  roomData.password = await password
  roomData.system = await system
  roomData.chatLog = await chatLog
  roomData.chits = await chits
  roomData.status = await status
  roomData.map = await map
  rooms[i] = { roomDb, member: [], roomData }
}

/**
 * 全ての部屋に対して使用準備をする
 * @param {any} _rooms
 * @param {Boolean} reCreate
 */
const setRoomsAll = function (_rooms, reCreate) {
  [...Array(constants.ROOM_TOTAL)].forEach((_, i) => {
    setRoom(_rooms, reCreate, i)
  })
}

// init db
function initDb () {
  consola.info('finding DB...')
  nano.db.get(constants.DB_PREFIX, async function (err, data) {
    if (err) {
      // マスターDBが無い場合、全DBの初期化をする。
      consola.error({
        message: `not found DB ${constants.DB_PREFIX}!`,
        badge: true
      })
      consola.info(`try to initial DB ${constants.DB_PREFIX}`)

      // master DB
      await nano.db.create(constants.DB_PREFIX)
      dbMaster = nano.db.use(constants.DB_PREFIX)
      dbMaster.insert({ value: [] }, IDs.images)
      // rooms
      setRoomsAll(rooms, true)
    } else {
      // マスターDBが見つかった場合は使用準備をする
      consola.info({
        message: `found DB ${constants.DB_PREFIX}`,
        badge: true
      })
      dbMaster = nano.db.use(constants.DB_PREFIX)
      images = await dbMaster.get(IDs.images)
      setRoomsAll(rooms, false)
    }
  })
}

initDb()

/**
 * 部屋情報をクライアントが扱いやすい形に成型する
 * @param {部屋情報} roomRaw
 */
function moldRoomData (roomRaw) {
  const room = {}
  room.member = roomRaw.member
  room.isCreated = roomRaw.roomData.isCreated.value
  room.roomNo = roomRaw.roomData.roomNo.value
  room.roomName = roomRaw.roomData.roomName.value
  room.password = roomRaw.roomData.password.value
  room.system = roomRaw.roomData.system.value
  room.chatLog = roomRaw.roomData.chatLog.value
  room.chits = roomRaw.roomData.chits.value
  room.map = roomRaw.roomData.map.value

  return room
}

async function start () {
  // Init Nuxt.js
  const nuxt = new Nuxt(config)

  const { host, port } = nuxt.options.server

  await nuxt.ready()
  // Build only in dev mode
  if (config.dev) {
    const builder = new Builder(nuxt)
    await builder.build()
  }

  // Give nuxt middleware to express
  app.use(nuxt.render)

  // Listen the server
  const server = app.listen(port, host)
  consola.ready({
    message: `Server listening on http://${host}:${port}`,
    badge: true
  })

  const io = socket(server)
  let systems = null

  io.on('connection', (socket) => {
    const id = socket.id
    let roomNo

    /**
     * idを_roomNoのリストから消去する
     */
    const leaveRoom = function (_roomNo, id) {
      const roomMember = rooms[roomNo].member
      socket.leave(roomNo)
      roomMember.splice(roomMember.findIndex(m => m.id === id), 1)
    }

    consola.info(`user ${id} connected`)

    socket.on('enterRoom', ({ tryRoomNo, name, password }) => {
      consola.info(`${id} enter room`)
      consola.info(tryRoomNo)
      if (roomNo) {
        leaveRoom(roomNo, id)
      }
      if (!rooms[tryRoomNo]) {
        io.to(id).emit('enterRoom.failed', { msg: '不正な部屋番号です' })
        return
      }
      if (!rooms[tryRoomNo].roomData.isCreated.value) {
        io.to(id).emit('enterRoom.failed', { msg: '部屋が作成されていません' })
        return
      }
      if (sha.sha256(password) !== rooms[tryRoomNo].roomData.password.value) {
        io.to(id).emit('enterRoom.failed', { msg: 'パスワードが一致していません' })
        return
      }
      roomNo = tryRoomNo
      socket.join(roomNo, () => {
        rooms[roomNo].member.push({ id, name })
      })
      io.to(id).emit('enterRoom.success')
    })

    socket.on('disconnect', () => {
      consola.info(`user ${id} disconnected`)
      if (roomNo) {
        leaveRoom(roomNo, id)
      }
    })

    socket.on('chat.init', () => {
      const log = rooms[roomNo].roomData.chatLog.value
      io.to(id).emit('chat.init', log)
    })
    socket.on('chat.send', async ({ msg, system }) => {
      const room = rooms[roomNo]
      const roomDb = room.roomDb
      room.roomData.chatLog.value.push(msg)
      await roomDb.insert(room.roomData.chatLog, IDs.chatLog)
      room.roomData.chatLog = await roomDb.get(IDs.chatLog)
      io.to(roomNo + '').emit('chat.receive', msg)
      dicebot.roll(async (err, res) => {
        if (err || !res.ok) {
          return
        }
        const dmsg = {
          id: Date.now(),
          name: system,
          text: res.result.slice(1),
          color: msg.color
        }
        room.roomData.chatLog.value.push(dmsg)
        await roomDb.insert(room.roomData.chatLog, IDs.chatLog)
        room.roomData.chatLog = await roomDb.get(IDs.chatLog)
        io.to(roomNo + '').emit('chat.receive', dmsg)
      },
      system,
      msg.text)
    })

    socket.on('systems', () => {
      if (systems) {
        io.to(id).emit('systems', systems)
      } else {
        dicebot.systems((err, data) => {
          if (err) {
            consola.err(err)
            return
          }
          systems = data
          io.to(id).emit('systems', systems)
        })
      }
    })

    socket.on('roomsinfo', () => {
      consola.info('send info to ' + id)
      io.to(id).emit('roomsinfo', rooms.map((r) => {
        const info = {
          roomNo: r.roomData.roomNo.value,
          isCreated: r.roomData.isCreated.value,
          text: r.roomData.roomName.value,
          password: r.roomData.password.value,
          system: r.roomData.system.value
        }
        return info
      }))
    })

    socket.on('createRoom', async function ({ roomId, roomName, password, system }) {
      consola.info(`create room ${roomId}`)
      const roomDb = rooms[roomId].roomDb
      let isCreated = await roomDb.get(IDs.isCreated)
      if (isCreated.value) {
        consola.error('failed make room')
        io.to(id).emit('createRoom.error', new Error('すでに部屋が作成されています'))
        return
      }
      const roomData = rooms[roomId].roomData
      isCreated = true
      roomData.isCreated.value = true
      roomData.roomName.value = roomName
      roomData.password.value = sha.sha256(password)
      roomData.system.value = system
      io.to(id).emit('createRoom.success')

      roomDb.insert(roomData.isCreated)
      roomDb.insert(roomData.roomName)
      roomDb.insert(roomData.password)
      roomDb.insert(roomData.system)
      consola.info('success create room')
    })
    socket.on('roomData', (roomNo) => {
      const room = moldRoomData(rooms[roomNo])
      io.to(id).emit('roomData', room)
    })
    socket.on('images', () => {
      io.to(id).emit('images', images.value)
    })
    socket.on('images.add', async (img) => {
      images.value.push(img)
      await dbMaster.insert(images, IDs.images)
      images = await dbMaster.get(IDs.images)
      io.emit('images.add', img)
    })
    socket.on('images.delete', async (id) => {
      images.value.splice(images.value.findIndex(i => i.id === id), 1)
      await dbMaster.insert(images, IDs.images)
      images = await dbMaster.get(IDs.images)
      io.emit('images.delete', id)
    })
    socket.on('status.init', () => {
      if (!roomNo) { return }
      const status = rooms[roomNo].roomData.status.value
      io.to(id).emit('status.init', status)
    })
    socket.on('status.edit', async (statusStr) => {
      const makeStatusData = function (status) {
        const statusArr = status.split(' ')
        const statusData = statusArr.map((name) => {
          if (name.charAt(0) === '*') {
            return {
              name: name.slice(1),
              type: 'bool',
              value: false
            }
          } else {
            return {
              name,
              type: 'number',
              value: 0
            }
          }
        })
        return statusData
      }
      const room = rooms[roomNo]
      const dbRoom = room.roomDb
      room.roomData.chits.value = room.roomData.chits.value.map((c) => {
        c.status = makeStatusData(statusStr)
        return c
      })
      room.roomData.status.value = statusStr
      await dbRoom.insert(room.roomData.status, IDs.status)
      await dbRoom.insert(room.roomData.chits, IDs.chits)
      room.roomData.status = await dbRoom.get(IDs.status)
      room.roomData.chits = await dbRoom.get(IDs.chits)
      io.to(roomNo + '').emit('status.init', statusStr)
      io.to(roomNo + '').emit('chits.init', room.roomData.chits.value)
    })
    socket.on('chits.init', () => {
      const chits = rooms[roomNo].roomData.chits.value
      io.to(id).emit('chits.init', chits)
    })
    socket.on('chit.add', async (chit) => {
      const chits = rooms[roomNo].roomData.chits
      const dbRoom = rooms[roomNo].roomDb
      chits.value.push(chit)
      await dbRoom.insert(chits, IDs.chits)
      rooms[roomNo].roomData.chits = await dbRoom.get(IDs.chits)
      io.to(roomNo + '').emit('chit.add', chit)
    })
    socket.on('chit.update', async (chit) => {
      const chits = rooms[roomNo].roomData.chits
      const dbRoom = rooms[roomNo].roomDb
      chits.value = _.reject(chits.value, { id: chit.id })
      chits.value.push(chit)
      await dbRoom.insert(chits, IDs.chits)
      rooms[roomNo].roomData.chits = await dbRoom.get(IDs.chits)
      io.to(roomNo + '').emit('chit.update', chit)
    })
    socket.on('chit.delete', async (id) => {
      const chits = rooms[roomNo].roomData.chits
      const dbRoom = rooms[roomNo].roomDb
      chits.value = _.reject(chits.value, { id })
      await dbRoom.insert(chits, IDs.chits)
      rooms[roomNo].roomData.chits = await dbRoom.get(IDs.chits)
      io.to(roomNo + '').emit('chit.delete', id)
    })
    socket.on('map.change', async ({ map }) => {
      const dbRoom = rooms[roomNo].roomDb
      rooms[roomNo].roomData.map.value = map
      await dbRoom.insert(rooms[roomNo].roomData.map, IDs.map)
      rooms[roomNo].roomData.map = await dbRoom.get(IDs.map)
      io.to(roomNo + '').emit('map.change', { map: rooms[roomNo].roomData.map.value })
    })
    socket.on('room.delete', () => {
      io.to(roomNo + '').emit('room.delete')
      setRoom(rooms, true, roomNo)
    })
  })
}
start()
