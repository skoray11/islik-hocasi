// Çalıştır: node tests/pitch.test.js
'use strict';
const assert = require('assert');
const { PitchDetector, PitchTracker } = require('../js/pitch.js');
const { parseSong, noteLabel, freqToMidi } = require('../js/music.js');

// Tekrarlanabilir gürültü için basit PRNG.
let seed = 1;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

function signal(sr, n, fn) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(i / sr);
  return out;
}

const cents = (a, b) => 1200 * Math.log2(a / b);

for (const sr of [44100, 48000]) {
  const det = new PitchDetector(sr);

  // 1) Saf ıslık tonları + hafif nefes gürültüsü: frekans hatası < 2 cent.
  let worst = 0;
  let minClarity = 1;
  for (let f = 400; f <= 4200; f *= 1.0297) {
    const ph = rand() * Math.PI;
    const x = signal(sr, 2048, (t) => 0.2 * Math.sin(2 * Math.PI * f * t + ph) + 0.01 * rand());
    const r = det.detect(x);
    worst = Math.max(worst, Math.abs(cents(r.freq, f)));
    minClarity = Math.min(minClarity, r.clarity);
  }
  assert(worst < 2, `${sr} Hz: en kötü hata ${worst.toFixed(2)} cent`);
  assert(minClarity > 0.8, `${sr} Hz: ıslık netliği düşük ${minClarity.toFixed(2)}`);

  // 2) Beyaz gürültü ıslık sayılmamalı.
  const noise = signal(sr, 2048, () => 0.2 * rand());
  const rn = det.detect(noise);
  assert(rn.clarity < 0.15, `gürültü netliği ${rn.clarity.toFixed(2)}`);

  // 3) Konuşmaya benzer harmonik ses (f0=150 Hz, 25 harmonik) ıslık sayılmamalı.
  const voice = signal(sr, 2048, (t) => {
    let s = 0;
    for (let k = 1; k <= 25; k++) s += Math.sin(2 * Math.PI * 150 * k * t) / k;
    return 0.1 * s;
  });
  const rv = det.detect(voice);
  assert(rv.clarity < 0.2, `konuşma netliği ${rv.clarity.toFixed(2)}`);

  // 4) Gürültülü ortamda ıslık (SNR ~ 10 dB) hâlâ doğru ve net.
  const noisy = signal(sr, 2048, (t) => 0.2 * Math.sin(2 * Math.PI * 1046.5 * t) + 0.045 * rand());
  const rq = det.detect(noisy);
  assert(Math.abs(cents(rq.freq, 1046.5)) < 5, `gürültülü ıslık hatası ${cents(rq.freq, 1046.5).toFixed(1)}`);
  assert(rq.clarity > 0.35, `gürültülü ıslık netliği ${rq.clarity.toFixed(2)}`);

  console.log(
    `✓ ${sr} Hz — en kötü hata ${worst.toFixed(3)}¢, min netlik ${minClarity.toFixed(2)}, ` +
      `gürültü ${rn.clarity.toFixed(3)}, konuşma ${rv.clarity.toFixed(3)}, gürültülü ıslık ${rq.clarity.toFixed(2)}`
  );
}

// 5) Takipçi: tek karelik sıçramayı eler, kısa kesintiyi köprüler.
{
  const tr = new PitchTracker();
  const dt = 1 / 60;
  let t = 0;
  let out;
  for (let i = 0; i < 6; i++) out = tr.update((t += dt), 79);
  out = tr.update((t += dt), 91); // tek karelik oktav hatası
  assert.strictEqual(out.value, 79);
  out = tr.update((t += dt), null); // 16 ms kesinti
  assert(out.voiced && out.value === 79);
  for (let i = 0; i < 8; i++) out = tr.update((t += dt), null);
  assert(!out.voiced);
  console.log('✓ takipçi');
}

// 6) Nota ayrıştırıcı.
{
  const { notes, errors } = parseSong('Do5 Re#5 Sib4 C5:2 F#:0,5 - es:2 | sol bb4 La');
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(
    notes.map((n) => [n.midi, n.beats]),
    [[72, 1], [75, 1], [70, 1], [72, 2], [78, 0.5], [null, 1], [null, 2], [79, 1], [70, 1], [69, 1]]
  );
  assert.deepStrictEqual(parseSong('Do5 xyz H5').errors, ['xyz', 'H5']);
  assert.strictEqual(noteLabel(78), 'Fa♯5');
  assert.strictEqual(noteLabel(78, 'letter'), 'F♯5');
  assert.strictEqual(Math.round(freqToMidi(440)), 69);
  console.log('✓ ayrıştırıcı');
}

// 7) Hazır şarkıların hepsi hatasız ayrışmalı; Macar Dansı ölçüleri tam (2/4 → ölçü başına 2 vuruş).
{
  const { SONGS } = require('../js/music.js');
  for (const s of SONGS) {
    const { notes, errors } = parseSong(s.text);
    assert.deepStrictEqual(errors, [], `${s.id}: ${errors}`);
    assert(notes.some((n) => n.midi != null), `${s.id}: nota yok`);
  }
  const beats = (id) => parseSong(SONGS.find((s) => s.id === id).text).notes.reduce((a, n) => a + n.beats, 0);
  assert.strictEqual(beats('macar5'), 32);
  assert.strictEqual(beats('macar5b'), 24);
  console.log(`✓ ${SONGS.length} hazır şarkı`);
}

console.log('Tüm testler geçti.');
