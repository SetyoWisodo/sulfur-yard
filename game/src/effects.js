// Transient visuals: tracers, impact sparks, explosion bursts. Everything is
// pooled — no geometry or material is created after boot, and the hot loop
// only reuses preallocated vectors and pool slots.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const MAX_TRACERS = 24;
const MAX_SPARKS = 10;
const SPARK_PARTICLES = 14;

export function createEffects(scene) {
  const tracerMat = new THREE.LineBasicMaterial({ color: new THREE.Color(PALETTE.lamp), transparent: true, opacity: 0.9 });
  const tracers = [];
  for (let i = 0; i < MAX_TRACERS; i += 1) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geo, tracerMat);
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    tracers.push({ line, life: 0 });
  }
  let tracerCursor = 0;

  const sparkMat = new THREE.PointsMaterial({ color: new THREE.Color(PALETTE.accent), size: 0.12, transparent: true, opacity: 0.95, depthWrite: false });
  const sparks = [];
  for (let i = 0; i < MAX_SPARKS; i += 1) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARK_PARTICLES * 3), 3));
    const points = new THREE.Points(geo, sparkMat);
    points.visible = false;
    points.frustumCulled = false;
    scene.add(points);
    sparks.push({ points, life: 0, vel: new Float32Array(SPARK_PARTICLES * 3) });
  }
  let sparkCursor = 0;

  // One explosion shell: an expanding transparent sphere + a point light.
  const boomMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.ember), transparent: true, opacity: 0.85, depthWrite: false });
  const boom = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), boomMat);
  boom.visible = false;
  scene.add(boom);
  const boomLight = new THREE.PointLight(new THREE.Color(PALETTE.ember), 0, 26);
  scene.add(boomLight);
  let boomLife = 0;
  const boomPos = new THREE.Vector3();

  // Smoke clouds (cycle 11): two pre-built clusters of five grey spheres
  // each — a player can carry at most two smokes, so the pool never grows.
  // The spheres are shared geometry with a per-cloud material, so each
  // cloud blooms and fades on its own clock.
  const SMOKE_SPHERES = 5;
  const SMOKE_LIFE = 12;
  const smokeGeo = new THREE.SphereGeometry(1, 12, 9);
  const smokeOffsets = [
    [0, 0, 0, 1.7], [1.5, 0.4, 0.6, 1.3], [-1.4, 0.3, 0.7, 1.4],
    [0.7, -0.3, -1.3, 1.2], [-0.8, 0.5, -1.2, 1.25],
  ];
  const smokes = [];
  for (let i = 0; i < 2; i += 1) {
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color('#8a97a0'), transparent: true, opacity: 0, depthWrite: false, roughness: 1 });
    const group = new THREE.Group();
    for (const [ox, oy, oz, s] of smokeOffsets) {
      const m = new THREE.Mesh(smokeGeo, mat);
      m.position.set(ox, oy, oz);
      m.scale.setScalar(s);
      group.add(m);
    }
    group.visible = false;
    scene.add(group);
    smokes.push({ group, mat, life: 0 });
  }
  let smokeCursor = 0;

  return {
    tracer(from, to) {
      const t = tracers[tracerCursor];
      tracerCursor = (tracerCursor + 1) % MAX_TRACERS;
      const pos = t.line.geometry.attributes.position;
      pos.setXYZ(0, from.x, from.y, from.z);
      pos.setXYZ(1, to.x, to.y, to.z);
      pos.needsUpdate = true;
      t.line.visible = true;
      t.life = 0.07;
    },
    spark(at, rng) {
      const s = sparks[sparkCursor];
      sparkCursor = (sparkCursor + 1) % MAX_SPARKS;
      const pos = s.points.geometry.attributes.position;
      for (let i = 0; i < SPARK_PARTICLES; i += 1) {
        pos.setXYZ(i, at.x, at.y, at.z);
        s.vel[i * 3] = (rng() * 2 - 1) * 3;
        s.vel[i * 3 + 1] = rng() * 3.5;
        s.vel[i * 3 + 2] = (rng() * 2 - 1) * 3;
      }
      pos.needsUpdate = true;
      s.points.visible = true;
      s.life = 0.4;
    },
    explosion(at) {
      boomPos.copy(at);
      boom.position.copy(at);
      boom.visible = true;
      boomLife = 0.7;
      boomLight.position.copy(at).y += 1.5;
      boomLight.intensity = 60;
    },
    // A smoke cloud blooms at `at` (already raised to chest height by the
    // caller), holds for most of its 12 s, and fades out over the last 3 s.
    smoke(at) {
      const c = smokes[smokeCursor];
      smokeCursor = (smokeCursor + 1) % smokes.length;
      c.group.position.copy(at);
      c.group.visible = true;
      c.life = SMOKE_LIFE;
      c.mat.opacity = 0;
    },
    step(dt) {
      for (const t of tracers) {
        if (t.life <= 0) continue;
        t.life -= dt;
        if (t.life <= 0) t.line.visible = false;
      }
      for (const s of sparks) {
        if (s.life <= 0) continue;
        s.life -= dt;
        const pos = s.points.geometry.attributes.position;
        for (let i = 0; i < SPARK_PARTICLES; i += 1) {
          s.vel[i * 3 + 1] -= 9 * dt;
          pos.setXYZ(i,
            pos.getX(i) + s.vel[i * 3] * dt,
            Math.max(0.02, pos.getY(i) + s.vel[i * 3 + 1] * dt),
            pos.getZ(i) + s.vel[i * 3 + 2] * dt);
        }
        pos.needsUpdate = true;
        if (s.life <= 0) s.points.visible = false;
      }
      if (boomLife > 0) {
        boomLife -= dt;
        const k = 1 - Math.max(0, boomLife) / 0.7;
        const r = 0.5 + k * 7;
        boom.scale.setScalar(r);
        boomMat.opacity = Math.max(0, 0.85 * (1 - k));
        boomLight.intensity = Math.max(0, 60 * (1 - k));
        if (boomLife <= 0) { boom.visible = false; boomLight.intensity = 0; }
      }
      for (const c of smokes) {
        if (c.life <= 0) continue;
        c.life -= dt;
        const age = SMOKE_LIFE - Math.max(0, c.life);
        // Bloom 0.6 -> 1 over the first 0.8 s, hold, fade over the last 3 s.
        const grow = Math.min(1, age / 0.8);
        c.group.scale.setScalar(0.6 + 0.4 * grow);
        const fade = Math.min(1, Math.max(0, c.life) / 3);
        c.mat.opacity = 0.32 * Math.min(grow * 1.5, 1) * fade;
        if (c.life <= 0) { c.group.visible = false; c.mat.opacity = 0; }
      }
    },
  };
}
