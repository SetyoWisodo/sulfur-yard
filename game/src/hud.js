// The DOM HUD: crosshair, hitmarker, health, ammo, timer, score, money,
// kill feed, buy menu, round overlays, charge status. It never touches the
// simulation; main.js pushes numbers in and reads callbacks out. Values are
// only written when they change, so the DOM stays quiet during play.
import { WEAPONS, GRENADES, GEAR } from './weapons.js';

export function createHud() {
  const $ = (id) => document.getElementById(id);
  const overlay = $('overlay');
  const overlayTitle = $('overlay-title');
  const overlayCopy = $('overlay-copy');
  const playBtn = $('play');
  const ammoMag = $('ammo-mag');
  const ammoReserve = $('ammo-reserve');
  const ammoBox = $('ammo');
  const healthValue = $('health-value');
  const armourValue = $('armour-value');
  const healthBar = $('health-bar');
  const timerValue = $('timer-value');
  const scoreValue = $('score-value');
  const moneyValue = $('money-value');
  const killfeed = $('killfeed');
  const chargeBox = $('charge-status');
  const buyMenu = $('buy-menu');
  const buyMoney = $('buy-money');
  const hint = $('hint');
  const crosshair = $('crosshair');
  const hitmarker = $('hitmarker');
  const damageFlash = $('damage-flash');
  const flashOverlay = $('flash-overlay');
  const roundBanner = $('round-banner');
  const weaponName = $('weapon-name');
  const grenadeCount = $('grenade-count');
  const scoreboardEl = $('scoreboard');
  const minimap = $('minimap');
  const mctx = minimap.getContext('2d');
  // Yard bounds for the minimap: x -32..32, z -24..24 -> 148 x 111 px.
  const MM_SCALE = 148 / 64;
  const mmX = (x) => (x + 32) * MM_SCALE;
  const mmY = (z) => (z + 24) * MM_SCALE;
  let last = {};
  let hitTimer = 0;
  let bannerTimer = 0;

  function setText(el, key, value) {
    if (last[key] === value) return;
    last[key] = value;
    el.textContent = value;
  }

  // Build the buy menu rows from the weapon catalog. Row order is the
  // catalog order (weapons ascending, then armour, then grenades), with
  // the defuse kit appended last: eleven rows, keys 1–9, then 0, then K
  // for the kit — the digits run out at ten rows, so the eleventh row
  // takes the free letter key (K is unused anywhere else). The kit sits
  // last deliberately, so the grenade digits (frag 8, flash 9, smoke 0)
  // never shift.
  const buyList = $('buy-list');
  const items = [
    ...Object.values(WEAPONS).filter((w) => w.price > 0),
    GEAR.armour,
    GRENADES.frag, GRENADES.flash, GRENADES.smoke,
    GEAR.defusekit,
  ];
  const buyRows = {};
  const buyStates = {};
  items.forEach((def, i) => {
    const row = document.createElement('div');
    row.className = 'buy-row';
    const keyLabel = i === 9 ? '0' : i === 10 ? 'K' : String(i + 1);
    row.innerHTML = `<span class="buy-key">${keyLabel}</span><span class="buy-name">${def.name}</span><span class="buy-state"></span><span class="buy-price">$${def.price}</span>`;
    buyList.appendChild(row);
    buyRows[def.id] = row;
    buyStates[def.id] = row.querySelector('.buy-state');
  });
  const buyKeys = items.map((d) => d.id);

  return {
    buyKeys,
    setAmmo(mag, reserve) {
      setText(ammoMag, 'mag', String(mag));
      setText(ammoReserve, 'reserve', `/ ${reserve}`);
      ammoBox.classList.toggle('empty', mag === 0);
    },
    setHealth(hp) {
      setText(healthValue, 'hp', String(Math.max(0, Math.ceil(hp))));
      healthBar.style.width = `${Math.max(0, hp)}%`;
      healthBar.classList.toggle('low', hp <= 30);
    },
    setArmour(n) {
      setText(armourValue, 'armour', n > 0 ? `+${Math.ceil(n)}` : '');
    },
    setTimer(seconds, phase) {
      const s = Math.max(0, Math.ceil(seconds));
      const mm = Math.floor(s / 60);
      const ss = String(s % 60).padStart(2, '0');
      setText(timerValue, 'timer', `${mm}:${ss}`);
      timerValue.classList.toggle('buy', phase === 'buy');
    },
    setScore(ember, ash, round) {
      setText(scoreValue, 'score', `EMBER ${ember} — ${ash} ASH · ROUND ${round}`);
    },
    setMoney(money) {
      setText(moneyValue, 'money', `$${money}`);
      setText(buyMoney, 'buymoney', `$${money}`);
    },
    setWeapon(name, frags, flashes, smokes = 0) {
      setText(weaponName, 'weapon', name);
      setText(grenadeCount, 'grenades', `Frag ${frags} · Flash ${flashes} · Smoke ${smokes}`);
    },
    setCharge(status) {
      // status: '' | 'PLANT THE CHARGE — HOLD E …' | 'DEFEND THE SITES …'
      //   | 'CHARGE PLANTED — SITE B — 32s'
      setText(chargeBox, 'charge', status);
      chargeBox.hidden = !status;
      chargeBox.classList.toggle('danger', status.includes('PLANTED'));
    },
    setHint(text) { setText(hint, 'hint', text); hint.hidden = !text; },
    setCrosshairGap(px) {
      crosshair.style.setProperty('--gap', `${px}px`);
    },
    hitMarker(killed, holdMs = 90) {
      hitmarker.classList.add('on');
      hitmarker.classList.toggle('kill', killed);
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => hitmarker.classList.remove('on', 'kill'), holdMs);
    },
    damageFlash() {
      damageFlash.classList.add('on');
      setTimeout(() => damageFlash.classList.remove('on'), 180);
    },
    whiteFlash() {
      flashOverlay.classList.add('on');
      setTimeout(() => flashOverlay.classList.remove('on'), 700);
    },
    banner(text, ms = 2500) {
      roundBanner.textContent = text;
      roundBanner.hidden = false;
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => { roundBanner.hidden = true; }, ms);
    },
    showBuy(open) {
      buyMenu.hidden = !open;
      for (const row of Object.values(buyRows)) row.classList.remove('bought', 'poor');
    },
    // Persistent affordances (cycle 12, Kilnyard comparison): every row
    // shows its state at a glance — Owned for the equipped weapon / full
    // armour, Max for a capped grenade, Too expensive when the wallet
    // cannot cover it, the carried count for a half-full grenade. Called
    // whenever the menu opens and after every purchase (money changes).
    refreshBuy(money, ownedWeapon, grenades, armour, defuseKit) {
      for (const def of items) {
        const row = buyRows[def.id];
        const stateEl = buyStates[def.id];
        let text = '';
        let cls = '';
        if (WEAPONS[def.id]) {
          if (def.id === ownedWeapon) { text = 'Owned'; cls = 'owned'; }
          else if (money < def.price) { text = 'Too expensive'; cls = 'poor'; }
        } else if (def.id === 'armour' || def.id === 'defusekit') {
          const owned = def.id === 'armour' ? armour >= 100 : defuseKit;
          if (owned) { text = 'Owned'; cls = 'owned'; }
          else if (money < def.price) { text = 'Too expensive'; cls = 'poor'; }
        } else {
          const n = grenades[def.id] || 0;
          if (n >= 2) { text = 'Max'; cls = 'owned'; }
          else if (money < def.price) { text = 'Too expensive'; cls = 'poor'; }
          else if (n > 0) text = `×${n}`;
        }
        row.classList.remove('owned', 'poor');
        if (cls) row.classList.add(cls);
        setText(stateEl, `buystate-${def.id}`, text);
      }
    },
    markBought(id, ok) {
      const row = buyRows[id];
      if (row) row.classList.add(ok ? 'bought' : 'poor');
    },
    setFeed(feed) {
      const key = feed.map((f) => f.text).join('|');
      if (last.feed === key) return;
      last.feed = key;
      killfeed.innerHTML = '';
      for (const item of feed.slice(-5)) {
        const div = document.createElement('div');
        div.className = `feed-${item.kind}`;
        div.textContent = item.text;
        killfeed.appendChild(div);
      }
    },
    // Top-down tactical overview: site letters, a pulsing charge marker,
    // live Ember (amber) and Ash (teal) dots, and the player's arrow.
    // Called every fixed step; the canvas is 148 x 111, so this is cheap.
    drawMinimap(data) {
      const W = 148; const H = 111;
      mctx.clearRect(0, 0, W, H);
      mctx.fillStyle = 'rgba(32, 38, 43, 0.85)';
      mctx.fillRect(0, 0, W, H);
      // Site markers.
      mctx.font = 'bold 11px ui-monospace, Menlo, monospace';
      mctx.textAlign = 'center';
      mctx.textBaseline = 'middle';
      for (const id of ['A', 'B']) {
        const s = data.sites[id];
        const x = mmX(s.pos.x); const y = mmY(s.pos.z);
        mctx.beginPath();
        mctx.arc(x, y, 8, 0, Math.PI * 2);
        mctx.fillStyle = 'rgba(255, 179, 71, 0.18)';
        mctx.fill();
        mctx.strokeStyle = '#ffb347';
        mctx.lineWidth = 1;
        mctx.stroke();
        mctx.fillStyle = '#ffb347';
        mctx.fillText(id, x, y);
      }
      // Planted charge: pulsing amber dot at its site.
      if (data.chargeSite) {
        const s = data.sites[data.chargeSite];
        const x = mmX(s.pos.x); const y = mmY(s.pos.z);
        const r = 4 + Math.sin(performance.now() / 180) * 1.5;
        mctx.beginPath();
        mctx.arc(x, y, Math.max(2, r), 0, Math.PI * 2);
        mctx.fillStyle = '#ff7a26';
        mctx.fill();
      }
      const dot = (b, color) => {
        if (!b.alive) return;
        mctx.beginPath();
        mctx.arc(mmX(b.pos.x), mmY(b.pos.z), 3, 0, Math.PI * 2);
        mctx.fillStyle = color;
        mctx.fill();
        mctx.strokeStyle = 'rgba(0,0,0,0.6)';
        mctx.lineWidth = 1;
        mctx.stroke();
      };
      for (const b of data.ember) dot(b, '#ff7a26');
      for (const b of data.ash) dot(b, '#7fb3b0');
      // Player arrow: forward is (-sin yaw, -cos yaw) in (x, z) = canvas (x, y).
      const fx = -Math.sin(data.yaw); const fz = -Math.cos(data.yaw);
      const ang = Math.atan2(fz, fx) + Math.PI / 2;
      mctx.save();
      mctx.translate(mmX(data.px), mmY(data.pz));
      mctx.rotate(ang);
      mctx.beginPath();
      mctx.moveTo(0, -6);
      mctx.lineTo(4.5, 5);
      mctx.lineTo(-4.5, 5);
      mctx.closePath();
      mctx.fillStyle = '#ece7db';
      mctx.fill();
      mctx.strokeStyle = 'rgba(0,0,0,0.6)';
      mctx.stroke();
      mctx.restore();
    },
    showOverlay(mode, detail = '', board = null) {
      const copy = {
        start: ['SULFUR YARD', 'Ember attacks. Plant the charge at Crusher (A) or Kiln (B) — or eliminate Ash. First to 7 rounds takes the yard; sides swap at halftime, then you defend it.', 'Click to play'],
        paused: ['PAUSED', 'Click to resume. Buy phase: press B.', 'Click to resume'],
        round: ['ROUND OVER', detail, 'Click to continue'],
        match: ['MATCH OVER', detail, 'Click to play again'],
      }[mode];
      if (!copy) return;
      overlayTitle.textContent = copy[0];
      overlayCopy.textContent = copy[1];
      playBtn.textContent = copy[2];
      // The scoreboard only belongs on the match overlay.
      if (mode === 'match' && board) {
        const hsPct = (r) => (r.k > 0 ? `${Math.round((r.hs / r.k) * 100)}%` : '—');
        const rows = (team) => board.filter((r) => r.team === team)
          .sort((a, b) => b.k - a.k || b.dmg - a.dmg)
          .map((r) => `<tr class="${r.you ? 'me' : ''}"><td>${r.you ? 'You' : r.name}</td><td>${r.k}</td><td>${r.d}</td><td>${hsPct(r)}</td><td>${Math.round(r.dmg)}</td></tr>`).join('');
        scoreboardEl.innerHTML = `<table><thead><tr><th>Player</th><th>K</th><th>D</th><th>HS</th><th>DMG</th></tr></thead><tbody><tr class="team-row"><td colspan="5">EMBER</td></tr>${rows('ember')}<tr class="team-row"><td colspan="5">ASH</td></tr>${rows('ash')}</tbody></table>`;
      } else {
        scoreboardEl.innerHTML = '';
      }
      overlay.hidden = false;
    },
    hideOverlay() { overlay.hidden = true; },
    onPlay(handler) { playBtn.addEventListener('click', handler); },
  };
}
