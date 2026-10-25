/* AudioBliss: step sequencer, UI, recording and export. */
(function () {
  'use strict';
  const S = window.Synth;
  const PRESETS = window.PRESETS;
  const SPB = 16, MAX_STEPS = 64, VERSION = (document.currentScript && (document.currentScript.src.split('v=')[1] || '')) || 'dev';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const uid = () => Math.random().toString(36).slice(2, 9);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const VEL = { 1: 0.78, 2: 1.0, 3: 0.42 };
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  /* ---------- project model ---------- */
  function blankSteps() { return Array.from({ length: MAX_STEPS }, () => ({ v: 0, deg: 0, len: 1 })); }
  function newTrack(instId, o) {
    const inst = S.INST_BY_ID[instId];
    return Object.assign({
      id: uid(), inst: instId, vol: 0.75, pan: 0, rev: 0.15, dly: 0, tone: 1, tune: 0,
      mute: false, solo: false, oct: inst.oct || 3, chord: 'none', gate: 0.9, lastDeg: 0, lastLen: 1,
      steps: blankSteps(),
    }, o || {});
  }
  function newProject() {
    return { name: 'Untitled groove', bpm: 120, swing: 0, root: 0, scale: 'minor', bars: 2, master: { vol: 0.9, rev: 0.5, dly: 0.45, dlyDiv: '1/8d' }, tracks: [] };
  }
  function fromPreset(t) {
    const p = newProject();
    Object.assign(p, { name: t.name, bpm: t.bpm, swing: t.swing || 0, root: t.root, scale: t.scale, bars: t.bars });
    Object.assign(p.master, t.master || {});
    p.tracks = t.tracks.map((tt) => {
      const tr = newTrack(tt.inst, {});
      ['vol', 'rev', 'dly', 'oct', 'chord', 'gate', 'tone', 'tune', 'pan'].forEach((k) => { if (tt[k] !== undefined) tr[k] = tt[k]; });
      if (tt.pat) {
        for (let i = 0; i < tt.pat.length && i < MAX_STEPS; i++) {
          const ch = tt.pat[i];
          tr.steps[i].v = ch === 'X' ? 2 : ch === 'x' ? 1 : ch === 'g' ? 3 : 0;
          if (S.INST_BY_ID[tt.inst].cat === 'fx' && tr.steps[i].v) tr.steps[i].len = 16;
        }
      }
      if (tt.notes) tt.notes.forEach(([s, d, l]) => { if (s < MAX_STEPS) Object.assign(tr.steps[s], { v: 1, deg: d, len: l || 1 }); });
      return tr;
    });
    return p;
  }
  function sanitize(p) {
    /* make a loaded project safe */
    const q = Object.assign(newProject(), p);
    q.master = Object.assign(newProject().master, p.master || {});
    q.tracks = (p.tracks || []).filter((t) => S.INST_BY_ID[t.inst]).map((t) => {
      const tr = Object.assign(newTrack(t.inst), t);
      tr.steps = blankSteps().map((s, i) => Object.assign(s, (t.steps && t.steps[i]) || {}));
      return tr;
    });
    if (![1, 2, 4].includes(q.bars)) q.bars = 2;
    return q;
  }

  /* ---------- state ---------- */
  let project = sanitize(LS.get('ab.current', null) || fromPreset(PRESETS[0]));
  let ctx = null, engine = null;
  let playing = false, stepIdx = 0, nextTime = 0, timer = null, queue = [], uiStep = -1;
  let viewBar = 0, follow = true, velMode = false;
  let recorder = null, recStart = 0, take = null;
  let downloadsCap = null;
  let wakeLock = null;
  const audioEl = $('#silent');

  /* ---------- audio bootstrap ---------- */
  function ensureAudio() {
    if (ctx) { if (ctx.state !== 'running') ctx.resume().catch(() => {}); return ctx; }
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    engine = new S.Engine(ctx);
    engine.setMaster(project.master);
    engine.setTempo(project.bpm, project.master.dlyDiv);
    project.tracks.forEach((t) => engine.sync(t, true));
    /* unlock on iOS: play a silent buffer plus a silent media element so the ring switch does not mute us */
    try { const b = ctx.createBuffer(1, 1, 22050); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch (e) {}
    try { audioEl.loop = true; audioEl.volume = 0.01; audioEl.play().catch(() => {}); } catch (e) {}
    ctx.resume().catch(() => {});
    visLoop();
    return ctx;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx) ctx.resume().catch(() => {}); });

  /* ---------- sequencing ---------- */
  const stepDur = () => 60 / project.bpm / 4;
  const totalSteps = () => project.bars * SPB;
  const swingOff = (i) => (i % 2 === 1 ? (project.swing / 100) * stepDur() / 3 : 0);

  function noteDur(tr, st, sd) { return Math.max(0.03, st.len * sd * (tr.gate || 0.9)); }

  function scheduleStep(eng, i, t, sd) {
    const anySolo = project.tracks.some((tr) => tr.solo);
    const beatHz = project.bpm / 60;
    for (const tr of project.tracks) {
      if (tr.mute || (anySolo && !tr.solo)) continue;
      const st = tr.steps[i];
      if (!st || !st.v) continue;
      triggerStep(eng, tr, st, t, sd, beatHz);
    }
  }
  function triggerStep(eng, tr, st, t, sd, beatHz) {
    const inst = S.INST_BY_ID[tr.inst];
    const vel = VEL[st.v] || 0.78;
    if (inst.kind === 'drum') {
      eng.play(tr, inst, { t, vel, dur: st.len * sd, tune: tr.tune || 0, beatHz });
    } else {
      const dur = noteDur(tr, st, sd);
      S.chordDegs(st.deg, tr.chord, project.scale).forEach((d, k) => {
        const n = S.degToMidi(d, project.root, project.scale, tr.oct) + (tr.tune || 0);
        eng.play(tr, inst, { t: t + k * 0.004, f: S.mtof(n), note: n, vel: vel * (k ? 0.8 : 1), dur, beatHz });
      });
    }
  }
  function tick() {
    const sd = stepDur();
    while (nextTime < ctx.currentTime + 0.14) {
      const t = nextTime + swingOff(stepIdx);
      scheduleStep(engine, stepIdx, t, sd);
      queue.push({ step: stepIdx, time: t });
      stepIdx = (stepIdx + 1) % totalSteps();
      nextTime += sd;
    }
  }
  function play() {
    ensureAudio();
    if (playing) return;
    playing = true;
    stepIdx = 0; queue = []; uiStep = -1;
    nextTime = ctx.currentTime + 0.06;
    timer = setInterval(tick, 25);
    tick();
    follow = true;
    $('#btnPlay').classList.add('is-on');
    $('#btnPlay').setAttribute('aria-label', 'Stop');
    requestAnimationFrame(phLoop);
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then((w) => { wakeLock = w; }).catch(() => {});
  }
  function stop() {
    if (!playing) return;
    playing = false;
    clearInterval(timer); timer = null;
    $('#btnPlay').classList.remove('is-on');
    $('#btnPlay').setAttribute('aria-label', 'Play');
    setPlayhead(-1);
    if (recorder) stopRecording();
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  function phLoop() {
    if (!playing) return;
    const now = ctx.currentTime;
    let changed = false;
    while (queue.length && queue[0].time <= now) { uiStep = queue.shift().step; changed = true; }
    if (changed) setPlayhead(uiStep);
    if (recorder) $('#recTime').textContent = fmtTime(now - recStart);
    requestAnimationFrame(phLoop);
  }
  let lastCol = -1;
  function setPlayhead(i) {
    if (i >= 0) {
      const bar = Math.floor(i / SPB);
      if (follow && bar !== viewBar) { viewBar = bar; lastCol = -1; renderBars(); renderTracks(); renderRollIfOpen(); }
      $$('.bartab').forEach((b, k) => b.classList.toggle('is-live', k === bar));
    } else $$('.bartab').forEach((b) => b.classList.remove('is-live'));
    const col = i >= 0 && Math.floor(i / SPB) === viewBar ? i % SPB : -1;
    if (col === lastCol) return;
    if (lastCol >= 0) $$('[data-c="' + lastCol + '"]').forEach((c) => c.classList.remove('ph'));
    if (col >= 0) $$('[data-c="' + col + '"]').forEach((c) => c.classList.add('ph'));
    lastCol = col;
  }

  /* ---------- visualiser ---------- */
  const vis = $('#vis'), vctx = vis.getContext('2d');
  let visData = null;
  function visLoop() {
    if (!engine) return;
    const a = engine.analyser;
    if (!visData) visData = new Uint8Array(a.frequencyBinCount);
    a.getByteFrequencyData(visData);
    const W = vis.width = vis.clientWidth * (window.devicePixelRatio || 1), H = vis.height = vis.clientHeight * (window.devicePixelRatio || 1);
    vctx.clearRect(0, 0, W, H);
    const bars = 40, bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const idx = Math.floor(Math.pow(i / bars, 1.7) * visData.length * 0.6);
      const v = visData[idx] / 255;
      const h = Math.max(2, v * H);
      const hue = 20 + (i / bars) * 300;
      vctx.fillStyle = 'hsla(' + hue + ',90%,65%,' + (0.25 + v * 0.75) + ')';
      vctx.fillRect(i * bw + 1, H - h, bw - 2, h);
    }
    requestAnimationFrame(visLoop);
  }

  /* ---------- recording ---------- */
  const WORKLET = `class C extends AudioWorkletProcessor{constructor(){super();this.n=0;this.l=new Float32Array(4096);this.r=new Float32Array(4096);}
process(inputs){const i=inputs[0];if(!i||!i.length)return true;const L=i[0],R=i[1]||i[0];for(let k=0;k<L.length;k++){this.l[this.n]=L[k];this.r[this.n]=R[k];this.n++;if(this.n>=4096){this.port.postMessage({l:this.l,r:this.r,n:this.n});this.l=new Float32Array(4096);this.r=new Float32Array(4096);this.n=0;}}return true;}}
registerProcessor('ab-cap',C);`;
  let workletReady = null;
  function loadWorklet() {
    if (workletReady) return workletReady;
    if (!ctx.audioWorklet) return (workletReady = Promise.resolve(false));
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    workletReady = ctx.audioWorklet.addModule(url).then(() => true).catch(() => false);
    return workletReady;
  }
  class Recorder {
    constructor() { this.chunks = []; this.frames = 0; this.node = null; this.sink = null; }
    push(l, r, n) {
      const out = new Int16Array(n * 2);
      for (let i = 0; i < n; i++) {
        const a = Math.max(-1, Math.min(1, l[i])), b = Math.max(-1, Math.min(1, r[i]));
        out[i * 2] = a < 0 ? a * 32768 : a * 32767; out[i * 2 + 1] = b < 0 ? b * 32768 : b * 32767;
      }
      this.chunks.push(out); this.frames += n;
    }
    async start() {
      const ok = await loadWorklet();
      const src = engine.master;
      if (ok) {
        this.node = new AudioWorkletNode(ctx, 'ab-cap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        this.node.port.onmessage = (e) => this.push(e.data.l, e.data.r, e.data.n);
      } else {
        this.node = ctx.createScriptProcessor(4096, 2, 2);
        this.node.onaudioprocess = (e) => this.push(e.inputBuffer.getChannelData(0), e.inputBuffer.getChannelData(Math.min(1, e.inputBuffer.numberOfChannels - 1)), e.inputBuffer.length);
      }
      this.sink = ctx.createGain(); this.sink.gain.value = 0;
      src.connect(this.node); this.node.connect(this.sink); this.sink.connect(ctx.destination);
    }
    stop() {
      try { engine.master.disconnect(this.node); this.node.disconnect(); this.sink.disconnect(); } catch (e) {}
      this.node.onaudioprocess = null;
      if (this.node.port) this.node.port.onmessage = null;
      return { blob: wavBlob(this.chunks, this.frames, ctx.sampleRate), seconds: this.frames / ctx.sampleRate };
    }
  }
  function wavBlob(chunks, frames, sr) {
    const dataLen = frames * 4;
    const buf = new ArrayBuffer(44 + dataLen), dv = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); str(8, 'WAVE'); str(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, sr, true);
    dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, dataLen, true);
    const out = new Int16Array(buf, 44);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return new Blob([buf], { type: 'audio/wav' });
  }
  function bufferToChunks(ab) {
    const n = ab.length, l = ab.getChannelData(0), r = ab.numberOfChannels > 1 ? ab.getChannelData(1) : l;
    const rec = new Recorder(); rec.push(l, r, n);
    return rec;
  }
  async function startRecording() {
    ensureAudio();
    recorder = new Recorder();
    await recorder.start();
    recStart = ctx.currentTime;
    $('#btnRec').classList.add('is-on');
    $('#recTime').hidden = false;
    $('#recTime').textContent = '0:00';
    if (!playing) play();
    toast('Recording. Tap the red button again to finish.');
  }
  function stopRecording() {
    if (!recorder) return;
    const r = recorder.stop(); recorder = null;
    $('#btnRec').classList.remove('is-on');
    $('#recTime').hidden = true;
    if (r.seconds < 0.3) { toast('Recording was too short.'); return; }
    setTake(r.blob, r.seconds, 'Recording');
  }
  function setTake(blob, seconds, kind) {
    if (take && take.url) URL.revokeObjectURL(take.url);
    take = { blob, seconds, url: URL.createObjectURL(blob), kind, name: fileSafe(project.name) + '-' + (kind === 'Recording' ? 'take' : 'loop') + '-' + stamp() + '.wav' };
    const card = $('#take');
    card.hidden = false;
    $('#takeTitle').textContent = kind + ' ready';
    $('#takeMeta').textContent = fmtTime(seconds) + ' · ' + Math.round(blob.size / 1024 / 102.4) / 10 + ' MB · WAV 16-bit';
    const au = $('#takeAudio'); au.src = take.url;
    $('#takeShare').hidden = !(navigator.canShare && window.File && navigator.canShare({ files: [new File([blob], take.name, { type: 'audio/wav' })] }));
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    updateSaveLabel();
  }
  async function renderLoop(loops) {
    const sd = stepDur(), total = totalSteps();
    const secs = total * sd * loops + 2.5;
    const sr = 44100;
    const off = new OfflineAudioContext(2, Math.ceil(secs * sr), sr);
    const eng = new S.Engine(off);
    eng.setMaster(project.master);
    eng.setTempo(project.bpm, project.master.dlyDiv);
    project.tracks.forEach((t) => eng.sync(t, true));
    for (let l = 0; l < loops; l++) for (let i = 0; i < total; i++) scheduleStep(eng, i, 0.05 + (l * total + i) * sd + swingOff(i), sd);
    const ab = await off.startRendering();
    const rec = bufferToChunks(ab);
    return { blob: wavBlob(rec.chunks, rec.frames, sr), seconds: secs };
  }

  /* ---------- saving files ---------- */
  function fileSafe(s) { return (s || 'audiobliss').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'audiobliss'; }
  function stamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()); }
  function fmtTime(s) { s = Math.max(0, s); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
  function capDownloads() {
    if (downloadsCap) return downloadsCap;
    downloadsCap = (window.claude && typeof window.claude.use === 'function') ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);
    return downloadsCap;
  }
  async function updateSaveLabel() {
    const dl = await capDownloads();
    $$('.save-wav-label').forEach((el) => { el.textContent = dl ? 'Save WAV (zipped)' : 'Save WAV'; });
  }
  async function saveFile(blob, filename) {
    const dl = await capDownloads();
    if (dl) {
      let data = blob, name = filename;
      if (/\.wav$/i.test(filename)) { data = await zipSingle(filename, blob); name = filename.replace(/\.wav$/i, '.zip'); }
      try { await dl.save({ filename: name, data }); toast('Saved ' + name); }
      catch (e) { if (e && e.code !== 'declined') toast('Could not save: ' + (e.message || e.code || 'unknown error')); }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    toast('Saving ' + filename);
  }
  async function shareFile(blob, filename) {
    try { await navigator.share({ files: [new File([blob], filename, { type: 'audio/wav' })], title: filename }); }
    catch (e) { if (e && e.name !== 'AbortError') toast('Sharing failed: ' + e.message); }
  }
  /* minimal stored ZIP writer (no compression) */
  const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  async function zipSingle(name, blob) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const nameB = new TextEncoder().encode(name);
    const crc = crc32(data);
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const local = new ArrayBuffer(30 + nameB.length), lv = new DataView(local);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true); lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameB.length, true); lv.setUint16(28, 0, true);
    new Uint8Array(local, 30).set(nameB);
    const cen = new ArrayBuffer(46 + nameB.length), cv = new DataView(cen);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameB.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, 0, true);
    new Uint8Array(cen, 46).set(nameB);
    const eocd = new ArrayBuffer(22), ev = new DataView(eocd);
    const cenOff = local.byteLength + data.length;
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true);
    ev.setUint32(12, cen.byteLength, true); ev.setUint32(16, cenOff, true); ev.setUint16(20, 0, true);
    return new Blob([local, data, cen, eocd], { type: 'application/zip' });
  }

  /* ---------- persistence ---------- */
  let saveTimer = null;
  function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(() => LS.set('ab.current', project), 400); }
  function touch() { persist(); }

  /* ---------- rendering ---------- */
  const trackColor = (tr) => S.CATS[S.INST_BY_ID[tr.inst].cat].color;
  const noteLetter = (tr, st) => S.NOTE_NAMES[((S.degToMidi(st.deg, project.root, project.scale, tr.oct) + (tr.tune || 0)) % 12 + 12) % 12];

  function renderAll() { renderHeader(); renderBars(); renderTracks(); renderTransport(); }
  function renderHeader() {
    $('#keyChip').textContent = S.NOTE_NAMES[project.root] + ' ' + S.SCALES[project.scale].name;
    $('#projName').textContent = project.name;
    $('#swingChip').textContent = project.swing ? 'Swing ' + project.swing + '%' : 'Straight';
  }
  function renderTransport() { $('#bpmVal').textContent = project.bpm; }
  function renderBars() {
    const wrap = $('#bartabs');
    wrap.innerHTML = Array.from({ length: project.bars }, (_, i) => '<button class="bartab' + (i === viewBar ? ' is-sel' : '') + '" data-bar="' + i + '">' + (i + 1) + '</button>').join('') +
      '<button class="bartab bartab-len" id="btnLen" title="Pattern length">' + project.bars + ' bar' + (project.bars > 1 ? 's' : '') + ' ▾</button>';
    $('#btnVel').classList.toggle('is-on', velMode);
  }
  function cellHTML(tr, i, inst) {
    const st = tr.steps[viewBar * SPB + i];
    const cls = ['cell']; if (st.v) cls.push('on', 'v' + st.v);
    const label = st.v && inst.kind === 'melodic' ? '<span>' + noteLetter(tr, st) + '</span>' : '';
    const tail = st.v && st.len > 1 ? ' style="--len:' + Math.min(st.len, SPB - i) + '"' : '';
    return '<button class="' + cls.join(' ') + '" data-c="' + i + '"' + tail + ' aria-label="Step ' + (i + 1) + '">' + label + '</button>';
  }
  function trackHTML(tr) {
    const inst = S.INST_BY_ID[tr.inst];
    const anySolo = project.tracks.some((t) => t.solo);
    const dim = tr.mute || (anySolo && !tr.solo);
    return '<section class="track' + (dim ? ' is-dim' : '') + '" data-id="' + tr.id + '" style="--tc:' + trackColor(tr) + '">' +
      '<div class="track-head">' +
      '<button class="tname" data-act="open"><span class="dot"></span><span class="tname-txt">' + esc(inst.name) + '</span>' +
      (inst.kind === 'melodic' ? '<span class="tsub">' + (tr.chord !== 'none' ? S.CHORDS[tr.chord].name + ' · ' : '') + 'oct ' + tr.oct + '</span>' : '<span class="tsub">' + S.CATS[inst.cat].name + '</span>') + '</button>' +
      '<div class="tbtns"><button class="tog' + (tr.mute ? ' is-on' : '') + '" data-act="mute" aria-label="Mute">M</button><button class="tog' + (tr.solo ? ' is-on is-solo' : '') + '" data-act="solo" aria-label="Solo">S</button></div>' +
      '</div>' +
      '<div class="steps" data-kind="' + inst.kind + '">' + Array.from({ length: SPB }, (_, i) => cellHTML(tr, i, inst)).join('') + '</div></section>';
  }
  function renderTracks() {
    const host = $('#tracks');
    host.innerHTML = project.tracks.map(trackHTML).join('');
    $('#empty').hidden = project.tracks.length > 0;
    if (lastCol >= 0) $$('[data-c="' + lastCol + '"]').forEach((c) => c.classList.add('ph'));
  }
  function renderTrack(tr) {
    const old = $('.track[data-id="' + tr.id + '"]');
    if (!old) return renderTracks();
    const tmp = document.createElement('div'); tmp.innerHTML = trackHTML(tr);
    old.replaceWith(tmp.firstElementChild);
    if (lastCol >= 0) $$('.track[data-id="' + tr.id + '"] [data-c="' + lastCol + '"]').forEach((c) => c.classList.add('ph'));
  }

  /* ---------- step editing ---------- */
  function toggleStep(tr, abs, forceOn) {
    const st = tr.steps[abs];
    const inst = S.INST_BY_ID[tr.inst];
    if (velMode) {
      if (!st.v) st.v = 1; else st.v = st.v === 1 ? 2 : st.v === 2 ? 3 : 1;
      if (inst.kind === 'melodic' && st.v === 1 && forceOn === undefined) {}
      return st.v > 0;
    }
    if (forceOn === undefined) forceOn = !st.v;
    if (forceOn) {
      st.v = st.v || 1;
      if (inst.kind === 'melodic') { st.deg = tr.lastDeg || 0; st.len = tr.lastLen || 1; }
      else st.len = inst.cat === 'fx' ? 16 : 1;
      preview(tr, st);
    } else st.v = 0;
    return forceOn;
  }
  function preview(tr, st) {
    if (!ctx || playing) return;
    triggerStep(engine, tr, st, ctx.currentTime + 0.01, stepDur(), project.bpm / 60);
  }
  let paint = null;
  const tracksHost = $('#tracks');
  tracksHost.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    ensureAudio();
    const sec = cell.closest('.track'); const tr = project.tracks.find((t) => t.id === sec.dataset.id);
    const abs = viewBar * SPB + Number(cell.dataset.c);
    const on = toggleStep(tr, abs);
    paint = { tr, on, done: new Set([abs]), id: e.pointerId, velMode };
    renderTrack(tr); touch();
    e.preventDefault();
  });
  tracksHost.addEventListener('pointermove', (e) => {
    if (!paint || paint.velMode || e.pointerId !== paint.id) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el && el.closest('.cell');
    if (!cell) return;
    const sec = cell.closest('.track');
    if (!sec || sec.dataset.id !== paint.tr.id) return;
    const abs = viewBar * SPB + Number(cell.dataset.c);
    if (paint.done.has(abs)) return;
    paint.done.add(abs);
    toggleStep(paint.tr, abs, paint.on);
    renderTrack(paint.tr); touch();
  });
  const endPaint = () => { paint = null; };
  window.addEventListener('pointerup', endPaint); window.addEventListener('pointercancel', endPaint);
  tracksHost.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const sec = b.closest('.track'); const tr = project.tracks.find((t) => t.id === sec.dataset.id);
    ensureAudio();
    if (b.dataset.act === 'mute') { tr.mute = !tr.mute; if (tr.mute) tr.solo = false; renderTracks(); touch(); }
    else if (b.dataset.act === 'solo') { tr.solo = !tr.solo; if (tr.solo) tr.mute = false; renderTracks(); touch(); }
    else if (b.dataset.act === 'open') openTrackSheet(tr);
  });
  $('#bartabs').addEventListener('click', (e) => {
    const b = e.target.closest('.bartab');
    if (!b) return;
    if (b.id === 'btnLen') { openLengthSheet(); return; }
    viewBar = Number(b.dataset.bar); follow = !playing ? true : false;
    renderBars(); renderTracks(); renderRollIfOpen(); lastCol = -1;
    if (playing && uiStep >= 0) setPlayhead(uiStep);
  });
  $('#btnVel').addEventListener('click', () => { velMode = !velMode; renderBars(); toast(velMode ? 'Velocity mode: tap steps to cycle normal, accent, ghost.' : 'Velocity mode off.'); });

  /* ---------- transport ---------- */
  $('#btnPlay').addEventListener('click', () => { ensureAudio(); playing ? stop() : play(); });
  $('#btnRec').addEventListener('click', () => { ensureAudio(); recorder ? stopRecording() : startRecording(); });
  $('#btnPads').addEventListener('click', () => { ensureAudio(); openPadsSheet(); });
  $('#bpmBtn').addEventListener('click', () => { ensureAudio(); openTempoSheet(); });
  function setBpm(v) {
    project.bpm = Math.round(S.clamp(v, 40, 240));
    renderTransport();
    if (engine) engine.setTempo(project.bpm, project.master.dlyDiv);
    const el = $('#tempoVal'); if (el) el.textContent = project.bpm;
    const sl = $('#tempoSlider'); if (sl && Number(sl.value) !== project.bpm) sl.value = project.bpm;
    touch();
  }
  function holdRepeat(btn, fn) {
    let t1, t2;
    const start = (e) => { e.preventDefault(); ensureAudio(); fn(); t1 = setTimeout(() => { t2 = setInterval(fn, 70); }, 420); };
    const end = () => { clearTimeout(t1); clearInterval(t2); };
    btn.addEventListener('pointerdown', start);
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => btn.addEventListener(ev, end));
  }
  holdRepeat($('#bpmDown'), () => setBpm(project.bpm - 1));
  holdRepeat($('#bpmUp'), () => setBpm(project.bpm + 1));

  /* ---------- take card ---------- */
  $('#takeSave').addEventListener('click', () => take && saveFile(take.blob, take.name));
  $('#takeShare').addEventListener('click', () => take && shareFile(take.blob, take.name));
  $('#takeClose').addEventListener('click', () => { $('#take').hidden = true; });

  /* ---------- sheet ---------- */
  const sheet = $('#sheet'), sheetBody = $('#sheetBody'), sheetTitle = $('#sheetTitle');
  let sheetKind = null, sheetTrack = null, rollOct = 0, rollLen = 1;
  function openSheet(kind, title, html) {
    sheetKind = kind; sheetTitle.textContent = title; sheetBody.innerHTML = html;
    sheet.hidden = false; document.body.classList.add('sheet-open');
    sheetBody.scrollTop = 0;
  }
  function closeSheet() { sheet.hidden = true; sheetKind = null; sheetTrack = null; document.body.classList.remove('sheet-open'); }
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#sheetBackdrop').addEventListener('click', closeSheet);

  const slider = (id, label, val, min, max, step, fmt) => '<label class="ctl"><span class="ctl-l">' + label + '<b data-out="' + id + '">' + (fmt ? fmt(val) : val) + '</b></span><input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '"></label>';
  const pct = (v) => Math.round(v * 100) + '%';
  const chips = (name, items, sel) => '<div class="chips" data-chips="' + name + '">' + items.map((it) => '<button class="chip' + (it.id === sel ? ' is-sel' : '') + '" data-val="' + it.id + '">' + esc(it.name) + '</button>').join('') + '</div>';

  /* track sheet */
  function openTrackSheet(tr) {
    sheetTrack = tr; rollOct = rollRangeFor(tr); rollLen = tr.lastLen || 1;
    const inst = S.INST_BY_ID[tr.inst];
    const mel = inst.kind === 'melodic';
    let html = '<div class="inst-row" style="--tc:' + trackColor(tr) + '"><span class="dot"></span><div><div class="inst-name">' + esc(inst.name) + '</div><div class="inst-cat">' + S.CATS[inst.cat].name + '</div></div><button class="btn" id="btnChangeInst">Change sound</button></div>';
    if (mel) html += '<div class="roll-wrap"><div class="roll-head"><span class="roll-title">Notes · bar ' + (viewBar + 1) + '</span><div class="roll-tools"><span class="roll-lbl">Length</span>' + chips('len', [1, 2, 4, 8, 16].map((n) => ({ id: n, name: n })), rollLen) + '<button class="btn sm" id="rollDown" aria-label="Lower octave">▼</button><button class="btn sm" id="rollUp" aria-label="Higher octave">▲</button></div></div><div id="roll"></div></div>';
    html += '<div class="ctl-grid">' +
      slider('tVol', 'Volume', tr.vol, 0, 1, 0.01, pct) +
      slider('tTone', 'Tone', tr.tone === undefined ? 1 : tr.tone, 0, 1, 0.01, pct) +
      slider('tRev', 'Reverb', tr.rev || 0, 0, 1, 0.01, pct) +
      slider('tDly', 'Delay', tr.dly || 0, 0, 1, 0.01, pct) +
      slider('tPan', 'Pan', tr.pan || 0, -1, 1, 0.05, (v) => (Math.abs(v) < 0.03 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100))) +
      (mel ? slider('tGate', 'Gate', tr.gate, 0.1, 1.5, 0.05, pct) : '') +
      slider('tTune', mel ? 'Transpose' : 'Tune', tr.tune || 0, -12, 12, 1, (v) => (v > 0 ? '+' : '') + v + ' st') +
      '</div>';
    if (mel) html += '<div class="ctl-row"><span class="ctl-l">Octave</span><div class="stepper"><button class="btn sm" data-oct="-1">−</button><b id="octVal">' + tr.oct + '</b><button class="btn sm" data-oct="1">+</button></div></div>' +
      '<div class="ctl-row"><span class="ctl-l">Chord</span>' + chips('chord', Object.keys(S.CHORDS).map((k) => ({ id: k, name: S.CHORDS[k].name })), tr.chord) + '</div>';
    html += '<div class="ctl-row"><span class="ctl-l">Pattern</span><div class="btn-row">' +
      '<button class="btn sm" data-pat="clear">Clear bar</button><button class="btn sm" data-pat="clearAll">Clear all</button><button class="btn sm" data-pat="random">Random</button>' +
      '<button class="btn sm" data-pat="left">◀ Shift</button><button class="btn sm" data-pat="right">Shift ▶</button><button class="btn sm" data-pat="copy">Copy bar to all</button></div></div>';
    html += '<div class="ctl-row danger-row"><button class="btn sm" data-pat="dup">Duplicate track</button><button class="btn sm danger" id="btnDelTrack">Delete track</button></div>';
    openSheet('track', 'Track', html);
    renderRoll();
    $$('#sheetBody input[type=range]').forEach((inp) => inp.addEventListener('input', onTrackSlider));
  }
  function onTrackSlider(e) {
    const tr = sheetTrack; if (!tr) return;
    const v = Number(e.target.value), id = e.target.id;
    const map = { tVol: 'vol', tTone: 'tone', tRev: 'rev', tDly: 'dly', tPan: 'pan', tGate: 'gate', tTune: 'tune' };
    tr[map[id]] = v;
    const out = $('[data-out="' + id + '"]');
    if (out) out.textContent = id === 'tTune' ? (v > 0 ? '+' : '') + v + ' st' : id === 'tPan' ? (Math.abs(v) < 0.03 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)) : pct(v);
    if (engine) engine.sync(tr);
    if (id === 'tTune') { renderTrack(tr); renderRoll(); }
    touch();
  }
  function rollRangeFor(tr) {
    const n = S.SCALES[project.scale].steps.length;
    const degs = tr.steps.slice(viewBar * SPB, viewBar * SPB + SPB).filter((s) => s.v).map((s) => s.deg);
    if (!degs.length) return 0;
    return Math.floor(Math.min.apply(null, degs) / n);
  }
  function renderRollIfOpen() { if (sheetKind === 'track' && sheetTrack) { const t = $('.roll-title'); if (t) t.textContent = 'Notes · bar ' + (viewBar + 1); renderRoll(); } }
  function renderRoll() {
    const host = $('#roll'); const tr = sheetTrack;
    if (!host || !tr) return;
    const sc = S.SCALES[project.scale].steps, n = sc.length;
    const rows = [];
    for (let d = 2 * n - 1 + rollOct * n; d >= rollOct * n; d--) rows.push(d);
    let html = '<div class="roll" style="--tc:' + trackColor(tr) + '">';
    rows.forEach((d) => {
      const midi = S.degToMidi(d, project.root, project.scale, tr.oct) + (tr.tune || 0);
      const isRoot = ((d % n) + n) % n === 0;
      html += '<div class="roll-row' + (isRoot ? ' is-root' : '') + '"><span class="roll-note">' + S.noteName(midi) + '</span>';
      for (let i = 0; i < SPB; i++) {
        const st = tr.steps[viewBar * SPB + i];
        const on = st.v && st.deg === d;
        html += '<button class="rcell' + (on ? ' on' : '') + '" data-c="' + i + '" data-d="' + d + '"' + (on && st.len > 1 ? ' style="--len:' + Math.min(st.len, SPB - i) + '"' : '') + ' aria-label="' + S.noteName(midi) + ' step ' + (i + 1) + '"></button>';
      }
      html += '</div>';
    });
    host.innerHTML = html + '</div>';
    if (lastCol >= 0) $$('#roll [data-c="' + lastCol + '"]').forEach((c) => c.classList.add('ph'));
  }
  sheetBody.addEventListener('pointerdown', (e) => {
    const rc = e.target.closest('.rcell');
    if (!rc || !sheetTrack) return;
    ensureAudio();
    const tr = sheetTrack, i = Number(rc.dataset.c), d = Number(rc.dataset.d);
    const st = tr.steps[viewBar * SPB + i];
    if (st.v && st.deg === d) st.v = 0;
    else { st.v = st.v || 1; st.deg = d; st.len = rollLen; tr.lastDeg = d; tr.lastLen = rollLen; preview(tr, st); }
    renderRoll(); renderTrack(tr); touch();
    e.preventDefault();
  });
  sheetBody.addEventListener('click', (e) => {
    const t = e.target;
    const chip = t.closest('.chip');
    const group = chip && chip.closest('[data-chips]');
    if (group) { onChip(group.dataset.chips, chip.dataset.val, chip); return; }
    if (t.id === 'btnChangeInst') { openInstPicker(sheetTrack); return; }
    if (t.id === 'rollUp') { rollOct++; renderRoll(); return; }
    if (t.id === 'rollDown') { rollOct--; renderRoll(); return; }
    const octBtn = t.closest('[data-oct]');
    if (octBtn && sheetTrack) { sheetTrack.oct = S.clamp(sheetTrack.oct + Number(octBtn.dataset.oct), 0, 7); $('#octVal').textContent = sheetTrack.oct; renderRoll(); renderTrack(sheetTrack); touch(); return; }
    const patBtn = t.closest('[data-pat]');
    if (patBtn && sheetTrack) { patternTool(sheetTrack, patBtn.dataset.pat); return; }
    if (t.id === 'btnDelTrack' && sheetTrack) {
      if (t.dataset.armed) { const id = sheetTrack.id; project.tracks = project.tracks.filter((x) => x.id !== id); if (engine) engine.removeTrack(id); closeSheet(); renderTracks(); touch(); }
      else { t.dataset.armed = '1'; t.textContent = 'Tap again to delete'; }
      return;
    }
    const d = (k) => t.closest('[data-' + k + ']');
    let b;
    if ((b = d('inst'))) { pickInstrument(b.dataset.inst); return; }
    if ((b = d('confirm'))) { doLoadPreset(b.dataset.confirm); return; }
    if ((b = d('cancel'))) { const c = b.closest('.confirm'); const card = c && c.previousElementSibling; if (card) card.classList.remove('is-armed'); if (c) c.remove(); return; }
    if ((b = d('preset'))) { loadPreset(b.dataset.preset, b); return; }
    if ((b = d('load'))) { loadSaved(b.dataset.load); return; }
    if ((b = d('del'))) { deleteSaved(b.dataset.del, b); return; }
    if (t.id === 'btnSaveProj') { saveProject(); return; }
    if (t.id === 'btnExportJson') { saveFile(new Blob([JSON.stringify(project)], { type: 'application/json' }), fileSafe(project.name) + '.json'); return; }
    if ((b = d('loops'))) { exportLoop(Number(b.dataset.loops), b); return; }
    if ((b = d('tempo'))) { setBpm(Number(b.dataset.tempo)); return; }
    if (t.id === 'tapTempo') { tapTempo(); return; }
    if ((b = d('bpmd'))) { setBpm(project.bpm + Number(b.dataset.bpmd)); return; }
    if ((b = d('bars'))) { setBars(Number(b.dataset.bars)); return; }
    if (t.id === 'btnNewProj') { newBlank(); return; }
  });
  function onChip(group, val, chipEl) {
    const wrap = chipEl.closest('[data-chips]');
    $$('.chip', wrap).forEach((c) => c.classList.toggle('is-sel', c === chipEl));
    if (group === 'len') { rollLen = Number(val); if (sheetTrack) sheetTrack.lastLen = rollLen; }
    else if (group === 'chord' && sheetTrack) { sheetTrack.chord = val; renderTrack(sheetTrack); touch(); }
    else if (group === 'cat') { renderInstList(val); }
    else if (group === 'root') { project.root = Number(val); onKeyChange(); }
    else if (group === 'scale') { project.scale = val; onKeyChange(); }
    else if (group === 'dlyDiv') { project.master.dlyDiv = val; if (engine) engine.setTempo(project.bpm, val); touch(); }
    else if (group === 'padInst') { padInst = val; renderPads(); }
  }
  function onKeyChange() { renderHeader(); renderTracks(); renderRollIfOpen(); touch(); }
  function patternTool(tr, op) {
    const a = viewBar * SPB, inst = S.INST_BY_ID[tr.inst];
    const seg = tr.steps.slice(a, a + SPB);
    if (op === 'clear') seg.forEach((s) => { s.v = 0; });
    else if (op === 'clearAll') tr.steps.forEach((s) => { s.v = 0; });
    else if (op === 'random') {
      const dens = inst.kind === 'drum' ? 0.35 : 0.3;
      const n = S.SCALES[project.scale].steps.length;
      seg.forEach((s, i) => { const on = Math.random() < dens + (i % 4 === 0 ? 0.25 : 0); s.v = on ? (Math.random() < 0.2 ? 2 : 1) : 0; if (on && inst.kind === 'melodic') { s.deg = Math.floor(Math.random() * (n + 3)) - 1; s.len = [1, 1, 2, 2, 4][Math.floor(Math.random() * 5)]; } });
    } else if (op === 'left' || op === 'right') {
      const copy = seg.map((s) => Object.assign({}, s));
      for (let i = 0; i < SPB; i++) Object.assign(tr.steps[a + i], copy[(i + (op === 'left' ? 1 : SPB - 1)) % SPB]);
    } else if (op === 'copy') {
      for (let b = 0; b < 4; b++) if (b !== viewBar) for (let i = 0; i < SPB; i++) Object.assign(tr.steps[b * SPB + i], seg[i]);
    } else if (op === 'dup') {
      const copy = JSON.parse(JSON.stringify(tr)); copy.id = uid(); copy.solo = false;
      project.tracks.splice(project.tracks.indexOf(tr) + 1, 0, copy);
      if (engine) engine.sync(copy, true);
      closeSheet(); renderTracks(); touch(); toast('Track duplicated.'); return;
    }
    renderTrack(tr); renderRoll(); touch();
  }

  /* instrument picker */
  let pickerTarget = null, pickerCat = 'drums';
  function openInstPicker(tr) {
    pickerTarget = tr;
    pickerCat = tr ? S.INST_BY_ID[tr.inst].cat : pickerCat;
    openSheet('inst', tr ? 'Change sound' : 'Add instrument', chips('cat', Object.keys(S.CATS).map((k) => ({ id: k, name: S.CATS[k].name })), pickerCat) + '<div id="instList" class="inst-grid"></div><p class="hint">Tap a sound to hear it. Tap again to use it.</p>');
    renderInstList(pickerCat);
  }
  let lastPreviewed = null;
  function renderInstList(cat) {
    pickerCat = cat;
    const host = $('#instList');
    host.innerHTML = S.INSTRUMENTS.filter((i) => i.cat === cat).map((i) => '<button class="inst-btn' + (pickerTarget && pickerTarget.inst === i.id ? ' is-sel' : '') + '" data-inst="' + i.id + '" style="--tc:' + S.CATS[cat].color + '">' + esc(i.name) + '</button>').join('');
    lastPreviewed = null;
  }
  function previewInst(inst) {
    ensureAudio();
    const t = ctx.currentTime + 0.01, beatHz = project.bpm / 60;
    if (inst.kind === 'drum') engine.playPad(inst, { t, vel: 0.9, dur: 0.5, tune: 0, beatHz });
    else { const n = S.degToMidi(0, project.root, project.scale, inst.oct); engine.playPad(inst, { t, vel: 0.85, dur: 0.45, f: S.mtof(n), note: n, beatHz }); }
  }
  function pickInstrument(id) {
    const inst = S.INST_BY_ID[id];
    previewInst(inst);
    if (lastPreviewed !== id) {
      lastPreviewed = id;
      $$('.inst-btn').forEach((b) => b.classList.toggle('is-armed', b.dataset.inst === id));
      return;
    }
    if (pickerTarget) {
      const was = S.INST_BY_ID[pickerTarget.inst];
      pickerTarget.inst = id;
      if (was.kind !== inst.kind) { pickerTarget.chord = 'none'; if (inst.kind === 'melodic') pickerTarget.steps.forEach((s) => { s.len = 1; }); }
      if (inst.kind === 'melodic' && was.kind !== 'melodic') pickerTarget.oct = inst.oct;
      renderTrack(pickerTarget);
      openTrackSheet(pickerTarget);
    } else {
      const tr = newTrack(id, {});
      project.tracks.push(tr);
      if (engine) engine.sync(tr, true);
      renderTracks(); closeSheet();
      toast(inst.name + ' added. Tap steps to program it.');
    }
    touch();
  }
  $('#btnAdd').addEventListener('click', () => { ensureAudio(); openInstPicker(null); });
  $('#emptyAdd').addEventListener('click', () => { ensureAudio(); openInstPicker(null); });

  /* tempo sheet */
  function openTempoSheet() {
    const presets = [['Hip-hop', 90], ['Lo-fi', 78], ['House', 124], ['Techno', 132], ['Trap', 140], ['Garage', 134], ['D&B', 174]];
    openSheet('tempo', 'Tempo',
      '<div class="tempo-big"><button class="btn round" data-bpmd="-1" aria-label="Slower">−</button><div class="tempo-num"><b id="tempoVal">' + project.bpm + '</b><span>BPM</span></div><button class="btn round" data-bpmd="1" aria-label="Faster">+</button></div>' +
      '<input type="range" id="tempoSlider" min="40" max="240" step="1" value="' + project.bpm + '" class="wide">' +
      '<div class="btn-row center"><button class="btn" id="tapTempo">Tap tempo</button><button class="btn" data-bpmd="-10">−10</button><button class="btn" data-bpmd="10">+10</button></div>' +
      '<div class="chips">' + presets.map((p) => '<button class="chip" data-tempo="' + p[1] + '">' + p[0] + ' ' + p[1] + '</button>').join('') + '</div>' +
      '<div class="ctl-grid one">' + slider('swing', 'Swing', project.swing, 0, 100, 1, (v) => v + '%') + '</div>');
    $('#tempoSlider').addEventListener('input', (e) => setBpm(Number(e.target.value)));
    $('#swing').addEventListener('input', (e) => { project.swing = Number(e.target.value); $('[data-out="swing"]').textContent = project.swing + '%'; renderHeader(); touch(); });
  }
  let taps = [];
  function tapTempo() {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    if (taps.length >= 2) {
      const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      setBpm(60000 / iv);
    }
    if (taps.length > 8) taps.shift();
  }

  /* length sheet */
  function openLengthSheet() {
    openSheet('len', 'Pattern length', '<p class="hint">Longer patterns keep what you have programmed. Bars you cannot see still play.</p><div class="btn-row big">' + [1, 2, 4].map((b) => '<button class="btn' + (project.bars === b ? ' is-sel' : '') + '" data-bars="' + b + '">' + b + ' bar' + (b > 1 ? 's' : '') + '</button>').join('') + '</div>');
  }
  function setBars(b) { project.bars = b; if (viewBar >= b) viewBar = 0; if (stepIdx >= totalSteps()) stepIdx = 0; renderBars(); renderTracks(); closeSheet(); touch(); }

  /* settings sheet */
  $('#btnSettings').addEventListener('click', () => {
    ensureAudio();
    openSheet('settings', 'Key & mix',
      '<div class="ctl-row"><span class="ctl-l">Project name</span><input type="text" id="projNameIn" class="text" value="' + esc(project.name) + '" maxlength="40"></div>' +
      '<div class="ctl-row"><span class="ctl-l">Key</span>' + chips('root', S.NOTE_NAMES.map((n, i) => ({ id: i, name: n })), project.root) + '</div>' +
      '<div class="ctl-row"><span class="ctl-l">Scale</span>' + chips('scale', Object.keys(S.SCALES).map((k) => ({ id: k, name: S.SCALES[k].name })), project.scale) + '</div>' +
      '<p class="hint">Changing key or scale moves every melodic track with it, so everything stays in tune.</p>' +
      '<div class="ctl-grid">' + slider('mVol', 'Master volume', project.master.vol, 0, 1, 0.01, pct) + slider('mRev', 'Reverb amount', project.master.rev, 0, 1, 0.01, pct) + slider('mDly', 'Delay amount', project.master.dly, 0, 1, 0.01, pct) + '</div>' +
      '<p class="hint">AudioBliss build ' + esc(VERSION) + '</p>' +
      '<div class="ctl-row"><span class="ctl-l">Delay time</span>' + chips('dlyDiv', [['1/16', '1/16'], ['1/8', '1/8'], ['1/8d', 'Dotted 1/8'], ['1/4t', 'Triplet'], ['1/4', '1/4']].map((x) => ({ id: x[0], name: x[1] })), project.master.dlyDiv) + '</div>');
    $('#projNameIn').addEventListener('input', (e) => { project.name = e.target.value || 'Untitled groove'; renderHeader(); touch(); });
    ['mVol', 'mRev', 'mDly'].forEach((id) => $('#' + id).addEventListener('input', (e) => {
      const v = Number(e.target.value); project.master[{ mVol: 'vol', mRev: 'rev', mDly: 'dly' }[id]] = v;
      $('[data-out="' + id + '"]').textContent = pct(v); if (engine) engine.setMaster(project.master); touch();
    }));
  });

  /* grooves sheet */
  $('#btnGrooves').addEventListener('click', () => {
    ensureAudio();
    openSheet('grooves', 'Grooves', '<p class="hint">Starting points. Loading one replaces the current pattern, so save first if you want to keep it.</p><div class="preset-list">' +
      PRESETS.map((p) => '<button class="preset" data-preset="' + p.id + '"><span class="preset-name">' + esc(p.name) + '</span><span class="preset-meta">' + p.bpm + ' BPM · ' + S.NOTE_NAMES[p.root] + ' ' + S.SCALES[p.scale].name + ' · ' + p.bars + ' bar' + (p.bars > 1 ? 's' : '') + '</span><span class="preset-blurb">' + esc(p.blurb) + '</span></button>').join('') + '</div>');
  });
  function loadPreset(id, btn) {
    const hasWork = project.tracks.some((t) => t.steps.some((s) => s.v));
    if (hasWork && !btn.classList.contains('is-armed')) {
      $$('.preset.is-armed').forEach((p) => { p.classList.remove('is-armed'); const c = p.querySelector('.confirm'); if (c) c.remove(); });
      btn.classList.add('is-armed');
      const c = document.createElement('div'); c.className = 'confirm';
      c.innerHTML = '<span>Replace the current pattern?</span><button class="btn sm primary" type="button" data-confirm="' + id + '">Load groove</button><button class="btn sm" type="button" data-cancel="1">Keep mine</button>';
      btn.after(c);
      return;
    }
    doLoadPreset(id);
  }
  function doLoadPreset(id) {
    loadProject(fromPreset(PRESETS.find((p) => p.id === id)));
    closeSheet(); toast(project.name + ' loaded.');
    if (!playing) play();
  }
  function loadProject(p) {
    const wasPlaying = playing; if (wasPlaying) stop();
    if (engine) project.tracks.forEach((t) => engine.removeTrack(t.id));
    project = sanitize(p); viewBar = 0; velMode = false;
    if (engine) { engine.setMaster(project.master); engine.setTempo(project.bpm, project.master.dlyDiv); project.tracks.forEach((t) => engine.sync(t, true)); }
    renderAll(); touch();
    if (wasPlaying) play();
  }
  function newBlank() { loadProject(fromPreset(PRESETS.find((p) => p.id === 'blank'))); closeSheet(); toast('New empty kit. Add instruments and tap steps.'); }

  /* projects sheet */
  $('#btnSave').addEventListener('click', () => { ensureAudio(); openProjectsSheet(); });
  function openProjectsSheet() {
    const saved = LS.get('ab.projects', []);
    openSheet('projects', 'Save & export',
      '<div class="ctl-row"><span class="ctl-l">Export audio</span><p class="hint tight">Renders the whole pattern offline at 44.1 kHz, exactly on the grid, with the reverb tail.</p><div class="btn-row">' + [1, 2, 4, 8].map((n) => '<button class="btn" data-loops="' + n + '">' + n + '× loop</button>').join('') + '</div><p class="hint tight">Or use the red record button to capture a live performance with mutes, pads and tempo changes.</p></div>' +
      '<div class="ctl-row"><span class="ctl-l">Save in this browser</span><div class="save-row"><input type="text" id="saveName" class="text" value="' + esc(project.name) + '" maxlength="40"><button class="btn" id="btnSaveProj">Save</button></div></div>' +
      '<div class="saved-list" id="savedList">' + (saved.length ? saved.map((s) => '<div class="saved"><button class="saved-main" data-load="' + s.id + '"><span class="preset-name">' + esc(s.name) + '</span><span class="preset-meta">' + s.bpm + ' BPM · ' + s.tracks + ' tracks · ' + new Date(s.date).toLocaleDateString() + '</span></button><button class="btn sm danger" data-del="' + s.id + '">Delete</button></div>').join('') : '<p class="hint">Nothing saved yet.</p>') + '</div>' +
      '<div class="ctl-row"><span class="ctl-l">Project file</span><div class="btn-row"><button class="btn" id="btnExportJson">Export .json</button><label class="btn file">Import .json<input type="file" id="importJson" accept="application/json,.json"></label><button class="btn" id="btnNewProj">New empty kit</button></div></div>');
    $('#importJson').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return;
      f.text().then((txt) => { loadProject(JSON.parse(txt)); closeSheet(); toast('Imported ' + project.name + '.'); }).catch(() => toast('That file is not an AudioBliss project.'));
    });
  }
  function saveProject() {
    const name = ($('#saveName').value || 'Untitled groove').trim();
    project.name = name; renderHeader();
    const saved = LS.get('ab.projects', []);
    const entry = { id: uid(), name, date: Date.now(), bpm: project.bpm, tracks: project.tracks.length, project: JSON.parse(JSON.stringify(project)) };
    const ix = saved.findIndex((s) => s.name === name);
    if (ix >= 0) saved[ix] = entry; else saved.unshift(entry);
    LS.set('ab.projects', saved.slice(0, 40));
    touch(); openProjectsSheet(); toast('Saved "' + name + '" in this browser.');
  }
  function loadSaved(id) { const s = LS.get('ab.projects', []).find((x) => x.id === id); if (!s) return; loadProject(s.project); closeSheet(); toast(project.name + ' loaded.'); }
  function deleteSaved(id, btn) {
    if (!btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Sure?'; return; }
    LS.set('ab.projects', LS.get('ab.projects', []).filter((x) => x.id !== id)); openProjectsSheet();
  }
  async function exportLoop(loops, btn) {
    ensureAudio();
    if (!project.tracks.some((t) => t.steps.some((s) => s.v))) { toast('Nothing to export yet. Program some steps first.'); return; }
    btn.textContent = 'Rendering…'; btn.disabled = true;
    try {
      const r = await renderLoop(loops);
      closeSheet(); setTake(r.blob, r.seconds, 'Export');
    } catch (e) { toast('Export failed: ' + e.message); btn.textContent = loops + '× loop'; btn.disabled = false; }
  }

  /* pads sheet */
  const KIT = ['kick808', 'snare', 'clap', 'hatC', 'hatO', 'rim', 'tomL', 'tomH', 'cowbell', 'clave', 'shaker', 'snap', 'crash', 'ride', 'conga', 'laser'];
  let padInst = 'kit';
  function openPadsSheet() {
    const opts = [{ id: 'kit', name: 'Drum kit' }].concat(project.tracks.filter((t) => S.INST_BY_ID[t.inst].kind === 'melodic').map((t) => ({ id: t.id, name: S.INST_BY_ID[t.inst].name })));
    if (!opts.some((o) => o.id === padInst)) padInst = 'kit';
    openSheet('pads', 'Play live', chips('padInst', opts, padInst) + '<div id="pads" class="pads"></div><p class="hint">Pads play through the master mix, so hits land in your recording. Add a melodic track to play its sound here.</p>');
    renderPads();
  }
  function renderPads() {
    const host = $('#pads'); if (!host) return;
    if (padInst === 'kit') host.innerHTML = KIT.map((id) => { const i = S.INST_BY_ID[id]; return '<button class="pad" data-pad="' + id + '" style="--tc:' + S.CATS[i.cat].color + '">' + esc(i.name) + '</button>'; }).join('');
    else {
      const tr = project.tracks.find((t) => t.id === padInst); if (!tr) return;
      const cells = [];
      for (let r = 3; r >= 0; r--) for (let c = 0; c < 4; c++) { const d = r * 4 + c; const midi = S.degToMidi(d, project.root, project.scale, tr.oct) + (tr.tune || 0); cells.push('<button class="pad" data-pad="' + tr.id + '" data-deg="' + d + '" style="--tc:' + trackColor(tr) + '">' + S.noteName(midi) + '</button>'); }
      host.innerHTML = cells.join('');
    }
  }
  sheetBody.addEventListener('pointerdown', (e) => {
    const pad = e.target.closest('.pad'); if (!pad) return;
    e.preventDefault(); ensureAudio();
    pad.classList.add('is-hit'); setTimeout(() => pad.classList.remove('is-hit'), 120);
    const t = ctx.currentTime + 0.005, beatHz = project.bpm / 60;
    if (padInst === 'kit') { engine.playPad(S.INST_BY_ID[pad.dataset.pad], { t, vel: 0.9, dur: 0.5, tune: 0, beatHz }); return; }
    const tr = project.tracks.find((x) => x.id === pad.dataset.pad); if (!tr) return;
    const inst = S.INST_BY_ID[tr.inst];
    const dur = inst.cat === 'pad' ? 1.2 : inst.cat === 'bass' ? 0.35 : 0.6;
    S.chordDegs(Number(pad.dataset.deg), tr.chord, project.scale).forEach((d, k) => { const n = S.degToMidi(d, project.root, project.scale, tr.oct) + (tr.tune || 0); engine.play(tr, inst, { t: t + k * 0.004, f: S.mtof(n), note: n, vel: 0.9, dur, beatHz }); });
  });

  /* ---------- misc ---------- */
  let toastTimer = null;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 300); }, 2800); }
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); ensureAudio(); playing ? stop() : play(); }
    if (e.key === 'Escape' && !sheet.hidden) closeSheet();
  });
  window.addEventListener('beforeunload', () => { LS.set('ab.current', project); });

  renderAll();
  updateSaveLabel();
})();
