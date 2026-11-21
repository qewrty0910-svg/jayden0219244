import * as THREE from 'three';
import type { ForestTextures } from './textures3d';
import { TOWER_DECK_HEIGHT, TOWER_RAMP_RUN, type LootType } from './types';

export interface SirenHeadRig {
  root: THREE.Group;
  bodyPivot: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  leftKnee: THREE.Group;
  rightKnee: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftElbow: THREE.Group;
  rightElbow: THREE.Group;
  headPole: THREE.Group;
  handAttach: THREE.Group;
  mouthTarget: THREE.Object3D;
  hornGlowMat: THREE.MeshStandardMaterial;
  hitMeshes: THREE.Mesh[];
  skinMat: THREE.MeshStandardMaterial;
}

export interface SurvivorRig {
  root: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  flashlightCone?: THREE.Mesh;
  gunMesh?: THREE.Group;
}

export function createSirenHeadModel(textures: ForestTextures): SirenHeadRig {
  const root = new THREE.Group();
  const bodyPivot = new THREE.Group();
  root.add(bodyPivot);

  const skinMat = new THREE.MeshStandardMaterial({
    map: textures.sirenSkinColor,
    color: 0x5c362e,
    roughness: 0.88,
    metalness: 0.08,
  });

  const darkRibMat = new THREE.MeshStandardMaterial({
    color: 0x261411,
    roughness: 0.92,
    metalness: 0.05,
  });

  const rustedMetalMat = new THREE.MeshStandardMaterial({
    color: 0x52525b,
    roughness: 0.48,
    metalness: 0.72,
  });

  const hornGlowMat = new THREE.MeshStandardMaterial({
    color: 0x240909,
    emissive: 0xb91c1c,
    emissiveIntensity: 0.9,
    roughness: 0.6,
  });

  const hitMeshes: THREE.Mesh[] = [];
  const registerHit = (mesh: THREE.Mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    hitMeshes.push(mesh);
    return mesh;
  };

  // Pelvis (at y = 5.2m)
  const pelvis = registerHit(new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.38, 0.7, 10), skinMat));
  pelvis.position.y = 5.1;
  bodyPivot.add(pelvis);

  // Articulated Legs with Hip + Knee Pivots (each 5.1m tall so feet sit flush at y=0)
  const makeLeg = (side: number) => {
    const legGroup = new THREE.Group();
    legGroup.position.set(side * 0.42, 5.0, 0);

    const thigh = registerHit(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.16, 2.6, 8), skinMat));
    thigh.position.y = -1.3;
    legGroup.add(thigh);

    const kneePivot = new THREE.Group();
    kneePivot.position.y = -2.6;
    legGroup.add(kneePivot);

    const knee = registerHit(new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), darkRibMat));
    kneePivot.add(knee);

    const shin = registerHit(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.11, 2.4, 8), skinMat));
    shin.position.y = -1.2;
    kneePivot.add(shin);

    const foot = registerHit(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.18, 0.65), darkRibMat));
    foot.position.set(0, -2.32, 0.18);
    kneePivot.add(foot);

    return { legGroup, kneePivot };
  };

  const leftLegBuilt = makeLeg(-1);
  const rightLegBuilt = makeLeg(1);
  const leftLeg = leftLegBuilt.legGroup;
  const rightLeg = rightLegBuilt.legGroup;
  const leftKnee = leftLegBuilt.kneePivot;
  const rightKnee = rightLegBuilt.kneePivot;
  bodyPivot.add(leftLeg, rightLeg);

  // Gaunt Spine & Ribcage Torso (y = 5.4m -> 8.2m)
  const spine = registerHit(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 2.8, 10), skinMat));
  spine.position.y = 6.6;
  bodyPivot.add(spine);

  const chest = registerHit(new THREE.Mesh(new THREE.CylinderGeometry(0.68, 0.36, 1.5, 10), skinMat));
  chest.position.y = 7.45;
  chest.scale.set(1.15, 1, 0.75);
  bodyPivot.add(chest);

  // Exposed rib rings
  for (let i = 0; i < 4; i++) {
    const rib = registerHit(
      new THREE.Mesh(new THREE.TorusGeometry(0.46 + i * 0.05, 0.055, 6, 14), darkRibMat)
    );
    rib.position.set(0, 6.75 + i * 0.28, 0);
    rib.rotation.x = Math.PI * 0.5;
    rib.scale.set(1.15, 0.75, 1);
    bodyPivot.add(rib);
  }

  // Shoulders
  const shoulders = registerHit(new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.34, 0.45), skinMat));
  shoulders.position.y = 8.1;
  bodyPivot.add(shoulders);

  // Long Skeletal Arms with Shoulder + Elbow Pivots
  const makeArm = (side: number) => {
    const armGroup = new THREE.Group();
    armGroup.position.set(side * 0.98, 8.05, 0);

    const upper = registerHit(new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.11, 2.5, 8), skinMat));
    upper.position.y = -1.25;
    armGroup.add(upper);

    const elbowPivot = new THREE.Group();
    elbowPivot.position.y = -2.5;
    armGroup.add(elbowPivot);

    const elbowJoint = registerHit(new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), darkRibMat));
    elbowPivot.add(elbowJoint);

    const fore = registerHit(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.08, 2.6, 8), skinMat));
    fore.position.set(0, -1.3, 0);
    elbowPivot.add(fore);

    const hand = registerHit(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.55, 0.22), darkRibMat));
    hand.position.set(0, -2.65, 0.08);
    elbowPivot.add(hand);

    return { armGroup, elbowPivot };
  };

  const leftArmBuilt = makeArm(-1);
  const rightArmBuilt = makeArm(1);
  const leftArm = leftArmBuilt.armGroup;
  const rightArm = rightArmBuilt.armGroup;
  const leftElbow = leftArmBuilt.elbowPivot;
  const rightElbow = rightArmBuilt.elbowPivot;
  bodyPivot.add(leftArm, rightArm);

  // Neck Pole & Twin Megaphone Sirens (y = 8.2m -> 10.9m)
  const headPole = new THREE.Group();
  headPole.position.y = 8.2;
  bodyPivot.add(headPole);

  const neck = registerHit(new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 2.5, 8), rustedMetalMat));
  neck.position.y = 1.25;
  headPole.add(neck);

  // Twin Megaphone Horn Builder
  const makeHorn = (yOffset: number, side: number, rotZ: number) => {
    const hornGroup = new THREE.Group();
    hornGroup.position.set(side * 0.25, yOffset, 0.15);
    hornGroup.rotation.z = rotZ;

    // Horn cone pointing forward (+Z)
    const cone = registerHit(new THREE.Mesh(new THREE.ConeGeometry(0.58, 1.15, 16, 1, true), rustedMetalMat));
    cone.rotation.x = -Math.PI * 0.5;
    cone.position.z = 0.55;
    hornGroup.add(cone);

    // Back cap
    const cap = registerHit(new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.35, 10), rustedMetalMat));
    cap.rotation.x = Math.PI * 0.5;
    cap.position.z = -0.1;
    hornGroup.add(cap);

    // Inner crimson speaker cone
    const speaker = new THREE.Mesh(new THREE.CircleGeometry(0.46, 14), hornGlowMat);
    speaker.position.z = 0.92;
    hornGroup.add(speaker);

    return hornGroup;
  };

  headPole.add(makeHorn(1.85, -1, 0.25));
  headPole.add(makeHorn(2.25, 1, -0.22));

  // Hand attach socket on right skeletal hand for grabbing survivor
  const handAttach = new THREE.Group();
  handAttach.position.set(0, -2.75, 0.2);
  rightElbow.add(handAttach);

  // Mouth target socket right between twin megaphone maws
  const mouthTarget = new THREE.Object3D();
  mouthTarget.position.set(0, 2.05, 0.95);
  headPole.add(mouthTarget);

  return {
    root,
    bodyPivot,
    leftLeg,
    rightLeg,
    leftKnee,
    rightKnee,
    leftArm,
    rightArm,
    leftElbow,
    rightElbow,
    headPole,
    handAttach,
    mouthTarget,
    hornGlowMat,
    hitMeshes,
    skinMat,
  };
}

export function createSurvivorModel(jacketColorHex = 0x334155, withRemoteGear = false): SurvivorRig {
  const root = new THREE.Group();

  const jacketMat = new THREE.MeshStandardMaterial({
    color: jacketColorHex,
    roughness: 0.78,
    metalness: 0.08,
  });
  const pantsMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    roughness: 0.88,
  });
  const skinMat = new THREE.MeshStandardMaterial({
    color: 0xd6b49c,
    roughness: 0.7,
  });
  const bootMat = new THREE.MeshStandardMaterial({
    color: 0x18181b,
    roughness: 0.65,
  });

  // Torso centered near y = 1.05 (total height ~1.72m)
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.62, 0.26), jacketMat);
  torso.position.y = 1.1;
  torso.castShadow = true;
  root.add(torso);

  // Head & Rain Hood
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12), skinMat);
  head.position.set(0, 1.56, 0.02);
  root.add(head);

  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.185, 12, 12, 0, Math.PI * 2, 0, Math.PI * 0.65), jacketMat);
  hood.position.set(0, 1.58, -0.02);
  hood.rotation.x = -0.35;
  root.add(hood);

  // Arms
  const makeArm = (side: number) => {
    const g = new THREE.Group();
    g.position.set(side * 0.3, 1.36, 0);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.56, 8), jacketMat);
    arm.position.y = -0.28;
    g.add(arm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), skinMat);
    hand.position.y = -0.58;
    g.add(hand);
    root.add(g);
    return g;
  };
  const leftArm = makeArm(-1);
  const rightArm = makeArm(1);

  // Legs
  const makeLeg = (side: number) => {
    const g = new THREE.Group();
    g.position.set(side * 0.13, 0.78, 0);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.065, 0.68, 8), pantsMat);
    leg.position.y = -0.34;
    g.add(leg);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.12, 0.22), bootMat);
    boot.position.set(0, -0.72, 0.05);
    g.add(boot);
    root.add(g);
    return g;
  };
  const leftLeg = makeLeg(-1);
  const rightLeg = makeLeg(1);

  let flashlightCone: THREE.Mesh | undefined;
  let gunMesh: THREE.Group | undefined;

  if (withRemoteGear) {
    // Lightweight additive volumetric flashlight cone on teammate (no extra shadow pass cost!)
    const torchMat = new THREE.MeshStandardMaterial({
      color: 0x27272a,
      roughness: 0.4,
      metalness: 0.8,
    });
    const torchBody = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.028, 0.18, 8), torchMat);
    torchBody.rotation.x = Math.PI * 0.5;
    torchBody.position.set(0, -0.56, -0.14);
    leftArm.add(torchBody);

    const coneGeo = new THREE.ConeGeometry(1.85, 8.5, 12, 1, true);
    coneGeo.translate(0, -4.25, 0);
    coneGeo.rotateX(Math.PI * 0.5);
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0xfff3d1,
      transparent: true,
      opacity: 0.09,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    flashlightCone = new THREE.Mesh(coneGeo, coneMat);
    flashlightCone.position.set(0.22, 1.32, -0.2);
    root.add(flashlightCone);

    // Compact 3rd-person AK-47 silhouette
    gunMesh = new THREE.Group();
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x27272a, roughness: 0.35, metalness: 0.8 });
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x6b3a1e, roughness: 0.72 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.42), metalMat);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.36, 6), metalMat);
    barrel.rotation.x = Math.PI * 0.5;
    barrel.position.set(0, 0.02, -0.35);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 0.22), woodMat);
    stock.position.set(0, -0.02, 0.26);
    gunMesh.add(body, barrel, stock);
    gunMesh.position.set(0.24, 1.08, -0.25);
    gunMesh.visible = false;
    root.add(gunMesh);
  }

  return { root, leftArm, rightArm, leftLeg, rightLeg, flashlightCone, gunMesh };
}

export interface WatchtowerModels {
  intactGroup: THREE.Group;
  collapsedGroup: THREE.Group;
  beaconLight: THREE.PointLight;
  beaconBulbMat: THREE.MeshStandardMaterial;
}

export function createWatchtowerModels(textures: ForestTextures): WatchtowerModels {
  const intactGroup = new THREE.Group();
  const collapsedGroup = new THREE.Group();
  collapsedGroup.visible = false;

  const steelMat = new THREE.MeshStandardMaterial({
    color: 0x475569,
    roughness: 0.45,
    metalness: 0.78,
  });

  const woodMat = new THREE.MeshStandardMaterial({
    map: textures.woodPlankColor,
    color: 0x8b6b50,
    roughness: 0.86,
    metalness: 0.05,
  });

  const roofMat = new THREE.MeshStandardMaterial({
    color: 0x334155,
    roughness: 0.52,
    metalness: 0.65,
  });

  const deckY = TOWER_DECK_HEIGHT;
  const halfW = 3.4;

  // 1. 4 Heavy Corner Pillars (ground y=-0.5 to roof y=deckY + 3.1m)
  const pillarH = deckY + 3.6;
  const corners = [
    [-halfW, -halfW],
    [halfW, -halfW],
    [-halfW, halfW],
    [halfW, halfW],
  ];
  for (const [cx, cz] of corners) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.34, pillarH, 0.34), steelMat);
    pillar.position.set(cx, -0.5 + pillarH * 0.5, cz);
    pillar.castShadow = true;
    pillar.receiveShadow = true;
    intactGroup.add(pillar);
  }

  // Mid-height horizontal tie beams (at y = deckY * 0.5)
  const midY = deckY * 0.5;
  const beamXGeo = new THREE.BoxGeometry(halfW * 2, 0.18, 0.18);
  const beamZGeo = new THREE.BoxGeometry(0.18, 0.18, halfW * 2);
  for (const sign of [-1, 1]) {
    const bx = new THREE.Mesh(beamXGeo, steelMat);
    bx.position.set(0, midY, sign * halfW);
    const bz = new THREE.Mesh(beamZGeo, steelMat);
    bz.position.set(sign * halfW, midY, 0);
    intactGroup.add(bx, bz);
  }

  // Two-Tier Cross Bracing Beams under the tall deck
  const tierCenters = [deckY * 0.25, deckY * 0.75];
  const braceLen = Math.hypot(halfW * 2, deckY * 0.5);
  const braceTilt = Math.atan2(deckY * 0.5, halfW * 2);
  const braceGeo = new THREE.BoxGeometry(0.13, 0.13, braceLen);
  for (const ty of tierCenters) {
    for (let side = 0; side < 4; side++) {
      for (const diag of [-1, 1]) {
        const brace = new THREE.Mesh(braceGeo, steelMat);
        brace.position.y = ty;
        if (side < 2) {
          brace.position.x = side === 0 ? -halfW : halfW;
          brace.rotation.x = diag * braceTilt;
        } else {
          brace.position.z = side === 2 ? -halfW : halfW;
          brace.rotation.y = Math.PI * 0.5;
          brace.rotation.x = diag * braceTilt;
        }
        intactGroup.add(brace);
      }
    }
  }

  // 2. Elevated Wooden Cabin Deck (6.9m x 6.9m at y = 9.2m)
  const deck = new THREE.Mesh(new THREE.BoxGeometry(7.1, 0.28, 7.1), woodMat);
  deck.position.set(0, deckY - 0.14, 0);
  deck.receiveShadow = true;
  deck.castShadow = true;
  intactGroup.add(deck);

  // 3. Perimeter Guard Railings (North, West, East, and South flanking doorway)
  const addRail = (x: number, z: number, w: number, d: number) => {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 1.05, d), woodMat);
    rail.position.set(x, deckY + 0.52, z);
    rail.castShadow = true;
    rail.receiveShadow = true;
    intactGroup.add(rail);
  };
  addRail(0, -halfW, 6.9, 0.22); // North
  addRail(-halfW, 0, 0.22, 6.9); // West
  addRail(halfW, 0, 0.22, 6.9); // East
  addRail(-2.25, halfW, 2.3, 0.22); // South-left (leaving 2.2m center stairs open!)
  addRail(2.25, halfW, 2.3, 0.22); // South-right

  // 4. Walkable South Staircase Ramp (from z = +16.0m ground up to z = +3.4m deck!)
  const rampLen = Math.hypot(TOWER_RAMP_RUN, deckY);
  const rampPitch = Math.atan2(deckY, TOWER_RAMP_RUN);
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.22, rampLen), woodMat);
  ramp.position.set(0, deckY * 0.5 - 0.08, halfW + TOWER_RAMP_RUN * 0.5);
  ramp.rotation.x = rampPitch;
  ramp.receiveShadow = true;
  ramp.castShadow = true;
  intactGroup.add(ramp);

  // Staircase handrails along both sides of the tall ramp
  const stairRailGeo = new THREE.BoxGeometry(0.1, 0.12, rampLen);
  for (const side of [-1, 1]) {
    const stairRail = new THREE.Mesh(stairRailGeo, steelMat);
    stairRail.position.set(side * 1.12, deckY * 0.5 + 0.72, halfW + TOWER_RAMP_RUN * 0.5);
    stairRail.rotation.x = rampPitch;
    intactGroup.add(stairRail);

    const midPost = new THREE.Mesh(new THREE.BoxGeometry(0.12, deckY * 0.5 + 0.9, 0.12), steelMat);
    midPost.position.set(side * 1.12, (deckY * 0.5 + 0.9) * 0.5 - 0.2, halfW + TOWER_RAMP_RUN * 0.5);
    intactGroup.add(midPost);
  }

  // Stair treads along ramp for visual clarity
  const treadCount = 22;
  for (let i = 1; i < treadCount; i++) {
    const t = i / treadCount;
    const step = new THREE.Mesh(new THREE.BoxGeometry(2.24, 0.14, 0.35), woodMat);
    step.position.set(0, deckY * (1 - t) - 0.02, halfW + t * TOWER_RAMP_RUN);
    intactGroup.add(step);
  }

  // Ground anchor plinth at stair entrance to seat cleanly on undulating forest terrain
  const stairBase = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.4, 1.4), steelMat);
  stairBase.position.set(0, -0.65, halfW + TOWER_RAMP_RUN);
  stairBase.receiveShadow = true;
  intactGroup.add(stairBase);

  // 5. Roof Frame & Corrugated Roof (y = deckY + 3.65m)
  const roof = new THREE.Mesh(new THREE.ConeGeometry(5.6, 1.65, 4), roofMat);
  roof.position.set(0, deckY + 3.65, 0);
  roof.rotation.y = Math.PI * 0.25;
  roof.castShadow = true;
  intactGroup.add(roof);

  // 6. Red Aircraft Warning Beacon atop roof peak (y = deckY + 4.65m = 13.85m)
  const beaconBulbMat = new THREE.MeshStandardMaterial({
    color: 0x7f1d1d,
    emissive: 0xef4444,
    emissiveIntensity: 3.0,
    roughness: 0.2,
  });
  const beaconBulb = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 12), beaconBulbMat);
  beaconBulb.position.set(0, deckY + 4.65, 0);
  intactGroup.add(beaconBulb);

  const beaconLight = new THREE.PointLight(0xef4444, 30, 72, 1.35);
  beaconLight.position.set(0, deckY + 4.8, 0);
  intactGroup.add(beaconLight);

  // --- Permanent Collapsed Wreckage Group (when 30% collapse triggers!) ---
  const debrisSpecs: [number, number, number, number, number, number, number, number, number, boolean][] = [
    [-1.8, 0.45, -1.2, 0.28, 0.28, 7.6, 0.1, 0.4, 0.12, true],
    [1.6, 0.4, 0.8, 0.28, 0.28, 7.4, -0.08, -0.5, 0.09, true],
    [-0.2, 0.3, 1.4, 4.2, 0.24, 3.8, 0.18, 0.2, -0.14, false],
    [1.2, 0.32, -1.5, 3.6, 0.24, 3.4, -0.15, -0.35, 0.16, false],
    [0, 0.55, 0.2, 4.6, 0.16, 4.6, 0.22, 0.7, 0.1, true],
    [-2.4, 0.22, 2.2, 0.24, 0.24, 5.2, 0.05, 1.1, -0.05, false],
  ];
  for (const [x, y, z, w, h, d, rx, ry, rz, isSteel] of debrisSpecs) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), isSteel ? steelMat : woodMat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    collapsedGroup.add(m);
  }

  return {
    intactGroup,
    collapsedGroup,
    beaconLight,
    beaconBulbMat,
  };
}

export interface AK47ViewModel {
  root: THREE.Group;
  muzzleFlash: THREE.Group;
  muzzleLight: THREE.PointLight;
}

export function createAK47ViewModel(): AK47ViewModel {
  const root = new THREE.Group();

  const gunMetalMat = new THREE.MeshStandardMaterial({
    color: 0x27272a,
    roughness: 0.32,
    metalness: 0.86,
  });

  const woodGripMat = new THREE.MeshStandardMaterial({
    color: 0x6b3a1e,
    roughness: 0.72,
    metalness: 0.08,
  });

  const bakeliteMagMat = new THREE.MeshStandardMaterial({
    color: 0x7c2d12,
    roughness: 0.55,
    metalness: 0.15,
  });

  // Receiver
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.095, 0.34), gunMetalMat);
  receiver.position.set(0, 0, -0.12);
  root.add(receiver);

  // Wooden Stock
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.11, 0.24), woodGripMat);
  stock.position.set(0, -0.025, 0.15);
  stock.rotation.x = 0.08;
  root.add(stock);

  // Pistol Grip
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.12, 0.055), woodGripMat);
  grip.position.set(0, -0.09, 0.01);
  grip.rotation.x = 0.32;
  root.add(grip);

  // Curved Banana Magazine
  const mag1 = new THREE.Mesh(new THREE.BoxGeometry(0.042, 0.15, 0.075), bakeliteMagMat);
  mag1.position.set(0, -0.11, -0.14);
  mag1.rotation.x = -0.22;
  root.add(mag1);
  const mag2 = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.12, 0.07), bakeliteMagMat);
  mag2.position.set(0, -0.21, -0.18);
  mag2.rotation.x = -0.45;
  root.add(mag2);

  // Handguard
  const handguard = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.075, 0.22), woodGripMat);
  handguard.position.set(0, 0.005, -0.39);
  root.add(handguard);

  // Barrel & Gas Tube
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.016, 0.44, 10), gunMetalMat);
  barrel.rotation.x = Math.PI * 0.5;
  barrel.position.set(0, 0.02, -0.58);
  root.add(barrel);

  const gasTube = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.26, 8), gunMetalMat);
  gasTube.rotation.x = Math.PI * 0.5;
  gasTube.position.set(0, 0.045, -0.42);
  root.add(gasTube);

  // Front Sight Post
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.045, 0.02), gunMetalMat);
  sight.position.set(0, 0.055, -0.74);
  root.add(sight);

  // Multi-layered Additive Star-Burst Muzzle Flash & Dynamic Illumination Light
  const muzzleFlash = new THREE.Group();
  muzzleFlash.position.set(0, 0.022, -0.85);
  muzzleFlash.visible = false;

  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.96,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const coreMesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.06, 0), coreMat);
  coreMesh.scale.set(1, 1, 1.8);
  muzzleFlash.add(coreMesh);

  const starMat = new THREE.MeshBasicMaterial({
    color: 0xfde047,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const bladeGeo = new THREE.PlaneGeometry(0.32, 0.09);
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(bladeGeo, starMat);
    blade.rotation.z = (i * Math.PI) / 3;
    muzzleFlash.add(blade);
  }

  const jetMat = new THREE.MeshBasicMaterial({
    color: 0xfb923c,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const jetCone = new THREE.Mesh(new THREE.ConeGeometry(0.068, 0.34, 6), jetMat);
  jetCone.rotation.x = -Math.PI * 0.5;
  jetCone.position.z = -0.14;
  muzzleFlash.add(jetCone);

  root.add(muzzleFlash);

  const muzzleLight = new THREE.PointLight(0xffcb6b, 0, 34, 1.35);
  muzzleLight.position.set(0, 0.05, -0.9);
  root.add(muzzleLight);

  return { root, muzzleFlash, muzzleLight };
}

export function createLootCrateModel(type: LootType): THREE.Group {
  const group = new THREE.Group();

  const bodyColor =
    type === 'AK47'
      ? 0x78350f
      : type === 'AMMO'
      ? 0x365314
      : type === 'MEDKIT'
      ? 0xe2e8f0
      : 0x1e3a8a;

  const trimColor =
    type === 'AK47'
      ? 0xf59e0b
      : type === 'AMMO'
      ? 0xa3e635
      : type === 'MEDKIT'
      ? 0xdc2626
      : 0x38bdf8;

  const bodyMat = new THREE.MeshStandardMaterial({
    color: bodyColor,
    roughness: 0.65,
    metalness: 0.25,
  });

  const trimMat = new THREE.MeshStandardMaterial({
    color: trimColor,
    emissive: trimColor,
    emissiveIntensity: 0.45,
    roughness: 0.35,
    metalness: 0.4,
  });

  const width = type === 'AK47' ? 1.15 : 0.68;
  const height = type === 'AK47' ? 0.34 : 0.42;
  const depth = type === 'AK47' ? 0.48 : 0.52;

  const box = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), bodyMat);
  box.position.y = height * 0.5;
  box.castShadow = true;
  box.receiveShadow = true;
  group.add(box);

  const lid = new THREE.Mesh(new THREE.BoxGeometry(width + 0.04, 0.06, depth + 0.04), trimMat);
  lid.position.y = height + 0.02;
  group.add(lid);

  if (type === 'MEDKIT') {
    const cross1 = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.03, 0.08), trimMat);
    cross1.position.y = height + 0.06;
    const cross2 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.03, 0.28), trimMat);
    cross2.position.y = height + 0.06;
    group.add(cross1, cross2);
  }

  return group;
}
