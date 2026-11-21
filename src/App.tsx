import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Crosshair,
  Eye,
  Flashlight,
  FlashlightOff,
  Heart,
  Lock,
  LockOpen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Shield,
  Smartphone,
  Users,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import { SirenForest3DEngine } from './game/engine3d';
import { MultiplayerClient } from './game/multiplayerClient';
import {
  MAX_CROUCH_SECONDS,
  SIREN_MAX_HP,
  type HudSnapshot,
  type RoomStatePayload,
} from './game/types';

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function hexColorCss(colorNum: number): string {
  return `#${colorNum.toString(16).padStart(6, '0')}`;
}

const INITIAL_HUD: HudSnapshot = {
  phase: 'TITLE_MENU',
  pointerLocked: false,
  hp: 100,
  maxHp: 100,
  stamina: 100,
  maxStamina: 100,
  exhausted: false,
  staminaBoostActive: false,
  crouching: false,
  crouchTime: 0,
  maxCrouchSeconds: MAX_CROUCH_SECONDS,
  crouchLocked: false,
  sprinting: false,
  aiming: false,
  flashlightOn: true,
  battery: 100,
  medkits: 0,
  hasAK47: false,
  ammoInMag: 0,
  magSize: 30,
  reserveAmmo: 0,
  reloading: false,
  reloadProgress: 0,
  sirenHp: SIREN_MAX_HP,
  sirenMaxHp: SIREN_MAX_HP,
  sirenVisibleBar: false,
  sirenDistance: 90,
  sirenState: 'PATROL',
  playerInTower: false,
  towerCollapsed: false,
  towerRelAngle: 0,
  towerDistance: 90,
  nearbyCrate: null,
  hitMarkerActive: false,
  cutsceneProgress: 0,
  notice: null,
  elapsedSeconds: 0,
  shotsFired: 0,
  shotsHit: 0,
  treesDestroyed: 0,
  causeOfDeath: '',
  muted: false,
  keyboardLocked: false,
  isMultiplayer: false,
  roomCode: null,
  playerCount: 1,
  teammates: [],
  spectatingName: null,
  mobileControlsEnabled: false,
};

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<SirenForest3DEngine | null>(null);
  const mpRef = useRef<MultiplayerClient | null>(null);

  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD);
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768
      : false
  );

  // Lobby & Multiplayer state
  const [lobbyTab, setLobbyTab] = useState<'SOLO' | 'MULTI'>('SOLO');
  const [playerName, setPlayerName] = useState('생존자');
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [room, setRoom] = useState<RoomStatePayload | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  const [mpConnected, setMpConnected] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  // Virtual joystick, multi-touch look & button drag-look tracking
  const [joyKnob, setJoyKnob] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const joyPointerId = useRef<number | null>(null);
  const joyCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lookPointerId = useRef<number | null>(null);
  const lookLastRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const firePointerId = useRef<number | null>(null);
  const buttonLookPointers = useRef<Map<number, { x: number; y: number }>>(new Map());

  useEffect(() => {
    const updateViewport = () => {
      const coarse = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768;
      setIsMobileViewport(coarse);
    };
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  useEffect(() => {
    if (hud.phase !== 'PLAYING' || !hud.mobileControlsEnabled) {
      joyPointerId.current = null;
      lookPointerId.current = null;
      firePointerId.current = null;
      buttonLookPointers.current.clear();
      setJoyKnob({ x: 0, y: 0 });
      engineRef.current?.setVirtualMove(0, 0);
      engineRef.current?.setVirtualFire(false);
    }
  }, [hud.phase, hud.mobileControlsEnabled]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const engine = new SirenForest3DEngine(container, (snapshot) => {
      setHud(snapshot);
    });
    engineRef.current = engine;

    const initialMobile =
      window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768;
    engine.setMobileControlsEnabled(initialMobile);

    const mp = new MultiplayerClient({
      onConnectionChange: (connected) => setMpConnected(connected),
      onWelcome: (id) => setMyPlayerId(id),
      onRoomJoined: (r) => {
        setRoom(r);
        setRoomError(null);
        setLobbyTab('MULTI');
      },
      onRoomUpdated: (r) => {
        setRoom(r);
      },
      onRoomLeft: () => {
        setRoom(null);
      },
      onRoomError: (message) => {
        setRoomError(message);
      },
      onGameStarted: (payload) => {
        setRoomError(null);
        const localId = mp.playerId || '';
        engine.startMultiplayerGame(payload, localId);
      },
      onWorldTick: (tick) => {
        engine.applyWorldTick(tick);
      },
      onCrateLooted: (payload) => {
        engine.applyCrateLooted(payload.crateId, payload.byPlayerId);
      },
      onTreeDestroyed: (payload) => {
        engine.applyTreeDestroyed(payload.id, payload.angle);
      },
      onTowerCollapsed: (payload) => {
        engine.applyTowerCollapsed(payload.crateRelocations);
      },
      onTowerStruck: () => {
        engine.applyTowerStruck();
      },
      onPlayerDamaged: (payload) => {
        engine.applyServerDamage(payload.amount, payload.reason);
      },
      onSirenDamaged: (payload) => {
        engine.applySirenDamaged(payload);
      },
      onPlayerShotFx: (payload) => {
        engine.applyRemoteShotFx(payload.x, payload.y, payload.z);
      },
      onGameEnded: (payload) => {
        engine.applyGameEnded(payload);
      },
    });
    mpRef.current = mp;

    engine.setNetworkSink({
      sendPlayerState: (state) => mp.send('player:state', state),
      sendCrateLoot: (crateId) => mp.send('crate:loot', { crateId }),
      sendSirenHit: () => mp.send('siren:hit', {}),
      sendPlayerShot: () => mp.send('player:shot', {}),
      sendPlayerDied: () => mp.send('player:died', {}),
    });

    return () => {
      mp.destroy();
      mpRef.current = null;
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  const compact = hud.mobileControlsEnabled || isMobileViewport;
  const accuracy = hud.shotsFired > 0 ? Math.round((hud.shotsHit / hud.shotsFired) * 100) : 0;
  const isHost = Boolean(room && myPlayerId && room.hostId === myPlayerId);
  const previewCount = room ? Math.max(1, room.players.length) : 1;

  const handleToggleMobileMode = () => {
    const next = !hud.mobileControlsEnabled;
    engineRef.current?.setMobileControlsEnabled(next);
  };

  const handleCopyCode = () => {
    if (!room) return;
    navigator.clipboard?.writeText(room.code).catch(() => {});
    setCopiedCode(true);
    window.setTimeout(() => setCopiedCode(false), 1800);
  };

  const handleBackToLobby = () => {
    if (hud.isMultiplayer && room) {
      mpRef.current?.returnToLobby();
      engineRef.current?.returnToTitleMenu();
    } else {
      engineRef.current?.returnToTitleMenu();
    }
  };

  // Virtual Joystick Touch/Pointer Handlers
  const updateJoystickFromPointer = (clientX: number, clientY: number) => {
    const maxR = 40;
    const dx = clientX - joyCenterRef.current.x;
    const dy = clientY - joyCenterRef.current.y;
    const dist = Math.hypot(dx, dy);
    const clampedDist = Math.min(maxR, dist);
    const angle = Math.atan2(dy, dx);
    const kx = dist > 0.01 ? (Math.cos(angle) * clampedDist) / maxR : 0;
    const ky = dist > 0.01 ? (Math.sin(angle) * clampedDist) / maxR : 0;
    setJoyKnob({ x: kx, y: ky });
    engineRef.current?.setVirtualMove(kx, -ky);
  };

  const handleJoyPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    joyCenterRef.current = {
      x: rect.left + rect.width * 0.5,
      y: rect.top + rect.height * 0.5,
    };
    joyPointerId.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore if capture unavailable
    }
    updateJoystickFromPointer(e.clientX, e.clientY);
  };

  const handleJoyPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (joyPointerId.current !== e.pointerId) return;
    e.stopPropagation();
    updateJoystickFromPointer(e.clientX, e.clientY);
  };

  const handleJoyPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (joyPointerId.current !== e.pointerId) return;
    e.stopPropagation();
    joyPointerId.current = null;
    setJoyKnob({ x: 0, y: 0 });
    engineRef.current?.setVirtualMove(0, 0);
  };

  // Multi-touch Look Handlers (full-screen background layer behind z-20 controls)
  const handleLookPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (lookPointerId.current !== null) return;
    e.preventDefault();
    lookPointerId.current = e.pointerId;
    lookLastRef.current = { x: e.clientX, y: e.clientY };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore if capture unavailable
    }
  };

  const handleLookPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (lookPointerId.current !== e.pointerId) return;
    const dx = e.clientX - lookLastRef.current.x;
    const dy = e.clientY - lookLastRef.current.y;
    lookLastRef.current = { x: e.clientX, y: e.clientY };
    engineRef.current?.applyTouchLook(dx, dy);
  };

  const handleLookPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (lookPointerId.current !== e.pointerId) return;
    lookPointerId.current = null;
  };

  // Shared Multi-Touch Action Button Helpers (trigger instantly + rotate camera if dragged)
  const handleActionButtonDown = (
    e: React.PointerEvent<HTMLButtonElement>,
    action: () => void,
    isFireButton = false
  ) => {
    e.preventDefault();
    e.stopPropagation();
    buttonLookPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (isFireButton) {
      firePointerId.current = e.pointerId;
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore if capture unavailable
    }
    action();
  };

  const handleActionButtonMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const prev = buttonLookPointers.current.get(e.pointerId);
    if (!prev) return;
    e.stopPropagation();
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;
    engineRef.current?.applyTouchLook(dx, dy);
  };

  const handleActionButtonEnd = (e: React.PointerEvent<HTMLButtonElement>, isFireButton = false) => {
    e.stopPropagation();
    buttonLookPointers.current.delete(e.pointerId);
    if (isFireButton && firePointerId.current === e.pointerId) {
      firePointerId.current = null;
      engineRef.current?.setVirtualFire(false);
    }
  };

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#04070c] text-zinc-100 select-none">
      {/* Isolated WebGL Mount Container */}
      <div ref={mountRef} className="w-full h-full" />

      {/* Full-Screen Touch Look Surface behind z-20 joystick/buttons (allows turning while pressing buttons) */}
      {hud.phase === 'PLAYING' && hud.mobileControlsEnabled && (
        <div
          onPointerDown={handleLookPointerDown}
          onPointerMove={handleLookPointerMove}
          onPointerUp={handleLookPointerEnd}
          onPointerCancel={handleLookPointerEnd}
          onLostPointerCapture={handleLookPointerEnd}
          className="fixed inset-0 z-10 touch-none"
          aria-label="시점 회전 영역"
        />
      )}

      {/* 1st-Person Center Crosshair, ADS Precision Reticle & Hitmarker */}
      {hud.phase === 'PLAYING' && (
        <div className="pointer-events-none fixed inset-0 z-10 flex items-center justify-center">
          <div className="relative flex items-center justify-center">
            <div
              className={`rounded-full transition-all duration-75 ${
                hud.hitMarkerActive
                  ? 'w-1.5 h-1.5 bg-red-500 scale-125'
                  : hud.aiming
                  ? 'w-1 h-1 bg-amber-300'
                  : hud.hasAK47
                  ? 'w-1.5 h-1.5 bg-amber-200/90'
                  : 'w-1.5 h-1.5 bg-zinc-200/65'
              }`}
            />
            {hud.aiming && (
              <>
                <div className="absolute -left-4 w-2 h-[1.5px] bg-amber-200/80" />
                <div className="absolute -right-4 w-2 h-[1.5px] bg-amber-200/80" />
                <div className="absolute -top-4 h-2 w-[1.5px] bg-amber-200/80" />
                <div className="absolute -bottom-4 h-2 w-[1.5px] bg-amber-200/80" />
              </>
            )}
            {hud.hitMarkerActive && (
              <div className="absolute w-5 h-5 border-2 border-red-500/90 rotate-45" />
            )}
          </div>

          {!hud.pointerLocked && !hud.mobileControlsEnabled && (
            <button
              type="button"
              onClick={() => engineRef.current?.requestLock()}
              className={`pointer-events-auto absolute top-[57%] rounded-md bg-zinc-950/85 border border-zinc-700/80 text-zinc-200 hover:border-zinc-500 transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                compact ? 'px-2.5 py-1 text-[9px]' : 'px-4 py-1.5 text-xs'
              }`}
            >
              화면을 클릭해 1인칭 시점 잠금 (드래그 시점 전환 가능)
            </button>
          )}
        </div>
      )}

      {/* Low HP Red Vignette */}
      {hud.phase === 'PLAYING' && hud.hp <= 35 && (
        <div
          className="pointer-events-none fixed inset-0 z-10"
          style={{
            background:
              'radial-gradient(circle at center, rgba(127,29,29,0) 52%, rgba(153,27,27,0.42) 100%)',
          }}
        />
      )}

      {/* 3rd-Person Grabbed & Eaten Cutscene Overlay */}
      {hud.phase === 'DYING_CUTSCENE' && (
        <>
          <div
            className="pointer-events-none fixed inset-0 z-10"
            style={{
              background:
                'radial-gradient(circle at center, rgba(127,29,29,0) 48%, rgba(127,29,29,0.58) 100%)',
            }}
          />
          {hud.cutsceneProgress > 0.72 && (
            <div
              className="pointer-events-none fixed inset-0 z-20 bg-black"
              style={{
                opacity: Math.min(1, (hud.cutsceneProgress - 0.72) / 0.26),
              }}
            />
          )}
        </>
      )}

      {/* Active Gameplay & Spectating HUD */}
      {(hud.phase === 'PLAYING' || hud.phase === 'PAUSED' || hud.phase === 'SPECTATING') && (
        <>
          {/* Top-Left Vitals & Teammate Strip (~30% scaled down on mobile) */}
          <div
            className={`pointer-events-none fixed z-20 flex flex-col bg-zinc-950/85 border border-zinc-800/90 rounded-lg ${
              compact
                ? 'top-2.5 left-2.5 w-44 p-2 gap-1.5'
                : 'top-4 left-4 w-64 p-3.5 gap-2.5'
            }`}
          >
            {hud.phase !== 'SPECTATING' ? (
              <>
                {/* HP */}
                <div className="flex flex-col gap-0.5">
                  <div
                    className={`flex items-center justify-between ${
                      compact ? 'text-[9px]' : 'text-xs'
                    }`}
                  >
                    <span className="flex items-center gap-1 font-medium text-zinc-200">
                      <Heart className={`${compact ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5'} text-red-500`} />
                      체력
                    </span>
                    <span className="font-mono-num text-zinc-200">
                      {hud.hp}/{hud.maxHp}
                      {hud.hp <= 35 ? ' · 위험' : ''}
                    </span>
                  </div>
                  <div className={`${compact ? 'h-1.5' : 'h-2'} w-full rounded-sm bg-zinc-800 overflow-hidden`}>
                    <div
                      className={`h-full transition-all duration-150 ${
                        hud.hp <= 35 ? 'bg-red-500' : 'bg-red-600'
                      }`}
                      style={{ width: `${(hud.hp / hud.maxHp) * 100}%` }}
                    />
                  </div>
                </div>

                {/* Stamina */}
                <div className="flex flex-col gap-0.5">
                  <div
                    className={`flex items-center justify-between ${
                      compact ? 'text-[9px]' : 'text-xs'
                    }`}
                  >
                    <span className="flex items-center gap-1 font-medium text-zinc-200">
                      <Zap className={`${compact ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5'} text-amber-400`} />
                      스태미나
                    </span>
                    <span
                      className={`font-mono-num ${
                        hud.exhausted
                          ? 'text-red-400'
                          : hud.staminaBoostActive
                          ? 'text-emerald-400'
                          : 'text-zinc-300'
                      }`}
                    >
                      {hud.stamina}%
                      {hud.exhausted ? ' · 탈진' : hud.staminaBoostActive ? ' · 가속' : ''}
                    </span>
                  </div>
                  <div className={`${compact ? 'h-1' : 'h-1.5'} w-full rounded-sm bg-zinc-800 overflow-hidden`}>
                    <div
                      className={`h-full transition-all duration-100 ${
                        hud.exhausted
                          ? 'bg-red-500'
                          : hud.staminaBoostActive
                          ? 'bg-emerald-400'
                          : 'bg-amber-400'
                      }`}
                      style={{ width: `${(hud.stamina / hud.maxStamina) * 100}%` }}
                    />
                  </div>
                </div>

                {/* Flashlight */}
                <div
                  className={`flex items-center justify-between border-t border-zinc-800/80 ${
                    compact ? 'pt-1 text-[9px]' : 'pt-1.5 text-xs'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => engineRef.current?.toggleFlashlight()}
                    className="pointer-events-auto flex items-center gap-1 text-zinc-200 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {hud.flashlightOn ? (
                      <Flashlight className={`${compact ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5'} text-amber-300`} />
                    ) : (
                      <FlashlightOff className={`${compact ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5'} text-zinc-500`} />
                    )}
                    <span>손전등</span>
                    <span className={hud.flashlightOn ? 'text-amber-300' : 'text-zinc-500'}>
                      {hud.flashlightOn ? 'ON' : 'OFF'}
                    </span>
                  </button>
                  <span className="font-mono-num text-zinc-300">{hud.battery}%</span>
                </div>

                {/* Stored Medkits */}
                <div
                  className={`flex items-center justify-between border-t border-zinc-800/80 ${
                    compact ? 'pt-1 text-[9px]' : 'pt-1.5 text-xs'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => engineRef.current?.useMedkit()}
                    className={`pointer-events-auto flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      hud.medkits > 0
                        ? 'text-emerald-300 hover:text-emerald-200'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <Plus
                      className={`${compact ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5'} ${
                        hud.medkits > 0 ? 'text-emerald-400' : 'text-zinc-500'
                      }`}
                    />
                    <span>구급상자</span>
                    {!compact && <span className="text-[10px] text-zinc-500">[H]</span>}
                  </button>
                  <span
                    className={`font-mono-num font-semibold ${
                      hud.medkits > 0 ? 'text-emerald-300' : 'text-zinc-500'
                    }`}
                  >
                    {hud.medkits}개
                  </span>
                </div>

                {/* Crouch Stealth & Dynamic Personal Circulation Limit */}
                {(hud.crouching || hud.crouchLocked || hud.crouchTime > 0.2) && (
                  <div className={`flex flex-col gap-0.5 border-t border-zinc-800/80 ${compact ? 'pt-1' : 'pt-1.5'}`}>
                    <div
                      className={`flex items-center justify-between ${
                        compact ? 'text-[8.5px]' : 'text-xs'
                      }`}
                    >
                      <span
                        className={`font-medium ${
                          hud.crouchLocked
                            ? 'text-red-400'
                            : hud.crouching
                            ? 'text-emerald-400'
                            : 'text-zinc-400'
                        }`}
                      >
                        {hud.crouchLocked
                          ? '다리 저림 · 강제 기립'
                          : hud.crouching
                          ? '웅크리기 은신'
                          : '혈류 회복'}
                      </span>
                      <span
                        className={`font-mono-num ${
                          hud.crouchLocked || hud.crouchTime >= hud.maxCrouchSeconds * 0.72
                            ? 'text-red-400'
                            : 'text-zinc-300'
                        }`}
                      >
                        {hud.crouchTime.toFixed(1)}/{hud.maxCrouchSeconds.toFixed(1)}s
                      </span>
                    </div>
                    <div className={`${compact ? 'h-1' : 'h-1.5'} w-full rounded-sm bg-zinc-800 overflow-hidden`}>
                      <div
                        className={`h-full transition-all duration-75 ${
                          hud.crouchLocked || hud.crouchTime >= hud.maxCrouchSeconds * 0.72
                            ? 'bg-red-500'
                            : hud.crouching
                            ? 'bg-emerald-400'
                            : 'bg-zinc-500'
                        }`}
                        style={{
                          width: `${Math.min(100, (hud.crouchTime / hud.maxCrouchSeconds) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className={`flex flex-col gap-1 ${compact ? 'text-[9px]' : 'text-xs'}`}>
                <div className="flex items-center gap-1 text-red-400 font-semibold">
                  <Eye className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
                  <span>팀원 관전 중</span>
                </div>
                <div className="text-zinc-200 font-bold truncate">
                  {hud.spectatingName || '생존자 탐색 중'}
                </div>
                <button
                  type="button"
                  onClick={() => engineRef.current?.cycleSpectatorTarget()}
                  className={`pointer-events-auto mt-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-medium cursor-pointer whitespace-nowrap shrink-0 ${
                    compact ? 'px-2 py-1 text-[9px]' : 'px-2.5 py-1 text-xs'
                  }`}
                >
                  다음 생존자 시점
                </button>
              </div>
            )}

            {/* Multiplayer Teammate Status List */}
            {hud.isMultiplayer && hud.teammates.length > 0 && (
              <div
                className={`flex flex-col gap-1 border-t border-zinc-800/80 ${
                  compact ? 'pt-1 text-[8.5px]' : 'pt-1.5 text-[11px]'
                }`}
              >
                <div className="flex items-center justify-between text-zinc-400">
                  <span>팀원 ({hud.playerCount}인 협동)</span>
                  <span className="font-mono-num">은신 {hud.maxCrouchSeconds.toFixed(1)}s</span>
                </div>
                {hud.teammates.map((tm) => (
                  <div key={tm.id} className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 truncate text-zinc-200">
                      <span
                        className="inline-block w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: hexColorCss(tm.color) }}
                      />
                      <span className="truncate">{tm.name}</span>
                    </span>
                    <span
                      className={`font-mono-num shrink-0 ${
                        !tm.alive
                          ? 'text-red-400'
                          : tm.hp <= 35
                          ? 'text-amber-400'
                          : 'text-emerald-400'
                      }`}
                    >
                      {tm.alive ? `${Math.ceil(tm.hp)}%` : '사망'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Top-Center Siren Head Boss Bar & Notices */}
          <div
            className={`pointer-events-none fixed left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1.5 w-full ${
              compact ? 'top-2.5 max-w-[200px] px-2' : 'top-4 max-w-md px-4 gap-2.5'
            }`}
          >
            {hud.sirenVisibleBar && (
              <div
                className={`w-full bg-zinc-950/88 border border-red-900/60 rounded-lg ${
                  compact ? 'px-2.5 py-1.5' : 'px-4 py-2.5'
                }`}
              >
                <div
                  className={`flex items-center justify-between ${
                    compact ? 'text-[9px] mb-1' : 'text-xs mb-1.5'
                  }`}
                >
                  <span className="font-bold tracking-wide text-red-400">
                    사이렌 헤드
                    {hud.sirenState === 'CHASE'
                      ? ' · 추격'
                      : hud.sirenState === 'INVESTIGATE'
                      ? ' · 수색'
                      : ''}
                  </span>
                  <span className="font-mono-num text-zinc-200">
                    {hud.sirenHp.toLocaleString()} / {hud.sirenMaxHp.toLocaleString()}
                  </span>
                </div>
                <div className={`${compact ? 'h-1.5' : 'h-2'} w-full rounded-sm bg-zinc-900 overflow-hidden`}>
                  <div
                    className="h-full bg-red-600 transition-all duration-100"
                    style={{ width: `${(hud.sirenHp / hud.sirenMaxHp) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {hud.notice && (
              <div
                className={`rounded-lg border font-medium text-center ${
                  compact ? 'px-2.5 py-1 text-[9px]' : 'px-4 py-2 text-xs'
                } ${
                  hud.notice.tone === 'danger'
                    ? 'bg-red-950/95 border-red-700/80 text-red-100'
                    : hud.notice.tone === 'warning'
                    ? 'bg-amber-950/95 border-amber-700/80 text-amber-100'
                    : hud.notice.tone === 'success'
                    ? 'bg-emerald-950/95 border-emerald-700/80 text-emerald-100'
                    : 'bg-zinc-950/90 border-zinc-700/80 text-zinc-100'
                }`}
              >
                {hud.notice.text}
              </div>
            )}
          </div>

          {/* Top-Right Survival Timer, Mobile Pad Toggle & Audio/Lock Controls */}
          <div
            className={`fixed z-20 flex items-center ${
              compact ? 'top-2.5 right-2.5 gap-1' : 'top-4 right-4 gap-2'
            }`}
          >
            <div
              className={`pointer-events-none flex items-center bg-zinc-950/85 border border-zinc-800/90 rounded-lg ${
                compact ? 'px-2 py-1 text-[10px]' : 'px-3.5 py-2 text-xs'
              }`}
            >
              <span className={`font-mono-num font-semibold text-zinc-100 ${compact ? 'text-[10px]' : 'text-sm'}`}>
                {formatTime(hud.elapsedSeconds)}
              </span>
            </div>

            <button
              type="button"
              onClick={handleToggleMobileMode}
              title="모바일 가상 조이스틱/버튼 모드 전환"
              aria-label="모바일 패드 전환"
              className={`rounded-lg bg-zinc-950/85 border transition-colors cursor-pointer ${
                compact ? 'p-1.5' : 'p-2.5'
              } ${
                hud.mobileControlsEnabled
                  ? 'border-sky-500/80 text-sky-400'
                  : 'border-zinc-800/90 text-zinc-300 hover:text-white hover:border-zinc-600'
              }`}
            >
              <Smartphone className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
            </button>

            {!hud.mobileControlsEnabled && (
              <button
                type="button"
                onClick={() => void engineRef.current?.toggleFullscreenLock()}
                title="전체화면으로 Ctrl+W 브라우저 닫힘 방지 키락 전환"
                aria-label="전체화면 키락"
                className={`rounded-lg bg-zinc-950/85 border transition-colors cursor-pointer ${
                  compact ? 'p-1.5' : 'p-2.5'
                } ${
                  hud.keyboardLocked
                    ? 'border-emerald-600/80 text-emerald-400 hover:border-emerald-400'
                    : 'border-zinc-800/90 text-zinc-300 hover:text-white hover:border-zinc-600'
                }`}
              >
                {hud.keyboardLocked ? (
                  <Lock className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
                ) : (
                  <LockOpen className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
                )}
              </button>
            )}

            <button
              type="button"
              onClick={() => engineRef.current?.toggleMute()}
              aria-label={hud.muted ? '음소거 해제' : '음소거'}
              className={`rounded-lg bg-zinc-950/85 border border-zinc-800/90 text-zinc-300 hover:text-white hover:border-zinc-600 transition-colors cursor-pointer ${
                compact ? 'p-1.5' : 'p-2.5'
              }`}
            >
              {hud.muted ? (
                <VolumeX className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
              ) : (
                <Volume2 className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
              )}
            </button>

            {!hud.isMultiplayer && hud.phase !== 'SPECTATING' && (
              <button
                type="button"
                onClick={() => engineRef.current?.setPaused(hud.phase !== 'PAUSED')}
                aria-label="일시정지"
                className={`rounded-lg bg-zinc-950/85 border border-zinc-800/90 text-zinc-300 hover:text-white hover:border-zinc-600 transition-colors cursor-pointer ${
                  compact ? 'p-1.5' : 'p-2.5'
                }`}
              >
                {hud.phase === 'PAUSED' ? (
                  <Play className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
                ) : (
                  <Pause className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
                )}
              </button>
            )}
          </div>

          {/* Bottom-Center Loot Prompt (Desktop & Non-overlapping on Mobile) */}
          {hud.nearbyCrate && hud.phase === 'PLAYING' && !hud.mobileControlsEnabled && (
            <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-20">
              <button
                type="button"
                onClick={() => engineRef.current?.tryLootNearbyCrate()}
                className={`flex items-center gap-2.5 rounded-lg bg-zinc-950/92 border border-amber-500/70 hover:border-amber-400 text-left shadow-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  compact ? 'px-2.5 py-1.5' : 'px-4 py-2.5'
                }`}
              >
                <span
                  className={`px-1.5 py-0.5 rounded bg-amber-500 text-zinc-950 font-mono-num font-bold ${
                    compact ? 'text-[9px]' : 'text-xs'
                  }`}
                >
                  E
                </span>
                <div className="flex flex-col">
                  <span className={`font-bold text-zinc-100 ${compact ? 'text-[9.5px]' : 'text-xs'}`}>
                    {hud.nearbyCrate.label} 파밍
                  </span>
                  <span className={`${compact ? 'text-[8.5px]' : 'text-[11px]'} text-zinc-400`}>
                    {hud.nearbyCrate.sublabel}
                  </span>
                </div>
              </button>
            </div>
          )}

          {/* Weapon Status Bar (Bottom-Left on Desktop, Bottom-Center on Mobile to clear Joystick) */}
          {hud.phase !== 'SPECTATING' && (
            <div
              className={`pointer-events-none fixed z-20 flex items-center bg-zinc-950/85 border border-zinc-800/90 rounded-lg ${
                hud.mobileControlsEnabled
                  ? 'bottom-2.5 left-1/2 -translate-x-1/2 gap-2 px-2.5 py-1.5'
                  : compact
                  ? 'bottom-2.5 left-2.5 gap-2 px-2.5 py-1.5'
                  : 'bottom-4 left-4 gap-4 px-4 py-2.5'
              }`}
            >
              <Crosshair
                className={`${compact ? 'w-3 h-3' : 'w-4 h-4'} ${
                  hud.hasAK47 ? 'text-amber-400' : 'text-zinc-500'
                }`}
              />
              {hud.hasAK47 ? (
                <div className="flex flex-col gap-0.5">
                  <div className={`flex items-center gap-2 ${compact ? 'text-[9px]' : 'text-xs'}`}>
                    <span className="font-bold text-zinc-100">AK-47</span>
                    <span className="text-zinc-500">·</span>
                    <span
                      className={`font-mono-num font-bold text-amber-300 ${
                        compact ? 'text-[10px]' : 'text-sm'
                      }`}
                    >
                      {hud.ammoInMag} / {hud.reserveAmmo}
                    </span>
                    {hud.reloading && (
                      <span className="text-amber-400 font-medium">재장전 중</span>
                    )}
                  </div>
                  {hud.reloading && (
                    <div className={`${compact ? 'w-24' : 'w-36'} h-1 rounded-sm bg-zinc-800 overflow-hidden`}>
                      <div
                        className="h-full bg-amber-400"
                        style={{ width: `${Math.round(hud.reloadProgress * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className={`${compact ? 'text-[9px]' : 'text-xs'} text-zinc-300 whitespace-nowrap`}>
                  무장 없음 · <span className="text-zinc-400">감시탑 AK-47 파밍</span>
                </div>
              )}
            </div>
          )}

          {/* Desktop Key Hints */}
          {!hud.mobileControlsEnabled && (
            <div className="pointer-events-none fixed bottom-4 right-4 z-20 hidden md:flex items-center gap-2 text-[11px] text-zinc-400 bg-zinc-950/80 border border-zinc-800/80 rounded-lg px-3 py-2">
              <span>WASD 이동</span>
              <span>·</span>
              <span>Shift 달리기</span>
              <span>·</span>
              <span>C / L-Ctrl 웅크리기(은신)</span>
              <span>·</span>
              <span>F 손전등</span>
              <span>·</span>
              <span>E 파밍</span>
              <span>·</span>
              <span>H 구급상자</span>
              <span>·</span>
              <span>좌클릭/Space 사격 · 우클릭 조준 · R 장전</span>
            </div>
          )}

          {/* Mobile Virtual Joystick (Bottom-Left) & Interactive Action Buttons (Bottom-Right) */}
          {hud.phase === 'PLAYING' && hud.mobileControlsEnabled && (
            <>
              {/* Left Virtual Joystick */}
              <div
                onPointerDown={handleJoyPointerDown}
                onPointerMove={handleJoyPointerMove}
                onPointerUp={handleJoyPointerEnd}
                onPointerCancel={handleJoyPointerEnd}
                onLostPointerCapture={handleJoyPointerEnd}
                className="fixed bottom-4 left-4 z-20 w-28 h-28 rounded-full bg-zinc-950/55 border border-zinc-600/70 flex items-center justify-center touch-none cursor-pointer"
                aria-label="이동 조이스틱"
              >
                <div className="absolute inset-3 rounded-full border border-zinc-700/40 pointer-events-none" />
                <div
                  className="w-11 h-11 rounded-full bg-zinc-200/85 border border-white/70 shadow-md pointer-events-none"
                  style={{
                    transform: `translate(${joyKnob.x * 38}px, ${joyKnob.y * 38}px)`,
                  }}
                />
              </div>

              {/* Right Interactive Virtual Buttons Cluster (Multi-touch onPointerDown + drag-to-look) */}
              <div className="fixed bottom-4 right-3 z-20 flex flex-col items-end gap-1.5 touch-none">
                {/* Loot Contextual Button */}
                {hud.nearbyCrate && (
                  <button
                    type="button"
                    onPointerDown={(e) =>
                      handleActionButtonDown(e, () => engineRef.current?.tryLootNearbyCrate())
                    }
                    onPointerMove={handleActionButtonMove}
                    onPointerUp={(e) => handleActionButtonEnd(e)}
                    onPointerCancel={(e) => handleActionButtonEnd(e)}
                    onLostPointerCapture={(e) => handleActionButtonEnd(e)}
                    className="px-3 py-1.5 rounded-lg bg-amber-500 text-zinc-950 font-bold text-[10px] shadow-lg border border-amber-300 whitespace-nowrap shrink-0 cursor-pointer touch-none"
                  >
                    [E] {hud.nearbyCrate.label} 파밍
                  </button>
                )}

                {/* Row 1: ADS, Reload, Medkit, Flashlight */}
                <div className="flex items-center gap-1.5">
                  {hud.hasAK47 && (
                    <button
                      type="button"
                      onPointerDown={(e) =>
                        handleActionButtonDown(e, () => engineRef.current?.toggleVirtualAim())
                      }
                      onPointerMove={handleActionButtonMove}
                      onPointerUp={(e) => handleActionButtonEnd(e)}
                      onPointerCancel={(e) => handleActionButtonEnd(e)}
                      onLostPointerCapture={(e) => handleActionButtonEnd(e)}
                      className={`px-2.5 py-1.5 rounded-lg border text-[9.5px] font-semibold whitespace-nowrap shrink-0 cursor-pointer touch-none ${
                        hud.aiming
                          ? 'bg-amber-500/90 border-amber-300 text-zinc-950'
                          : 'bg-zinc-950/80 border-zinc-700 text-zinc-200'
                      }`}
                    >
                      조준
                    </button>
                  )}
                  {hud.hasAK47 && (
                    <button
                      type="button"
                      onPointerDown={(e) =>
                        handleActionButtonDown(e, () => engineRef.current?.tryReload())
                      }
                      onPointerMove={handleActionButtonMove}
                      onPointerUp={(e) => handleActionButtonEnd(e)}
                      onPointerCancel={(e) => handleActionButtonEnd(e)}
                      onLostPointerCapture={(e) => handleActionButtonEnd(e)}
                      className="px-2.5 py-1.5 rounded-lg bg-zinc-950/80 border border-zinc-700 text-zinc-200 text-[9.5px] font-semibold whitespace-nowrap shrink-0 cursor-pointer touch-none"
                    >
                      장전
                    </button>
                  )}
                  <button
                    type="button"
                    onPointerDown={(e) =>
                      handleActionButtonDown(e, () => engineRef.current?.useMedkit())
                    }
                    onPointerMove={handleActionButtonMove}
                    onPointerUp={(e) => handleActionButtonEnd(e)}
                    onPointerCancel={(e) => handleActionButtonEnd(e)}
                    onLostPointerCapture={(e) => handleActionButtonEnd(e)}
                    className={`px-2.5 py-1.5 rounded-lg border text-[9.5px] font-semibold whitespace-nowrap shrink-0 cursor-pointer touch-none flex items-center gap-1 ${
                      hud.medkits > 0 && hud.hp < hud.maxHp
                        ? 'bg-emerald-500/90 border-emerald-300 text-zinc-950'
                        : hud.medkits > 0
                        ? 'bg-emerald-950/85 border-emerald-500/70 text-emerald-200'
                        : 'bg-zinc-950/80 border-zinc-800 text-zinc-500'
                    }`}
                  >
                    <Plus className="w-2.5 h-2.5" />
                    <span>구급</span>
                    <span className="font-mono-num">{hud.medkits}</span>
                  </button>
                  <button
                    type="button"
                    onPointerDown={(e) =>
                      handleActionButtonDown(e, () => engineRef.current?.toggleFlashlight())
                    }
                    onPointerMove={handleActionButtonMove}
                    onPointerUp={(e) => handleActionButtonEnd(e)}
                    onPointerCancel={(e) => handleActionButtonEnd(e)}
                    onLostPointerCapture={(e) => handleActionButtonEnd(e)}
                    className={`px-2.5 py-1.5 rounded-lg border text-[9.5px] font-semibold whitespace-nowrap shrink-0 cursor-pointer touch-none ${
                      hud.flashlightOn
                        ? 'bg-amber-400/20 border-amber-400/70 text-amber-200'
                        : 'bg-zinc-950/80 border-zinc-700 text-zinc-400'
                    }`}
                  >
                    손전등
                  </button>
                </div>

                {/* Row 2: Crouch, Sprint, Big Fire Button */}
                <div className="flex items-end gap-1.5">
                  <button
                    type="button"
                    onPointerDown={(e) =>
                      handleActionButtonDown(e, () => engineRef.current?.toggleVirtualCrouch())
                    }
                    onPointerMove={handleActionButtonMove}
                    onPointerUp={(e) => handleActionButtonEnd(e)}
                    onPointerCancel={(e) => handleActionButtonEnd(e)}
                    onLostPointerCapture={(e) => handleActionButtonEnd(e)}
                    className={`px-2.5 py-2 rounded-lg border text-[9.5px] font-semibold whitespace-nowrap shrink-0 cursor-pointer touch-none ${
                      hud.crouchLocked
                        ? 'bg-red-950/80 border-red-700 text-red-300'
                        : hud.crouching
                        ? 'bg-emerald-500/90 border-emerald-300 text-zinc-950'
                        : 'bg-zinc-950/80 border-zinc-700 text-zinc-200'
                    }`}
                  >
                    웅크리기
                  </button>
                  <button
                    type="button"
                    onPointerDown={(e) =>
                      handleActionButtonDown(e, () => engineRef.current?.toggleVirtualSprint())
                    }
                    onPointerMove={handleActionButtonMove}
                    onPointerUp={(e) => handleActionButtonEnd(e)}
                    onPointerCancel={(e) => handleActionButtonEnd(e)}
                    onLostPointerCapture={(e) => handleActionButtonEnd(e)}
                    className={`px-2.5 py-2 rounded-lg border text-[9.5px] font-semibold whitespace-nowrap shrink-0 cursor-pointer touch-none ${
                      hud.sprinting
                        ? 'bg-amber-500/90 border-amber-300 text-zinc-950'
                        : 'bg-zinc-950/80 border-zinc-700 text-zinc-200'
                    }`}
                  >
                    달리기
                  </button>
                  <button
                    type="button"
                    onPointerDown={(e) =>
                      handleActionButtonDown(
                        e,
                        () => {
                          if (hud.hasAK47) engineRef.current?.setVirtualFire(true);
                        },
                        true
                      )
                    }
                    onPointerMove={handleActionButtonMove}
                    onPointerUp={(e) => handleActionButtonEnd(e, true)}
                    onPointerCancel={(e) => handleActionButtonEnd(e, true)}
                    onLostPointerCapture={(e) => handleActionButtonEnd(e, true)}
                    className={`w-14 h-14 rounded-full border-2 font-bold text-[10px] flex items-center justify-center whitespace-nowrap shrink-0 cursor-pointer touch-none ${
                      hud.hasAK47
                        ? 'bg-red-600/90 active:bg-red-500 border-red-300 text-white shadow-lg'
                        : 'bg-zinc-900/75 border-zinc-700 text-zinc-500'
                    }`}
                  >
                    사격
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* Title Menu & Multiplayer Lobby (~30% scaled down on mobile) */}
      {hud.phase === 'TITLE_MENU' && (
        <div
          className={`fixed inset-0 z-30 flex items-center justify-center bg-gradient-to-b from-black/75 via-black/60 to-black/85 ${
            compact ? 'p-3' : 'p-6'
          }`}
        >
          <div
            className={`w-full bg-zinc-950/92 border border-zinc-800 rounded-xl max-h-[94vh] overflow-y-auto ${
              compact ? 'max-w-sm p-4' : 'max-w-xl p-7'
            }`}
          >
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <span className={`font-medium tracking-wide text-red-400 ${compact ? 'text-[9px]' : 'text-xs'}`}>
                1인칭 3D 야간 폭우 생존 호러
              </span>
              <button
                type="button"
                onClick={handleToggleMobileMode}
                className={`flex items-center gap-1 rounded border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  compact ? 'px-2 py-0.5 text-[9px]' : 'px-2.5 py-1 text-xs'
                } ${
                  hud.mobileControlsEnabled
                    ? 'bg-sky-500/20 border-sky-500 text-sky-300'
                    : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-500'
                }`}
              >
                <Smartphone className={compact ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5'} />
                <span>모바일 UI {hud.mobileControlsEnabled ? 'ON' : 'OFF'}</span>
              </button>
            </div>

            <h1
              className={`font-display font-bold tracking-tight text-white ${
                compact ? 'text-2xl mb-2' : 'text-4xl sm:text-5xl mb-3'
              }`}
            >
              사이렌 헤드의 숲 3D
            </h1>
            <p className={`leading-relaxed text-zinc-300 ${compact ? 'text-[10px] mb-3' : 'text-sm mb-5'}`}>
              폭우가 쏟아지는 어두운 3D 숲속, 무작위 산불감시탑에 올라가 AK-47을 파밍하고
              거대한 사이렌 헤드를 처치하세요.
            </p>

            {/* Mode Switch: Solo vs 4-Player Co-op Lobby */}
            <div className={`grid grid-cols-2 gap-2 ${compact ? 'mb-3' : 'mb-5'}`}>
              <button
                type="button"
                onClick={() => {
                  if (room) mpRef.current?.leaveRoom();
                  setLobbyTab('SOLO');
                }}
                className={`flex items-center justify-center gap-1.5 rounded-lg border font-semibold transition-colors cursor-pointer ${
                  compact ? 'py-1.5 text-[10px]' : 'py-2.5 text-xs'
                } ${
                  lobbyTab === 'SOLO'
                    ? 'bg-zinc-100 text-zinc-950 border-white'
                    : 'bg-zinc-900 text-zinc-300 border-zinc-800 hover:border-zinc-600'
                }`}
              >
                <Shield className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
                <span>솔로 생존 (1인)</span>
              </button>
              <button
                type="button"
                onClick={() => setLobbyTab('MULTI')}
                className={`flex items-center justify-center gap-1.5 rounded-lg border font-semibold transition-colors cursor-pointer ${
                  compact ? 'py-1.5 text-[10px]' : 'py-2.5 text-xs'
                } ${
                  lobbyTab === 'MULTI'
                    ? 'bg-red-600 text-white border-red-500'
                    : 'bg-zinc-900 text-zinc-300 border-zinc-800 hover:border-zinc-600'
                }`}
              >
                <Users className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
                <span>멀티 협동 (최대 4인)</span>
              </button>
            </div>

            {lobbyTab === 'SOLO' ? (
              <>
                <div
                  className={`grid grid-cols-1 sm:grid-cols-2 border-y border-zinc-800/90 ${
                    compact ? 'gap-2.5 py-2.5 mb-3 text-[9.5px]' : 'gap-4 py-4 mb-5 text-xs'
                  } text-zinc-300`}
                >
                  <div className="space-y-1">
                    <div className="font-semibold text-zinc-100">3D 숲 물리 및 은신</div>
                    <p className="text-zinc-400 leading-relaxed">
                      나뭇잎은 통과 가능하지만 나무 기둥은 이동을 막습니다. 손전등과 사격은 사이렌
                      헤드를 유인하며, 웅크리기(15초 제한)로 은신할 수 있습니다.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <div className="font-semibold text-zinc-100">산불감시탑 및 전투</div>
                    <p className="text-zinc-400 leading-relaxed">
                      AK-47 피해량 20, 사이렌 체력 2,000입니다. 감시탑에서 포위될 경우 30% 확률로
                      탑이 영구 붕괴됩니다.
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className={`text-zinc-400 ${compact ? 'text-[9px]' : 'text-xs'}`}>
                    {hud.mobileControlsEnabled
                      ? '좌측 조이스틱 이동 · 우측 드래그 시점 전환 · 가상 버튼 전투'
                      : 'WASD 이동 · Shift 달리기 · C / L-Ctrl 웅크리기 · F 손전등 · 우클릭 조준 · E 파밍'}
                  </div>
                  <button
                    type="button"
                    onClick={() => engineRef.current?.startGame()}
                    className={`rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      compact ? 'px-4 py-2 text-xs' : 'px-6 py-3 text-sm'
                    }`}
                  >
                    생존 시작
                  </button>
                </div>
              </>
            ) : (
              <div className={`flex flex-col ${compact ? 'gap-2.5 text-[9.5px]' : 'gap-4 text-xs'}`}>
                {/* Nickname */}
                <div className="flex items-center gap-2">
                  <label className="text-zinc-400 whitespace-nowrap shrink-0">닉네임</label>
                  <input
                    type="text"
                    maxLength={14}
                    value={playerName}
                    onChange={(e) => setPlayerName(e.target.value)}
                    disabled={Boolean(room)}
                    placeholder="생존자 이름"
                    className={`flex-1 rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-100 focus:outline-none focus:border-zinc-500 disabled:opacity-60 ${
                      compact ? 'px-2.5 py-1 text-[10px]' : 'px-3 py-2 text-xs'
                    }`}
                  />
                  <span
                    className={`font-mono-num whitespace-nowrap shrink-0 ${
                      mpConnected ? 'text-emerald-400' : 'text-amber-400'
                    }`}
                  >
                    {mpConnected ? '서버 연결됨' : '연결 중...'}
                  </span>
                </div>

                {roomError && (
                  <div className="px-3 py-1.5 rounded-lg bg-red-950/90 border border-red-800 text-red-200">
                    {roomError}
                  </div>
                )}

                {!room ? (
                  <div className={`grid grid-cols-1 sm:grid-cols-2 ${compact ? 'gap-2' : 'gap-3'}`}>
                    <div className={`rounded-lg bg-zinc-900/80 border border-zinc-800 flex flex-col justify-between ${compact ? 'p-2.5 gap-2' : 'p-4 gap-3'}`}>
                      <div>
                        <div className="font-bold text-zinc-100 mb-0.5">새 방 만들기</div>
                        <p className="text-zinc-400">
                          5자리 방 코드를 생성해 최대 4인의 팀원을 초대합니다.
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={!mpConnected}
                        onClick={() => {
                          setRoomError(null);
                          mpRef.current?.createRoom(playerName);
                        }}
                        className={`w-full rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-bold transition-colors cursor-pointer ${
                          compact ? 'py-1.5 text-[10px]' : 'py-2.5 text-xs'
                        }`}
                      >
                        방 코드 생성하기
                      </button>
                    </div>

                    <div className={`rounded-lg bg-zinc-900/80 border border-zinc-800 flex flex-col justify-between ${compact ? 'p-2.5 gap-2' : 'p-4 gap-3'}`}>
                      <div>
                        <div className="font-bold text-zinc-100 mb-1">방 코드로 입장</div>
                        <input
                          type="text"
                          maxLength={6}
                          value={joinCodeInput}
                          onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                          placeholder="방 코드 5자리 (예: A7K9P)"
                          className={`w-full rounded-lg bg-zinc-950 border border-zinc-700 font-mono-num uppercase text-zinc-100 focus:outline-none focus:border-zinc-500 ${
                            compact ? 'px-2 py-1 text-[10px]' : 'px-3 py-2 text-xs'
                          }`}
                        />
                      </div>
                      <button
                        type="button"
                        disabled={!mpConnected || joinCodeInput.trim().length < 4}
                        onClick={() => {
                          setRoomError(null);
                          mpRef.current?.joinRoom(joinCodeInput.trim(), playerName);
                        }}
                        className={`w-full rounded-lg bg-zinc-100 hover:bg-white disabled:opacity-40 text-zinc-950 font-bold transition-colors cursor-pointer ${
                          compact ? 'py-1.5 text-[10px]' : 'py-2.5 text-xs'
                        }`}
                      >
                        방 입장하기
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={`rounded-lg bg-zinc-900/80 border border-zinc-800 flex flex-col ${compact ? 'p-2.5 gap-2' : 'p-4 gap-3'}`}>
                    <div className="flex items-center justify-between gap-2 pb-2 border-b border-zinc-800">
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-400">방 코드</span>
                        <span
                          className={`font-mono-num font-bold tracking-widest text-amber-300 ${
                            compact ? 'text-sm' : 'text-lg'
                          }`}
                        >
                          {room.code}
                        </span>
                        <button
                          type="button"
                          onClick={handleCopyCode}
                          className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 cursor-pointer"
                          title="방 코드 복사"
                        >
                          {copiedCode ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                      <span className="font-mono-num text-zinc-300">
                        {room.players.length} / {room.maxPlayers}명
                      </span>
                    </div>

                    {/* Player List */}
                    <div className="grid grid-cols-2 gap-1.5">
                      {room.players.map((p) => (
                        <div
                          key={p.id}
                          className={`flex items-center justify-between rounded bg-zinc-950/80 border border-zinc-800 ${
                            compact ? 'px-2 py-1' : 'px-3 py-1.5'
                          }`}
                        >
                          <span className="flex items-center gap-1.5 truncate">
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: hexColorCss(p.color) }}
                            />
                            <span className="truncate font-medium text-zinc-100">{p.name}</span>
                          </span>
                          {p.isHost && (
                            <span className="text-[9px] font-bold text-amber-400 shrink-0">
                              방장
                            </span>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Dynamic Multiplayer Scaling Rules */}
                    <div
                      className={`grid grid-cols-3 gap-1.5 rounded bg-zinc-950/70 border border-zinc-800/80 text-center ${
                        compact ? 'p-1.5 text-[8.5px]' : 'p-2.5 text-[11px]'
                      }`}
                    >
                      <div>
                        <div className="text-zinc-400">감시탑 AK-47</div>
                        <div className="font-mono-num font-bold text-amber-300">
                          {previewCount}정 생성
                        </div>
                      </div>
                      <div>
                        <div className="text-zinc-400">사이렌 체력</div>
                        <div className="font-mono-num font-bold text-red-400">
                          {(previewCount * 2000).toLocaleString()}
                        </div>
                      </div>
                      <div>
                        <div className="text-zinc-400">개인 은신 제한</div>
                        <div className="font-mono-num font-bold text-emerald-400">
                          {(MAX_CROUCH_SECONDS / previewCount).toFixed(1)}초
                        </div>
                      </div>
                    </div>

                    <div className="text-zinc-400">
                      멀티플레이 시 사이렌 헤드는 웅크리지 않은 랜덤한 생존자를 추격합니다.
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => mpRef.current?.leaveRoom()}
                        className={`rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-semibold cursor-pointer whitespace-nowrap shrink-0 ${
                          compact ? 'px-3 py-1.5 text-[9.5px]' : 'px-4 py-2 text-xs'
                        }`}
                      >
                        방 나가기
                      </button>

                      {isHost ? (
                        <button
                          type="button"
                          onClick={() => mpRef.current?.startRoom()}
                          className={`rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold cursor-pointer whitespace-nowrap shrink-0 ${
                            compact ? 'px-4 py-1.5 text-[10px]' : 'px-6 py-2.5 text-sm'
                          }`}
                        >
                          협동 생존 시작 ({room.players.length}인)
                        </button>
                      ) : (
                        <span className="text-zinc-300 font-medium">
                          방장이 게임을 시작하기를 기다리는 중...
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Pause Modal (Solo only) */}
      {hud.phase === 'PAUSED' && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/75 p-4">
          <div
            className={`w-full bg-zinc-950 border border-zinc-800 rounded-xl text-center ${
              compact ? 'max-w-xs p-4' : 'max-w-sm p-6'
            }`}
          >
            <h2 className={`font-bold text-white mb-1.5 ${compact ? 'text-base' : 'text-xl'}`}>
              일시 정지
            </h2>
            <p className={`text-zinc-400 mb-5 ${compact ? 'text-[9.5px]' : 'text-xs'}`}>
              계속하기를 눌러 1인칭 시점으로 숲에 복귀하세요.
            </p>
            <div className="flex items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={() => engineRef.current?.setPaused(false)}
                className={`rounded-lg bg-zinc-100 hover:bg-white text-zinc-950 font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  compact ? 'px-3.5 py-1.5 text-[10px]' : 'px-5 py-2.5 text-xs'
                }`}
              >
                계속하기
              </button>
              <button
                type="button"
                onClick={() => engineRef.current?.startGame()}
                className={`rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  compact ? 'px-3.5 py-1.5 text-[10px]' : 'px-5 py-2.5 text-xs'
                }`}
              >
                처음부터 다시
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Victory / Game Over Modal */}
      {(hud.phase === 'VICTORY' || hud.phase === 'GAME_OVER') && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/80 p-4">
          <div
            className={`w-full bg-zinc-950 border border-zinc-800 rounded-xl ${
              compact ? 'max-w-xs p-4' : 'max-w-md p-7'
            }`}
          >
            <div
              className={`font-semibold mb-1 ${compact ? 'text-[9.5px]' : 'text-xs'} ${
                hud.phase === 'VICTORY' ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              {hud.phase === 'VICTORY' ? '생존 및 처치 성공' : '생존 실패'}
            </div>
            <h2 className={`font-display font-bold text-white mb-1.5 ${compact ? 'text-xl' : 'text-3xl'}`}>
              {hud.phase === 'VICTORY'
                ? '사이렌이 멈췄습니다'
                : '어둠 속에 삼켜졌습니다'}
            </h2>
            <p className={`text-zinc-300 mb-4 ${compact ? 'text-[10px]' : 'text-sm'}`}>
              {hud.phase === 'VICTORY'
                ? `AK-47로 체력 ${hud.sirenMaxHp.toLocaleString()} 사이렌 헤드를 쓰러뜨리고 폭우 속 숲에서 살아남았습니다.`
                : hud.causeOfDeath || '사이렌 헤드의 공격으로 쓰러졌습니다.'}
            </p>

            <div
              className={`grid grid-cols-2 border-y border-zinc-800 mb-5 ${
                compact ? 'gap-2 py-2.5 text-[9.5px]' : 'gap-3 py-4 text-xs'
              }`}
            >
              <div>
                <div className="text-zinc-400">생존 시간</div>
                <div className={`font-mono-num font-bold text-zinc-100 mt-0.5 ${compact ? 'text-xs' : 'text-base'}`}>
                  {formatTime(hud.elapsedSeconds)}
                </div>
              </div>
              <div>
                <div className="text-zinc-400">명중률</div>
                <div className={`font-mono-num font-bold text-zinc-100 mt-0.5 ${compact ? 'text-xs' : 'text-base'}`}>
                  {accuracy}% ({hud.shotsHit}/{hud.shotsFired})
                </div>
              </div>
              <div>
                <div className="text-zinc-400">파괴된 나무</div>
                <div className={`font-mono-num font-bold text-zinc-100 mt-0.5 ${compact ? 'text-xs' : 'text-base'}`}>
                  {hud.treesDestroyed}그루
                </div>
              </div>
              <div>
                <div className="text-zinc-400">산불감시탑</div>
                <div className={`font-bold text-zinc-100 mt-0.5 ${compact ? 'text-xs' : 'text-base'}`}>
                  {hud.towerCollapsed ? '영구 붕괴됨' : '온전함'}
                </div>
              </div>
            </div>

            {hud.isMultiplayer ? (
              <button
                type="button"
                onClick={handleBackToLobby}
                className={`w-full flex items-center justify-center gap-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  compact ? 'px-4 py-2 text-xs' : 'px-5 py-3 text-sm'
                }`}
              >
                <RotateCcw className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
                대기실 로비로 돌아가기
              </button>
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => engineRef.current?.startGame()}
                  className={`flex-1 flex items-center justify-center gap-2 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    compact ? 'px-3 py-2 text-xs' : 'px-5 py-3 text-sm'
                  }`}
                >
                  <RotateCcw className={compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
                  다시 플레이
                </button>
                <button
                  type="button"
                  onClick={handleBackToLobby}
                  className={`rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    compact ? 'px-3 py-2 text-xs' : 'px-4 py-3 text-sm'
                  }`}
                >
                  로비
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
