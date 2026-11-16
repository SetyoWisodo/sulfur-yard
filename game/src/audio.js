// Synthesized WebAudio only — no audio files, no network. Every sound is
// built from oscillators and filtered noise at call time. The context is
// created lazily on the first user gesture so autoplay rules never block it.
export function createAudio() {
  let ctx = null;
  let master = null;
  let muted = false;
  let ambientOn = false;

  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    return ctx;
  }

  // Ambient yard (cycle 12): looped wind through a lowpass, breathing
  // slowly on a 0.07 Hz LFO, under a 55 Hz yard hum. Started once, on the
  // first user gesture (unlock); never before, so autoplay rules never
  // block it and headless captures stay silent.
  function startAmbient() {
    const c = ensure();
    if (!c || ambientOn) return;
    ambientOn = true;
    const buf = noiseBuffer(2);
    if (!buf) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    const windGain = c.createGain();
    windGain.gain.value = 0.05;
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = c.createGain();
    lfoGain.gain.value = 0.025;
    lfo.connect(lfoGain).connect(windGain.gain);
    src.connect(filter).connect(windGain).connect(master);
    src.start();
    lfo.start();
    const hum = c.createOscillator();
    hum.type = 'sine';
    hum.frequency.value = 55;
    const humGain = c.createGain();
    humGain.gain.value = 0.03;
    hum.connect(humGain).connect(master);
    hum.start();
  }

  function noiseBuffer(duration) {
    const c = ensure();
    if (!c) return null;
    const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * duration)), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function burst({ duration = 0.12, freq = 1800, type = 'lowpass', gain = 0.5, slideTo = 0 }) {
    const c = ensure();
    if (!c || muted) return;
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(duration);
    const filter = c.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t);
    if (slideTo) filter.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t + duration);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter).connect(g).connect(master);
    src.start(t);
    src.stop(t + duration);
  }

  function tone({ freq = 440, to = 0, duration = 0.1, type = 'square', gain = 0.2 }) {
    const c = ensure();
    if (!c || muted) return;
    const t = c.currentTime;
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + duration);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + duration);
  }

  return {
    unlock() { ensure(); startAmbient(); },
    toggleMute() { muted = !muted; return muted; },
    status() { return { ctx: !!ctx, state: ctx ? ctx.state : 'none', ambient: ambientOn }; },
    // Round-start sting (cycle 12): a short rising three-note motif at
    // the start of every round, so the buy phase opening has a sound.
    sting() { [220, 330, 440].forEach((f, i) => setTimeout(() => tone({ freq: f, duration: 0.16, type: 'triangle', gain: 0.18 }), i * 90)); },
    shot(kind) {
      // kind: 'rifle' | 'smg' | 'shotgun' | 'sniper' | 'dmr' | 'pistol' | 'enemy'
      if (kind === 'shotgun') { burst({ duration: 0.28, freq: 900, gain: 0.8, slideTo: 120 }); tone({ freq: 90, to: 45, duration: 0.16, type: 'sine', gain: 0.5 }); }
      else if (kind === 'sniper') { burst({ duration: 0.4, freq: 2400, gain: 0.9, slideTo: 150 }); tone({ freq: 70, to: 35, duration: 0.3, type: 'sine', gain: 0.6 }); }
      else if (kind === 'dmr') { burst({ duration: 0.16, freq: 2200, gain: 0.7, slideTo: 300 }); tone({ freq: 110, to: 55, duration: 0.18, type: 'sine', gain: 0.45 }); }
      else if (kind === 'smg') burst({ duration: 0.08, freq: 2600, gain: 0.4, slideTo: 500 });
      else if (kind === 'pistol') burst({ duration: 0.1, freq: 2000, gain: 0.45, slideTo: 300 });
      else if (kind === 'enemy') burst({ duration: 0.12, freq: 1400, gain: 0.28, slideTo: 250 });
      else burst({ duration: 0.14, freq: 1800, gain: 0.6, slideTo: 200 });
    },
    dryFire() { tone({ freq: 1200, duration: 0.03, type: 'square', gain: 0.12 }); },
    reload() {
      tone({ freq: 700, duration: 0.05, type: 'square', gain: 0.15 });
      setTimeout(() => tone({ freq: 500, duration: 0.05, type: 'square', gain: 0.15 }), 320);
      setTimeout(() => tone({ freq: 900, duration: 0.06, type: 'square', gain: 0.18 }), 700);
    },
    hit() { tone({ freq: 1500, duration: 0.05, type: 'sine', gain: 0.25 }); },
    kill() { tone({ freq: 1500, duration: 0.06, type: 'sine', gain: 0.25 }); setTimeout(() => tone({ freq: 2100, duration: 0.08, type: 'sine', gain: 0.25 }), 70); },
    hurt() { tone({ freq: 160, to: 80, duration: 0.18, type: 'sawtooth', gain: 0.25 }); },
    step() {
      // Footsteps vary per step (cycle 12): pitch 350–500 Hz and gain
      // 0.06–0.10, so walking does not sound like a metronome.
      burst({ duration: 0.05, freq: 350 + Math.random() * 150, gain: 0.06 + Math.random() * 0.04, slideTo: 150 });
    },
    beep(final) { tone({ freq: final ? 1400 : 950, duration: final ? 0.3 : 0.09, type: 'square', gain: 0.2 }); },
    plant() { tone({ freq: 880, duration: 0.12, type: 'square', gain: 0.2 }); },
    defuse() { tone({ freq: 660, duration: 0.12, type: 'square', gain: 0.2 }); },
    explosion() {
      burst({ duration: 1.1, freq: 500, gain: 1.0, slideTo: 60 });
      tone({ freq: 55, to: 28, duration: 0.9, type: 'sine', gain: 0.9 });
    },
    roundWin() { [523, 659, 784].forEach((f, i) => setTimeout(() => tone({ freq: f, duration: 0.18, type: 'triangle', gain: 0.22 }), i * 130)); },
    roundLose() { [392, 330, 262].forEach((f, i) => setTimeout(() => tone({ freq: f, duration: 0.2, type: 'triangle', gain: 0.2 }), i * 140)); },
    buy() { tone({ freq: 1000, duration: 0.06, type: 'square', gain: 0.18 }); setTimeout(() => tone({ freq: 1300, duration: 0.08, type: 'square', gain: 0.18 }), 80); },
    denied() { tone({ freq: 220, duration: 0.15, type: 'square', gain: 0.2 }); },
    throwPin() { tone({ freq: 1800, duration: 0.03, type: 'square', gain: 0.12 }); },
  };
}
