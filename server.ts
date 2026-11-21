import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  AK47_DAMAGE,
  MAX_CROUCH_SECONDS,
  SIREN_BASE_HP,
  TOWER_COLLAPSE_CHANCE,
  TOWER_RAMP_RUN,
  WORLD_HALF,
  generateWorldLayout,
  groundHeightAt,
} from './src/game/worldGen.ts';
import type { LootCrateData, TreeRecord } from './src/game/worldGen.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const MAX_PLAYERS = 4;
const PLAYER_COLORS = [0x38bdf8, 0xf59e0b, 0x34d399, 0xf472b6];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

type SirenAIState = 'PATROL' | 'INVESTIGATE' | 'CHASE';

interface PlayerSession {
  id: string;
  name: string;
  color: number;
  ws: WebSocket;
  roomCode: string | null;
  x: number;
  y: number;
  z: number;
  yaw: number;
  crouching: boolean;
  sprinting: boolean;
  flashlightOn: boolean;
  hasAK47: boolean;
  alive: boolean;
  hp: number;
  maxHp: number;
}

interface RoomMatchState {
  seed: number;
  playerCount: number;
  towerX: number;
  towerZ: number;
  towerGroundY: number;
  towerCollapsed: boolean;
  towerShakeTimer: number;
  sirenX: number;
  sirenY: number;
  sirenZ: number;
  sirenAngle: number;
  sirenHp: number;
  sirenMaxHp: number;
  sirenState: SirenAIState;
  sirenTargetX: number;
  sirenTargetZ: number;
  sirenInvestigateTimer: number;
  sirenPatrolTimer: number;
  sirenAttackCooldown: number;
  sirenTowerStrikeCooldown: number;
  sirenDead: boolean;
  sirenDeathTimer: number;
  chaseTargetId: string | null;
  chaseRetargetTimer: number;
  allDeadTimer: number;
  elapsedSeconds: number;
  crates: LootCrateData[];
  trees: TreeRecord[];
  lastTickAt: number;
}

interface RoomRecord {
  code: string;
  hostId: string;
  status: 'LOBBY' | 'PLAYING' | 'ENDED';
  players: PlayerSession[];
  match: RoomMatchState | null;
  intervalId: NodeJS.Timeout | null;
}

const rooms = new Map<string, RoomRecord>();

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function distSqXZ(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateRoomCode(): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    let code = '';
    for (let i = 0; i < 5; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function sendJson(ws: WebSocket, type: string, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function broadcastRoom(room: RoomRecord, type: string, payload: unknown): void {
  const msg = JSON.stringify({ type, payload });
  for (const p of room.players) {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  }
}

function serializeRoom(room: RoomRecord) {
  return {
    code: room.code,
    hostId: room.hostId,
    maxPlayers: MAX_PLAYERS,
    status: room.status,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      isHost: p.id === room.hostId,
      alive: p.alive,
    })),
  };
}

function isPlayerInTower(match: RoomMatchState, p: PlayerSession): boolean {
  if (match.towerCollapsed) return false;
  const rx = p.x - match.towerX;
  const rz = p.z - match.towerZ;
  return (
    Math.abs(rx) <= 3.6 &&
    rz >= -3.6 &&
    rz <= 3.4 + TOWER_RAMP_RUN &&
    p.y > match.towerGroundY + 1.8
  );
}

function pickRandomCandidate(list: PlayerSession[], excludeId?: string | null): PlayerSession | null {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const filtered = excludeId ? list.filter((p) => p.id !== excludeId) : list;
  const pool = filtered.length > 0 ? filtered : list;
  return pool[Math.floor(Math.random() * pool.length)];
}

function startMatchForRoom(room: RoomRecord): void {
  if (room.intervalId) {
    clearInterval(room.intervalId);
    room.intervalId = null;
  }

  const playerCount = Math.max(1, Math.min(MAX_PLAYERS, room.players.length));
  const seed = (Math.random() * 0xffffffff) >>> 0;
  const layout = generateWorldLayout(seed, playerCount);

  const spawnPositions: Record<string, { x: number; z: number }> = {};
  room.players.forEach((p, idx) => {
    const ang = (idx / playerCount) * Math.PI * 2;
    const rad = playerCount === 1 ? 0 : 2.1;
    const sx = Math.cos(ang) * rad;
    const sz = Math.sin(ang) * rad;
    const sy = groundHeightAt(sx, sz);
    p.x = sx;
    p.y = sy;
    p.z = sz;
    p.yaw = 0;
    p.crouching = false;
    p.sprinting = false;
    p.flashlightOn = true;
    p.hasAK47 = false;
    p.alive = true;
    p.hp = 100;
    p.maxHp = 100;
    spawnPositions[p.id] = { x: sx, z: sz };
  });

  const sirenMaxHp = SIREN_BASE_HP * playerCount;
  const maxCrouchSeconds = MAX_CROUCH_SECONDS / playerCount;

  room.status = 'PLAYING';
  room.match = {
    seed,
    playerCount,
    towerX: layout.towerX,
    towerZ: layout.towerZ,
    towerGroundY: layout.towerGroundY,
    towerCollapsed: false,
    towerShakeTimer: 0,
    sirenX: layout.sirenX,
    sirenY: layout.sirenY,
    sirenZ: layout.sirenZ,
    sirenAngle: Math.atan2(-layout.sirenX, -layout.sirenZ),
    sirenHp: sirenMaxHp,
    sirenMaxHp,
    sirenState: 'PATROL',
    sirenTargetX: (Math.random() - 0.5) * 40,
    sirenTargetZ: (Math.random() - 0.5) * 40,
    sirenInvestigateTimer: 0,
    sirenPatrolTimer: 4,
    sirenAttackCooldown: 0,
    sirenTowerStrikeCooldown: 0,
    sirenDead: false,
    sirenDeathTimer: 0,
    chaseTargetId: null,
    chaseRetargetTimer: 6.5,
    allDeadTimer: -1,
    elapsedSeconds: 0,
    crates: layout.crates,
    trees: layout.trees,
    lastTickAt: Date.now(),
  };

  broadcastRoom(room, 'room:updated', serializeRoom(room));
  broadcastRoom(room, 'game:started', {
    roomCode: room.code,
    seed,
    playerCount,
    sirenMaxHp,
    maxCrouchSeconds,
    players: serializeRoom(room).players,
    spawnPositions,
  });

  room.intervalId = setInterval(() => tickRoom(room), 66);
}

function endMatchForRoom(room: RoomRecord, victory: boolean, reason: string): void {
  if (room.intervalId) {
    clearInterval(room.intervalId);
    room.intervalId = null;
  }
  const match = room.match;
  room.status = 'ENDED';
  broadcastRoom(room, 'game:ended', {
    victory,
    reason,
    elapsedSeconds: match ? Math.floor(match.elapsedSeconds) : 0,
    towerCollapsed: match ? match.towerCollapsed : false,
    treesDestroyed: match ? match.trees.filter((t) => t.destroyed).length : 0,
  });
  broadcastRoom(room, 'room:updated', serializeRoom(room));
}

function tickRoom(room: RoomRecord): void {
  const match = room.match;
  if (!match || room.status !== 'PLAYING') return;

  const now = Date.now();
  const dt = Math.min((now - match.lastTickAt) / 1000, 0.1);
  match.lastTickAt = now;
  match.elapsedSeconds += dt;

  if (match.towerShakeTimer > 0) {
    match.towerShakeTimer = Math.max(0, match.towerShakeTimer - dt);
  }

  // Check if all players died
  const alivePlayers = room.players.filter((p) => p.alive);
  if (alivePlayers.length === 0) {
    if (match.allDeadTimer < 0) {
      match.allDeadTimer = 3.5;
    } else {
      match.allDeadTimer -= dt;
      if (match.allDeadTimer <= 0) {
        endMatchForRoom(room, false, '모든 생존자가 사이렌 헤드에게 당했습니다.');
        return;
      }
    }
  } else {
    match.allDeadTimer = -1;
  }

  // Siren Head death sequence
  if (match.sirenDead) {
    match.sirenDeathTimer -= dt;
    if (match.sirenDeathTimer <= 0) {
      endMatchForRoom(room, true, '사이렌 헤드를 처치했습니다.');
      return;
    }
    broadcastWorldTick(room, match);
    return;
  }

  if (match.sirenAttackCooldown > 0) match.sirenAttackCooldown -= dt;
  if (match.sirenTowerStrikeCooldown > 0) match.sirenTowerStrikeCooldown -= dt;

  // Detection & Random Target Selection (among alive, non-crouching players)
  const uncrouchedAlive = alivePlayers.filter((p) => !p.crouching);
  const detectedUncrouched: PlayerSession[] = [];

  for (const p of uncrouchedAlive) {
    const dx = p.x - match.sirenX;
    const dz = p.z - match.sirenZ;
    const dist = Math.hypot(dx, dz);
    const proxR = p.flashlightOn ? 32 : p.sprinting ? 26 : 16;

    let seesLight = false;
    if (p.flashlightOn && dist < 65) {
      const lookX = -Math.sin(p.yaw);
      const lookZ = -Math.cos(p.yaw);
      const toSX = (match.sirenX - p.x) / (dist || 1);
      const toSZ = (match.sirenZ - p.z) / (dist || 1);
      const dot = lookX * toSX + lookZ * toSZ;
      if (dist < 40 || dot > 0.72) {
        seesLight = true;
      }
    }

    if (dist < proxR || seesLight) {
      detectedUncrouched.push(p);
    }
  }

  // Validate current random chase target
  let chaseTarget = uncrouchedAlive.find((p) => p.id === match.chaseTargetId) || null;
  if (match.sirenState === 'CHASE') {
    match.chaseRetargetTimer -= dt;
  }

  if (uncrouchedAlive.length === 0) {
    match.chaseTargetId = null;
    chaseTarget = null;
    if (match.sirenState !== 'PATROL') {
      match.sirenState = 'PATROL';
      match.sirenInvestigateTimer = 0;
      match.sirenPatrolTimer = 0;
    }
  } else {
    // Switch target randomly if target became invalid/crouched or retarget timer elapsed
    if (
      !chaseTarget ||
      (match.sirenState === 'CHASE' && match.chaseRetargetTimer <= 0 && uncrouchedAlive.length > 1)
    ) {
      if (detectedUncrouched.length > 0) {
        const picked = pickRandomCandidate(detectedUncrouched, match.chaseTargetId);
        if (picked) {
          chaseTarget = picked;
          match.chaseTargetId = picked.id;
          match.sirenState = 'CHASE';
          match.chaseRetargetTimer = 6.5 + Math.random() * 3.5;
        }
      } else if (match.sirenState === 'CHASE') {
        const picked = pickRandomCandidate(uncrouchedAlive, match.chaseTargetId);
        if (picked) {
          const dPicked = Math.hypot(picked.x - match.sirenX, picked.z - match.sirenZ);
          if (dPicked <= 58 || picked.flashlightOn) {
            chaseTarget = picked;
            match.chaseTargetId = picked.id;
            match.chaseRetargetTimer = 6.5 + Math.random() * 3.5;
          } else {
            match.chaseTargetId = null;
            chaseTarget = null;
            match.sirenState = 'INVESTIGATE';
            match.sirenInvestigateTimer = 5.5;
          }
        }
      }
    }

    // If patrolling/investigating and a player triggers detection
    if (match.sirenState !== 'CHASE' && detectedUncrouched.length > 0) {
      const closeOrLit = detectedUncrouched.filter((p) => {
        const d = Math.hypot(p.x - match.sirenX, p.z - match.sirenZ);
        const proxR = p.flashlightOn ? 32 : p.sprinting ? 26 : 16;
        return d < proxR || d < 42;
      });
      if (closeOrLit.length > 0) {
        const picked = pickRandomCandidate(closeOrLit);
        if (picked) {
          chaseTarget = picked;
          match.chaseTargetId = picked.id;
          match.sirenState = 'CHASE';
          match.chaseRetargetTimer = 6.5 + Math.random() * 3.5;
        }
      } else {
        const picked = pickRandomCandidate(detectedUncrouched);
        if (picked) {
          match.sirenState = 'INVESTIGATE';
          match.sirenInvestigateTimer = 6.0;
          match.sirenTargetX = picked.x;
          match.sirenTargetZ = picked.z;
        }
      }
    }
  }

  if (match.sirenState === 'CHASE' && chaseTarget) {
    match.sirenTargetX = chaseTarget.x;
    match.sirenTargetZ = chaseTarget.z;
  } else if (match.sirenState === 'INVESTIGATE') {
    match.sirenInvestigateTimer -= dt;
    if (
      match.sirenInvestigateTimer <= 0 ||
      Math.hypot(match.sirenTargetX - match.sirenX, match.sirenTargetZ - match.sirenZ) < 3
    ) {
      match.sirenState = 'PATROL';
    }
  }

  if (match.sirenState === 'PATROL') {
    match.sirenPatrolTimer -= dt;
    if (
      match.sirenPatrolTimer <= 0 ||
      Math.hypot(match.sirenTargetX - match.sirenX, match.sirenTargetZ - match.sirenZ) < 4
    ) {
      match.sirenPatrolTimer = 4.5 + Math.random() * 4;
      const anchor = pickRandomCandidate(alivePlayers);
      const ax = anchor ? anchor.x : 0;
      const az = anchor ? anchor.z : 0;
      match.sirenTargetX = clamp(ax + (Math.random() - 0.5) * 95, -WORLD_HALF + 14, WORLD_HALF - 14);
      match.sirenTargetZ = clamp(az + (Math.random() - 0.5) * 95, -WORLD_HALF + 14, WORLD_HALF - 14);
    }
  }

  const targetInTower = Boolean(chaseTarget && isPlayerInTower(match, chaseTarget));
  const goalX = targetInTower && match.sirenState === 'CHASE' ? match.towerX : match.sirenTargetX;
  const goalZ = targetInTower && match.sirenState === 'CHASE' ? match.towerZ : match.sirenTargetZ;
  const tx = goalX - match.sirenX;
  const tz = goalZ - match.sirenZ;
  const tDist = Math.hypot(tx, tz);

  let speed = 5.4;
  if (match.sirenState === 'INVESTIGATE') speed = 7.4;
  else if (match.sirenState === 'CHASE') speed = 8.9;

  const distTower = Math.hypot(match.sirenX - match.towerX, match.sirenZ - match.towerZ);
  const stopAtTower = targetInTower && !match.towerCollapsed && distTower < 8.4;

  if (tDist > 1.0) {
    const targetAng = Math.atan2(tx, tz);
    const diff = normalizeAngle(targetAng - match.sirenAngle);
    match.sirenAngle += diff * Math.min(1, dt * 6);
    if (!stopAtTower) {
      match.sirenX += (tx / tDist) * speed * dt;
      match.sirenZ += (tz / tDist) * speed * dt;
    }
  }

  match.sirenX = clamp(match.sirenX, -WORLD_HALF + 6, WORLD_HALF - 6);
  match.sirenZ = clamp(match.sirenZ, -WORLD_HALF + 6, WORLD_HALF - 6);
  match.sirenY = groundHeightAt(match.sirenX, match.sirenZ);

  // Server-authoritative permanent tree destruction
  for (let i = 0; i < match.trees.length; i++) {
    const t = match.trees[i];
    if (t.destroyed) continue;
    if (Math.abs(t.x - match.sirenX) > 2.6 || Math.abs(t.z - match.sirenZ) > 2.6) continue;
    if (distSqXZ(match.sirenX, match.sirenZ, t.x, t.z) <= 2.4 * 2.4) {
      t.destroyed = true;
      t.destroyedAngle = Math.atan2(t.z - match.sirenZ, t.x - match.sirenX);
      broadcastRoom(room, 'tree:destroyed', {
        id: t.id,
        angle: t.destroyedAngle,
      });
    }
  }

  // Watchtower attack & 30% permanent collapse
  const anyAliveInTower = alivePlayers.some((p) => isPlayerInTower(match, p));
  if (anyAliveInTower && !match.towerCollapsed && distTower <= 9.4 && match.sirenTowerStrikeCooldown <= 0) {
    match.sirenTowerStrikeCooldown = 2.6;
    if (Math.random() < TOWER_COLLAPSE_CHANCE) {
      match.towerCollapsed = true;
      match.towerShakeTimer = 0;
      const crateRelocations: { id: number; x: number; y: number; z: number; looted: boolean }[] = [];
      for (const c of match.crates) {
        if (c.looted) continue;
        if (c.salvageable) {
          c.x = match.towerX + (Math.random() - 0.5) * 3.8;
          c.z = match.towerZ + (Math.random() - 0.5) * 3.8;
          c.y = groundHeightAt(c.x, c.z) + 0.35;
          crateRelocations.push({ id: c.id, x: c.x, y: c.y, z: c.z, looted: false });
        } else {
          c.looted = true;
          crateRelocations.push({ id: c.id, x: c.x, y: c.y, z: c.z, looted: true });
        }
      }
      broadcastRoom(room, 'tower:collapsed', { crateRelocations });
      for (const p of alivePlayers) {
        if (isPlayerInTower(match, p)) {
          sendJson(p.ws, 'player:damaged', {
            amount: 35,
            reason: '산불감시탑 붕괴 잔해에 매몰되었습니다.',
          });
        }
      }
    } else {
      match.towerShakeTimer = 0.65;
      broadcastRoom(room, 'tower:struck', {});
    }
  } else if (match.sirenAttackCooldown <= 0) {
    // Melee hit on any close alive uncrouched player outside watchtower
    for (const p of uncrouchedAlive) {
      if (isPlayerInTower(match, p)) continue;
      const dist = Math.hypot(p.x - match.sirenX, p.z - match.sirenZ);
      if (dist < 3.4) {
        match.sirenAttackCooldown = 1.25;
        sendJson(p.ws, 'player:damaged', {
          amount: 28,
          reason: '사이렌 헤드의 손에 잡혀 삼켜졌습니다.',
        });
        break;
      }
    }
  }

  broadcastWorldTick(room, match);
}

function broadcastWorldTick(room: RoomRecord, match: RoomMatchState): void {
  broadcastRoom(room, 'world:tick', {
    sirenX: match.sirenX,
    sirenY: match.sirenY,
    sirenZ: match.sirenZ,
    sirenAngle: match.sirenAngle,
    sirenHp: match.sirenHp,
    sirenMaxHp: match.sirenMaxHp,
    sirenState: match.sirenState,
    sirenDead: match.sirenDead,
    chaseTargetId: match.chaseTargetId,
    towerCollapsed: match.towerCollapsed,
    towerShake: match.towerShakeTimer > 0,
    elapsedSeconds: match.elapsedSeconds,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      crouching: p.crouching,
      flashlightOn: p.flashlightOn,
      hasAK47: p.hasAK47,
      alive: p.alive,
      hp: p.hp,
      maxHp: p.maxHp,
    })),
  });
}

function removePlayerFromRoom(player: PlayerSession): void {
  if (!player.roomCode) return;
  const room = rooms.get(player.roomCode);
  player.roomCode = null;
  if (!room) return;

  room.players = room.players.filter((p) => p.id !== player.id);
  if (room.players.length === 0) {
    if (room.intervalId) clearInterval(room.intervalId);
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === player.id) {
    room.hostId = room.players[0].id;
  }
  if (room.match && room.match.chaseTargetId === player.id) {
    room.match.chaseTargetId = null;
  }
  broadcastRoom(room, 'room:updated', serializeRoom(room));
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, rooms: rooms.size });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    const session: PlayerSession = {
      id: genId('p'),
      name: '생존자',
      color: PLAYER_COLORS[0],
      ws,
      roomCode: null,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      crouching: false,
      sprinting: false,
      flashlightOn: true,
      hasAK47: false,
      alive: true,
      hp: 100,
      maxHp: 100,
    };

    sendJson(ws, 'session:welcome', { playerId: session.id });

    ws.on('message', (raw) => {
      let msg: { type: string; payload?: Record<string, unknown> };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const payload = msg.payload || {};

      switch (msg.type) {
        case 'room:create': {
          removePlayerFromRoom(session);
          const cleanName = String(payload.name || '').trim().slice(0, 14) || '방장';
          const code = generateRoomCode();
          session.name = cleanName;
          session.color = PLAYER_COLORS[0];
          session.roomCode = code;
          session.alive = true;

          const room: RoomRecord = {
            code,
            hostId: session.id,
            status: 'LOBBY',
            players: [session],
            match: null,
            intervalId: null,
          };
          rooms.set(code, room);
          sendJson(ws, 'room:joined', serializeRoom(room));
          break;
        }

        case 'room:join': {
          const code = String(payload.code || '')
            .trim()
            .toUpperCase();
          const room = rooms.get(code);
          if (!room) {
            sendJson(ws, 'room:error', { message: '존재하지 않는 방 코드입니다.' });
            return;
          }
          if (room.status === 'PLAYING') {
            sendJson(ws, 'room:error', { message: '이미 게임이 진행 중인 방입니다.' });
            return;
          }
          if (room.players.length >= MAX_PLAYERS) {
            sendJson(ws, 'room:error', { message: '방 정원(최대 4인)이 가득 찼습니다.' });
            return;
          }

          removePlayerFromRoom(session);
          const idx = room.players.length;
          const cleanName =
            String(payload.name || '').trim().slice(0, 14) || `생존자 ${idx + 1}`;
          session.name = cleanName;
          session.color = PLAYER_COLORS[idx % PLAYER_COLORS.length];
          session.roomCode = room.code;
          session.alive = true;
          room.players.push(session);

          if (room.status === 'ENDED') {
            room.status = 'LOBBY';
          }

          const state = serializeRoom(room);
          sendJson(ws, 'room:joined', state);
          broadcastRoom(room, 'room:updated', state);
          break;
        }

        case 'room:leave': {
          removePlayerFromRoom(session);
          sendJson(ws, 'room:left', {});
          break;
        }

        case 'room:start': {
          if (!session.roomCode) return;
          const room = rooms.get(session.roomCode);
          if (!room || room.hostId !== session.id) return;
          startMatchForRoom(room);
          break;
        }

        case 'room:return_lobby': {
          if (!session.roomCode) return;
          const room = rooms.get(session.roomCode);
          if (!room) return;
          if (room.intervalId) {
            clearInterval(room.intervalId);
            room.intervalId = null;
          }
          room.match = null;
          room.status = 'LOBBY';
          for (const p of room.players) p.alive = true;
          broadcastRoom(room, 'room:updated', serializeRoom(room));
          break;
        }

        case 'player:state': {
          if (!session.roomCode) return;
          const room = rooms.get(session.roomCode);
          if (!room || room.status !== 'PLAYING') return;
          if (typeof payload.x === 'number') session.x = payload.x;
          if (typeof payload.y === 'number') session.y = payload.y;
          if (typeof payload.z === 'number') session.z = payload.z;
          if (typeof payload.yaw === 'number') session.yaw = payload.yaw;
          session.crouching = Boolean(payload.crouching);
          session.sprinting = Boolean(payload.sprinting);
          session.flashlightOn = Boolean(payload.flashlightOn);
          session.hasAK47 = Boolean(payload.hasAK47);
          if (typeof payload.hp === 'number') session.hp = payload.hp;
          if (typeof payload.maxHp === 'number') session.maxHp = payload.maxHp;
          if (typeof payload.alive === 'boolean') session.alive = payload.alive;
          break;
        }

        case 'crate:loot': {
          if (!session.roomCode) return;
          const room = rooms.get(session.roomCode);
          if (!room || !room.match || room.status !== 'PLAYING') return;
          const crateId = Number(payload.crateId);
          const crate = room.match.crates.find((c) => c.id === crateId);
          if (!crate || crate.looted) return;
          if (room.match.towerCollapsed && !crate.salvageable) return;
          crate.looted = true;
          broadcastRoom(room, 'crate:looted', {
            crateId: crate.id,
            byPlayerId: session.id,
          });
          break;
        }

        case 'siren:hit': {
          if (!session.roomCode) return;
          const room = rooms.get(session.roomCode);
          if (!room || !room.match || room.status !== 'PLAYING' || room.match.sirenDead) return;
          const match = room.match;
          match.sirenHp = Math.max(0, match.sirenHp - AK47_DAMAGE);

          // Alert Siren Head & randomly pick an uncrouched alive target (or shooter)
          const uncrouchedAlive = room.players.filter((p) => p.alive && !p.crouching);
          if (uncrouchedAlive.length > 0 && (!match.chaseTargetId || Math.random() < 0.35)) {
            const picked = pickRandomCandidate(uncrouchedAlive);
            if (picked) {
              match.chaseTargetId = picked.id;
              match.sirenState = 'CHASE';
              match.chaseRetargetTimer = 6.5 + Math.random() * 3.5;
            }
          }

          if (match.sirenHp <= 0) {
            match.sirenDead = true;
            match.sirenDeathTimer = 2.4;
          }
          broadcastRoom(room, 'siren:damaged', {
            sirenHp: match.sirenHp,
            sirenMaxHp: match.sirenMaxHp,
            sirenDead: match.sirenDead,
            shooterId: session.id,
          });
          break;
        }

        case 'player:shot': {
          if (!session.roomCode) return;
          const room = rooms.get(session.roomCode);
          if (!room || !room.match || room.status !== 'PLAYING') return;
          const match = room.match;
          if (!match.sirenDead && !session.crouching) {
            const d2 = distSqXZ(session.x, session.z, match.sirenX, match.sirenZ);
            if (d2 < 125 * 125 && match.sirenState !== 'CHASE') {
              match.sirenState = 'INVESTIGATE';
              match.sirenTargetX = session.x;
              match.sirenTargetZ = session.z;
              match.sirenInvestigateTimer = 7.5;
            }
          }
          for (const p of room.players) {
            if (p.id !== session.id) {
              sendJson(p.ws, 'player:shot_fx', {
                playerId: session.id,
                x: session.x,
                y: session.y,
                z: session.z,
              });
            }
          }
          break;
        }

        case 'player:died': {
          if (!session.roomCode) return;
          const room = rooms.get(session.roomCode);
          if (!room || !room.match) return;
          session.alive = false;
          session.hp = 0;
          if (room.match.chaseTargetId === session.id) {
            room.match.chaseTargetId = null;
          }
          broadcastRoom(room, 'room:updated', serializeRoom(room));
          break;
        }
      }
    });

    ws.on('close', () => {
      removePlayerFromRoom(session);
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
