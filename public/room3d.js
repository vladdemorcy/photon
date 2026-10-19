// 3D preview of a room. Units are feet, matching the floor plan:
// x runs left to right, z runs from the back wall toward the viewer, y is height.
// A furniture piece's local +z side is its back (backrest, headboard); it faces -z.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const FABRIC = 0x1d2850;
const FABRIC_DARK = 0x16203f;
const WOOD = 0x2a2c45;
const TIMBER = 0x4a3a2e;
const TIMBER_DARK = 0x35291f;
const STONE = 0x3a3e52;
const LEAF = 0x245c40;
const LIGHT_BUDGET = 28; // point lights are costly; strips share them when a room has many

export function createRoom3D(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.setClearColor(0x03050b);
  host.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x03050b, 40, 90);
  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 300);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 6;
  controls.maxDistance = 70;

  scene.add(new THREE.HemisphereLight(0x6f86d8, 0x0a0c18, 0.9));
  scene.add(new THREE.AmbientLight(0x7a88c0, 0.55)); // enough to see the room with every light off
  const dyn = new THREE.Group();
  scene.add(dyn);
  const tex = glowTexture();

  let dims = null;
  let disposed = false;

  function clear() {
    dyn.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
    });
    dyn.clear();
  }

  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, ...extra });
  function box(parent, w, h, d, color, x = 0, y = h / 2, z = 0, extra) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, extra));
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }
  function cyl(parent, rTop, rBot, h, color, x, y, z, extra, seg = 20) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat(color, extra));
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }

  function seat(g, w, d, armW = 0.55) {
    box(g, w, 1.4, d, FABRIC, 0, 0.7, 0);
    box(g, w, 1.7, 0.7, FABRIC_DARK, 0, 2.0, d / 2 - 0.35);
    if (armW) {
      box(g, armW, 1.0, d, FABRIC_DARK, -w / 2 + armW / 2, 1.7, 0);
      box(g, armW, 1.0, d, FABRIC_DARK, w / 2 - armW / 2, 1.7, 0);
    }
  }

  function table(g, w, d, ht, round = false) {
    if (round) {
      cyl(g, Math.min(w, d) / 2, Math.min(w, d) / 2, 0.12, WOOD, 0, ht, 0, {}, 28);
      cyl(g, 0.12, 0.2, ht, WOOD, 0, ht / 2, 0);
      return;
    }
    box(g, w, 0.14, d, WOOD, 0, ht, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, 0.15, ht, 0.15, WOOD, sx * (w / 2 - 0.2), ht / 2, sz * (d / 2 - 0.2));
  }

  function furniture(f, screensOn) {
    const g = new THREE.Group();
    const { w, d, ht } = f;
    switch (f.kind) {
      case 'tv': {
        const h = w * 9 / 16;
        box(g, w, h, 0.15, 0x05070f, 0, 2.6 + h / 2, 0);
        const scr = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.96, h * 0.92),
          mat(0x000000, { emissive: screensOn ? 0x2a6bd8 : 0x0a1020, emissiveIntensity: screensOn ? 1.4 : 1 }));
        scr.position.set(0, 2.6 + h / 2, 0.08);
        g.add(scr);
        if (screensOn) { const l = new THREE.PointLight(0x4d8cff, 120, 0, 1.6); l.position.set(0, 2.6 + h / 2, 1.2); g.add(l); }
        break;
      }
      case 'screen': {
        const h = w * 0.56;
        const scr = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat(screensOn ? 0x1b2a55 : 0x1a2034, { emissive: screensOn ? 0x3b78e0 : 0x000000, emissiveIntensity: screensOn ? 1.1 : 0 }));
        scr.position.set(0, 1.6 + h / 2, 0.1);
        g.add(scr);
        box(g, w + 0.3, 0.25, 0.25, 0x0b0f1d, 0, 1.6 + h + 0.12, 0);
        if (screensOn) { const l = new THREE.PointLight(0x5b8cff, 160, 0, 1.6); l.position.set(0, 1.6 + h / 2, 1.5); g.add(l); }
        break;
      }
      case 'tvstand': box(g, w, ht, d, 0x151d36); break;
      case 'sofa': case 'loveseat': seat(g, w, d); break;
      case 'armchair': seat(g, w, d, 0.5); break;
      case 'chair':
        box(g, w, 0.18, d, FABRIC, 0, 1.5, 0);
        box(g, w, 1.6, 0.15, FABRIC_DARK, 0, 2.3, d / 2 - 0.08);
        cyl(g, 0.1, 0.25, 1.4, WOOD, 0, 0.7, 0);
        break;
      case 'sectional': {
        const depthSeat = Math.min(3.2, d / 2);
        box(g, w, 1.4, depthSeat, FABRIC, 0, 0.7, d / 2 - depthSeat / 2);
        box(g, depthSeat, 1.4, d - depthSeat, FABRIC, -w / 2 + depthSeat / 2, 0.7, -depthSeat / 2);
        box(g, w, 1.7, 0.7, FABRIC_DARK, 0, 2.0, d / 2 - 0.35);
        box(g, 0.7, 1.7, d, FABRIC_DARK, -w / 2 + 0.35, 2.0, 0);
        box(g, 0.55, 1.0, depthSeat, FABRIC_DARK, w / 2 - 0.27, 1.7, d / 2 - depthSeat / 2);
        break;
      }
      case 'bed': case 'kingbed':
        box(g, w, 1.0, d, 0x1a2242, 0, 0.5, 0);
        box(g, w - 0.2, 0.8, d - 0.4, 0x3a4a7c, 0, 1.4, -0.1);
        box(g, w, 3.6, 0.3, FABRIC_DARK, 0, 1.8, d / 2 - 0.15);
        box(g, w * 0.4, 0.4, 1.2, 0x56679c, -w * 0.22, 2.0, d / 2 - 1.0);
        box(g, w * 0.4, 0.4, 1.2, 0x56679c, w * 0.22, 2.0, d / 2 - 1.0);
        box(g, w - 0.1, 0.12, d * 0.45, 0x2a3866, 0, 1.86, -d * 0.25);
        break;
      case 'nightstand': case 'dresser': box(g, w, ht, d, WOOD); break;
      case 'sidetable': table(g, w, d, ht, true); break;
      case 'coffeetable': case 'desk': case 'diningtable': table(g, w, d, ht); break;
      case 'bookshelf':
        box(g, w, ht, d, 0x1c2546);
        for (let y = 1.2; y < ht; y += 1.4) box(g, w - 0.2, 0.08, d - 0.1, 0x2b3768, 0, y, 0.05);
        break;
      case 'rug': {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(0x24315f, { roughness: 1 }));
        m.rotation.x = -Math.PI / 2;
        m.position.y = 0.02;
        g.add(m);
        break;
      }
      case 'plant': {
        const r = Math.min(w, d) / 2;
        cyl(g, r * 0.6, r * 0.45, 1.2, 0x3a3150, 0, 0.6, 0);
        const leaves = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat(0x2c6e52));
        leaves.position.y = 1.2 + r * 1.2;
        leaves.scale.y = 1.4;
        g.add(leaves);
        break;
      }
      case 'door': box(g, w, 7, 0.15, 0x2a3254, 0, 3.5, 0); break;
      case 'window': {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 4), mat(0x1b2a4a, { emissive: 0x23406e, emissiveIntensity: 0.6, transparent: true, opacity: 0.85 }));
        m.position.set(0, 5, 0.09);
        g.add(m);
        box(g, w + 0.2, 0.15, 0.3, 0x3a4a80, 0, 2.95, 0);
        break;
      }
      // ---- outside ----
      case 'pergola': {
        const post = 0.45, top = ht;
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(g, post, top, post, TIMBER, sx * (w / 2 - post / 2), top / 2, sz * (d / 2 - post / 2));
        for (const sz of [-1, 1]) box(g, w + 1.2, 0.7, 0.3, TIMBER_DARK, 0, top + 0.1, sz * (d / 2 - post / 2));
        const n = Math.max(3, Math.round(w / 1.5));
        for (let i = 0; i <= n; i++) box(g, 0.2, 0.45, d + 1.4, TIMBER, -w / 2 + (w * i) / n, top + 0.6, 0);
        break;
      }
      case 'gazebo': {
        const r = Math.min(w, d) / 2, wall = Math.max(6.5, ht - 3.5);
        cyl(g, r, r, 0.5, TIMBER_DARK, 0, 0.25, 0, {}, 8);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
          box(g, 0.35, wall, 0.35, TIMBER, Math.cos(a) * (r - 0.3), 0.5 + wall / 2, Math.sin(a) * (r - 0.3));
        }
        const roof = new THREE.Mesh(new THREE.ConeGeometry(r + 0.9, ht - wall, 8), mat(0x2b2638));
        roof.position.y = 0.5 + wall + (ht - wall) / 2;
        roof.rotation.y = Math.PI / 8;
        g.add(roof);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r - 0.3, 0.12, 6, 8), mat(TIMBER));
        ring.rotation.x = Math.PI / 2; ring.rotation.z = Math.PI / 8; ring.position.y = 0.5 + wall;
        g.add(ring);
        break;
      }
      case 'fence': case 'railing': {
        const fence = f.kind === 'fence';
        const n = Math.max(1, Math.round(w / (fence ? 6 : 5)));
        for (let i = 0; i <= n; i++) box(g, 0.35, ht + 0.2, 0.35, TIMBER_DARK, -w / 2 + (w * i) / n, (ht + 0.2) / 2, 0);
        if (fence) box(g, w, ht - 0.3, 0.12, TIMBER, 0, (ht - 0.3) / 2 + 0.15, 0);
        else {
          box(g, w, 0.25, 0.3, TIMBER, 0, ht, 0);
          const bal = Math.min(160, Math.round(w / 0.45));
          for (let i = 1; i < bal; i++) box(g, 0.08, ht - 0.3, 0.08, TIMBER, -w / 2 + (w * i) / bal, (ht - 0.3) / 2 + 0.1, 0);
        }
        break;
      }
      case 'deck':
        box(g, w, ht, d, TIMBER_DARK);
        for (let z = -d / 2 + 0.5; z < d / 2; z += Math.max(0.6, d / 40)) box(g, w - 0.05, 0.02, 0.06, 0x241b14, 0, ht + 0.01, z);
        break;
      case 'patio': {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(STONE, { roughness: 1 }));
        m.rotation.x = -Math.PI / 2; m.position.y = 0.03; g.add(m);
        break;
      }
      case 'path': {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat(0x34384c, { roughness: 1 }));
        m.rotation.x = -Math.PI / 2; m.position.y = 0.025; g.add(m);
        break;
      }
      case 'housewall':
        box(g, w, ht, d, 0x232a45);
        box(g, w + 0.4, 0.4, d + 0.8, 0x1a1f33, 0, ht + 0.2, 0.2);
        break;
      case 'shed': {
        const wallH = ht * 0.7;
        box(g, w, wallH, d, 0x2d2a3e, 0, wallH / 2, 0);
        const tri = new THREE.Shape([new THREE.Vector2(-w / 2 - 0.4, 0), new THREE.Vector2(w / 2 + 0.4, 0), new THREE.Vector2(0, ht - wallH)]);
        const roofGeo = new THREE.ExtrudeGeometry(tri, { depth: d + 0.6, bevelEnabled: false });
        roofGeo.translate(0, 0, -(d + 0.6) / 2);
        const roof = new THREE.Mesh(roofGeo, mat(0x1f1c2c));
        roof.position.y = wallH;
        g.add(roof);
        box(g, 3, 6, 0.1, 0x1a1828, 0, 3, -d / 2 - 0.05);
        break;
      }
      case 'pool': {
        const rim = 0.8;
        box(g, w, 0.3, rim, STONE, 0, 0.15, -d / 2 + rim / 2); box(g, w, 0.3, rim, STONE, 0, 0.15, d / 2 - rim / 2);
        box(g, rim, 0.3, d, STONE, -w / 2 + rim / 2, 0.15, 0); box(g, rim, 0.3, d, STONE, w / 2 - rim / 2, 0.15, 0);
        const water = new THREE.Mesh(new THREE.PlaneGeometry(w - rim * 2, d - rim * 2), mat(0x0d4a7a, { emissive: 0x0b3d6e, emissiveIntensity: 0.6, roughness: 0.15, metalness: 0.2 }));
        water.rotation.x = -Math.PI / 2; water.position.y = 0.12; g.add(water);
        break;
      }
      case 'hottub':
        box(g, w, ht, d, 0x2c2b3c);
        { const water = new THREE.Mesh(new THREE.PlaneGeometry(w - 1, d - 1), mat(0x1a6ea6, { emissive: 0x135a8c, emissiveIntensity: 0.7, roughness: 0.2 }));
          water.rotation.x = -Math.PI / 2; water.position.y = ht - 0.25; g.add(water); }
        break;
      case 'firepit': {
        const r = Math.min(w, d) / 2;
        const ringM = new THREE.Mesh(new THREE.TorusGeometry(r - 0.4, 0.4, 10, 28), mat(STONE));
        ringM.rotation.x = Math.PI / 2; ringM.position.y = ht * 0.55; ringM.scale.z = 1.6; g.add(ringM);
        const ember = new THREE.Mesh(new THREE.CircleGeometry(r - 0.6, 24), mat(0x220a00, { emissive: 0xff6a1a, emissiveIntensity: 1.6 }));
        ember.rotation.x = -Math.PI / 2; ember.position.y = ht * 0.5; g.add(ember);
        const fire = new THREE.PointLight(0xff7a2a, 60, 0, 1.8); fire.position.y = ht + 0.8; g.add(fire);
        break;
      }
      case 'patiotable': {
        const r = Math.min(w, d) / 2;
        cyl(g, r * 0.7, r * 0.7, 0.1, 0x2a3050, 0, 2.4, 0, {}, 24);
        cyl(g, 0.08, 0.08, ht, 0x8a8fa8, 0, ht / 2, 0, {}, 8);
        const canopy = new THREE.Mesh(new THREE.ConeGeometry(r * 1.9, 1.3, 8, 1, true), mat(0x3d4a80, { side: THREE.DoubleSide }));
        canopy.position.y = ht - 0.5; g.add(canopy);
        break;
      }
      case 'lounger': {
        box(g, w, 0.9, d * 0.65, 0x2c3a68, 0, 0.45, -d * 0.17);
        const back = box(g, w, 0.25, d * 0.38, 0x2c3a68, 0, 1.4, d * 0.28);
        back.rotation.x = -0.6;
        break;
      }
      case 'outdoorsofa': seat(g, w, d, 0.4); break;
      case 'grill':
        box(g, w * 0.7, 1.4, d, 0x1a1d28, 0, 3.1, 0);
        box(g, w, 0.12, d, 0x2a2e3e, 0, 2.4, 0);
        for (const sx of [-1, 1]) box(g, 0.12, 2.4, d * 0.8, 0x2a2e3e, sx * w * 0.32, 1.2, 0);
        break;
      case 'tree': {
        const r = Math.min(w, d) / 2;
        cyl(g, 0.35, 0.55, ht * 0.5, 0x3a2c22, 0, ht * 0.25, 0, {}, 10);
        for (const [dx, dy, dz, k] of [[0, 0.62, 0, 1], [r * 0.35, 0.55, r * 0.2, 0.7], [-r * 0.3, 0.5, -r * 0.25, 0.72]]) {
          const crown = new THREE.Mesh(new THREE.SphereGeometry(r * k * 0.85, 16, 12), mat(LEAF));
          crown.position.set(dx, ht * dy + r * 0.2, dz);
          crown.scale.y = 0.9;
          g.add(crown);
        }
        break;
      }
      case 'shrub': {
        const r = Math.min(w, d) / 2;
        const b = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), mat(0x2d6e4f));
        b.position.y = ht * 0.5; b.scale.y = ht / (2 * r); g.add(b);
        break;
      }
      case 'hedge': box(g, w, ht, d, 0x2a6247, 0, ht / 2, 0, { roughness: 1 }); break;
      case 'gardenbed':
        box(g, w, ht, d, TIMBER_DARK);
        box(g, w - 0.4, 0.05, d - 0.4, 0x2a1d16, 0, ht + 0.01, 0);
        for (let x = -w / 2 + 1; x < w / 2; x += 1.6) { const p = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 8), mat(0x3b7a52)); p.position.set(x, ht + 0.4, 0); g.add(p); }
        break;
      default: box(g, w, ht || 2, d, FABRIC);
    }
    return g;
  }

  function halo(parent, color, level, x, y, z, scale = 1) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.35 + level * 0.5 }));
    const k = (1.6 + level * 4) * scale;
    s.scale.set(k, k, 1);
    s.position.set(x, y, z);
    parent.add(s);
  }

  function addLight(l, budget) {
    const g = new THREE.Group();
    const color = new THREE.Color(`rgb(${l.rgb[0]},${l.rgb[1]},${l.rgb[2]})`);
    const lit = l.level > 0;
    const emissive = lit ? color : new THREE.Color(0x0b1020);
    const glowMat = () => mat(0x111827, { emissive, emissiveIntensity: lit ? 0.6 + l.level * 2 : 1 });
    const brandMat = new THREE.LineBasicMaterial({ color: l.brand, transparent: true, opacity: 0.4 });
    const h = Math.max(0.15, l.h);
    const power = 40 + l.level * 360;

    if (l.shape === 'strip') {
      const len = Math.max(1, l.len || 6);
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, len, 10), glowMat());
      tube.rotation.z = Math.PI / 2;
      tube.position.y = h;
      g.add(tube);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-len / 2, 0.03, 0), new THREE.Vector3(len / 2, 0.03, 0)]), brandMat);
      g.add(line);
      if (lit) {
        const n = budget.left >= 3 ? 3 : 1;
        budget.left -= n;
        for (let i = 0; i < n; i++) {
          const x = n === 1 ? 0 : -len / 2 + (len * (i + 0.5)) / n;
          const pl = new THREE.PointLight(color, power / n * 1.3, 0, 1.6);
          pl.position.set(x, h, 0.3);
          g.add(pl);
        }
        const steps = Math.max(2, Math.round(len / 1.5));
        for (let i = 0; i <= steps; i++) halo(g, color, l.level, -len / 2 + (len * i) / steps, h, 0, 0.6);
      }
    } else if (l.shape === 'panel') {
      const offsets = [[-0.55, 0], [0.55, 0], [0, 0.95], [1.1, 0.95]];
      for (const [ox, oy] of offsets) {
        const hex = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.08, 6), glowMat());
        hex.rotation.x = Math.PI / 2;
        hex.position.set(ox, h + oy, 0.05);
        g.add(hex);
      }
      if (lit) { budget.left--; const pl = new THREE.PointLight(color, power * 1.2, 0, 1.6); pl.position.set(0.3, h + 0.5, 0.8); g.add(pl); halo(g, color, l.level, 0.3, h + 0.5, 0.2, 1.4); }
    } else if (l.shape === 'lamp') {
      const shadeY = Math.max(1.1, h);
      if (shadeY > 3.2) cyl(g, 0.05, 0.05, shadeY, 0x2a3354, 0, shadeY / 2, 0);
      else cyl(g, 0.25, 0.35, shadeY - 0.3, 0x2a3354, 0, (shadeY - 0.3) / 2, 0);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.7, 0.9, 24, 1, true),
        mat(0x1b2238, { emissive, emissiveIntensity: lit ? 0.3 + l.level * 1.2 : 1, side: THREE.DoubleSide }));
      shade.position.y = shadeY + 0.2;
      g.add(shade);
      if (lit) { budget.left--; const pl = new THREE.PointLight(color, power, 0, 1.6); pl.position.y = shadeY + 0.1; g.add(pl); halo(g, color, l.level, 0, shadeY + 0.2, 0); }
    } else {
      const bulb = new THREE.Mesh(l.group ? new THREE.BoxGeometry(0.7, 0.7, 0.7) : new THREE.SphereGeometry(0.32, 24, 16), glowMat());
      bulb.position.y = h;
      g.add(bulb);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.05, 8, 40), new THREE.MeshBasicMaterial({ color: l.brand }));
      ring.position.y = h;
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, h, 0)]), brandMat));
      if (lit) { budget.left--; const pl = new THREE.PointLight(color, power, 0, 1.6); pl.position.y = h; g.add(pl); halo(g, color, l.level, 0, h, 0); }
    }

    if (l.shape !== 'strip') {
      const foot = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.32, 24), new THREE.MeshBasicMaterial({ color: l.brand, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
      foot.rotation.x = -Math.PI / 2;
      foot.position.y = 0.03;
      g.add(foot);
    }
    return g;
  }

  function update(model) {
    if (disposed) return;
    clear();
    const { width: W, depth: D, height: H } = model;
    const X = x => x - W / 2;
    const Z = z => z - D / 2;
    const place = (obj, x, y, rotDeg) => { obj.position.set(X(x), 0, Z(y)); obj.rotation.y = -(rotDeg || 0) * Math.PI / 180; dyn.add(obj); };

    const outdoor = Boolean(model.outdoor);
    renderer.setClearColor(outdoor ? 0x050b1c : 0x03050b);
    scene.fog.color.set(outdoor ? 0x050b1c : 0x03050b);
    scene.fog.near = Math.max(40, Math.max(W, D) * 1.2);
    scene.fog.far = Math.max(90, Math.max(W, D) * 3);
    controls.maxDistance = Math.max(70, Math.max(W, D) * 2.2);
    camera.far = Math.max(300, Math.max(W, D) * 6);
    camera.updateProjectionMatrix();

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(outdoor ? W * 1.6 : W, outdoor ? D * 1.6 : D), mat(outdoor ? 0x0f2419 : 0x141c3a, { roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    dyn.add(floor);
    const cells = outdoor ? Math.max(1, Math.round(Math.max(W, D) / 5)) : Math.max(W, D);
    const grid = new THREE.GridHelper(Math.max(W, D), cells, outdoor ? 0x1d3a2b : 0x1c2646, outdoor ? 0x15291f : 0x121a33);
    grid.scale.set(W / Math.max(W, D), 1, D / Math.max(W, D));
    grid.position.y = 0.01;
    dyn.add(grid);
    if (outdoor) {
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(W, D)), new THREE.LineBasicMaterial({ color: 0x2e5a44, transparent: true, opacity: 0.6 }));
      edge.rotation.x = -Math.PI / 2; edge.position.y = 0.02;
      dyn.add(edge);
    }
    const wallMat = () => mat(0x1a2550, { roughness: 0.9, side: THREE.DoubleSide });
    if (!outdoor) {
    const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), wallMat());
    back.position.set(0, H / 2, -D / 2);
    dyn.add(back);
    const left = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wallMat());
    left.rotation.y = Math.PI / 2;
    left.position.set(-W / 2, H / 2, 0);
    dyn.add(left);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, H, D)), new THREE.LineBasicMaterial({ color: 0x2a3762, transparent: true, opacity: 0.5 }));
    edges.position.y = H / 2;
    dyn.add(edges);
    }

    // At rotation 0 seating faces the back wall (local -z) and screens, doors and
    // windows on the back wall face into the room (local +z), matching the plan.
    for (const f of model.furniture) place(furniture(f, model.screensOn), f.x, f.y, f.rot);

    const budget = { left: LIGHT_BUDGET };
    for (const l of model.lights) place(addLight(l, budget), l.x, l.y, ['strip', 'panel'].includes(l.shape) ? l.rot : 0);

    const key = `${W}x${D}x${H}x${outdoor}`;
    if (dims !== key) {
      dims = key;
      const span = Math.max(W, D);
      camera.position.set(W * 0.55, H + span * 0.55, D * 0.5 + span * 0.95);
      controls.target.set(0, H * 0.25, 0);
      controls.update();
    }
  }

  function resize() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    update,
    dispose() {
      disposed = true;
      renderer.setAnimationLoop(null);
      ro.disconnect();
      controls.dispose();
      clear();
      tex.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
