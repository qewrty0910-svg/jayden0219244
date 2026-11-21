import type { MultiplayerStartPayload, RoomStatePayload, WorldTickPayload } from './types';

export interface MultiplayerEvents {
  onWelcome?: (playerId: string) => void;
  onRoomJoined?: (room: RoomStatePayload) => void;
  onRoomUpdated?: (room: RoomStatePayload) => void;
  onRoomLeft?: () => void;
  onRoomError?: (message: string) => void;
  onGameStarted?: (payload: MultiplayerStartPayload) => void;
  onWorldTick?: (tick: WorldTickPayload) => void;
  onCrateLooted?: (payload: { crateId: number; byPlayerId: string }) => void;
  onTreeDestroyed?: (payload: { id: number; angle: number }) => void;
  onTowerCollapsed?: (payload: {
    crateRelocations: { id: number; x: number; y: number; z: number; looted: boolean }[];
  }) => void;
  onTowerStruck?: () => void;
  onPlayerDamaged?: (payload: { amount: number; reason: string }) => void;
  onSirenDamaged?: (payload: {
    sirenHp: number;
    sirenMaxHp: number;
    sirenDead: boolean;
    shooterId: string;
  }) => void;
  onPlayerShotFx?: (payload: { playerId: string; x: number; y: number; z: number }) => void;
  onGameEnded?: (payload: {
    victory: boolean;
    reason: string;
    elapsedSeconds: number;
    towerCollapsed: boolean;
    treesDestroyed: number;
  }) => void;
  onConnectionChange?: (connected: boolean) => void;
}

export class MultiplayerClient {
  private ws: WebSocket | null = null;
  private events: MultiplayerEvents;
  private closedByApp = false;
  private reconnectTimer: number | null = null;
  public playerId: string | null = null;

  constructor(events: MultiplayerEvents) {
    this.events = events;
    this.connect();
  }

  private connect(): void {
    if (this.closedByApp) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.events.onConnectionChange?.(true);
    };

    ws.onmessage = (ev) => {
      let parsed: { type: string; payload?: unknown };
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const p = parsed.payload as never;
      switch (parsed.type) {
        case 'session:welcome':
          this.playerId = (parsed.payload as { playerId: string }).playerId;
          this.events.onWelcome?.(this.playerId);
          break;
        case 'room:joined':
          this.events.onRoomJoined?.(p);
          break;
        case 'room:updated':
          this.events.onRoomUpdated?.(p);
          break;
        case 'room:left':
          this.events.onRoomLeft?.();
          break;
        case 'room:error':
          this.events.onRoomError?.((parsed.payload as { message: string }).message);
          break;
        case 'game:started':
          this.events.onGameStarted?.(p);
          break;
        case 'world:tick':
          this.events.onWorldTick?.(p);
          break;
        case 'crate:looted':
          this.events.onCrateLooted?.(p);
          break;
        case 'tree:destroyed':
          this.events.onTreeDestroyed?.(p);
          break;
        case 'tower:collapsed':
          this.events.onTowerCollapsed?.(p);
          break;
        case 'tower:struck':
          this.events.onTowerStruck?.();
          break;
        case 'player:damaged':
          this.events.onPlayerDamaged?.(p);
          break;
        case 'siren:damaged':
          this.events.onSirenDamaged?.(p);
          break;
        case 'player:shot_fx':
          this.events.onPlayerShotFx?.(p);
          break;
        case 'game:ended':
          this.events.onGameEnded?.(p);
          break;
      }
    };

    ws.onclose = () => {
      this.events.onConnectionChange?.(false);
      this.ws = null;
      if (!this.closedByApp) {
        this.reconnectTimer = window.setTimeout(() => this.connect(), 1800);
      }
    };

    ws.onerror = () => {
      // handled via onclose
    };
  }

  send(type: string, payload: Record<string, unknown> = {}): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
  }

  createRoom(name: string): void {
    this.send('room:create', { name });
  }

  joinRoom(code: string, name: string): void {
    this.send('room:join', { code, name });
  }

  leaveRoom(): void {
    this.send('room:leave', {});
  }

  startRoom(): void {
    this.send('room:start', {});
  }

  returnToLobby(): void {
    this.send('room:return_lobby', {});
  }

  destroy(): void {
    this.closedByApp = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
