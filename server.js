const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.get('/', (_, res) => res.sendFile(__dirname + '/index.html'));

function publicRoom(r) {
  return {
    code: r.code,
    players: r.players.map(p => ({
      id: p.id, name: p.name, photoUrl: p.photoUrl || '', ready: p.ready,
      alive: p.alive, host: p.id === r.host
    })),
    phase: r.phase,
    round: r.round,
    hostId: r.host
  };
}

function sendRoom(r) {
  io.to(r.code).emit('room:update', publicRoom(r));
  io.emit('rooms:list:update', [...rooms.values()].map(x => ({
    code: x.code, count: x.players.length, max: 10, phase: x.phase
  })));
}

function notice(socket, message) {
  socket.emit('notice', message);
}

function winner(r) {
  const alive = r.players.filter(p => p.alive);
  const mafia = alive.filter(p => r.roles[p.id] === 'mafia').length;
  const town = alive.length - mafia;
  if (mafia === 0) return 'town';
  if (mafia >= town) return 'mafia';
  return null;
}

function endGame(r) {
  const result = winner(r);
  if (!result) return false;
  r.phase = 'game_over';
  io.to(r.code).emit('game:result', {
    players: r.players.map(p => ({
      id: p.id, name: p.name, alive: p.alive, role: r.roles[p.id]
    })),
    winner: result
  });
  io.to(r.code).emit('game:phase', {
    phase: r.phase, round: r.round, winner: result
  });
  sendRoom(r);
  return true;
}

function finishRoom(r) {
  if (!r.players.length) {
    rooms.delete(r.code);
    io.emit('rooms:list:update', [...rooms.values()].map(x => ({
      code: x.code, count: x.players.length, max: 10, phase: x.phase
    })));
    return;
  }
  if (!r.players.some(p => p.id === r.host)) {
    r.host = r.players[0].id;
  }
  if (r.phase !== 'lobby' && r.phase !== 'game_over') {
    r.phase = 'game_over';
    io.to(r.code).emit('game:phase', {
      phase: 'game_over', round: r.round
    });
    io.to(r.code).emit('notice', 'O‘yinchi chiqib ketdi. O‘yinni qaytadan boshlang.');
  }
  sendRoom(r);
}


const khdPublicRooms = new Map();
function khdSendPublicRooms() {
  io.emit('publicRooms:update', [...khdPublicRooms.values()].map(r => ({
    id:r.id, name:r.name, players:r.players.size, maxPlayers:r.maxPlayers,
    status:r.status
  })));
}
io.on('connection', socket => {
  socket.on('publicRooms:list', () => khdSendPublicRooms());
  socket.on('publicRooms:create', data => {
    const name = String(data?.name || 'Mafia xonasi').trim().slice(0,32);
    const maxPlayers = Math.max(5, Math.min(10, Number(data?.maxPlayers) || 10));
    const id = 'room-' + Math.random().toString(36).slice(2,9);
    const room = {id, name, maxPlayers, players:new Set([socket.id]), status:'Kutilyapti'};
    khdPublicRooms.set(id, room);
    socket.join(id);
    socket.data.khdPublicRoom = id;
    socket.emit('publicRooms:joined', {id, name});
    khdSendPublicRooms();
  });
  socket.on('publicRooms:join', id => {
    const room = khdPublicRooms.get(String(id));
    if (!room || room.players.size >= room.maxPlayers) {
      socket.emit('publicRooms:error', 'Xona to‘la yoki topilmadi');
      return;
    }
    const old = socket.data.khdPublicRoom;
    if (old && khdPublicRooms.has(old)) {
      const previous = khdPublicRooms.get(old);
      previous.players.delete(socket.id);
      if (!previous.players.size) khdPublicRooms.delete(old);
    }
    room.players.add(socket.id);
    socket.join(room.id);
    socket.data.khdPublicRoom = room.id;
    socket.emit('publicRooms:joined', {id:room.id, name:room.name});
    khdSendPublicRooms();
  });
  socket.on('disconnect', () => {
    const id = socket.data.khdPublicRoom;
    if (id && khdPublicRooms.has(id)) {
      const room = khdPublicRooms.get(id);
      room.players.delete(socket.id);
      if (!room.players.size) khdPublicRooms.delete(id);
      khdSendPublicRooms();
    }
  });
  // KHD_TEMP_TEST_BOTS: vaqtinchalik test botlari
  socket.on('test:bots', ({count} = {}) => {
    const n = Math.max(1, Math.min(5, Number(count) || 5));
    socket.emit('test:bots:notice', {
      ok: false,
      message: 'Botlarni xona tizimiga ulash uchun mavjud xona va player tuzilmasi kerak.'
    });
  });

  socket.on('rooms:list', () => {
    socket.emit('rooms:list:update', [...rooms.values()].map(r => ({
      code: r.code, count: r.players.length, max: 10, phase: r.phase
    })));
  });

  socket.on('room:create', data => {
    const name = String(data?.name || 'Mehmon').trim().slice(0, 24) || 'Mehmon';
    let code;
    do {
      code = String(Math.floor(1000 + Math.random() * 9000));
    } while (rooms.has(code));

    const r = {
      code, host: socket.id, players: [], phase: 'lobby',
      round: 1, roles: {}, votes: {}, nightActions: {}
    };
    rooms.set(code, r);
    joinRoom(socket, r, name, data?.photoUrl);
  });

  socket.on('room:join', data => {
    const code = String(data?.code || '').trim();
    const r = rooms.get(code);

    if (!r) return notice(socket, 'Bunday xona topilmadi.');
    if (r.phase !== 'lobby') return notice(socket, 'O‘yin boshlangan.');
    if (r.players.length >= 10) return notice(socket, 'Xona to‘la.');
    if (r.players.some(p => p.id === socket.id)) return;

    const name = String(data?.name || 'Mehmon').trim().slice(0, 24) || 'Mehmon';
    joinRoom(socket, r, name, data?.photoUrl);
  });

  function joinRoom(s, r, name, photoUrl) {
    if (r.players.length >= 10) return;
    s.join(r.code);
    s.data.roomCode = r.code;
    const safePhoto = typeof photoUrl === 'string' &&
      /^https:\/\/[^\s"'<>]+$/i.test(photoUrl) ? photoUrl : '';
    r.players.push({ id: s.id, name, photoUrl: safePhoto, ready: false, alive: true });
    s.emit('room:joined', { code: r.code });
    sendRoom(r);
  }

  socket.on('player:ready', () => {
    const r = rooms.get(socket.data.roomCode);
    if (!r || r.host !== socket.id) {
      return notice(socket, 'Faqat xona egasi boshlaydi.');
    }
    if (r.phase !== 'lobby') return;
    if (r.players.length < 5) {
      return notice(socket, 'Boshlash uchun kamida 5 o‘yinchi kerak.');
    }

    const shuffled = [...r.players].sort(() => Math.random() - 0.5);
    const mafiaCount = Math.max(1, Math.floor(r.players.length / 4));
    r.roles = {};
    shuffled.forEach((p, i) => {
      r.roles[p.id] = i < mafiaCount ? 'mafia'
        : i === mafiaCount ? 'doctor'
        : i === mafiaCount + 1 ? 'detective'
        : 'citizen';
    });

    r.players.forEach(p => {
      p.alive = true;
      io.to(p.id).emit('game:role', {
        role: r.roles[p.id], round: 1
      });
    });

    r.phase = 'night';
    r.round = 1;
    r.votes = {};
    r.nightActions = {};
    io.to(r.code).emit('game:phase', { phase: r.phase, round: r.round });
    sendRoom(r);
  });

  socket.on('game:action', data => {
    const r = rooms.get(socket.data.roomCode);
    const player = r?.players.find(p => p.id === socket.id && p.alive);
    if (!r || r.phase !== 'night' || !player) return;

    const role = r.roles[socket.id];
    if (!['mafia', 'doctor', 'detective'].includes(role)) {
      return notice(socket, 'Sizda tungi harakat yo‘q.');
    }

    const target = r.players.find(p => p.id === data?.targetId && p.alive);
    if (!target) return notice(socket, 'O‘yinchi topilmadi yoki tirik emas.');
    if (target.id === socket.id) {
      return notice(socket, 'O‘zingizni tanlay olmaysiz.');
    }

    if (role === 'detective') {
      socket.emit('game:investigation', {
        target: target.name,
        role: r.roles[target.id] === 'mafia' ? 'mafia' : 'not-mafia'
      });
      r.nightActions[socket.id] = target.id;
    } else {
      // Har bir rol bir kechada faqat bitta marta tanlov qiladi.
      if (r.nightActions[socket.id]) {
        return notice(socket, 'Bu kecha harakatingizni tanlab bo‘lgansiz.');
      }
      r.nightActions[socket.id] = target.id;
      if (role === 'mafia') r.votes.kill = target.id;
      if (role === 'doctor') r.votes.save = target.id;
    }

    notice(socket, 'Harakat qabul qilindi.');
  });

  socket.on('game:day', () => {
    const r = rooms.get(socket.data.roomCode);
    if (!r || r.host !== socket.id || r.phase !== 'night') return;

    const killId = r.votes.kill;
    const saveId = r.votes.save;
    if (killId && killId !== saveId) {
      const victim = r.players.find(p => p.id === killId && p.alive);
      if (victim) victim.alive = false;
    }

    r.votes = {};
    r.nightActions = {};

    if (endGame(r)) return;

    r.phase = 'day';
    io.to(r.code).emit('game:result', {
      players: r.players.map(p => ({
        id: p.id, name: p.name, alive: p.alive
      }))
    });
    io.to(r.code).emit('game:phase', { phase: 'day', round: r.round });
    sendRoom(r);
  });

  socket.on('game:vote', data => {
    const r = rooms.get(socket.data.roomCode);
    const voter = r?.players.find(p => p.id === socket.id && p.alive);
    if (!r || r.phase !== 'day' || !voter) return;

    const target = r.players.find(p => p.id === data?.targetId && p.alive);
    if (!target) return notice(socket, 'Bu o‘yinchi endi ovoz bera olmaydi.');
    if (r.votes[socket.id]) return notice(socket, 'Siz ovoz berib bo‘lgansiz.');

    r.votes[socket.id] = target.id;
    const alive = r.players.filter(p => p.alive);

    if (alive.every(p => r.votes[p.id])) {
      const counts = {};
      alive.forEach(p => {
        const id = r.votes[p.id];
        counts[id] = (counts[id] || 0) + 1;
      });

      const max = Math.max(...Object.values(counts));
      const leaders = Object.keys(counts).filter(id => counts[id] === max);
      let eliminated = null;

      if (leaders.length === 1) {
        eliminated = r.players.find(p => p.id === leaders[0]);
        if (eliminated) eliminated.alive = false;
      }

      const resultPlayers = r.players.map(p => ({
        id: p.id, name: p.name, alive: p.alive,
        role: r.roles[p.id]
      }));

      if (endGame(r)) return;

      r.phase = 'night';
      r.round++;
      r.votes = {};
      r.nightActions = {};

      io.to(r.code).emit('game:result', {
        players: resultPlayers,
        eliminated: eliminated ? eliminated.id : null,
        tie: leaders.length !== 1
      });
      io.to(r.code).emit('game:phase', { phase: r.phase, round: r.round });
    }

    sendRoom(r);
  });

  socket.on('chat:send', text => {
    const r = rooms.get(socket.data.roomCode);
    if (!r) return;
    const msg = String(text || '').trim().slice(0, 300);
    if (!msg) return;

    const player = r.players.find(p => p.id === socket.id);
    if (!player) return;

    io.to(r.code).emit('chat:message', {
      name: player.name, text: msg
    });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const r = rooms.get(code);
    if (!r) return;

    r.players = r.players.filter(p => p.id !== socket.id);
    delete r.roles[socket.id];
    delete r.votes[socket.id];
    delete r.nightActions[socket.id];
    finishRoom(r);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`KH.D MAFIA: http://localhost:${PORT}`);
});
