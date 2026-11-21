import * as THREE from 'three';

export interface ForestTextures {
  groundColor: THREE.CanvasTexture;
  groundRoughness: THREE.CanvasTexture;
  barkColor: THREE.CanvasTexture;
  foliageColor: THREE.CanvasTexture;
  woodPlankColor: THREE.CanvasTexture;
  sirenSkinColor: THREE.CanvasTexture;
}

function seededRand(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function createProceduralTextures(maxAnisotropy: number): ForestTextures {
  const rand = seededRand(88173);

  // 1. Wet Mud, Pine Needles & Moss Ground Texture (512x512)
  const gCanvas = document.createElement('canvas');
  gCanvas.width = 512;
  gCanvas.height = 512;
  const gctx = gCanvas.getContext('2d')!;
  gctx.fillStyle = '#181e16';
  gctx.fillRect(0, 0, 512, 512);

  // Roughness canvas (wet puddles = dark/glossy, dirt = bright/rough)
  const rCanvas = document.createElement('canvas');
  rCanvas.width = 512;
  rCanvas.height = 512;
  const rctx = rCanvas.getContext('2d')!;
  rctx.fillStyle = '#d8d8d8';
  rctx.fillRect(0, 0, 512, 512);

  for (let i = 0; i < 85; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const rad = 18 + rand() * 50;
    const isPuddle = i < 18;
    const grad = gctx.createRadialGradient(x, y, 2, x, y, rad);
    grad.addColorStop(
      0,
      isPuddle ? 'rgba(18, 26, 32, 0.78)' : rand() > 0.5 ? 'rgba(26, 38, 22, 0.55)' : 'rgba(34, 24, 16, 0.55)'
    );
    grad.addColorStop(1, 'rgba(24, 30, 22, 0)');
    gctx.fillStyle = grad;
    gctx.beginPath();
    gctx.arc(x, y, rad, 0, Math.PI * 2);
    gctx.fill();

    if (isPuddle) {
      const rg = rctx.createRadialGradient(x, y, 2, x, y, rad);
      rg.addColorStop(0, '#222222');
      rg.addColorStop(1, 'rgba(216,216,216,0)');
      rctx.fillStyle = rg;
      rctx.beginPath();
      rctx.arc(x, y, rad, 0, Math.PI * 2);
      rctx.fill();
    }
  }

  for (let i = 0; i < 650; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const a = rand() * Math.PI * 2;
    const len = 4 + rand() * 10;
    gctx.strokeStyle = rand() > 0.4 ? 'rgba(54, 42, 28, 0.55)' : 'rgba(38, 56, 32, 0.5)';
    gctx.lineWidth = 1.4;
    gctx.beginPath();
    gctx.moveTo(x, y);
    gctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    gctx.stroke();
  }

  const groundColor = new THREE.CanvasTexture(gCanvas);
  groundColor.colorSpace = THREE.SRGBColorSpace;
  groundColor.wrapS = groundColor.wrapT = THREE.RepeatWrapping;
  groundColor.repeat.set(42, 42);
  groundColor.anisotropy = maxAnisotropy;

  const groundRoughness = new THREE.CanvasTexture(rCanvas);
  groundRoughness.wrapS = groundRoughness.wrapT = THREE.RepeatWrapping;
  groundRoughness.repeat.set(42, 42);
  groundRoughness.anisotropy = maxAnisotropy;

  // 2. Dark Wet Pine Bark Texture (256x256)
  const bCanvas = document.createElement('canvas');
  bCanvas.width = 256;
  bCanvas.height = 256;
  const bctx = bCanvas.getContext('2d')!;
  bctx.fillStyle = '#2d2018';
  bctx.fillRect(0, 0, 256, 256);

  for (let i = 0; i < 160; i++) {
    const x = rand() * 256;
    const y = rand() * 256;
    const w = 3 + rand() * 8;
    const h = 24 + rand() * 70;
    bctx.fillStyle = rand() > 0.45 ? '#1b120c' : '#443124';
    bctx.fillRect(x, y, w, h);
  }
  const barkColor = new THREE.CanvasTexture(bCanvas);
  barkColor.colorSpace = THREE.SRGBColorSpace;
  barkColor.wrapS = barkColor.wrapT = THREE.RepeatWrapping;
  barkColor.repeat.set(2, 4);
  barkColor.anisotropy = maxAnisotropy;

  // 3. Pine Foliage Needle Texture (256x256)
  const fCanvas = document.createElement('canvas');
  fCanvas.width = 256;
  fCanvas.height = 256;
  const fctx = fCanvas.getContext('2d')!;
  fctx.fillStyle = '#15281a';
  fctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 420; i++) {
    const x = rand() * 256;
    const y = rand() * 256;
    const a = rand() * Math.PI * 2;
    fctx.strokeStyle = rand() > 0.45 ? '#1f3b25' : '#0f1f13';
    fctx.lineWidth = 2;
    fctx.beginPath();
    fctx.moveTo(x, y);
    fctx.lineTo(x + Math.cos(a) * 14, y + Math.sin(a) * 14);
    fctx.stroke();
  }
  const foliageColor = new THREE.CanvasTexture(fCanvas);
  foliageColor.colorSpace = THREE.SRGBColorSpace;
  foliageColor.wrapS = foliageColor.wrapT = THREE.RepeatWrapping;
  foliageColor.anisotropy = maxAnisotropy;

  // 4. Weathered Watchtower Wood Plank Texture (256x256)
  const wCanvas = document.createElement('canvas');
  wCanvas.width = 256;
  wCanvas.height = 256;
  const wctx = wCanvas.getContext('2d')!;
  wctx.fillStyle = '#4a3525';
  wctx.fillRect(0, 0, 256, 256);
  for (let py = 0; py < 256; py += 32) {
    wctx.fillStyle = py % 64 === 0 ? '#3f2c1e' : '#4e3928';
    wctx.fillRect(0, py, 256, 30);
    wctx.fillStyle = '#1b120b';
    wctx.fillRect(0, py + 30, 256, 2);
  }
  for (let i = 0; i < 120; i++) {
    wctx.fillStyle = 'rgba(20,12,6,0.28)';
    wctx.fillRect(rand() * 256, rand() * 256, 28 + rand() * 40, 2);
  }
  const woodPlankColor = new THREE.CanvasTexture(wCanvas);
  woodPlankColor.colorSpace = THREE.SRGBColorSpace;
  woodPlankColor.wrapS = woodPlankColor.wrapT = THREE.RepeatWrapping;
  woodPlankColor.anisotropy = maxAnisotropy;

  // 5. Siren Head Desiccated Muscle/Bark Flesh Texture (256x256)
  const sCanvas = document.createElement('canvas');
  sCanvas.width = 256;
  sCanvas.height = 256;
  const sctx = sCanvas.getContext('2d')!;
  sctx.fillStyle = '#3c211d';
  sctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 180; i++) {
    sctx.strokeStyle = rand() > 0.5 ? '#26120f' : '#583029';
    sctx.lineWidth = 2 + rand() * 3;
    const x = rand() * 256;
    const y = rand() * 256;
    sctx.beginPath();
    sctx.moveTo(x, y);
    sctx.lineTo(x + (rand() - 0.5) * 14, y + 25 + rand() * 35);
    sctx.stroke();
  }
  const sirenSkinColor = new THREE.CanvasTexture(sCanvas);
  sirenSkinColor.colorSpace = THREE.SRGBColorSpace;
  sirenSkinColor.wrapS = sirenSkinColor.wrapT = THREE.RepeatWrapping;
  sirenSkinColor.anisotropy = maxAnisotropy;

  return {
    groundColor,
    groundRoughness,
    barkColor,
    foliageColor,
    woodPlankColor,
    sirenSkinColor,
  };
}
