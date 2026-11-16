// Bots: 4 Ember allies and 5 Ash defenders. Each bot is a small state
// machine — advance along the waypoint graph, hold an angle, plant, rotate,
// defuse — driven by line-of-sight checks and by sound (gunfire alerts
// nearby bots). Bots shoot in bursts with distance-based accuracy and can
// be headshot. No per-frame allocation: reused vectors and a staggered
// sense tick (each bot re-checks sight every ~0.2 s).
//
// Roles, not teams, decide behaviour (cycle 12, halftime side-swap):
// the ATTACKING team pushes the sites and plants, the DEFENDING team
// holds angles, rotates to a planted charge, and defuses. Which team
// attacks flips at halftime (round 7) — Ember attacks first, Ash second —
// while team names, colours, and rosters never change. reset() is the
// only place the current attacker is set, so it can never drift from
// the match state.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { pick } from './rng.js';

const BOT_SPEED = 3.3;
const BOT_RADIUS = 0.34;
const BOT_HEIGHT = 1.7;
const SIGHT_RANGE = 42;
const PLANT_TIME = 4;
const DEFUSE_TIME = 5;

function bfsPath(adjacency, from, to) {
  if (from === to) return [to];
  const prev = new Array(adjacency.length).fill(-1);
  const queue = [from];
  prev[from] = from;
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adjacency[cur]) {
      if (prev[next] !== -1) continue;
      prev[next] = cur;
      if (next === to) {
        const path = [to];
        let n = to;
        while (n !== from) { n = prev[n]; path.unshift(n); }
        return path;
      }
      queue.push(next);
    }
  }
  return [to];
}

export function createBots(scene, world, rng) {
  const emberMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ember), roughness: 0.8 });
  const ashMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ash), roughness: 0.8 });
  const darkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.steelDark), roughness: 0.8 });
  const bots = [];
  const hitMeshes = [];
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const eye = new THREE.Vector3();
  let attackerTeam = 'ember'; // set by reset() every round from the match state

  function makeBot(team, index, name) {
    const group = new THREE.Group();
    const mat = team === 'ember' ? emberMat : ashMat;
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.05, 0.34), mat);
    body.position.y = 0.85;
    body.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), darkMat);
    head.position.y = 1.58;
    head.castShadow = true;
    // Legs (cycle 11, per-part hitboxes): a narrow dark lower body, so a
    // shot below the torso (y < 0.325) is a real leg hit at x0.8 instead
    // of passing through empty air under a floating torso. The torso is
    // wider and its front face is closer, so from the front a ray in the
    // overlap band still meets the torso first — the split is clean.
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.7, 0.24), darkMat);
    legs.position.y = 0.35;
    legs.castShadow = true;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.07, 0.05), new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.lamp), emissive: new THREE.Color(PALETTE.lamp), emissiveIntensity: 0.8 }));
    visor.position.set(0, 1.6, 0.16);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.7), darkMat);
    gun.position.set(0.25, 1.05, -0.3);
    group.add(body, head, visor, gun, legs);
    scene.add(group);
    const bot = {
      team, index, name,
      group, body, head,
      pos: new THREE.Vector3(),
      yaw: 0, hp: 100, alive: true, frozen: false, // frozen: QA staging (cycle 11) — a frozen bot stands still as a target dummy
      targetNode: 0, path: [], pathIdx: 0,
      state: 'advance', // advance | hold | plant | defuse | rotate | hunt
      holdTimer: 0, senseTimer: rng() * 0.2, fireTimer: 0, burstLeft: 0,
      actionTimer: 0, actionSite: null, visibleEnemy: null, visibleEnemyPos: new THREE.Vector3(),
      alertPos: new THREE.Vector3(), alertTimer: 0, speed: BOT_SPEED,
      lastDist: Infinity, stuckTimer: 0, detourPos: new THREE.Vector3(), detourTimer: 0, detourSide: 1,
    };
    body.userData.bot = bot;
    body.userData.part = 'body';
    head.userData.bot = bot;
    head.userData.part = 'head';
    legs.userData.bot = bot;
    legs.userData.part = 'legs';
    hitMeshes.push(body, head, legs);
    bots.push(bot);
    return bot;
  }

  const emberNames = ['Cinder', 'Soot', 'Flint', 'Pumice'];
  const ashNames = ['Dusk', 'Slag', 'Cinder-2', 'Basalt', 'Gravel'];
  for (let i = 0; i < 4; i += 1) makeBot('ember', i, emberNames[i]);
  for (let i = 0; i < 5; i += 1) makeBot('ash', i, ashNames[i]);

  // Nearest waypoint with a WALKABLE straight segment from pos. Plain
  // nearest-by-distance can name a node on the far side of a wall (the old
  // west Ash spawn's nearest node sat behind the crusher housing), and a bot
  // that can only push at that wall never arrives. Sampling the segment with
  // the same box test the bot moves with keeps the first hop honest; if no
  // node is reachable (should not happen), fall back to plain nearest.
  function segmentClear(ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / 0.4));
    for (let i = 0; i <= steps; i += 1) {
      if (overlaps(ax + (dx * i) / steps, az + (dz * i) / steps)) return false;
    }
    return true;
  }

  function nearestNode(pos) {
    let best = 0;
    let bestD = Infinity;
    let fallback = 0;
    let fallbackD = Infinity;
    for (let i = 0; i < world.nodes.length; i += 1) {
      const d = world.nodes[i].distanceToSquared(pos);
      if (d < fallbackD) { fallbackD = d; fallback = i; }
      if (d < bestD && segmentClear(pos.x, pos.z, world.nodes[i].x, world.nodes[i].z)) {
        bestD = d;
        best = i;
      }
    }
    return bestD === Infinity ? fallback : best;
  }

  function setPath(bot, node) {
    bot.targetNode = node;
    bot.path = bfsPath(world.adjacency, nearestNode(bot.pos), node);
    bot.pathIdx = 0;
    bot.lastDist = Infinity;
    bot.stuckTimer = 0;
    bot.detourTimer = 0;
  }

  function overlaps(x, z) {
    // Horizontal overlap plus a real vertical test: the floor (top at y=0)
    // must not block, but any solid rising above the feet does.
    for (const c of world.colliders) {
      if (x + BOT_RADIUS > c.min.x && x - BOT_RADIUS < c.max.x
        && z + BOT_RADIUS > c.min.z && z - BOT_RADIUS < c.max.z
        && c.min.y < BOT_HEIGHT && c.max.y > 0.1) return true;
    }
    return false;
  }

  function moveBot(bot, dt, tx, tz) {
    tmp.set(tx - bot.pos.x, 0, tz - bot.pos.z);
    const dist = tmp.length();
    if (dist < 0.05) return true;
    tmp.normalize();
    const stepLen = bot.speed * dt;
    const nx = bot.pos.x + tmp.x * stepLen;
    const nz = bot.pos.z + tmp.z * stepLen;
    if (!overlaps(nx, bot.pos.z)) bot.pos.x = nx;
    if (!overlaps(bot.pos.x, nz)) bot.pos.z = nz;
    bot.yaw = Math.atan2(tmp.x, tmp.z);
    return dist <= stepLen + 0.05;
  }

  function reset(round, attackingTeam = 'ember') {
    attackerTeam = attackingTeam;
    const siteChoice = rng() < 0.5 ? 'A' : 'B';
    // Attackers spawn south and push the sites; defenders spawn north and
    // hold them. The spawn rows are keyed by ROLE, not by team name, so
    // after the halftime swap the Ash attackers come up from the south
    // and the Ember defenders hold the north — the map's geometry (sites
    // in the north) never changes, only who pushes it.
    const attackers = bots.filter((b) => b.team === attackerTeam);
    const defenders = bots.filter((b) => b.team !== attackerTeam);
    attackers.forEach((bot, i) => {
      const spawn = world.spawns.ember[i];
      bot.pos.set(spawn.x, 0, spawn.z);
      bot.hp = 100; bot.alive = true; bot.frozen = false;
      bot.group.visible = true;
      bot.state = 'advance';
      bot.actionTimer = 0; bot.actionSite = null; bot.visibleEnemy = null;
      bot.alertTimer = 0;
      // Split: two bots to the chosen site, the rest to the other, so both sites get pressure.
      const site = (i < 2) === (siteChoice === 'A') ? 'A' : 'B';
      bot.site = site;
      setPath(bot, world.sites[site].node);
    });
    defenders.forEach((bot, i) => {
      const spawn = world.spawns.ash[i];
      bot.pos.set(spawn.x, 0, spawn.z);
      bot.hp = 100; bot.alive = true; bot.frozen = false;
      bot.group.visible = true;
      bot.state = 'hold';
      bot.actionTimer = 0; bot.actionSite = null; bot.visibleEnemy = null;
      bot.alertTimer = 0;
      // Defenders: two hold A, two hold B, one floats mid.
      bot.site = i < 2 ? 'A' : i < 4 ? 'B' : null;
      bot.holdNode = bot.site ? world.sites[bot.site].node : 8;
      setPath(bot, bot.holdNode);
      bot.state = 'advance';
    });
    void round;
  }

  function damage(bot, amount, killerName) {
    if (!bot.alive) return false;
    bot.hp -= amount;
    if (bot.hp <= 0) {
      bot.hp = 0;
      bot.alive = false;
      bot.group.visible = false;
      return true;
    }
    return false;
  }

  function alert(pos, radius) {
    for (const bot of bots) {
      if (!bot.alive) continue;
      if (bot.pos.distanceTo(pos) < radius) {
        bot.alertPos.copy(pos); // reused vector: no allocation per alerted bot
        bot.alertTimer = 3;
      }
    }
  }

  function step(dt, ctx) {
    for (const bot of bots) {
      if (!bot.alive) continue;
      // QA staging (cycle 11): a frozen bot stands still as a target dummy —
      // it neither moves, senses, nor shoots, but stays alive and shootable.
      if (bot.frozen) {
        bot.group.position.set(bot.pos.x, bot.pos.y, bot.pos.z);
        bot.group.rotation.y = bot.yaw;
        continue;
      }
      bot.senseTimer -= dt;
      bot.fireTimer -= dt;
      bot.alertTimer -= dt;
      // --- Sense (staggered): find the nearest visible enemy.
      if (bot.senseTimer <= 0) {
        bot.senseTimer = 0.18 + rng() * 0.08;
        const hadEnemy = bot.visibleEnemy;
        bot.visibleEnemy = null;
        eye.set(bot.pos.x, bot.pos.y + 1.55, bot.pos.z);
        let bestD = SIGHT_RANGE;
        // Player is an enemy for Ash bots. The player is always Ember, so
        // Ash is the enemy team in both halves — even after the halftime
        // swap, when Ash attacks and the player defends.
        if (bot.team === 'ash' && ctx.playerAlive) {
          tmp2.set(ctx.playerPos.x, ctx.playerPos.y + 1.3, ctx.playerPos.z);
          const d = eye.distanceTo(tmp2);
          if (d < bestD && ctx.hasLOS(eye, tmp2)) {
            bestD = d;
            bot.visibleEnemy = 'player';
            bot.visibleEnemyPos.copy(tmp2);
          }
        }
        // Enemy bots.
        for (const other of bots) {
          if (!other.alive || other.team === bot.team) continue;
          tmp2.set(other.pos.x, other.pos.y + 1.3, other.pos.z);
          const d = eye.distanceTo(tmp2);
          if (d < bestD && ctx.hasLOS(eye, tmp2)) {
            bestD = d;
            bot.visibleEnemy = other;
            bot.visibleEnemyPos.copy(tmp2);
          }
        }
        // Attackers keep pushing while they fight. Forcing an attacker bot to
        // hold every time it glimpsed a defender stranded the push in the
        // open mid-lane, where two holding defenders killed it before it
        // reached the site (cycle 6: 0 plants in 11 rounds, the carrier
        // dying at the same spot every round; the non-carriers random-walked
        // on the hold-drift and died near spawn). Bots shoot on the move —
        // the combat block below is state-independent — so the push still
        // trades fire, it just closes distance instead of duelling from the
        // open. Defenders still stop and hold their angle on sight.
        if (bot.visibleEnemy && bot.team !== attackerTeam) bot.state = bot.state === 'plant' || bot.state === 'defuse' ? bot.state : 'hold';
        // Radio: a first sighting is a callout, not a stream — the edge
        // (null -> enemy) fires once per engagement, and main.js throttles
        // the channel globally.
        if (bot.visibleEnemy && !hadEnemy) ctx.onContact(bot);
      }

      // --- Combat: burst fire at the visible enemy. Live phase ONLY
      // (cycle 11): the buy phase is setup, not combat — before this gate
      // the bots fought freely for the whole 15 s buy phase (diagnostic:
      // after 14 s of buy, Cinder 40 hp, Slag 44, Basalt 54, Flint 53 —
      // the round was half-decided before live play began, while the
      // player's own shooting was already gated to live). Movement and
      // sensing still run during buy (bots pre-position), only the
      // trigger is held.
      if (bot.visibleEnemy && ctx.phase === 'live') {
        const target = bot.visibleEnemy === 'player' ? ctx.playerPos : bot.visibleEnemy.pos;
        tmp.set(target.x - bot.pos.x, 0, target.z - bot.pos.z);
        bot.yaw = Math.atan2(tmp.x, tmp.z);
        const dist = eye.distanceTo(bot.visibleEnemyPos);
        if (bot.fireTimer <= 0) {
          if (bot.burstLeft <= 0) { bot.burstLeft = 2 + Math.floor(rng() * 3); bot.fireTimer = 0.7 + rng() * 0.6; }
          else {
            bot.burstLeft -= 1;
            bot.fireTimer = 0.13;
            // Tuned so a push can survive the approach: accuracy falls off
            // with distance and bursts breathe between volleys. (Cycle 2:
            // the first tuning let Ash wipe Ember in ~20 s and no charge
            // was ever planted.)
            const hitChance = Math.max(0.10, 0.45 - dist / 100) * (bot.visibleEnemy === 'player' && ctx.playerCrouching ? 0.8 : 1);
            ctx.botShot(bot, bot.visibleEnemyPos, dist);
            if (rng() < hitChance) {
              const dmg = 6 + rng() * 6;
              const head = rng() < 0.06;
              const dealt = dmg * (head ? 2 : 1);
              if (bot.visibleEnemy === 'player') ctx.damagePlayer(dealt, bot.name);
              else {
                // Scoreboard stats (cycle 11): damage dealt and headshot
                // kills, tracked for every combatant, not just the player.
                ctx.onBotDamage(bot, dealt);
                if (damage(bot.visibleEnemy, dealt, bot.name)) {
                  ctx.onBotKilled(bot.name, bot.visibleEnemy.name, bot.visibleEnemy.team, head);
                }
              }
            }
          }
        }
      }

      // --- Objective actions.
      if (bot.state === 'plant' || bot.state === 'defuse') {
        bot.actionTimer -= dt;
        if (bot.actionTimer <= 0) {
          if (bot.state === 'plant') ctx.onPlantDone(bot);
          else ctx.onDefuseDone(bot);
          bot.state = 'hold';
        }
        continue;
      }

      // --- Movement by state.
      if (bot.state === 'advance' || bot.state === 'rotate') {
        const node = world.nodes[bot.path[bot.pathIdx]];
        if (!node) { bot.state = 'hold'; bot.holdTimer = 1; }
        else if (bot.detourTimer > 0) {
          // Sidestepping around whatever blocked the direct line.
          bot.detourTimer -= dt;
          if (moveBot(bot, dt, bot.detourPos.x, bot.detourPos.z)) bot.detourTimer = 0;
        } else {
          // Stuck detection: if the bot stops closing on its node, sidestep
          // perpendicular to the desired direction for a moment, then retry.
          // (The graph edges are hand-checked clear, but a corner clip or a
          // firefight sidestep can still wedge a bot against a crate.)
          const d = Math.hypot(node.x - bot.pos.x, node.z - bot.pos.z);
          if (d < bot.lastDist - 0.02) { bot.lastDist = d; bot.stuckTimer = 0; }
          else {
            bot.stuckTimer += dt;
            if (bot.stuckTimer > 1.5) {
              bot.stuckTimer = 0;
              bot.lastDist = d;
              const dx = node.x - bot.pos.x;
              const dz = node.z - bot.pos.z;
              const len = Math.hypot(dx, dz) || 1;
              bot.detourSide = -bot.detourSide;
              bot.detourPos.set(bot.pos.x + (-dz / len) * 1.8 * bot.detourSide, 0, bot.pos.z + (dx / len) * 1.8 * bot.detourSide);
              bot.detourTimer = 1.2;
            }
          }
          if (moveBot(bot, dt, node.x, node.z)) {
            bot.pathIdx += 1;
            bot.lastDist = Infinity;
            bot.stuckTimer = 0;
            if (bot.pathIdx >= bot.path.length) {
            if (bot.team === attackerTeam && bot.site && ctx.phase === 'live' && !ctx.chargePlanted) {
              // Reached the site: plant if this bot is the carrier and the site is clear.
              const site = world.sites[bot.site];
              if (bot.pos.distanceTo(site.pos) < 5 && ctx.isCarrier(bot)) {
                bot.state = 'plant';
                bot.actionTimer = PLANT_TIME;
                bot.actionSite = bot.site;
                ctx.onPlantStart(bot, bot.site);
              } else { bot.state = 'hold'; bot.holdTimer = 2 + rng() * 2; }
            } else if (bot.team !== attackerTeam && ctx.chargePlanted && ctx.chargeSite) {
              // Defuse only from the planted site. The old code let any Ash
              // bot whose path ended anywhere start "defusing" from across
              // the map (cycle 6: Dusk "defused" from (0,-16), ~20 m from
              // the charge). A bot that arrives elsewhere keeps rotating
              // to the site instead.
              const site = world.sites[ctx.chargeSite];
              if (site && bot.pos.distanceTo(site.pos) < 4) {
                bot.state = 'defuse';
                bot.actionTimer = DEFUSE_TIME;
                bot.actionSite = ctx.chargeSite;
                ctx.onDefuseStart(bot);
              } else if (site) {
                setPath(bot, site.node);
                bot.state = 'rotate';
              } else { bot.state = 'hold'; bot.holdTimer = 1.5 + rng() * 2.5; }
            } else { bot.state = 'hold'; bot.holdTimer = 1.5 + rng() * 2.5; }
          }
        }
      }
      } else if (bot.state === 'hold') {
        bot.holdTimer -= dt;
        // Alerted bots investigate the noise; defenders rotate to a planted charge.
        if (ctx.chargePlanted && bot.team !== attackerTeam && ctx.chargeSite) {
          // Don't re-path if the bot is already rotating to this site
          // (cycle 14): setPath recomputes from nearestNode, which can be
          // the node BEHIND the bot, and the sense tick re-paths on every
          // sighting (~5x/second while an enemy is visible) — the bot then
          // oscillates around the node and never reaches the site
          // (defenders stuck 20+ s at the north-row nodes while rotating,
          // caught by the cycle-14b anchor detector). Only re-path when
          // the destination changed or the bot has no path left; the state
          // flip to 'rotate' is free and happens every time.
          const siteNode = world.sites[ctx.chargeSite].node;
          if (bot.targetNode !== siteNode || bot.pathIdx >= bot.path.length) {
            setPath(bot, siteNode);
          }
          bot.state = 'rotate';
          ctx.onRotate(bot, ctx.chargeSite);
        } else if (bot.team === attackerTeam && ctx.phase === 'live' && !ctx.chargePlanted && ctx.isCarrier(bot)) {
          // The carrier never gives up the plant: if it arrived during the
          // buy phase it sat in hold — re-path to its site and plant on arrival.
          const site = world.sites[bot.site];
          if (site && bot.pos.distanceTo(site.pos) < 5) {
            bot.state = 'plant';
            bot.actionTimer = PLANT_TIME;
            bot.actionSite = bot.site;
            ctx.onPlantStart(bot, bot.site);
          } else if (site) {
            setPath(bot, site.node);
            bot.state = 'advance';
          }
        } else if (bot.alertTimer > 0) {
          const n = nearestNode(bot.alertPos);
          if (n !== nearestNode(bot.pos)) { setPath(bot, n); bot.state = 'advance'; bot.alertTimer = 0; }
        } else if (bot.holdTimer <= 0) {
          // Drift to a nearby waypoint to vary the angle — but ONLY if
          // the bot actually arrived (path complete). A defender flipped
          // to 'hold' mid-path by a sighting must RESUME its path, not
          // drift to a random neighbour: the drift hijacked defenders
          // that glimpsed an enemy (even at 40 m, even during buy) and
          // they random-walked the north row instead of holding their
          // assigned site (cycle 14: lone Basalt never reached its hold
          // node in 45 s of diagnostic — it drifted 16<->17<->19 the whole
          // round). Resuming keeps the purposeful path; the drift still
          // fires once the bot arrives and holds.
          if (bot.pathIdx >= bot.path.length) {
            const near = world.adjacency[nearestNode(bot.pos)];
            if (near.length) { setPath(bot, pick(rng, near)); bot.state = 'advance'; }
            bot.holdTimer = 2 + rng() * 3;
          } else {
            bot.state = 'advance';
          }
        }
      }

      bot.group.position.set(bot.pos.x, bot.pos.y, bot.pos.z);
      bot.group.rotation.y = bot.yaw;
    }
  }

  return {
    bots,
    hitMeshes,
    reset,
    step,
    damage,
    alert,
    aliveCount(team) { return bots.filter((b) => b.team === team && b.alive).length; },
    carrier() {
      // The carrier is the first alive ATTACKER — Ember in half 1, Ash in
      // half 2 — because the carrier is the bot that plants.
      const attackers = bots.filter((b) => b.team === attackerTeam && b.alive);
      return attackers[0] || null;
    },
  };
}
