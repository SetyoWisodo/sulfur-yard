// Match state in one place: rounds, phases, economy, the charge, and the
// kill feed. main.js reads this every frame and pushes it to the HUD; the
// rules themselves (who wins a round, what it pays) live here and nowhere else.
import { WEAPONS, GRENADES, GEAR } from './weapons.js';

export const WIN_ROUNDS = 7;
export const HALFTIME_ROUND = 7; // rounds 1-6: Ember attacks; round 7+: sides swap, Ash attacks
export const BUY_SECONDS = 15;
export const ROUND_SECONDS = 100;
export const CHARGE_SECONDS = 35;
export const REWARDS = { win: 3250, loss: 1900, kill: 300, plant: 300 };
// A match's wallet tops out here (Counter-Strike caps at $16000 the same
// way): after ~3 wins the player can already afford the dearest loadout
// every round, so an uncapped wallet just grows into a meaningless number
// across a 13-round match. The old $9999 cap bound by round 5–7 in EVERY
// trace (win streak, losing match, balanced — cycle 13), so the economy
// was dead for the second half of the match; $16000 keeps decisions alive
// longer, and the death penalty below is what actually drains the wallet.
export const MAX_MONEY = 16000;

export function createMatch() {
  const state = {
    round: 1,
    scoreEmber: 0,
    scoreAsh: 0,
    phase: 'buy', // buy | live | over
    phaseTime: BUY_SECONDS,
    roundTime: ROUND_SECONDS,
    money: 800,
    kills: 0,
    deaths: 0,
    charge: null, // { site, timer, plantedBy } once planted
    chargeSite: null,
    matchOver: false,
    matchWinner: null,
    lastResult: null, // { winner, reason }
    grenades: { frag: 0, flash: 0, smoke: 0 },
    armour: 0, // 0..100, absorbs half of incoming damage; persists across rounds
    defuseKit: false, // owned; halves the player's hold-E defuse time; persists across rounds like armour
    ownedWeapon: 'pistol',
    attackerTeam: 'ember', // half 1: Ember attacks; after the halftime swap (round 7) Ash attacks
  };
  const feed = [];

  function defenderTeam() { return state.attackerTeam === 'ember' ? 'ash' : 'ember'; }

  function addMoney(n) { state.money = Math.min(MAX_MONEY, state.money + n); }

  function swapSides() {
    state.attackerTeam = defenderTeam();
  }

  function resetRound() {
    state.phase = 'buy';
    state.phaseTime = BUY_SECONDS;
    state.roundTime = ROUND_SECONDS;
    state.charge = null;
    state.chargeSite = null;
    state.lastResult = null;
  }

  function endRound(winner, reason) {
    if (state.phase === 'over') return;
    state.phase = 'over';
    state.phaseTime = 3.5;
    state.lastResult = { winner, reason };
    if (winner === 'ember') {
      state.scoreEmber += 1;
      addMoney(REWARDS.win);
    } else {
      state.scoreAsh += 1;
      addMoney(REWARDS.loss);
    }
    if (state.scoreEmber >= WIN_ROUNDS) { state.matchOver = true; state.matchWinner = 'ember'; }
    else if (state.scoreAsh >= WIN_ROUNDS) { state.matchOver = true; state.matchWinner = 'ash'; }
  }

  function nextRound() {
    if (state.matchOver) return false;
    state.round += 1;
    resetRound();
    return true;
  }

  function buy(id) {
    const def = WEAPONS[id] || GRENADES[id] || GEAR[id];
    if (!def) return { ok: false, why: 'unknown item' };
    if (state.phase !== 'buy') return { ok: false, why: 'buy phase is over' };
    if (state.money < def.price) return { ok: false, why: 'not enough money' };
    if (id === 'frag' || id === 'flash' || id === 'smoke') {
      if (state.grenades[id] >= 2) return { ok: false, why: 'already carrying 2' };
      state.grenades[id] += 1;
    } else if (id === 'armour') {
      if (state.armour >= 100) return { ok: false, why: 'armour already full' };
      state.armour = 100;
    } else if (id === 'defusekit') {
      if (state.defuseKit) return { ok: false, why: 'defuse kit already owned' };
      state.defuseKit = true;
    } else {
      state.ownedWeapon = id;
    }
    state.money -= def.price;
    return { ok: true, name: def.name, price: def.price };
  }

  function addKillReward() { addMoney(REWARDS.kill); state.kills += 1; }
  function addPlantReward() { addMoney(REWARDS.plant); }

  function addFeed(text, kind = 'info') {
    feed.push({ text, kind, t: Date.now() });
    if (feed.length > 6) feed.shift();
  }

  function step(dt) {
    if (state.phase === 'buy') {
      state.phaseTime -= dt;
      if (state.phaseTime <= 0) { state.phase = 'live'; state.roundTime = ROUND_SECONDS; }
    } else if (state.phase === 'live') {
      state.roundTime -= dt;
      if (state.charge) {
        state.charge.timer -= dt;
        // A live charge detonates for whoever planted it: the attackers.
        if (state.charge.timer <= 0) endRound(state.attackerTeam, 'charge detonated');
      } else if (state.roundTime <= 0) {
        // No plant by the clock: the defenders held the yard.
        endRound(defenderTeam(), `time expired — ${defenderTeam() === 'ember' ? 'Ember' : 'Ash'} holds the yard`);
      }
    } else if (state.phase === 'over') {
      state.phaseTime -= dt;
    }
  }

  return {
    state,
    feed,
    step,
    endRound,
    nextRound,
    resetRound,
    swapSides,
    buy,
    addKillReward,
    addPlantReward,
    addFeed,
  };
}
