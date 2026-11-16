// Boot and the one loop: a fixed 60 Hz simulation feeding a render at the
// display's rate. All match state lives in rounds.js; this file wires the
// modules together, owns the shooting ray, grenades, planting, and the
// deterministic ?shot= captures (render twice, freeze, window.__shotReady).
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { mulberry32 } from './rng.js';
import { createWorld } from './world.js';
import { createPlayer } from './player.js';
import { createWeapon, WEAPONS } from './weapons.js';
import { createBots } from './bots.js';
import { createMatch, BUY_SECONDS, ROUND_SECONDS, CHARGE_SECONDS, HALFTIME_ROUND } from './rounds.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import { createEffects } from './effects.js';
import { createInput } from './input.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;
const rng = mulberry32(shot ? seed : (Date.now() % 2147483647));

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft is deprecated since r182 and logs a warning
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
scene.add(camera);

const world = createWorld(scene);
const effects = createEffects(scene);
const audio = createAudio();
const match = createMatch();
const hud = createHud();
const player = createPlayer(world.colliders);
const weapon = createWeapon(camera, 'pistol');
const bots = createBots(scene, world, rng);
const input = createInput(renderer.domElement, onLockChange);
const raycaster = new THREE.Raycaster();
raycaster.far = 140;

const body = player.state;
const shootables = world.shootables.concat(bots.hitMeshes);
const direction = new THREE.Vector3();
const muzzle = new THREE.Vector3();
const hitPoint = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const shotEnd = new THREE.Vector3();
const pelletDir = new THREE.Vector3();
const grenadeVel = new THREE.Vector3();
const SITE_IDS = ['A', 'B'];
// Buy menu keys: rows 1–9, then 0 for the tenth row, then K for the
// eleventh (the defuse kit — cycle 12: the menu grew to 11 rows, and
// Digit10 does not exist; K is free everywhere else).
const digitKey = (i) => (i === 9 ? 'Digit0' : i === 10 ? 'KeyK' : `Digit${i + 1}`);

let started = false;
let frozen = false;
let accumulator = 0;
let lastTime = performance.now();
let prevFiring = false;
// Hold-E progress for the objective action: planting as an attacker,
// defusing as a defender (cycle 12, halftime side-swap). One variable
// because the two actions never overlap — the charge is either absent
// (plant) or present (defuse) — and both reset on round start.
let actionProgress = 0;
let stepTimer = 0;
let beepTimer = 0;
let buyOpen = false;
let roundStarted = false;
let chargeMesh = null;
const grenades = []; // { mesh, vel, timer, kind, owner }
const smokes = []; // { pos, radius, t } — live smoke clouds (cycle 11), for the LOS check below
const SMOKE_RADIUS = 2.5;
const SMOKE_SECONDS = 12;

function makeChargeMesh() {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.3, 0.35),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ember), emissive: new THREE.Color(PALETTE.ember), emissiveIntensity: 0.9 }),
  );
  mesh.visible = false;
  scene.add(mesh);
  return mesh;
}
chargeMesh = makeChargeMesh();

function syncCamera() {
  camera.position.set(body.position.x, body.position.y + body.eye, body.position.z);
  camera.rotation.set(body.pitch, body.yaw, 0, 'YXZ');
}

function aimAt(point) {
  const dx = point.x - body.position.x;
  const dy = point.y - (body.position.y + body.eye);
  const dz = point.z - body.position.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  body.yaw = Math.atan2(-dx, -dz);
  body.pitch = Math.asin(Math.max(-1, Math.min(1, dy / len)));
  syncCamera();
}

function segmentSphere(a, b, c, r) {
  // True when point c is within r of segment ab — the smoke sight test.
  const abx = b.x - a.x; const aby = b.y - a.y; const abz = b.z - a.z;
  const acx = c.x - a.x; const acy = c.y - a.y; const acz = c.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? (acx * abx + acy * aby + acz * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = acx - abx * t; const dy = acy - aby * t; const dz = acz - abz * t;
  return dx * dx + dy * dy + dz * dz < r * r;
}

function losBlocked(from, to) {
  // Smoke (cycle 11): a cloud blocks sight when the eye-to-target segment
  // passes within its radius. Only the bot sense uses this — bullets are
  // unaffected, so a smoked lane hides the player from bots but not from
  // a blind spray, exactly like a tactical smoke should.
  for (const s of smokes) {
    if (segmentSphere(from, to, s.pos, s.radius)) return true;
  }
  tmpV2.copy(to).sub(from);
  const dist = tmpV2.length();
  if (dist < 0.01) return false;
  raycaster.set(from, tmpV2.normalize());
  raycaster.far = dist;
  const hit = raycaster.intersectObjects(world.shootables, false)[0];
  raycaster.far = 140;
  return !!hit;
}

function muzzleWorld() {
  camera.getWorldPosition(muzzle);
  camera.getWorldDirection(tmpV);
  muzzle.addScaledVector(tmpV, 0.7);
  muzzle.y -= 0.12;
  return muzzle;
}

function shoot(spread) {
  if (!weapon.takeRound()) { audio.dryFire(); return false; }
  camera.getWorldDirection(direction);
  direction.x += (rng() * 2 - 1) * spread;
  direction.y += (rng() * 2 - 1) * spread;
  direction.z += (rng() * 2 - 1) * spread;
  direction.normalize();
  const pellets = weapon.def.pellets || 1;
  let killed = false;
  for (let p = 0; p < pellets; p += 1) {
    // Reused vector: no allocation per pellet in this hot loop.
    pelletDir.copy(direction);
    if (pellets > 1) {
      pelletDir.x += (rng() * 2 - 1) * weapon.def.spreadStill * 2;
      pelletDir.y += (rng() * 2 - 1) * weapon.def.spreadStill * 2;
      pelletDir.normalize();
    }
    const dir = pelletDir;
    raycaster.set(camera.position, dir);
    raycaster.far = weapon.def.range;
    // Take the first hit that is world geometry or a LIVE ENEMY bot. Dead
    // bots' meshes stay in `shootables` (built once at boot) and the
    // raycaster ignores `visible = false`, so without this a shot could
    // "hit" an invisible corpse for full damage — and a corpse could shield
    // a live bot standing behind it (cycle 7: "You hit Dusk for 52" on a
    // corpse). Teammates are skipped the same way (cycle 11): the player's
    // fire must never hurt Ember — an ally in the line of fire used to
    // absorb full damage and even pay the +$300 kill reward (cycle 8's
    // frag double-kill of Cinder + Soot was two teammates). A shot passes
    // through an ally and can still hit the enemy behind them.
    const hits = raycaster.intersectObjects(shootables, false);
    let hit = null;
    for (let i = 0; i < hits.length; i += 1) {
      const h = hits[i];
      const hb = h.object.userData.bot;
      if (!hb || (hb.alive && hb.team === 'ash')) { hit = h; break; }
    }
    // Dedicated vector: the muzzle helper reuses tmpV, so the tracer end
    // must live somewhere it cannot be overwritten mid-call.
    if (hit) shotEnd.copy(hit.point);
    else shotEnd.copy(camera.position).addScaledVector(dir, weapon.def.range);
    const end = shotEnd;
    effects.tracer(muzzleWorld(), end);
    if (hit) {
      hitPoint.copy(hit.point);
      if (hit.object.userData.bot) {
        const bot = hit.object.userData.bot;
        // Per-part hitboxes (cycle 11, "hitbox gunplay"): head x2, torso
        // x1, legs x0.8. The part comes from the mesh the ray met, so a
        // leg shot is a leg shot even at an angle.
        const part = hit.object.userData.part;
        const isHead = part === 'head';
        const mult = isHead ? weapon.def.headMult : part === 'legs' ? 0.8 : 1;
        const dmg = weapon.def.damage * mult;
        const me = stat('You');
        me.dmg += dmg;
        if (bots.damage(bot, dmg, 'You')) {
          killed = true;
          me.k += 1;
          if (isHead) me.hs += 1;
          match.addKillReward();
          match.addFeed(`You eliminated ${bot.name} (${bot.team === 'ash' ? 'Ash' : 'Ember'})`, 'kill');
          audio.kill();
          checkRoundEnd();
        } else {
          audio.hit();
          match.addFeed(`You hit ${bot.name} for ${Math.round(dmg)}`, 'info');
        }
        hud.hitMarker(killed, shot ? 4000 : 120);
      } else {
        effects.spark(hitPoint, rng);
      }
    }
  }
  raycaster.far = 140;
  weapon.pullTrigger();
  player.recoil(weapon.def.kick + rng() * 0.004, (rng() * 2 - 1) * 0.004);
  audio.shot(weapon.def.sound);
  bots.alert(camera.position, 26);
  hud.setAmmo(weapon.state.mag, weapon.state.reserve);
  hud.setMoney(match.state.money);
  return true;
}

function throwGrenade(kind) {
  if (match.state.grenades[kind] <= 0) { audio.denied(); return; }
  match.state.grenades[kind] -= 1;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(kind === 'frag' ? PALETTE.rust : PALETTE.ink) }));
  mesh.position.copy(camera.position);
  scene.add(mesh);
  camera.getWorldDirection(tmpV);
  grenadeVel.copy(tmpV).multiplyScalar(16);
  grenadeVel.y += 4;
  grenades.push({ mesh, vel: grenadeVel.clone(), timer: kind === 'frag' ? 1.6 : 1.1, kind });
  audio.throwPin();
  hud.setWeapon(weapon.def.name, match.state.grenades.frag, match.state.grenades.flash, match.state.grenades.smoke);
}

function explodeGrenade(g) {
  scene.remove(g.mesh);
  // The throw builds one small mesh + material per grenade (the only
  // allocation outside boot, and only on a throw, never per frame), so
  // release it here instead of leaking a geometry per throw across a
  // 13-round match.
  g.mesh.geometry.dispose();
  g.mesh.material.dispose();
  const pos = g.mesh.position;
  if (g.kind === 'frag') {
    effects.explosion(pos);
    audio.explosion();
    for (const bot of bots.bots) {
      if (!bot.alive || bot.team !== 'ash') continue; // a frag never hurts Ember (cycle 11: it used to kill teammates and pay +$300 for it)
      const d = bot.pos.distanceTo(pos);
      if (d < 7) {
        const dmg = Math.round(95 * (1 - d / 7) + 10);
        const me = stat('You');
        me.dmg += dmg;
        if (bots.damage(bot, dmg, 'You')) {
          me.k += 1;
          match.addKillReward();
          match.addFeed(`You eliminated ${bot.name} with a frag`, 'kill');
          audio.kill();
        }
      }
    }
    bots.alert(pos, 30);
    checkRoundEnd();
  } else if (g.kind === 'smoke') {
    // A smoke cloud blooms at chest height over the pop point and screens
    // the lane for 12 s. The throw is a long one (~15 m on the fuse), so
    // it is a lane-screening tool: throw it at the far side of the lane
    // you are about to cross, not at your own feet.
    const cloudPos = new THREE.Vector3(pos.x, 1.2, pos.z);
    effects.smoke(cloudPos);
    smokes.push({ pos: cloudPos, radius: SMOKE_RADIUS, t: SMOKE_SECONDS });
    audio.beep(false);
  } else {
    hud.whiteFlash();
    audio.beep(true);
    for (const bot of bots.bots) {
      if (!bot.alive || bot.team !== 'ash') continue; // a flash never blinds Ember either (cycle 11)
      if (bot.pos.distanceTo(pos) < 20) bot.senseTimer = 3; // blinded: no sight for 3 s
    }
  }
}

function plantCharge(site) {
  match.state.charge = { site, timer: CHARGE_SECONDS, plantedBy: 'You' };
  match.state.chargeSite = site;
  const pos = world.sites[site].pos;
  chargeMesh.position.set(pos.x, 0.25, pos.z);
  chargeMesh.visible = true;
  match.addPlantReward();
  match.addFeed(`You planted the charge at Site ${site} (${world.sites[site].name}) +$300`, 'plant');
  audio.plant();
  bots.alert(pos, 40);
  hud.setMoney(match.state.money);
}

function checkRoundEnd() {
  const m = match.state;
  if (m.phase !== 'live') return;
  const emberAlive = bots.aliveCount('ember') + (body.alive ? 1 : 0);
  const ashAlive = bots.aliveCount('ash');
  // Roles, not team names, decide a round (cycle 12, halftime side-swap):
  // the attackers win by wiping the defenders or detonating the charge;
  // the defenders win by wiping the attackers, running the clock out, or
  // defusing. The player is always Ember, so "attackers wiped" means a
  // different headcount in each half.
  const atkAlive = m.attackerTeam === 'ember' ? emberAlive : ashAlive;
  const defAlive = m.attackerTeam === 'ember' ? ashAlive : emberAlive;
  const atkName = m.attackerTeam === 'ember' ? 'Ember' : 'Ash';
  const defName = m.attackerTeam === 'ember' ? 'Ash' : 'Ember';
  if (m.charge) {
    if (defAlive === 0) match.endRound(m.attackerTeam, `${defName} eliminated — charge detonates`);
    // Attackers wiped while charge is live: defenders still have to defuse; the timer decides.
    return;
  }
  if (defAlive === 0) match.endRound(m.attackerTeam, `${defName} team eliminated`);
  else if (atkAlive === 0) match.endRound(m.attackerTeam === 'ember' ? 'ash' : 'ember', `${atkName} team eliminated`);
}

let radioCooldown = 0;
let lastRadioText = '';
let radioPending = null;
let prevPhase = 'buy'; // buy->live transition watcher (cycle 15, contact edges)
// The radio channel (cycle 11, Kilnyard comparison): contextual callouts
// tied to REAL bot state changes — a first sighting, a rotation, a plant,
// a round plan. One global throttle (2 s sim time) keeps the feed from
// flooding; each event itself is a rare state transition, so the channel
// reads as a team talking, not a log. An identical line twice in a row
// (a bot re-rotating after losing its path) is dropped as a repeat.
// Cycle 15: a callout that arrives while the throttle is up is QUEUED
// (latest only), not dropped. Before this, an edge-triggered contact
// callout whose first sighting landed inside the 2 s window after the
// round-start "pushing" line was lost forever for that engagement —
// the bot never re-fires onContact until it loses and re-acquires an
// enemy — so the contact line appeared only in some runs (the
// minimap-radio test flaked on it). The queue keeps the 2 s spacing
// and the repeat drop; it just never silently loses a callout.
function radio(text) {
  if (text === lastRadioText) return;
  if (radioCooldown > 0) { radioPending = text; return; }
  radioCooldown = 2;
  lastRadioText = text;
  match.addFeed(`RADIO: ${text}`, 'radio');
}

// Match stats for the end-of-match scoreboard (cycle 11, Kilnyard
// comparison): per combatant kills / deaths / headshot kills / damage
// dealt. 'You' is the player; the bots are tracked by name. Reset on a
// new match; the ?shot=end capture seeds them (see seedEndStats).
const stats = {};
function stat(name) {
  if (!stats[name]) stats[name] = { k: 0, d: 0, hs: 0, dmg: 0 };
  return stats[name];
}
function resetStats() {
  for (const key of Object.keys(stats)) delete stats[key];
  stat('You');
  for (const b of bots.bots) stat(b.name);
}
resetStats();

function startRound() {
  const m = match.state;
  // Halftime (cycle 12): round 7 opens the second half with the sides
  // swapped — Ash attacks, Ember (and the player) defends. The swap
  // happens once, here, before the bots are placed for the round; the
  // attackerTeam guard makes a repeated startRound(7) a no-op.
  const halftimeSwap = m.round === HALFTIME_ROUND && m.attackerTeam === 'ember';
  if (halftimeSwap) match.swapSides();
  bots.reset(m.round, m.attackerTeam);
  // The player spawns with their side: south with the attackers in half 1
  // (facing north, toward the sites), north with the defenders in half 2
  // (facing south, toward the yard).
  const attacking = m.attackerTeam === 'ember';
  const spawn = attacking ? world.spawns.ember[2] : world.spawns.ash[2];
  player.reset(spawn, attacking ? 0 : Math.PI);
  weapon.equip(m.ownedWeapon);
  weapon.refillReserve();
  chargeMesh.visible = false;
  actionProgress = 0;
  radioPending = null; // a queued callout must not spill into the next round
  for (const g of grenades) scene.remove(g.mesh);
  grenades.length = 0;
  smokes.length = 0; // a new round starts with clear air
  match.resetRound();
  roundStarted = true;
  hud.setHealth(body.health);
  hud.setAmmo(weapon.state.mag, weapon.state.reserve);
  hud.setMoney(m.money);
  hud.setScore(m.scoreEmber, m.scoreAsh, m.round);
  hud.setWeapon(weapon.def.name, m.grenades.frag, m.grenades.flash, m.grenades.smoke);
  hud.setCharge('');
  // The round banner is set first so the halftime banner (when it fires)
  // is the one the player actually reads, not the one it overwrites.
  hud.banner(`ROUND ${m.round} — BUY PHASE (B)`, 3000);
  if (halftimeSwap) hud.banner('HALFTIME — SIDES SWAP — Ember defends the yard now', 4000);
  // Round-start sting (cycle 12): live play only — screenshot captures
  // stay silent and deterministic.
  if (!shot) audio.sting();
  // The round plan, from the carrier's assigned site: the team talks
  // before the push, and the line is already in the feed when live starts.
  // The radio is the PLAYER's team's channel (cycle 12): in half 1 the
  // carrier is an Ember attacker, so the plan is ours to hear; in half 2
  // the carrier is an Ash attacker, so the enemy's plan stays silent and
  // a defending Ember bot calls the hold instead.
  const carrier = bots.carrier();
  if (match.state.attackerTeam === 'ember') {
    if (carrier && carrier.site) radio(`${carrier.name} — pushing ${carrier.site}`);
  } else {
    const holder = bots.bots.find((b) => b.team === 'ember' && b.alive);
    if (holder) radio(`${holder.name} — holding ${holder.site || 'mid'}`);
  }
}

function endRoundFlow() {
  const m = match.state;
  const r = m.lastResult;
  if (!r) return;
  if (r.winner === 'ember') audio.roundWin(); else audio.roundLose();
  match.addFeed(`${r.winner === 'ember' ? 'EMBER' : 'ASH'} wins the round — ${r.reason}`, r.winner === 'ember' ? 'kill' : 'info');
  hud.banner(m.matchOver
    ? `${r.winner === 'ember' ? 'EMBER' : 'ASH'} WINS THE MATCH`
    : `${r.winner === 'ember' ? 'EMBER' : 'ASH'} WINS THE ROUND`, 3200);
  if (m.matchOver) {
    // End-of-match scoreboard: every combatant, Ember then Ash, the
    // player's row highlighted (hud sorts within each team by kills).
    const board = [
      { name: 'You', team: 'ember', you: true, ...stat('You') },
      ...bots.bots.filter((b) => b.team === 'ember').map((b) => ({ name: b.name, team: 'ember', ...stat(b.name) })),
      ...bots.bots.filter((b) => b.team === 'ash').map((b) => ({ name: b.name, team: 'ash', ...stat(b.name) })),
    ];
    hud.showOverlay('match', `${m.matchWinner === 'ember' ? 'EMBER' : 'ASH'} takes the yard ${m.scoreEmber}–${m.scoreAsh}.`, board);
    if (document.pointerLockElement) document.exitPointerLock();
  }
}

const botCtx = {
  get phase() { return match.state.phase; },
  get chargePlanted() { return !!match.state.charge; },
  get chargeSite() { return match.state.chargeSite; },
  get playerAlive() { return body.alive; },
  get playerCrouching() { return body.crouching; },
  playerPos: body.position,
  hasLOS(from, to) { return !losBlocked(from, to); },
  damagePlayer(amount, name) {
    if (!body.alive || match.state.phase !== 'live') return;
    audio.hurt();
    hud.damageFlash();
    // Armour absorbs half of every hit until it is depleted (cycle 11):
    // a 10-damage shot with 100 armour costs 5 armour and 5 health.
    let dmg = amount;
    if (match.state.armour > 0) {
      const absorbed = Math.min(match.state.armour, dmg * 0.5);
      match.state.armour -= absorbed;
      dmg -= absorbed;
    }
    if (player.damage(dmg)) {
      match.state.deaths += 1;
      stat('You').d += 1;
      match.addFeed(`${name} eliminated you`, 'death');
      // Death costs the gun (cycle 13, the Counter-Strike rule): the
      // bought weapon is lost and the next round opens on the free P-9.
      // Dying with a $4500 sniper has to hurt — before this, weapons
      // persisted for free across deaths, so money only ever accumulated
      // and the wallet cap bound by round 5–7 in every economy trace.
      // Grenades and the defuse kit are kept. Armour is ablative — the
      // damage that kills you spends it (from full health + full armour
      // it is always fully spent, as the cycle-13 follow-up proved live)
      // and any remainder persists into the next round.
      // startRound() equips ownedWeapon, so the loss takes effect there.
      match.state.ownedWeapon = 'pistol';
      checkRoundEnd();
    }
    hud.setHealth(body.health);
    hud.setArmour(match.state.armour);
  },
  botShot(bot, targetPos) {
    tmpV.copy(bot.pos); tmpV.y += 1.35;
    effects.tracer(tmpV, targetPos);
    audio.shot('enemy');
  },
  onBotDamage(bot, amount) {
    stat(bot.name).dmg += amount;
  },
  onBotKilled(killer, victim, victimTeam, head = false) {
    stat(killer).k += 1;
    stat(victim).d += 1;
    if (head) stat(killer).hs += 1;
    match.addFeed(`${killer} eliminated ${victim}`, 'info');
    if (victimTeam === 'ash') { /* bot-on-bot kill, no player reward */ }
    checkRoundEnd();
  },
  isCarrier(bot) { return bots.carrier() === bot; },
  // The radio is the PLAYER's team's channel (cycle 12): contact and
  // rotation callouts come only from Ember bots — the player's own side.
  // An Ash callout in the feed would be the enemy's radio leaking. Plant
  // and defuse lines are objective events, audible to everyone, so they
  // are not gated.
  onContact(bot) {
    if (match.state.phase !== 'live') return;
    if (bot.team !== 'ember') return;
    const lane = bot.pos.x < -10 ? 'west' : bot.pos.x > 10 ? 'east' : 'mid';
    radio(`${bot.name} — contact ${lane}`);
  },
  onRotate(bot, site) {
    if (match.state.phase !== 'live') return;
    if (bot.team !== 'ember') return;
    radio(`${bot.name} — rotating to ${site}`);
  },
  onPlantStart(bot, site) {
    radio(`${bot.name} — planting ${site}`);
    audio.plant();
  },
  onPlantDone(bot) {
    if (match.state.charge) return;
    // A carrier that finishes planting after the round clock already ended
    // the round must not plant into the intermission (cycle 5): the round
    // was already awarded on time, and the charge would linger as a stray
    // feed line and mesh until the next round wiped it.
    if (match.state.phase !== 'live') return;
    match.state.charge = { site: bot.actionSite, timer: CHARGE_SECONDS, plantedBy: bot.name };
    match.state.chargeSite = bot.actionSite;
    const pos = world.sites[bot.actionSite].pos;
    chargeMesh.position.set(pos.x, 0.25, pos.z);
    chargeMesh.visible = true;
    match.addFeed(`${bot.name} planted the charge at Site ${bot.actionSite}!`, 'plant');
    audio.plant();
  },
  onDefuseStart(bot) {
    radio(`${bot.name} — defusing ${bot.actionSite || ''}`.trim());
    audio.defuse();
  },
  onDefuseDone() {
    if (!match.state.charge) return;
    match.state.charge = null;
    match.state.chargeSite = null;
    chargeMesh.visible = false;
    // The defuse wins the round for the DEFENDERS — Ash in half 1, Ember
    // (the player's team) in half 2.
    match.endRound(match.state.attackerTeam === 'ember' ? 'ash' : 'ember', 'charge defused');
  },
};

function step(dt) {
  const m = match.state;
  if (!roundStarted) startRound();
  match.step(dt);
  // Fresh contact edges for live play (cycle 15): bots acquire enemies
  // during the buy phase while pre-positioning, so by live start they
  // already "have" an enemy and the null->enemy edge never fires — the
  // contact callout is silently lost for the whole engagement (onContact
  // only fires on that edge, and it is suppressed during buy). Resetting
  // visibleEnemy on the buy->live transition makes the first live
  // sighting a new edge, so onContact fires. Combat is unaffected: the
  // sense block in the same step re-acquires the enemy before shooting.
  if (prevPhase === 'buy' && m.phase === 'live') {
    for (const b of bots.bots) b.visibleEnemy = null;
  }
  prevPhase = m.phase;
  if (m.phase === 'over' && m.lastResult && !m._announced) {
    m._announced = true;
    endRoundFlow();
  }
  if (m.phase === 'over' && m.phaseTime <= 0 && !m.matchOver) {
    m._announced = false;
    if (match.nextRound()) startRound();
  }
  if (m.phase === 'over' && m.matchOver && m.phaseTime <= 0) {
    // Stay on the match overlay until the player clicks play again.
  }

  player.step(dt, input.state.keys);
  weapon.step(dt);
  effects.step(dt);
  bots.step(dt, botCtx);

  // Shooting lives in the fixed step, not the render loop: the sim owns the
  // trigger, so a headless fast-forward and a 144 Hz display fire the same
  // way. Auto weapons hold, semi weapons need a fresh click edge.
  const firing = input.state.firing;
  const edge = firing && !prevFiring;
  prevFiring = firing;
  if (body.alive && m.phase === 'live' && weapon.ready() && (weapon.def.auto ? firing : edge)) {
    shoot(weapon.spread(player.groundSpeed(), body.crouching));
  }

  // Footsteps.
  const speed = player.groundSpeed();
  if (speed > 1 && body.onGround) {
    stepTimer -= dt * speed;
    if (stepTimer <= 0) { stepTimer = 2.2; audio.step(); }
  }

  // Charge beeping.
  if (m.charge) {
    beepTimer -= dt;
    if (beepTimer <= 0) { beepTimer = Math.max(0.35, m.charge.timer / CHARGE_SECONDS); audio.beep(m.charge.timer < 5); }
    hud.setCharge(`CHARGE PLANTED — SITE ${m.charge.site} — ${Math.ceil(m.charge.timer)}s`);
  } else if (m.phase === 'live') {
    // The objective banner follows the half: plant in half 1, hold in half 2.
    hud.setCharge(m.attackerTeam === 'ember'
      ? 'PLANT THE CHARGE — HOLD E AT SITE A OR B'
      : 'DEFEND THE SITES — HOLD E TO DEFUSE A PLANTED CHARGE');
  } else hud.setCharge('');

  // Player objective action: hold E. As an attacker (half 1) the player
  // plants at a site (4 s, like the bot carrier); as a defender (half 2)
  // the player defuses a planted charge (5 s, like a bot defuser — the
  // same DEFUSE_TIME bots.js uses; 2.5 s with the defuse kit). One key,
  // one progress bar, opposite jobs: this is the only honest way a
  // defuse earns its place, and it only exists because the sides swap.
  if (m.phase === 'live' && body.alive && input.state.keys.has('KeyE')) {
    if (!m.charge && m.attackerTeam === 'ember') {
      let near = null;
      for (const site of SITE_IDS) {
        if (body.position.distanceTo(world.sites[site].pos) < 4) near = site;
      }
      if (near) {
        actionProgress += dt / 4;
        hud.setHint(`PLANTING… ${Math.round(actionProgress * 100)}% — keep holding E`);
        if (actionProgress >= 1) { plantCharge(near); actionProgress = 0; hud.setHint(''); }
      } else { actionProgress = 0; hud.setHint(''); }
    } else if (m.charge && m.attackerTeam !== 'ember') {
      const site = world.sites[m.charge.site];
      if (site && body.position.distanceTo(site.pos) < 4) {
        actionProgress += dt / (m.defuseKit ? 2.5 : 5);
        hud.setHint(`DEFUSING… ${Math.round(actionProgress * 100)}% — keep holding E`);
        if (actionProgress >= 1) {
          match.addFeed('You defused the charge', 'plant');
          audio.defuse();
          botCtx.onDefuseDone();
          actionProgress = 0; hud.setHint('');
        }
      } else { actionProgress = 0; hud.setHint(''); }
    } else { actionProgress = 0; hud.setHint(''); }
  } else {
    actionProgress = Math.max(0, actionProgress - dt / 2);
    if (m.phase === 'live' && body.alive) hud.setHint('');
  }

  // Grenades in flight.
  for (let i = grenades.length - 1; i >= 0; i -= 1) {
    const g = grenades[i];
    g.timer -= dt;
    g.vel.y -= 14 * dt;
    g.mesh.position.addScaledVector(g.vel, dt);
    if (g.mesh.position.y < 0.09) { g.mesh.position.y = 0.09; g.vel.y *= -0.35; g.vel.x *= 0.6; g.vel.z *= 0.6; }
    if (g.timer <= 0) { explodeGrenade(g); grenades.splice(i, 1); }
  }

  // Smoke clouds thin out after 12 s; sight returns with them.
  for (let i = smokes.length - 1; i >= 0; i -= 1) {
    smokes[i].t -= dt;
    if (smokes[i].t <= 0) smokes.splice(i, 1);
  }

  // Spread-driven crosshair gap.
  const gap = 3 + weapon.spread(speed, body.crouching) * 260;
  hud.setCrosshairGap(gap);

  // HUD numbers.
  hud.setHealth(body.health);
  hud.setArmour(m.armour);
  hud.setTimer(m.phase === 'buy' ? m.phaseTime : m.roundTime, m.phase);
  hud.setScore(m.scoreEmber, m.scoreAsh, m.round);
  hud.setMoney(m.money);
  hud.setFeed(match.feed);
  hud.setAmmo(weapon.state.mag, weapon.state.reserve);
  // Radio throttle ticks in sim time; the minimap redraws every step.
  // Flush a queued callout (cycle 15) the moment the throttle clears.
  radioCooldown = Math.max(0, radioCooldown - dt);
  if (radioCooldown === 0 && radioPending) {
    const text = radioPending;
    radioPending = null;
    radio(text);
  }
  hud.drawMinimap({
    px: body.position.x, pz: body.position.z, yaw: body.yaw,
    ember: bots.bots.filter((b) => b.team === 'ember'),
    ash: bots.bots.filter((b) => b.team === 'ash'),
    sites: world.sites,
    chargeSite: m.chargeSite,
  });
  if (m.phase === 'buy' && !buyOpen) hud.setHint('BUY PHASE — press B to open the buy menu');
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  // The simulation runs only while the player holds pointer lock (or in a
  // ?shot= capture). Before the first lock, and while paused, the yard is
  // frozen: the buy timer must not run out while the player is still
  // reading the start screen, and nobody should die on the pause screen.
  const simActive = shot || input.state.locked;
  if (!frozen && simActive) {
    const look = input.takeLook();
    player.look(look.x, look.y);
    if (input.wasPressed('KeyR') && weapon.reload()) audio.reload();
    if (input.wasPressed('KeyB') && match.state.phase === 'buy') {
      buyOpen = !buyOpen;
      hud.showBuy(buyOpen);
      // The "press B to open the buy menu" hint must not survive under an
      // open menu (cycle 12: it showed through below the 10-row menu in
      // the start shot). step() re-sets it when the menu closes.
      if (buyOpen) hud.setHint('');
      if (buyOpen) hud.refreshBuy(match.state.money, match.state.ownedWeapon, match.state.grenades, match.state.armour, match.state.defuseKit);
    }
    if (buyOpen && match.state.phase === 'buy') {
      for (let i = 0; i < hud.buyKeys.length; i += 1) {
        if (input.wasPressed(digitKey(i))) {
          const id = hud.buyKeys[i];
          const res = match.buy(id);
          hud.markBought(id, res.ok);
          if (res.ok) {
            audio.buy();
            if (WEAPONS[id]) { weapon.equip(id); hud.setAmmo(weapon.state.mag, weapon.state.reserve); }
            hud.setWeapon(weapon.def.name, match.state.grenades.frag, match.state.grenades.flash, match.state.grenades.smoke);
            hud.setMoney(match.state.money);
            hud.refreshBuy(match.state.money, match.state.ownedWeapon, match.state.grenades, match.state.armour, match.state.defuseKit);
          } else audio.denied();
        }
      }
    } else {
      // Drain stale digit presses. wasPressed only clears a code when it
      // is asked for, so a number tapped while the menu was closed used to
      // sit in the pressed set and fire a surprise purchase the next time
      // the menu opened (cycle 4: a $1500 SMG bought itself a round late).
      // Only a press made with the menu open may buy.
      for (let i = 0; i < hud.buyKeys.length; i += 1) input.wasPressed(digitKey(i));
    }
    // The buy menu closes itself when the buy phase ends. Nothing else
    // reset buyOpen, so an open menu used to sit over the whole live round
    // until the player remembered to press B again (cycle 4).
    if (buyOpen && match.state.phase !== 'buy') {
      buyOpen = false;
      hud.showBuy(false);
    }
    if (input.wasPressed('KeyG')) throwGrenade('frag');
    if (input.wasPressed('KeyF')) throwGrenade('flash');
    if (input.wasPressed('KeyV')) throwGrenade('smoke');
    // Mute toggle (cycle 12 sweep): audio.muted existed but nothing could
    // ever set it — a dead switch. M flips it, and the feed confirms it.
    if (input.wasPressed('KeyM')) {
      const m = audio.toggleMute();
      match.addFeed(m ? 'Sound muted — press M to unmute' : 'Sound on', 'info');
    }
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 5) {
      step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * 5) accumulator = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
}

function onLockChange(locked) {
  if (shot) return;
  audio.unlock();
  if (locked) {
    started = true;
    hud.hideOverlay();
    hud.showBuy(false);
    buyOpen = false;
  } else if (!match.state.matchOver && match.state.phase !== 'over') {
    hud.showOverlay(started ? 'paused' : 'start');
  }
}

hud.onPlay(() => {
  if (shot) return;
  audio.unlock();
  if (match.state.matchOver) {
    // Full reset for a new match.
    match.state.scoreEmber = 0;
    match.state.scoreAsh = 0;
    match.state.round = 1;
    match.state.money = 800;
    match.state.kills = 0;
    match.state.deaths = 0;
    match.state.matchOver = false;
    match.state.matchWinner = null;
    match.state.ownedWeapon = 'pistol';
    match.state.grenades = { frag: 0, flash: 0, smoke: 0 };
    match.state.armour = 0;
    match.state.defuseKit = false;
    // A new match always opens with Ember attacking (round 1); the
    // halftime swap is per-match, not sticky across matches.
    match.state.attackerTeam = 'ember';
    resetStats();
    startRound();
  } else if (match.state.phase === 'over' && !match.state.matchOver) {
    // Skip the wait: jump straight to the next round.
    match.state._announced = false;
    if (match.nextRound()) startRound();
  }
  input.requestLock();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- Deterministic screenshot modes -------------------------------------
function settle(steps) {
  for (let i = 0; i < steps; i += 1) step(FIXED_STEP);
}

// Staged history for the ?shot=end capture: 8 rounds, Ember 4–2, and the
// player's line reads like a match played (11 kills, 45% headshots).
// Fixed numbers, consistent with the staged score above.
function seedEndStats() {
  // Staged history for a 12-round match (Ember 6 – Ash 5 going into
  // round 12): the per-round rates match the old 9-round seed (~1.8
  // kills/round for the player), scaled to 11 completed rounds.
  const seed = {
    'You': { k: 20, d: 9, hs: 9, dmg: 2250 },
    'Cinder': { k: 14, d: 11, hs: 4, dmg: 1650 },
    'Soot': { k: 11, d: 13, hs: 2, dmg: 1160 },
    'Flint': { k: 9, d: 11, hs: 4, dmg: 1050 },
    'Pumice': { k: 7, d: 15, hs: 0, dmg: 760 },
    'Dusk': { k: 13, d: 11, hs: 5, dmg: 1490 },
    'Slag': { k: 11, d: 13, hs: 2, dmg: 1250 },
    'Cinder-2': { k: 9, d: 15, hs: 4, dmg: 1110 },
    'Basalt': { k: 7, d: 13, hs: 2, dmg: 870 },
    'Gravel': { k: 5, d: 16, hs: 0, dmg: 640 },
  };
  for (const [n, s] of Object.entries(seed)) Object.assign(stat(n), s);
}

function runShot(name) {
  hud.hideOverlay();
  startRound();
  // Buy phase gives us a calm, fully populated yard.
  if (name === 'start') {
    const spawn = world.spawns.ember[2];
    player.reset(spawn, 0);
    settle(30);
    aimAt(new THREE.Vector3(0, 1.2, -10));
    // The shot shows the rifle in the buy menu, so give the shot's wallet
    // enough to actually buy it — live play still starts at $800.
    match.state.money = 4000;
    match.buy('rifle');
    weapon.equip('rifle');
    hud.setAmmo(weapon.state.mag, weapon.state.reserve);
    hud.setMoney(match.state.money);
    hud.setWeapon(weapon.def.name, 0, 0, 0);
    buyOpen = true;
    hud.showBuy(true);
    hud.refreshBuy(match.state.money, match.state.ownedWeapon, match.state.grenades, match.state.armour, match.state.defuseKit);
    // No buy-phase hint under the open menu (cycle 12): settle() above
    // ran while buyOpen was still false, so step() set the hint — clear
    // it here, after the menu opens, or it shows through below the menu.
    hud.setHint('');
  } else if (name === 'play') {
    match.state.phase = 'live';
    match.state.roundTime = 78;
    // West lane: a clean 12 m sightline, no conveyor in the foreground.
    body.position.set(-12, 0, 8);
    body.yaw = 0;
    settle(10);
    const bot = bots.bots.find((b) => b.team === 'ash');
    bot.pos.set(-12, 0, -4);
    bot.group.position.copy(bot.pos);
    bot.group.visible = true;
    const ally = bots.bots.find((b) => b.team === 'ember');
    ally.pos.set(-8, 0, 2);
    ally.group.position.copy(ally.pos);
    aimAt(new THREE.Vector3(-12, 1.3, -4));
    shoot(0);
    settle(2);
    hud.hitMarker(false, 4000);
  } else if (name === 'plant') {
    match.state.phase = 'live';
    match.state.roundTime = 64;
    const site = world.sites.B;
    // South-east of the Kiln: the site beacon, the charge, and the defender
    // are all in the open from here; the old spot stood behind the kiln drum.
    body.position.set(28, 0, -6);
    settle(5);
    aimAt(new THREE.Vector3(site.pos.x, 1.2, site.pos.z));
    const defender = bots.bots.filter((b) => b.team === 'ash')[1];
    defender.pos.set(21, 0, -12);
    defender.group.position.copy(defender.pos);
    defender.yaw = Math.PI / 2;
    defender.group.rotation.y = defender.yaw;
    defender.group.visible = true;
    actionProgress = 0.62;
    hud.setHint('PLANTING… 62% — keep holding E');
    hud.setCharge('PLANT THE CHARGE — HOLD E AT SITE A OR B');
    chargeMesh.position.set(site.pos.x, 0.25, site.pos.z);
    chargeMesh.visible = true;
  } else if (name === 'end') {
    match.state.phase = 'live';
    match.state.roundTime = 41;
    // A match already 11 rounds in: Ember 6 – Ash 5, round 12, and this
    // win makes it 7–5. This is the second half (the sides swapped after
    // round 6), so Ember is DEFENDING here — the staged win is a
    // defensive wipe of the Ash attackers, not a detonation. The
    // scoreboard is seeded with the same staged history as the 6–5 score
    // — fixed numbers, not random per run, and documented here the way
    // the staged score is: the capture stages a match state, it does not
    // play one out. The camera sits north, looking south across the yard,
    // the way a defender sees it.
    match.state.attackerTeam = 'ash';
    match.state.round = 12;
    match.state.scoreEmber = 6;
    match.state.scoreAsh = 5;
    body.position.set(-6, 0, -10);
    settle(10);
    aimAt(new THREE.Vector3(0, 1.5, 10));
    // Seed AFTER the settle: anything the sim accumulated in those 10
    // steps is replaced by the staged history, so the board is exact.
    seedEndStats();
    match.endRound('ember', 'Ash team eliminated');
    hud.setScore(7, 5, 12);
    endRoundFlow();
  }
  hud.setHealth(body.health);
  hud.setTimer(match.state.phase === 'buy' ? match.state.phaseTime : match.state.roundTime, match.state.phase);
  hud.setScore(match.state.scoreEmber, match.state.scoreAsh, match.state.round);
  syncCamera();
  paintTwiceThenReady();
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

syncCamera();
// Minimal test hook for the QA bot playtest (see artifacts/game-progress.md):
// read-only match state, no cheats, no gameplay effect.
window.__sulfur = {
  state() {
    const m = match.state;
    return {
      phase: m.phase, round: m.round, roundTime: Math.round(m.roundTime * 10) / 10,
      attackerTeam: m.attackerTeam, defuseKit: m.defuseKit,
      scoreEmber: m.scoreEmber, scoreAsh: m.scoreAsh, money: m.money,
      player: { x: Math.round(body.position.x * 100) / 100, z: Math.round(body.position.z * 100) / 100, health: Math.round(body.health), armour: Math.round(m.armour * 10) / 10, alive: body.alive },
      emberAlive: bots.aliveCount('ember') + (body.alive ? 1 : 0),
      ashAlive: bots.aliveCount('ash'),
      bots: bots.bots.map((b) => ({ team: b.team, name: b.name, alive: b.alive, hp: Math.round(b.hp), sense: Math.round(b.senseTimer * 10) / 10, enemy: b.visibleEnemy ? (b.visibleEnemy === 'player' ? 'player' : b.visibleEnemy.name) : null, x: Math.round(b.pos.x * 10) / 10, z: Math.round(b.pos.z * 10) / 10, state: b.state, site: b.site || null })),
      charge: m.charge ? { site: m.charge.site, timer: Math.round(m.charge.timer * 10) / 10 } : null,
      smokes: smokes.map((s) => ({ x: Math.round(s.pos.x * 10) / 10, z: Math.round(s.pos.z * 10) / 10, t: Math.round(s.t * 10) / 10 })),
      matchOver: m.matchOver, matchWinner: m.matchWinner,
      audio: audio.status(),
      stats: Object.fromEntries(Object.entries(stats).map(([n, s]) => [n, { ...s }])),
    };
  },
  // QA-only hooks for the automated playtest (see artifacts/game-progress.md).
  // ff() steps the fixed-step simulation without rendering, so a whole round
  // can be driven in a headless browser where SwiftShader renders at a few
  // frames per second. warp/key/fire inject the same input state the real
  // handlers write — they never change game rules, only how input arrives.
  test: {
    ff(seconds) {
      const n = Math.max(0, Math.round(seconds / FIXED_STEP));
      for (let i = 0; i < n; i += 1) step(FIXED_STEP);
      // The renderer refreshes every matrixWorld once per frame in live
      // play, so a raycast in step() always sees fresh positions. ff()
      // steps the sim WITHOUT rendering, so without this the matrices a
      // shot raycasts against are wherever the last real frame left them
      // — in headless (rAF ~1 fps) that is seconds stale, and a staged
      // target dummy reads as a miss even though the aim is dead on
      // (cycle 12: a DMR body shot at a frozen Gravel "missed" until a
      // real frame rendered). Refresh here so ff()-driven shots test
      // the same geometry a player sees.
      scene.updateMatrixWorld(true);
      syncCamera();
      return window.__sulfur.state();
    },
    warp(x, z, yaw) {
      body.position.set(x, 0, z);
      body.velocity.set(0, 0, 0);
      body.yaw = yaw;
      body.pitch = 0;
      syncCamera();
      return window.__sulfur.state();
    },
    key(code, down) {
      if (down) input.state.keys.add(code);
      else input.state.keys.delete(code);
    },
    fire(down) { input.state.firing = down; },
    reload() { weapon.reload(); return window.__sulfur.state(); },
    // Cycle-11 QA staging hooks: they move/place/kill actors through the
    // game's OWN damage and round-end paths (bots.damage,
    // botCtx.onBotKilled, botCtx.damagePlayer, match.buy) — they never
    // change game rules, only let a test stage a state that is hard to
    // reach by chance (a last-alive 1v1, a staged sniper lane, a forced
    // loss streak). Never used by the game itself.
    killBot(name) {
      const bot = bots.bots.find((b) => b.name === name);
      if (bot && bot.alive && bots.damage(bot, 9999, 'QA')) botCtx.onBotKilled('QA', bot.name, bot.team);
      return window.__sulfur.state();
    },
    killPlayer() { botCtx.damagePlayer(9999, 'QA'); return window.__sulfur.state(); },
    placeBot(name, x, z, yaw = 0) {
      const bot = bots.bots.find((b) => b.name === name);
      if (bot) {
        bot.pos.set(x, 0, z);
        bot.yaw = yaw;
        bot.group.position.copy(bot.pos);
        bot.group.rotation.y = yaw;
      }
      return window.__sulfur.state();
    },
    freezeBot(name, on) {
      const bot = bots.bots.find((b) => b.name === name);
      if (bot) bot.frozen = !!on;
      return window.__sulfur.state();
    },
    aim(x, y, z) { aimAt(new THREE.Vector3(x, y, z)); return window.__sulfur.state(); },
    // Cycle-12 QA ray probe: fires the same spread-free camera ray
    // shoot() uses toward a point and reports the first three hits (world
    // material or bot name/part), so a missed shot can be traced to the
    // exact surface that ate it. QA-only; the game never calls it.
    probe(x, y, z) {
      aimAt(new THREE.Vector3(x, y, z));
      // Same matrix freshness as ff(): the probe must test the geometry
      // a live shot would meet, not the last rendered frame's.
      scene.updateMatrixWorld(true);
      camera.getWorldDirection(tmpV);
      raycaster.set(camera.position, tmpV);
      raycaster.far = 140;
      const hits = raycaster.intersectObjects(shootables, false).slice(0, 3).map((h) => ({
        d: Math.round(h.distance * 100) / 100,
        point: [Math.round(h.point.x * 100) / 100, Math.round(h.point.y * 100) / 100, Math.round(h.point.z * 100) / 100],
        what: h.object.userData.bot ? `${h.object.userData.bot.name}/${h.object.userData.part}` : (h.object.material.color ? `#${h.object.material.color.getHexString()}` : 'world'),
      }));
      raycaster.far = 140;
      return { from: [Math.round(camera.position.x * 100) / 100, Math.round(camera.position.y * 100) / 100, Math.round(camera.position.z * 100) / 100], dir: [Math.round(tmpV.x * 1000) / 1000, Math.round(tmpV.y * 1000) / 1000, Math.round(tmpV.z * 1000) / 1000], hits };
    },
    setMoney(n) { match.state.money = n; hud.setMoney(n); return n; },
    buy(id) {
      const res = match.buy(id);
      if (res.ok) {
        if (WEAPONS[id]) { weapon.equip(id); hud.setAmmo(weapon.state.mag, weapon.state.reserve); }
        hud.setWeapon(weapon.def.name, match.state.grenades.frag, match.state.grenades.flash, match.state.grenades.smoke);
        hud.setMoney(match.state.money);
      }
      return res;
    },
  },
};
if (shot) runShot(shot);
else {
  hud.showOverlay('start');
  requestAnimationFrame(frame);
}
