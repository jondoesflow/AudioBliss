/* AudioBliss synth engine. Every instrument is synthesised with the Web Audio API,
   so the app works offline and loads instantly. All functions take any BaseAudioContext
   (live or OfflineAudioContext), which is what makes offline WAV export possible. */
(function (global) {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const SCALES = {
    minor:     { name: 'Minor',          steps: [0, 2, 3, 5, 7, 8, 10] },
    major:     { name: 'Major',          steps: [0, 2, 4, 5, 7, 9, 11] },
    dorian:    { name: 'Dorian',         steps: [0, 2, 3, 5, 7, 9, 10] },
    mixo:      { name: 'Mixolydian',     steps: [0, 2, 4, 5, 7, 9, 10] },
    lydian:    { name: 'Lydian',         steps: [0, 2, 4, 6, 7, 9, 11] },
    phrygian:  { name: 'Phrygian',       steps: [0, 1, 3, 5, 7, 8, 10] },
    harmMinor: { name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
    minPent:   { name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
    majPent:   { name: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
    blues:     { name: 'Blues',          steps: [0, 3, 5, 6, 7, 10] },
    japanese:  { name: 'Japanese',       steps: [0, 1, 5, 7, 8] },
    whole:     { name: 'Whole tone',     steps: [0, 2, 4, 6, 8, 10] },
    chromatic: { name: 'Chromatic',      steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  };
  const CHORDS = {
    none:  { name: 'Single', degs: [0] },
    oct:   { name: 'Octave', degs: [0, 'o'] },
    power: { name: 'Power',  degs: [0, 4] },
    triad: { name: 'Triad',  degs: [0, 2, 4] },
    sev:   { name: '7th',    degs: [0, 2, 4, 6] },
    nine:  { name: '9th',    degs: [0, 2, 4, 6, 8] },
    sus:   { name: 'Sus',    degs: [0, 3, 4] },
  };

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* degree -> midi note. deg may be any integer; octaves wrap through the scale. */
  function degToMidi(deg, root, scaleId, baseOct) {
    const sc = (SCALES[scaleId] || SCALES.minor).steps;
    const n = sc.length;
    const oct = Math.floor(deg / n);
    const idx = ((deg % n) + n) % n;
    return 12 * (baseOct + 1) + root + oct * 12 + sc[idx];
  }
  function chordDegs(deg, chordId, scaleId) {
    const ch = CHORDS[chordId] || CHORDS.none;
    const n = (SCALES[scaleId] || SCALES.minor).steps.length;
    return ch.degs.map((d) => (d === 'o' ? deg + n : deg + d));
  }
  function noteName(midi) {
    return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }

  /* ---------- shared helpers ---------- */
  const noiseCache = new WeakMap();
  function noiseBuffer(ctx) {
    let b = noiseCache.get(ctx);
    if (b) return b;
    const len = Math.floor(ctx.sampleRate * 2);
    b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
    return b;
  }
  function noise(ctx, t, dur) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuffer(ctx);
    s.loop = true;
    s.loopStart = Math.random() * 1.5;
    s.loopEnd = s.loopStart + 0.5;
    s.start(t, s.loopStart);
    s.stop(t + dur + 0.05);
    return s;
  }
  function osc(ctx, type, freq, t, detune) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(1, freq), t);
    if (detune) o.detune.setValueAtTime(detune, t);
    return o;
  }
  function gain(ctx, v) {
    const g = ctx.createGain();
    g.gain.value = v === undefined ? 1 : v;
    return g;
  }
  function filt(ctx, type, f, q) {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = clamp(f, 10, 20000);
    if (q !== undefined) b.Q.value = q;
    return b;
  }
  /* ADSR amplitude envelope. Returns gain node and the time the voice is silent. */
  function adsr(ctx, t, a, d, s, r, dur, peak) {
    const g = ctx.createGain();
    peak = peak === undefined ? 1 : peak;
    const gateEnd = t + Math.max(dur, a + 0.005);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setTargetAtTime(Math.max(0.0001, peak * s), t + a, Math.max(0.005, d / 3));
    g.gain.setTargetAtTime(0.0001, gateEnd, Math.max(0.005, r / 4));
    g.end = gateEnd + r + 0.05;
    return g;
  }
  /* percussive decay envelope */
  function decayEnv(ctx, t, peak, dec) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dec);
    g.end = t + dec + 0.02;
    return g;
  }
  const shaperCache = new WeakMap();
  function shaper(ctx, amount) {
    let m = shaperCache.get(ctx);
    if (!m) { m = new Map(); shaperCache.set(ctx, m); }
    let ws = m.get(amount);
    if (ws) return ws;
    ws = ctx.createWaveShaper();
    const n = 1024, curve = new Float32Array(n), k = amount;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    ws.curve = curve;
    ws.oversample = '2x';
    m.set(amount, ws);
    return ws;
  }
  function chain(nodes) {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }
  function startStop(oscs, t, end) {
    oscs.forEach((o) => { o.start(t); o.stop(end); });
  }
  /* metallic 808 style oscillator stack for hats and cymbals */
  function metal(ctx, t, end, mult) {
    const ratios = [205.3, 304.4, 369.6, 522.7, 540, 800];
    const g = gain(ctx, 0.25);
    const oscs = ratios.map((f) => { const o = osc(ctx, 'square', f * (mult || 1), t); o.connect(g); return o; });
    startStop(oscs, t, end);
    return g;
  }

  /* ---------- drums ---------- */
  function kick(ctx, out, p, o) {
    const t = p.t, v = p.vel;
    const tune = Math.pow(2, (p.tune || 0) / 12);
    const body = osc(ctx, 'sine', o.f0 * tune, t);
    body.frequency.exponentialRampToValueAtTime(o.f1 * tune, t + o.sweep);
    const env = decayEnv(ctx, t, v * o.level, o.dec);
    let last = env;
    if (o.drive) { last = shaper(ctx, o.drive); env.connect(last); }
    body.connect(env);
    last.connect(out);
    body.start(t); body.stop(env.end);
    if (o.click) {
      const n = noise(ctx, t, 0.03);
      const hp = filt(ctx, 'highpass', 1500, 0.7);
      const e = decayEnv(ctx, t, v * o.click, 0.03);
      chain([n, hp, e, out]);
    }
  }
  function snare(ctx, out, p, o) {
    const t = p.t, v = p.vel;
    const tune = Math.pow(2, (p.tune || 0) / 12);
    const t1 = osc(ctx, 'triangle', o.tone * tune, t);
    t1.frequency.exponentialRampToValueAtTime(o.tone * 0.6 * tune, t + 0.06);
    const e1 = decayEnv(ctx, t, v * o.toneLevel, o.toneDec);
    chain([t1, e1, out]);
    t1.start(t); t1.stop(e1.end);
    const n = noise(ctx, t, o.dec);
    const bp = filt(ctx, o.filter || 'highpass', o.cut, 0.8);
    const e2 = decayEnv(ctx, t, v * o.noiseLevel, o.dec);
    chain([n, bp, e2, out]);
  }
  function clap(ctx, out, p, o) {
    const t = p.t, v = p.vel;
    const n = noise(ctx, t, 0.5);
    const bp = filt(ctx, 'bandpass', o.cut || 1400, 1.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    const spread = o.spread || 0.011;
    for (let i = 0; i < 3; i++) {
      const tt = t + i * spread;
      g.gain.setValueAtTime(v * 0.9, tt);
      g.gain.exponentialRampToValueAtTime(0.1 * v, tt + spread * 0.9);
    }
    const tt = t + 3 * spread;
    g.gain.setValueAtTime(v, tt);
    g.gain.exponentialRampToValueAtTime(0.0005, tt + (o.dec || 0.22));
    chain([n, bp, g, out]);
  }
  function hat(ctx, out, p, o) {
    const t = p.t, v = p.vel;
    const end = t + o.dec + 0.05;
    const m = metal(ctx, t, end, o.mult || 1);
    const bp = filt(ctx, 'bandpass', o.bp || 10000, 1);
    const hp = filt(ctx, 'highpass', o.hp || 7000, 0.7);
    const e = decayEnv(ctx, t, v * o.level, o.dec);
    chain([m, bp, hp, e, out]);
    if (o.noise) {
      const n = noise(ctx, t, o.dec);
      const hp2 = filt(ctx, 'highpass', o.hp || 7000, 0.7);
      const e2 = decayEnv(ctx, t, v * o.noise, o.dec);
      chain([n, hp2, e2, out]);
    }
  }
  function tom(ctx, out, p, o) {
    const t = p.t, v = p.vel;
    const tune = Math.pow(2, (p.tune || 0) / 12);
    const b = osc(ctx, 'sine', o.f * 1.6 * tune, t);
    b.frequency.exponentialRampToValueAtTime(o.f * tune, t + 0.08);
    const e = decayEnv(ctx, t, v * o.level, o.dec);
    chain([b, e, out]);
    b.start(t); b.stop(e.end);
    const n = noise(ctx, t, 0.05);
    const lp = filt(ctx, 'lowpass', 1800, 0.5);
    const e2 = decayEnv(ctx, t, v * 0.25, 0.05);
    chain([n, lp, e2, out]);
  }
  function blip(ctx, out, p, o) {
    /* short pitched hits: rim, clave, woodblock, cowbell */
    const t = p.t, v = p.vel;
    const tune = Math.pow(2, (p.tune || 0) / 12);
    const e = decayEnv(ctx, t, v * o.level, o.dec);
    const oscs = o.freqs.map((f) => osc(ctx, o.type || 'sine', f * tune, t));
    let dest = e;
    if (o.bp) { const bp = filt(ctx, 'bandpass', o.bp, 1.5); e.connect(bp); bp.connect(out); } else e.connect(out);
    oscs.forEach((x) => x.connect(dest));
    startStop(oscs, t, e.end);
    if (o.noise) {
      const n = noise(ctx, t, 0.02);
      const hp = filt(ctx, 'highpass', 2000, 0.7);
      const e2 = decayEnv(ctx, t, v * o.noise, 0.02);
      chain([n, hp, e2, out]);
    }
  }
  function cymbal(ctx, out, p, o) {
    const t = p.t, v = p.vel;
    const end = t + o.dec + 0.1;
    const m = metal(ctx, t, end, o.mult || 1.3);
    const hp = filt(ctx, 'highpass', o.hp || 6000, 0.5);
    const e = decayEnv(ctx, t, v * o.level, o.dec);
    chain([m, hp, e, out]);
    const n = noise(ctx, t, o.dec);
    const hp2 = filt(ctx, 'highpass', o.hp || 6000, 0.5);
    const e2 = decayEnv(ctx, t, v * o.level * 0.6, o.dec * 0.8);
    chain([n, hp2, e2, out]);
  }
  function shaker(ctx, out, p, o) {
    const t = p.t, v = p.vel;
    const n = noise(ctx, t, o.dec + 0.02);
    const bp = filt(ctx, 'bandpass', o.cut || 6000, 1.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v * o.level, t + (o.att || 0.012));
    g.gain.exponentialRampToValueAtTime(0.0005, t + o.dec);
    chain([n, bp, g, out]);
  }

  /* ---------- FX hits ---------- */
  function riser(ctx, out, p) {
    const t = p.t, dur = Math.max(0.5, p.dur);
    const n = noise(ctx, t, dur + 0.3);
    const bp = filt(ctx, 'bandpass', 300, 2);
    bp.frequency.exponentialRampToValueAtTime(6000, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5 * p.vel, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur + 0.25);
    chain([n, bp, g, out]);
  }
  function impact(ctx, out, p) {
    kick(ctx, out, p, { f0: 120, f1: 30, sweep: 0.3, dec: 1.4, level: 0.9, click: 0, drive: 2 });
    const n = noise(ctx, p.t, 0.8);
    const lp = filt(ctx, 'lowpass', 900, 0.7);
    const e = decayEnv(ctx, p.t, p.vel * 0.5, 0.8);
    chain([n, lp, e, out]);
  }
  function laser(ctx, out, p) {
    const t = p.t;
    const o = osc(ctx, 'square', 2200, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.3);
    const e = decayEnv(ctx, t, p.vel * 0.3, 0.32);
    chain([o, e, out]);
    o.start(t); o.stop(e.end);
  }
  function zap(ctx, out, p) {
    const t = p.t;
    const o = osc(ctx, 'sawtooth', 900, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.18);
    const lp = filt(ctx, 'lowpass', 3000, 8);
    lp.frequency.exponentialRampToValueAtTime(200, t + 0.18);
    const e = decayEnv(ctx, t, p.vel * 0.45, 0.2);
    chain([o, lp, e, out]);
    o.start(t); o.stop(e.end);
  }
  function glitch(ctx, out, p) {
    const t = p.t;
    for (let i = 0; i < 6; i++) {
      const tt = t + i * 0.022 + Math.random() * 0.004;
      const o = osc(ctx, 'square', 400 + Math.random() * 3000, tt);
      const e = decayEnv(ctx, tt, p.vel * 0.2, 0.012);
      chain([o, e, out]);
      o.start(tt); o.stop(e.end);
    }
  }
  function vinyl(ctx, out, p) {
    const t = p.t, dur = Math.max(0.25, p.dur);
    const n = noise(ctx, t, dur);
    const lp = filt(ctx, 'lowpass', 2500, 0.5);
    const g = gain(ctx, 0.05 * p.vel);
    g.gain.setValueAtTime(0.05 * p.vel, t + dur - 0.01);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    chain([n, lp, g, out]);
    const count = Math.floor(dur * 12);
    for (let i = 0; i < count; i++) {
      const tt = t + Math.random() * dur;
      const c = noise(ctx, tt, 0.004);
      const hp = filt(ctx, 'highpass', 3000, 0.5);
      const e = decayEnv(ctx, tt, p.vel * 0.25, 0.004);
      chain([c, hp, e, out]);
    }
  }
  function reverseCym(ctx, out, p) {
    const t = p.t, dur = Math.max(0.3, Math.min(p.dur, 1.2));
    const n = noise(ctx, t, dur);
    const hp = filt(ctx, 'highpass', 4000, 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6 * p.vel, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur + 0.03);
    chain([n, hp, g, out]);
  }

  /* ---------- melodic helpers ---------- */
  function lfo(ctx, t, end, freq, depth, target, type) {
    const o = osc(ctx, type || 'sine', freq, t);
    const g = gain(ctx, depth);
    o.connect(g); g.connect(target);
    o.start(t); o.stop(end);
    return o;
  }
  /* a generic subtractive voice used by many instruments */
  function subtractive(ctx, out, p, o) {
    const t = p.t, f = p.f, v = p.vel;
    const env = adsr(ctx, t, o.a, o.d, o.s, o.r, p.dur, v * o.level);
    const end = env.end;
    const oscs = [];
    (o.oscs || [{ type: 'sawtooth' }]).forEach((spec) => {
      const x = osc(ctx, spec.type, f * (spec.ratio || 1), t, spec.detune || 0);
      if (spec.glide) { x.frequency.setValueAtTime(f * spec.glide, t); x.frequency.exponentialRampToValueAtTime(f * (spec.ratio || 1), t + 0.05); }
      x.level = spec.level;
      oscs.push(x);
    });
    const mix = gain(ctx, 1 / Math.sqrt(oscs.length));
    oscs.forEach((x) => { if (x.level !== undefined) { const lg = gain(ctx, x.level); x.connect(lg); lg.connect(mix); } else x.connect(mix); });
    let node = mix;
    if (o.sub) { const s = osc(ctx, o.subType || 'sine', f / 2, t); const sg = gain(ctx, o.sub); s.connect(sg); sg.connect(mix); oscs.push(s); }
    if (o.hp) { const h = filt(ctx, 'highpass', o.hp, 0.7); node.connect(h); node = h; }
    if (o.cut) {
      const lp = filt(ctx, 'lowpass', o.cut, o.q || 1);
      if (o.fenv) {
        const peak = clamp(o.cut + o.fenv * (0.5 + 0.5 * v), 20, 18000);
        lp.frequency.setValueAtTime(peak, t);
        lp.frequency.setTargetAtTime(o.cut, t + (o.fa || 0.005), Math.max(0.01, (o.fd || 0.2) / 3));
      }
      if (o.fsweep) { lp.frequency.setValueAtTime(o.cut, t); lp.frequency.linearRampToValueAtTime(o.fsweep, t + Math.max(0.05, p.dur)); }
      if (o.flfo) lfo(ctx, t, end, o.flfo.rate === 'beat' ? (p.beatHz || 2) * (o.flfo.mult || 1) : o.flfo.rate, o.flfo.depth, lp.frequency, o.flfo.type);
      node.connect(lp); node = lp;
      if (o.cut2) { const lp2 = filt(ctx, 'lowpass', o.cut2, 0.7); node.connect(lp2); node = lp2; }
    }
    if (o.drive) { const ws = shaper(ctx, o.drive); node.connect(ws); node = ws; }
    if (o.vib) oscs.forEach((x) => lfo(ctx, t + (o.vibDelay || 0), end, o.vib.rate, o.vib.depth, x.detune));
    if (o.trem) lfo(ctx, t, end, o.trem.rate, o.trem.depth, env.gain);
    node.connect(env); env.connect(out);
    startStop(oscs, t, end);
  }
  /* 2 operator FM voice */
  function fm(ctx, out, p, o) {
    const t = p.t, f = p.f, v = p.vel;
    const env = adsr(ctx, t, o.a, o.d, o.s, o.r, p.dur, v * o.level);
    const end = env.end;
    const car = osc(ctx, 'sine', f * (o.cRatio || 1), t);
    const mod = osc(ctx, 'sine', f * o.mRatio, t);
    const idx = ctx.createGain();
    const peak = f * o.index * (0.6 + 0.4 * v);
    idx.gain.setValueAtTime(peak, t);
    idx.gain.setTargetAtTime(f * (o.indexFloor || 0), t, Math.max(0.01, o.indexDec / 3));
    mod.connect(idx); idx.connect(car.frequency);
    car.connect(env); env.connect(out);
    if (o.extra) {
      o.extra.forEach((x) => {
        const e2 = osc(ctx, x.type || 'sine', f * x.ratio, t);
        const g2 = decayEnv(ctx, t, v * x.level, x.dec);
        chain([e2, g2, out]);
        e2.start(t); e2.stop(g2.end);
      });
    }
    if (o.trem) lfo(ctx, t, end, o.trem.rate, o.trem.depth, env.gain);
    startStop([car, mod], t, end);
  }
  function additive(ctx, out, p, o) {
    const t = p.t, f = p.f, v = p.vel;
    const env = adsr(ctx, t, o.a, o.d, o.s, o.r, p.dur, v * o.level);
    const end = env.end;
    const oscs = o.partials.map((pt) => {
      const x = osc(ctx, pt.type || 'sine', f * pt.ratio, t);
      const g = gain(ctx, pt.level);
      if (pt.dec) { g.gain.setValueAtTime(pt.level, t); g.gain.setTargetAtTime(0.0001, t, pt.dec / 3); }
      x.connect(g); g.connect(env);
      return x;
    });
    env.connect(out);
    if (o.vib) oscs.forEach((x) => lfo(ctx, t, end, o.vib.rate, o.vib.depth, x.detune));
    if (o.click) {
      const n = noise(ctx, t, 0.01);
      const hp = filt(ctx, 'highpass', 3000, 0.7);
      const e = decayEnv(ctx, t, v * o.click, 0.01);
      chain([n, hp, e, out]);
    }
    startStop(oscs, t, end);
  }
  /* Karplus-Strong plucked string */
  function pluck(ctx, out, p, o) {
    const t = p.t, f = p.f, v = p.vel;
    const dur = o.ring || 1.5;
    const burst = noise(ctx, t, 1 / f + 0.01);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(v, t);
    bg.gain.setValueAtTime(v, t + 1 / f);
    bg.gain.linearRampToValueAtTime(0, t + 1 / f + 0.002);
    const del = ctx.createDelay(1);
    del.delayTime.value = 1 / f;
    const fb = gain(ctx, o.fb || 0.985);
    const lp = filt(ctx, 'lowpass', o.cut || 4500, 0.5);
    const outG = gain(ctx, o.level * 0.9);
    outG.gain.setValueAtTime(o.level * 0.9, t + dur - 0.05);
    outG.gain.linearRampToValueAtTime(0.0001, t + dur);
    burst.connect(bg); bg.connect(del);
    del.connect(lp); lp.connect(fb); fb.connect(del);
    del.connect(outG); outG.connect(out);
    const killer = osc(ctx, 'sine', 1, t);  /* keeps graph alive until stop, then GC */
    killer.start(t); killer.stop(t + dur);
    killer.onended = () => { try { fb.disconnect(); del.disconnect(); outG.disconnect(); } catch (e) {} };
  }
  function formantPad(ctx, out, p, o) {
    const t = p.t, f = p.f, v = p.vel;
    const env = adsr(ctx, t, o.a, o.d, o.s, o.r, p.dur, v * o.level);
    const end = env.end;
    const oscs = [osc(ctx, 'sawtooth', f, t, -7), osc(ctx, 'sawtooth', f, t, 7), osc(ctx, 'triangle', f * 2, t)];
    const mix = gain(ctx, 0.4);
    oscs.forEach((x) => x.connect(mix));
    o.formants.forEach((fr) => { const bp = filt(ctx, 'bandpass', fr.f, fr.q || 6); const g = gain(ctx, fr.g || 1); mix.connect(bp); bp.connect(g); g.connect(env); });
    const lp = filt(ctx, 'lowpass', 1800, 0.5);
    mix.connect(lp); lp.connect(env);
    env.connect(out);
    oscs.forEach((x) => lfo(ctx, t, end, 5, 6, x.detune));
    startStop(oscs, t, end);
  }

  /* ---------- instrument table ---------- */
  const CATS = {
    drums: { name: 'Drums', color: 'var(--c-drums)' },
    perc:  { name: 'Percussion', color: 'var(--c-perc)' },
    bass:  { name: 'Bass', color: 'var(--c-bass)' },
    keys:  { name: 'Keys', color: 'var(--c-keys)' },
    lead:  { name: 'Leads', color: 'var(--c-lead)' },
    pad:   { name: 'Pads', color: 'var(--c-pad)' },
    fx:    { name: 'FX', color: 'var(--c-fx)' },
  };

  const D = (id, name, cat, play, oct) => ({ id, name, cat, kind: 'drum', play });
  const M = (id, name, cat, oct, play) => ({ id, name, cat, kind: 'melodic', oct, play });

  const INSTRUMENTS = [
    /* drums */
    D('kick808', '808 Kick', 'drums', (c, o, p) => kick(c, o, p, { f0: 160, f1: 46, sweep: 0.06, dec: 0.7, level: 1.0, click: 0.3 })),
    D('kick909', '909 Kick', 'drums', (c, o, p) => kick(c, o, p, { f0: 220, f1: 52, sweep: 0.05, dec: 0.45, level: 0.9, click: 0.6, drive: 3 })),
    D('kickPunch', 'Punch Kick', 'drums', (c, o, p) => kick(c, o, p, { f0: 300, f1: 55, sweep: 0.035, dec: 0.3, level: 0.95, click: 0.8, drive: 1.5 })),
    D('kickSub', 'Sub Kick', 'drums', (c, o, p) => kick(c, o, p, { f0: 90, f1: 38, sweep: 0.1, dec: 1.0, level: 1.0, click: 0.1 })),
    D('kickLofi', 'Dusty Kick', 'drums', (c, o, p) => kick(c, o, p, { f0: 140, f1: 50, sweep: 0.05, dec: 0.35, level: 0.85, click: 0.2, drive: 6 })),
    D('snare', 'Snare', 'drums', (c, o, p) => snare(c, o, p, { tone: 190, toneLevel: 0.5, toneDec: 0.18, cut: 1800, noiseLevel: 0.7, dec: 0.22 })),
    D('snare909', 'Tight Snare', 'drums', (c, o, p) => snare(c, o, p, { tone: 240, toneLevel: 0.45, toneDec: 0.1, cut: 2500, noiseLevel: 0.6, dec: 0.13 })),
    D('snareFat', 'Fat Snare', 'drums', (c, o, p) => snare(c, o, p, { tone: 165, toneLevel: 0.6, toneDec: 0.25, cut: 1200, noiseLevel: 0.8, dec: 0.32 })),
    D('snareDnb', 'DnB Snare', 'drums', (c, o, p) => { snare(c, o, p, { tone: 210, toneLevel: 0.55, toneDec: 0.12, cut: 2200, noiseLevel: 0.75, dec: 0.17 }); clap(c, o, { t: p.t, vel: p.vel * 0.45 }, { cut: 2000, dec: 0.12, spread: 0.008 }); }),
    D('clap', 'Clap', 'drums', (c, o, p) => clap(c, o, p, { cut: 1400, dec: 0.22 })),
    D('clapBig', 'Big Clap', 'drums', (c, o, p) => clap(c, o, p, { cut: 1000, dec: 0.45, spread: 0.014 })),
    D('rim', 'Rimshot', 'drums', (c, o, p) => blip(c, o, p, { freqs: [1750, 460], level: 0.5, dec: 0.045, noise: 0.5, bp: 1800 })),
    D('snap', 'Snap', 'drums', (c, o, p) => clap(c, o, p, { cut: 2600, dec: 0.08, spread: 0.006 })),
    D('hatC', 'Closed Hat', 'drums', (c, o, p) => hat(c, o, p, { dec: 0.06, level: 0.45, noise: 0.2 })),
    D('hatO', 'Open Hat', 'drums', (c, o, p) => hat(c, o, p, { dec: 0.4, level: 0.4, noise: 0.25 })),
    D('hatPedal', 'Pedal Hat', 'drums', (c, o, p) => hat(c, o, p, { dec: 0.12, level: 0.35, noise: 0.15, hp: 5000 })),
    D('hatTrap', 'Trap Hat', 'drums', (c, o, p) => hat(c, o, p, { dec: 0.045, level: 0.5, noise: 0.5, hp: 9000, bp: 12000, mult: 1.4 })),
    D('ride', 'Ride', 'drums', (c, o, p) => cymbal(c, o, p, { dec: 1.0, level: 0.25, hp: 5000, mult: 1.1 })),
    D('crash', 'Crash', 'drums', (c, o, p) => cymbal(c, o, p, { dec: 1.8, level: 0.35, hp: 4000, mult: 1.35 })),
    D('tomL', 'Low Tom', 'drums', (c, o, p) => tom(c, o, p, { f: 85, dec: 0.5, level: 0.8 })),
    D('tomM', 'Mid Tom', 'drums', (c, o, p) => tom(c, o, p, { f: 130, dec: 0.4, level: 0.75 })),
    D('tomH', 'High Tom', 'drums', (c, o, p) => tom(c, o, p, { f: 200, dec: 0.3, level: 0.7 })),
    D('tom808', '808 Tom', 'drums', (c, o, p) => tom(c, o, p, { f: 110, dec: 0.7, level: 0.8 })),
    /* percussion */
    D('conga', 'Conga', 'perc', (c, o, p) => tom(c, o, p, { f: 190, dec: 0.22, level: 0.7 })),
    D('congaHi', 'Conga Slap', 'perc', (c, o, p) => tom(c, o, p, { f: 260, dec: 0.14, level: 0.65 })),
    D('bongo', 'Bongo', 'perc', (c, o, p) => blip(c, o, p, { freqs: [420, 630], level: 0.45, dec: 0.12, noise: 0.3 })),
    D('clave', 'Clave', 'perc', (c, o, p) => blip(c, o, p, { freqs: [2500], level: 0.5, dec: 0.06 })),
    D('cowbell', 'Cowbell', 'perc', (c, o, p) => blip(c, o, p, { freqs: [587, 845], type: 'square', level: 0.3, dec: 0.3, bp: 1200 })),
    D('woodblock', 'Woodblock', 'perc', (c, o, p) => blip(c, o, p, { freqs: [820, 1230], level: 0.45, dec: 0.07, noise: 0.3 })),
    D('shaker', 'Shaker', 'perc', (c, o, p) => shaker(c, o, p, { dec: 0.1, level: 0.3, cut: 6500 })),
    D('tamb', 'Tambourine', 'perc', (c, o, p) => { shaker(c, o, p, { dec: 0.18, level: 0.25, cut: 7500, att: 0.005 }); hat(c, o, { t: p.t, vel: p.vel * 0.6 }, { dec: 0.2, level: 0.3, mult: 1.9, hp: 8000, bp: 11000 }); }),
    D('triangle', 'Triangle', 'perc', (c, o, p) => blip(c, o, p, { freqs: [3100, 5200, 7800], level: 0.12, dec: 0.9 })),
    D('timbale', 'Timbale', 'perc', (c, o, p) => { tom(c, o, p, { f: 320, dec: 0.2, level: 0.6 }); blip(c, o, { t: p.t, vel: p.vel }, { freqs: [1400], level: 0.25, dec: 0.08, noise: 0.5 }); }),
    D('djembe', 'Djembe', 'perc', (c, o, p) => tom(c, o, p, { f: 95, dec: 0.3, level: 0.85 })),
    D('tabla', 'Tabla', 'perc', (c, o, p) => { const b = osc(c, 'sine', 320, p.t); b.frequency.exponentialRampToValueAtTime(520, p.t + 0.08); const e = decayEnv(c, p.t, p.vel * 0.6, 0.25); chain([b, e, o]); b.start(p.t); b.stop(e.end); }),
    D('cabasa', 'Cabasa', 'perc', (c, o, p) => shaker(c, o, p, { dec: 0.07, level: 0.3, cut: 9000, att: 0.004 })),
    /* fx */
    D('riser', 'Riser', 'fx', riser),
    D('reverse', 'Reverse Cymbal', 'fx', reverseCym),
    D('impact', 'Impact', 'fx', impact),
    D('laser', 'Laser', 'fx', laser),
    D('zap', 'Zap', 'fx', zap),
    D('glitch', 'Glitch', 'fx', glitch),
    D('vinyl', 'Vinyl Crackle', 'fx', vinyl),
    /* bass */
    M('sub', 'Sub Bass', 'bass', 1, (c, o, p) => subtractive(c, o, p, { level: 0.9, a: 0.005, d: 0.1, s: 0.9, r: 0.08, oscs: [{ type: 'sine' }, { type: 'triangle', level: 0.2 }], cut: 400 })),
    M('reese', 'Reese', 'bass', 1, (c, o, p) => subtractive(c, o, p, { level: 0.55, a: 0.01, d: 0.2, s: 0.9, r: 0.12, oscs: [{ type: 'sawtooth', detune: -14 }, { type: 'sawtooth', detune: 14 }, { type: 'sawtooth', detune: 3, ratio: 0.5 }], cut: 650, q: 2, flfo: { rate: 0.6, depth: 250 }, drive: 1.5 })),
    M('acid', 'Acid 303', 'bass', 2, (c, o, p) => subtractive(c, o, p, { level: 0.5, a: 0.003, d: 0.25, s: 0.3, r: 0.05, oscs: [{ type: 'sawtooth' }], cut: 220, q: 14, fenv: 2600, fd: 0.25, drive: 1.2 })),
    M('fmBass', 'FM Bass', 'bass', 1, (c, o, p) => fm(c, o, p, { level: 0.6, a: 0.004, d: 0.3, s: 0.5, r: 0.08, mRatio: 1, index: 6, indexDec: 0.25, indexFloor: 0.3 })),
    M('wobble', 'Wobble', 'bass', 1, (c, o, p) => subtractive(c, o, p, { level: 0.55, a: 0.01, d: 0.1, s: 0.9, r: 0.1, oscs: [{ type: 'sawtooth', detune: -8 }, { type: 'square', detune: 8 }], cut: 500, q: 6, flfo: { rate: 'beat', mult: 1, depth: 420 }, drive: 2 })),
    M('pluckBass', 'Pluck Bass', 'bass', 1, (c, o, p) => subtractive(c, o, p, { level: 0.6, a: 0.002, d: 0.22, s: 0.15, r: 0.08, oscs: [{ type: 'square' }, { type: 'sawtooth', detune: 5 }], cut: 300, q: 3, fenv: 1800, fd: 0.18 })),
    M('moog', 'Fat Moog', 'bass', 1, (c, o, p) => subtractive(c, o, p, { level: 0.55, a: 0.005, d: 0.35, s: 0.6, r: 0.1, oscs: [{ type: 'sawtooth', detune: -6 }, { type: 'sawtooth', detune: 6 }], sub: 0.6, subType: 'square', cut: 350, q: 4, fenv: 1200, fd: 0.35, cut2: 2500, drive: 1.3 })),
    M('growl', 'Growl', 'bass', 1, (c, o, p) => subtractive(c, o, p, { level: 0.45, a: 0.01, d: 0.2, s: 0.8, r: 0.1, oscs: [{ type: 'sawtooth' }, { type: 'sawtooth', detune: 19 }, { type: 'square', ratio: 2.01 }], cut: 900, q: 9, flfo: { rate: 'beat', mult: 3, depth: 700 }, drive: 6 })),
    M('rubber', 'Rubber Bass', 'bass', 1, (c, o, p) => subtractive(c, o, p, { level: 0.65, a: 0.003, d: 0.25, s: 0.4, r: 0.08, oscs: [{ type: 'square', glide: 2 }, { type: 'sine', ratio: 1 }], cut: 450, q: 2, fenv: 900, fd: 0.2 })),
    M('donk', 'Donk', 'bass', 2, (c, o, p) => fm(c, o, p, { level: 0.55, a: 0.002, d: 0.15, s: 0.05, r: 0.05, mRatio: 2, index: 9, indexDec: 0.08, cRatio: 1 })),
    M('lofiBass', 'Lo-fi Bass', 'bass', 1, (c, o, p) => subtractive(c, o, p, { level: 0.7, a: 0.01, d: 0.3, s: 0.5, r: 0.15, oscs: [{ type: 'triangle' }, { type: 'sine', ratio: 2 }], cut: 500, q: 1, drive: 3 })),
    /* keys */
    M('rhodes', 'Rhodes', 'keys', 3, (c, o, p) => fm(c, o, p, { level: 0.55, a: 0.004, d: 1.6, s: 0.3, r: 0.35, mRatio: 14, index: 0.35, indexDec: 0.18, extra: [{ ratio: 1, level: 0.3, dec: 1.4 }, { ratio: 2, level: 0.08, dec: 0.5 }], trem: { rate: 4.5, depth: 0.08 } })),
    M('wurli', 'Wurlitzer', 'keys', 3, (c, o, p) => additive(c, o, p, { level: 0.45, a: 0.003, d: 1.1, s: 0.25, r: 0.25, partials: [{ ratio: 1, level: 0.8, type: 'triangle' }, { ratio: 2, level: 0.35, dec: 0.6 }, { ratio: 3, level: 0.15, dec: 0.3 }, { ratio: 5, level: 0.05, dec: 0.2 }], click: 0.2, vib: { rate: 5.5, depth: 3 } })),
    M('piano', 'Piano', 'keys', 3, (c, o, p) => additive(c, o, p, { level: 0.45, a: 0.002, d: 2.0, s: 0.12, r: 0.3, partials: [{ ratio: 1, level: 0.7 }, { ratio: 2.001, level: 0.4, dec: 1.2 }, { ratio: 3.003, level: 0.2, dec: 0.8, type: 'triangle' }, { ratio: 4.01, level: 0.1, dec: 0.5 }, { ratio: 5.02, level: 0.05, dec: 0.35 }, { ratio: 0.5, level: 0.06 }], click: 0.15 })),
    M('organ', 'Organ', 'keys', 3, (c, o, p) => additive(c, o, p, { level: 0.35, a: 0.01, d: 0.05, s: 1, r: 0.05, partials: [{ ratio: 0.5, level: 0.6 }, { ratio: 1, level: 1 }, { ratio: 1.5, level: 0.5 }, { ratio: 2, level: 0.7 }, { ratio: 3, level: 0.35 }, { ratio: 4, level: 0.3 }, { ratio: 6, level: 0.12 }, { ratio: 8, level: 0.1 }], vib: { rate: 6.2, depth: 5 }, click: 0.3 })),
    M('clav', 'Clav', 'keys', 3, (c, o, p) => subtractive(c, o, p, { level: 0.4, a: 0.002, d: 0.35, s: 0.1, r: 0.06, oscs: [{ type: 'square' }, { type: 'sawtooth', detune: 4 }], hp: 250, cut: 900, q: 5, fenv: 4500, fd: 0.12 })),
    M('glass', 'Glass Keys', 'keys', 4, (c, o, p) => additive(c, o, p, { level: 0.4, a: 0.005, d: 1.3, s: 0.2, r: 0.5, partials: [{ ratio: 1, level: 0.8 }, { ratio: 3.01, level: 0.25, dec: 0.9 }, { ratio: 5.02, level: 0.08, dec: 0.5 }, { ratio: 1.003, level: 0.4 }] })),
    M('bell', 'Bell', 'keys', 4, (c, o, p) => fm(c, o, p, { level: 0.4, a: 0.002, d: 1.8, s: 0.05, r: 0.6, mRatio: 3.5, index: 2.5, indexDec: 0.9 })),
    M('vibes', 'Vibes', 'keys', 4, (c, o, p) => additive(c, o, p, { level: 0.45, a: 0.004, d: 1.4, s: 0.08, r: 0.4, partials: [{ ratio: 1, level: 0.9 }, { ratio: 4, level: 0.25, dec: 0.4 }, { ratio: 10, level: 0.04, dec: 0.1 }], click: 0.1, vib: { rate: 5, depth: 0 }, trem: { rate: 5, depth: 0.3 } })),
    M('marimba', 'Marimba', 'keys', 3, (c, o, p) => additive(c, o, p, { level: 0.5, a: 0.002, d: 0.45, s: 0.02, r: 0.15, partials: [{ ratio: 1, level: 0.9 }, { ratio: 4, level: 0.3, dec: 0.08 }, { ratio: 9.2, level: 0.08, dec: 0.04 }], click: 0.25 })),
    M('kalimba', 'Kalimba', 'keys', 4, (c, o, p) => additive(c, o, p, { level: 0.45, a: 0.002, d: 0.7, s: 0.02, r: 0.2, partials: [{ ratio: 1, level: 0.9 }, { ratio: 2.3, level: 0.12, dec: 0.15 }, { ratio: 6, level: 0.05, dec: 0.05 }], click: 0.3 })),
    M('harp', 'Harp', 'keys', 4, (c, o, p) => pluck(c, o, p, { level: 0.5, ring: 1.8, fb: 0.99, cut: 5000 })),
    M('guitar', 'Pluck Guitar', 'keys', 3, (c, o, p) => pluck(c, o, p, { level: 0.55, ring: 1.2, fb: 0.975, cut: 2800 })),
    M('musicbox', 'Music Box', 'keys', 5, (c, o, p) => additive(c, o, p, { level: 0.35, a: 0.002, d: 0.9, s: 0.02, r: 0.3, partials: [{ ratio: 1, level: 0.8 }, { ratio: 3, level: 0.2, dec: 0.3 }, { ratio: 6, level: 0.06, dec: 0.1 }], click: 0.1 })),
    M('steelDrum', 'Steel Drum', 'keys', 4, (c, o, p) => fm(c, o, p, { level: 0.45, a: 0.003, d: 0.8, s: 0.05, r: 0.3, mRatio: 2, index: 1.6, indexDec: 0.3, extra: [{ ratio: 4.1, level: 0.12, dec: 0.3 }] })),
    /* leads */
    M('sawLead', 'Saw Lead', 'lead', 4, (c, o, p) => subtractive(c, o, p, { level: 0.35, a: 0.01, d: 0.2, s: 0.8, r: 0.15, oscs: [{ type: 'sawtooth', detune: -6 }, { type: 'sawtooth', detune: 6 }], cut: 1800, q: 2, fenv: 2500, fd: 0.3, vib: { rate: 5.5, depth: 8 }, vibDelay: 0.2 })),
    M('squareLead', 'Square Lead', 'lead', 4, (c, o, p) => subtractive(c, o, p, { level: 0.3, a: 0.01, d: 0.15, s: 0.8, r: 0.12, oscs: [{ type: 'square' }, { type: 'square', detune: 9, ratio: 1 }], cut: 2200, q: 1.5, fenv: 1500, fd: 0.2, vib: { rate: 6, depth: 6 }, vibDelay: 0.25 })),
    M('chip', 'Chip Lead', 'lead', 4, (c, o, p) => subtractive(c, o, p, { level: 0.25, a: 0.001, d: 0.05, s: 0.9, r: 0.02, oscs: [{ type: 'square' }], vib: { rate: 7, depth: 12 }, vibDelay: 0.12 })),
    M('supersaw', 'Supersaw', 'lead', 4, (c, o, p) => subtractive(c, o, p, { level: 0.28, a: 0.02, d: 0.3, s: 0.9, r: 0.3, oscs: [-28, -18, -7, 0, 7, 18, 28].map((d) => ({ type: 'sawtooth', detune: d })), hp: 120, cut: 6000, q: 0.7 })),
    M('sync', 'Sync Lead', 'lead', 4, (c, o, p) => fm(c, o, p, { level: 0.3, a: 0.005, d: 0.3, s: 0.7, r: 0.1, mRatio: 1, index: 4, indexDec: 0.5, indexFloor: 1.5, cRatio: 1 })),
    M('trancePluck', 'Trance Pluck', 'lead', 4, (c, o, p) => subtractive(c, o, p, { level: 0.35, a: 0.002, d: 0.3, s: 0.05, r: 0.12, oscs: [{ type: 'sawtooth', detune: -10 }, { type: 'sawtooth', detune: 10 }, { type: 'square', ratio: 0.5 }], cut: 300, q: 2, fenv: 7000, fd: 0.25 })),
    M('arp', 'Arp Pluck', 'lead', 4, (c, o, p) => subtractive(c, o, p, { level: 0.35, a: 0.002, d: 0.2, s: 0.02, r: 0.1, oscs: [{ type: 'square' }, { type: 'sawtooth', detune: 7 }], cut: 500, q: 3, fenv: 4000, fd: 0.15 })),
    M('flute', 'Flute', 'lead', 5, (c, o, p) => subtractive(c, o, p, { level: 0.4, a: 0.07, d: 0.1, s: 0.9, r: 0.2, oscs: [{ type: 'triangle' }, { type: 'sine', ratio: 2 }], cut: 2500, vib: { rate: 5, depth: 10 }, vibDelay: 0.3 })),
    M('whistle', 'Whistle', 'lead', 5, (c, o, p) => subtractive(c, o, p, { level: 0.35, a: 0.05, d: 0.1, s: 0.9, r: 0.15, oscs: [{ type: 'sine' }], vib: { rate: 6, depth: 25 }, vibDelay: 0.15 })),
    M('brass', 'Brass', 'lead', 3, (c, o, p) => subtractive(c, o, p, { level: 0.32, a: 0.06, d: 0.3, s: 0.8, r: 0.2, oscs: [{ type: 'sawtooth', detune: -5 }, { type: 'sawtooth', detune: 5 }, { type: 'sawtooth', ratio: 0.5 }], cut: 600, q: 1.5, fenv: 2500, fa: 0.08, fd: 0.4, drive: 1.5 })),
    M('hoover', 'Hoover', 'lead', 3, (c, o, p) => subtractive(c, o, p, { level: 0.3, a: 0.02, d: 0.2, s: 0.9, r: 0.25, oscs: [{ type: 'sawtooth', detune: -30 }, { type: 'sawtooth', detune: 30 }, { type: 'square', ratio: 0.5, glide: 0.75 }, { type: 'sawtooth', ratio: 0.5, detune: 12 }], cut: 2500, q: 1.2, drive: 2 })),
    M('bleep', 'Bleep', 'lead', 5, (c, o, p) => subtractive(c, o, p, { level: 0.3, a: 0.002, d: 0.08, s: 0.3, r: 0.05, oscs: [{ type: 'sine' }, { type: 'triangle', ratio: 2 }] })),
    /* pads */
    M('warmPad', 'Warm Pad', 'pad', 3, (c, o, p) => subtractive(c, o, p, { level: 0.3, a: 0.5, d: 0.5, s: 1, r: 1.2, oscs: [{ type: 'sawtooth', detune: -10 }, { type: 'sawtooth', detune: 10 }, { type: 'triangle', ratio: 0.5 }], cut: 1100, q: 0.8, flfo: { rate: 0.25, depth: 400 } })),
    M('strings', 'Strings', 'pad', 3, (c, o, p) => subtractive(c, o, p, { level: 0.28, a: 0.3, d: 0.4, s: 0.9, r: 0.8, oscs: [{ type: 'sawtooth', detune: -9 }, { type: 'sawtooth', detune: 9 }, { type: 'sawtooth', ratio: 2, detune: 4 }], hp: 180, cut: 3200, q: 0.7, vib: { rate: 5, depth: 7 }, vibDelay: 0.4 })),
    M('choir', 'Choir', 'pad', 3, (c, o, p) => formantPad(c, o, p, { level: 0.35, a: 0.45, d: 0.4, s: 1, r: 1.0, formants: [{ f: 700, q: 7, g: 1 }, { f: 1200, q: 8, g: 0.7 }, { f: 2600, q: 10, g: 0.25 }] })),
    M('airPad', 'Air Pad', 'pad', 4, (c, o, p) => additive(c, o, p, { level: 0.35, a: 0.8, d: 0.5, s: 1, r: 1.5, partials: [{ ratio: 1, level: 0.7 }, { ratio: 2.003, level: 0.3 }, { ratio: 3.002, level: 0.12 }, { ratio: 0.5, level: 0.2 }], vib: { rate: 0.4, depth: 6 } })),
    M('drone', 'Drone', 'pad', 2, (c, o, p) => subtractive(c, o, p, { level: 0.35, a: 0.6, d: 0.5, s: 1, r: 1.5, oscs: [{ type: 'sawtooth', detune: -5 }, { type: 'sawtooth', detune: 5, ratio: 0.5 }, { type: 'square', ratio: 0.25 }], cut: 500, q: 3, flfo: { rate: 0.12, depth: 350 }, drive: 1.5 })),
    M('glassPad', 'Glass Pad', 'pad', 4, (c, o, p) => subtractive(c, o, p, { level: 0.3, a: 0.4, d: 0.5, s: 1, r: 1.3, oscs: [{ type: 'sine' }, { type: 'triangle', ratio: 2, detune: 8 }, { type: 'sine', ratio: 3.01, detune: -6 }], cut: 4000, vib: { rate: 4.5, depth: 5 } })),
    M('dreamPad', 'Dream Pad', 'pad', 3, (c, o, p) => subtractive(c, o, p, { level: 0.3, a: 0.7, d: 0.5, s: 1, r: 1.8, oscs: [{ type: 'triangle', detune: -12 }, { type: 'sawtooth', detune: 12 }, { type: 'triangle', ratio: 2.002 }], cut: 900, q: 1.5, flfo: { rate: 0.18, depth: 600 } })),
  ];
  const INST_BY_ID = {};
  INSTRUMENTS.forEach((i) => { INST_BY_ID[i.id] = i; });

  /* ---------- reverb impulse ---------- */
  function makeImpulse(ctx, seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const x = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - x, decay) * (i < 200 ? i / 200 : 1);
      }
    }
    return buf;
  }

  /* ---------- Engine: master bus, fx, per-track buses ---------- */
  class Engine {
    constructor(ctx) {
      this.ctx = ctx;
      this.tracks = new Map();
      const bus = gain(ctx, 1);
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.18;
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -2; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.08;
      const master = gain(ctx, 0.9);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.8;
      chain([bus, comp, lim, master, analyser, ctx.destination]);
      /* reverb */
      const rev = ctx.createConvolver();
      rev.buffer = makeImpulse(ctx, 2.6, 3.2);
      const revIn = gain(ctx, 1), revOut = gain(ctx, 0.8);
      const revHp = filt(ctx, 'highpass', 220, 0.7);
      chain([revIn, revHp, rev, revOut, bus]);
      /* tempo delay */
      const dlyIn = gain(ctx, 1);
      const dly = ctx.createDelay(2);
      dly.delayTime.value = 0.375;
      const fb = gain(ctx, 0.42);
      const dlyLp = filt(ctx, 'lowpass', 3200, 0.5);
      const dlyHp = filt(ctx, 'highpass', 300, 0.7);
      const dlyOut = gain(ctx, 0.7);
      dlyIn.connect(dly); dly.connect(dlyLp); dlyLp.connect(dlyHp); dlyHp.connect(fb); fb.connect(dly); dlyHp.connect(dlyOut); dlyOut.connect(bus);
      /* pad bus for live playing */
      const pad = gain(ctx, 0.8);
      const padRev = gain(ctx, 0.2);
      pad.connect(bus); pad.connect(padRev); padRev.connect(revIn);
      Object.assign(this, { bus, comp, master, analyser, revIn, revOut, dlyIn, dly, dlyFb: fb, dlyOut, pad, padRev });
    }
    setMaster(m) {
      if (!m) return;
      const t = this.ctx.currentTime;
      if (m.vol !== undefined) this.master.gain.setTargetAtTime(m.vol, t, 0.02);
      if (m.rev !== undefined) this.revOut.gain.setTargetAtTime(m.rev, t, 0.02);
      if (m.dly !== undefined) this.dlyOut.gain.setTargetAtTime(m.dly, t, 0.02);
      if (m.dlyFb !== undefined) this.dlyFb.gain.setTargetAtTime(m.dlyFb, t, 0.02);
    }
    setTempo(bpm, dlyDiv) {
      const beat = 60 / bpm;
      const mult = { '1/8': 0.5, '1/8d': 0.75, '1/4': 1, '1/16': 0.25, '1/4t': 2 / 3 }[dlyDiv || '1/8d'];
      this.dly.delayTime.setTargetAtTime(beat * mult, this.ctx.currentTime, 0.05);
    }
    bus_(track) {
      let b = this.tracks.get(track.id);
      if (!b) {
        const ctx = this.ctx;
        const input = gain(ctx, 1);
        const tone = filt(ctx, 'lowpass', 18000, 0.5);
        const vol = gain(ctx, 0.8);
        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : gain(ctx, 1);
        const rev = gain(ctx, 0), dly = gain(ctx, 0);
        chain([input, tone, vol, pan, this.bus]);
        pan.connect(rev); rev.connect(this.revIn);
        pan.connect(dly); dly.connect(this.dlyIn);
        b = { input, tone, vol, pan, rev, dly };
        this.tracks.set(track.id, b);
      }
      return b;
    }
    sync(track, immediate) {
      const b = this.bus_(track);
      const t = this.ctx.currentTime, k = immediate ? 0.0001 : 0.02;
      b.vol.gain.setTargetAtTime(track.vol, t, k);
      if (b.pan.pan) b.pan.pan.setTargetAtTime(track.pan || 0, t, k);
      b.rev.gain.setTargetAtTime(track.rev || 0, t, k);
      b.dly.gain.setTargetAtTime(track.dly || 0, t, k);
      const tone = track.tone === undefined ? 1 : track.tone;
      b.tone.frequency.setTargetAtTime(200 * Math.pow(90, tone), t, k);
    }
    removeTrack(id) {
      const b = this.tracks.get(id);
      if (!b) return;
      try { b.input.disconnect(); b.pan.disconnect(); b.rev.disconnect(); b.dly.disconnect(); } catch (e) {}
      this.tracks.delete(id);
    }
    /* play a note on a track's bus */
    play(track, inst, p) {
      const b = this.bus_(track);
      try { inst.play(this.ctx, b.input, p); } catch (e) { console.warn('voice error', inst.id, e); }
    }
    /* play through the live pad bus */
    playPad(inst, p) {
      try { inst.play(this.ctx, this.pad, p); } catch (e) { console.warn('voice error', inst.id, e); }
    }
  }

  global.Synth = { NOTE_NAMES, SCALES, CHORDS, CATS, INSTRUMENTS, INST_BY_ID, mtof, degToMidi, chordDegs, noteName, Engine, clamp };
})(window);
