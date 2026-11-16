// Weapons: the catalog, one live instance per holder, and the view model.
// Hitscan numbers live here; main.js owns the ray and the damage. Spread
// grows with movement speed and shrinks when crouched or still, so holding
// an angle beats spraying on the move.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export const WEAPONS = {
  // Catalog in ascending price order — the buy menu reads like a shop:
  // a real upgrade at every budget, from the $800 eco pistol to the
  // $4500 sniper. Each gun owns one role: pistol (free fallback), heavy
  // pistol (round-1 power on a starter budget — two body shots, one
  // headshot, so it beats the free pistol's time-to-kill; cycle 13: at
  // 40 damage it was strictly slower than the P-9, 0.56 s vs 0.48 s),
  // SMG (budget spray), shotgun (close — one shot inside ~10 m; cycle 13:
  // the 0.02 spread let only ~half the pellets land at 10 m, so it took
  // two shots and lost to every other gun at its own range), rifle (mid,
  // auto), DMR (affordable long-range precision — two body shots, one
  // headshot — with a 0.25 s gap so its body TTK beats the rifle at range;
  // cycle 13: at 0.35 s it lost to the rifle's 0.30 s at every hit rate),
  // sniper (max range/damage, one headshot kill).
  pistol: { id: 'pistol', name: 'P-9 Sidearm', price: 0, mag: 12, reserve: 36, damage: 26, headMult: 2, fireGap: 0.16, reloadTime: 1.3, auto: false, spreadStill: 0.003, spreadMove: 0.02, kick: 0.006, sound: 'pistol', range: 60 },
  heavy: { id: 'heavy', name: 'Sulfur-9 Heavy', price: 800, mag: 8, reserve: 24, damage: 50, headMult: 2, fireGap: 0.28, reloadTime: 1.5, auto: false, spreadStill: 0.004, spreadMove: 0.025, kick: 0.012, sound: 'pistol', range: 50 },
  smg: { id: 'smg', name: 'Vesper-9', price: 1500, mag: 28, reserve: 84, damage: 20, headMult: 2, fireGap: 0.07, reloadTime: 1.6, auto: true, spreadStill: 0.004, spreadMove: 0.034, kick: 0.005, sound: 'smg', range: 45 },
  shotgun: { id: 'shotgun', name: 'Duskmore-12', price: 1800, mag: 6, reserve: 24, damage: 13, headMult: 2, fireGap: 0.85, reloadTime: 2.4, auto: false, pellets: 8, spreadStill: 0.014, spreadMove: 0.045, kick: 0.03, sound: 'shotgun', range: 30 },
  rifle: { id: 'rifle', name: 'KR-7 Carbine', price: 2700, mag: 30, reserve: 90, damage: 30, headMult: 2, fireGap: 0.1, reloadTime: 1.9, auto: true, spreadStill: 0.0022, spreadMove: 0.028, kick: 0.009, sound: 'rifle', range: 90 },
  dmr: { id: 'dmr', name: 'Ashfall-7 DMR', price: 3200, mag: 10, reserve: 30, damage: 55, headMult: 2, fireGap: 0.25, reloadTime: 2.2, auto: false, spreadStill: 0.0008, spreadMove: 0.05, kick: 0.03, sound: 'dmr', range: 110 },
  sniper: { id: 'sniper', name: 'Longshadow-88', price: 4500, mag: 5, reserve: 15, damage: 95, headMult: 2, fireGap: 1.4, reloadTime: 2.8, auto: false, spreadStill: 0.0006, spreadMove: 0.06, kick: 0.05, sound: 'sniper', range: 120 },
};

export const GRENADES = {
  frag: { id: 'frag', name: 'Frag Grenade', price: 300 },
  flash: { id: 'flash', name: 'Flash Grenade', price: 200 },
  smoke: { id: 'smoke', name: 'Smoke Grenade', price: 300 },
};

// Buyable gear that is not a weapon: armour absorbs half of incoming
// damage until it is depleted, and persists across rounds like the owned
// weapon (it is only lost on a new match). The defuse kit halves the
// player's hold-E defuse time (5 s -> 2.5 s); it only earns its keep
// after the halftime swap, when the player defends — a kit bought in
// half 1 is a pre-buy for half 2, exactly like armour bought early.
export const GEAR = {
  armour: { id: 'armour', name: 'Plate Armour', price: 650 },
  defusekit: { id: 'defusekit', name: 'Defuse Kit', price: 400 },
};

const MUZZLE_TIME = 0.06;

export function createWeapon(camera, defId = 'pistol') {
  // View-model materials (cycle 12): the yard has no environment map, so
  // metalness makes a gun render near-black — the P-9 was invisible in the
  // play shot, a bare crosshair over dark ground. Near-zero metalness plus
  // a faint emissive of the same colour keeps the gun readable as a
  // dark-grey shape in the dusk light without glowing.
  const gripMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.steelDark), roughness: 0.7, metalness: 0.05, emissive: new THREE.Color(PALETTE.steelDark), emissiveIntensity: 0.3 });
  const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.steel), roughness: 0.5, metalness: 0.05, emissive: new THREE.Color(PALETTE.steel), emissiveIntensity: 0.3 });
  const accentMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.rust), roughness: 0.6, metalness: 0.05, emissive: new THREE.Color(PALETTE.rust), emissiveIntensity: 0.3 });

  const model = new THREE.Group();
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.1, 0.1),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }),
  );
  const flashLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 5);
  camera.add(model, flash, flashLight);

  let def = WEAPONS[defId];
  const state = { mag: def.mag, reserve: def.reserve, cooldown: 0, reloadLeft: 0, flash: 0, kick: 0 };

  function buildModel() {
    while (model.children.length) model.remove(model.children[0]);
    const long = def.id === 'rifle' || def.id === 'sniper' || def.id === 'dmr';
    const wide = def.id === 'shotgun';
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(wide ? 0.11 : 0.09, 0.1, long ? 0.5 : 0.34), bodyMat);
    const barrelLen = def.id === 'sniper' ? 0.62 : def.id === 'dmr' ? 0.52 : def.id === 'shotgun' ? 0.5 : 0.38;
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, barrelLen), gripMat);
    barrel.position.set(0, 0.025, -0.2 - barrelLen / 2 + 0.15);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.08, 0.2), gripMat);
    stock.position.set(0, -0.02, 0.26);
    model.add(receiver, barrel, stock);
    if (def.id === 'sniper' || def.id === 'dmr') {
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 10), accentMat);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, 0.09, -0.05);
      model.add(scope);
    }
    if (def.id === 'shotgun') {
      const pump = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.2), accentMat);
      pump.position.set(0, -0.02, -0.3);
      model.add(pump);
    }
    model.position.set(0.24, -0.2, -0.42);
    // Flash sits well past the muzzle: a plane this close to the camera
    // subtends a huge angle, so it stays small and reads as a star.
    flash.position.set(0.24, -0.18, -0.42 - barrelLen - 0.55);
    flash.rotation.z = Math.PI / 4;
    flashLight.position.set(0.24, -0.16, -0.7);
  }
  buildModel();

  function step(dt) {
    state.cooldown = Math.max(0, state.cooldown - dt);
    state.flash = Math.max(0, state.flash - dt);
    state.kick += (0 - state.kick) * Math.min(1, dt * 14);
    model.position.z = -0.42 + state.kick;
    model.rotation.x = state.kick * 2.2;
    flash.visible = state.flash > 0;
    flashLight.intensity = state.flash > 0 ? 8 : 0;
    if (state.reloadLeft > 0) {
      state.reloadLeft = Math.max(0, state.reloadLeft - dt);
      model.rotation.x = -0.55 * Math.min(1, (def.reloadTime - state.reloadLeft) * 2);
      if (state.reloadLeft === 0) {
        const need = def.mag - state.mag;
        const take = Math.min(need, state.reserve);
        state.mag += take;
        state.reserve -= take;
      }
    }
  }

  return {
    state,
    get def() { return def; },
    step,
    ready() { return state.mag > 0 && state.cooldown === 0 && state.reloadLeft === 0; },
    pullTrigger() { state.cooldown = def.fireGap; state.flash = MUZZLE_TIME; state.kick = def.id === 'sniper' ? 0.09 : def.id === 'shotgun' ? 0.08 : 0.05; },
    takeRound() { if (state.mag <= 0) return false; state.mag -= 1; return true; },
    reload() {
      if (state.reloadLeft > 0 || state.mag === def.mag || state.reserve === 0) return false;
      state.reloadLeft = def.reloadTime;
      return true;
    },
    spread(speed, crouched) {
      const move = Math.min(1, speed / 5.4);
      let s = def.spreadStill + move * def.spreadMove;
      if (crouched) s *= 0.6;
      return s;
    },
    equip(defId) {
      def = WEAPONS[defId];
      state.mag = def.mag;
      state.reserve = def.reserve;
      state.cooldown = 0;
      state.reloadLeft = 0;
      buildModel();
    },
    refillReserve() { state.reserve = def.reserve; },
  };
}
