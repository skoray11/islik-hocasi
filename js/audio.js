/*
 * Mikrofon girişi ve referans sesler (ıslığa benzeyen sinüs + hafif vibrato).
 */
(function (root) {
  'use strict';

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.analyser = null;
      this.buf = null;
      this.voices = new Set();
      this.testOsc = null;
      this.testGain = null;
    }

    get running() {
      return !!this.ctx;
    }

    get sampleRate() {
      return this.ctx.sampleRate;
    }

    now() {
      return this.ctx.currentTime;
    }

    /** test: true → mikrofon yerine kontrol edilebilir bir osilatör (geliştirme için). */
    async start({ test = false } = {}) {
      const Ctx = root.AudioContext || root.webkitAudioContext;
      const ctx = new Ctx();
      try {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;

        if (test) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          gain.gain.value = 0;
          osc.connect(gain).connect(analyser);
          osc.start();
          this.testOsc = osc;
          this.testGain = gain;
        } else {
          // Tarayıcının gürültü bastırma/otomatik kazanç filtreleri ıslığı bozar, kapatıyoruz.
          this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          });
          ctx.createMediaStreamSource(this.stream).connect(analyser);
        }
        if (ctx.state === 'suspended') await ctx.resume();

        this.out = ctx.createGain();
        this.out.gain.value = 0.9;
        this.out.connect(ctx.destination);
        this.analyser = analyser;
        this.buf = new Float32Array(analyser.fftSize);
        this.ctx = ctx;
      } catch (err) {
        ctx.close();
        throw err;
      }
    }

    /** Telefonda uygulama değiştirince askıya alınan sesi geri açar. */
    resume() {
      if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    }

    read() {
      this.analyser.getFloatTimeDomainData(this.buf);
      return this.buf;
    }

    setTestTone(freq, level = 0.25) {
      if (!this.testOsc) return;
      const t = this.ctx.currentTime;
      if (freq) this.testOsc.frequency.setValueAtTime(freq, t);
      this.testGain.gain.setValueAtTime(freq ? level : 0, t);
    }

    /** Islık benzeri ton planlar; bitiş zamanını döndürür. */
    tone(freq, start, dur, vol = 0.22) {
      const ctx = this.ctx;
      const att = Math.min(0.03, dur * 0.3);
      const rel = Math.min(0.06, dur * 0.3);

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const vib = ctx.createOscillator();
      vib.frequency.value = 5.5;
      const vibDepth = ctx.createGain();
      vibDepth.gain.value = freq * 0.004;
      vib.connect(vibDepth).connect(osc.frequency);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(vol, start + att);
      g.gain.setValueAtTime(vol, start + dur - rel);
      g.gain.linearRampToValueAtTime(0, start + dur);
      osc.connect(g).connect(this.out);

      osc.start(start);
      vib.start(start);
      osc.stop(start + dur + 0.02);
      vib.stop(start + dur + 0.02);
      const voice = { osc, vib, g };
      this.voices.add(voice);
      osc.onended = () => this.voices.delete(voice);
      return start + dur;
    }

    /** Metronom tıkı. */
    click(start, accent = false) {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = accent ? 1320 : 880;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(accent ? 0.35 : 0.25, start + 0.003);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.06);
      osc.connect(g).connect(this.out);
      osc.start(start);
      osc.stop(start + 0.08);
      const voice = { osc, g };
      this.voices.add(voice);
      osc.onended = () => this.voices.delete(voice);
      return start + 0.06;
    }

    stopAll() {
      const t = this.ctx.currentTime;
      for (const v of this.voices) {
        try {
          v.g.gain.cancelScheduledValues(t);
          v.g.gain.setValueAtTime(0, t);
          v.osc.stop(t + 0.01);
          if (v.vib) v.vib.stop(t + 0.01);
        } catch (_) {
          // henüz başlamamış ya da bitmiş ses: önemsiz
        }
      }
      this.voices.clear();
    }
  }

  root.WhistleAudio = { AudioEngine };
})(window);
