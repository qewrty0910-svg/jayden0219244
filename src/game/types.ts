import type { LootCrateData, LootType, TreeRecord } from './worldGen';
export {
  AK47_DAMAGE,
  MAX_CROUCH_SECONDS,
  SIREN_BASE_HP,
  SIREN_MAX_HP,
  TOWER_COLLAPSE_CHANCE,
  TOWER_DECK_HEIGHT,
  TOWER_RAMP_RUN,
  WORLD_HALF,
  groundHeightAt,
} from './worldGen';
export type { LootCrateData, LootType, TreeRecord };

export type GamePhase =
  | 'TITLE_MENU'
  | 'PLAYING'
  | 'PAUSED'
  | 'DYING_CUTSCENE'
  | 'SPECTATING'
  | 'VICTORY'
  | 'GAME_OVER';

export type SirenAIState = 'PATROL' | 'INVESTIGATE' | 'CHASE';

export interface ToastNotice {
  id: number;
  text: string;
  tone: 'info' | 'warning' | 'danger' | 'success';
  until: number;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  color: number;
  isHost: boolean;
  alive: boolean;
}

export interface RoomStatePayload {
  code: string;
  hostId: string;
  maxPlayers: number;
  status: 'LOBBY' | 'PLAYING' | 'ENDED';
  players: LobbyPlayer[];
}

export interface RemotePlayerState {
  id: string;
  name: string;
  color: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  crouching: boolean;
  flashlightOn: boolean;
  hasAK47: boolean;
  alive: boolean;
  hp: number;
  maxHp: number;
}

export interface MultiplayerStartPayload {
  roomCode: string;
  seed: number;
  playerCount: number;
  sirenMaxHp: number;
  maxCrouchSeconds: number;
  players: LobbyPlayer[];
  spawnPositions: Record<string, { x: number; z: number }>;
}

export interface WorldTickPayload {
  sirenX: number;
  sirenY: number;
  sirenZ: number;
  sirenAngle: number;
  sirenHp: number;
  sirenMaxHp: number;
  sirenState: SirenAIState;
  sirenDead: boolean;
  chaseTargetId: string | null;
  towerCollapsed: boolean;
  towerShake: boolean;
  elapsedSeconds: number;
  players: RemotePlayerState[];
}

export interface HudSnapshot {
  phase: GamePhase;
  pointerLocked: boolean;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  exhausted: boolean;
  staminaBoostActive: boolean;
  crouching: boolean;
  crouchTime: number;
  maxCrouchSeconds: number;
  crouchLocked: boolean;
  sprinting: boolean;
  aiming: boolean;
  flashlightOn: boolean;
  battery: number;
  medkits: number;
  hasAK47: boolean;
  ammoInMag: number;
  magSize: number;
  reserveAmmo: number;
  reloading: boolean;
  reloadProgress: number;
  sirenHp: number;
  sirenMaxHp: number;
  sirenVisibleBar: boolean;
  sirenDistance: number;
  sirenState: SirenAIState;
  playerInTower: boolean;
  towerCollapsed: boolean;
  towerRelAngle: number;
  towerDistance: number;
  nearbyCrate: {
    id: number;
    label: string;
    sublabel: string;
  } | null;
  hitMarkerActive: boolean;
  cutsceneProgress: number;
  notice: ToastNotice | null;
  elapsedSeconds: number;
  shotsFired: number;
  shotsHit: number;
  treesDestroyed: number;
  causeOfDeath: string;
  muted: boolean;
  keyboardLocked: boolean;
  isMultiplayer: boolean;
  roomCode: string | null;
  playerCount: number;
  teammates: RemotePlayerState[];
  spectatingName: string | null;
  mobileControlsEnabled: boolean;
}

export const SIREN_AUDIO_PATH =
  '/assets/aistudio/freesound_community-scary-siren-air-raid-tornado-nuke-7010_ab341691.mp3';
