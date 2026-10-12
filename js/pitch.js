/*
 * Islık perde algılama.
 *
 * Islık neredeyse saf bir sinüs dalgasıdır: enerjinin neredeyse tamamı tek bir
 * frekansta toplanır, harmonikleri çok zayıftır. Bu yüzden spektrumdaki en
 * güçlü tepeyi bulup parabolik interpolasyonla inceltmek, otokorelasyon
 * yöntemlerinden (yüksek frekanslarda kaba kalırlar) daha isabetli sonuç verir.
 *
 * "Netlik" (clarity), bant içi enerjinin ne kadarının o tek tepede
 * toplandığıdır: ıslıkta ~0.6–1, konuşma ve gürültüde ~0–0.2.
 */
(function (root) {
  'use strict';

  function hann(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
  }

  // Yerinde çalışan radix-2 FFT (ön hesaplanmış twiddle tablolarıyla).
  class FFT {
    constructor(n) {
      this.n = n;
      this.cos = new Float64Array(n / 2);
      this.sin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) {
        this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
        this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
      }
      const bits = Math.round(Math.log2(n));
      this.rev = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
        this.rev[i] = r;
      }
    }

    transform(re, im) {
      const n = this.n;
      for (let i = 0; i < n; i++) {
        const j = this.rev[i];
        if (i < j) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let start = 0; start < n; start += size) {
          for (let k = 0; k < half; k++) {
            const a = start + k;
            const b = a + half;
            const wr = this.cos[k * step];
            const wi = this.sin[k * step];
            const tr = re[b] * wr - im[b] * wi;
            const ti = re[b] * wi + im[b] * wr;
            re[b] = re[a] - tr;
            im[b] = im[a] - ti;
            re[a] += tr;
            im[a] += ti;
          }
        }
      }
    }
  }

  class PitchDetector {
    constructor(sampleRate, opts = {}) {
      this.sampleRate = sampleRate;
      this.frameSize = opts.frameSize || 2048;
      this.fftSize = this.frameSize * (opts.pad || 4); // sıfır doldurma → daha sık frekans ızgarası
      this.minFreq = opts.minFreq || 350;
      this.maxFreq = opts.maxFreq || 5000;
      this.window = hann(this.frameSize);
      this.fft = new FFT(this.fftSize);
      this.re = new Float64Array(this.fftSize);
      this.im = new Float64Array(this.fftSize);
      this.power = new Float64Array(this.fftSize / 2);
    }

    /** samples: en az frameSize uzunluğunda; son frameSize örnek analiz edilir. */
    detect(samples) {
      const n = this.frameSize;
      const N = this.fftSize;
      const re = this.re;
      const im = this.im;
      const offset = samples.length - n;

      let mean = 0;
      for (let i = 0; i < n; i++) mean += samples[offset + i];
      mean /= n;

      let sumSq = 0;
      for (let i = 0; i < n; i++) {
        const s = samples[offset + i] - mean;
        sumSq += s * s;
        re[i] = s * this.window[i];
      }
      re.fill(0, n);
      im.fill(0);

      const rms = Math.sqrt(sumSq / n);
      const db = 20 * Math.log10(rms + 1e-12);

      this.fft.transform(re, im);
      const half = N / 2;
      const P = this.power;
      for (let k = 0; k < half; k++) P[k] = re[k] * re[k] + im[k] * im[k];

      const binHz = this.sampleRate / N;
      const lo = Math.max(2, Math.floor(this.minFreq / binHz));
      const hi = Math.min(half - 2, Math.ceil(this.maxFreq / binHz));
      let peak = lo;
      for (let k = lo + 1; k <= hi; k++) if (P[k] > P[peak]) peak = k;

      // Log-güç üzerinde parabolik interpolasyon (Hann penceresinde çok küçük sapma).
      const a = Math.log(P[peak - 1] + 1e-30);
      const b = Math.log(P[peak] + 1e-30);
      const c = Math.log(P[peak + 1] + 1e-30);
      const denom = a - 2 * b + c;
      const delta = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
      const freq = (peak + delta) * binHz;

      // Netlik: tepenin ana lobundaki güç / 150–8000 Hz bandındaki toplam güç.
      const lobe = 3 * (N / n);
      const tLo = Math.max(1, Math.floor(150 / binHz));
      const tHi = Math.min(half - 1, Math.ceil(8000 / binHz));
      let total = 0;
      let inPeak = 0;
      for (let k = tLo; k <= tHi; k++) {
        total += P[k];
        if (k >= peak - lobe && k <= peak + lobe) inPeak += P[k];
      }
      const clarity = total > 0 ? inPeak / total : 0;

      return { freq, clarity, rms, db };
    }
  }

  function median(values) {
    const s = values.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /**
   * Kare kare gelen ham ölçümleri yumuşatır: tek karelik sıçramaları medyanla
   * eler, çok kısa kesintileri (dil vuruşu, nefes) köprüler ve tek karelik
   * tıkırtıları ses saymaz.
   */
  class PitchTracker {
    constructor(opts = {}) {
      this.size = opts.size || 5;
      this.gap = opts.gap || 0.08;
      this.minFrames = opts.minFrames || 2;
      this.values = [];
      this.lastT = -Infinity;
      this.run = 0;
    }

    update(t, value) {
      if (value != null) {
        this.values.push(value);
        if (this.values.length > this.size) this.values.shift();
        this.lastT = t;
        this.run++;
      } else if (t - this.lastT > this.gap) {
        this.values = [];
        this.run = 0;
      }
      const voiced = this.run >= this.minFrames && t - this.lastT <= this.gap;
      return { voiced, value: voiced ? median(this.values) : null };
    }
  }

  const api = { PitchDetector, PitchTracker, FFT, median };
  root.WhistlePitch = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
