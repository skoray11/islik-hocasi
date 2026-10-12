/*
 * Islık Hocası — arayüz, akort modu ve şarkı çalışma modları.
 */
(function () {
  'use strict';

  const { PitchDetector, PitchTracker } = window.WhistlePitch;
  const M = window.WhistleMusic;
  const engine = new window.WhistleAudio.AudioEngine();

  const TEST_MODE = new URLSearchParams(location.search).has('test');
  const LATENCY = 0.045; // analiz penceresinin ortası + giriş gecikmesi (s)
  const CLARITY_MIN = 0.35; // bu netliğin altı ıslık sayılmaz
  const TRACE_SECONDS = 14;
  const STEP_SPB = 0.5; // adım adım modda ruloda vuruş başına gösterim süresi (s)
  const RING = 339.29; // tutma halkasının çevresi (2π·54)

  // ---------- kalıcı durum ----------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('islik.' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('islik.' + key, JSON.stringify(value));
      } catch (_) {
        // gizli pencere vb.: kaydetmeden devam
      }
    },
  };

  const DEFAULTS = {
    naming: 'solfege',
    tolerance: 25,
    holdMs: 400,
    gateDb: -50,
    octaveFree: true,
    headphones: false,
    refBeforeNote: false,
    accompany: false,
    a4: 440,
  };
  const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  let range = store.get('range', null); // { lo, hi } midi
  let customSongs = store.get('songs', []);
  const best = store.get('best', {}); // "şarkı:mod" → puan
  const keys = store.get('keys', {}); // şarkı → ton kaydırma

  const ui = {
    mode: 'tuner',
    practice: store.get('practice', 'step'),
    songId: store.get('songId', 'twinkle'),
    bpm: 90,
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    meterCard: $('meterCard'), noteName: $('noteName'), noteOct: $('noteOct'), ringFg: $('ringFg'),
    gauge: $('gauge'), readLeft: $('readLeft'), readRight: $('readRight'), hint: $('hint'),
    rangeOut: $('rangeOut'), rangeReset: $('rangeReset'),
    songSelect: $('songSelect'), addSongBtn: $('addSongBtn'), delSongBtn: $('delSongBtn'),
    keyDown: $('keyDown'), keyUp: $('keyUp'), keyOut: $('keyOut'), keyFromMe: $('keyFromMe'), keyFit: $('keyFit'),
    practiceSeg: $('practiceSeg'), bpm: $('bpm'), bpmOut: $('bpmOut'),
    startBtn: $('startBtn'), listenBtn: $('listenBtn'), refBtn: $('refBtn'), bestOut: $('bestOut'),
    roll: $('roll'), countdown: $('countdown'), chips: $('chips'),
    micDot: $('micDot'), statusText: $('statusText'), levelFill: $('levelFill'), levelGate: $('levelGate'),
    startOverlay: $('startOverlay'), micBtn: $('micBtn'), micError: $('micError'),
    settingsBtn: $('settingsBtn'), settingsDlg: $('settingsDlg'),
    songDlg: $('songDlg'), songName: $('songName'), songText: $('songText'), songBpm: $('songBpm'),
    parseOut: $('parseOut'), songPreview: $('songPreview'), songSave: $('songSave'),
    resultDlg: $('resultDlg'), resStars: $('resStars'), resScore: $('resScore'), resTitle: $('resTitle'),
    resSub: $('resSub'), resChips: $('resChips'), resClose: $('resClose'), resAgain: $('resAgain'),
    toast: $('toast'),
  };

  const label = (midi) => M.noteLabel(midi, settings.naming);
  const freqOf = (midi) => M.midiToFreq(midi, settings.a4);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const clock = () => (engine.running ? engine.now() : performance.now() / 1000);
  const fmtShift = (t) => (t > 0 ? '+' : '') + t;
  const fmtCents = (c) => (c >= 0 ? '+' : '−') + Math.round(Math.abs(c)) + ' ¢';

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  /** Perdenin hedefe uzaklığı (cent). Oktav serbestse en yakın oktava katlanır. */
  function deviation(midi, target) {
    let d = midi - target;
    if (settings.octaveFree) d -= 12 * Math.round(d / 12);
    return d * 100;
  }

  function category(cents) {
    const a = Math.abs(cents);
    return a <= settings.tolerance ? 'good' : a <= settings.tolerance * 2 ? 'near' : 'off';
  }

  const scoreClass = (score) => (score >= 80 ? 'good' : score >= 50 ? 'near' : 'off');

  // ---------- canlı durum ----------
  let detector = null;
  const tracker = new PitchTracker();
  let raw = { freq: 0, clarity: 0, rms: 0, db: -120 };
  let pitch = { voiced: false, midi: null };
  let muteUntil = 0; // hoparlörden referans çalarken kendi sesimizi duymamak için
  const trace = []; // { t, m, cat } — rulodaki perde çizgisi
  const stable = { ref: null, start: 0, sum: 0, n: 0 };
  let lockStart = null;
  let wasLocked = false;
  let keyCapture = false;
  let session = null; // aktif şarkı çalışması
  let preview = null; // melodiyi dinleme
  let viewCenter = 79;
  let needle = 0;
  let needleEl = null;
  let songNotes = [];
  let songMin = 72;
  let songMax = 84;

  function mute(until) {
    if (!settings.headphones) muteUntil = Math.max(muteUntil, until);
  }

  // ---------- şarkı kitaplığı ----------
  const allSongs = () => M.SONGS.concat(customSongs);
  const transposition = () => keys[ui.songId] || 0;

  function currentSong() {
    const list = allSongs();
    return list.find((s) => s.id === ui.songId) || list[0];
  }

  function fillSongSelect() {
    el.songSelect.textContent = '';
    const groups = new Map();
    for (const s of allSongs()) {
      const g = s.custom ? 'Senin şarkıların' : s.group;
      if (!groups.has(g)) {
        const og = document.createElement('optgroup');
        og.label = g;
        groups.set(g, og);
        el.songSelect.appendChild(og);
      }
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.title;
      groups.get(g).appendChild(o);
    }
    el.songSelect.value = currentSong().id;
  }

  function loadSong() {
    const def = currentSong();
    ui.songId = def.id;
    const t = transposition();
    songNotes = M.parseSong(def.text).notes.map((n) => ({
      midi: n.midi == null ? null : n.midi + t,
      beats: n.beats,
      rest: n.midi == null,
    }));
    const pitched = songNotes.filter((n) => !n.rest).map((n) => n.midi);
    songMin = pitched.length ? Math.min(...pitched) : 72;
    songMax = pitched.length ? Math.max(...pitched) : 84;
    renderChips();
    setText(el.keyOut, fmtShift(t));
    el.delSongBtn.hidden = !def.custom;
    renderBest();
  }

  function selectSong(id) {
    ui.songId = id;
    store.set('songId', id);
    ui.bpm = currentSong().bpm || 90;
    el.bpm.value = ui.bpm;
    setText(el.bpmOut, String(ui.bpm));
    el.songSelect.value = currentSong().id;
    loadSong();
  }

  function setTransposition(t) {
    t = clamp(Math.round(t), -24, 24);
    if (t === 0) delete keys[ui.songId];
    else keys[ui.songId] = t;
    store.set('keys', keys);
    loadSong();
  }

  function baseMidis() {
    return M.parseSong(currentSong().text).notes.filter((n) => n.midi != null).map((n) => n.midi);
  }

  function fitToRange() {
    if (!range || range.hi === range.lo) {
      toast('Önce Akort modunda ses aralığını ölç: en pes ve en tiz notanı birer saniye tut.');
      return;
    }
    const base = baseMidis();
    if (!base.length) return;
    const lo = Math.min(...base);
    const hi = Math.max(...base);
    let bestT = 0;
    let bestCost = Infinity;
    for (let t = -24; t <= 24; t++) {
      const over = Math.max(0, range.lo - (lo + t)) + Math.max(0, hi + t - range.hi);
      const offCenter = Math.abs((lo + hi) / 2 + t - (range.lo + range.hi) / 2);
      const cost = over * 100 + offCenter + Math.abs(t) * 0.01;
      if (cost < bestCost) {
        bestCost = cost;
        bestT = t;
      }
    }
    setTransposition(bestT);
    const fits = lo + bestT >= range.lo && hi + bestT <= range.hi;
    toast(fits ? `Şarkı ses aralığına sığdırıldı (ton ${fmtShift(bestT)})` : `Şarkı aralığından geniş; en yakın ton ${fmtShift(bestT)}`);
  }

  function startKeyCapture() {
    keyCapture = true;
    stable.ref = null;
    el.keyFromMe.classList.add('active');
    setText(el.keyFromMe, 'Dinliyorum…');
  }

  function stopKeyCapture() {
    keyCapture = false;
    el.keyFromMe.classList.remove('active');
    setText(el.keyFromMe, 'İlk notamdan');
  }

  function captureKey(midi) {
    stopKeyCapture();
    const base = baseMidis();
    if (!base.length) return;
    const t = clamp(Math.round(midi) - base[0], -24, 24);
    setTransposition(t);
    toast(`Şarkı ${label(base[0] + t)} notasından başlayacak (ton ${fmtShift(t)})`);
  }

  // ---------- ses aralığı ----------
  /** Aynı perde ~0,5 sn tutulduysa ortalamasını döndürür. */
  function updateStable(now) {
    if (!pitch.voiced) {
      stable.ref = null;
      return null;
    }
    if (stable.ref == null || Math.abs(pitch.midi - stable.ref) > 0.45) {
      stable.ref = pitch.midi;
      stable.start = now;
      stable.sum = 0;
      stable.n = 0;
    }
    stable.sum += pitch.midi;
    stable.n++;
    return now - stable.start >= 0.5 ? stable.sum / stable.n : null;
  }

  function registerRange(midi) {
    const r = Math.round(midi);
    if (range && r >= range.lo && r <= range.hi) return;
    range = range ? { lo: Math.min(range.lo, r), hi: Math.max(range.hi, r) } : { lo: r, hi: r };
    store.set('range', range);
    renderRange();
  }

  function renderRange() {
    if (!range) return setText(el.rangeOut, 'Henüz ölçülmedi');
    const span = range.hi - range.lo;
    setText(el.rangeOut, span ? `${label(range.lo)} – ${label(range.hi)} · ${span} yarım ton` : label(range.lo));
  }

  // ---------- nota çipleri ----------
  function renderChips() {
    el.chips.textContent = '';
    for (const n of songNotes) {
      if (n.rest) continue;
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = label(n.midi);
      n.el = c;
      el.chips.appendChild(c);
    }
    el.chips.scrollLeft = 0;
  }

  function resetChips() {
    for (const n of songNotes) if (n.el) n.el.className = 'chip';
    el.chips.scrollLeft = 0;
  }

  function chipState(n, cls) {
    if (n && n.el) n.el.className = cls ? 'chip ' + cls : 'chip';
  }

  function scrollToChip(n) {
    if (!n || !n.el) return;
    const c = el.chips;
    c.scrollLeft = n.el.offsetLeft - c.clientWidth / 2 + n.el.offsetWidth / 2;
  }

  function relabel() {
    for (const n of songNotes) if (n.el) n.el.textContent = label(n.midi);
    renderRange();
  }

  function renderBest() {
    const parts = [];
    const step = best[ui.songId + ':step'];
    const tempo = best[ui.songId + ':tempo'];
    if (step != null) parts.push(`adım adım ${step}`);
    if (tempo != null) parts.push(`ritimli ${tempo}`);
    setText(el.bestOut, parts.length ? 'En iyi puanın: ' + parts.join(' · ') : '');
  }

  // ---------- referans sesler ----------
  function playRef(midi, at) {
    if (!engine.running || midi == null) return;
    const end = engine.tone(freqOf(midi), at == null ? clock() + 0.05 : at, 0.8);
    mute(end + 0.12);
  }

  function playCurrentRef() {
    const n = currentTarget(clock());
    if (n) playRef(n.midi);
  }

  function scheduleMelody(notes, bpm, vol) {
    const spb = 60 / bpm;
    let t = clock() + 0.15;
    const timeline = [];
    for (const n of notes) {
      const dur = n.beats * spb;
      if (!n.rest && n.midi != null) engine.tone(freqOf(n.midi), t, Math.max(0.08, dur - 0.04), vol);
      timeline.push({ n, start: t, end: t + dur });
      t += dur;
    }
    mute(t + 0.12);
    return { timeline, end: t, idx: -1 };
  }

  function togglePreview() {
    if (preview) return stopPreview();
    if (!engine.running || !songNotes.some((n) => !n.rest)) return;
    stopKeyCapture();
    preview = scheduleMelody(songNotes, ui.bpm);
    updateButtons();
  }

  function stopPreview() {
    if (!preview) return;
    preview = null;
    engine.stopAll();
    muteUntil = Math.min(muteUntil, clock() + 0.1);
    resetChips();
    updateButtons();
  }

  function updatePreview(now) {
    if (now >= preview.end) {
      preview = null;
      resetChips();
      updateButtons();
      return;
    }
    const i = preview.timeline.findIndex((s) => now >= s.start && now < s.end);
    if (i === preview.idx) return;
    const old = preview.timeline[preview.idx];
    if (old) chipState(old.n, '');
    const cur = preview.timeline[i];
    if (cur && !cur.n.rest) {
      chipState(cur.n, 'playing');
      scrollToChip(cur.n);
    }
    preview.idx = i;
  }

  // ---------- şarkı çalışması ----------
  function toggleSession() {
    if (session) stopSession();
    else startSession();
  }

  function startSession() {
    if (!engine.running || !songNotes.some((n) => !n.rest)) return;
    stopPreview();
    stopKeyCapture();
    resetChips();
    const now = clock();
    for (const n of songNotes) {
      n.start = n.end = n.score = null;
      n.hit = n.total = 0;
    }

    if (ui.practice === 'step') {
      const notes = songNotes.filter((n) => !n.rest);
      session = {
        kind: 'step', notes, i: 0, t0: now,
        holdStart: null, lastGood: 0, devs: [], peakRms: 0, needRelease: false,
      };
      notes[0].start = now - LATENCY;
      chipState(notes[0], 'current');
      if (settings.refBeforeNote) playRef(notes[0].midi, now + 0.1);
    } else {
      const spb = 60 / ui.bpm;
      const first = now + 0.3;
      for (let k = 0; k < 4; k++) engine.click(first + k * spb, k === 0);
      mute(first + 3 * spb + 0.08);
      const t0 = first + 4 * spb;
      let beat = 0;
      for (const n of songNotes) {
        n.start = t0 + beat * spb;
        n.end = n.start + n.beats * spb;
        beat += n.beats;
      }
      session = { kind: 'tempo', notes: songNotes, i: 0, t0, spb, end: t0 + beat * spb, bpm: ui.bpm };
      if (!songNotes[0].rest) chipState(songNotes[0], 'current');
      if (settings.accompany && settings.headphones) {
        for (const n of songNotes) {
          if (!n.rest) engine.tone(freqOf(n.midi), n.start, Math.max(0.08, n.end - n.start - 0.04), 0.12);
        }
      }
    }
    updateButtons();
  }

  function stopSession() {
    session = null;
    engine.stopAll();
    muteUntil = Math.min(muteUntil, clock());
    el.countdown.hidden = true;
    resetChips();
    updateButtons();
  }

  function updateStep(now) {
    const s = session;
    const n = s.notes[s.i];
    if (!pitch.voiced) {
      s.holdStart = null;
      s.needRelease = false;
      return;
    }
    const dev = deviation(pitch.midi, n.midi);
    if (s.needRelease) {
      // Aynı nota tekrar ediyor: ses kısılmadan/kesilmeden ikinci notayı sayma.
      if (raw.rms < s.peakRms * 0.5 || Math.abs(dev) > settings.tolerance * 2) s.needRelease = false;
      else return;
    }
    if (Math.abs(dev) <= settings.tolerance) {
      if (s.holdStart == null) {
        s.holdStart = now;
        s.devs = [];
        s.peakRms = 0;
      }
      s.lastGood = now;
      s.devs.push(Math.abs(dev));
      s.peakRms = Math.max(s.peakRms, raw.rms);
      if (now - s.holdStart >= settings.holdMs / 1000) stepSuccess(now);
    } else if (s.holdStart != null && now - s.lastGood > 0.12) {
      s.holdStart = null;
    }
  }

  function stepSuccess(now) {
    const s = session;
    const n = s.notes[s.i];
    n.score = Math.round(100 - (50 * mean(s.devs)) / settings.tolerance);
    n.end = now - LATENCY;
    chipState(n, scoreClass(n.score));
    pulse();
    s.i++;
    s.holdStart = null;
    if (s.i >= s.notes.length) return finishSession(now);
    const next = s.notes[s.i];
    next.start = now - LATENCY;
    s.needRelease = Math.abs(deviation(next.midi, n.midi)) < 1;
    chipState(next, 'current');
    scrollToChip(next);
    if (settings.refBeforeNote) playRef(next.midi, now + 0.2);
  }

  function updateTempo(now) {
    const s = session;
    const tf = now - LATENCY;
    while (s.i < s.notes.length && tf >= s.notes[s.i].end) {
      const done = s.notes[s.i];
      if (!done.rest) {
        done.score = done.total ? Math.round((100 * done.hit) / done.total) : 0;
        chipState(done, scoreClass(done.score));
      }
      s.i++;
      const next = s.notes[s.i];
      if (next && !next.rest) {
        chipState(next, 'current');
        scrollToChip(next);
      }
    }
    if (s.i >= s.notes.length) return finishSession(now);
    const n = s.notes[s.i];
    if (n.rest || tf < n.start) return;
    // Notanın ilk anı (atak) puanlanmaz.
    if (tf < n.start + Math.min(0.12, (n.end - n.start) * 0.25)) return;
    n.total++;
    if (pitch.voiced && Math.abs(deviation(pitch.midi, n.midi)) <= settings.tolerance) n.hit++;
  }

  function finishSession(now) {
    const s = session;
    session = null;
    el.countdown.hidden = true;
    updateButtons();
    const scored = s.notes.filter((n) => !n.rest);
    const total = Math.round(mean(scored.map((n) => n.score || 0)));
    const key = ui.songId + ':' + s.kind;
    const prev = best[key];
    if (prev == null || total > prev) {
      best[key] = total;
      store.set('best', best);
      renderBest();
    }
    showResult(total, s, scored, now, prev != null && total > prev);
  }

  function showResult(total, s, scored, now, newRecord) {
    const stars = total >= 90 ? 3 : total >= 75 ? 2 : total >= 55 ? 1 : 0;
    setText(el.resStars, '★'.repeat(stars) + '☆'.repeat(3 - stars));
    setText(el.resScore, String(total));
    setText(el.resTitle, ['Biraz daha pratik 💪', 'Fena değil, devam!', 'Çok iyi!', 'Harika! 🎉'][stars]);
    let sub = s.kind === 'step'
      ? `Adım adım · ${scored.length} nota · ${Math.round(now - s.t0)} sn`
      : `Ritimli · ${s.bpm} BPM · ${scored.length} nota`;
    if (newRecord) sub += ' · Yeni rekor!';
    setText(el.resSub, sub);
    el.resChips.textContent = '';
    for (const n of scored) {
      const c = document.createElement('span');
      c.className = 'chip ' + scoreClass(n.score || 0);
      c.textContent = label(n.midi);
      c.title = `${n.score || 0} puan`;
      el.resChips.appendChild(c);
    }
    el.resultDlg.showModal();
  }

  /** Şu an ıslıklanması gereken nota (şarkı modunda). */
  function currentTarget(now) {
    if (ui.mode !== 'song') return null;
    if (session) {
      if (session.kind === 'step') return session.notes[session.i] || null;
      const tf = now - LATENCY;
      if (tf < session.t0) return songNotes.find((n) => !n.rest) || null;
      const n = session.notes[session.i];
      return n && !n.rest && tf >= n.start ? n : null;
    }
    if (preview) {
      const s = preview.timeline[preview.idx];
      return s && !s.n.rest ? s.n : null;
    }
    return songNotes.find((n) => !n.rest) || null;
  }

  function updateButtons() {
    const busy = !!session;
    setText(el.startBtn, busy ? '■ Durdur' : '▶ Başla');
    el.startBtn.disabled = !engine.running;
    setText(el.listenBtn, preview ? '■ Durdur' : '🔊 Melodiyi dinle');
    el.listenBtn.disabled = busy || !engine.running;
    el.refBtn.disabled = !engine.running || (busy && session.kind === 'tempo');
    for (const b of [el.songSelect, el.keyDown, el.keyUp, el.keyFromMe, el.keyFit, el.addSongBtn, el.delSongBtn, el.bpm]) {
      b.disabled = busy;
    }
    for (const b of el.practiceSeg.querySelectorAll('button')) {
      b.disabled = busy;
      b.classList.toggle('active', b.dataset.practice === ui.practice);
    }
  }

  function setMode(mode) {
    if (mode === ui.mode) return;
    if (session) stopSession();
    stopPreview();
    stopKeyCapture();
    ui.mode = mode;
    document.body.dataset.mode = mode;
    for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.mode === mode);
    trace.length = 0;
    lockStart = null;
  }

  // ---------- ana döngü ----------
  function frame() {
    requestAnimationFrame(frame);
    const now = clock();
    if (engine.running) {
      raw = detector.detect(engine.read());
      const isWhistle = now >= muteUntil && raw.db > settings.gateDb && raw.clarity > CLARITY_MIN;
      const r = tracker.update(now, isWhistle ? M.freqToMidi(raw.freq, settings.a4) : null);
      pitch = { voiced: r.voiced, midi: r.value };

      const held = updateStable(now);
      if (held != null) {
        registerRange(held);
        if (keyCapture) captureKey(held);
      }
      if (preview) updatePreview(now);
      if (session) (session.kind === 'step' ? updateStep : updateTempo)(now);
    }

    const target = currentTarget(now);
    recordTrace(now, target);
    renderMeter(now, target);
    renderLevel();
    renderCountdown(now);
    drawRoll(now);
  }

  function recordTrace(now, target) {
    if (!engine.running) return;
    const t = now - LATENCY;
    if (!pitch.voiced) {
      trace.push({ t, m: null });
    } else if (target) {
      const d = deviation(pitch.midi, target.midi);
      trace.push({ t, m: target.midi + d / 100, cat: category(d) });
    } else {
      let m = pitch.midi;
      if (ui.mode === 'song' && settings.octaveFree) {
        const center = (songMin + songMax) / 2;
        m -= 12 * Math.round((m - center) / 12);
      }
      trace.push({ t, m, cat: category((pitch.midi - Math.round(pitch.midi)) * 100) });
    }
    while (trace.length && trace[0].t < t - TRACE_SECONDS) trace.shift();
  }

  // ---------- ölçer ----------
  function buildGauge() {
    const cx = 150;
    const cy = 150;
    const r = 116;
    const pt = (c, rad) => {
      const a = ((clamp(c, -50, 50) / 50) * 80 * Math.PI) / 180;
      return [(cx + rad * Math.sin(a)).toFixed(2), (cy - rad * Math.cos(a)).toFixed(2)];
    };
    const arc = (c1, c2) => {
      const [x1, y1] = pt(c1, r);
      const [x2, y2] = pt(c2, r);
      return `M${x1} ${y1} A${r} ${r} 0 0 1 ${x2} ${y2}`;
    };
    const tol = settings.tolerance;
    const near = Math.min(50, tol * 2);
    const zones = [[-50, -near, 'off'], [-near, -tol, 'near'], [-tol, tol, 'good'], [tol, near, 'near'], [near, 50, 'off']];
    let svg = '';
    for (const [a, b, cls] of zones) if (b > a) svg += `<path class="zone ${cls}" d="${arc(a, b)}"/>`;
    for (let c = -50; c <= 50; c += 10) {
      const major = c % 50 === 0;
      const [x1, y1] = pt(c, r - 11);
      const [x2, y2] = pt(c, r - (major ? 25 : 19));
      svg += `<line class="tick${major ? ' major' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    }
    for (const [c, txt] of [[-50, '−50'], [0, '0'], [50, '+50']]) {
      const [x, y] = pt(c, r - 38);
      svg += `<text class="lbl" x="${x}" y="${(+y + 4).toFixed(2)}">${txt}</text>`;
    }
    const [lx, ly] = pt(-50, r);
    const [rx, ry] = pt(50, r);
    svg += `<text class="lbl" x="${lx}" y="${(+ly + 22).toFixed(2)}">pes</text>`;
    svg += `<text class="lbl" x="${rx}" y="${(+ry + 22).toFixed(2)}">tiz</text>`;
    svg += `<g class="needle"><line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r + 18}"/><circle cx="${cx}" cy="${cy}" r="7"/></g>`;
    el.gauge.innerHTML = svg;
    needleEl = el.gauge.querySelector('.needle');
  }

  function pulse() {
    el.meterCard.classList.remove('pop');
    void el.meterCard.offsetWidth; // animasyonu yeniden başlat
    el.meterCard.classList.add('pop');
  }

  function renderMeter(now, target) {
    const songMode = ui.mode === 'song';
    let cents = null;
    let big = null;
    let left = '— Hz';
    let right = '— ¢';

    if (songMode) {
      big = target ? target.midi : null;
      if (pitch.voiced) {
        left = 'Sen: ' + label(pitch.midi);
        if (target) cents = deviation(pitch.midi, target.midi);
      } else {
        left = 'Sen: —';
      }
      if (cents != null) right = fmtCents(cents);
    } else if (pitch.voiced) {
      big = Math.round(pitch.midi);
      cents = (pitch.midi - big) * 100;
      left = freqOf(pitch.midi).toFixed(1) + ' Hz';
      right = fmtCents(cents);
    }

    const state = cents == null ? 'idle' : category(cents);
    let ring = 0;
    let ringKind = 'hold';
    if (session && session.kind === 'step') {
      if (session.holdStart != null) ring = (now - session.holdStart) / (settings.holdMs / 1000);
    } else if (session) {
      ringKind = 'tempo';
      const tf = now - LATENCY;
      if (target && tf >= target.start) ring = (tf - target.start) / (target.end - target.start);
    } else if (state === 'good') {
      if (lockStart == null) lockStart = now;
      ring = (now - lockStart) / (settings.holdMs / 1000);
    } else {
      lockStart = null;
    }
    ring = clamp(ring, 0, 1);
    const locked = !session && ring >= 1;
    if (locked && !wasLocked) pulse();
    wasLocked = locked;

    el.ringFg.style.strokeDashoffset = (RING * (1 - ring)).toFixed(1);
    if (el.meterCard.dataset.ring !== ringKind) el.meterCard.dataset.ring = ringKind;
    if (el.meterCard.dataset.state !== state) el.meterCard.dataset.state = state;

    if (big == null) {
      const rest = session && session.kind === 'tempo' && now - LATENCY >= session.t0;
      setText(el.noteName, rest ? 'Es' : '–');
      setText(el.noteOct, '');
    } else {
      const p = M.noteParts(big, settings.naming);
      setText(el.noteName, p.name);
      setText(el.noteOct, String(p.octave));
    }

    const goal = cents == null ? 0 : clamp(cents, -55, 55);
    needle += (goal - needle) * (cents == null ? 0.08 : 0.3);
    needleEl.setAttribute('transform', `rotate(${((needle / 50) * 80).toFixed(2)} 150 150)`);

    setText(el.readLeft, left);
    setText(el.readRight, right);
    setText(el.hint, hintText(now, cents, target));
  }

  function hintText(now, cents, target) {
    if (!engine.running) return 'Mikrofonu başlat';
    if (now < muteUntil) return '🔊 Dinle…';
    if (keyCapture) return 'Rahat ettiğin bir notayı ıslıkla ve tut…';
    if (session && session.kind === 'tempo' && now < session.t0) return 'Hazırlan…';
    if (session && session.kind === 'step' && session.needRelease && pitch.voiced) return 'Aynı nota tekrar: kısa kes, yeniden ıslıkla';
    if (cents == null) {
      if (ui.mode === 'tuner') return 'Islık çal…';
      if (!target) return session ? 'Es — kısa bir sus' : 'Bir şarkı seç';
      return session ? `${label(target.midi)} notasını ıslıkla` : 'Başla’ya bas ya da ilk notayı dene';
    }
    const a = Math.abs(cents);
    if (a <= settings.tolerance) return session && session.kind === 'step' ? 'Güzel, tut…' : 'Tam isabet ✓';
    const dir = cents < 0 ? 'yükselt ▲' : 'alçalt ▼';
    if (a < 100) return 'Biraz ' + dir;
    return `${Math.round(a / 100)} yarım ton ${dir}`;
  }

  function renderLevel() {
    const pct = engine.running ? clamp((raw.db + 80) / 80, 0, 1) * 100 : 0;
    el.levelFill.style.width = pct.toFixed(1) + '%';
    el.levelFill.classList.toggle('voiced', pitch.voiced);
  }

  function renderGate() {
    el.levelGate.style.left = (clamp((settings.gateDb + 80) / 80, 0, 1) * 100).toFixed(1) + '%';
  }

  function renderCountdown(now) {
    const show = session && session.kind === 'tempo' && now < session.t0;
    el.countdown.hidden = !show;
    if (show) setText(el.countdown, String(clamp(Math.ceil((session.t0 - now) / session.spb), 1, 4)));
  }

  // ---------- piyano rulosu ----------
  const rollCtx = el.roll.getContext('2d');
  const colors = {};
  let rollW = 0;
  let rollH = 0;
  let dpr = 1;

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['panel', 'line', 'text', 'muted', 'accent', 'good', 'near', 'off', 'idle', 'lane', 'lane-dark']) {
      colors[k] = cs.getPropertyValue('--' + k).trim();
    }
  }

  function resizeRoll() {
    dpr = window.devicePixelRatio || 1;
    rollW = el.roll.clientWidth;
    rollH = el.roll.clientHeight;
    el.roll.width = Math.round(rollW * dpr);
    el.roll.height = Math.round(rollH * dpr);
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) {
      c.roundRect(x, y, w, h, r);
      return;
    }
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  /** Rulodaki hedef nota çubukları: { n, start, end, state }. */
  function songSegments(tNow) {
    const segs = [];
    if (session && session.kind === 'step') {
      const s = session;
      let t = 0;
      s.notes.forEach((n, i) => {
        if (i < s.i) {
          segs.push({ n, start: n.start, end: n.end, state: scoreClass(n.score) });
        } else if (i === s.i) {
          t = Math.max(tNow, n.start) + n.beats * STEP_SPB;
          segs.push({ n, start: n.start, end: t, state: 'current' });
        } else {
          segs.push({ n, start: t, end: t + n.beats * STEP_SPB, state: 'next' });
          t += n.beats * STEP_SPB;
        }
      });
    } else if (session) {
      session.notes.forEach((n, i) => {
        if (n.rest) return;
        const state = i < session.i ? scoreClass(n.score) : i === session.i && tNow >= n.start ? 'current' : 'next';
        segs.push({ n, start: n.start, end: n.end, state });
      });
    } else if (preview) {
      preview.timeline.forEach((s, i) => {
        if (!s.n.rest) segs.push({ n: s.n, start: s.start - LATENCY, end: s.end - LATENCY, state: i === preview.idx ? 'current' : 'next' });
      });
    } else {
      // Boştayken şarkıyı oynatma çizgisinden itibaren önizle.
      const spb = 60 / ui.bpm;
      let t = tNow + 0.3;
      for (const n of songNotes) {
        if (!n.rest) segs.push({ n, start: t, end: t + n.beats * spb, state: 'next' });
        t += n.beats * spb;
      }
    }
    return segs;
  }

  function drawTargets(c, tNow, xOf, yOf, laneH, gutter, w) {
    const segs = songSegments(tNow);
    const barH = Math.max(6, laneH * 0.78);
    const cur = segs.find((s) => s.state === 'current');
    if (cur) {
      // Hedef notanın tolerans bandı
      const band = settings.tolerance / 100;
      const y1 = yOf(cur.n.midi + band);
      c.globalAlpha = 0.12;
      c.fillStyle = colors.accent;
      c.fillRect(gutter, y1, w - gutter, yOf(cur.n.midi - band) - y1);
      c.globalAlpha = 1;
    }
    c.font = `700 ${clamp(barH * 0.55, 9, 12)}px system-ui, sans-serif`;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    for (const s of segs) {
      const x1 = xOf(s.start);
      const x2 = xOf(s.end) - 3;
      if (x2 < gutter || x1 > w) continue;
      const y = yOf(s.n.midi) - barH / 2;
      c.globalAlpha = s.state === 'next' ? 0.55 : s.state === 'current' ? 0.95 : 0.6;
      c.fillStyle = s.state === 'current' ? colors.accent : s.state === 'next' ? colors.idle : colors[s.state];
      roundRect(c, x1, y, Math.max(4, x2 - x1), barH, Math.min(6, barH / 2));
      c.fill();
      c.globalAlpha = 1;
      if (x2 - Math.max(x1, gutter) > 36) {
        c.fillStyle = s.state === 'next' ? colors.text : '#fff';
        c.fillText(label(s.n.midi), Math.max(x1, gutter) + 7, y + barH / 2 + 0.5);
      }
    }
  }

  function drawTrace(c, xOf, yOf) {
    c.lineWidth = 3;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    let prev = null;
    let open = false;
    let cat = null;
    const flush = () => {
      if (open) c.stroke();
      open = false;
    };
    for (const p of trace) {
      if (p.m == null) {
        flush();
        prev = null;
        continue;
      }
      if (!prev || p.t - prev.t > 0.12 || Math.abs(p.m - prev.m) > 2) {
        flush();
        prev = p;
        continue;
      }
      if (!open || p.cat !== cat) {
        flush();
        c.beginPath();
        c.strokeStyle = colors[p.cat];
        c.moveTo(xOf(prev.t), yOf(prev.m));
        cat = p.cat;
        open = true;
      }
      c.lineTo(xOf(p.t), yOf(p.m));
      prev = p;
    }
    flush();
  }

  function drawRoll(now) {
    const c = rollCtx;
    const w = rollW;
    const h = rollH;
    if (!w || !h) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = colors.panel;
    c.fillRect(0, 0, w, h);

    const songMode = ui.mode === 'song';
    let lo;
    let hi;
    if (songMode) {
      lo = songMin - 2.5;
      hi = songMax + 2.5;
      if (hi - lo < 12) {
        const mid = (lo + hi) / 2;
        lo = mid - 6;
        hi = mid + 6;
      }
    } else {
      if (pitch.voiced) {
        const d = pitch.midi - viewCenter;
        if (Math.abs(d) > 4) viewCenter += (d - Math.sign(d) * 4) * 0.1;
      }
      lo = viewCenter - 7.5;
      hi = viewCenter + 7.5;
    }
    const gutter = 50;
    const laneH = h / (hi - lo);
    const yOf = (m) => h - ((m - lo) / (hi - lo)) * h;

    // Nota şeritleri (diyez/bemoller koyu) ve etiketler
    const heard = !songMode && pitch.voiced ? Math.round(pitch.midi) : null;
    c.font = `600 ${clamp(laneH * 0.6, 9, 12)}px system-ui, sans-serif`;
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    for (let m = Math.floor(lo); m <= Math.ceil(hi); m++) {
      const black = M.isBlackKey(m);
      c.fillStyle = black ? colors['lane-dark'] : colors.lane;
      c.fillRect(gutter, yOf(m + 0.5), w - gutter, laneH + 0.5);
      if (m === heard) {
        c.globalAlpha = 0.1;
        c.fillStyle = colors.accent;
        c.fillRect(gutter, yOf(m + 0.5), w - gutter, laneH);
        c.globalAlpha = 1;
      }
      if (((m % 12) + 12) % 12 === 0) {
        c.fillStyle = colors.line;
        c.fillRect(gutter, yOf(m - 0.5) - 0.5, w - gutter, 1);
      }
      if (!black || laneH >= 16) {
        c.fillStyle = m === heard ? colors.accent : black ? colors.idle : colors.muted;
        c.fillText(label(m), gutter - 8, yOf(m));
      }
    }

    const playX = songMode ? gutter + (w - gutter) * (w < 520 ? 0.4 : 0.58) : w - 28;
    const pps = songMode ? 140 : 95; // saniye başına piksel
    const tNow = now - LATENCY;
    const xOf = (t) => playX + (t - tNow) * pps;

    c.save();
    c.beginPath();
    c.rect(gutter, 0, w - gutter, h);
    c.clip();

    if (songMode) drawTargets(c, tNow, xOf, yOf, laneH, gutter, w);
    drawTrace(c, xOf, yOf);

    c.globalAlpha = 0.5;
    c.fillStyle = colors.accent;
    c.fillRect(playX - 1, 0, 2, h);
    c.globalAlpha = 1;

    // Anlık perde: nokta, görünür aralığın dışındaysa kenarda ok
    const last = trace[trace.length - 1];
    if (last && last.m != null) {
      const x = xOf(last.t);
      const y = yOf(last.m);
      c.fillStyle = colors[last.cat];
      c.beginPath();
      if (y < 0) {
        c.moveTo(x, 4);
        c.lineTo(x - 8, 18);
        c.lineTo(x + 8, 18);
        c.fill();
      } else if (y > h) {
        c.moveTo(x, h - 4);
        c.lineTo(x - 8, h - 18);
        c.lineTo(x + 8, h - 18);
        c.fill();
      } else {
        c.shadowColor = colors[last.cat];
        c.shadowBlur = 14;
        c.arc(x, y, 6, 0, Math.PI * 2);
        c.fill();
        c.shadowBlur = 0;
      }
    }
    c.restore();
  }

  // ---------- diyaloglar ----------
  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), 3000);
  }

  const S = {
    naming: $('setNaming'), tol: $('setTol'), tolOut: $('tolOut'), hold: $('setHold'), holdOut: $('holdOut'),
    gate: $('setGate'), gateOut: $('gateOut'), octave: $('setOctave'), headphones: $('setHeadphones'),
    refBefore: $('setRefBefore'), accompany: $('setAccompany'), a4: $('setA4'),
  };

  function fillSettingsForm() {
    S.naming.value = settings.naming;
    S.tol.value = settings.tolerance;
    S.hold.value = settings.holdMs;
    S.gate.value = settings.gateDb;
    S.octave.checked = settings.octaveFree;
    S.headphones.checked = settings.headphones;
    S.refBefore.checked = settings.refBeforeNote;
    S.accompany.checked = settings.accompany;
    S.a4.value = settings.a4;
    renderSettingsOutputs();
  }

  function renderSettingsOutputs() {
    S.tolOut.textContent = settings.tolerance;
    S.holdOut.textContent = settings.holdMs;
    S.gateOut.textContent = settings.gateDb;
    S.accompany.disabled = !settings.headphones;
  }

  function onSettingsInput() {
    settings.naming = S.naming.value;
    settings.tolerance = +S.tol.value;
    settings.holdMs = +S.hold.value;
    settings.gateDb = +S.gate.value;
    settings.octaveFree = S.octave.checked;
    settings.headphones = S.headphones.checked;
    settings.refBeforeNote = S.refBefore.checked;
    settings.accompany = S.accompany.checked;
    const a4 = +S.a4.value;
    if (a4 >= 415 && a4 <= 466) settings.a4 = a4;
    if (settings.headphones) muteUntil = 0;
    store.set('settings', settings);
    renderSettingsOutputs();
    buildGauge();
    renderGate();
    relabel();
  }

  function parseCustom() {
    const { notes, errors } = M.parseSong(el.songText.value);
    const pitched = notes.filter((n) => n.midi != null).map((n) => n.midi);
    const out = el.parseOut;
    if (errors.length) {
      out.className = 'parse-out bad';
      out.textContent = 'Anlaşılamayan: ' + errors.slice(0, 6).join(', ') + (errors.length > 6 ? '…' : '');
    } else if (!pitched.length) {
      out.className = 'parse-out muted';
      out.textContent = 'Notaları yazınca burada özeti görünür.';
    } else {
      out.className = 'parse-out ok';
      out.textContent = `${pitched.length} nota · ${label(Math.min(...pitched))} – ${label(Math.max(...pitched))}`;
    }
    return { notes, errors, pitched };
  }

  function saveCustomSong() {
    const { errors, pitched } = parseCustom();
    if (errors.length || !pitched.length) {
      el.songText.focus();
      return;
    }
    const title = el.songName.value.trim() || 'Şarkım';
    const song = {
      id: 'custom-' + Date.now().toString(36),
      title,
      text: el.songText.value.trim(),
      bpm: clamp(parseInt(el.songBpm.value, 10) || 90, 40, 200),
      custom: true,
    };
    customSongs.push(song);
    store.set('songs', customSongs);
    fillSongSelect();
    selectSong(song.id);
    el.songDlg.close();
    toast(`“${title}” eklendi`);
  }

  function deleteCustomSong() {
    const def = currentSong();
    if (!def.custom || !confirm(`“${def.title}” silinsin mi?`)) return;
    customSongs = customSongs.filter((s) => s.id !== def.id);
    delete keys[def.id];
    delete best[def.id + ':step'];
    delete best[def.id + ':tempo'];
    store.set('songs', customSongs);
    store.set('keys', keys);
    store.set('best', best);
    fillSongSelect();
    selectSong('twinkle');
  }

  function micErrorText(err) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return 'Bu tarayıcı mikrofonu açamıyor. Sayfayı http://localhost üzerinden ya da https ile aç.';
    }
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Mikrofon izni verilmedi. Adres çubuğundaki mikrofon simgesinden izin verip tekrar dene.';
    }
    if (name === 'NotFoundError') return 'Mikrofon bulunamadı. Bağlı bir mikrofon var mı?';
    return 'Mikrofon açılamadı: ' + ((err && err.message) || err);
  }

  // Telefonda ekran kararmasın: ıslık çalarken ekrana dokunulmuyor.
  async function keepAwake() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      await navigator.wakeLock.request('screen');
    } catch (_) {
      // desteklenmiyor ya da pil tasarrufu reddetti: önemsiz
    }
  }

  async function startMic() {
    el.micBtn.disabled = true;
    el.micError.hidden = true;
    try {
      await engine.start({ test: TEST_MODE });
    } catch (err) {
      el.micBtn.disabled = false;
      el.micError.hidden = false;
      el.micError.textContent = micErrorText(err);
      return;
    }
    detector = new PitchDetector(engine.sampleRate);
    el.startOverlay.hidden = true;
    el.micDot.classList.add('on');
    setText(el.statusText, TEST_MODE ? 'Test modu (osilatör)' : `Mikrofon açık · ${(engine.sampleRate / 1000).toFixed(1)} kHz`);
    if (TEST_MODE) window.testTone = (f, level) => engine.setTestTone(f, level);
    updateButtons();
    keepAwake();
  }

  // ---------- olaylar ----------
  el.micBtn.addEventListener('click', startMic);
  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => setMode(b.dataset.mode));

  el.rangeReset.addEventListener('click', () => {
    range = null;
    store.set('range', null);
    renderRange();
  });

  el.songSelect.addEventListener('change', () => selectSong(el.songSelect.value));
  el.keyDown.addEventListener('click', () => setTransposition(transposition() - 1));
  el.keyUp.addEventListener('click', () => setTransposition(transposition() + 1));
  el.keyFit.addEventListener('click', fitToRange);
  el.keyFromMe.addEventListener('click', () => (keyCapture ? stopKeyCapture() : startKeyCapture()));
  el.practiceSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    ui.practice = b.dataset.practice;
    store.set('practice', ui.practice);
    document.body.dataset.practice = ui.practice;
    updateButtons();
  });
  el.bpm.addEventListener('input', () => {
    ui.bpm = +el.bpm.value;
    setText(el.bpmOut, String(ui.bpm));
  });
  el.startBtn.addEventListener('click', toggleSession);
  el.listenBtn.addEventListener('click', togglePreview);
  el.refBtn.addEventListener('click', playCurrentRef);

  el.settingsBtn.addEventListener('click', () => {
    fillSettingsForm();
    el.settingsDlg.showModal();
  });
  el.settingsDlg.addEventListener('input', onSettingsInput);
  el.settingsDlg.addEventListener('change', onSettingsInput);

  el.addSongBtn.addEventListener('click', () => {
    el.songName.value = '';
    el.songText.value = '';
    el.songBpm.value = 90;
    parseCustom();
    el.songDlg.showModal();
  });
  el.delSongBtn.addEventListener('click', deleteCustomSong);
  el.songText.addEventListener('input', parseCustom);
  el.songSave.addEventListener('click', saveCustomSong);
  el.songPreview.addEventListener('click', () => {
    const { notes, errors, pitched } = parseCustom();
    if (!engine.running || errors.length || !pitched.length) return;
    engine.stopAll();
    scheduleMelody(notes, clamp(parseInt(el.songBpm.value, 10) || 90, 40, 200));
  });
  el.songDlg.addEventListener('close', () => engine.running && engine.stopAll());

  el.resClose.addEventListener('click', () => el.resultDlg.close());
  el.resAgain.addEventListener('click', () => {
    el.resultDlg.close();
    startSession();
  });

  document.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]') || e.target.closest('input, textarea, select')) return;
    if (ui.mode !== 'song' || !engine.running) return;
    if (e.code === 'Space') {
      e.preventDefault();
      // Odaktaki düğmenin boşlukla ayrıca tıklanmasını engelle.
      if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
      toggleSession();
    } else if (e.key === 'n' || e.key === 'N') {
      if (!el.refBtn.disabled) playCurrentRef();
    }
  });

  // Uygulamaya geri dönünce (ekran kilidi bırakılır, ses askıya alınabilir) ikisini de yenile.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !engine.running) return;
    engine.resume();
    keepAwake();
  });

  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', readColors);
  new ResizeObserver(resizeRoll).observe(el.roll);

  // ---------- başlangıç ----------
  document.body.dataset.practice = ui.practice;
  if (TEST_MODE) el.micBtn.textContent = '🧪 Test modunda başlat';
  readColors();
  resizeRoll();
  buildGauge();
  renderGate();
  renderRange();
  fillSongSelect();
  selectSong(currentSong().id);
  updateButtons();
  requestAnimationFrame(frame);
})();
