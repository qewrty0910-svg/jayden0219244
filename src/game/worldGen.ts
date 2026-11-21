export const WORLD_HALF = 155; // 310m x 310m playable dense forest
export const SIREN_BASE_HP = 2000;
export const SIREN_MAX_HP = SIREN_BASE_HP;
export const AK47_DAMAGE = 20;
export const TOWER_COLLAPSE_CHANCE = 0.3;
export const TOWER_DECK_HEIGHT = 9.2;
export const TOWER_RAMP_RUN = 12.6;
export const MAX_CROUCH_SECONDS = 15;
export const TREE_COUNT = 1850;

export type LootType = 'AK47' | 'AMMO' | 'MEDKIT' | 'BATTERY' | 'ENERGY_DRINK';

export interface TreeRecord {
  id: number;
  x: number;
  z: number;
  y: number;
  trunkRadius: number;
  scale: number;
  rotation: number;
  destroyed: boolean;
  destroyedAngle: number;
}

export interface LootCrateData {
  id: number;
  x: number;
  y: number;
  z: number;
  type: LootType;
  label: string;
  sublabel: string;
  amount: number;
  looted: boolean;
  salvageable: boolean;
}

export function groundHeightAt(x: number, z: number): number {
  return (
    Math.sin(x * 0.032) * Math.cos(z * 0.028) * 1.15 +
    Math.sin(x * 0.075 + 1.4) * Math.sin(z * 0.068) * 0.42
  );
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function distSqXZ(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

export interface GeneratedWorldLayout {
  towerX: number;
  towerZ: number;
  towerGroundY: number;
  sirenX: number;
  sirenZ: number;
  sirenY: number;
  crates: LootCrateData[];
  trees: TreeRecord[];
  treeColors: number[];
}

export function generateWorldLayout(seed: number, playerCount: number): GeneratedWorldLayout {
  const rand = mulberry32(seed);
  const count = Math.max(1, Math.min(4, Math.floor(playerCount)));

  // Random Watchtower placement (75m to 105m away from spawn)
  const tAng = rand() * Math.PI * 2;
  const tDist = 75 + rand() * 30;
  const towerX = clamp(Math.cos(tAng) * tDist, -WORLD_HALF + 28, WORLD_HALF - 28);
  const towerZ = clamp(Math.sin(tAng) * tDist, -WORLD_HALF + 28, WORLD_HALF - 28);
  const towerGroundY = groundHeightAt(towerX, towerZ);
  const deckWorldY = towerGroundY + TOWER_DECK_HEIGHT;

  // Spawn AK-47 crates matching playerCount (1..4) so every survivor can arm up
  const crates: LootCrateData[] = [];
  let crateId = 1;
  const akOffsets: [number, number][] = [
    [-2.1, -2.1],
    [-0.7, -2.2],
    [0.7, -2.2],
    [2.1, -2.1],
  ];
  for (let i = 0; i < count; i++) {
    const [ox, oz] = akOffsets[i];
    crates.push({
      id: crateId++,
      x: towerX + ox,
      y: deckWorldY,
      z: towerZ + oz,
      type: 'AK47',
      label: count > 1 ? `AK-47 돌격소총 #${i + 1}` : 'AK-47 돌격소총',
      sublabel: '피해량 20 · 30발 장전 (+30발 예비)',
      amount: 30,
      looted: false,
      salvageable: true,
    });
  }

  // Ammo crates scale with playerCount so teammates have enough rounds for 2000*N Siren Head HP
  const ammoPositions: [number, number][] = [
    [2.1, 1.5],
    [2.1, -0.3],
    [-2.1, -0.3],
    [0.9, 1.5],
    [-0.9, 1.5],
  ];
  const ammoCrateCount = Math.min(ammoPositions.length, count + 1);
  for (let i = 0; i < ammoCrateCount; i++) {
    const [ox, oz] = ammoPositions[i];
    crates.push({
      id: crateId++,
      x: towerX + ox,
      y: deckWorldY,
      z: towerZ + oz,
      type: 'AMMO',
      label: i % 2 === 0 ? '7.62mm 탄약 상자' : '7.62mm 대용량 탄통',
      sublabel: '예비 탄약 +90발',
      amount: 90,
      looted: false,
      salvageable: true,
    });
  }

  crates.push({
    id: crateId++,
    x: towerX - 2.1,
    y: deckWorldY,
    z: towerZ + 1.5,
    type: 'MEDKIT',
    label: '응급 구급상자',
    sublabel: '가방에 보관 · H키로 체력 +50 회복',
    amount: 50,
    looted: false,
    salvageable: false,
  });

  crates.push({
    id: crateId++,
    x: towerX,
    y: deckWorldY,
    z: towerZ + 0.1,
    type: 'ENERGY_DRINK',
    label: '전술 배터리 & 에너지 드링크',
    sublabel: '손전등 100% · 스태미나 완충 & 가속',
    amount: 100,
    looted: false,
    salvageable: false,
  });

  // Spawn Siren Head on opposite side of forest (~88m away)
  const sAng = tAng + Math.PI + (rand() - 0.5) * 1.1;
  const sDist = 82 + rand() * 18;
  const sirenX = clamp(Math.cos(sAng) * sDist, -WORLD_HALF + 20, WORLD_HALF - 20);
  const sirenZ = clamp(Math.sin(sAng) * sDist, -WORLD_HALF + 20, WORLD_HALF - 20);
  const sirenY = groundHeightAt(sirenX, sirenZ);

  // Deterministic dense forest placement using fast flat spatial buckets
  const minSpacing = 3.15;
  const minSpacingSq = minSpacing * minSpacing;
  const cellSize = 12;
  const span = WORLD_HALF * 2 + 20;
  const cols = Math.ceil(span / cellSize);
  const buckets: TreeRecord[][] = Array.from({ length: cols * cols }, () => []);
  const toIdx = (v: number) => clamp(Math.floor((v + WORLD_HALF + 10) / cellSize), 0, cols - 1);

  const trees: TreeRecord[] = [];
  const treeColors: number[] = [];
  let idx = 0;
  let attempts = 0;

  while (idx < TREE_COUNT && attempts < 34000) {
    attempts++;
    const x = (rand() - 0.5) * (WORLD_HALF * 2 - 12);
    const z = (rand() - 0.5) * (WORLD_HALF * 2 - 12);

    if (distSqXZ(x, z, 0, 0) < 9.5 * 9.5) continue;
    if (distSqXZ(x, z, towerX, towerZ + 5.5) < 15.5 * 15.5) continue;

    const c0 = toIdx(x - minSpacing);
    const c1 = toIdx(x + minSpacing);
    const r0 = toIdx(z - minSpacing);
    const r1 = toIdx(z + minSpacing);
    let tooClose = false;

    for (let r = r0; r <= r1 && !tooClose; r++) {
      const row = r * cols;
      for (let c = c0; c <= c1; c++) {
        const b = buckets[row + c];
        for (let i = 0; i < b.length; i++) {
          if (distSqXZ(x, z, b[i].x, b[i].z) < minSpacingSq) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) break;
      }
    }
    if (tooClose) continue;

    const y = groundHeightAt(x, z);
    const scale = 0.86 + rand() * 0.34;
    const rotation = rand() * Math.PI * 2;
    const rec: TreeRecord = {
      id: idx,
      x,
      z,
      y,
      trunkRadius: 0.44 * scale,
      scale,
      rotation,
      destroyed: false,
      destroyedAngle: 0,
    };
    trees.push(rec);
    treeColors.push(rand());
    buckets[toIdx(z) * cols + toIdx(x)].push(rec);
    idx++;
  }

  return {
    towerX,
    towerZ,
    towerGroundY,
    sirenX,
    sirenZ,
    sirenY,
    crates,
    trees,
    treeColors,
  };
}
