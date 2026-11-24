const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 3e6 // Allow up to ~3MB for optional custom avatar images
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// ============================================================================
// 1. GAME CONSTANTS (12 SECRET IDENTITIES + NIGHT EVENTS)
// ============================================================================
const ROLE_ORDER_LIST = [
  'werewolf', 'wolfcub',
  'defender', 'seer', 'witch', 'hunter', 'cupid', 'spellcaster', 'revealer', 'huntress', 'villager',
  'tanner'
];

const NIGHT_STEPS_ORDER = ['cupid', 'wolfpack', 'defender', 'seer', 'witch', 'spellcaster', 'revealer', 'huntress'];

const NIGHT_EVENTS = [
  { id: 'full_moon', icon: '🌕', name: 'คืนจันทร์เต็มดวง (Full Moon)', desc: 'ค่ำคืนปกติ ไม่มีผลพิเศษ ทุกคนใช้พลังได้ตามกติกา' },
  { id: 'thick_fog', icon: '🌫️', name: 'หมอกลงจัด (Thick Fog)', desc: 'หมอกหนาทึบบดบังสายตา — คืนนี้การหยั่งรู้ของ Seer จะมองไม่เห็นฝ่ายของเป้าหมาย' },
  { id: 'blood_moon', icon: '🩸', name: 'คืนพระจันทร์สีเลือด (Blood Moon)', desc: 'บรรยากาศกดดันเข้มข้น — เพิ่มเวลาทำแอคชั่นกลางคืนอีก +10 วินาที' },
  { id: 'silent_night', icon: '🤫', name: 'คืนแห่งความเงียบงัน (Silent Night)', desc: 'เวลาพูดคุยกลางวันพรุ่งนี้จะถูกบีบเหลือ 30 วินาที ต้องรีบตัดสินใจ!' },
  { id: 'moon_blessing', icon: '✨', name: 'พรแห่งแสงจันทร์ (Moonlight Blessing)', desc: 'หากคืนนี้ไม่มีใครเสียชีวิต วันพรุ่งนี้หมู่บ้านจะได้เวลาพูดคุยเพิ่ม +20 วินาที' }
];

const BOT_NAMES = [
  'Third', 'มายด์', 'บีม', 'เจมส์', 'แพรว', 'ก้อง', 'น้ำหวาน', 'เต้',
  'ฟ้าใส', 'ปอนด์', 'มิ้นท์', 'นัท', 'ออม', 'เบสท์', 'พลอย', 'คิม', 'ไทเกอร์', 'เฟิร์น'
];

const AVATAR_GALLERY = [
  '🐺', '🦊', '🦉', '🦝', '🦌', '🐈‍⬛',
  '🐻', '🦇', '🕊️', '🐇', '🦁', '🐼',
  '🐯', '🐸', '🐙', '🦋', '🦅', '🦄'
];

const rooms = new Map(); // roomCode -> Room Object

// ============================================================================
// 2. HELPERS
// ============================================================================
function genRoomCode() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(code));
  return code;
}

function uid(prefix = 'p') {
  return prefix + '_' + crypto.randomBytes(5).toString('hex');
}

function isWolfRole(roleId) {
  return roleId === 'werewolf' || roleId === 'wolfcub';
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function getDeckTotal(deck) {
  return Object.values(deck).reduce((a, b) => a + b, 0);
}

function getAlivePlayers(room) {
  return room.players.filter(p => p.alive);
}

function createRoomObject(roomCode, hostPlayer) {
  return {
    roomCode,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    view: 'lobby', // 'lobby' | 'game'
    players: [hostPlayer],
    tvSockets: new Set(),
    deck: {
      werewolf: 1,
      wolfcub: 0,
      defender: 1,
      seer: 1,
      witch: 0,
      hunter: 1,
      cupid: 0,
      spellcaster: 0,
      revealer: 0,
      huntress: 0,
      tanner: 0,
      villager: 2
    },
    timers: {
      roleReveal: 10,
      nightAction: 30,
      dayDiscussion: 60,
      voting: 20,
      defenseTrial: 20,
      secondChance: 10,
      antiMetaFixedNight: false,
      voiceNarrator: true,
      enableNightEvents: true
    },
    interval: null,
    game: createIdleGameState()
  };
}

function createIdleGameState() {
  return {
    phase: 'idle',
    round: 1,
    timerRemaining: 0,
    timerTotal: 1,
    paused: false,
    lovers: [],
    wolfCubRageRound: 0,
    silencedPlayerId: null,
    currentNightEvent: null,
    ghostGuesses: {},
    nightQueue: [],
    nightStepIndex: 0,
    currentNightStep: null,
    nightActions: {
      cupidPicks: [],
      wolfTargets: [],
      defenderTargetId: null,
      seerTargetId: null,
      seerResult: null,
      witchHealUsed: false,
      witchPoisonUsed: false,
      witchHealedId: null,
      witchPoisonTargetId: null,
      spellcasterTargetId: null,
      revealerTargetId: null,
      huntressTargetId: null,
      submittedBy: {}
    },
    dawnDeaths: [],
    dawnSteps: [],
    votes: {},
    accusedId: null,
    trialVotes: {},
    secondChanceVotes: {},
    hunterQueue: [],
    hunterReturnPhase: 'day',
    winner: null,
    logs: []
  };
}

function addLog(room, phaseIcon, text) {
  room.game.logs.unshift({ round: room.game.round, phaseIcon, text });
  if (room.game.logs.length > 80) room.game.logs.pop();
}

// ============================================================================
// 3. STRICT PERSONALIZED STATE PROJECTION (ZERO LEAKS / ANTI-CHEAT)
// ============================================================================
function buildPersonalizedState(room, viewerId, isTv = false) {
  const g = room.game;
  const isOver = g.phase === 'gameover';
  const viewer = isTv ? null : room.players.find(p => p.id === viewerId) || null;
  const viewerIsWolf = viewer && isWolfRole(viewer.role);

  // Public player list: NEVER expose other players' roles until gameover!
  const sanitizedPlayers = room.players.map(p => {
    const canSeeRole = isOver || (viewer && p.id === viewer.id);
    return {
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      customAvatarUrl: p.customAvatarUrl || '',
      isHost: p.isHost,
      isBot: p.isBot,
      connected: p.isBot ? true : Boolean(p.socketId),
      alive: p.alive,
      role: canSeeRole ? p.role : null,
      isLover: isOver
        ? g.lovers.includes(p.id)
        : Boolean(viewer && g.lovers.includes(viewer.id) && g.lovers.includes(p.id)),
      isPackMate: !isOver && viewerIsWolf && isWolfRole(p.role) && p.id !== viewer.id
    };
  });

  // Private night payload ONLY for the currently active role on this phone
  let privateNight = null;
  if (!isTv && viewer && viewer.alive && g.phase === 'night') {
    const step = g.currentNightStep;
    const isMyTurn = step === 'wolfpack' ? isWolfRole(viewer.role) : viewer.role === step;
    if (isMyTurn) {
      privateNight = {
        step,
        submitted: Boolean(g.nightActions.submittedBy[viewer.id])
      };
      if (step === 'cupid') {
        privateNight.cupidPicks = g.nightActions.cupidPicks;
      } else if (step === 'wolfpack') {
        privateNight.wolfTargets = g.nightActions.wolfTargets;
        privateNight.maxKills = g.wolfCubRageRound === g.round ? 2 : 1;
      } else if (step === 'defender') {
        privateNight.protectedLastNight = viewer.protectedLastNight;
      } else if (step === 'seer') {
        privateNight.seerResult = g.nightActions.seerResult;
      } else if (step === 'witch') {
        privateNight.wolfVictims = g.nightActions.wolfTargets;
        privateNight.witchHealUsed = g.nightActions.witchHealUsed;
        privateNight.witchPoisonUsed = g.nightActions.witchPoisonUsed;
      } else if (step === 'huntress') {
        privateNight.huntressUsed = viewer.huntressUsed;
      }
    }
  }

  return {
    roomCode: room.roomCode,
    view: room.view,
    isTv,
    myPlayerId: viewer ? viewer.id : null,
    players: sanitizedPlayers,
    deck: room.deck,
    timers: room.timers,
    game: {
      phase: g.phase,
      round: g.round,
      timerRemaining: g.timerRemaining,
      timerTotal: g.timerTotal,
      paused: g.paused,
      silencedPlayerId: g.silencedPlayerId,
      currentNightEvent: g.currentNightEvent,
      nightStepIndex: g.nightStepIndex,
      nightQueueLength: g.nightQueue.length,
      privateNight,
      dawnSteps: g.dawnSteps,
      votes: g.votes,
      accusedId: g.accusedId,
      trialVotes: g.trialVotes,
      secondChanceVotes: g.secondChanceVotes,
      activeHunterId: g.hunterQueue[0] || null,
      myGhostGuess: viewer ? g.ghostGuesses[viewer.id] || null : null,
      ghostGuesses: isOver ? g.ghostGuesses : null,
      winner: g.winner,
      logs: g.logs
    }
  };
}

function broadcastRoom(room) {
  room.lastActivity = Date.now();
  room.players.forEach(p => {
    if (p.socketId) {
      io.to(p.socketId).emit('room:state', buildPersonalizedState(room, p.id, false));
    }
  });
  room.tvSockets.forEach(sid => {
    io.to(sid).emit('room:state', buildPersonalizedState(room, null, true));
  });
}

function broadcastAudioCue(room, cue, speakText = '') {
  const payload = { cue, speakText };
  room.players.forEach(p => {
    if (p.socketId) io.to(p.socketId).emit('room:audio', payload);
  });
  room.tvSockets.forEach(sid => {
    io.to(sid).emit('room:audio', payload);
  });
}

// ============================================================================
// 4. SERVER-SIDE AUTOMATIC MODERATOR ENGINE
// ============================================================================
function stopRoomTimer(room) {
  if (room.interval) {
    clearInterval(room.interval);
    room.interval = null;
  }
}

function startRoomCountdown(room, seconds, onComplete) {
  stopRoomTimer(room);
  room.game.timerTotal = Math.max(1, seconds);
  room.game.timerRemaining = Math.max(1, seconds);
  room.game.paused = false;
  broadcastRoom(room);

  room.interval = setInterval(() => {
    if (room.game.paused || room.view !== 'game') return;
    room.game.timerRemaining -= 1;
    // Emit lightweight timer tick to all clients
    const tick = { remaining: room.game.timerRemaining, total: room.game.timerTotal, paused: room.game.paused };
    room.players.forEach(p => { if (p.socketId) io.to(p.socketId).emit('room:tick', tick); });
    room.tvSockets.forEach(sid => io.to(sid).emit('room:tick', tick));

    if (room.game.timerRemaining <= 0) {
      stopRoomTimer(room);
      onComplete();
    }
  }, 1000);
}

function validateStart(room) {
  const pCount = room.players.length;
  const dCount = getDeckTotal(room.deck);
  if (pCount < 6) return `ต้องมีผู้เล่นอย่างน้อย 6 คน (ตอนนี้ ${pCount} คน)`;
  if (pCount > 18) return `รองรับผู้เล่นสูงสุด 18 คน (ตอนนี้ ${pCount} คน)`;
  if (dCount !== pCount) return `จำนวนการ์ด (${dCount} ใบ) ต้องเท่ากับจำนวนผู้เล่น (${pCount} คน)`;
  const darkCount = (room.deck.werewolf || 0) + (room.deck.wolfcub || 0);
  if (darkCount < 1) return 'ต้องมีฝ่ายมืด (Werewolf หรือ Wolf Cub) อย่างน้อย 1 ใบ';
  if (darkCount >= Math.ceil(pCount / 2)) return 'ฝ่ายหมาป่ามากเกินไป ควรน้อยกว่าครึ่งหนึ่งของผู้เล่น';
  return null;
}

function startGameOnServer(room) {
  const err = validateStart(room);
  if (err) return err;

  const cards = [];
  for (const [roleId, count] of Object.entries(room.deck)) {
    for (let i = 0; i < count; i++) cards.push(roleId);
  }
  const shuffled = shuffle(cards);

  room.players.forEach((p, idx) => {
    p.role = shuffled[idx];
    p.alive = true;
    p.protectedLastNight = null;
    p.seerHistory = [];
    p.huntressUsed = false;
  });

  room.view = 'game';
  room.game = createIdleGameState();
  room.game.phase = 'role_reveal';
  addLog(room, '👁️', `เฟสที่ 1: ระบบ Auto-Moderator แจกบทบาทลับให้ผู้เล่น ${room.players.length} คนเรียบร้อย (Host ร่วมเล่นด้วย)`);
  broadcastAudioCue(room, 'night', `เปิดดูบทบาทลับของตนเอง มีเวลา ${room.timers.roleReveal} วินาที`);

  startRoomCountdown(room, room.timers.roleReveal, () => {
    beginNightPhase(room);
  });
  return null;
}

function getStepActors(room, stepId) {
  if (stepId === 'wolfpack') return room.players.filter(p => p.alive && isWolfRole(p.role));
  return room.players.filter(p => p.alive && p.role === stepId);
}

function beginNightPhase(room) {
  stopRoomTimer(room);
  const g = room.game;

  const queue = NIGHT_STEPS_ORDER.filter(stepId => {
    if (stepId === 'cupid') {
      if (g.round > 1 || (room.deck.cupid || 0) === 0) return false;
      return room.timers.antiMetaFixedNight || room.players.some(p => p.alive && p.role === 'cupid');
    }
    if (stepId === 'wolfpack') {
      return room.players.some(p => p.alive && isWolfRole(p.role));
    }
    if ((room.deck[stepId] || 0) === 0) return false;
    if (!room.timers.antiMetaFixedNight) {
      return room.players.some(p => p.alive && p.role === stepId);
    }
    return true;
  });

  g.phase = 'night';
  g.nightQueue = queue;
  g.nightStepIndex = 0;
  g.silencedPlayerId = null;
  g.nightActions.cupidPicks = [];
  g.nightActions.wolfTargets = [];
  g.nightActions.defenderTargetId = null;
  g.nightActions.seerTargetId = null;
  g.nightActions.seerResult = null;
  g.nightActions.witchHealedId = null;
  g.nightActions.witchPoisonTargetId = null;
  g.nightActions.spellcasterTargetId = null;
  g.nightActions.revealerTargetId = null;
  g.nightActions.huntressTargetId = null;
  g.nightActions.submittedBy = {};

  if (room.timers.enableNightEvents) {
    const pool = g.round === 1 ? NIGHT_EVENTS.filter(e => e.id !== 'silent_night') : NIGHT_EVENTS;
    g.currentNightEvent = pool[Math.floor(Math.random() * pool.length)];
  } else {
    g.currentNightEvent = null;
  }

  broadcastAudioCue(room, 'night', `เข้าสู่คืนที่ ${g.round} ทุกคนหลับตา`);
  runCurrentNightStep(room);
}

function runCurrentNightStep(room) {
  stopRoomTimer(room);
  const g = room.game;
  if (g.nightStepIndex >= g.nightQueue.length) {
    resolveNightToDawn(room);
    return;
  }

  const stepId = g.nightQueue[g.nightStepIndex];
  g.currentNightStep = stepId;
  g.nightActions.submittedBy = {};

  runBotNightActions(room, stepId);

  const aliveHumanActors = getStepActors(room, stepId).filter(p => !p.isBot);
  const bonusSec = g.currentNightEvent?.id === 'blood_moon' ? 10 : 0;
  let stepSeconds = room.timers.nightAction + bonusSec;
  if (aliveHumanActors.length === 0 && !room.timers.antiMetaFixedNight) {
    stepSeconds = Math.min(stepSeconds, 3);
  }

  startRoomCountdown(room, stepSeconds, () => finalizeNightStep(room, stepId));
}

function runBotNightActions(room, stepId) {
  const g = room.game;
  const actors = getStepActors(room, stepId).filter(p => p.isBot);
  if (actors.length === 0) return;
  const alive = getAlivePlayers(room);

  actors.forEach(bot => {
    if (stepId === 'cupid') {
      const sh = shuffle(alive);
      if (sh.length >= 2) g.nightActions.cupidPicks = [sh[0].id, sh[1].id];
    } else if (stepId === 'wolfpack') {
      const maxKills = g.wolfCubRageRound === g.round ? 2 : 1;
      const nonWolves = shuffle(alive.filter(p => !isWolfRole(p.role)));
      for (const t of nonWolves) {
        if (g.nightActions.wolfTargets.length >= maxKills) break;
        if (!g.nightActions.wolfTargets.includes(t.id)) g.nightActions.wolfTargets.push(t.id);
      }
    } else if (stepId === 'defender') {
      const cands = alive.filter(p => p.id !== bot.protectedLastNight);
      if (cands.length > 0) g.nightActions.defenderTargetId = cands[Math.floor(Math.random() * cands.length)].id;
    } else if (stepId === 'seer') {
      const others = alive.filter(p => p.id !== bot.id);
      if (others.length > 0) {
        const pick = others[Math.floor(Math.random() * others.length)];
        if (g.currentNightEvent?.id !== 'thick_fog') {
          bot.seerHistory.push({ targetId: pick.id, isDark: isWolfRole(pick.role), round: g.round });
        }
      }
    } else if (stepId === 'witch') {
      const firstVictim = g.nightActions.wolfTargets[0] || null;
      if (!g.nightActions.witchHealUsed && firstVictim && Math.random() < 0.6) {
        g.nightActions.witchHealedId = firstVictim;
        g.nightActions.witchHealUsed = true;
      } else if (!g.nightActions.witchPoisonUsed && g.round >= 2 && Math.random() < 0.4) {
        const targets = alive.filter(p => p.id !== bot.id && !g.nightActions.wolfTargets.includes(p.id));
        if (targets.length > 0) {
          g.nightActions.witchPoisonTargetId = targets[Math.floor(Math.random() * targets.length)].id;
          g.nightActions.witchPoisonUsed = true;
        }
      }
    } else if (stepId === 'spellcaster') {
      const others = alive.filter(p => p.id !== bot.id);
      if (others.length > 0) g.nightActions.spellcasterTargetId = others[Math.floor(Math.random() * others.length)].id;
    } else if (stepId === 'revealer') {
      if (Math.random() < 0.4) {
        const others = alive.filter(p => p.id !== bot.id);
        if (others.length > 0) g.nightActions.revealerTargetId = others[Math.floor(Math.random() * others.length)].id;
      }
    } else if (stepId === 'huntress') {
      if (!bot.huntressUsed && g.round >= 2 && Math.random() < 0.45) {
        const others = alive.filter(p => p.id !== bot.id);
        if (others.length > 0) {
          g.nightActions.huntressTargetId = others[Math.floor(Math.random() * others.length)].id;
          bot.huntressUsed = true;
        }
      }
    }
    g.nightActions.submittedBy[bot.id] = true;
  });
}

function finalizeNightStep(room, stepId) {
  stopRoomTimer(room);
  const g = room.game;
  if (stepId === 'cupid' && g.nightActions.cupidPicks.length === 2) {
    g.lovers = [...g.nightActions.cupidPicks];
  }
  if (stepId === 'defender') {
    const def = room.players.find(p => p.alive && p.role === 'defender');
    if (def) def.protectedLastNight = g.nightActions.defenderTargetId;
  }
  g.nightStepIndex += 1;
  runCurrentNightStep(room);
}

function applyDeathWithSideEffects(room, playerId, cause, deathsCollector, fallenHuntersCollector) {
  const p = room.players.find(x => x.id === playerId);
  if (!p || !p.alive) return;
  p.alive = false;
  deathsCollector.push({ playerId: p.id, cause });

  if (p.role === 'hunter') fallenHuntersCollector.push(p.id);
  if (p.role === 'wolfcub') room.game.wolfCubRageRound = room.game.round + 1;

  if (room.game.lovers.includes(p.id)) {
    const partnerId = room.game.lovers.find(id => id !== p.id);
    const partner = room.players.find(x => x.id === partnerId);
    if (partner && partner.alive) {
      applyDeathWithSideEffects(room, partner.id, `💘 ตรอมใจตายตามคู่รัก (${p.name})`, deathsCollector, fallenHuntersCollector);
    }
  }
}

function resolveNightToDawn(room) {
  stopRoomTimer(room);
  const g = room.game;
  const na = g.nightActions;
  const deaths = [];
  const fallenHunters = [];

  na.wolfTargets.forEach(targetId => {
    const saved = na.defenderTargetId === targetId || na.witchHealedId === targetId;
    if (!saved) applyDeathWithSideEffects(room, targetId, '🐺 ถูกฝูงหมาป่าสังหารในความมืด', deaths, fallenHunters);
  });

  if (na.witchPoisonTargetId) {
    applyDeathWithSideEffects(room, na.witchPoisonTargetId, '🧪 เสียชีวิตจากน้ำยาพิษของแม่มด', deaths, fallenHunters);
  }

  if (na.revealerTargetId) {
    const revPlayer = room.players.find(p => p.alive && p.role === 'revealer');
    const target = room.players.find(p => p.id === na.revealerTargetId);
    if (target && revPlayer) {
      if (isWolfRole(target.role)) {
        applyDeathWithSideEffects(room, target.id, '🌙 เสียชีวิตอย่างปริศนาในความมืด', deaths, fallenHunters);
      } else {
        applyDeathWithSideEffects(room, revPlayer.id, '🌙 เสียชีวิตอย่างปริศนาในความมืด', deaths, fallenHunters);
      }
    }
  }

  if (na.huntressTargetId) {
    applyDeathWithSideEffects(room, na.huntressTargetId, '🌙 เสียชีวิตอย่างปริศนาในความมืด', deaths, fallenHunters);
  }

  let silencedPlayer = null;
  if (na.spellcasterTargetId) {
    const target = room.players.find(p => p.id === na.spellcasterTargetId && p.alive);
    if (target) {
      g.silencedPlayerId = target.id;
      silencedPlayer = target;
      addLog(room, '🤐', `จอมเวทใบ้ร่ายเวทปิดปาก ${target.name} — ห้ามพูดในเฟสกลางวันนี้!`);
    }
  }

  const steps = [
    {
      icon: '🌫️',
      title: `หมอกยามเช้าค่อยๆ จางลง... (เช้าวันที่ ${g.round})`,
      subtitle: 'ทุกคนลืมตาขึ้นเพื่อรับฟังเหตุการณ์ที่เกิดขึ้นเมื่อคืนที่ผ่านมา',
      tone: 'mist'
    }
  ];

  if (g.currentNightEvent) {
    const ev = g.currentNightEvent;
    steps.push({
      icon: ev.icon,
      title: `เหตุการณ์ประจำคืน: ${ev.name}`,
      subtitle: ev.desc,
      tone: ev.id === 'blood_moon' ? 'rage' : 'curse'
    });
    addLog(room, ev.icon, `เหตุการณ์คืนที่ ${g.round}: ${ev.name}`);
  }

  if (deaths.length === 0) {
    steps.push({
      icon: '🕊️',
      title: 'คืนที่ผ่านมาสงบสุข — ไม่มีผู้เสียชีวิต',
      subtitle: 'หมู่บ้านรอดพ้นจากความมืดไปได้อีกหนึ่งคืน',
      tone: 'safe'
    });
    addLog(room, '🌅', `เช้าวันที่ ${g.round}: คืนนี้สงบสุข ไม่มีผู้เสียชีวิต`);
    broadcastAudioCue(room, 'dawn', `รุ่งเช้าวันที่ ${g.round} ทุกคนลืมตาได้ เมื่อคืนไม่มีใครเสียชีวิต`);
  } else {
    deaths.forEach(d => {
      const p = room.players.find(x => x.id === d.playerId);
      if (p) {
        steps.push({
          icon: '🩸',
          title: `${p.name} เสียชีวิตเมื่อคืนที่ผ่านมา`,
          subtitle: `${d.cause} • 🔒 บทบาทถูกเก็บเป็นความลับจนจบเกม`,
          tone: 'death',
          playerId: p.id
        });
      }
    });
    const names = deaths.map(d => room.players.find(p => p.id === d.playerId)?.name).filter(Boolean).join(', ');
    addLog(room, '🌅', `เช้าวันที่ ${g.round}: พบผู้เสียชีวิต — ${names} (ปิดบังบทบาทจนจบเกม)`);
    broadcastAudioCue(room, 'death', `รุ่งเช้าวันที่ ${g.round} ทุกคนลืมตาได้ เมื่อคืน ${names} เสียชีวิต`);
  }

  if (silencedPlayer) {
    steps.push({
      icon: '🤐',
      title: `${silencedPlayer.name} ถูกมนต์สะกดปิดปาก`,
      subtitle: 'ห้ามพูดหรือออกเสียงใดๆ ตลอดช่วงพูดคุยกลางวันนี้',
      tone: 'curse'
    });
  }

  if (g.wolfCubRageRound === g.round + 1) {
    steps.push({
      icon: '🐾',
      title: 'เสียงหอนก้องป่าอย่างดุร้ายผิดปกติ...',
      subtitle: 'ลางสังหรณ์บอกว่าคืนถัดไปฝูงหมาป่าจะล่าเหยื่อหนักกว่าเดิม!',
      tone: 'rage'
    });
  }

  g.dawnDeaths = deaths;
  g.dawnSteps = steps;
  g.phase = 'dawn';
  if (fallenHunters.length > 0) {
    g.hunterQueue = fallenHunters;
    g.hunterReturnPhase = 'day';
  }
  broadcastRoom(room);
}

function proceedFromDawn(room) {
  if (room.game.hunterQueue.length > 0) {
    startHunterPhase(room);
    return;
  }
  if (checkWinConditions(room)) return;
  startDayDiscussion(room);
}

function startHunterPhase(room) {
  stopRoomTimer(room);
  const g = room.game;
  g.phase = 'hunter';
  const hunterId = g.hunterQueue[0];
  const hunter = room.players.find(p => p.id === hunterId);
  broadcastAudioCue(room, 'gavel', `นายพราน ${hunter?.name || ''} กำลังจะสิ้นใจ กรุณาเลือกยิงผู้เล่น 1 คน`);

  startRoomCountdown(room, 15, () => {
    const alive = getAlivePlayers(room);
    if (alive.length > 0) {
      executeHunterShot(room, hunterId, alive[Math.floor(Math.random() * alive.length)].id);
    } else {
      finishHunterQueue(room);
    }
  });

  if (hunter && hunter.isBot) {
    setTimeout(() => {
      if (room.game.phase === 'hunter' && room.game.hunterQueue[0] === hunterId) {
        const alive = getAlivePlayers(room);
        if (alive.length > 0) executeHunterShot(room, hunterId, alive[Math.floor(Math.random() * alive.length)].id);
      }
    }, 2000);
  }
}

function executeHunterShot(room, hunterId, targetId) {
  stopRoomTimer(room);
  const hunter = room.players.find(p => p.id === hunterId);
  const deaths = [];
  const extraHunters = [];
  applyDeathWithSideEffects(room, targetId, `🏹 ถูกนายพราน ${hunter?.name} ยิงตามไป`, deaths, extraHunters);

  deaths.forEach(d => {
    const p = room.players.find(x => x.id === d.playerId);
    if (p) addLog(room, '🏹', `${p.name} เสียชีวิต — ${d.cause} (ปิดบังบทบาทจนจบเกม)`);
  });
  broadcastAudioCue(room, 'death', '');

  room.game.hunterQueue.shift();
  room.game.hunterQueue.push(...extraHunters);
  finishHunterQueue(room);
}

function finishHunterQueue(room) {
  if (room.game.hunterQueue.length > 0) {
    startHunterPhase(room);
    return;
  }
  if (checkWinConditions(room)) return;
  if (room.game.hunterReturnPhase === 'day') {
    startDayDiscussion(room);
  } else {
    room.game.round += 1;
    beginNightPhase(room);
  }
}

function startDayDiscussion(room) {
  stopRoomTimer(room);
  const g = room.game;
  g.phase = 'day';
  g.votes = {};
  g.accusedId = null;

  let daySec = room.timers.dayDiscussion;
  if (g.currentNightEvent?.id === 'silent_night') daySec = Math.min(daySec, 30);
  else if (g.currentNightEvent?.id === 'moon_blessing' && g.dawnDeaths.length === 0) daySec += 20;

  broadcastAudioCue(room, 'dawn', `เริ่มช่วงพูดคุยกลางวัน ${daySec} วินาที`);
  startRoomCountdown(room, daySec, () => startVotingPhase(room));
}

function startVotingPhase(room) {
  stopRoomTimer(room);
  const g = room.game;
  g.phase = 'vote';
  g.votes = {};
  broadcastAudioCue(room, 'gavel', `เข้าสู่ช่วงโหวตเสนอชื่อผู้ต้องสงสัย ${room.timers.voting} วินาที`);

  startRoomCountdown(room, room.timers.voting, () => resolveNominationVote(room));

  // Bot nominations
  setTimeout(() => {
    if (room.game.phase !== 'vote') return;
    const alive = getAlivePlayers(room);
    alive.filter(p => p.isBot).forEach(bot => {
      if (g.votes[bot.id]) return;
      const pool = isWolfRole(bot.role)
        ? alive.filter(p => !isWolfRole(p.role))
        : alive.filter(p => p.id !== bot.id);
      g.votes[bot.id] = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)].id : 'skip';
    });
    broadcastRoom(room);
    checkAllNominated(room);
  }, 1500);
}

function checkAllNominated(room) {
  const alive = getAlivePlayers(room);
  if (alive.every(p => Boolean(room.game.votes[p.id])) && room.game.phase === 'vote') {
    setTimeout(() => {
      if (room.game.phase === 'vote') resolveNominationVote(room);
    }, 700);
  }
}

function resolveNominationVote(room) {
  stopRoomTimer(room);
  const g = room.game;
  const tally = {};
  Object.values(g.votes).forEach(t => { if (t && t !== 'skip') tally[t] = (tally[t] || 0) + 1; });
  const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0 || (sorted.length > 1 && sorted[0][1] === sorted[1][1])) {
    addLog(room, '🗳️', `วันที่ ${g.round}: คะแนนโหวตเท่ากันหรือไม่มีผู้ถูกเสนอชื่อ — ข้ามการประหาร`);
    g.round += 1;
    beginNightPhase(room);
    return;
  }

  g.accusedId = sorted[0][0];
  startDefensePhase(room);
}

function startDefensePhase(room) {
  stopRoomTimer(room);
  const g = room.game;
  g.phase = 'defense';
  g.trialVotes = {};
  const accused = room.players.find(p => p.id === g.accusedId);
  addLog(room, '⚔️', `${accused?.name} ถูกโหวตขึ้นแท่นแก้ต่าง!`);
  broadcastAudioCue(room, 'gavel', `${accused?.name || ''} ขึ้นแท่นแก้ต่าง มีเวลา ${room.timers.defenseTrial} วินาที`);

  startRoomCountdown(room, room.timers.defenseTrial, () => resolveDefenseTrial(room));

  setTimeout(() => {
    if (room.game.phase !== 'defense') return;
    const alive = getAlivePlayers(room).filter(p => p.id !== g.accusedId);
    alive.filter(p => p.isBot).forEach(bot => {
      if (g.trialVotes[bot.id]) return;
      g.trialVotes[bot.id] = Math.random() < 0.62 ? 'guilty' : 'innocent';
    });
    broadcastRoom(room);
  }, 1800);
}

function resolveDefenseTrial(room) {
  stopRoomTimer(room);
  const g = room.game;
  let guilty = 0, innocent = 0;
  Object.values(g.trialVotes).forEach(v => { if (v === 'guilty') guilty++; else if (v === 'innocent') innocent++; });
  const accused = room.players.find(p => p.id === g.accusedId);

  if (guilty > innocent) {
    startSecondChancePhase(room);
  } else {
    addLog(room, '🕊️', `${accused?.name} รอดพ้นจากคำตัดสิน (ประหาร ${guilty} vs ปล่อยตัว ${innocent})`);
    g.round += 1;
    beginNightPhase(room);
  }
}

function startSecondChancePhase(room) {
  stopRoomTimer(room);
  const g = room.game;
  g.phase = 'second_chance';
  g.secondChanceVotes = {};
  const accused = room.players.find(p => p.id === g.accusedId);
  broadcastAudioCue(room, 'gavel', `เข้าสู่ช่วงโอกาสครั้งที่สองของ ${accused?.name || ''} เวลา ${room.timers.secondChance} วินาที`);

  startRoomCountdown(room, room.timers.secondChance, () => resolveSecondChance(room));

  setTimeout(() => {
    if (room.game.phase !== 'second_chance') return;
    const alive = getAlivePlayers(room).filter(p => p.id !== g.accusedId);
    alive.filter(p => p.isBot).forEach(bot => {
      if (g.secondChanceVotes[bot.id]) return;
      g.secondChanceVotes[bot.id] = Math.random() < 0.72 ? 'execute' : 'spare';
    });
    broadcastRoom(room);
  }, 1500);
}

function resolveSecondChance(room) {
  stopRoomTimer(room);
  const g = room.game;
  let execute = 0, spare = 0;
  Object.values(g.secondChanceVotes).forEach(v => { if (v === 'execute') execute++; else if (v === 'spare') spare++; });

  const accused = room.players.find(p => p.id === g.accusedId);
  if (spare > execute) {
    addLog(room, '🛡️', `Second Chance สำเร็จ! หมู่บ้านเปลี่ยนใจไว้ชีวิต ${accused?.name}`);
    g.round += 1;
    beginNightPhase(room);
    return;
  }

  broadcastAudioCue(room, 'death', '');
  const deaths = [];
  const fallenHunters = [];
  applyDeathWithSideEffects(room, g.accusedId, '⚖️ ถูกหมู่บ้านลงมติประหาร', deaths, fallenHunters);

  deaths.forEach(d => {
    const p = room.players.find(x => x.id === d.playerId);
    if (p) addLog(room, '⚖️', `${p.name} ถูกหมู่บ้านลงมติประหาร (บทบาทถูกเก็บเป็นความลับจนจบเกม)`);
  });

  if (accused && accused.role === 'tanner') {
    triggerGameOver(room, {
      team: 'neutral',
      title: '😵 THE OUTSIDER WINS!',
      subtitle: `${accused.name} (คนอยากตาย) หลอกให้หมู่บ้านลงมติประหารตัวเองได้สำเร็จ!`
    });
    return;
  }

  if (fallenHunters.length > 0) {
    g.hunterQueue = fallenHunters;
    g.hunterReturnPhase = 'next_night';
    startHunterPhase(room);
    return;
  }

  if (checkWinConditions(room)) return;
  g.round += 1;
  beginNightPhase(room);
}

function checkWinConditions(room) {
  const alive = getAlivePlayers(room);
  const aliveDark = alive.filter(p => isWolfRole(p.role)).length;
  const aliveVillage = alive.length - aliveDark;

  if (aliveDark === 0) {
    triggerGameOver(room, {
      team: 'village',
      title: '🛡️ THE VILLAGE WINS!',
      subtitle: 'ฝ่ายชาวบ้านกำจัดหมาป่าทั้งหมดออกจากหมู่บ้านได้สำเร็จ'
    });
    return true;
  }
  if (aliveDark >= aliveVillage) {
    triggerGameOver(room, {
      team: 'dark',
      title: '🐺 THE DARK SIDE WINS!',
      subtitle: 'จำนวนฝ่ายหมาป่าเท่ากับหรือมากกว่าชาวบ้าน หมู่บ้านตกอยู่ในความมืดมิด'
    });
    return true;
  }
  return false;
}

function triggerGameOver(room, winner) {
  stopRoomTimer(room);
  room.game.phase = 'gameover';
  room.game.winner = winner;
  broadcastAudioCue(room, 'win', `จบเกมแล้ว ${winner.subtitle}`);
  broadcastRoom(room);
}

// ============================================================================
// 5. SOCKET.IO EVENT HANDLERS
// ============================================================================
io.on('connection', (socket) => {
  socket.data = { roomCode: null, playerId: null, isTv: false };

  // Create Room (Host plays too!)
  socket.on('room:create', ({ nickname, avatar, customAvatarUrl }, cb) => {
    const roomCode = genRoomCode();
    const playerId = uid('host');
    const sessionToken = uid('tok');
    const hostPlayer = {
      id: playerId,
      sessionToken,
      socketId: socket.id,
      name: String(nickname || 'Host').trim().slice(0, 16) || 'Host',
      avatar: avatar || '🐺',
      customAvatarUrl: typeof customAvatarUrl === 'string' && customAvatarUrl.length < 2500000 ? customAvatarUrl : '',
      isHost: true,
      isBot: false,
      role: null,
      alive: true,
      protectedLastNight: null,
      seerHistory: [],
      huntressUsed: false
    };
    const room = createRoomObject(roomCode, hostPlayer);
    rooms.set(roomCode, room);

    socket.data = { roomCode, playerId, isTv: false };
    cb?.({ ok: true, roomCode, playerId, sessionToken });
    broadcastRoom(room);
  });

  // Join Room by 6-digit Room Code
  socket.on('room:join', ({ roomCode, nickname, avatar, customAvatarUrl }, cb) => {
    const code = String(roomCode || '').replace(/\D/g, '').slice(0, 6);
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: `ไม่พบห้องรหัส ${code} กรุณาตรวจสอบเลขห้องอีกครั้ง` });
    if (room.view !== 'lobby') return cb?.({ ok: false, error: 'เกมในห้องนี้เริ่มไปแล้ว ไม่สามารถเข้ากลางคันได้' });
    if (room.players.length >= 18) return cb?.({ ok: false, error: 'ห้องเต็มแล้ว (สูงสุด 18 คน)' });

    const playerId = uid('usr');
    const sessionToken = uid('tok');
    const newPlayer = {
      id: playerId,
      sessionToken,
      socketId: socket.id,
      name: String(nickname || 'ผู้เล่น').trim().slice(0, 16) || 'ผู้เล่น',
      avatar: avatar || AVATAR_GALLERY[room.players.length % AVATAR_GALLERY.length],
      customAvatarUrl: typeof customAvatarUrl === 'string' && customAvatarUrl.length < 2500000 ? customAvatarUrl : '',
      isHost: false,
      isBot: false,
      role: null,
      alive: true,
      protectedLastNight: null,
      seerHistory: [],
      huntressUsed: false
    };
    room.players.push(newPlayer);

    socket.data = { roomCode: code, playerId, isTv: false };
    cb?.({ ok: true, roomCode: code, playerId, sessionToken });
    broadcastRoom(room);
  });

  // Auto-Reconnect on phone refresh / wake
  socket.on('room:reconnect', ({ roomCode, sessionToken }, cb) => {
    const room = rooms.get(String(roomCode || ''));
    if (!room) return cb?.({ ok: false });
    const player = room.players.find(p => p.sessionToken === sessionToken);
    if (!player) return cb?.({ ok: false });
    player.socketId = socket.id;
    socket.data = { roomCode: room.roomCode, playerId: player.id, isTv: false };
    cb?.({ ok: true, roomCode: room.roomCode, playerId: player.id });
    broadcastRoom(room);
  });

  // Join as Public TV / Center Table Display (Read-only, zero secrets)
  socket.on('table:join', ({ roomCode }, cb) => {
    const code = String(roomCode || '').replace(/\D/g, '').slice(0, 6);
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: `ไม่พบห้องรหัส ${code}` });
    room.tvSockets.add(socket.id);
    socket.data = { roomCode: code, playerId: null, isTv: true };
    cb?.({ ok: true, roomCode: code });
    broadcastRoom(room);
  });

  // Lobby Host Actions
  function getHostRoom() {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return null;
    const me = room.players.find(p => p.id === socket.data.playerId);
    return me && me.isHost ? room : null;
  }

  socket.on('lobby:updateDeck', (deck) => {
    const room = getHostRoom();
    if (!room || room.view !== 'lobby') return;
    ROLE_ORDER_LIST.forEach(r => {
      if (typeof deck[r] === 'number') room.deck[r] = Math.max(0, Math.min(12, Math.floor(deck[r])));
    });
    broadcastRoom(room);
  });

  socket.on('lobby:updateTimers', (timers) => {
    const room = getHostRoom();
    if (!room || room.view !== 'lobby') return;
    const clamp = (v, min, max, fallback) => Math.max(min, Math.min(max, Number(v) || fallback));
    room.timers.roleReveal = clamp(timers.roleReveal, 5, 60, 10);
    room.timers.nightAction = clamp(timers.nightAction, 10, 90, 30);
    room.timers.dayDiscussion = clamp(timers.dayDiscussion, 15, 600, 60);
    room.timers.voting = clamp(timers.voting, 10, 120, 20);
    room.timers.defenseTrial = clamp(timers.defenseTrial, 10, 120, 20);
    room.timers.secondChance = clamp(timers.secondChance, 5, 60, 10);
    room.timers.antiMetaFixedNight = Boolean(timers.antiMetaFixedNight);
    room.timers.voiceNarrator = Boolean(timers.voiceNarrator);
    room.timers.enableNightEvents = Boolean(timers.enableNightEvents);
    broadcastRoom(room);
  });

  socket.on('lobby:addBot', ({ fillToDeck } = {}) => {
    const room = getHostRoom();
    if (!room || room.view !== 'lobby') return;
    const target = fillToDeck ? Math.max(6, Math.min(18, getDeckTotal(room.deck))) : Math.min(18, room.players.length + 1);
    while (room.players.length < target) {
      const used = new Set(room.players.map(p => p.name));
      const name = BOT_NAMES.find(n => !used.has(n)) || `เพื่อน ${room.players.length + 1}`;
      room.players.push({
        id: uid('bot'),
        sessionToken: null,
        socketId: null,
        name,
        avatar: AVATAR_GALLERY[room.players.length % AVATAR_GALLERY.length],
        customAvatarUrl: '',
        isHost: false,
        isBot: true,
        role: null,
        alive: true,
        protectedLastNight: null,
        seerHistory: [],
        huntressUsed: false
      });
    }
    broadcastRoom(room);
  });

  socket.on('lobby:removePlayer', ({ targetId }) => {
    const room = getHostRoom();
    if (!room || room.view !== 'lobby') return;
    room.players = room.players.filter(p => p.id !== targetId || p.isHost);
    broadcastRoom(room);
  });

  socket.on('game:start', (_data, cb) => {
    const room = getHostRoom();
    if (!room || room.view !== 'lobby') return cb?.({ ok: false, error: 'เฉพาะ Host เท่านั้นที่เริ่มเกมได้' });
    const err = startGameOnServer(room);
    cb?.({ ok: !err, error: err });
  });

  socket.on('game:returnLobby', () => {
    const room = getHostRoom();
    if (!room) return;
    stopRoomTimer(room);
    room.view = 'lobby';
    room.game = createIdleGameState();
    room.players.forEach(p => {
      p.role = null;
      p.alive = true;
      p.protectedLastNight = null;
      p.seerHistory = [];
      p.huntressUsed = false;
    });
    broadcastRoom(room);
  });

  socket.on('game:togglePause', () => {
    const room = getHostRoom();
    if (!room || room.view !== 'game') return;
    room.game.paused = !room.game.paused;
    broadcastRoom(room);
  });

  socket.on('game:skipPhase', () => {
    const room = getHostRoom();
    if (!room || room.view !== 'game') return;
    const p = room.game.phase;
    if (p === 'role_reveal') beginNightPhase(room);
    else if (p === 'dawn') proceedFromDawn(room);
    else if (p === 'day') startVotingPhase(room);
    else if (p === 'vote') resolveNominationVote(room);
    else if (p === 'defense') resolveDefenseTrial(room);
    else if (p === 'second_chance') resolveSecondChance(room);
  });

  // Night Action from Player Phone
  socket.on('game:nightAction', ({ actionType, targetId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.game.phase !== 'night') return;
    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player || !player.alive) return;

    const g = room.game;
    const step = g.currentNightStep;

    if (step === 'cupid' && player.role === 'cupid') {
      if (actionType === 'target') {
        const picks = g.nightActions.cupidPicks;
        if (picks.includes(targetId)) g.nightActions.cupidPicks = picks.filter(id => id !== targetId);
        else if (picks.length < 2) picks.push(targetId);
        broadcastRoom(room);
        return;
      }
      if (actionType === 'confirm_cupid' && g.nightActions.cupidPicks.length === 2) {
        g.nightActions.submittedBy[player.id] = true;
      }
    } else if (step === 'wolfpack' && isWolfRole(player.role)) {
      const maxKills = g.wolfCubRageRound === g.round ? 2 : 1;
      if (actionType === 'toggle_wolf_target') {
        const list = g.nightActions.wolfTargets;
        if (list.includes(targetId)) g.nightActions.wolfTargets = list.filter(id => id !== targetId);
        else { if (list.length >= maxKills) list.shift(); list.push(targetId); }
        broadcastRoom(room);
        return;
      }
      if (actionType === 'confirm_wolf' && g.nightActions.wolfTargets.length > 0) {
        g.nightActions.submittedBy[player.id] = true;
      }
    } else if (step === 'defender' && player.role === 'defender') {
      if (targetId === player.protectedLastNight) return;
      g.nightActions.defenderTargetId = targetId;
      g.nightActions.submittedBy[player.id] = true;
    } else if (step === 'seer' && player.role === 'seer') {
      if (g.nightActions.submittedBy[player.id]) return;
      const target = room.players.find(p => p.id === targetId);
      if (!target) return;
      const fogged = g.currentNightEvent?.id === 'thick_fog';
      const isDark = isWolfRole(target.role);
      g.nightActions.seerTargetId = targetId;
      g.nightActions.seerResult = { targetId, isDark, fogged };
      g.nightActions.submittedBy[player.id] = true;
      if (!room.timers.antiMetaFixedNight) g.timerRemaining = Math.min(g.timerRemaining, 4);
      broadcastRoom(room);
      return;
    } else if (step === 'witch' && player.role === 'witch') {
      if (actionType === 'heal' && !g.nightActions.witchHealUsed && targetId) {
        g.nightActions.witchHealedId = targetId;
        g.nightActions.witchHealUsed = true;
        broadcastRoom(room);
        return;
      }
      if (actionType === 'poison' && !g.nightActions.witchPoisonUsed && targetId) {
        g.nightActions.witchPoisonTargetId = targetId;
        g.nightActions.witchPoisonUsed = true;
        broadcastRoom(room);
        return;
      }
      if (actionType === 'done') g.nightActions.submittedBy[player.id] = true;
    } else if (step === 'spellcaster' && player.role === 'spellcaster') {
      g.nightActions.spellcasterTargetId = targetId;
      g.nightActions.submittedBy[player.id] = true;
    } else if (step === 'revealer' && player.role === 'revealer') {
      g.nightActions.revealerTargetId = actionType === 'skip' ? null : targetId;
      g.nightActions.submittedBy[player.id] = true;
    } else if (step === 'huntress' && player.role === 'huntress') {
      if (actionType === 'target' && !player.huntressUsed && targetId) {
        g.nightActions.huntressTargetId = targetId;
        player.huntressUsed = true;
      }
      g.nightActions.submittedBy[player.id] = true;
    }

    if (!room.timers.antiMetaFixedNight) {
      const actors = getStepActors(room, step);
      if (actors.every(p => g.nightActions.submittedBy[p.id])) {
        finalizeNightStep(room, step);
        return;
      }
    }
    broadcastRoom(room);
  });

  // Voting / Trial / Second Chance / Hunter / Ghost Guess
  socket.on('game:vote', ({ targetId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.game.phase !== 'vote') return;
    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player || !player.alive) return;
    room.game.votes[player.id] = targetId;
    broadcastRoom(room);
    checkAllNominated(room);
  });

  socket.on('game:trialVote', ({ verdict }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.game.phase !== 'defense') return;
    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player || !player.alive || player.id === room.game.accusedId) return;
    if (verdict === 'guilty' || verdict === 'innocent') {
      room.game.trialVotes[player.id] = verdict;
      broadcastRoom(room);
    }
  });

  socket.on('game:secondChanceVote', ({ decision }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.game.phase !== 'second_chance') return;
    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player || !player.alive || player.id === room.game.accusedId) return;
    if (decision === 'execute' || decision === 'spare') {
      room.game.secondChanceVotes[player.id] = decision;
      broadcastRoom(room);
    }
  });

  socket.on('game:hunterShot', ({ targetId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.game.phase !== 'hunter') return;
    if (room.game.hunterQueue[0] !== socket.data.playerId) return;
    executeHunterShot(room, socket.data.playerId, targetId);
  });

  socket.on('game:ghostGuess', ({ targetId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.view !== 'game') return;
    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player || player.alive) return;
    room.game.ghostGuesses[player.id] = targetId;
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.isTv) {
      room.tvSockets.delete(socket.id);
      return;
    }
    const player = room.players.find(p => p.id === socket.data.playerId);
    if (player && player.socketId === socket.id) {
      player.socketId = null;
      broadcastRoom(room);
    }
  });
});

// Cleanup stale rooms every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [code, room] of rooms.entries()) {
    if (room.lastActivity < cutoff) {
      stopRoomTimer(room);
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌕 MOONCOURT Server running on http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`📱 Local Wi-Fi (ให้เพื่อนเข้าจากมือถือ): http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('');
});
