// Blood Tube Macro — a 5 s, 9:16 single-shot macro of a gloved hand lifting a
// vacuum blood-collection tube out of a stainless rack. Everything is driven
// from HyperFrames time (hf-seek), never from a clock, so every frame is
// reproducible.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

window.THREE = THREE;

const W = 1080;
const H = 1920;
const DURATION = 5;

// ---------------------------------------------------------------------------
// Optics. A 100 mm macro on a full-frame body held vertically: the 36 mm side
// of the sensor maps to the 1920 px frame height.
const FOCAL = 0.1;
const SENSOR_H = 0.036;
const F_STOP = 5.6;
const VFOV = THREE.MathUtils.radToDeg(2 * Math.atan(SENSOR_H / 2 / FOCAL));
// Fast mode: the 3D passes run at half resolution and the grade upsamples
// to the 1080x1920 canvas (grain is added at full res). ~4x cheaper per frame.
const RS = 0.5;
const RW = Math.round(W * RS);
const RH = Math.round(H * RS);
const MAX_COC_PX = 44 * RS;

// Tube dimensions (13 x 100 mm vacuum collection tube).
const TUBE_R = 0.0065;
const TUBE_WALL = 0.0009;
const TUBE_L = 0.1;
const FILL_H = 0.064;
const CAP_R = 0.0083;
const TUBE_SPACING = 0.022;
const RACK_YAW = THREE.MathUtils.degToRad(24);
const RISE = 0.06;

// ---------------------------------------------------------------------------
// Deterministic helpers.
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const smoother = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Renderer.
const canvas = document.getElementById("three-layer");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  powerPreference: "high-performance",
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
RectAreaLightUniformsLib.init();
if ("transmissionResolutionScale" in renderer) renderer.transmissionResolutionScale = RS;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07090c);

const camera = new THREE.PerspectiveCamera(VFOV, W / H, 0.02, 12);

// ---------------------------------------------------------------------------
// Environment for reflections: a soft lab "room" with a cool ceiling softbox,
// a warm rim strip behind-right and cool bounce panels — this is what the
// glass and steel actually reflect.
function buildEnvironment() {
  const env = new THREE.Scene();
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(6, 3, 6),
    new THREE.MeshBasicMaterial({ color: 0x1a1f26, side: THREE.BackSide }),
  );
  room.position.y = 1.2;
  env.add(room);
  const panel = (w, h, color, intensity, pos, look) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(color).multiplyScalar(intensity),
        side: THREE.DoubleSide,
      }),
    );
    m.position.set(...pos);
    m.lookAt(new THREE.Vector3(...look));
    env.add(m);
  };
  // Cool overhead light panels.
  panel(1.4, 0.6, 0xeaf2ff, 9, [0, 2.5, 0], [0, 0, 0]);
  panel(1.4, 0.6, 0xe4eeff, 5, [0, 2.5, -1.6], [0, 0, -1.6]);
  panel(1.4, 0.6, 0xe4eeff, 4, [0, 2.5, 1.6], [0, 0, 1.6]);
  // Warm rim strip behind right.
  panel(0.35, 1.6, 0xffa766, 14, [1.3, 0.9, -1.4], [0, 0.1, 0]);
  // Cool window-ish bounce on the camera side, left.
  panel(1.2, 1.0, 0xbfd6ff, 2.2, [-1.8, 0.8, 1.6], [0, 0.1, 0]);
  // Analyzer glow behind.
  panel(0.8, 0.25, 0x4fb8ff, 3.5, [-0.4, 0.5, -2.8], [0, 0.2, 0]);
  panel(0.6, 0.2, 0x58ffd0, 2.0, [0.8, 0.6, -2.8], [0, 0.2, 0]);
  // Pale bench under everything.
  const bench = new THREE.Mesh(
    new THREE.PlaneGeometry(6, 6),
    new THREE.MeshBasicMaterial({ color: 0x8a9096 }),
  );
  bench.rotation.x = -Math.PI / 2;
  bench.position.y = -0.01;
  env.add(bench);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.015);
  pmrem.dispose();
  return rt.texture;
}
scene.environment = buildEnvironment();
scene.environmentIntensity = 0.7;

// ---------------------------------------------------------------------------
// Lights.
const hemi = new THREE.HemisphereLight(0xdfe9ff, 0x3b3f45, 0.35);
scene.add(hemi);

const overhead = new THREE.RectAreaLight(0xeef4ff, 7, 0.5, 0.25);
overhead.position.set(0.02, 0.6, 0.06);
overhead.lookAt(0, 0, 0.02);
scene.add(overhead);

const keyShadow = new THREE.SpotLight(0xeef4ff, 2.2, 3, THREE.MathUtils.degToRad(28), 0.9, 1.4);
keyShadow.position.set(0.06, 0.85, 0.22);
keyShadow.target.position.set(0, 0.04, 0);
keyShadow.castShadow = true;
keyShadow.shadow.mapSize.set(1024, 1024);
keyShadow.shadow.camera.near = 0.3;
keyShadow.shadow.camera.far = 1.4;
keyShadow.shadow.bias = -0.00008;
keyShadow.shadow.normalBias = 0.0004;
keyShadow.shadow.radius = 6;
scene.add(keyShadow, keyShadow.target);

const rim = new THREE.SpotLight(0xffa860, 4.5, 2.5, THREE.MathUtils.degToRad(22), 0.8, 1.2);
rim.position.set(0.32, 0.22, -0.42);
rim.target.position.set(0, 0.09, 0);
scene.add(rim, rim.target);

const rim2 = new THREE.SpotLight(0xffc28a, 1.4, 2.5, THREE.MathUtils.degToRad(25), 0.9, 1.2);
rim2.position.set(-0.3, 0.3, -0.38);
rim2.target.position.set(0, 0.09, 0);
scene.add(rim2, rim2.target);

const fill = new THREE.RectAreaLight(0xcfe0ff, 1.6, 0.4, 0.4);
fill.position.set(-0.25, 0.12, 0.45);
fill.lookAt(0, 0.08, 0);
scene.add(fill);

// ---------------------------------------------------------------------------
// Materials.
const glassMat = new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  metalness: 0,
  roughness: 0.035,
  transmission: 1,
  thickness: 0.0016,
  ior: 1.5,
  specularIntensity: 1,
  envMapIntensity: 1.2,
  attenuationColor: new THREE.Color(0xe9f4f0),
  attenuationDistance: 0.05,
  side: THREE.DoubleSide,
});

const capMat = new THREE.MeshPhysicalMaterial({
  color: new THREE.Color(0.62, 0.035, 0.045),
  roughness: 0.34,
  clearcoat: 0.35,
  clearcoatRoughness: 0.25,
  sheen: 0.25,
  sheenColor: new THREE.Color(0.9, 0.35, 0.35),
  sheenRoughness: 0.6,
});

const stopperMat = new THREE.MeshStandardMaterial({
  color: new THREE.Color(0.33, 0.05, 0.06),
  roughness: 0.62,
});

const steelMat = new THREE.MeshPhysicalMaterial({
  color: new THREE.Color(0.78, 0.8, 0.82),
  metalness: 1,
  roughness: 0.26,
  anisotropy: 0.7,
  anisotropyRotation: Math.PI / 2,
  envMapIntensity: 1.1,
});

// Nitrile micro-texture: a seeded value-noise height field turned into a
// tangent-space normal map plus a matching roughness variation.
function gloveTextures(size = 512) {
  const rnd = mulberry32(7);
  const grid = 64;
  const lattice = new Float32Array(grid * grid).map(() => rnd());
  const sample = (x, y, f) => {
    const gx = (x / size) * f;
    const gy = (y / size) * f;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = gx - x0;
    const ty = gy - y0;
    const L = (i, j) => lattice[((((y0 + j) % f) + f) % f) * grid + ((((x0 + i) % f) + f) % f)];
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    return (L(0, 0) * (1 - sx) + L(1, 0) * sx) * (1 - sy) + (L(0, 1) * (1 - sx) + L(1, 1) * sx) * sy;
  };
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      h[y * size + x] = sample(x, y, 64) * 0.55 + sample(x, y, 32) * 0.3 + sample(x, y, 16) * 0.15;
  const nData = new Uint8Array(size * size * 4);
  const rData = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const dx = h[y * size + ((x + 1) % size)] - h[y * size + ((x - 1 + size) % size)];
      const dy = h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x];
      const n = new THREE.Vector3(-dx * 6, -dy * 6, 1).normalize();
      nData.set([(n.x * 0.5 + 0.5) * 255, (n.y * 0.5 + 0.5) * 255, (n.z * 0.5 + 0.5) * 255, 255], i * 4);
      const r = 255 * (0.44 + 0.08 * h[i]);
      rData.set([r, r, r, 255], i * 4);
    }
  const mk = (data) => {
    const t = new THREE.DataTexture(data, size, size);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(14, 14);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
  };
  return { normal: mk(nData), rough: mk(rData) };
}
const gloveTex = gloveTextures();
const gloveMat = new THREE.MeshPhysicalMaterial({
  color: new THREE.Color(0.17, 0.26, 0.55),
  roughness: 1,
  roughnessMap: gloveTex.rough,
  normalMap: gloveTex.normal,
  normalScale: new THREE.Vector2(0.045, 0.045),
  sheen: 0.18,
  sheenColor: new THREE.Color(0.35, 0.45, 0.75),
  sheenRoughness: 0.5,
  clearcoat: 0.08,
  clearcoatRoughness: 0.45,
  envMapIntensity: 0.75,
});

// Blood: deep venous red with a slow internal swirl of lighter, more
// oxygenated streaks, and a free surface that tilts with the hand's sway.
const bloodUniforms = {
  uTime: { value: 0 },
  uSwirl: { value: 0.2 },
  uTilt: { value: new THREE.Vector2(0, 0) },
  uFill: { value: FILL_H },
};
const NOISE_GLSL = /* glsl */ `
  float hb_hash(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
  float hb_noise(vec3 x){
    vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
    return mix(mix(mix(hb_hash(i+vec3(0,0,0)),hb_hash(i+vec3(1,0,0)),f.x),
                   mix(hb_hash(i+vec3(0,1,0)),hb_hash(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(hb_hash(i+vec3(0,0,1)),hb_hash(i+vec3(1,0,1)),f.x),
                   mix(hb_hash(i+vec3(0,1,1)),hb_hash(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
  float hb_fbm(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<4;i++){ s+=a*hb_noise(p); p*=2.03; a*=0.5; } return s; }
`;
const bloodMat = new THREE.MeshPhysicalMaterial({
  color: new THREE.Color(0.2, 0.004, 0.012),
  roughness: 0.12,
  clearcoat: 1,
  clearcoatRoughness: 0.05,
  specularIntensity: 0.6,
  envMapIntensity: 0.9,
});
bloodMat.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, bloodUniforms);
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
       uniform float uTime; uniform vec2 uTilt; uniform float uFill;
       varying vec3 vBloodPos;`,
    )
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
       float topW = smoothstep(uFill - 0.006, uFill, position.y);
       float ripple = 0.00012 * sin(length(position.xz) * 900.0 - uTime * 7.0);
       transformed.y += topW * (uTilt.x * position.x + uTilt.y * position.z + ripple * length(uTilt) * 30.0);
       vBloodPos = position;`,
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
       uniform float uTime; uniform float uSwirl; uniform float uFill;
       varying vec3 vBloodPos;
       ${NOISE_GLSL}`,
    )
    .replace(
      "#include <color_fragment>",
      `#include <color_fragment>
       {
         float ang = atan(vBloodPos.z, vBloodPos.x);
         float h = vBloodPos.y;
         float warp = hb_fbm(vec3(cos(ang) * 1.3, sin(ang) * 1.3, h * 40.0 + uTime * 0.12));
         float twist = ang + uTime * (0.25 + 0.75 * uSwirl) + h * 18.0 * uSwirl + warp * 2.2;
         vec3 q = vec3(cos(twist) * 1.8, sin(twist) * 1.8, h * 70.0 - uTime * 0.3 + warp * 2.0);
         float n = hb_fbm(q + vec3(0.0, 0.0, hb_fbm(q * 0.8 + uTime * 0.2) * 2.0));
         float streak = smoothstep(0.42, 0.82, n) * (0.35 + 0.65 * uSwirl);
         vec3 deep = vec3(0.13, 0.0025, 0.007);
         vec3 bright = vec3(0.55, 0.02, 0.03);
         vec3 c = mix(deep, bright, streak);
         // Top meniscus slightly lighter where the film thins on the glass.
         c = mix(c, vec3(0.5, 0.03, 0.04), smoothstep(uFill - 0.0025, uFill, h) * 0.35);
         diffuseColor.rgb = c;
       }`,
    );
};

const calmUniforms = { ...bloodUniforms, uSwirl: { value: 0.0 }, uTilt: { value: new THREE.Vector2(0, 0) } };
const calmBloodMat = bloodMat.clone();
calmBloodMat.onBeforeCompile = (shader) => {
  const saved = Object.assign({}, bloodUniforms);
  Object.assign(bloodUniforms, calmUniforms);
  bloodMat.onBeforeCompile(shader);
  Object.assign(bloodUniforms, saved);
};

// ---------------------------------------------------------------------------
// Geometry builders.
function tubeGeometry() {
  // Closed lathe profile: outer wall up from a rounded bottom, lip, inner wall
  // back down. Rendered with a transmissive physical material.
  const pts = [];
  const rIn = TUBE_R - TUBE_WALL;
  const seg = 18;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.sin(a) * TUBE_R, TUBE_R - Math.cos(a) * TUBE_R));
  }
  pts.push(new THREE.Vector2(TUBE_R, TUBE_L - 0.0006));
  pts.push(new THREE.Vector2(TUBE_R - 0.0003, TUBE_L));
  pts.push(new THREE.Vector2(rIn + 0.0003, TUBE_L));
  pts.push(new THREE.Vector2(rIn, TUBE_L - 0.0006));
  for (let i = seg; i >= 0; i--) {
    const a = (i / seg) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(0.00001, Math.sin(a) * rIn), TUBE_R - Math.cos(a) * rIn));
  }
  const g = new THREE.LatheGeometry(pts, 96);
  g.computeVertexNormals();
  return g;
}

function bloodGeometry() {
  const r = TUBE_R - TUBE_WALL - 0.00005;
  const base = TUBE_R;
  const pts = [new THREE.Vector2(0.00001, base - r)];
  const seg = 16;
  for (let i = 1; i <= seg; i++) {
    const a = (i / seg) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.sin(a) * r, base - Math.cos(a) * r));
  }
  pts.push(new THREE.Vector2(r, FILL_H - 0.0016));
  // Meniscus: the surface climbs the wall slightly.
  pts.push(new THREE.Vector2(r - 0.00005, FILL_H));
  pts.push(new THREE.Vector2(r * 0.8, FILL_H - 0.0007));
  pts.push(new THREE.Vector2(r * 0.4, FILL_H - 0.001));
  pts.push(new THREE.Vector2(0.00001, FILL_H - 0.0011));
  const g = new THREE.LatheGeometry(pts, 72);
  g.computeVertexNormals();
  return g;
}

function capGeometry() {
  // Hemogard-style cap: a skirt over the tube, a ribbed grip band and a
  // rounded, slightly recessed crown.
  const y0 = TUBE_L - 0.019;
  const pts = [
    new THREE.Vector2(TUBE_R + 0.0001, y0 + 0.0003),
    new THREE.Vector2(TUBE_R + 0.0004, y0),
    new THREE.Vector2(CAP_R - 0.0004, y0),
    new THREE.Vector2(CAP_R, y0 + 0.0006),
    new THREE.Vector2(CAP_R, y0 + 0.017),
    new THREE.Vector2(CAP_R - 0.0007, y0 + 0.0222),
    new THREE.Vector2(CAP_R - 0.0022, y0 + 0.0243),
    new THREE.Vector2(CAP_R - 0.0034, y0 + 0.0247),
    new THREE.Vector2(0.0034, y0 + 0.0245),
    new THREE.Vector2(0.0026, y0 + 0.0236),
    new THREE.Vector2(0.00001, y0 + 0.0234),
  ];
  const g = new THREE.LatheGeometry(pts, 160);
  // Vertical grip ribs on the band.
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const r = Math.hypot(v.x, v.z);
    if (r < CAP_R - 0.0012) continue;
    const band = smooth(y0 + 0.003, y0 + 0.005, v.y) * (1 - smooth(y0 + 0.016, y0 + 0.019, v.y));
    const ang = Math.atan2(v.z, v.x);
    const rib = Math.pow(Math.abs(Math.cos(ang * 16)), 6);
    const nr = r + band * rib * 0.00035;
    v.x *= nr / r;
    v.z *= nr / r;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function stopperGeometry() {
  const rIn = TUBE_R - TUBE_WALL - 0.00003;
  const pts = [
    new THREE.Vector2(0.00001, TUBE_L - 0.012),
    new THREE.Vector2(rIn - 0.0008, TUBE_L - 0.012),
    new THREE.Vector2(rIn, TUBE_L - 0.0105),
    new THREE.Vector2(rIn, TUBE_L - 0.0005),
    new THREE.Vector2(0.00001, TUBE_L - 0.0005),
  ];
  return new THREE.LatheGeometry(pts, 64);
}

const TUBE_GEO = tubeGeometry();
const BLOOD_GEO = bloodGeometry();
const CAP_GEO = capGeometry();
const STOPPER_GEO = stopperGeometry();

function makeTube(bloodMaterial, capMaterial) {
  const g = new THREE.Group();
  const glass = new THREE.Mesh(TUBE_GEO, glassMat);
  glass.castShadow = true;
  glass.renderOrder = 2;
  const blood = new THREE.Mesh(BLOOD_GEO, bloodMaterial);
  blood.castShadow = true;
  blood.receiveShadow = true;
  const stopper = new THREE.Mesh(STOPPER_GEO, stopperMat);
  const cap = new THREE.Mesh(CAP_GEO, capMaterial);
  cap.castShadow = true;
  cap.receiveShadow = true;
  g.add(blood, stopper, glass, cap);
  return g;
}

// ---------------------------------------------------------------------------
// Stainless rack: base, two perforated decks and end walls.
function buildRack() {
  const rack = new THREE.Group();
  const len = 0.086;
  const depth = 0.03;
  const holeR = TUBE_R + 0.0012;
  const deck = (y, thick, withHoles) => {
    const s = new THREE.Shape();
    const r = 0.003;
    const x0 = -len / 2;
    const z0 = -depth / 2;
    s.moveTo(x0 + r, z0);
    s.lineTo(x0 + len - r, z0);
    s.quadraticCurveTo(x0 + len, z0, x0 + len, z0 + r);
    s.lineTo(x0 + len, z0 + depth - r);
    s.quadraticCurveTo(x0 + len, z0 + depth, x0 + len - r, z0 + depth);
    s.lineTo(x0 + r, z0 + depth);
    s.quadraticCurveTo(x0, z0 + depth, x0, z0 + depth - r);
    s.lineTo(x0, z0 + r);
    s.quadraticCurveTo(x0, z0, x0 + r, z0);
    if (withHoles) {
      for (let i = -1; i <= 1; i++) {
        const h = new THREE.Path();
        h.absarc(i * TUBE_SPACING, 0, holeR, 0, Math.PI * 2, true);
        s.holes.push(h);
      }
    }
    const g = new THREE.ExtrudeGeometry(s, {
      depth: thick,
      bevelEnabled: true,
      bevelThickness: 0.0003,
      bevelSize: 0.0003,
      bevelSegments: 2,
      curveSegments: 48,
    });
    g.rotateX(Math.PI / 2);
    const m = new THREE.Mesh(g, steelMat);
    m.position.y = y + thick;
    m.castShadow = true;
    m.receiveShadow = true;
    rack.add(m);
  };
  deck(0, 0.0012, false);
  deck(0.026, 0.0012, true);
  deck(0.05, 0.0014, true);
  // Corner posts (round stainless rods) instead of solid end walls.
  const postGeo = new THREE.CylinderGeometry(0.0014, 0.0014, 0.0514, 20);
  const postMat = steelMat.clone();
  postMat.roughness = 0.36;
  postMat.anisotropy = 0.3;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(sx * (len / 2 - 0.0035), 0.0257, sz * (depth / 2 - 0.0035));
      post.castShadow = true;
      post.receiveShadow = true;
      rack.add(post);
    }
  // Small rubber feet.
  const footMat = new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.8 });
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const f = new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.002, 0.0012, 16), footMat);
      f.position.set(sx * (len / 2 - 0.005), -0.0006, sz * (depth / 2 - 0.005));
      rack.add(f);
    }
  rack.position.y = 0.0012;
  return rack;
}

const rackGroup = new THREE.Group();
rackGroup.rotation.y = RACK_YAW;
scene.add(rackGroup);
rackGroup.add(buildRack());

// Tubes. Base of each tube rests on the rack's base deck.
const TUBE_BASE_Y = 0.0012 + 0.0024;
const sideTubes = [];
for (const i of [-1, 1]) {
  const t = makeTube(calmBloodMat, capMat);
  t.position.set(i * TUBE_SPACING, TUBE_BASE_Y, 0);
  t.rotation.y = i * 0.7;
  rackGroup.add(t);
  sideTubes.push(t);
}

// The hero tube lives in a grip group that also carries the hand.
const grip = new THREE.Group();
rackGroup.add(grip);
const heroTube = makeTube(bloodMat, capMat);
grip.add(heroTube);
const heroBlood = heroTube.children[0];

// ---------------------------------------------------------------------------
// Bench and lab environment (all of it sits deep in the bokeh).
const benchMat = new THREE.MeshPhysicalMaterial({
  color: new THREE.Color(0.045, 0.05, 0.055),
  roughness: 0.22,
  clearcoat: 0.8,
  clearcoatRoughness: 0.08,
});
const bench = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.04, 2.4), benchMat);
bench.position.set(0, -0.02, -0.7);
bench.receiveShadow = true;
scene.add(bench);

const wallMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.16, 0.19, 0.22), roughness: 0.9 });
const backWall = new THREE.Mesh(new THREE.PlaneGeometry(8, 4), wallMat);
backWall.position.set(0, 1.4, -2.6);
scene.add(backWall);

const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.55, 0.58, 0.61), roughness: 0.45 });
const darkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.05, 0.06, 0.07), roughness: 0.35 });
const emissive = (hex, k) =>
  new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k), toneMapped: false });

function analyzer(x, z, w, h, d, glowHex, ledHex) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMat);
  body.position.y = h / 2;
  g.add(body);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.32, h * 0.22), darkMat);
  screen.position.set(-w * 0.18, h * 0.66, d / 2 + 0.001);
  g.add(screen);
  // UI glow blocks (unreadable at any focus — pure light shapes).
  const blocks = [
    [-0.08, 0.04, 0.12, 0.02, 2.4],
    [-0.08, 0.0, 0.12, 0.012, 1.4],
    [-0.08, -0.03, 0.08, 0.012, 1.1],
    [0.05, 0.02, 0.05, 0.05, 1.8],
  ];
  for (const [bx, by, bw, bh, k] of blocks) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(bw * w * 2.5, bh * h * 2.5), emissive(glowHex, k));
    b.position.set(-w * 0.18 + bx * w * 1.5, h * 0.66 + by * h * 1.5, d / 2 + 0.002);
    g.add(b);
  }
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.85, 0.008), emissive(glowHex, 3.2));
  strip.position.set(0, h * 0.38, d / 2 + 0.002);
  g.add(strip);
  for (let i = 0; i < 3; i++) {
    const led = new THREE.Mesh(new THREE.CircleGeometry(0.006, 16), emissive(ledHex, 9));
    led.position.set(w * 0.3 + i * 0.03, h * 0.7, d / 2 + 0.002);
    g.add(led);
  }
  g.position.set(x, 0, z);
  scene.add(g);
}
analyzer(-0.42, -1.25, 0.62, 0.55, 0.55, 0x3aa8ff, 0x39ff9a);
analyzer(0.42, -1.75, 0.7, 0.95, 0.6, 0x47d6ff, 0xffb347);
analyzer(-1.15, -2.0, 0.6, 0.8, 0.6, 0x5a8cff, 0x39ff9a);
analyzer(1.2, -1.3, 0.5, 0.42, 0.5, 0x2fe3c8, 0x39ff9a);

// Upper cabinets and ceiling light panels.
const cabinet = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.6, 0.35), bodyMat);
cabinet.position.set(0, 1.35, -2.4);
scene.add(cabinet);
for (const x of [-1.2, 0, 1.2]) {
  const p = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.08), emissive(0xf3f7ff, 4));
  p.position.set(x, 1.04, -2.22);
  scene.add(p);
}
// Under-cabinet task light glow on the wall.
const wash = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.5), emissive(0xb9cde6, 0.25));
wash.position.set(0, 0.8, -2.58);
scene.add(wash);

// Distant tube racks with colored caps (lavender, gold, green, light blue).
const farCapColors = [0x8e6cc8, 0xd8b23a, 0x3c9a52, 0x6fb6e6, 0x8e6cc8, 0xc23040];
const farTubeMat = new THREE.MeshPhysicalMaterial({
  color: 0xdfe6ea,
  roughness: 0.08,
  transmission: 0.6,
  thickness: 0.001,
});
const farBloodMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.2, 0.01, 0.015), roughness: 0.2 });
function farRack(x, z, yaw, count, seed) {
  const rnd = mulberry32(seed);
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(count * 0.022 + 0.01, 0.05, 0.03), steelMat);
  base.position.y = 0.025;
  g.add(base);
  for (let i = 0; i < count; i++) {
    if (rnd() < 0.25) continue;
    const t = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(TUBE_R, TUBE_R, TUBE_L, 24), farTubeMat);
    tube.position.y = TUBE_L / 2;
    const b = new THREE.Mesh(new THREE.CylinderGeometry(TUBE_R * 0.86, TUBE_R * 0.86, 0.05 + rnd() * 0.02, 20), farBloodMat);
    b.position.y = 0.03;
    const capCol = farCapColors[Math.floor(rnd() * farCapColors.length)];
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(CAP_R, CAP_R, 0.022, 24),
      new THREE.MeshPhysicalMaterial({ color: capCol, roughness: 0.35, clearcoat: 0.3 }),
    );
    cap.position.y = TUBE_L + 0.004;
    t.add(tube, b, cap);
    t.position.set((i - (count - 1) / 2) * 0.022, 0.003, 0);
    g.add(t);
  }
  g.position.set(x, 0, z);
  g.rotation.y = yaw;
  scene.add(g);
}
farRack(-0.16, -0.32, 0.15, 6, 11);
farRack(0.2, -0.5, -0.2, 7, 23);
farRack(-0.05, -0.85, 0.05, 8, 37);

// Pipette tip box and a sample cup shape in the mid ground for depth layering.
const tipBox = new THREE.Mesh(
  new THREE.BoxGeometry(0.12, 0.06, 0.08),
  new THREE.MeshPhysicalMaterial({ color: 0x5aa0e0, roughness: 0.2, transmission: 0.5, thickness: 0.01 }),
);
tipBox.position.set(0.32, 0.03, -0.62);
tipBox.rotation.y = -0.3;
scene.add(tipBox);

// ---------------------------------------------------------------------------
// The gloved hand. The WebXR generic hand ships with a flat joint list, so the
// joints are re-chained into fingers, posed into a pinch and smoothed with
// Phong-tessellated subdivision so the low-poly mesh reads as a real glove.
const FINGERS = {
  thumb: ["thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
  index: [
    "index-finger-metacarpal",
    "index-finger-phalanx-proximal",
    "index-finger-phalanx-intermediate",
    "index-finger-phalanx-distal",
    "index-finger-tip",
  ],
  middle: [
    "middle-finger-metacarpal",
    "middle-finger-phalanx-proximal",
    "middle-finger-phalanx-intermediate",
    "middle-finger-phalanx-distal",
    "middle-finger-tip",
  ],
  ring: [
    "ring-finger-metacarpal",
    "ring-finger-phalanx-proximal",
    "ring-finger-phalanx-intermediate",
    "ring-finger-phalanx-distal",
    "ring-finger-tip",
  ],
  pinky: [
    "pinky-finger-metacarpal",
    "pinky-finger-phalanx-proximal",
    "pinky-finger-phalanx-intermediate",
    "pinky-finger-phalanx-distal",
    "pinky-finger-tip",
  ],
};

// Joint rotations (radians) per joint: flex about local X (negative curls
// toward the palm), abd about local Y, roll about local Z. Values come from
// solvePinch() for a 16 mm cap, rounded.
const POSE = window.__HAND_POSE || {
  thumb: { abd: [0.244, 0, 0], roll: [0.073, 0, 0], flex: [-0.582, -0.258, 0.249] },
  index: { abd: [0, -0.35, 0, 0], flex: [0, -0.605, -0.937, -0.382] },
  middle: { abd: [0, -0.196, 0, 0], flex: [0, -0.82, -1.041, -0.186] },
  ring: { abd: [0, -0.06, 0, 0], flex: [-0.05, -0.95, -1.25, -0.6] },
  pinky: { abd: [0, -0.12, 0, 0], flex: [-0.08, -1.05, -1.3, -0.6] },
};

function subdivideSkinned(geo) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  const si = geo.attributes.skinIndex;
  const sw = geo.attributes.skinWeight;
  const idx = geo.index.array;
  const P = [];
  const N = [];
  const U = [];
  const SI = [];
  const SW = [];
  for (let i = 0; i < pos.count; i++) {
    P.push(new THREE.Vector3().fromBufferAttribute(pos, i));
    N.push(new THREE.Vector3().fromBufferAttribute(nor, i).normalize());
    U.push(uv ? new THREE.Vector2().fromBufferAttribute(uv, i) : new THREE.Vector2());
    SI.push([si.getX(i), si.getY(i), si.getZ(i), si.getW(i)]);
    SW.push([sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)]);
  }
  const mid = new Map();
  const tmp = new THREE.Vector3();
  const project = (m, p, n) => tmp.copy(m).sub(p).multiplyScalar(1).dot(n);
  const midpoint = (a, b) => {
    const key = a < b ? a + "_" + b : b + "_" + a;
    if (mid.has(key)) return mid.get(key);
    const m = P[a].clone().add(P[b]).multiplyScalar(0.5);
    const qa = m.clone().addScaledVector(N[a], -project(m, P[a], N[a]));
    const qb = m.clone().addScaledVector(N[b], -project(m, P[b], N[b]));
    const phong = qa.add(qb).multiplyScalar(0.5);
    const p = m.multiplyScalar(0.25).addScaledVector(phong, 0.75);
    const n = N[a].clone().add(N[b]).normalize();
    const u = U[a].clone().add(U[b]).multiplyScalar(0.5);
    const wmap = new Map();
    for (const v of [a, b])
      for (let k = 0; k < 4; k++) {
        const j = SI[v][k];
        wmap.set(j, (wmap.get(j) || 0) + SW[v][k] * 0.5);
      }
    const top = [...wmap.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
    while (top.length < 4) top.push([0, 0]);
    const tot = top.reduce((s, e) => s + e[1], 0) || 1;
    P.push(p);
    N.push(n);
    U.push(u);
    SI.push(top.map((e) => e[0]));
    SW.push(top.map((e) => e[1] / tot));
    const id = P.length - 1;
    mid.set(key, id);
    return id;
  };
  const out = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    const ab = midpoint(a, b);
    const bc = midpoint(b, c);
    const ca = midpoint(c, a);
    out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P.flatMap((v) => [v.x, v.y, v.z]), 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(N.flatMap((v) => [v.x, v.y, v.z]), 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(U.flatMap((v) => [v.x, v.y]), 2));
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(SI.flat(), 4));
  g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(SW.flat(), 4));
  g.setIndex(out);
  return g;
}

const hand = {
  root: new THREE.Group(), // positioned relative to the grip
  model: null,
  bones: {},
  rest: {},
};
grip.add(hand.root);

const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const _qr = new THREE.Quaternion();

function applyPose(squeeze) {
  for (const [name, chain] of Object.entries(FINGERS)) {
    const p = POSE[name];
    for (let k = 0; k < chain.length - 1; k++) {
      const b = hand.bones[chain[k]];
      if (!b) continue;
      const flex = (p.flex[k] || 0) * (1 + squeeze);
      const abd = p.abd[k] || 0;
      const roll = (p.roll && p.roll[k]) || 0;
      _q.setFromAxisAngle(X, flex);
      _qa.setFromAxisAngle(Y, abd);
      _qr.setFromAxisAngle(Z, roll);
      b.quaternion.copy(hand.rest[chain[k]]).multiply(_qa).multiply(_qr).multiply(_q);
    }
  }
}

// Place the hand so the pinch (thumb pad vs index/middle pads) closes on the
// cap, with the back of the hand rising up and away from the camera.
const PLACE = window.__HAND_PLACE || {
  pinchDir: new THREE.Vector3(-0.1, 0, -1), // thumb -> fingers, rack-local (+z faces camera)
  wristDir: new THREE.Vector3(0.55, 0.8, -0.25),
  capPoint: new THREE.Vector3(0, TUBE_L - 0.006, 0),
  sep: 0.0,
  roll: 0,
};

// Surface point of a fingertip pad: between the distal joint and the tip,
// pushed to the palmar side (-Y of the distal joint frame).
const PAD_DEPTH = 0.0062;
function padPoint(finger, toLocal) {
  const chain = FINGERS[finger];
  const distal = hand.bones[chain[chain.length - 2]];
  const tip = hand.bones[chain[chain.length - 1]];
  const a = distal.getWorldPosition(new THREE.Vector3());
  const b = tip.getWorldPosition(new THREE.Vector3());
  const palmar = new THREE.Vector3(0, -1, 0).applyQuaternion(distal.getWorldQuaternion(new THREE.Quaternion()));
  const p = a.lerp(b, 0.62).addScaledVector(palmar, PAD_DEPTH);
  return toLocal ? p.applyMatrix4(toLocal) : p;
}
function padNormal(finger) {
  const chain = FINGERS[finger];
  const distal = hand.bones[chain[chain.length - 2]];
  return new THREE.Vector3(0, -1, 0).applyQuaternion(distal.getWorldQuaternion(new THREE.Quaternion()));
}

// Dev tool: coordinate-descent search for a pinch that closes the thumb and
// index/middle pads on opposite sides of a cap of the given diameter.
function solvePinch(width = 2 * CAP_R - 0.0004, iters = 60) {
  const params = [
    ["thumb", "flex", 0], ["thumb", "abd", 0], ["thumb", "roll", 0], ["thumb", "flex", 1], ["thumb", "flex", 2],
    ["index", "flex", 1], ["index", "flex", 2], ["index", "flex", 3], ["index", "abd", 1],
    ["middle", "flex", 1], ["middle", "flex", 2], ["middle", "flex", 3], ["middle", "abd", 1],
  ];
  const get = ([f, k, i]) => ((POSE[f][k] = POSE[f][k] || [0, 0, 0, 0])[i] || 0);
  const set = ([f, k, i], v) => ((POSE[f][k] = POSE[f][k] || [0, 0, 0, 0])[i] = v);
  const init = params.map(get);
  const energy = () => {
    applyPose(0);
    hand.model.updateMatrixWorld(true);
    const t = padPoint("thumb");
    const ix = padPoint("index");
    const md = padPoint("middle");
    const fp = ix.clone().lerp(md, 0.3);
    const dist = t.distanceTo(fp);
    const nT = padNormal("thumb");
    const nI = padNormal("index");
    const nM = padNormal("middle");
    const axis = fp.clone().sub(t).normalize();
    let e = 4000 * (dist - width) ** 2;
    e += 0.6 * (nT.dot(axis) - 1) ** 2 + 0.6 * (nI.dot(axis) + 1) ** 2 + 0.3 * (nM.dot(axis) + 1) ** 2;
    // Middle pad sits beside the index pad on the same side of the cap.
    const side = md.clone().sub(ix);
    e += 3000 * (side.length() - 0.0155) ** 2 + 0.5 * side.normalize().dot(axis) ** 2;
    params.forEach((p, i) => {
      const v = get(p);
      e += 0.01 * (v - init[i]) ** 2;
      const [lo, hi] = p[1] === "flex" ? [-1.7, 0.25] : [-0.35, 0.35];
      e += 50 * (Math.max(0, v - hi) ** 2 + Math.max(0, lo - v) ** 2);
    });
    return e;
  };
  let step = 0.2;
  let best = energy();
  for (let it = 0; it < iters; it++) {
    let improved = false;
    for (const p of params) {
      for (const dir of [1, -1]) {
        const v = get(p);
        set(p, v + dir * step);
        const e = energy();
        if (e < best) {
          best = e;
          improved = true;
        } else set(p, v);
      }
    }
    if (!improved) step *= 0.6;
    if (step < 0.002) break;
  }
  applyPose(0);
  placeHand();
  return { best, POSE: JSON.parse(JSON.stringify(POSE)) };
}

function placeHand() {
  const m = hand.model;
  m.position.set(0, 0, 0);
  m.quaternion.identity();
  m.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(hand.root.matrixWorld).invert();
  const wp = (name) => hand.bones[name].getWorldPosition(new THREE.Vector3()).applyMatrix4(toLocal);
  const thumbPad = padPoint("thumb", toLocal);
  const indexPad = padPoint("index", toLocal);
  const middlePad = padPoint("middle", toLocal);
  const fingerPad = indexPad.clone().lerp(middlePad, 0.3);
  const pinchMid = thumbPad.clone().lerp(fingerPad, 0.5);
  const d = fingerPad.clone().sub(thumbPad).normalize();
  const wrist = wp("wrist").sub(pinchMid);
  const target = PLACE.pinchDir.clone().normalize();
  const q1 = new THREE.Quaternion().setFromUnitVectors(d, target);
  const w1 = wrist.clone().applyQuaternion(q1);
  const desired = PLACE.wristDir.clone().normalize();
  let best = 0;
  let bestDot = -Infinity;
  for (let a = 0; a < 360; a += 0.5) {
    const qa = new THREE.Quaternion().setFromAxisAngle(target, THREE.MathUtils.degToRad(a));
    const dot = w1.clone().applyQuaternion(qa).normalize().dot(desired);
    if (dot > bestDot) {
      bestDot = dot;
      best = a;
    }
  }
  const q2 = new THREE.Quaternion().setFromAxisAngle(target, THREE.MathUtils.degToRad(best + PLACE.roll));
  const q = q2.multiply(q1);
  m.quaternion.copy(q);
  const off = pinchMid.clone().applyQuaternion(q);
  m.position.copy(PLACE.capPoint).sub(off);
  hand.debug = { thumbPad, fingerPad, gap: thumbPad.distanceTo(fingerPad) };
}

function loadHand() {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(
      "assets/models/right-hand.glb",
      (gltf) => {
        const model = gltf.scene;
        let skinned = null;
        model.traverse((o) => {
          if (o.isSkinnedMesh) skinned = o;
          if (o.isBone) hand.bones[o.name] = o;
        });
        // Re-chain the flat joint list into a hierarchy (keeps world transforms
        // so the bind pose is unchanged).
        model.updateMatrixWorld(true);
        const wrist = hand.bones["wrist"];
        for (const chain of Object.values(FINGERS)) {
          let parent = wrist;
          for (const name of chain) {
            parent.attach(hand.bones[name]);
            parent = hand.bones[name];
          }
        }
        for (const [name, b] of Object.entries(hand.bones)) hand.rest[name] = b.quaternion.clone();
        const g = subdivideSkinned(subdivideSkinned(skinned.geometry));
        skinned.geometry.dispose();
        skinned.geometry = g;
        skinned.material = gloveMat;
        skinned.castShadow = true;
        skinned.receiveShadow = true;
        skinned.frustumCulled = false;
        // Glove cuff / forearm continuing out of frame from the wrist.
        const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.026, 0.22, 48, 1, true), gloveMat);
        cuff.castShadow = true;
        const wristB = hand.bones["wrist"];
        wristB.add(cuff);
        cuff.position.set(0, 0, 0.11);
        cuff.rotation.x = Math.PI / 2;
        cuff.scale.set(1.0, 1, 0.72);
        hand.cuff = cuff;
        hand.model = model;
        hand.root.add(model);
        applyPose(0);
        placeHand();
        resolve();
      },
      undefined,
      reject,
    );
  });
}

// ---------------------------------------------------------------------------
// Post: depth of field (scatter-as-gather on a golden-angle spiral), bloom,
// then a filmic grade with vignette, halation-like warmth and fine grain.
const rtScene = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType, samples: 4 });
// Depth for the DOF comes from its own single-sample pass: MSAA depth resolve
// is not reliable on every backend.
const rtDepth = new THREE.WebGLRenderTarget(RW, RH, {
  depthTexture: new THREE.DepthTexture(RW, RH, THREE.FloatType),
});
rtDepth.depthTexture.format = THREE.DepthFormat;
const depthOnlyMat = new THREE.MeshBasicMaterial({ colorWrite: false });
const rtDof = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType });

const dofMat = new THREE.ShaderMaterial({
  uniforms: {
    tColor: { value: rtScene.texture },
    tDepth: { value: rtDepth.depthTexture },
    uNear: { value: camera.near },
    uFar: { value: camera.far },
    uFocus: { value: 0.5 },
    uK: { value: 0 },
    uMaxCoc: { value: MAX_COC_PX },
    uRes: { value: new THREE.Vector2(RW, RH) },
    uShowCoc: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform float uShowCoc;
    uniform sampler2D tColor; uniform sampler2D tDepth;
    uniform float uNear, uFar, uFocus, uK, uMaxCoc; uniform vec2 uRes;
    varying vec2 vUv;
    float linDepth(vec2 uv){
      float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
      return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
    }
    // Signed circle of confusion in pixels (negative = in front of focus).
    float coc(float d){ return clamp(uK * (d - uFocus) / d, -uMaxCoc, uMaxCoc); }
    void main(){
      float d0 = linDepth(vUv);
      float c0 = coc(d0);
      float r0 = abs(c0);
      const int TAPS = 72;
      const float GA = 2.39996323;
      float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      float w0 = 1.0 / max(r0 * r0, 1.0);
      vec3 acc = texture2D(tColor, vUv).rgb * w0; float wsum = w0;
      float radius = uMaxCoc;
      // Gather radius: enough to reach any neighbour that can scatter here.
      for (int i = 1; i < TAPS; i++){
        float fi = float(i);
        float rr = sqrt(fi / float(TAPS)) * radius;
        float th = fi * GA + ign * 6.2831853;
        vec2 off = vec2(cos(th), sin(th)) * rr / uRes;
        vec2 uv = vUv + off;
        float d = linDepth(uv);
        float c = coc(d);
        float rc = abs(c);
        // Background samples may not bleed over a sharper foreground.
        if (d > d0) rc = min(rc, r0 * 1.2 + 0.5);
        float w = clamp(rc - rr + 1.0, 0.0, 1.0) / max(rc * rc, 1.0);
        vec3 s = texture2D(tColor, uv).rgb;
        float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
        // Soft-clamp fireflies so thin hot speculars blur into smooth bokeh.
        s *= 3.0 / max(3.0, l);
        w *= 1.0 + smoothstep(0.8, 3.0, l) * 0.8;
        acc += s * w; wsum += w;
      }
      vec3 blurred = acc / wsum;
      vec3 sharp = texture2D(tColor, vUv).rgb;
      gl_FragColor = vec4(mix(sharp, blurred, smoothstep(0.6, 2.0, r0 + 0.0)), r0);
      if (uShowCoc > 0.5) gl_FragColor = vec4(vec3(r0 / uMaxCoc) * 4.0, 1.0) + vec4(texture2D(tDepth, vUv).x > 0.9999 ? 1.0 : 0.0, 0.0, 0.0, 0.0);
    }`,
  depthTest: false,
  depthWrite: false,
});
const dofQuad = new FullScreenQuad(dofMat);

// Post-filter: a CoC-scaled tent over the gathered result removes the sparse
// sampling noise in large bokeh without softening in-focus detail.
const rtDof2 = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.HalfFloatType });
const dofFilterMat = new THREE.ShaderMaterial({
  uniforms: { tSrc: { value: rtDof.texture }, uRes: { value: new THREE.Vector2(RW, RH) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tSrc; uniform vec2 uRes; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tSrc, vUv);
      float r = clamp(c.a * 0.42, 0.0, 7.0);
      if (r < 0.75) { gl_FragColor = c; return; }
      vec3 acc = c.rgb; float ws = 1.0;
      for (int i = 0; i < 16; i++){
        float a = float(i) * 2.39996323;
        float rr = r * sqrt((float(i) + 0.5) / 16.0);
        vec2 uv = vUv + vec2(cos(a), sin(a)) * rr / uRes;
        vec4 s = texture2D(tSrc, uv);
        float w = smoothstep(0.0, 1.5, s.a);
        acc += s.rgb * w; ws += w;
      }
      gl_FragColor = vec4(acc / ws, c.a);
    }`,
  depthTest: false,
  depthWrite: false,
});
const dofFilterQuad = new FullScreenQuad(dofFilterMat);

const bloom = new UnrealBloomPass(new THREE.Vector2(RW / 2, RH / 2), 0.22, 0.55, 1.6);

const gradeMat = new THREE.ShaderMaterial({
  uniforms: {
    tColor: { value: rtDof2.texture },
    uFrame: { value: 0 },
    uRes: { value: new THREE.Vector2(W, H) },
    uExposure: { value: 1.05 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tColor; uniform float uFrame; uniform vec2 uRes; uniform float uExposure;
    varying vec2 vUv;
    vec3 aces(vec3 x){
      const mat3 m1 = mat3(0.59719,0.07600,0.02840, 0.35458,0.90834,0.13383, 0.04823,0.01566,0.83777);
      const mat3 m2 = mat3(1.60475,-0.10208,-0.00327, -0.53108,1.10813,-0.07276, -0.07367,-0.00605,1.07602);
      vec3 v = m1 * x;
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return clamp(m2 * (a / b), 0.0, 1.0);
    }
    float hash(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
    void main(){
      vec2 uv = vUv;
      vec2 cc = uv - 0.5;
      // Very light lateral chromatic aberration toward the edges.
      float ca = 0.0012 * dot(cc, cc);
      vec3 col;
      col.r = texture2D(tColor, uv - cc * ca * 4.0).r;
      col.g = texture2D(tColor, uv).g;
      col.b = texture2D(tColor, uv + cc * ca * 4.0).b;
      col *= uExposure;
      // Grade: cool shadows, a touch of warmth in the highlights.
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(col * vec3(0.94, 1.0, 1.06), col * vec3(1.04, 1.0, 0.95), smoothstep(0.05, 0.9, l));
      col = aces(col);
      col = pow(col, vec3(1.0 / 2.2));
      // Gentle S-curve.
      col = mix(col, col * col * (3.0 - 2.0 * col), 0.18);
      // Vignette.
      vec2 vv = cc * vec2(uRes.x / uRes.y, 1.0) * 1.6;
      col *= mix(1.0, 0.72, smoothstep(0.25, 1.05, dot(vv, vv)));
      // Fine film grain, seeded per frame (deterministic).
      float g = hash(vec3(gl_FragCoord.xy, uFrame)) + hash(vec3(gl_FragCoord.yx * 1.37, uFrame + 17.0)) - 1.0;
      col += g * 0.018 * (1.0 - l * 0.5);
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
  depthTest: false,
  depthWrite: false,
});
const gradeQuad = new FullScreenQuad(gradeMat);

// ---------------------------------------------------------------------------
// Motion.
function liftAt(t) {
  // Fingers settle on the cap, a tiny press as the grip takes the weight, then a
  // slow lift that eases out near the end of the shot.
  const press = -0.0003 * smooth(0.15, 0.5, t) * (1 - smooth(0.55, 0.9, t));
  const rise = RISE * smoother(0.55, 5.6, t);
  return press + rise;
}

const _v = new THREE.Vector3();
const camPos0 = new THREE.Vector3(0.05, 0.03, 0.6);
const camPos1 = new THREE.Vector3(0.03, 0.045, 0.415);
const camTarget = new THREE.Vector3();
const nearRackPoint = new THREE.Vector3();

function renderAt(time) {
  const t = Math.min(Math.max(time, 0), DURATION);
  const frame = Math.round(t * 30);

  // Hero tube + hand.
  const h = liftAt(t);
  const free = smooth(0.8, 3.0, t);
  const swayX = 0.0007 * Math.sin(2 * Math.PI * 0.21 * t + 0.4) * free;
  const swayZ = 0.0005 * Math.sin(2 * Math.PI * 0.16 * t + 1.3) * free;
  grip.position.set(swayX, TUBE_BASE_Y + h, swayZ);
  const tiltZ = THREE.MathUtils.degToRad(0.9) * Math.sin(2 * Math.PI * 0.19 * t + 0.2) * free;
  const tiltX = THREE.MathUtils.degToRad(0.6) * Math.sin(2 * Math.PI * 0.14 * t + 2.1) * free;
  grip.rotation.set(tiltX, 0.0, tiltZ);
  if (hand.model) applyPose(0.035 * smooth(0.1, 0.55, t));

  // Blood responds to the motion: swirl builds with lift velocity, the free
  // surface leans against the sway acceleration.
  const vel = (liftAt(t + 0.02) - liftAt(t - 0.02)) / 0.04;
  bloodUniforms.uTime.value = t;
  bloodUniforms.uSwirl.value = 0.25 + Math.min(1, vel / 0.02) * 0.75;
  const ax = -0.0007 * Math.pow(2 * Math.PI * 0.21, 2) * Math.sin(2 * Math.PI * 0.21 * t + 0.4) * free;
  const az = -0.0005 * Math.pow(2 * Math.PI * 0.16, 2) * Math.sin(2 * Math.PI * 0.16 * t + 1.3) * free;
  bloodUniforms.uTilt.value.set(-ax / 9.81 - tiltZ * 0.9, -az / 9.81 + tiltX * 0.9);

  // Camera: continuous slow dolly-in from a low angle; the aim follows the
  // tube up with a little lag.
  const e = smooth(-1.5, 6.2, t);
  camera.position.lerpVectors(camPos0, camPos1, e);
  camera.position.y += 0.6 * h * 0.35;
  camTarget.set(0.0, 0.066 + h * 0.8, 0.0);
  camera.lookAt(camTarget);
  camera.updateMatrixWorld();

  // Focus pull: from the near front corner of the rack to the lifted tube.
  scene.updateMatrixWorld(true);
  nearRackPoint.set(-0.043, 0.051, 0.015);
  rackGroup.localToWorld(nearRackPoint);
  const heroPoint = heroTube.localToWorld(_v.set(0, 0.07, TUBE_R * 0.6));
  const camFwd = camera.getWorldDirection(new THREE.Vector3());
  const dNear = nearRackPoint.clone().sub(camera.position).dot(camFwd);
  const dHero = heroPoint.clone().sub(camera.position).dot(camFwd);
  const pull = smoother(0.9, 3.1, t);
  const focus = THREE.MathUtils.lerp(dNear, dHero, pull);
  const aperture = FOCAL / F_STOP;
  const kMeters = (aperture * FOCAL) / (focus - FOCAL);
  dofMat.uniforms.uFocus.value = focus;
  dofMat.uniforms.uK.value = (kMeters / SENSOR_H) * RH * 0.5; // radius in px
  dofMat.uniforms.uNear.value = camera.near;
  dofMat.uniforms.uFar.value = camera.far;

  // Render chain.
  const dbg = window.__debug || {};
  if (dbg.cam) {
    camera.position.set(...dbg.cam.pos);
    camera.lookAt(new THREE.Vector3(...dbg.cam.target));
    if (dbg.cam.fov) camera.fov = dbg.cam.fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.setRenderTarget(rtScene);
  renderer.render(scene, camera);
  scene.overrideMaterial = depthOnlyMat;
  const bg = scene.background;
  scene.background = null;
  renderer.setRenderTarget(rtDepth);
  renderer.render(scene, camera);
  scene.overrideMaterial = null;
  scene.background = bg;
  if (dbg.noDof) dofMat.uniforms.uK.value = 0;
  dofMat.uniforms.uShowCoc.value = dbg.showCoc ? 1 : 0;
  if (dbg.log) console.log('focus', focus, 'K', dofMat.uniforms.uK.value);
  renderer.setRenderTarget(rtDof);
  dofQuad.render(renderer);
  renderer.setRenderTarget(rtDof2);
  dofFilterQuad.render(renderer);
  bloom.render(renderer, null, rtDof2);
  gradeMat.uniforms.uFrame.value = frame;
  renderer.setRenderTarget(null);
  gradeQuad.render(renderer);
}

// ---------------------------------------------------------------------------
let ready = false;
let pendingTime = window.__hfThreeTime || 0;
const build = loadHand()
  .then(() => {
    ready = true;
    renderAt(pendingTime);
  })
  .catch((err) => {
    console.error("hand load failed", err);
    ready = true;
    renderAt(pendingTime);
  });
window.__hf = window.__hf || {};
window.__hf.buildReady = window.__hf.buildReady || {};
window.__hf.buildReady["blood-tube-scene"] = build;

window.addEventListener("hf-seek", (event) => {
  pendingTime = event.detail.time;
  if (ready) renderAt(pendingTime);
});

window.__bloodTube = { renderAt, hand, scene, camera, POSE, PLACE, placeHand, applyPose, solvePinch };
