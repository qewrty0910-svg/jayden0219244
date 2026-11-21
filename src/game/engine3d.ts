import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HorrorAudioEngine } from './audio';
import {
  createAK47ViewModel,
  createLootCrateModel,
  createSirenHeadModel,
  createSurvivorModel,
  createWatchtowerModels,
  type AK47ViewModel,
  type SirenHeadRig,
  type SurvivorRig,
  type WatchtowerModels,
} from './models3d';
import { TreeSpatialGrid3D } from './spatialGrid3d';
import { createProceduralTextures, type ForestTextures } from './textures3d';
import {
  AK47_DAMAGE,
  groundHeightAt,
  MAX_CROUCH_SECONDS,
  SIREN_BASE_HP,
  SIREN_MAX_HP,
  TOWER_COLLAPSE_CHANCE,
  TOWER_DECK_HEIGHT,
  TOWER_RAMP_RUN,
  WORLD_HALF,
  type GamePhase,
  type HudSnapshot,
  type LootCrateData,
  type MultiplayerStartPayload,
  type RemotePlayerState,
  type SirenAIState,
  type ToastNotice,
  type TreeRecord,
  type WorldTickPayload,
} from './types';
import { generateWorldLayout } from './worldGen';

export interface MultiplayerSink {
  sendPlayerState: (state: {
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
  }) => void;
  sendCrateLoot: (crateId: number) => void;
  sendSirenHit: () => void;
  sendPlayerShot: () => void;
  sendPlayerDied: () => void;
}

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

function rayCircleXZ(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  maxDist: number,
  cx: number,
  cz: number,
  r: number
): number {
  const fx = ox - cx;
  const fz = oz - cz;
  const a = dx * dx + dz * dz;
  if (a < 0.0001) return maxDist;
  const b = 2 * (fx * dx + fz * dz);
  const c = fx * fx + fz * fz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return maxDist;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  if (t > 0 && t < maxDist) return t;
  return maxDist;
}

const TREE_COUNT = 1850;
const RAIN_COUNT = 600;
const PARTICLE_POOL = 48;

// Pre-allocated math helpers (zero GC inside animation loop)
const _dummy = new THREE.Object3D();
const _vecA = new THREE.Vector3();
const _vecB = new THREE.Vector3();
const _vecRight = new THREE.Vector3();
const _quatA = new THREE.Quaternion();
const _eulerA = new THREE.Euler(0, 0, 0, 'YXZ');
const _colorTarget = new THREE.Color();

export class SirenForest3DEngine {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private isSoftwareGl: boolean;
  private textures: ForestTextures;
  private audio = new HorrorAudioEngine();
  private onHudUpdate: (hud: HudSnapshot) => void;

  private rafId: number | null = null;
  private timerId: number | null = null;
  private disposed = false;
  private lastTime = 0;
  private hudSyncTimer = 0;

  // Lighting
  private hemiLight!: THREE.HemisphereLight;
  private moonLight!: THREE.DirectionalLight;
  private flashlight!: THREE.SpotLight;
  private flashlightTarget!: THREE.Object3D;
  private closeAuraLight!: THREE.PointLight;
  private cutsceneLight!: THREE.PointLight;
  private envRT: THREE.WebGLRenderTarget | null = null;

  // World & Forest InstancedMeshes
  private grid = new TreeSpatialGrid3D(12);
  private trees: TreeRecord[] = [];
  private nearbyScratch: TreeRecord[] = [];
  private trunkInst!: THREE.InstancedMesh;
  private canopy1Inst!: THREE.InstancedMesh;
  private canopy2Inst!: THREE.InstancedMesh;
  private canopy3Inst!: THREE.InstancedMesh;
  private stumpInst!: THREE.InstancedMesh;
  private fallenLogInst!: THREE.InstancedMesh;

  // Watchtower & Crates
  private towerGroup = new THREE.Group();
  private towerModels!: WatchtowerModels;
  private towerX = 0;
  private towerZ = 0;
  private towerGroundY = 0;
  private towerCollapsed = false;
  private towerShakeTimer = 0;
  private beaconPhase = 0;
  private crates: LootCrateData[] = [];
  private crateMeshes: THREE.Group[] = [];

  // Siren Head
  private sirenRig!: SirenHeadRig;
  private sirenX = 0;
  private sirenZ = 0;
  private sirenY = 0;
  private sirenAngle = 0;
  private sirenHp = SIREN_MAX_HP;
  private sirenMaxHp = SIREN_BASE_HP;
  private sirenState: SirenAIState = 'PATROL';
  private sirenTargetX = 0;
  private sirenTargetZ = 0;
  private sirenInvestigateTimer = 0;
  private sirenPatrolTimer = 0;
  private sirenAttackCooldown = 0;
  private sirenTowerStrikeCooldown = 0;
  private sirenStepTimer = 0;
  private sirenWalkCycle = 0;
  private sirenHitFlashTimer = 0;
  private sirenAlerted = false;
  private sirenDead = false;
  private sirenDeathTimer = 0;

  // Multiplayer & Scaling
  private isMultiplayer = false;
  private roomCode: string | null = null;
  private localPlayerId: string | null = null;
  private playerCount = 1;
  private maxCrouchSeconds = MAX_CROUCH_SECONDS;
  private networkSink: MultiplayerSink | null = null;
  private netStateAccum = 0;
  private sirenNetTargetX = 0;
  private sirenNetTargetY = 0;
  private sirenNetTargetZ = 0;
  private sirenNetTargetAngle = 0;
  private spectateIndex = 0;
  private spectatingName: string | null = null;
  private remotePlayers = new Map<
    string,
    {
      rig: SurvivorRig;
      state: RemotePlayerState;
      targetX: number;
      targetY: number;
      targetZ: number;
      targetYaw: number;
      walkPhase: number;
    }
  >();

  // 1st-Person Player & Viewmodel + 3rd-Person Survivor Cutscene Rig
  private ak47View!: AK47ViewModel;
  private survivorRig!: SurvivorRig;
  private playerX = 0;
  private playerY = 0;
  private playerZ = 0;
  private playerYaw = 0;
  private playerPitch = 0;
  private playerHp = 100;
  private playerMaxHp = 100;
  private medkits = 0;
  private stamina = 100;
  private maxStamina = 100;
  private exhausted = false;
  private staminaBoostTimer = 0;
  private crouching = false;
  private sprinting = false;
  private crouchTime = 0;
  private crouchLockTimer = 0;
  private eyeHeight = 1.68;
  private flashlightOn = true;
  private battery = 100;
  private hasAK47 = false;
  private ammoInMag = 0;
  private magSize = 30;
  private reserveAmmo = 0;
  private reloading = false;
  private reloadTimer = 0;
  private reloadDuration = 1.75;
  private fireCooldown = 0;
  private muzzleFlashTimer = 0;
  private hurtFlashTimer = 0;
  private hitMarkerTimer = 0;
  private walkCycle = 0;
  private recoilPitchKick = 0;
  private recoilZKick = 0;
  private shakeMag = 0;
  private cutsceneTime = 0;
  private cutsceneDuration = 3.5;
  private cutsceneDevourPlayed = false;

  // Tracer & Rain & 3D Particles
  private raycaster = new THREE.Raycaster();
  private tracerLine!: THREE.Line;
  private tracerTimer = 0;
  private rainLines!: THREE.LineSegments;
  private rainPos!: Float32Array;
  private particles: {
    mesh: THREE.Mesh;
    vx: number;
    vy: number;
    vz: number;
    life: number;
  }[] = [];

  // Lightning & Game Stats
  private lightningAlpha = 0;
  private lightningTimer = 12;
  private thunderDelay = -1;
  private phase: GamePhase = 'TITLE_MENU';
  private elapsedSeconds = 0;
  private shotsFired = 0;
  private shotsHit = 0;
  private treesDestroyed = 0;
  private causeOfDeath = '';
  private notice: ToastNotice | null = null;
  private noticeSeq = 1;

  // Inputs & Mobile Virtual Controls
  private keys = new Set<string>();
  private mouseDown = false;
  private rightMouseDown = false;
  private aiming = false;
  private aimBlend = 0;
  private draggingLook = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private pointerLocked = false;
  private keyboardLocked = false;
  private mobileControlsEnabled = false;
  private virtualMoveX = 0;
  private virtualMoveY = 0;
  private virtualSprint = false;
  private virtualCrouch = false;
  private virtualAim = false;
  private virtualFire = false;

  constructor(container: HTMLElement, onHudUpdate: (hud: HudSnapshot) => void) {
    this.container = container;
    this.onHudUpdate = onHudUpdate;

    // Software WebGL detection per Three.js skill guidelines
    this.isSoftwareGl = (() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);

    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x020408);
    this.scene.fog = new THREE.FogExp2(0x020408, 0.03);

    const aspect = (container.clientWidth || window.innerWidth) / (container.clientHeight || window.innerHeight);
    this.camera = new THREE.PerspectiveCamera(74, aspect, 0.1, 125);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    // Studio Environment Reflection (RoomEnvironment) heavily dimmed for pitch-dark forest night
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new RoomEnvironment();
    this.envRT = pmrem.fromScene(envScene, 0.04);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.06;
    envScene.dispose();
    pmrem.dispose();

    const maxAniso = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    this.textures = createProceduralTextures(maxAniso);

    this.setupLighting();
    this.setupTerrain();
    this.setupRainAndParticles();
    this.setupViewModel();
    this.setupWatchtowerAndSiren();
    this.setupForestInstances();

    this.resetWorld('TITLE_MENU');
    this.bindEvents();

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.lastTime = performance.now();
    this.scheduleNextTick();
  }

  private setupLighting(): void {
    this.hemiLight = new THREE.HemisphereLight(0x0d1522, 0x040604, 0.11);
    this.scene.add(this.hemiLight);

    this.moonLight = new THREE.DirectionalLight(0x4b6a8c, 0.07);
    this.moonLight.position.set(45, 75, -35);
    this.scene.add(this.moonLight);

    // 1st-Person High-Lumen Flashlight SpotLight (512 shadow map for fast frame pacing)
    this.flashlight = new THREE.SpotLight(0xfff4de, 155, 78, 0.48, 0.52, 1.3);
    this.flashlight.castShadow = !this.isSoftwareGl;
    this.flashlight.shadow.mapSize.set(512, 512);
    this.flashlight.shadow.camera.near = 0.4;
    this.flashlight.shadow.camera.far = 58;
    this.flashlight.shadow.bias = -0.0005;

    this.flashlightTarget = new THREE.Object3D();
    this.scene.add(this.flashlight);
    this.scene.add(this.flashlightTarget);
    this.flashlight.target = this.flashlightTarget;

    // Minimal close dark-adaptation aura when flashlight is OFF
    this.closeAuraLight = new THREE.PointLight(0x52657d, 0.22, 4.5, 2.0);
    this.scene.add(this.closeAuraLight);

    // Dramatic lighting for 3rd-person death cutscene
    this.cutsceneLight = new THREE.PointLight(0xdbeafe, 0, 26, 1.4);
    this.scene.add(this.cutsceneLight);
  }

  private setupTerrain(): void {
    const size = WORLD_HALF * 2 + 120;
    const geo = new THREE.PlaneGeometry(size, size, 72, 72);
    geo.rotateX(-Math.PI * 0.5);

    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, groundHeightAt(x, z));
    }
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      map: this.textures.groundColor,
      roughnessMap: this.textures.groundRoughness,
      roughness: 0.92,
      metalness: 0.04,
    });
    const terrain = new THREE.Mesh(geo, mat);
    terrain.receiveShadow = true;
    this.scene.add(terrain);
  }

  private setupRainAndParticles(): void {
    // 3D Rain streaks wrapped in a camera-local volume
    const rainGeo = new THREE.BufferGeometry();
    this.rainPos = new Float32Array(RAIN_COUNT * 6);
    for (let i = 0; i < RAIN_COUNT; i++) {
      const rx = (Math.random() - 0.5) * 26;
      const ry = Math.random() * 16;
      const rz = (Math.random() - 0.5) * 26;
      const idx = i * 6;
      this.rainPos[idx] = rx;
      this.rainPos[idx + 1] = ry;
      this.rainPos[idx + 2] = rz;
      this.rainPos[idx + 3] = rx - 0.08;
      this.rainPos[idx + 4] = ry + 0.55;
      this.rainPos[idx + 5] = rz - 0.05;
    }
    rainGeo.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    const rainMat = new THREE.LineBasicMaterial({
      color: 0xaac4de,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });
    this.rainLines = new THREE.LineSegments(rainGeo, rainMat);
    this.rainLines.frustumCulled = false;
    this.scene.add(this.rainLines);

    // Tracer line for AK-47 shots
    const tGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(0, 0, -1),
    ]);
    const tMat = new THREE.LineBasicMaterial({
      color: 0xfef08a,
      transparent: true,
      opacity: 0.88,
    });
    this.tracerLine = new THREE.Line(tGeo, tMat);
    this.tracerLine.visible = false;
    this.tracerLine.frustumCulled = false;
    this.scene.add(this.tracerLine);

    // 3D Particle Pool (wood splinters, sparks, crimson bursts)
    const pGeo = new THREE.BoxGeometry(0.14, 0.14, 0.32);
    for (let i = 0; i < PARTICLE_POOL; i++) {
      const pMat = new THREE.MeshBasicMaterial({ color: 0x8b6a4b });
      const mesh = new THREE.Mesh(pGeo, pMat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.particles.push({ mesh, vx: 0, vy: 0, vz: 0, life: 0 });
    }
  }

  private setupViewModel(): void {
    this.ak47View = createAK47ViewModel();
    this.ak47View.root.position.set(0.24, -0.22, -0.35);
    this.ak47View.root.visible = false;
    this.camera.add(this.ak47View.root);
  }

  private setupWatchtowerAndSiren(): void {
    this.towerModels = createWatchtowerModels(this.textures);
    this.towerGroup.add(this.towerModels.intactGroup, this.towerModels.collapsedGroup);
    this.scene.add(this.towerGroup);

    this.sirenRig = createSirenHeadModel(this.textures);
    this.scene.add(this.sirenRig.root);

    this.survivorRig = createSurvivorModel();
    this.survivorRig.root.visible = false;
    this.scene.add(this.survivorRig.root);
  }

  private setupForestInstances(): void {
    // Solid Trunks (0.45m radius, 12m tall)
    const trunkGeo = new THREE.CylinderGeometry(0.26, 0.5, 12.2, 7);
    trunkGeo.translate(0, 6.1, 0);
    const trunkMat = new THREE.MeshStandardMaterial({
      map: this.textures.barkColor,
      color: 0x5c4636,
      roughness: 0.94,
      metalness: 0.02,
    });
    this.trunkInst = new THREE.InstancedMesh(trunkGeo, trunkMat, TREE_COUNT);
    this.trunkInst.castShadow = !this.isSoftwareGl;
    this.trunkInst.receiveShadow = true;
    this.trunkInst.frustumCulled = false;

    // 3 Passable Pine Foliage Canopy Tiers (FrontSide avoids inside-canopy view block & halves shading cost)
    const canopyMat = new THREE.MeshStandardMaterial({
      map: this.textures.foliageColor,
      color: 0x1a3522,
      roughness: 0.88,
      metalness: 0.02,
      side: THREE.FrontSide,
    });
    const c1Geo = new THREE.ConeGeometry(2.75, 4.4, 7);
    c1Geo.translate(0, 3.8, 0); // Low leaves from 1.6m to 6.0m (walk right through!)
    const c2Geo = new THREE.ConeGeometry(2.2, 4.1, 7);
    c2Geo.translate(0, 6.8, 0);
    const c3Geo = new THREE.ConeGeometry(1.55, 3.6, 7);
    c3Geo.translate(0, 9.6, 0);

    this.canopy1Inst = new THREE.InstancedMesh(c1Geo, canopyMat, TREE_COUNT);
    this.canopy2Inst = new THREE.InstancedMesh(c2Geo, canopyMat, TREE_COUNT);
    this.canopy3Inst = new THREE.InstancedMesh(c3Geo, canopyMat, TREE_COUNT);
    this.canopy1Inst.castShadow = false;
    this.canopy1Inst.frustumCulled = false;
    this.canopy2Inst.frustumCulled = false;
    this.canopy3Inst.frustumCulled = false;

    // Permanent Destroyed Tree Stumps & Fallen Logs
    const stumpGeo = new THREE.CylinderGeometry(0.36, 0.52, 0.95, 7);
    stumpGeo.translate(0, 0.45, 0);
    const stumpMat = new THREE.MeshStandardMaterial({
      map: this.textures.barkColor,
      color: 0x70533c,
      roughness: 0.92,
    });
    this.stumpInst = new THREE.InstancedMesh(stumpGeo, stumpMat, TREE_COUNT);
    this.stumpInst.receiveShadow = true;
    this.stumpInst.frustumCulled = false;

    const fallenGeo = new THREE.CylinderGeometry(0.24, 0.42, 9.5, 7);
    fallenGeo.rotateZ(Math.PI * 0.5);
    fallenGeo.translate(5.2, 0.36, 0);
    this.fallenLogInst = new THREE.InstancedMesh(fallenGeo, trunkMat, TREE_COUNT);
    this.fallenLogInst.receiveShadow = true;
    this.fallenLogInst.frustumCulled = false;

    this.scene.add(
      this.trunkInst,
      this.canopy1Inst,
      this.canopy2Inst,
      this.canopy3Inst,
      this.stumpInst,
      this.fallenLogInst
    );
  }

  private bindEvents(): void {
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('keydown', this.handleKeyDown, { capture: true });
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    document.addEventListener('fullscreenchange', this.handleFullscreenChange);
    document.addEventListener('mousemove', this.handleMouseMove);

    const dom = this.renderer.domElement;
    dom.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    dom.addEventListener('contextmenu', this.handleContextMenu);
    dom.addEventListener('webglcontextlost', this.handleContextLost);
  }

  destroy(): void {
    this.disposed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.timerId !== null) clearTimeout(this.timerId);
    this.audio.stopSirenLoop();
    this.releaseKeyboardLock();

    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }

    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('keydown', this.handleKeyDown, { capture: true });
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
    document.removeEventListener('mousemove', this.handleMouseMove);

    const dom = this.renderer.domElement;
    dom.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    dom.removeEventListener('contextmenu', this.handleContextMenu);
    dom.removeEventListener('webglcontextlost', this.handleContextLost);

    this.scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const m = obj as THREE.Mesh;
        m.geometry?.dispose();
        if (Array.isArray(m.material)) {
          m.material.forEach((mat) => mat.dispose());
        } else {
          m.material?.dispose();
        }
      }
    });
    this.envRT?.dispose();
    Object.values(this.textures).forEach((t) => t.dispose());
    this.renderer.dispose();
    dom.remove();
  }

  private handleContextLost = (e: Event): void => {
    e.preventDefault();
  };

  private handleResize = (): void => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
  };

  private handlePointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
    if (!this.pointerLocked) {
      this.mouseDown = false;
      this.rightMouseDown = false;
      this.aiming = false;
    }
    this.emitHud();
  };

  private handleBlur = (): void => {
    this.keys.clear();
    this.mouseDown = false;
    this.rightMouseDown = false;
    this.aiming = false;
    this.draggingLook = false;
  };

  private handleContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
  };

  private handleMouseDown = (e: MouseEvent): void => {
    if (this.phase !== 'PLAYING') return;
    this.audio.resume();

    if (this.mobileControlsEnabled) {
      return;
    }

    if (!this.pointerLocked) {
      this.requestLock();
      if (e.button === 0) {
        this.draggingLook = true;
        this.lastPointerX = e.clientX;
        this.lastPointerY = e.clientY;
      }
    }

    if (e.button === 0) {
      this.mouseDown = true;
    } else if (e.button === 2) {
      this.rightMouseDown = true;
    }
  };

  private handleMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.mouseDown = false;
      this.draggingLook = false;
    } else if (e.button === 2) {
      this.rightMouseDown = false;
    }
  };

  private handleMouseMove = (e: MouseEvent): void => {
    if (this.phase !== 'PLAYING') return;
    const sens = 0.0022 * (this.aiming ? 0.62 : 1);
    if (this.pointerLocked) {
      this.playerYaw -= e.movementX * sens;
      this.playerPitch = clamp(this.playerPitch - e.movementY * sens, -1.42, 1.42);
    } else if (this.draggingLook) {
      const dx = e.clientX - this.lastPointerX;
      const dy = e.clientY - this.lastPointerY;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      this.playerYaw -= dx * sens * 1.4;
      this.playerPitch = clamp(this.playerPitch - dy * sens * 1.4, -1.42, 1.42);
    }
  };

  private handleBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (this.phase === 'PLAYING' || this.phase === 'PAUSED' || this.phase === 'DYING_CUTSCENE') {
      e.preventDefault();
      e.returnValue = '';
    }
  };

  private handleFullscreenChange = (): void => {
    if (!document.fullscreenElement) {
      this.releaseKeyboardLock();
    }
    this.emitHud();
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    const code = e.code;
    if (code === 'Escape') {
      if (this.phase === 'PLAYING' && !this.pointerLocked) {
        this.setPaused(true);
      } else if (this.phase === 'PAUSED') {
        this.setPaused(false);
      }
      return;
    }
    if (this.phase !== 'PLAYING') return;
    if (code === 'ControlLeft' || code === 'ControlRight' || e.ctrlKey || e.metaKey) {
      e.preventDefault();
    }
    this.keys.add(code);

    if (code === 'KeyF') {
      this.toggleFlashlight();
    } else if (code === 'KeyE') {
      this.tryLootNearbyCrate();
    } else if (code === 'KeyR') {
      this.tryReload();
    } else if (code === 'KeyH') {
      this.useMedkit();
    }
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private async engageKeyboardLock(): Promise<void> {
    if (this.disposed) return;
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // Fullscreen may be restricted in embedded preview iframes; fallback guards remain active
    }
    try {
      const kb = (
        navigator as Navigator & {
          keyboard?: { lock?: (keyCodes?: string[]) => Promise<void>; unlock?: () => void };
        }
      ).keyboard;
      if (kb?.lock && document.fullscreenElement) {
        await kb.lock(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'ControlLeft']);
        this.keyboardLocked = true;
      }
    } catch {
      this.keyboardLocked = false;
    }
    this.emitHud();
  }

  private releaseKeyboardLock(): void {
    try {
      const kb = (
        navigator as Navigator & {
          keyboard?: { unlock?: () => void };
        }
      ).keyboard;
      kb?.unlock?.();
    } catch {
      // ignore
    }
    this.keyboardLocked = false;
  }

  async toggleFullscreenLock(): Promise<void> {
    if (document.fullscreenElement) {
      this.releaseKeyboardLock();
      try {
        await document.exitFullscreen();
      } catch {
        // ignore
      }
    } else {
      this.requestLock();
      await this.engageKeyboardLock();
    }
    this.emitHud();
  }

  setNetworkSink(sink: MultiplayerSink | null): void {
    this.networkSink = sink;
  }

  setMobileControlsEnabled(enabled: boolean): void {
    this.mobileControlsEnabled = enabled;
    if (!enabled) {
      this.virtualMoveX = 0;
      this.virtualMoveY = 0;
      this.virtualSprint = false;
      this.virtualCrouch = false;
      this.virtualAim = false;
      this.virtualFire = false;
    } else if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.emitHud();
  }

  setVirtualMove(x: number, y: number): void {
    this.virtualMoveX = clamp(x, -1, 1);
    this.virtualMoveY = clamp(y, -1, 1);
  }

  toggleVirtualSprint(): void {
    this.virtualSprint = !this.virtualSprint;
    if (this.virtualSprint) this.virtualCrouch = false;
    this.emitHud();
  }

  toggleVirtualCrouch(): void {
    if (this.crouchLockTimer > 0) return;
    this.virtualCrouch = !this.virtualCrouch;
    if (this.virtualCrouch) this.virtualSprint = false;
    this.emitHud();
  }

  toggleVirtualAim(): void {
    if (!this.hasAK47) return;
    this.virtualAim = !this.virtualAim;
    this.emitHud();
  }

  setVirtualFire(firing: boolean): void {
    this.audio.resume();
    this.virtualFire = firing;
  }

  applyTouchLook(dx: number, dy: number): void {
    if (this.phase !== 'PLAYING') return;
    const sens = 0.0044 * (this.aiming ? 0.62 : 1);
    this.playerYaw -= dx * sens;
    this.playerPitch = clamp(this.playerPitch - dy * sens, -1.42, 1.42);
  }

  cycleSpectatorTarget(): void {
    this.spectateIndex++;
    this.emitHud();
  }

  requestLock(): void {
    if (this.phase !== 'PLAYING' || this.mobileControlsEnabled) return;
    if (document.pointerLockElement === this.renderer.domElement) return;
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    if (ua && !ua.isActive) return;
    try {
      const res = this.renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined;
      if (res && typeof res.catch === 'function') {
        res.catch(() => {
          // Ignore when browser denies pointer lock (e.g., ESC cooldown or iframe policy)
        });
      }
    } catch {
      // ignore
    }
  }

  startGame(): void {
    this.isMultiplayer = false;
    this.roomCode = null;
    this.localPlayerId = null;
    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.resetWorld('PLAYING', seed, 1);
    this.audio.startSirenLoop();
    this.pushNotice('어두운 3D 숲 어딘가의 산불감시탑에서 AK-47을 찾으세요.', 'info', 5);
    if (!this.mobileControlsEnabled) {
      this.requestLock();
      void this.engageKeyboardLock();
    }
    this.emitHud();
  }

  startMultiplayerGame(payload: MultiplayerStartPayload, localPlayerId: string): void {
    this.isMultiplayer = true;
    this.roomCode = payload.roomCode;
    this.localPlayerId = localPlayerId;
    const spawn = payload.spawnPositions[localPlayerId];
    this.resetWorld('PLAYING', payload.seed, payload.playerCount, spawn);

    for (const p of payload.players) {
      if (p.id === localPlayerId) continue;
      const rig = createSurvivorModel(p.color, true);
      const sp = payload.spawnPositions[p.id] || { x: 0, z: 0 };
      const sy = groundHeightAt(sp.x, sp.z);
      rig.root.position.set(sp.x, sy, sp.z);
      this.scene.add(rig.root);
      this.remotePlayers.set(p.id, {
        rig,
        state: {
          id: p.id,
          name: p.name,
          color: p.color,
          x: sp.x,
          y: sy,
          z: sp.z,
          yaw: 0,
          crouching: false,
          flashlightOn: true,
          hasAK47: false,
          alive: true,
          hp: 100,
          maxHp: 100,
        },
        targetX: sp.x,
        targetY: sy,
        targetZ: sp.z,
        targetYaw: 0,
        walkPhase: 0,
      });
    }

    this.audio.startSirenLoop();
    this.pushNotice(
      `${payload.playerCount}인 협동 시작! 감시탑 AK-47 ${payload.playerCount}정 · 사이렌 체력 ${payload.sirenMaxHp.toLocaleString()} · 은신 ${payload.maxCrouchSeconds.toFixed(1)}초`,
      'info',
      5.5
    );
    this.emitHud();
  }

  returnToTitleMenu(): void {
    this.isMultiplayer = false;
    this.roomCode = null;
    this.localPlayerId = null;
    this.audio.stopSirenLoop();
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.resetWorld('TITLE_MENU');
    this.emitHud();
  }

  applyWorldTick(tick: WorldTickPayload): void {
    if (!this.isMultiplayer) return;
    if (this.phase === 'TITLE_MENU') return;

    this.sirenNetTargetX = tick.sirenX;
    this.sirenNetTargetY = tick.sirenY;
    this.sirenNetTargetZ = tick.sirenZ;
    this.sirenNetTargetAngle = tick.sirenAngle;
    this.sirenHp = tick.sirenHp;
    this.sirenMaxHp = tick.sirenMaxHp;
    this.sirenState = tick.sirenState;
    this.elapsedSeconds = tick.elapsedSeconds;

    if (tick.sirenState === 'CHASE' || tick.sirenState === 'INVESTIGATE' || tick.sirenHp < tick.sirenMaxHp) {
      this.sirenAlerted = true;
    } else if (tick.sirenState === 'PATROL' && tick.sirenHp >= tick.sirenMaxHp) {
      this.sirenAlerted = false;
    }

    if (tick.sirenDead && !this.sirenDead) {
      this.handleSirenDefeated();
    }

    const seenIds = new Set<string>();
    for (const p of tick.players) {
      if (p.id === this.localPlayerId) continue;
      seenIds.add(p.id);
      const existing = this.remotePlayers.get(p.id);
      if (existing) {
        existing.state = p;
        existing.targetX = p.x;
        existing.targetY = p.y;
        existing.targetZ = p.z;
        existing.targetYaw = p.yaw;
        existing.rig.root.visible = p.alive;
        if (existing.rig.flashlightCone) {
          existing.rig.flashlightCone.visible = p.alive && p.flashlightOn;
        }
        if (existing.rig.gunMesh) {
          existing.rig.gunMesh.visible = p.alive && p.hasAK47;
        }
      }
    }
    for (const [id, entry] of this.remotePlayers.entries()) {
      if (!seenIds.has(id)) {
        this.scene.remove(entry.rig.root);
        this.remotePlayers.delete(id);
      }
    }
  }

  applyCrateLooted(crateId: number, byPlayerId: string): void {
    const idx = this.crates.findIndex((c) => c.id === crateId);
    if (idx < 0) return;
    const crate = this.crates[idx];
    if (crate.looted) return;
    crate.looted = true;
    this.crateMeshes[idx].visible = false;
    if (byPlayerId === this.localPlayerId) {
      this.grantLootItem(crate);
    }
    this.emitHud();
  }

  applyTreeDestroyed(id: number, angle: number): void {
    const t = this.trees[id];
    if (!t || t.destroyed) return;
    this.destroyTreePermanently(t, angle);
    const dist = Math.hypot(t.x - this.playerX, t.z - this.playerZ);
    this.audio.playTreeSmash(dist);
    if (dist < 48) {
      this.shakeMag = Math.max(this.shakeMag, (1 - dist / 48) * 0.14);
    }
  }

  applyTowerCollapsed(
    crateRelocations: { id: number; x: number; y: number; z: number; looted: boolean }[]
  ): void {
    if (this.towerCollapsed) return;
    this.towerCollapsed = true;
    this.towerShakeTimer = 0;
    this.towerModels.intactGroup.visible = false;
    this.towerModels.collapsedGroup.visible = true;
    this.shakeMag = 0.55;
    this.audio.playTowerStrike(true);

    for (const reloc of crateRelocations) {
      const idx = this.crates.findIndex((c) => c.id === reloc.id);
      if (idx < 0) continue;
      const c = this.crates[idx];
      c.looted = reloc.looted;
      c.x = reloc.x;
      c.y = reloc.y;
      c.z = reloc.z;
      if (reloc.looted) {
        this.crateMeshes[idx].visible = false;
      } else {
        this.crateMeshes[idx].position.set(c.x, c.y, c.z);
        this.crateMeshes[idx].rotation.z = (Math.random() - 0.5) * 0.35;
      }
    }

    for (let k = 0; k < 24; k++) {
      this.spawnParticle(
        this.towerX + (Math.random() - 0.5) * 6,
        this.towerGroundY + 1.5 + Math.random() * 3,
        this.towerZ + (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 14,
        4 + Math.random() * 7,
        (Math.random() - 0.5) * 14,
        0.95,
        k % 2 === 0 ? 0x78350f : 0x64748b
      );
    }
    this.pushNotice('산불감시탑이 영구적으로 붕괴되었습니다! 잔해에서 탈출하세요!', 'danger', 4.5);
  }

  applyTowerStruck(): void {
    this.towerShakeTimer = 0.65;
    this.shakeMag = Math.max(this.shakeMag, 0.22);
    this.audio.playTowerStrike(false);
    this.pushNotice('사이렌 헤드가 감시탑을 강타했습니다! 구조물이 간신히 버팁니다!', 'warning', 2.4);
    for (let k = 0; k < 8; k++) {
      this.spawnParticle(
        this.towerX + (Math.random() - 0.5) * 5,
        this.towerGroundY + 3.5,
        this.towerZ + (Math.random() - 0.5) * 5,
        (Math.random() - 0.5) * 8,
        2 + Math.random() * 4,
        (Math.random() - 0.5) * 8,
        0.6,
        0x94a3b8
      );
    }
  }

  applyServerDamage(amount: number, reason: string): void {
    if (this.phase !== 'PLAYING') return;
    this.damagePlayer(amount, reason);
  }

  applySirenDamaged(payload: {
    sirenHp: number;
    sirenMaxHp: number;
    sirenDead: boolean;
  }): void {
    this.sirenHp = payload.sirenHp;
    this.sirenMaxHp = payload.sirenMaxHp;
    this.sirenHitFlashTimer = 0.08;
    this.sirenAlerted = true;
    if (payload.sirenDead && !this.sirenDead) {
      this.handleSirenDefeated();
    }
  }

  applyRemoteShotFx(x: number, y: number, z: number): void {
    const dist = Math.hypot(x - this.playerX, z - this.playerZ);
    if (dist < 110) {
      this.spawnParticle(x, y + 1.4, z, 0, 1.5, 0, 0.12, 0xfef08a);
    }
  }

  applyGameEnded(payload: {
    victory: boolean;
    reason: string;
    elapsedSeconds: number;
    towerCollapsed: boolean;
    treesDestroyed: number;
  }): void {
    this.elapsedSeconds = payload.elapsedSeconds;
    this.towerCollapsed = payload.towerCollapsed;
    this.treesDestroyed = Math.max(this.treesDestroyed, payload.treesDestroyed);
    this.phase = payload.victory ? 'VICTORY' : 'GAME_OVER';
    if (!payload.victory && payload.reason) {
      this.causeOfDeath = payload.reason;
    }
    this.survivorRig.root.visible = false;
    this.cutsceneLight.intensity = 0;
    this.audio.stopSirenLoop();
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    this.emitHud();
  }

  setPaused(paused: boolean): void {
    if (this.isMultiplayer) return;
    if (this.phase !== 'PLAYING' && this.phase !== 'PAUSED') return;
    this.phase = paused ? 'PAUSED' : 'PLAYING';
    this.keys.clear();
    this.mouseDown = false;
    this.rightMouseDown = false;
    this.aiming = false;
    this.audio.setPaused(paused);
    if (paused && document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    } else if (!paused) {
      this.requestLock();
    }
    this.emitHud();
  }

  toggleMute(): void {
    this.audio.setMuted(!this.audio.isMuted());
    this.emitHud();
  }

  toggleFlashlight(): void {
    if (this.phase !== 'PLAYING') return;
    if (!this.flashlightOn && this.battery <= 1) {
      this.pushNotice('손전등 배터리가 부족합니다. 잠시 끄거나 배터리를 찾으세요.', 'warning', 2.5);
      return;
    }
    this.flashlightOn = !this.flashlightOn;
    this.audio.playFlashlightClick(this.flashlightOn);
    this.emitHud();
  }

  tryReload(): void {
    if (this.hasAK47 && !this.reloading && this.ammoInMag < this.magSize && this.reserveAmmo > 0) {
      this.reloading = true;
      this.reloadTimer = this.reloadDuration;
      this.audio.playReload();
      this.emitHud();
    }
  }

  private resetWorld(
    targetPhase: GamePhase,
    seed = (Math.random() * 0xffffffff) >>> 0,
    playerCount = 1,
    spawnPos?: { x: number; z: number }
  ): void {
    this.phase = targetPhase;
    this.keys.clear();
    this.mouseDown = false;
    this.rightMouseDown = false;
    this.aiming = false;
    this.aimBlend = 0;
    this.virtualMoveX = 0;
    this.virtualMoveY = 0;
    this.virtualSprint = false;
    this.virtualCrouch = false;
    this.virtualAim = false;
    this.virtualFire = false;
    this.elapsedSeconds = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.treesDestroyed = 0;
    this.causeOfDeath = '';
    this.notice = null;
    this.shakeMag = 0;
    this.lightningAlpha = 0;
    this.lightningTimer = 11 + Math.random() * 12;
    this.thunderDelay = -1;
    this.netStateAccum = 0;
    this.spectateIndex = 0;
    this.spectatingName = null;

    this.playerCount = Math.max(1, Math.min(4, playerCount));
    this.sirenMaxHp = SIREN_BASE_HP * this.playerCount;
    this.maxCrouchSeconds = MAX_CROUCH_SECONDS / this.playerCount;

    for (const entry of this.remotePlayers.values()) {
      this.scene.remove(entry.rig.root);
    }
    this.remotePlayers.clear();

    for (const p of this.particles) {
      p.life = 0;
      p.mesh.visible = false;
    }

    const layout = generateWorldLayout(seed, this.playerCount);

    // Player spawn
    this.playerX = spawnPos ? spawnPos.x : 0;
    this.playerZ = spawnPos ? spawnPos.z : 0;
    this.playerY = groundHeightAt(this.playerX, this.playerZ);
    this.playerYaw = 0;
    this.playerPitch = 0;
    this.playerHp = 100;
    this.medkits = 0;
    this.stamina = 100;
    this.exhausted = false;
    this.staminaBoostTimer = 0;
    this.crouching = false;
    this.sprinting = false;
    this.crouchTime = 0;
    this.crouchLockTimer = 0;
    this.eyeHeight = 1.68;
    this.cutsceneTime = 0;
    this.cutsceneDevourPlayed = false;
    this.cutsceneLight.intensity = 0;
    this.survivorRig.root.visible = false;
    this.survivorRig.root.scale.set(1, 1, 1);
    this.survivorRig.root.rotation.set(0, 0, 0);
    this.flashlightOn = true;
    this.battery = 100;
    this.hasAK47 = false;
    this.ammoInMag = 0;
    this.reserveAmmo = 0;
    this.reloading = false;
    this.reloadTimer = 0;
    this.fireCooldown = 0;
    this.muzzleFlashTimer = 0;
    this.hurtFlashTimer = 0;
    this.hitMarkerTimer = 0;
    this.recoilPitchKick = 0;
    this.recoilZKick = 0;

    this.ak47View.root.visible = false;
    this.ak47View.muzzleFlash.visible = false;
    this.ak47View.muzzleLight.intensity = 0;

    // Watchtower placement
    this.towerX = layout.towerX;
    this.towerZ = layout.towerZ;
    this.towerGroundY = layout.towerGroundY;
    this.towerCollapsed = false;
    this.towerShakeTimer = 0;
    this.towerGroup.position.set(this.towerX, this.towerGroundY, this.towerZ);
    this.towerModels.intactGroup.visible = true;
    this.towerModels.collapsedGroup.visible = false;

    // Rebuild 3D Loot Crates inside Watchtower deck
    for (const m of this.crateMeshes) {
      this.scene.remove(m);
    }
    this.crateMeshes = [];
    this.crates = layout.crates;

    for (const c of this.crates) {
      const mesh = createLootCrateModel(c.type);
      mesh.position.set(c.x, c.y, c.z);
      this.scene.add(mesh);
      this.crateMeshes.push(mesh);
    }

    // Siren Head spawn
    this.sirenX = layout.sirenX;
    this.sirenZ = layout.sirenZ;
    this.sirenY = layout.sirenY;
    this.sirenAngle = Math.atan2(-this.sirenX, -this.sirenZ);
    this.sirenNetTargetX = this.sirenX;
    this.sirenNetTargetY = this.sirenY;
    this.sirenNetTargetZ = this.sirenZ;
    this.sirenNetTargetAngle = this.sirenAngle;
    this.sirenHp = this.sirenMaxHp;
    this.sirenState = 'PATROL';
    this.sirenTargetX = (Math.random() - 0.5) * 40;
    this.sirenTargetZ = (Math.random() - 0.5) * 40;
    this.sirenInvestigateTimer = 0;
    this.sirenPatrolTimer = 4;
    this.sirenAttackCooldown = 0;
    this.sirenTowerStrikeCooldown = 0;
    this.sirenStepTimer = 0;
    this.sirenWalkCycle = 0;
    this.sirenHitFlashTimer = 0;
    this.sirenAlerted = false;
    this.sirenDead = false;
    this.sirenDeathTimer = 0;

    this.sirenRig.root.position.set(this.sirenX, this.sirenY, this.sirenZ);
    this.sirenRig.root.scale.set(1, 1, 1);
    this.sirenRig.bodyPivot.rotation.set(0, 0, 0);
    this.sirenRig.bodyPivot.position.y = 0;
    this.sirenRig.leftLeg.rotation.set(0, 0, 0);
    this.sirenRig.rightLeg.rotation.set(0, 0, 0);
    this.sirenRig.leftKnee.rotation.set(0, 0, 0);
    this.sirenRig.rightKnee.rotation.set(0, 0, 0);
    this.sirenRig.leftArm.rotation.set(0, 0, 0);
    this.sirenRig.rightArm.rotation.set(0, 0, 0);
    this.sirenRig.leftElbow.rotation.set(0, 0, 0);
    this.sirenRig.rightElbow.rotation.set(0, 0, 0);
    this.sirenRig.headPole.rotation.set(0, 0, 0);

    this.applyGeneratedForest(layout.trees, layout.treeColors);
    this.syncCameraAndFlashlight(1);
  }

  private applyGeneratedForest(trees: TreeRecord[], treeColors: number[]): void {
    this.trees = trees;
    this.grid.clear();

    const color = new THREE.Color();
    for (let idx = 0; idx < trees.length; idx++) {
      const rec = trees[idx];
      this.grid.insert(rec);

      _dummy.position.set(rec.x, rec.y - 0.25, rec.z);
      _dummy.rotation.set(0, rec.rotation, 0);
      _dummy.scale.set(rec.scale, rec.scale, rec.scale);
      _dummy.updateMatrix();

      this.trunkInst.setMatrixAt(idx, _dummy.matrix);
      this.canopy1Inst.setMatrixAt(idx, _dummy.matrix);
      this.canopy2Inst.setMatrixAt(idx, _dummy.matrix);
      this.canopy3Inst.setMatrixAt(idx, _dummy.matrix);

      const rv1 = treeColors[idx] ?? 0.5;
      const rv2 = (rv1 * 7.13) % 1;
      color.setHSL(0.36 + (rv1 - 0.5) * 0.04, 0.32, 0.14 + rv2 * 0.08);
      this.canopy1Inst.setColorAt(idx, color);
      this.canopy2Inst.setColorAt(idx, color);
      this.canopy3Inst.setColorAt(idx, color);

      _dummy.scale.set(0, 0, 0);
      _dummy.updateMatrix();
      this.stumpInst.setMatrixAt(idx, _dummy.matrix);
      this.fallenLogInst.setMatrixAt(idx, _dummy.matrix);
    }

    _dummy.scale.set(0, 0, 0);
    _dummy.updateMatrix();
    for (let k = trees.length; k < TREE_COUNT; k++) {
      this.trunkInst.setMatrixAt(k, _dummy.matrix);
      this.canopy1Inst.setMatrixAt(k, _dummy.matrix);
      this.canopy2Inst.setMatrixAt(k, _dummy.matrix);
      this.canopy3Inst.setMatrixAt(k, _dummy.matrix);
      this.stumpInst.setMatrixAt(k, _dummy.matrix);
      this.fallenLogInst.setMatrixAt(k, _dummy.matrix);
    }

    this.trunkInst.instanceMatrix.needsUpdate = true;
    this.canopy1Inst.instanceMatrix.needsUpdate = true;
    this.canopy2Inst.instanceMatrix.needsUpdate = true;
    this.canopy3Inst.instanceMatrix.needsUpdate = true;
    if (this.canopy1Inst.instanceColor) this.canopy1Inst.instanceColor.needsUpdate = true;
    if (this.canopy2Inst.instanceColor) this.canopy2Inst.instanceColor.needsUpdate = true;
    if (this.canopy3Inst.instanceColor) this.canopy3Inst.instanceColor.needsUpdate = true;
    this.stumpInst.instanceMatrix.needsUpdate = true;
    this.fallenLogInst.instanceMatrix.needsUpdate = true;
  }

  private destroyTreePermanently(tree: TreeRecord, smashAngle: number): void {
    tree.destroyed = true;
    tree.destroyedAngle = smashAngle;
    this.treesDestroyed++;

    // Remove intact trunk & passable canopy forever
    _dummy.position.set(tree.x, tree.y, tree.z);
    _dummy.scale.set(0, 0, 0);
    _dummy.updateMatrix();
    this.trunkInst.setMatrixAt(tree.id, _dummy.matrix);
    this.canopy1Inst.setMatrixAt(tree.id, _dummy.matrix);
    this.canopy2Inst.setMatrixAt(tree.id, _dummy.matrix);
    this.canopy3Inst.setMatrixAt(tree.id, _dummy.matrix);
    this.trunkInst.instanceMatrix.needsUpdate = true;
    this.canopy1Inst.instanceMatrix.needsUpdate = true;
    this.canopy2Inst.instanceMatrix.needsUpdate = true;
    this.canopy3Inst.instanceMatrix.needsUpdate = true;

    // Show permanent splintered stump & fallen log debris
    _dummy.position.set(tree.x, tree.y - 0.1, tree.z);
    _dummy.rotation.set(0, tree.rotation, 0);
    _dummy.scale.set(tree.scale, tree.scale, tree.scale);
    _dummy.updateMatrix();
    this.stumpInst.setMatrixAt(tree.id, _dummy.matrix);

    _dummy.rotation.set(0, -smashAngle, 0);
    _dummy.updateMatrix();
    this.fallenLogInst.setMatrixAt(tree.id, _dummy.matrix);
    this.stumpInst.instanceMatrix.needsUpdate = true;
    this.fallenLogInst.instanceMatrix.needsUpdate = true;

    // Wood splinter particles
    for (let k = 0; k < 5; k++) {
      this.spawnParticle(
        tree.x,
        tree.y + 1.2 + Math.random() * 1.5,
        tree.z,
        (Math.random() - 0.5) * 9,
        3 + Math.random() * 4,
        (Math.random() - 0.5) * 9,
        0.7,
        0x7c5d41
      );
    }
  }

  private spawnParticle(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    colorHex: number
  ): void {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (p.life <= 0) {
        p.life = life;
        p.vx = vx;
        p.vy = vy;
        p.vz = vz;
        p.mesh.position.set(x, y, z);
        (p.mesh.material as THREE.MeshBasicMaterial).color.setHex(colorHex);
        p.mesh.visible = true;
        return;
      }
    }
  }

  private pushNotice(text: string, tone: ToastNotice['tone'], seconds = 3.2): void {
    this.notice = {
      id: this.noticeSeq++,
      text,
      tone,
      until: performance.now() + seconds * 1000,
    };
  }

  private scheduleNextTick(): void {
    if (this.disposed) return;
    if (this.isSoftwareGl) {
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
      if (!sync) {
        this.timerId = window.setTimeout(this.tick, 80);
        return;
      }
      gl.flush();
      const poll = () => {
        if (this.disposed) return;
        const state = gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          this.timerId = window.setTimeout(poll, 5);
        } else {
          gl.deleteSync(sync);
          this.timerId = window.setTimeout(this.tick, 80);
        }
      };
      this.timerId = window.setTimeout(poll, 5);
    } else {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private tick = (): void => {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;

    if (this.phase === 'PLAYING') {
      this.update(dt, now);
    } else if (this.phase === 'DYING_CUTSCENE') {
      this.updateDeathCutscene(dt);
    } else if (this.phase === 'SPECTATING') {
      this.updateSpectating(dt, now);
    } else if (this.phase === 'TITLE_MENU') {
      this.playerYaw += dt * 0.08;
      this.updateRainAndLightning(dt);
      this.syncCameraAndLightning(dt);
    }

    this.renderer.render(this.scene, this.camera);

    this.hudSyncTimer += dt;
    if (this.hudSyncTimer >= 0.095) {
      this.hudSyncTimer = 0;
      this.emitHud();
    }

    this.scheduleNextTick();
  };

  private update(dt: number, now: number): void {
    if (!this.isMultiplayer) {
      this.elapsedSeconds += dt;
    }
    this.updateRainAndLightning(dt);

    // Optional keyboard look fallback (Q)
    if (this.keys.has('KeyQ')) this.playerYaw += 1.9 * dt;

    // 1. Movement & Stamina System (Keyboard + Mobile Virtual Joystick)
    let fwd = this.virtualMoveY;
    let strafe = this.virtualMoveX;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) fwd += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) fwd -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) strafe += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) strafe -= 1;

    const mag = Math.hypot(fwd, strafe);
    const moving = mag > 0.08;
    if (mag > 1) {
      fwd /= mag;
      strafe /= mag;
    }

    if (this.staminaBoostTimer > 0) {
      this.staminaBoostTimer = Math.max(0, this.staminaBoostTimer - dt);
    }

    // 1a. Crouch Stealth (Left Ctrl, C, or mobile crouch toggle) & personal stealth time limit
    if (this.crouchLockTimer > 0) {
      this.crouchLockTimer = Math.max(0, this.crouchLockTimer - dt);
      this.crouching = false;
      this.virtualCrouch = false;
      this.crouchTime = Math.max(0, this.crouchTime - 4.7 * dt);
    } else {
      this.crouching = this.keys.has('ControlLeft') || this.keys.has('KeyC') || this.virtualCrouch;
      if (this.crouching) {
        this.crouchTime += dt;
        if (this.crouchTime >= this.maxCrouchSeconds) {
          this.crouching = false;
          this.virtualCrouch = false;
          this.crouchTime = this.maxCrouchSeconds;
          this.crouchLockTimer = 3.2;
          this.pushNotice('다리에 피가 통하지 않아 강제로 일어섭니다!', 'danger', 3.0);
        }
      } else {
        this.crouchTime = Math.max(0, this.crouchTime - 4.2 * dt);
      }
    }

    const targetEye = this.crouching ? 0.94 : 1.68;
    this.eyeHeight = THREE.MathUtils.damp(this.eyeHeight, targetEye, 12, dt);

    // 1b. Right-Click or Mobile Toggle Aim Down Sights (ADS)
    this.aiming = (this.rightMouseDown || this.virtualAim) && !this.reloading;
    this.aimBlend = THREE.MathUtils.damp(this.aimBlend, this.aiming && this.hasAK47 ? 1 : 0, 14, dt);

    const wantsSprint =
      !this.crouching &&
      !this.aiming &&
      (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.virtualSprint) &&
      moving;
    const sprinting = wantsSprint && !this.exhausted && this.stamina > 0;
    this.sprinting = sprinting;

    if (sprinting) {
      const drain = this.staminaBoostTimer > 0 ? 6.0 : 12.5;
      this.stamina = Math.max(0, this.stamina - drain * dt);
      if (this.stamina <= 0.1) {
        this.stamina = 0;
        this.exhausted = true;
        this.virtualSprint = false;
        this.pushNotice('스태미나가 고갈되었습니다! 잠시 걸으며 숨을 고르세요.', 'warning', 2.2);
      }
    } else {
      const regen = (moving ? 14.0 : 22.0) * (this.staminaBoostTimer > 0 ? 1.65 : 1);
      this.stamina = Math.min(this.maxStamina, this.stamina + regen * dt);
      if (this.exhausted && this.stamina >= 22) {
        this.exhausted = false;
      }
    }

    const speed = sprinting
      ? 13.4
      : this.aiming
      ? this.crouching
        ? 2.5
        : 3.6
      : this.crouching
      ? 3.1
      : 5.4;
    const sinY = Math.sin(this.playerYaw);
    const cosY = Math.cos(this.playerYaw);
    // Forward in Three.js camera (-Z when yaw=0): (-sinY, -cosY), Right: (cosY, -sinY)
    const moveX = (-sinY * fwd + cosY * strafe) * speed * dt;
    const moveZ = (-cosY * fwd - sinY * strafe) * speed * dt;

    this.playerX = clamp(this.playerX + moveX, -WORLD_HALF + 3, WORLD_HALF - 3);
    this.playerZ = clamp(this.playerZ + moveZ, -WORLD_HALF + 3, WORLD_HALF - 3);

    if (moving) {
      this.walkCycle += dt * (sprinting ? 16.5 : this.aiming || this.crouching ? 5.5 : 8.5);
    }

    // Dynamic FOV zoom on ADS / widening on sprint / narrowing on crouch
    const targetFov = this.aiming
      ? this.hasAK47
        ? 52
        : 60
      : sprinting
      ? 85
      : this.crouching
      ? 70
      : 74;
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = THREE.MathUtils.damp(this.camera.fov, targetFov, 11, dt);
      this.camera.updateProjectionMatrix();
    }

    // 2. Solid Tree Trunk Collision (leaves pass freely, trunks block!) & Watchtower Floor/Railings
    this.resolvePlayerCollisions(dt);

    // 3. Flashlight Battery
    if (this.flashlightOn) {
      this.battery = Math.max(0, this.battery - 1.3 * dt);
      if (this.battery <= 0) {
        this.flashlightOn = false;
        this.audio.playFlashlightClick(false);
        this.pushNotice('손전등 배터리가 방전되었습니다!', 'warning', 2.6);
      }
    } else {
      this.battery = Math.min(100, this.battery + 3.8 * dt);
    }

    // 4. AK-47 Reload & Shooting
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    if (this.muzzleFlashTimer > 0) this.muzzleFlashTimer -= dt;
    if (this.hurtFlashTimer > 0) this.hurtFlashTimer -= dt;
    if (this.hitMarkerTimer > 0) this.hitMarkerTimer -= dt;
    if (this.tracerTimer > 0) {
      this.tracerTimer -= dt;
      if (this.tracerTimer <= 0) this.tracerLine.visible = false;
    }

    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloading = false;
        const needed = this.magSize - this.ammoInMag;
        const loaded = Math.min(needed, this.reserveAmmo);
        this.ammoInMag += loaded;
        this.reserveAmmo -= loaded;
      }
    }

    if (
      (this.mouseDown || this.virtualFire || this.keys.has('Space')) &&
      this.hasAK47 &&
      !this.reloading &&
      this.fireCooldown <= 0
    ) {
      if (this.ammoInMag > 0) {
        this.fireAK47();
      } else {
        this.fireCooldown = 0.28;
        this.audio.playDryFire();
        if (this.reserveAmmo > 0) this.tryReload();
      }
    }

    // 5. Watchtower Beacon & Shake
    this.beaconPhase += dt * 3.0;
    const beaconPulse = Math.max(0, Math.sin(this.beaconPhase));
    this.towerModels.beaconLight.intensity = beaconPulse > 0.2 ? 26 * beaconPulse : 0.6;
    this.towerModels.beaconBulbMat.emissiveIntensity = beaconPulse > 0.2 ? 5.2 : 0.4;

    if (this.towerShakeTimer > 0) {
      this.towerShakeTimer = Math.max(0, this.towerShakeTimer - dt);
      this.towerGroup.position.set(
        this.towerX + (Math.random() - 0.5) * 0.28,
        this.towerGroundY,
        this.towerZ + (Math.random() - 0.5) * 0.28
      );
    } else {
      this.towerGroup.position.set(this.towerX, this.towerGroundY, this.towerZ);
    }

    // 6. Siren Head AI (solo local AI vs server-authoritative multiplayer interpolation)
    if (this.isMultiplayer) {
      this.updateMultiplayerEntities(dt);
      this.netStateAccum += dt;
      if (this.netStateAccum >= 0.066) {
        this.netStateAccum = 0;
        this.networkSink?.sendPlayerState({
          x: this.playerX,
          y: this.playerY,
          z: this.playerZ,
          yaw: this.playerYaw,
          crouching: this.crouching,
          sprinting,
          flashlightOn: this.flashlightOn,
          hasAK47: this.hasAK47,
          alive: true,
          hp: this.playerHp,
          maxHp: this.playerMaxHp,
        });
      }
    } else {
      this.updateSirenHead(dt, sprinting);
    }

    // 7. Particles & Camera Sync
    this.updateParticles(dt);
    this.syncCameraAndFlashlight(dt);
    this.syncCameraAndLightning(dt);

    // 8. Spatial Siren Audio (infinite loop + 3D distance & ear pan!)
    const dist3D = Math.hypot(this.sirenX - this.playerX, this.sirenZ - this.playerZ);
    _vecA.set(this.sirenX - this.playerX, 0, this.sirenZ - this.playerZ).normalize();
    _vecRight.set(Math.cos(this.playerYaw), 0, -Math.sin(this.playerYaw));
    const pan = _vecA.dot(_vecRight);
    this.audio.updateSirenSpatial(dist3D, pan, this.sirenDead, dt);

    if (this.notice && now > this.notice.until) {
      this.notice = null;
    }
  }

  private resolvePlayerCollisions(dt: number): void {
    const pRad = 0.42;
    this.grid.queryRect(this.playerX - 3, this.playerZ - 3, this.playerX + 3, this.playerZ + 3, this.nearbyScratch);
    for (let i = 0; i < this.nearbyScratch.length; i++) {
      const t = this.nearbyScratch[i];
      if (t.destroyed) continue;
      const dx = this.playerX - t.x;
      const dz = this.playerZ - t.z;
      const minD = pRad + t.trunkRadius;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD * minD && d2 > 0.00001) {
        const d = Math.sqrt(d2);
        const push = minD - d;
        this.playerX += (dx / d) * push;
        this.playerZ += (dz / d) * push;
      }
    }

    // Watchtower floor elevation & railings
    let targetY = groundHeightAt(this.playerX, this.playerZ);
    if (!this.towerCollapsed) {
      const rx = this.playerX - this.towerX;
      const rz = this.playerZ - this.towerZ;
      const rampEndZ = 3.4 + TOWER_RAMP_RUN;

      const onRamp = Math.abs(rx) < 1.1 && rz >= 3.3 && rz <= rampEndZ + 0.1;
      const onDeck = Math.abs(rx) <= 3.35 && Math.abs(rz) <= 3.35;

      if (onRamp) {
        const frac = clamp((rampEndZ - rz) / TOWER_RAMP_RUN, 0, 1);
        targetY = this.towerGroundY + frac * TOWER_DECK_HEIGHT;
        // Clamp laterally on narrow ramp
        this.playerX = clamp(this.playerX, this.towerX - 0.92, this.towerX + 0.92);
      } else if (onDeck && this.playerY >= this.towerGroundY + TOWER_DECK_HEIGHT - 2.2) {
        targetY = this.towerGroundY + TOWER_DECK_HEIGHT;
        // Guard railings inside cabin except South stair opening (|rx| < 1.05, rz > 3.2)
        if (rx < -3.0) this.playerX = this.towerX - 3.0;
        if (rx > 3.0) this.playerX = this.towerX + 3.0;
        if (rz < -3.0) this.playerZ = this.towerZ - 3.0;
        if (rz > 3.05 && Math.abs(rx) > 0.95) this.playerZ = this.towerZ + 3.05;
      } else if (!onRamp && Math.abs(rx) < 3.65 && Math.abs(rz) < 3.65) {
        // 4 corner steel pillar collision on ground floor beneath the tower
        const corners: [number, number][] = [
          [-3.4, -3.4],
          [3.4, -3.4],
          [-3.4, 3.4],
          [3.4, 3.4],
        ];
        for (const [cx, cz] of corners) {
          const px = this.towerX + cx;
          const pz = this.towerZ + cz;
          const dx = this.playerX - px;
          const dz = this.playerZ - pz;
          const d2 = dx * dx + dz * dz;
          const minD = pRad + 0.25;
          if (d2 < minD * minD && d2 > 0.0001) {
            const d = Math.sqrt(d2);
            this.playerX += (dx / d) * (minD - d);
            this.playerZ += (dz / d) * (minD - d);
          }
        }
      }
    }

    this.playerY = THREE.MathUtils.damp(this.playerY, targetY, 16, dt);
  }

  private isPlayerInTower(): boolean {
    if (this.towerCollapsed) return false;
    const rx = this.playerX - this.towerX;
    const rz = this.playerZ - this.towerZ;
    return (
      Math.abs(rx) <= 3.6 &&
      rz >= -3.6 &&
      rz <= 3.4 + TOWER_RAMP_RUN &&
      this.playerY > this.towerGroundY + 1.8
    );
  }

  private fireAK47(): void {
    this.ammoInMag--;
    this.fireCooldown = 0.105;
    this.muzzleFlashTimer = 0.065;
    this.ak47View.muzzleFlash.rotation.z = Math.random() * Math.PI * 2;
    this.shotsFired++;
    this.recoilPitchKick = Math.min(0.14, this.recoilPitchKick + (this.aiming ? 0.012 : 0.022));
    this.recoilZKick = this.aiming ? 0.045 : 0.07;
    this.shakeMag = Math.max(this.shakeMag, this.aiming ? 0.025 : 0.04);
    this.audio.playAK47Shot();

    if (this.isMultiplayer) {
      this.networkSink?.sendPlayerShot();
    } else if (!this.sirenDead && distSqXZ(this.playerX, this.playerZ, this.sirenX, this.sirenZ) < 125 * 125) {
      if (this.sirenState !== 'CHASE') {
        this.sirenState = 'INVESTIGATE';
        this.sirenTargetX = this.playerX;
        this.sirenTargetZ = this.playerZ;
        this.sirenInvestigateTimer = 7.5;
        this.sirenAlerted = true;
      }
    }

    // Raycast from camera center with tight ADS spread
    const spread = this.aiming ? 0.003 : 0.018;
    _vecA.set((Math.random() - 0.5) * spread, (Math.random() - 0.5) * spread, -1).normalize();
    _vecA.applyQuaternion(this.camera.quaternion).normalize();
    const origin = this.camera.position;

    // 1. Check closest intact tree trunk occlusion along ray
    let maxDist = 115;
    this.grid.queryRect(
      Math.min(origin.x, origin.x + _vecA.x * 105) - 2,
      Math.min(origin.z, origin.z + _vecA.z * 105) - 2,
      Math.max(origin.x, origin.x + _vecA.x * 105) + 2,
      Math.max(origin.z, origin.z + _vecA.z * 105) + 2,
      this.nearbyScratch
    );
    let hitTreeY = 0;
    let hitTreeFlag = false;
    for (let i = 0; i < this.nearbyScratch.length; i++) {
      const t = this.nearbyScratch[i];
      if (t.destroyed) continue;
      const hitT = rayCircleXZ(origin.x, origin.z, _vecA.x, _vecA.z, maxDist, t.x, t.z, t.trunkRadius);
      if (hitT < maxDist) {
        const yAtHit = origin.y + _vecA.y * hitT;
        if (yAtHit >= t.y && yAtHit <= t.y + 12.2 * t.scale) {
          maxDist = hitT;
          hitTreeY = yAtHit;
          hitTreeFlag = true;
        }
      }
    }

    // 2. Raycast against Siren Head hit meshes
    let endPointDist = maxDist;
    if (!this.sirenDead) {
      this.raycaster.set(origin, _vecA);
      this.raycaster.far = maxDist;
      const hits = this.raycaster.intersectObjects(this.sirenRig.hitMeshes, false);
      if (hits.length > 0) {
        const hit = hits[0];
        endPointDist = hit.distance;
        hitTreeFlag = false;
        this.shotsHit++;
        this.hitMarkerTimer = 0.14;
        this.sirenHitFlashTimer = 0.08;
        this.sirenAlerted = true;

        for (let k = 0; k < 6; k++) {
          this.spawnParticle(
            hit.point.x,
            hit.point.y,
            hit.point.z,
            (Math.random() - 0.5) * 6,
            1 + Math.random() * 4,
            (Math.random() - 0.5) * 6,
            0.35,
            k % 2 === 0 ? 0xdc2626 : 0xf59e0b
          );
        }

        if (this.isMultiplayer) {
          this.sirenHp = Math.max(0, this.sirenHp - AK47_DAMAGE);
          this.networkSink?.sendSirenHit();
        } else {
          this.sirenHp = Math.max(0, this.sirenHp - AK47_DAMAGE);
          this.sirenState = 'CHASE';
          this.sirenTargetX = this.playerX;
          this.sirenTargetZ = this.playerZ;
          if (this.sirenHp <= 0) {
            this.handleSirenDefeated();
          }
        }
      }
    }

    if (hitTreeFlag) {
      this.spawnParticle(
        origin.x + _vecA.x * maxDist,
        hitTreeY,
        origin.z + _vecA.z * maxDist,
        (Math.random() - 0.5) * 4,
        1.5 + Math.random() * 2,
        (Math.random() - 0.5) * 4,
        0.3,
        0x8b6a4b
      );
    }

    // Visual tracer streak from muzzle to impact
    this.ak47View.muzzleFlash.getWorldPosition(_vecB);
    const tAttr = this.tracerLine.geometry.attributes.position as THREE.BufferAttribute;
    tAttr.setXYZ(0, _vecB.x, _vecB.y, _vecB.z);
    tAttr.setXYZ(
      1,
      origin.x + _vecA.x * endPointDist,
      origin.y + _vecA.y * endPointDist,
      origin.z + _vecA.z * endPointDist
    );
    tAttr.needsUpdate = true;
    this.tracerLine.visible = true;
    this.tracerTimer = 0.055;
  }

  private handleSirenDefeated(): void {
    this.sirenDead = true;
    this.sirenDeathTimer = 2.4;
    this.shakeMag = 0.35;
    this.audio.playSirenDeath();
    this.audio.updateSirenSpatial(999, 0, true, 1);
    this.pushNotice('사이렌 헤드를 처치했습니다!', 'success', 4);
  }

  private updateMultiplayerEntities(dt: number): void {
    const dampK = Math.min(1, dt * 11);

    // 1. Remote Survivors interpolation & animation
    for (const entry of this.remotePlayers.values()) {
      if (!entry.state.alive) continue;
      const prevX = entry.rig.root.position.x;
      const prevZ = entry.rig.root.position.z;
      const nx = prevX + (entry.targetX - prevX) * dampK;
      const ny = entry.rig.root.position.y + (entry.targetY - entry.rig.root.position.y) * dampK;
      const nz = prevZ + (entry.targetZ - prevZ) * dampK;
      entry.rig.root.position.set(nx, ny, nz);

      const yawDiff = normalizeAngle(entry.targetYaw - entry.rig.root.rotation.y);
      entry.rig.root.rotation.y += yawDiff * dampK;

      const moveDist = Math.hypot(nx - prevX, nz - prevZ);
      const speedEst = dt > 0.001 ? moveDist / dt : 0;
      if (speedEst > 0.35) {
        entry.walkPhase += dt * Math.min(18, speedEst * 1.45);
        const legSwing = Math.sin(entry.walkPhase) * 0.65;
        entry.rig.leftLeg.rotation.x = legSwing;
        entry.rig.rightLeg.rotation.x = -legSwing;
        entry.rig.leftArm.rotation.x = entry.state.flashlightOn ? -0.95 : -legSwing * 0.7;
        entry.rig.rightArm.rotation.x = entry.state.hasAK47 ? -0.75 : legSwing * 0.7;
      } else {
        entry.rig.leftLeg.rotation.x *= 0.85;
        entry.rig.rightLeg.rotation.x *= 0.85;
        entry.rig.leftArm.rotation.x = entry.state.flashlightOn ? -0.95 : 0;
        entry.rig.rightArm.rotation.x = entry.state.hasAK47 ? -0.75 : 0;
      }
      entry.rig.root.scale.y = THREE.MathUtils.damp(
        entry.rig.root.scale.y,
        entry.state.crouching ? 0.68 : 1,
        10,
        dt
      );
    }

    // 2. Siren Head interpolation & limb gait animation
    if (this.sirenDead) {
      this.sirenRig.bodyPivot.rotation.x = THREE.MathUtils.damp(
        this.sirenRig.bodyPivot.rotation.x,
        Math.PI * 0.48,
        3.2,
        dt
      );
      return;
    }

    if (this.sirenHitFlashTimer > 0) {
      this.sirenHitFlashTimer -= dt;
      this.sirenRig.skinMat.emissive.setHex(this.sirenHitFlashTimer > 0 ? 0x991b1b : 0x000000);
    }

    const prevSX = this.sirenX;
    const prevSZ = this.sirenZ;
    this.sirenX += (this.sirenNetTargetX - this.sirenX) * Math.min(1, dt * 10);
    this.sirenY += (this.sirenNetTargetY - this.sirenY) * Math.min(1, dt * 10);
    this.sirenZ += (this.sirenNetTargetZ - this.sirenZ) * Math.min(1, dt * 10);
    this.sirenAngle += normalizeAngle(this.sirenNetTargetAngle - this.sirenAngle) * Math.min(1, dt * 10);

    const moved = Math.hypot(this.sirenX - prevSX, this.sirenZ - prevSZ);
    const speedEst = dt > 0.001 ? moved / dt : 0;
    const isMoving = speedEst > 0.5;
    const distP = Math.hypot(this.sirenX - this.playerX, this.sirenZ - this.playerZ);

    if (isMoving) {
      this.sirenWalkCycle += dt * (speedEst * 0.72);
      this.sirenStepTimer += dt;
      if (this.sirenStepTimer >= (this.sirenState === 'CHASE' ? 0.44 : 0.68)) {
        this.sirenStepTimer = 0;
        this.audio.playFootstep(distP);
        if (distP < 24) {
          this.shakeMag = Math.max(this.shakeMag, (1 - distP / 24) * 0.08);
        }
      }
    }

    this.animateSirenRig(dt, isMoving);
  }

  private animateSirenRig(dt: number, isMoving: boolean): void {
    const strideAmp = isMoving ? (this.sirenState === 'CHASE' ? 0.64 : 0.48) : 0;
    const phaseL = this.sirenWalkCycle;
    const phaseR = this.sirenWalkCycle + Math.PI;

    const hipL = -Math.sin(phaseL) * strideAmp;
    const hipR = -Math.sin(phaseR) * strideAmp;
    const kneeL = isMoving ? Math.max(0.06, Math.sin(phaseL + 0.85) * 0.78) : 0.08;
    const kneeR = isMoving ? Math.max(0.06, Math.sin(phaseR + 0.85) * 0.78) : 0.08;

    const dampK = Math.min(1, dt * 12);
    this.sirenRig.leftLeg.rotation.x += (hipL - this.sirenRig.leftLeg.rotation.x) * dampK;
    this.sirenRig.rightLeg.rotation.x += (hipR - this.sirenRig.rightLeg.rotation.x) * dampK;
    this.sirenRig.leftKnee.rotation.x += (kneeL - this.sirenRig.leftKnee.rotation.x) * dampK;
    this.sirenRig.rightKnee.rotation.x += (kneeR - this.sirenRig.rightKnee.rotation.x) * dampK;

    const chaseReach = this.sirenState === 'CHASE' ? -0.78 : -0.14;
    const armL = chaseReach + Math.sin(phaseL) * (strideAmp * 0.65);
    const armR = chaseReach + Math.sin(phaseR) * (strideAmp * 0.65);
    const elbowBend = this.sirenState === 'CHASE' ? -0.52 : -0.28;
    this.sirenRig.leftArm.rotation.x += (armL - this.sirenRig.leftArm.rotation.x) * dampK;
    this.sirenRig.rightArm.rotation.x += (armR - this.sirenRig.rightArm.rotation.x) * dampK;
    this.sirenRig.leftElbow.rotation.x +=
      (elbowBend - Math.max(0, Math.sin(phaseL)) * 0.25 - this.sirenRig.leftElbow.rotation.x) * dampK;
    this.sirenRig.rightElbow.rotation.x +=
      (elbowBend - Math.max(0, Math.sin(phaseR)) * 0.25 - this.sirenRig.rightElbow.rotation.x) * dampK;

    const targetBobY = isMoving ? Math.abs(Math.sin(phaseL)) * 0.34 - 0.14 : Math.sin(performance.now() * 0.002) * 0.04;
    const targetPitch = this.sirenState === 'CHASE' ? 0.22 : isMoving ? 0.11 : 0.06;
    const targetYaw = isMoving ? Math.sin(phaseL) * 0.1 : 0;
    const targetRoll = isMoving ? Math.cos(phaseL) * 0.055 : 0;

    this.sirenRig.bodyPivot.position.y += (targetBobY - this.sirenRig.bodyPivot.position.y) * dampK;
    this.sirenRig.bodyPivot.rotation.x += (targetPitch - this.sirenRig.bodyPivot.rotation.x) * dampK;
    this.sirenRig.bodyPivot.rotation.y += (targetYaw - this.sirenRig.bodyPivot.rotation.y) * dampK;
    this.sirenRig.bodyPivot.rotation.z += (targetRoll - this.sirenRig.bodyPivot.rotation.z) * dampK;

    this.sirenRig.headPole.rotation.z = isMoving ? -Math.cos(phaseL) * 0.08 : Math.sin(performance.now() * 0.0015) * 0.05;
    this.sirenRig.headPole.rotation.x = isMoving ? 0.06 + Math.sin(phaseL * 2) * 0.04 : 0.04;
    this.sirenRig.hornGlowMat.emissiveIntensity = this.sirenState === 'CHASE' ? 2.4 : 0.9;

    this.sirenRig.root.position.set(this.sirenX, this.sirenY, this.sirenZ);
    this.sirenRig.root.rotation.y = this.sirenAngle;
  }

  private updateSpectating(dt: number, now: number): void {
    this.updateRainAndLightning(dt);
    this.updateParticles(dt);
    this.syncCameraAndLightning(dt);
    this.updateMultiplayerEntities(dt);

    const aliveTargets = Array.from(this.remotePlayers.values()).filter((e) => e.state.alive);
    if (aliveTargets.length > 0) {
      const target = aliveTargets[this.spectateIndex % aliveTargets.length];
      this.spectatingName = target.state.name;
      const pos = target.rig.root.position;
      const yaw = target.rig.root.rotation.y;
      const camX = pos.x + Math.sin(yaw) * 3.4;
      const camZ = pos.z + Math.cos(yaw) * 3.4;
      const camY = pos.y + 2.35;
      this.camera.position.set(camX, camY, camZ);
      this.camera.lookAt(pos.x - Math.sin(yaw) * 5, pos.y + 1.4, pos.z - Math.cos(yaw) * 5);

      this.playerX = pos.x;
      this.playerY = pos.y;
      this.playerZ = pos.z;
      this.flashlight.intensity = 0;

      const dist3D = Math.hypot(this.sirenX - pos.x, this.sirenZ - pos.z);
      this.audio.updateSirenSpatial(dist3D, 0, this.sirenDead, dt);
    } else {
      this.spectatingName = null;
      this.audio.updateSirenSpatial(45, 0, this.sirenDead, dt);
    }

    if (this.notice && now > this.notice.until) {
      this.notice = null;
    }
  }

  private updateSirenHead(dt: number, playerSprinting: boolean): void {
    if (this.sirenDead) {
      this.sirenDeathTimer -= dt;
      // Dramatic 11m topple forward onto forest floor
      this.sirenRig.bodyPivot.rotation.x = THREE.MathUtils.damp(
        this.sirenRig.bodyPivot.rotation.x,
        Math.PI * 0.48,
        3.2,
        dt
      );
      if (this.sirenDeathTimer <= 0 && this.phase === 'PLAYING') {
        this.phase = 'VICTORY';
        this.audio.stopSirenLoop();
        if (document.pointerLockElement === this.renderer.domElement) {
          document.exitPointerLock();
        }
        this.emitHud();
      }
      return;
    }

    if (this.sirenHitFlashTimer > 0) {
      this.sirenHitFlashTimer -= dt;
      this.sirenRig.skinMat.emissive.setHex(this.sirenHitFlashTimer > 0 ? 0x991b1b : 0x000000);
    }
    if (this.sirenAttackCooldown > 0) this.sirenAttackCooldown -= dt;
    if (this.sirenTowerStrikeCooldown > 0) this.sirenTowerStrikeCooldown -= dt;

    const dxP = this.playerX - this.sirenX;
    const dzP = this.playerZ - this.sirenZ;
    const distP = Math.hypot(dxP, dzP);
    const inTower = this.isPlayerInTower();

    // Detection: Crouching hides player completely from Siren Head
    if (this.crouching) {
      if (this.sirenState !== 'PATROL') {
        this.sirenState = 'PATROL';
        this.sirenInvestigateTimer = 0;
        this.sirenAlerted = false;
        this.sirenPatrolTimer = 0;
      }
    } else {
      const proxR = this.flashlightOn ? 32 : playerSprinting ? 26 : 16;
      let seesLight = false;
      if (this.flashlightOn && this.battery > 1 && distP < 65) {
        const lookX = -Math.sin(this.playerYaw);
        const lookZ = -Math.cos(this.playerYaw);
        const toSX = (this.sirenX - this.playerX) / (distP || 1);
        const toSZ = (this.sirenZ - this.playerZ) / (distP || 1);
        const dot = lookX * toSX + lookZ * toSZ;
        if (distP < 40 || dot > 0.72) {
          seesLight = true;
        }
      }

      if (distP < proxR || (seesLight && distP < 42)) {
        this.sirenState = 'CHASE';
        this.sirenTargetX = this.playerX;
        this.sirenTargetZ = this.playerZ;
        this.sirenAlerted = true;
      } else if (seesLight) {
        if (this.sirenState !== 'CHASE') {
          this.sirenState = 'INVESTIGATE';
          this.sirenInvestigateTimer = 6.0;
        }
        this.sirenTargetX = this.playerX;
        this.sirenTargetZ = this.playerZ;
        this.sirenAlerted = true;
      } else if (this.sirenState === 'CHASE') {
        if (distP > 48 && !this.flashlightOn) {
          this.sirenState = 'INVESTIGATE';
          this.sirenInvestigateTimer = 5.5;
        } else {
          this.sirenTargetX = this.playerX;
          this.sirenTargetZ = this.playerZ;
        }
      }
    }

    if (this.sirenState === 'INVESTIGATE') {
      this.sirenInvestigateTimer -= dt;
      if (
        this.sirenInvestigateTimer <= 0 ||
        Math.hypot(this.sirenTargetX - this.sirenX, this.sirenTargetZ - this.sirenZ) < 3
      ) {
        this.sirenState = 'PATROL';
      }
    }

    if (this.sirenState === 'PATROL') {
      this.sirenPatrolTimer -= dt;
      if (
        this.sirenPatrolTimer <= 0 ||
        Math.hypot(this.sirenTargetX - this.sirenX, this.sirenTargetZ - this.sirenZ) < 4
      ) {
        this.sirenPatrolTimer = 4.5 + Math.random() * 4;
        this.sirenTargetX = clamp(this.playerX + (Math.random() - 0.5) * 95, -WORLD_HALF + 14, WORLD_HALF - 14);
        this.sirenTargetZ = clamp(this.playerZ + (Math.random() - 0.5) * 95, -WORLD_HALF + 14, WORLD_HALF - 14);
      }
    }

    const goalX = inTower && this.sirenState === 'CHASE' ? this.towerX : this.sirenTargetX;
    const goalZ = inTower && this.sirenState === 'CHASE' ? this.towerZ : this.sirenTargetZ;
    const tx = goalX - this.sirenX;
    const tz = goalZ - this.sirenZ;
    const tDist = Math.hypot(tx, tz);

    let speed = 5.4;
    if (this.sirenState === 'INVESTIGATE') speed = 7.4;
    else if (this.sirenState === 'CHASE') speed = 8.9; // faster than walk (5.2), slower than sprint (9.6)!

    const distTower = Math.hypot(this.sirenX - this.towerX, this.sirenZ - this.towerZ);
    const stopAtTower = inTower && !this.towerCollapsed && distTower < 8.4;

    if (tDist > 1.0) {
      const targetAng = Math.atan2(tx, tz);
      const diff = normalizeAngle(targetAng - this.sirenAngle);
      this.sirenAngle += diff * Math.min(1, dt * 6);

      if (!stopAtTower) {
        this.sirenX += (tx / tDist) * speed * dt;
        this.sirenZ += (tz / tDist) * speed * dt;
        this.sirenWalkCycle += dt * (speed * 0.72);
        this.sirenStepTimer += dt;
        if (this.sirenStepTimer >= (this.sirenState === 'CHASE' ? 0.44 : 0.68)) {
          this.sirenStepTimer = 0;
          this.audio.playFootstep(distP);
          if (distP < 24) {
            this.shakeMag = Math.max(this.shakeMag, (1 - distP / 24) * 0.08);
          }
        }
      }
    }

    this.sirenX = clamp(this.sirenX, -WORLD_HALF + 6, WORLD_HALF - 6);
    this.sirenZ = clamp(this.sirenZ, -WORLD_HALF + 6, WORLD_HALF - 6);
    this.sirenY = groundHeightAt(this.sirenX, this.sirenZ);

    // Animate 3D Siren Head with natural heavy bipedal gait (hip, knee, elbow, torso sway & weight bob)
    const isMoving = tDist > 1.0 && !stopAtTower;
    const strideAmp = isMoving ? (this.sirenState === 'CHASE' ? 0.64 : 0.48) : 0;
    const phaseL = this.sirenWalkCycle;
    const phaseR = this.sirenWalkCycle + Math.PI;

    // Negative X rotation swings limb forward (+Z); positive knee X rotation bends shin backward (-Z)
    const hipL = -Math.sin(phaseL) * strideAmp;
    const hipR = -Math.sin(phaseR) * strideAmp;
    const kneeL = isMoving ? Math.max(0.06, Math.sin(phaseL + 0.85) * 0.78) : 0.08;
    const kneeR = isMoving ? Math.max(0.06, Math.sin(phaseR + 0.85) * 0.78) : 0.08;

    const dampK = Math.min(1, dt * 12);
    this.sirenRig.leftLeg.rotation.x += (hipL - this.sirenRig.leftLeg.rotation.x) * dampK;
    this.sirenRig.rightLeg.rotation.x += (hipR - this.sirenRig.rightLeg.rotation.x) * dampK;
    this.sirenRig.leftKnee.rotation.x += (kneeL - this.sirenRig.leftKnee.rotation.x) * dampK;
    this.sirenRig.rightKnee.rotation.x += (kneeR - this.sirenRig.rightKnee.rotation.x) * dampK;

    // Counter-swinging long skeletal arms + bent elbows
    const chaseReach = this.sirenState === 'CHASE' ? -0.78 : -0.14;
    const armL = chaseReach + Math.sin(phaseL) * (strideAmp * 0.65);
    const armR = chaseReach + Math.sin(phaseR) * (strideAmp * 0.65);
    const elbowBend = this.sirenState === 'CHASE' ? -0.52 : -0.28;
    this.sirenRig.leftArm.rotation.x += (armL - this.sirenRig.leftArm.rotation.x) * dampK;
    this.sirenRig.rightArm.rotation.x += (armR - this.sirenRig.rightArm.rotation.x) * dampK;
    this.sirenRig.leftElbow.rotation.x += (elbowBend - Math.max(0, Math.sin(phaseL)) * 0.25 - this.sirenRig.leftElbow.rotation.x) * dampK;
    this.sirenRig.rightElbow.rotation.x += (elbowBend - Math.max(0, Math.sin(phaseR)) * 0.25 - this.sirenRig.rightElbow.rotation.x) * dampK;

    // Heavy torso stride bob, forward hunch, and shoulder twist
    const targetBobY = isMoving ? Math.abs(Math.sin(phaseL)) * 0.34 - 0.14 : Math.sin(performance.now() * 0.002) * 0.04;
    const targetPitch = this.sirenState === 'CHASE' ? 0.22 : isMoving ? 0.11 : 0.06;
    const targetYaw = isMoving ? Math.sin(phaseL) * 0.1 : 0;
    const targetRoll = isMoving ? Math.cos(phaseL) * 0.055 : 0;

    this.sirenRig.bodyPivot.position.y += (targetBobY - this.sirenRig.bodyPivot.position.y) * dampK;
    this.sirenRig.bodyPivot.rotation.x += (targetPitch - this.sirenRig.bodyPivot.rotation.x) * dampK;
    this.sirenRig.bodyPivot.rotation.y += (targetYaw - this.sirenRig.bodyPivot.rotation.y) * dampK;
    this.sirenRig.bodyPivot.rotation.z += (targetRoll - this.sirenRig.bodyPivot.rotation.z) * dampK;

    this.sirenRig.headPole.rotation.z = isMoving ? -Math.cos(phaseL) * 0.08 : Math.sin(performance.now() * 0.0015) * 0.05;
    this.sirenRig.headPole.rotation.x = isMoving ? 0.06 + Math.sin(phaseL * 2) * 0.04 : 0.04;
    this.sirenRig.hornGlowMat.emissiveIntensity = this.sirenState === 'CHASE' ? 2.4 : 0.9;

    this.sirenRig.root.position.set(this.sirenX, this.sirenY, this.sirenZ);
    this.sirenRig.root.rotation.y = this.sirenAngle;

    // Siren Head SMASHES trees along its path permanently!
    this.grid.queryRect(this.sirenX - 3.2, this.sirenZ - 3.2, this.sirenX + 3.2, this.sirenZ + 3.2, this.nearbyScratch);
    for (let i = 0; i < this.nearbyScratch.length; i++) {
      const t = this.nearbyScratch[i];
      if (t.destroyed) continue;
      if (distSqXZ(this.sirenX, this.sirenZ, t.x, t.z) <= 2.4 * 2.4) {
        this.destroyTreePermanently(t, Math.atan2(t.z - this.sirenZ, t.x - this.sirenX));
        this.audio.playTreeSmash(distP);
        if (distP < 48) {
          this.shakeMag = Math.max(this.shakeMag, (1 - distP / 48) * 0.14);
        }
      }
    }

    // Watchtower Attack & 30% Permanent Collapse
    if (inTower && !this.towerCollapsed) {
      if (distTower <= 9.4 && this.sirenTowerStrikeCooldown <= 0) {
        this.sirenTowerStrikeCooldown = 2.6;
        if (Math.random() < TOWER_COLLAPSE_CHANCE) {
          this.collapseWatchtower();
        } else {
          this.towerShakeTimer = 0.65;
          this.shakeMag = Math.max(this.shakeMag, 0.22);
          this.audio.playTowerStrike(false);
          this.pushNotice('사이렌 헤드가 감시탑을 강타했습니다! 구조물이 간신히 버팁니다!', 'warning', 2.4);
          for (let k = 0; k < 8; k++) {
            this.spawnParticle(
              this.towerX + (Math.random() - 0.5) * 5,
              this.towerGroundY + 3.5,
              this.towerZ + (Math.random() - 0.5) * 5,
              (Math.random() - 0.5) * 8,
              2 + Math.random() * 4,
              (Math.random() - 0.5) * 8,
              0.6,
              0x94a3b8
            );
          }
        }
      }
    } else if (!inTower && !this.crouching && distP < 3.4 && this.sirenAttackCooldown <= 0) {
      this.sirenAttackCooldown = 1.25;
      this.damagePlayer(28, '사이렌 헤드의 손에 잡혀 삼켜졌습니다.');
    }
  }

  private collapseWatchtower(): void {
    this.towerCollapsed = true;
    this.towerShakeTimer = 0;
    this.towerModels.intactGroup.visible = false;
    this.towerModels.collapsedGroup.visible = true;
    this.shakeMag = 0.55;
    this.audio.playTowerStrike(true);

    // Move salvageable AK-47 / Ammo crates onto the permanent ground rubble; destroy non-salvageables
    for (let i = 0; i < this.crates.length; i++) {
      const c = this.crates[i];
      if (c.looted) continue;
      if (c.salvageable) {
        c.x = this.towerX + (Math.random() - 0.5) * 3.8;
        c.z = this.towerZ + (Math.random() - 0.5) * 3.8;
        c.y = groundHeightAt(c.x, c.z) + 0.35;
        this.crateMeshes[i].position.set(c.x, c.y, c.z);
        this.crateMeshes[i].rotation.z = (Math.random() - 0.5) * 0.35;
      } else {
        c.looted = true;
        this.crateMeshes[i].visible = false;
      }
    }

    for (let k = 0; k < 24; k++) {
      this.spawnParticle(
        this.towerX + (Math.random() - 0.5) * 6,
        this.towerGroundY + 1.5 + Math.random() * 3,
        this.towerZ + (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 14,
        4 + Math.random() * 7,
        (Math.random() - 0.5) * 14,
        0.95,
        k % 2 === 0 ? 0x78350f : 0x64748b
      );
    }

    this.pushNotice('산불감시탑이 영구적으로 붕괴되었습니다! 잔해에서 탈출하세요!', 'danger', 4.5);
    this.damagePlayer(35, '산불감시탑 붕괴 잔해에 매몰되었습니다.');
  }

  private damagePlayer(amount: number, reason: string): void {
    this.playerHp = Math.max(0, this.playerHp - amount);
    this.hurtFlashTimer = 0.38;
    this.shakeMag = Math.max(this.shakeMag, 0.3);
    this.audio.playHurt();

    if (this.playerHp <= 0 && this.phase === 'PLAYING') {
      this.startDeathCutscene(reason);
    }
  }

  private startDeathCutscene(reason: string): void {
    this.causeOfDeath = reason;
    this.phase = 'DYING_CUTSCENE';
    this.keys.clear();
    this.mouseDown = false;
    this.rightMouseDown = false;
    this.aiming = false;
    this.crouching = false;
    this.sprinting = false;
    this.virtualFire = false;
    if (this.isMultiplayer) {
      this.networkSink?.sendPlayerDied();
    }
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }

    this.ak47View.root.visible = false;
    this.camera.fov = 74;
    this.camera.updateProjectionMatrix();
    this.cutsceneTime = 0;
    this.cutsceneDevourPlayed = false;

    const survY = groundHeightAt(this.playerX, this.playerZ);
    const dx = this.playerX - this.sirenX;
    const dz = this.playerZ - this.sirenZ;
    const d = Math.hypot(dx, dz) || 1;
    if (d > 2.8 || d < 1.6) {
      this.sirenX = clamp(this.playerX - (dx / d) * 2.4, -WORLD_HALF + 6, WORLD_HALF - 6);
      this.sirenZ = clamp(this.playerZ - (dz / d) * 2.4, -WORLD_HALF + 6, WORLD_HALF - 6);
    }
    this.sirenY = groundHeightAt(this.sirenX, this.sirenZ);
    this.sirenAngle = Math.atan2(this.playerX - this.sirenX, this.playerZ - this.sirenZ);

    this.sirenRig.root.position.set(this.sirenX, this.sirenY, this.sirenZ);
    this.sirenRig.root.rotation.set(0, this.sirenAngle, 0);
    this.sirenRig.bodyPivot.position.set(0, 0, 0);
    this.sirenRig.bodyPivot.rotation.set(0, 0, 0);
    this.sirenRig.leftLeg.rotation.set(0, 0, 0);
    this.sirenRig.rightLeg.rotation.set(0, 0, 0);
    this.sirenRig.leftKnee.rotation.set(0.08, 0, 0);
    this.sirenRig.rightKnee.rotation.set(0.08, 0, 0);
    this.sirenRig.leftArm.rotation.set(0, 0, 0);
    this.sirenRig.rightArm.rotation.set(0, 0, 0);
    this.sirenRig.leftElbow.rotation.set(-0.2, 0, 0);
    this.sirenRig.rightElbow.rotation.set(-0.2, 0, 0);
    this.sirenRig.headPole.rotation.set(0, 0, 0);

    this.survivorRig.root.position.set(this.playerX, survY, this.playerZ);
    this.survivorRig.root.rotation.set(0, this.sirenAngle + Math.PI, 0);
    this.survivorRig.root.scale.set(1, 1, 1);
    this.survivorRig.leftArm.rotation.set(0, 0, 0);
    this.survivorRig.rightArm.rotation.set(0, 0, 0);
    this.survivorRig.leftLeg.rotation.set(0, 0, 0);
    this.survivorRig.rightLeg.rotation.set(0, 0, 0);
    this.survivorRig.root.visible = true;

    this.cutsceneLight.intensity = 45;
    this.emitHud();
  }

  private updateDeathCutscene(dt: number): void {
    this.cutsceneTime += dt;
    const t = this.cutsceneTime;

    this.updateRainAndLightning(dt);
    this.updateParticles(dt);
    this.syncCameraAndLightning(dt);
    this.audio.updateSirenSpatial(2.0, 0, false, dt);

    if (t < 0.85) {
      // Phase 1: Siren Head hunches down and grabs survivor on the forest floor
      const p = clamp(t / 0.85, 0, 1);
      const ease = p * p * (3 - 2 * p);
      this.sirenRig.bodyPivot.rotation.set(ease * 0.58, 0, 0);
      this.sirenRig.bodyPivot.position.y = -ease * 0.45;
      this.sirenRig.rightArm.rotation.x = -ease * 1.35;
      this.sirenRig.rightElbow.rotation.x = -0.25;
      this.sirenRig.leftArm.rotation.x = -ease * 0.55;
      this.sirenRig.leftElbow.rotation.x = -0.35;
      this.survivorRig.leftArm.rotation.x = -ease * 1.4;
      this.survivorRig.rightArm.rotation.x = -ease * 1.4;
    } else if (t < 2.15) {
      // Phase 2: Lift struggling survivor high into the air in Siren Head's right hand
      const p = clamp((t - 0.85) / 1.3, 0, 1);
      const ease = p * p * (3 - 2 * p);
      this.sirenRig.bodyPivot.rotation.set(0.58 * (1 - ease) - 0.08 * ease, 0, 0);
      this.sirenRig.bodyPivot.position.y = -0.45 * (1 - ease);
      this.sirenRig.rightArm.rotation.x = -1.35 - ease * 1.0;
      this.sirenRig.rightElbow.rotation.x = -0.25 - ease * 0.7;
      this.sirenRig.leftArm.rotation.x = -0.55 + ease * 0.3;

      this.sirenRig.root.updateMatrixWorld(true);
      this.sirenRig.handAttach.getWorldPosition(_vecA);
      this.survivorRig.root.position.set(_vecA.x, _vecA.y - 0.95, _vecA.z);
      this.survivorRig.root.rotation.set(
        0.24 * Math.sin(t * 9),
        this.sirenAngle + Math.PI + Math.sin(t * 7) * 0.35,
        Math.cos(t * 8) * 0.24
      );
      this.survivorRig.leftArm.rotation.x = -2.2 + Math.sin(t * 18) * 0.75;
      this.survivorRig.rightArm.rotation.x = -2.2 - Math.sin(t * 18) * 0.75;
      this.survivorRig.leftLeg.rotation.x = Math.sin(t * 20) * 0.85;
      this.survivorRig.rightLeg.rotation.x = -Math.sin(t * 20) * 0.85;
    } else {
      // Phase 3: Pull survivor into twin megaphone maws & devour
      const p = clamp((t - 2.15) / 0.75, 0, 1);
      this.sirenRig.bodyPivot.rotation.set(-0.08 + p * 0.14, 0, 0);
      this.sirenRig.bodyPivot.position.y = 0;
      this.sirenRig.rightArm.rotation.x = -2.35 - p * 0.3;
      this.sirenRig.rightElbow.rotation.x = -0.95 - p * 0.8;
      this.sirenRig.headPole.rotation.x = -p * 0.32;
      this.sirenRig.hornGlowMat.emissiveIntensity = 2.6 + Math.sin(t * 24) * 1.2 + p * 2.5;

      this.sirenRig.root.updateMatrixWorld(true);
      this.sirenRig.handAttach.getWorldPosition(_vecA);
      this.sirenRig.mouthTarget.getWorldPosition(_vecB);

      if (!this.cutsceneDevourPlayed && t >= 2.22) {
        this.cutsceneDevourPlayed = true;
        this.audio.playDevourScreech();
        this.shakeMag = 0.45;
        for (let k = 0; k < 18; k++) {
          this.spawnParticle(
            _vecB.x,
            _vecB.y,
            _vecB.z,
            (Math.random() - 0.5) * 9,
            1 + Math.random() * 5,
            (Math.random() - 0.5) * 9,
            0.85,
            k % 3 === 0 ? 0x7f1d1d : 0xdc2626
          );
        }
      }

      _vecA.lerp(_vecB, p);
      this.survivorRig.root.position.set(_vecA.x, _vecA.y - 0.95 * (1 - p), _vecA.z);
      this.survivorRig.root.rotation.set(p * 0.8, this.sirenAngle + Math.PI + t * 5, 0);
      this.survivorRig.leftArm.rotation.x = -2.4 + Math.sin(t * 22) * 0.6;
      this.survivorRig.rightArm.rotation.x = -2.4 - Math.sin(t * 22) * 0.6;
      this.survivorRig.leftLeg.rotation.x = Math.sin(t * 24) * 0.9;
      this.survivorRig.rightLeg.rotation.x = -Math.sin(t * 24) * 0.9;

      const shrink = 1 - clamp((t - 2.35) / 0.6, 0, 1);
      this.survivorRig.root.scale.setScalar(Math.max(0.001, shrink));
      if (shrink <= 0.01) {
        this.survivorRig.root.visible = false;
      }
    }

    // 3rd-person orbiting camera framing Siren Head + grabbed survivor
    const camAng = this.sirenAngle + 0.85 + t * 0.22;
    const camDist = 7.4 - clamp(t / this.cutsceneDuration, 0, 1) * 1.4;
    const shakeX = this.shakeMag > 0.005 ? (Math.random() - 0.5) * this.shakeMag : 0;
    const shakeY = this.shakeMag > 0.005 ? (Math.random() - 0.5) * this.shakeMag : 0;
    if (this.shakeMag > 0) this.shakeMag = Math.max(0, this.shakeMag - dt * 0.9);

    const camX = this.sirenX + Math.sin(camAng) * camDist + shakeX;
    const camZ = this.sirenZ + Math.cos(camAng) * camDist;
    const camY = this.sirenY + 3.2 + t * 0.85 + shakeY;

    this.camera.position.set(camX, camY, camZ);
    this.camera.lookAt(
      this.sirenX,
      this.sirenY + 4.4 + clamp(t / 2.2, 0, 1) * 4.2,
      this.sirenZ
    );

    this.cutsceneLight.position.set(
      (camX + this.sirenX) * 0.5,
      this.sirenY + 6.5,
      (camZ + this.sirenZ) * 0.5
    );
    this.cutsceneLight.intensity = 44;
    this.flashlight.intensity = 0;

    if (t >= this.cutsceneDuration) {
      this.survivorRig.root.visible = false;
      this.cutsceneLight.intensity = 0;
      if (this.isMultiplayer) {
        const hasAliveTeammates = Array.from(this.remotePlayers.values()).some((e) => e.state.alive);
        if (hasAliveTeammates) {
          this.phase = 'SPECTATING';
          this.pushNotice('팀원이 아직 생존해 있습니다. 관전 모드로 전환됩니다.', 'info', 4);
        } else {
          this.phase = 'GAME_OVER';
          this.audio.stopSirenLoop();
        }
      } else {
        this.phase = 'GAME_OVER';
        this.audio.stopSirenLoop();
      }
      this.emitHud();
    }
  }

  tryLootNearbyCrate(): void {
    if (this.phase !== 'PLAYING') return;
    const found = this.findNearbyCrate();
    if (!found) return;
    const { crate, index } = found;

    if (this.isMultiplayer) {
      this.networkSink?.sendCrateLoot(crate.id);
      return;
    }

    crate.looted = true;
    this.crateMeshes[index].visible = false;
    this.grantLootItem(crate);
    this.emitHud();
  }

  useMedkit(): void {
    if (this.phase !== 'PLAYING') return;
    if (this.medkits <= 0) {
      this.pushNotice('보유 중인 구급상자가 없습니다.', 'warning', 2.0);
      return;
    }
    if (this.playerHp >= this.playerMaxHp) {
      this.pushNotice('이미 체력이 가득 찼습니다.', 'info', 2.0);
      return;
    }
    this.medkits--;
    this.playerHp = Math.min(this.playerMaxHp, this.playerHp + 50);
    this.audio.playLoot();
    this.pushNotice(`구급상자 사용: 체력 +50 회복 (남은 개수: ${this.medkits})`, 'success', 2.8);
    this.emitHud();
  }

  private grantLootItem(crate: LootCrateData): void {
    this.audio.playLoot();

    switch (crate.type) {
      case 'AK47':
        this.hasAK47 = true;
        this.ammoInMag = 30;
        this.reserveAmmo += 30;
        this.ak47View.root.visible = true;
        this.pushNotice('AK-47 돌격소총 장착! (사격 · R 재장전)', 'success', 4);
        break;
      case 'AMMO':
        this.reserveAmmo += crate.amount;
        this.pushNotice(`7.62mm 탄약 +${crate.amount}발을 확보했습니다.`, 'info', 3);
        break;
      case 'MEDKIT':
        this.medkits++;
        this.pushNotice(
          `응급 구급상자를 보관했습니다! (보유 ${this.medkits}개 · H키로 사용)`,
          'success',
          3.4
        );
        break;
      case 'BATTERY':
        this.battery = 100;
        this.pushNotice('손전등 배터리가 100% 충전되었습니다.', 'info', 2.8);
        break;
      case 'ENERGY_DRINK':
        this.battery = 100;
        this.stamina = this.maxStamina;
        this.exhausted = false;
        this.staminaBoostTimer = 15;
        this.pushNotice('배터리 100% & 15초간 스태미나 부스트 활성화!', 'success', 3.4);
        break;
    }
  }

  private findNearbyCrate(): { crate: LootCrateData; index: number } | null {
    let bestIdx = -1;
    let bestD2 = 3.2 * 3.2;
    for (let i = 0; i < this.crates.length; i++) {
      const c = this.crates[i];
      if (c.looted) continue;
      if (this.towerCollapsed && !c.salvageable) continue;
      if (Math.abs(this.playerY - c.y) > 2.6) continue;
      const d2 = distSqXZ(this.playerX, this.playerZ, c.x, c.z);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestIdx = i;
      }
    }
    return bestIdx >= 0 ? { crate: this.crates[bestIdx], index: bestIdx } : null;
  }

  private updateParticles(dt: number): void {
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.visible = false;
        continue;
      }
      p.vy -= 14 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.mesh.rotation.x += dt * 7;
      p.mesh.rotation.y += dt * 5;
    }
  }

  private updateRainAndLightning(dt: number): void {
    const cx = this.playerX;
    const cy = this.playerY;
    const cz = this.playerZ;
    const halfBox = 11;

    for (let i = 0; i < RAIN_COUNT; i++) {
      const idx = i * 6;
      let rx = this.rainPos[idx] - 2.6 * dt;
      let ry = this.rainPos[idx + 1] - 22 * dt;
      let rz = this.rainPos[idx + 2] - 1.5 * dt;

      if (ry < cy - 1.5) {
        rx = cx + (Math.random() - 0.5) * halfBox * 2;
        ry = cy + 12 + Math.random() * 6;
        rz = cz + (Math.random() - 0.5) * halfBox * 2;
      } else {
        if (rx < cx - halfBox) rx += halfBox * 2;
        if (rx > cx + halfBox) rx -= halfBox * 2;
        if (rz < cz - halfBox) rz += halfBox * 2;
        if (rz > cz + halfBox) rz -= halfBox * 2;
      }

      this.rainPos[idx] = rx;
      this.rainPos[idx + 1] = ry;
      this.rainPos[idx + 2] = rz;
      this.rainPos[idx + 3] = rx - 0.08;
      this.rainPos[idx + 4] = ry + 0.58;
      this.rainPos[idx + 5] = rz - 0.04;
    }
    (this.rainLines.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    this.lightningTimer -= dt;
    if (this.lightningTimer <= 0) {
      this.lightningAlpha = 1.0;
      this.lightningTimer = 17 + Math.random() * 15;
      this.thunderDelay = 0.4 + Math.random() * 0.5;
    }
    if (this.lightningAlpha > 0) {
      this.lightningAlpha = Math.max(0, this.lightningAlpha - dt * 2.8);
    }
    if (this.thunderDelay >= 0) {
      this.thunderDelay -= dt;
      if (this.thunderDelay < 0) {
        this.audio.playThunder();
      }
    }
  }

  private syncCameraAndLightning(dt: number): void {
    const flash = this.lightningAlpha;
    this.moonLight.intensity = 0.07 + flash * 3.8;
    this.hemiLight.intensity = 0.11 + flash * 1.4;
    _colorTarget.setHex(flash > 0.05 ? 0x162233 : 0x020408);
    (this.scene.background as THREE.Color).lerp(_colorTarget, Math.min(1, dt * 18));
    if (this.scene.fog) {
      (this.scene.fog as THREE.FogExp2).color.copy(this.scene.background as THREE.Color);
    }
  }

  private syncCameraAndFlashlight(dt: number): void {
    // Camera position + subtle head bobbing + shake + recoil
    const bobY = Math.sin(this.walkCycle) * 0.055;
    const bobX = Math.cos(this.walkCycle * 0.5) * 0.035;
    const sx = this.shakeMag > 0.005 ? (Math.random() - 0.5) * this.shakeMag : 0;
    const sy = this.shakeMag > 0.005 ? (Math.random() - 0.5) * this.shakeMag : 0;
    if (this.shakeMag > 0) this.shakeMag = Math.max(0, this.shakeMag - dt * 1.2);

    this.recoilPitchKick = THREE.MathUtils.damp(this.recoilPitchKick, 0, 14, dt);
    this.recoilZKick = THREE.MathUtils.damp(this.recoilZKick, 0, 18, dt);

    this.camera.position.set(
      this.playerX + bobX + sx,
      this.playerY + this.eyeHeight + bobY + sy,
      this.playerZ
    );
    this.camera.rotation.set(this.playerPitch + this.recoilPitchKick, this.playerYaw, 0, 'YXZ');

    // Flashlight SpotLight tracks camera with subtle weight
    this.flashlight.position.copy(this.camera.position);
    _eulerA.set(this.playerPitch + this.recoilPitchKick * 0.5, this.playerYaw, 0, 'YXZ');
    _quatA.setFromEuler(_eulerA);
    _vecA.set(0, 0, -10).applyQuaternion(_quatA);
    this.flashlightTarget.position.copy(this.camera.position).add(_vecA);

    if (this.flashlightOn && this.battery > 0.5) {
      const dim = clamp(this.battery / 18, 0.5, 1);
      this.flashlight.intensity = 160 * dim;
    } else {
      this.flashlight.intensity = 0;
    }

    this.closeAuraLight.position.copy(this.camera.position);

    // 1st-Person AK-47 Viewmodel sway, ADS alignment, reload tilt & punchy muzzle flash
    if (this.hasAK47) {
      const reloadTilt = this.reloading ? Math.sin((1 - this.reloadTimer / this.reloadDuration) * Math.PI) * 0.65 : 0;
      const swayScale = 1 - this.aimBlend * 0.78;
      const posX = THREE.MathUtils.lerp(0.24, 0, this.aimBlend) + bobX * 0.35 * swayScale;
      const posY = THREE.MathUtils.lerp(-0.22, -0.064, this.aimBlend) + bobY * 0.35 * swayScale - reloadTilt * 0.12;
      const posZ = THREE.MathUtils.lerp(-0.35, -0.22, this.aimBlend) + this.recoilZKick;
      this.ak47View.root.position.set(posX, posY, posZ);
      this.ak47View.root.rotation.set(
        this.recoilPitchKick * (1.2 - this.aimBlend * 0.55) - reloadTilt * 0.9,
        reloadTilt * 0.5,
        0
      );
      const flashAlpha = clamp(this.muzzleFlashTimer / 0.065, 0, 1);
      const flashOn = flashAlpha > 0;
      this.ak47View.muzzleFlash.visible = flashOn;
      if (flashOn) {
        this.ak47View.muzzleFlash.scale.setScalar(0.75 + flashAlpha * 0.55);
        this.ak47View.muzzleFlash.rotation.z += dt * 45;
      }
      this.ak47View.muzzleLight.intensity = flashOn ? 120 * flashAlpha : 0;
    }
  }

  private emitHud(): void {
    const nearby = this.findNearbyCrate();
    const dxT = this.towerX - this.playerX;
    const dzT = this.towerZ - this.playerZ;
    const worldTowerAng = Math.atan2(-dxT, -dzT);
    const towerRelAngle = normalizeAngle(this.playerYaw - worldTowerAng);
    const teammates = Array.from(this.remotePlayers.values()).map((e) => e.state);

    this.onHudUpdate({
      phase: this.phase,
      pointerLocked: this.pointerLocked,
      hp: Math.ceil(this.playerHp),
      maxHp: this.playerMaxHp,
      stamina: Math.round(this.stamina),
      maxStamina: this.maxStamina,
      exhausted: this.exhausted,
      staminaBoostActive: this.staminaBoostTimer > 0,
      crouching: this.crouching,
      crouchTime: this.crouchTime,
      maxCrouchSeconds: this.maxCrouchSeconds,
      crouchLocked: this.crouchLockTimer > 0,
      sprinting: this.sprinting,
      aiming: this.aiming,
      flashlightOn: this.flashlightOn,
      battery: Math.round(this.battery),
      medkits: this.medkits,
      hasAK47: this.hasAK47,
      ammoInMag: this.ammoInMag,
      magSize: this.magSize,
      reserveAmmo: this.reserveAmmo,
      reloading: this.reloading,
      reloadProgress: this.reloading ? 1 - this.reloadTimer / this.reloadDuration : 0,
      sirenHp: this.sirenHp,
      sirenMaxHp: this.sirenMaxHp,
      sirenVisibleBar: this.sirenAlerted || this.hasAK47 || this.sirenHp < this.sirenMaxHp,
      sirenDistance: Math.round(Math.hypot(this.sirenX - this.playerX, this.sirenZ - this.playerZ)),
      sirenState: this.sirenState,
      playerInTower: this.isPlayerInTower(),
      towerCollapsed: this.towerCollapsed,
      towerRelAngle,
      towerDistance: Math.round(Math.hypot(dxT, dzT)),
      nearbyCrate: nearby
        ? { id: nearby.crate.id, label: nearby.crate.label, sublabel: nearby.crate.sublabel }
        : null,
      hitMarkerActive: this.hitMarkerTimer > 0,
      cutsceneProgress:
        this.phase === 'DYING_CUTSCENE'
          ? clamp(this.cutsceneTime / this.cutsceneDuration, 0, 1)
          : 0,
      notice: this.notice,
      elapsedSeconds: Math.floor(this.elapsedSeconds),
      shotsFired: this.shotsFired,
      shotsHit: this.shotsHit,
      treesDestroyed: this.treesDestroyed,
      causeOfDeath: this.causeOfDeath,
      muted: this.audio.isMuted(),
      keyboardLocked: this.keyboardLocked,
      isMultiplayer: this.isMultiplayer,
      roomCode: this.roomCode,
      playerCount: this.playerCount,
      teammates,
      spectatingName: this.spectatingName,
      mobileControlsEnabled: this.mobileControlsEnabled,
    });
  }
}
