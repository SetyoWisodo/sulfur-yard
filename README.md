# Sulfur Yard — a three.js tactical FPS

[![make.fun · threejs-fps-02](https://make.fun/badge/threejs-fps-02.svg)](https://make.fun/bounty/threejs-fps-02?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)
[![rank](https://make.fun/badge/threejs-fps-02/SetyoWisodo/sulfur-yard/rank.svg)](https://make.fun/bounty/threejs-fps-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)
[![reward](https://make.fun/badge/threejs-fps-02/SetyoWisodo/sulfur-yard/reward.svg)](https://make.fun/bounty/threejs-fps-02?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-02)

A round-based tactical FPS in a sulfur-mining yard at dusk. **Ember** (you + 4 bots) vs **Ash** (5 bots). Ember attacks first: plant the charge at Site A **Crusher** or Site B **Kiln**, defend it until it detonates — or eliminate the other team. After round 6 the sides swap and **Ash** attacks while **you defend** — hold E near a planted charge to defuse it. First to 7 rounds (max 13) takes the yard.

## How to run

```sh
node serve.ts
```

Then open http://localhost:8080 and click to play (pointer lock). No build step, no network requests, no audio files — all sounds are synthesized with WebAudio.

## Controls

- **WASD** move, **mouse** look, **click** fire
- **R** reload, **Ctrl/C** crouch, **B** buy menu (buy phase only, number keys 1–9 then 0, **K** defuse kit)
- **E** (hold) plant the charge at a site (attacking) or defuse a planted charge (defending), **G** frag grenade, **F** flash grenade, **V** smoke grenade, **M** mute

## The game

- **Map:** 64 × 48 m yard with three lanes (west / mid / east), a conveyor spine, silo row, crusher housing, kiln drum, crates, pipe runs, sulfur piles, ore carts, barrels and hazard striping — all low-poly geometry built in code.
- **Gunplay:** hitscan raycasts, per-part hitboxes (legs ×0.8, torso ×1, head ×2), recoil, and spread that grows with movement speed and shrinks when crouched or still. Tracers, muzzle flash, impact sparks.
- **Weapons:** P-9 Sidearm (free), Sulfur-9 Heavy $800, Vesper-9 SMG $1500, Duskmore-12 Shotgun $1800, KR-7 Carbine $2700, Ashfall-7 DMR $3200, Longshadow-88 Sniper $4500; Plate Armour $650 (absorbs half of incoming damage); Frag $300, Flash $200, Smoke $300 (blocks bot line of sight); Defuse Kit $400 (halves the player's hold-E defuse time, 5 s → 2.5 s — it only matters after the halftime swap, when the player defends). Buy menu shows Owned and Too expensive states.
- **Economy:** start $800, round win $3250, loss $1900, kill $300, plant $300, wallet capped at $16000. Dying loses your bought weapon — the next round opens on the free P-9, so a lost $4500 sniper has to be re-bought. 15 s buy phase, 100 s rounds, 35 s charge timer.
- **Bots:** waypoint navigation with BFS routing, line-of-sight checks, burst fire, hold angles, sound alerts (gunfire draws nearby bots), attackers plant, defenders rotate to a planted site and defuse. At halftime the roles swap: the team that attacked now defends, and the player with it.
- **Presentation:** live minimap, radio callouts from your own team, end-of-match scoreboard (K/D, headshot %, damage), synthesized footsteps, ambient yard hum and wind, round-start sting.
- **Deterministic screenshots:** `?shot=start|play|plant|end&seed=1` renders a fixed frame and sets `window.__shotReady`.

## Layout

- `game/index.html` — import map + HUD DOM
- `game/src/` — one module per job: `main` (boot + fixed 60 Hz loop), `world`, `player`, `bots`, `weapons`, `rounds` (match state + economy), `hud`, `audio` (synthesized), `effects` (pooled tracers/sparks/explosions), `input`, `palette`, `rng`
- `game/vendor/three/` — three.js 0.187.0 (vendored)
- `main.ts` — builds the submission dossier into `MAKEFUN_OUTPUT_DIR` (or `/output`)

## License

MIT — see LICENSE.
