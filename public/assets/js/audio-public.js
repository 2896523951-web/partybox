/* 公共音频引擎 —— 跑在主持人的电脑上，声音从电视 / 音响出来。
 * 玩家手机不再拉长音频，所以这里不考虑多端同步，只管「别停」。 */

(function (g) {
  const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const BASS_LINE = [33, 33, 36, 33, 31, 31, 36, 38];
  const STAB_CHORDS = [
    [57, 60, 64],
    [57, 60, 64],
    [53, 57, 60],
    [55, 59, 62],
  ];

  function PublicAudio() {
    this.ctx = null;
    this.ready = false;
    this.playing = false;
    this.kind = 'synth';
    this.stepDur = 0;
    this.origin = 0;
    this.nextStep = 0;
    this.timer = null;
    this.el = null;
    this.fileUrl = null;
    this.volume = 0.85;
    this.stallAt = 0;
    this.guardTimer = null;
  }

  PublicAudio.prototype.init = async function () {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        try { await this.ctx.resume(); } catch (e) {}
      }
      return;
    }
    const AC = g.AudioContext || g.webkitAudioContext;
    const ctx = new AC({ latencyHint: 'playback' });
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 3;

    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) {}
    }
    this.ready = true;
    this._guard();
  };

  /* ---------------------------------------------------------- 乐器 */

  PublicAudio.prototype.kick = function (t, gain) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const gd = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    gd.gain.setValueAtTime(0, t);
    gd.gain.linearRampToValueAtTime(gain, t + 0.004);
    gd.gain.exponentialRampToValueAtTime(0.0008, t + 0.3);
    o.connect(gd);
    gd.connect(this.master);
    o.start(t);
    o.stop(t + 0.32);
  };

  PublicAudio.prototype.hat = function (t, gain, open) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.playbackRate.value = 1.6;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = open ? 6500 : 8200;
    const gd = ctx.createGain();
    const dur = open ? 0.16 : 0.045;
    gd.gain.setValueAtTime(gain, t);
    gd.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    s.connect(hp);
    hp.connect(gd);
    gd.connect(this.master);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.02);
  };

  PublicAudio.prototype.clap = function (t) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 1.1;
    const gd = ctx.createGain();
    gd.gain.setValueAtTime(0.0001, t);
    gd.gain.linearRampToValueAtTime(0.26, t + 0.008);
    gd.gain.exponentialRampToValueAtTime(0.0006, t + 0.14);
    s.connect(bp);
    bp.connect(gd);
    gd.connect(this.master);
    s.start(t, Math.random() * 1.8);
    s.stop(t + 0.16);
  };

  PublicAudio.prototype.bass = function (t, midi, dur) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = NOTE(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 7;
    f.frequency.setValueAtTime(1400, t);
    f.frequency.exponentialRampToValueAtTime(240, t + dur);
    const gd = ctx.createGain();
    gd.gain.setValueAtTime(0, t);
    gd.gain.linearRampToValueAtTime(0.3, t + 0.006);
    gd.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(f);
    f.connect(gd);
    gd.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  };

  PublicAudio.prototype.stab = function (t, notes) {
    const ctx = this.ctx;
    const gd = ctx.createGain();
    gd.gain.setValueAtTime(0, t);
    gd.gain.linearRampToValueAtTime(0.075, t + 0.01);
    gd.gain.exponentialRampToValueAtTime(0.0008, t + 0.26);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 0.9;
    gd.connect(bp);
    bp.connect(this.master);
    for (const n of notes) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = NOTE(n);
      o.detune.value = (Math.random() - 0.5) * 12;
      o.connect(gd);
      o.start(t);
      o.stop(t + 0.28);
    }
  };

  PublicAudio.prototype.scheduleStep = function (step, t) {
    const s = step % 16;
    if (s % 4 === 0) this.kick(t, 0.95);
    if (s === 14) this.kick(t, 0.45);
    if (s % 2 === 0) this.hat(t, s % 8 === 4 ? 0.1 : 0.055, s % 8 === 4);
    else this.hat(t, 0.03, false);
    if (s === 4 || s === 12) this.clap(t);
    if (s % 2 === 0) this.bass(t, BASS_LINE[(Math.floor(step / 2)) % BASS_LINE.length], 0.2);
    if (s === 6 || s === 14) {
      this.stab(t, STAB_CHORDS[Math.floor(step / 32) % STAB_CHORDS.length]);
    }
  };

  PublicAudio.prototype.loop = function () {
    if (!this.playing || this.kind !== 'synth') return;
    const ctx = this.ctx;
    const horizon = ctx.currentTime + 0.18;
    let guard = 0;
    while (this.origin + this.nextStep * this.stepDur < horizon && guard++ < 64) {
      const t = this.origin + this.nextStep * this.stepDur;
      if (t >= ctx.currentTime - 0.02) this.scheduleStep(this.nextStep, t);
      this.nextStep++;
    }
  };

  /* ------------------------------------------------------- 对外 API */

  PublicAudio.prototype.startSynth = function (bpm, fromMs) {
    if (!this.ready) return;
    const ctx = this.ctx;
    this.stopFile();
    this.kind = 'synth';
    const beatMs = 60000 / Math.max(60, bpm || 122);
    this.stepDur = beatMs / 4 / 1000;
    const startStep = Math.max(0, Math.ceil((fromMs || 0) / (this.stepDur * 1000)));
    this.nextStep = startStep;
    this.origin = ctx.currentTime + 0.06 - startStep * this.stepDur;
    this.playing = true;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.loop(), 25);
    this.loop();
  };

  PublicAudio.prototype.stopSynth = function () {
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
  };

  PublicAudio.prototype.ensureElement = function () {
    if (this.el) return this.el;
    const el = new Audio();
    el.preload = 'auto';
    el.loop = true;
    el.setAttribute('playsinline', '');
    el.crossOrigin = 'anonymous';
    const src = this.ctx.createMediaElementSource(el);
    const gd = this.ctx.createGain();
    gd.gain.value = 0.9;
    src.connect(gd);
    gd.connect(this.master);
    this.el = el;
    return el;
  };

  PublicAudio.prototype.playFile = function (url, fromMs) {
    if (!this.ready) return;
    this.stopSynth();
    this.kind = 'file';
    const el = this.ensureElement();
    const abs = new URL(url, location.href).href;
    if (el.src !== abs) {
      el.src = abs;
      el.load();
    }
    const elapsed = Math.max(0, (fromMs || 0) / 1000);
    const go = () => {
      const seek = () => {
        const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
        const target = dur > 0 ? elapsed % dur : elapsed;
        try {
          if (Math.abs(el.currentTime - target) > 0.2) el.currentTime = target;
        } catch (e) {}
        const pr = el.play();
        if (pr && pr.catch) pr.catch(() => {});
        this.playing = true;
        this.stallAt = 0;
      };
      if (el.readyState >= 1) seek();
      else el.addEventListener('loadedmetadata', seek, { once: true });
    };
    go();
  };

  PublicAudio.prototype.stopFile = function () {
    if (this.el) {
      try {
        this.el.pause();
        this.el.currentTime = 0;
      } catch (e) {}
    }
    this.playing = false;
  };

  PublicAudio.prototype.stopAll = function () {
    this.stopSynth();
    this.stopFile();
  };

  PublicAudio.prototype.setVolume = function (v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.volume;
  };

  /* 现场最怕的是「歌自己停了」：切标签、系统休眠、蓝牙断开都会。
     这里每秒体检一次，停了就拉回来。 */
  PublicAudio.prototype._guard = function () {
    clearInterval(this.guardTimer);
    this.guardTimer = setInterval(() => {
      if (!this.ready || !this.playing || this.kind !== 'file' || !this.el) return;
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      if (this.el.paused && this.el.readyState >= 2) {
        this.el.play().catch(() => {});
      }
      if (!this.el.paused) {
        const t = this.el.currentTime;
        if (this.stallAt && Math.abs(t - this.stallAt) < 0.001) {
          try { this.el.currentTime = t + 0.2; } catch (e) {}
          this.el.play().catch(() => {});
        }
        this.stallAt = t;
      }
    }, 1000);
  };

  PublicAudio.prototype.info = function () {
    return {
      playing: this.playing,
      kind: this.kind,
      pos: this.el && this.kind === 'file' ? this.el.currentTime : 0,
      dur: this.el && this.kind === 'file' ? this.el.duration || 0 : 0,
      ctx: this.ctx ? this.ctx.state : 'none',
    };
  };

  g.PublicAudio = PublicAudio;
})(window);
