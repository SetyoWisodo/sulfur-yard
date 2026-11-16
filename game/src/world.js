// Sulfur Yard: a 64 x 48 m sulfur-mining yard at dusk. Ember spawns south,
// Ash spawns north. Site A "Crusher" sits west, Site B "Kiln" east, joined
// by three lanes (west, mid, east) with cross connectors. Every solid is a
// box collider for players and bots and a surface bullets stop on. Cylinders
// (silos, pipes) get box colliders a touch inside their visual radius.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const C = (hex) => new THREE.Color(hex);

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);
  const colliders = [];
  const shootables = [];
  const mats = {};
  for (const name of Object.keys(PALETTE)) {
    mats[name] = new THREE.MeshStandardMaterial({ color: C(PALETTE[name]), roughness: 0.9, metalness: 0.05 });
  }
  mats.steel.metalness = 0.45;
  mats.steel.roughness = 0.55;
  mats.steelDark.metalness = 0.4;
  mats.steelDark.roughness = 0.6;

  function box(w, h, d, x, y, z, mat, collide = true) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats[mat]);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (collide) {
      colliders.push(new THREE.Box3().setFromObject(mesh));
      shootables.push(mesh);
    }
    return mesh;
  }

  function cyl(rTop, rBot, h, x, y, z, mat, seg = 12) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mats[mat]);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    // Box collider slightly inside the cylinder so bots and players can brush past.
    const half = Math.max(rTop, rBot) * 0.72;
    colliders.push(new THREE.Box3(
      new THREE.Vector3(x - half, y - h / 2, z - half),
      new THREE.Vector3(x + half, y + h / 2, z + half)));
    shootables.push(mesh);
    return mesh;
  }

  // Ground: two slabs with a darker worn strip down mid lane.
  box(64.4, 0.4, 48.4, 0, -0.2, 0, 'ground');
  box(6, 0.06, 48, 0, 0.03, 0, 'groundDark', false);
  box(64, 0.06, 4, 0, 0.03, -8, 'groundDark', false);

  // Perimeter walls, 4 m high, with a gap-free ring.
  box(64.4, 4, 0.6, 0, 2, -24.2, 'steelDark');
  box(64.4, 4, 0.6, 0, 2, 24.2, 'steelDark');
  box(0.6, 4, 48.4, -32.2, 2, 0, 'steelDark');
  box(0.6, 4, 48.4, 32.2, 2, 0, 'steelDark');

  // --- Site A "Crusher" (west, -24, -16): crusher housing + ore piles.
  box(10, 3.4, 6, -24, 1.7, -18, 'steel');
  box(10.4, 0.5, 6.4, -24, 3.6, -18, 'steelDark');
  box(3, 2.2, 3, -27.5, 1.1, -13.5, 'rust');
  // Cycle 14: this crate sat at (-21,-13.2), directly on the waypoint
  // edge 13<->15 — defenders rotating to Site A from the north row wedged
  // there for 10+ s (the 1.8 m sidestep cannot get around a 2.2 m crate
  // sitting on the approach line). First move (-24,-10) was worse: it
  // blocked the southern approach edge 10<->13 (the segment clips the
  // crate's east corner). (-21,-7) is clear of BOTH approaches and of
  // every other edge (grid-searched by /tmp/audit/audit2.mjs) — still
  // site-A dressing, now cover on the southern approach.
  box(2.2, 1.4, 2.2, -21, 0.7, -7, 'crate');
  cyl(1.6, 1.9, 5.5, -29, 2.75, -20, 'steelDark');
  // --- Site B "Kiln" (east, 24, -16): kiln drum + chimney.
  cyl(2.2, 2.2, 7, 26, 1.4, -18, 'rust');
  cyl(0.9, 1.1, 9, 21.5, 4.5, -20.5, 'steelDark');
  box(5, 2.4, 4, 20, 1.2, -14.5, 'steel');
  box(2.4, 1.2, 2.4, 27.5, 0.6, -12.5, 'crateDark');

  // --- Silo row along the north wall (Ash side cover).
  cyl(2.4, 2.4, 8, -12, 4, -21.5, 'steel');
  cyl(2.4, 2.4, 8, -4, 4, -21.5, 'steelDark');
  cyl(2.4, 2.4, 8, 12, 4, -21.5, 'steel');

  // --- Conveyor spine down mid lane (low, walkable-around, blocks sight).
  box(2.2, 1.1, 16, 0, 0.55, -2, 'steelDark');
  box(2.6, 0.25, 16, 0, 1.2, -2, 'rust');
  box(1.4, 2.6, 1.4, 0, 1.3, 6.5, 'steel');
  box(1.4, 2.6, 1.4, 0, 1.3, -10.5, 'steel');

  // --- Crates and cover scattered on the three lanes.
  const crates = [
    [-22, 1.1, -4, 2.2, 'crate'], [-22, 0.7, 2, 1.4, 'crateDark'],
    [-14, 0.9, 8, 1.8, 'crate'], [-14, 0.9, -12, 1.8, 'crateDark'],
    [-8, 1.1, -4, 2.2, 'crate'], [-8, 0.7, 12, 1.4, 'crate'],
    [8, 1.1, -4, 2.2, 'crateDark'], [8, 0.7, 12, 1.4, 'crate'],
    [14, 0.9, 8, 1.8, 'crate'], [14, 0.9, -12, 1.8, 'crateDark'],
    [22, 1.1, -4, 2.2, 'crate'], [22, 0.7, 2, 1.4, 'crateDark'],
    [-26, 0.9, 6, 1.8, 'crateDark'], [26, 0.9, 6, 1.8, 'crate'],
    [-4, 0.9, 18, 1.8, 'crate'], [4, 0.9, 18, 1.8, 'crateDark'],
    [-19, 0.7, -11.5, 2.2, 'crate'], [18, 1.1, -18, 2.2, 'crateDark'],
  ];
  for (const [x, h, z, s, m] of crates) box(s, h, s, x, h / 2, z, m);

  // --- Pipe runs (low walls) forcing corners on west and east lanes.
  box(0.8, 1.6, 10, -16, 0.8, -6, 'steelDark');
  box(0.8, 1.6, 10, 16, 0.8, -6, 'steelDark');
  box(10, 1.6, 0.8, -24, 0.8, 4, 'steelDark');
  box(10, 1.6, 0.8, 24, 0.8, 4, 'steelDark');
  // Overhead pipe gantry across mid (visual only, high enough to walk under).
  box(10, 0.7, 0.7, -5, 4.6, -8, 'rust', false);

  // --- Sulfur piles: low amber mounds near the sites (visual, walkable over? no — low colliders).
  box(4, 0.5, 3, -28, 0.25, -10, 'sulfur');
  box(3.5, 0.5, 3, 28, 0.25, -10, 'sulfur');

  // --- Ore carts (cycle 12, Kilnyard comparison): rusted carts parked
  // against the walls, clear of every waypoint edge (west carts sit at
  // x=-29, the west lane column is x=-19; the east cart at x=29, the east
  // column is x=19). The body collides; the wheels are visual only.
  function oreCart(x, z) {
    box(1.6, 0.8, 1.0, x, 0.55, z, 'rust');
    box(1.7, 0.12, 1.1, x, 0.98, z, 'steelDark');
    for (const dz of [-0.35, 0.35]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 10), mats.steelDark);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, 0.22, z + dz);
      wheel.castShadow = true;
      group.add(wheel);
    }
  }
  oreCart(-29, -8);
  oreCart(-29, 2);
  oreCart(29, 8);

  // --- Barrels (cycle 12): rust/steel drums clustered by the walls and
  // the north silos, clear of the waypoint columns (x=±19/4) and of the
  // spawn rows.
  const barrels = [
    [28, -4, 'rust'], [28.8, -3.2, 'steelDark'], [28.4, -5.2, 'rust'],
    [-28, 10, 'rust'], [-27.2, 10.8, 'steelDark'],
    [6, -20, 'rust'], [-6, -20, 'steelDark'], [6.8, -19.2, 'rust'],
  ];
  for (const [x, z, m] of barrels) cyl(0.5, 0.5, 1.1, x, 0.55, z, m, 10);

  // --- Hazard striping (cycle 12): sulfur-yellow chevrons on the ground
  // at the site approaches. Visual only (no collider) — bots walk over
  // them, and they read as yard markings, not cover.
  for (const [x, z] of [[-26, -11.5], [-23, -11.5], [-20, -11.5], [22, -11.5], [25, -11.5], [28, -11.5]]) {
    box(2.4, 0.02, 0.3, x, 0.05, z, 'sulfur', false);
  }

  // --- Site markers: glowing floor rings + a small beacon post at each site.
  function siteMarker(x, z, color) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.8, 32),
      new THREE.MeshBasicMaterial({ color: C(color), transparent: true, opacity: 0.75, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.06, z);
    group.add(ring);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 2.6, 0.35),
      new THREE.MeshStandardMaterial({ color: C(color), emissive: C(color), emissiveIntensity: 0.7 }));
    post.position.set(x, 1.3, z);
    group.add(post);
    const glow = new THREE.PointLight(C(color), 6, 12);
    glow.position.set(x, 2.6, z);
    group.add(glow);
    return ring;
  }
  siteMarker(-24, -15, PALETTE.ember);
  siteMarker(24, -15, PALETTE.ember);

  // --- Amber lamps on poles down each lane.
  const lampPositions = [[-22, 6], [0, 12], [22, 6], [-10, -8], [10, -8], [0, -18], [-4, -14], [4, -14]];
  for (const [x, z] of lampPositions) {
    box(0.25, 4.2, 0.25, x, 2.1, z, 'steelDark', false);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8),
      new THREE.MeshStandardMaterial({ color: C(PALETTE.lamp), emissive: C(PALETTE.lamp), emissiveIntensity: 1.6 }));
    bulb.position.set(x, 4.3, z);
    group.add(bulb);
    const light = new THREE.PointLight(C(PALETTE.lamp), 9, 15);
    light.position.set(x, 4.2, z);
    group.add(light);
  }

  // --- Lighting: dusk sun low from the west, cool hemisphere, fog. The
  // hemisphere fill was raised in cycle 11 (0.85 → 1.1) and again in
  // cycle 12 (→ 1.25, then → 1.35) because the play shot's lower half — the foreground
  // ground the player walks on — still read dark (mean luminance 27.4, then
  // 29.2 vs the ~30 target); the dusk palette is unchanged, the ground just stops
  // swallowing the light. Two extra lamps at (±4,-14) put warm pools on
  // the north lanes the play shot looks down.
  scene.fog = new THREE.Fog(C(PALETTE.fog), 22, 78);
  const hemi = new THREE.HemisphereLight(C('#5b7180'), C('#282219'), 1.35);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(C('#ffb37a'), 1.9);
  sun.position.set(-30, 16, 14);
  sun.target.position.set(4, 0, -6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  sun.shadow.camera.far = 90;
  sun.shadow.bias = -0.0006;
  scene.add(sun, sun.target);

  // Waypoint graph: nodes on the three lanes and connectors. Bots BFS through it.
  // Every edge was checked by hand against the colliders: lane columns sit
  // clear of the crates and pipes (west x=-19, mid x=4, east x=19), the
  // z=-8 row does NOT cross between lanes (the pipe runs at x=±16 block it),
  // and the site approaches come in from the south, clear of the kiln box
  // and crusher housing. Bots also carry a stuck-sidestep (see bots.js) as a
  // safety net for any corner the graph still clips.
  // Cycle 14 (edge audit, /tmp/audit/audit.mjs — same test as bots.js
  // segmentClear): 6 of 31 edges fail the strict segment test. Three are
  // fixed here ([7,8] and [15,11] removed, [13,15] kept by moving the
  // crate); three are traversable via the sidestep and are deliberately
  // left:
  // - [7,8] REMOVED: the conveyor spine crosses it mid-span (x -1.1..1.1,
  //   z -10..6) — a 1.8 m sidestep can never get around a 16 m wall, so any
  //   bot BFS-routed across mid at z=0 wedged there until killed or the
  //   round ended. Bots now cross mid via the lane columns (7->4->5->8).
  // - [13,15] KEPT by moving the ore-pile crate (-21,-13.2)->(-24,-10):
  //   the crate sat on the approach line and wedged defenders rotating to
  //   Site A (Dusk + Slag, 10+ s at node 15, cycle 14 wedge watch).
  // - [15,11] REMOVED (cycle 14e): the conveyor spine's south corner
  //   cuts it — the segment from (-12,-16) to (4,-8) crosses the spine's
  //   south face at (0,-10), and a 1.8 m sidestep can never get around a
  //   16 m wall approached at a shallow angle: the sidestep only pushes
  //   the bot into the spine's west face, where it oscillates for 20+ s
  //   (anchor detector: Cinder-2 in 'rotate' at (-1.7,-8) in R2/R5/R6,
  //   all site-B plants). The cycle-14 audit left this edge in, claiming
  //   the sidestep clears it — the anchor detector proves it does not.
  //   Bots now cross from the north row to node 11 via 15->17->16->11
  //   (all clear). Same class as the removed [7,8].
  // - [1,5], [4,7], [6,9] LEFT: blocked only at a corner or a small
  //   prop's edge (spawn crate, pipe ends) — the sidestep clears those in
  //   ~3-5 s, and 7 rounds of wedge watch never flagged them. Removing
  //   them would lengthen every lane traversal for no stall saved.
  const wp = (x, z) => new THREE.Vector3(x, 0, z);
  const nodes = [
    wp(-24, 20), wp(-10, 20), wp(8, 20), wp(24, 20), // Ember spawn row
    wp(-19, 10), wp(4, 11), wp(19, 10),
    wp(-19, 0), wp(4, 0), wp(19, 0),
    wp(-19, -8), wp(4, -8), wp(19, -8),
    wp(-25, -13), wp(25, -13), // site approaches A, B
    wp(-12, -16), wp(12, -16), wp(0, -16), // north row
    wp(-14, -19), wp(14, -19), // Ash row
    wp(-24, -22), wp(-16, -22), wp(-16, -16), // south bypass around the crusher housing
  ];
  const edges = [
    [0, 1], [1, 2], [2, 3], [0, 4], [1, 5], [2, 6], [3, 6],
    [4, 7], [5, 8], [6, 9], [4, 5], [5, 6],
    [7, 10], [8, 11], [9, 12], [8, 9],
    [10, 13], [12, 14],
    [13, 15], [15, 17], [17, 16], [16, 11],
    [15, 18], [16, 19], [18, 17], [19, 17],
    [20, 21], [21, 22], [22, 15],
  ];
  const adjacency = nodes.map(() => []);
  for (const [a, b] of edges) { adjacency[a].push(b); adjacency[b].push(a); }

  return {
    colliders,
    shootables,
    group,
    sites: {
      A: { name: 'Crusher', pos: new THREE.Vector3(-24, 0, -15), node: 13 },
      B: { name: 'Kiln', pos: new THREE.Vector3(24, 0, -15), node: 14 },
    },
    spawns: {
      ember: [wp(-26, 21), wp(-14, 21), wp(0, 22), wp(14, 21), wp(26, 21)],
      // Ash spawns sit a full bot-radius clear of every collider: the old
      // west spawn (-26,-21) wedged its bot 0.34 m into the crusher housing
      // corner and the (-14,-21)/(14,-21) spawns clipped the silo boxes, so
      // those bots could never take a single step (cycle 2). Cycle 14: the
      // east spawn (26,-21) had the same disease one step out — the kiln
      // drum at (26,-18) blocks the segment to every nearby node, so
      // Gravel stalled 10+ s at spawn in two separate watches (the edge
      // audit confirms NO clear node from (26,-21), and (23,-21) still
      // clips the drum's north-west corner). Moved to (20,-21): nearest
      // clear node 19 at 6.3 m, west of the drum and clear of the chimney.
      ash: [wp(-26, -22), wp(-16, -21), wp(0, -22), wp(16, -21), wp(20, -21)],
    },
    nodes,
    adjacency,
  };
}
