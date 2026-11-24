/* 私密音效引擎 —— 只走耳机。
 *
 * 这里只剩「游戏自己的提示音」：得分、倒计时、判错、终局、狼嚎、全场警报。
 * 五个整蛊合成音（汽笛 / 猫叫 / 弹簧 / 悲情小号 / 白噪音）和 5 段浏览器 TTS
 * 在 R4 里全删了 —— 合成出来的声音现场没人会笑，真能让人崩不住的是
 * 主持人自己传进来的那段音频。整蛊类音效现在只放 sfx/ 和曲库里的真文件，
 * 前缀分别是 file: 和 media:。 */

(function (g) {
  function Sfx() {
    this.ctx = null;
    this.ready = false;
    this.noiseBuf = null;
    this.mvol = 0.62; // 音乐音量，和音效分开，自己调不影响提示音
    this.musicGain = null;
    this._musicOn = false;
    this._wantMusic = null;
    // 曲库里的真人歌曲：手机上本地放，不占网络，狼王那台就是不播
    this._fileEl = null;
    this._fileNode = null;
    this._fileSrc = '';
    this._fileTimer = null;
    // 私密音效走一条单独的 fxBus，好处是「停」的时候能一次性全掐掉
    this.fxBus = null;
    // 自己传的音效是一次性 <audio>，得留着引用，否则停不掉
    this._oneShots = [];
  }

  Sfx.prototype.init = async function () {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        try { await this.ctx.resume(); } catch (e) {}
      }
      return;
    }
    const AC = g.AudioContext || g.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);

    // 私密音效专门的总线：停音效时换掉它，正在排队的音符就一起哑了
    this.fxBus = ctx.createGain();
    this.fxBus.gain.value = 1;
    this.fxBus.connect(this.master);

    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) {}
    }
    this.ready = true;
    this._ensureFileEl();
    if (this._wantMusic) {
      const w = this._wantMusic;
      this._wantMusic = null;
      this.startMusic(w.bpm, w.wait, w.offset);
    }
  };

  // 必须在用户手势里调一次，否则 iOS 后面不让出声。
  // 以前这里还要顺手叫醒一次 TTS，TTS 删了之后只剩 <audio> 要解锁。
  Sfx.prototype.prime = function () {
    this.primeFile();
  };

  // 音效一律走 fxBus，音乐走 musicGain —— 两条线互不影响，「停音效」也不会把歌带停
  Sfx.prototype._fxDest = function () {
    return this.fxBus || this.master;
  };

  Sfx.prototype.tone = function (opt) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + (opt.delay || 0);
    const o = ctx.createOscillator();
    const gd = ctx.createGain();
    o.type = opt.type || 'sine';
    o.frequency.setValueAtTime(opt.f, t0);
    if (opt.to) o.frequency.exponentialRampToValueAtTime(opt.to, t0 + opt.dur);
    const peak = opt.gain == null ? 0.18 : opt.gain;
    gd.gain.setValueAtTime(0.0001, t0);
    gd.gain.linearRampToValueAtTime(peak, t0 + (opt.attack || 0.008));
    gd.gain.exponentialRampToValueAtTime(0.0001, t0 + opt.dur);
    o.connect(gd);
    gd.connect(this._fxDest());
    o.start(t0);
    o.stop(t0 + opt.dur + 0.05);
  };

  Sfx.prototype.noise = function (opt) {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuf) return;
    const t0 = ctx.currentTime + (opt.delay || 0);
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = opt.filter || 'lowpass';
    f.frequency.setValueAtTime(opt.f || 1200, t0);
    if (opt.to) f.frequency.exponentialRampToValueAtTime(opt.to, t0 + opt.dur);
    f.Q.value = opt.q || 1;
    const gd = ctx.createGain();
    gd.gain.setValueAtTime(0.0001, t0);
    gd.gain.linearRampToValueAtTime(opt.gain == null ? 0.16 : opt.gain, t0 + 0.02);
    gd.gain.exponentialRampToValueAtTime(0.0001, t0 + opt.dur);
    s.connect(f);
    f.connect(gd);
    gd.connect(this._fxDest());
    s.start(t0);
    s.stop(t0 + opt.dur + 0.05);
  };

  /* ------------------------------------------- 舞蹈狼人杀：耳机里的那首歌
   *
   * 音频不走网络、也不走文件：每台手机自己合成同一首循环舞曲。
   * 20 个人一起「听歌」，服务器一个字节音频都不用发。
   * 狼王的手机上只是不放而已 —— 他不是听到错拍，是根本听不见。
   *
   * 单独一条 musicGain，音量只影响音乐，不影响任何提示音。 */

  const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const BASS_LINE = [33, 33, 36, 33, 31, 31, 36, 38];
  const STABS = [
    [57, 60, 64],
    [57, 60, 64],
    [53, 57, 60],
    [55, 59, 62],
  ];

  Sfx.prototype._ensureMusicGain = function () {
    if (this.musicGain || !this.ctx) return;
    const gd = this.ctx.createGain();
    gd.gain.value = this.mvol;
    // 手机小喇叭放舞曲容易糊，压一道
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    gd.connect(comp);
    comp.connect(this.master);
    this.musicGain = gd;
  };

  Sfx.prototype._mDest = function () {
    this._ensureMusicGain();
    return this.musicGain || this.master;
  };

  /* 曲库歌曲走 <audio>。走 musicGain 分支，所以主持人调音量对它也生效。 */
  Sfx.prototype._ensureFileEl = function () {
    if (this._fileEl || !this.ctx) return this._fileEl;
    const el = new Audio();
    el.preload = 'auto';
    el.loop = true;
    el.setAttribute('playsinline', '');
    el.crossOrigin = 'anonymous';
    try {
      const node = this.ctx.createMediaElementSource(el);
      node.connect(this._mDest());
      this._fileNode = node;
    } catch (e) {}
    this._fileEl = el;
    return el;
  };

  /* iOS 只认手势里起的那一次播放。进场那一下顺手把 <audio> 也叫醒，
     否则等主持人喊开始才播，会被判成「不是用户点的」直接静掉。 */
  Sfx.prototype.primeFile = function () {
    try {
      const el = this._ensureFileEl();
      if (!el || this._fileUnlocked) return;
      this._fileUnlocked = true;
      el.src =
        'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAiBEAAIgRAAABAAgAZGF0YQAAAAA=';
      const p = el.play();
      if (p && p.then) {
        p.then(() => {
          el.pause();
          this._fileSrc = '';
        }).catch(() => {});
      }
    } catch (e) {}
  };

  // 一次性的音频（耳返攻击 / 灌杂音里自己传的音效）
  Sfx.prototype.playFile = function (url, gain) {
    if (!url) return null;
    try {
      const a = new Audio(url);
      a.preload = 'auto';
      a.volume = Math.max(0, Math.min(1, gain == null ? 1 : gain));
      a.setAttribute('playsinline', '');
      // 记下来才能停：不然主持人按「停」只能干看着它放完
      this._oneShots.push(a);
      const drop = () => {
        const i = this._oneShots.indexOf(a);
        if (i >= 0) this._oneShots.splice(i, 1);
      };
      a.addEventListener('ended', drop);
      a.addEventListener('error', drop);
      const p = a.play();
      if (p && p.catch) p.catch(drop);
      return a;
    } catch (e) {
      return null;
    }
  };

  /* 立刻停掉这台手机上的所有私密音效：
   * 合成提示音（tone / noise）和主持人传的音频，一起掐。
   * 只掐音效，舞曲那条线（musicGain）不受影响。 */
  Sfx.prototype.stopFx = function () {
    for (const a of this._oneShots) {
      try {
        a.pause();
        a.currentTime = 0;
      } catch (e) {}
    }
    this._oneShots = [];
    // 已经排上时间的音符停不掉，只能把总线换掉 —— 旧的那条一断就哑了
    if (this.ctx && this.fxBus) {
      const old = this.fxBus;
      try {
        old.gain.cancelScheduledValues(0);
        old.gain.setValueAtTime(0, this.ctx.currentTime);
        old.disconnect();
      } catch (e) {}
      const nb = this.ctx.createGain();
      nb.gain.value = 1;
      nb.connect(this.master);
      this.fxBus = nb;
    }
  };

  Sfx.prototype._kick = function (t, gain) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const gd = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    gd.gain.setValueAtTime(0, t);
    gd.gain.linearRampToValueAtTime(gain, t + 0.004);
    gd.gain.exponentialRampToValueAtTime(0.0008, t + 0.3);
    o.connect(gd);
    gd.connect(this._mDest());
    o.start(t);
    o.stop(t + 0.32);
  };

  Sfx.prototype._hat = function (t, gain, open) {
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
    gd.connect(this._mDest());
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.02);
  };

  Sfx.prototype._clap = function (t) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 1.1;
    const gd = ctx.createGain();
    gd.gain.setValueAtTime(0.0001, t);
    gd.gain.linearRampToValueAtTime(0.2, t + 0.008);
    gd.gain.exponentialRampToValueAtTime(0.0006, t + 0.14);
    s.connect(bp);
    bp.connect(gd);
    gd.connect(this._mDest());
    s.start(t, Math.random() * 1.8);
    s.stop(t + 0.16);
  };

  Sfx.prototype._bass = function (t, midi, dur) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = mtof(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 6;
    f.frequency.setValueAtTime(1200, t);
    f.frequency.exponentialRampToValueAtTime(220, t + dur);
    const gd = ctx.createGain();
    gd.gain.setValueAtTime(0, t);
    gd.gain.linearRampToValueAtTime(0.22, t + 0.006);
    gd.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(f);
    f.connect(gd);
    gd.connect(this._mDest());
    o.start(t);
    o.stop(t + dur + 0.02);
  };

  Sfx.prototype._stab = function (t, notes) {
    const ctx = this.ctx;
    const gd = ctx.createGain();
    gd.gain.setValueAtTime(0, t);
    gd.gain.linearRampToValueAtTime(0.05, t + 0.01);
    gd.gain.exponentialRampToValueAtTime(0.0008, t + 0.24);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 0.9;
    gd.connect(bp);
    bp.connect(this._mDest());
    for (const n of notes) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = mtof(n);
      o.detune.value = (Math.random() - 0.5) * 12;
      o.connect(gd);
      o.start(t);
      o.stop(t + 0.26);
    }
  };

  Sfx.prototype._step = function (step, t) {
    const s = step % 16;
    if (s % 4 === 0) this._kick(t, 0.8);
    if (s === 14) this._kick(t, 0.4);
    if (s % 2 === 0) this._hat(t, s % 8 === 4 ? 0.085 : 0.045, s % 8 === 4);
    else this._hat(t, 0.026, false);
    if (s === 4 || s === 12) this._clap(t);
    if (s % 2 === 0) this._bass(t, BASS_LINE[Math.floor(step / 2) % BASS_LINE.length], 0.2);
    if (s === 6 || s === 14) this._stab(t, STABS[Math.floor(step / 32) % STABS.length]);
  };

  /* wait  = 距离第一拍还有多少秒。
     offset = 从曲目的第几秒开始放（拖动进度条用）。
     所有人按服务端给的同一个开始时刻 + 同一个 offset 算，踩的是同一拍。 */
  Sfx.prototype.startMusic = function (bpm, wait, offset) {
    const b = Math.min(180, Math.max(70, Number(bpm) || 118));
    this.stopMusic();
    if (!this.ready) {
      this._wantMusic = { bpm: b, wait: Number(wait) || 0.06, offset: Math.max(0, Number(offset) || 0) };
      return;
    }
    this._haltFile();
    const ctx = this.ctx;
    this._musicBpm = b;
    this._musicSpb = 60 / b / 4; // 一个十六分音符多长
    this._musicOn = true;
    let w = Number(wait) || 0;
    if (!(w >= 0.02)) w = 0.06;
    this._origin = ctx.currentTime + w;
    // 从第 offset 秒对应的那一格开始 —— 所有手机按同一个 offset 算，格子必然相同
    this._musicOff = Math.max(0, Number(offset) || 0);
    this._nStep = Math.max(0, Math.round(this._musicOff / this._musicSpb));
    clearInterval(this._mtimer);
    this._mtimer = setInterval(() => this._pumpMusic(), 25);
    this._pumpMusic();
  };

  /* 用曲库里的真人歌曲。每人手机本地放自己那份，服务端只发地址和开始时刻。
     狼王那台不播 —— 他听不见，别人听得见。
     哪个手机格式不支持 / 拉不下来，就退回合成舞曲，别让那一台彻底没声。 */
  Sfx.prototype.startMusicFile = function (url, wait, offset, bpm) {
    this._haltSynth();
    this._musicOn = false;
    const el = this._ensureFileEl();
    if (!el) return;
    this._fileOn = true;
    this._fileBpm = bpm || 118;
    const fallback = () => {
      if (!this._fileOn) return;
      this._fileOn = false;
      this.startMusic(this._fileBpm, 0.08, Math.max(0, Number(offset) || 0));
    };
    el.onerror = fallback;
    if (this._fileSrc !== url) {
      this._fileSrc = url;
      el.src = url;
      try { el.load(); } catch (e) {}
    }
    const go = () => {
      const dur = isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
      const off = Math.max(0, Number(offset) || 0);
      try { el.currentTime = dur > 0 ? off % dur : off; } catch (e) {}
      const w = Math.max(0, Number(wait) || 0);
      clearTimeout(this._fileTimer);
      this._fileTimer = setTimeout(() => {
        if (!this._fileOn) return;
        const p = el.play();
        if (p && p.catch) p.catch(fallback);
      }, w * 1000);
    };
    if (el.readyState >= 1) go();
    else el.addEventListener('loadedmetadata', go, { once: true });
  };

  // 提前把歌拉进缓存：真跳之前先备好，别等主持人喊开始才转圈
  Sfx.prototype.preloadFile = function (url) {
    if (!url) return;
    const el = this._ensureFileEl();
    if (!el || this._fileSrc === url) return;
    // 不打断正在放的
    if (this._fileOn) return;
    this._fileSrc = url;
    el.src = url;
    try { el.load(); } catch (e) {}
  };

  Sfx.prototype._haltSynth = function () {
    this._musicOn = false;
    this._wantMusic = null;
    if (this._mtimer) {
      clearInterval(this._mtimer);
      this._mtimer = null;
    }
  };

  Sfx.prototype._haltFile = function () {
    this._fileOn = false;
    clearTimeout(this._fileTimer);
    this._fileTimer = null;
    if (this._fileEl) {
      try { this._fileEl.pause(); } catch (e) {}
    }
  };

  Sfx.prototype._pumpMusic = function () {
    if (!this._musicOn || !this.ctx) return;
    const ctx = this.ctx;
    // 切后台回来时 currentTime 会跳，别一口气补发几百个音符
    if (this._origin < ctx.currentTime - 1) {
      this._origin = ctx.currentTime + 0.06;
      // 回到拖动点，而不是曲子开头 —— 否则进度条和听感对不上
      this._nStep = Math.max(0, Math.round((this._musicOff || 0) / this._musicSpb));
    }
    const horizon = ctx.currentTime + 0.18;
    let guard = 0;
    while (this._origin + this._nStep * this._musicSpb < horizon && guard < 64) {
      const t = this._origin + this._nStep * this._musicSpb;
      if (t >= ctx.currentTime - 0.02) this._step(this._nStep, t);
      this._nStep += 1;
      guard += 1;
    }
  };

  Sfx.prototype.stopMusic = function () {
    this._haltSynth();
    this._haltFile();
  };

  /* 0–1。0 就是静音。只影响音乐，不影响任何音效。 */
  Sfx.prototype.setMusicVolume = function (v) {
    const x = Math.max(0, Math.min(1, Number(v) || 0));
    this.mvol = x;
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.setTargetAtTime(x, this.ctx.currentTime, 0.02);
    }
  };

  /* 把音乐压低，不是掐掉：私密音效进来时舞曲让路十几秒。
   * 两条音轨一起响谁也听不清谁；舞蹈狼人杀的音乐本身是游戏信息，
   * 压到三成还听得见，掐掉就等于把线索抽走了。 */
  Sfx.prototype.duck = function (ms) {
    if (!this.ctx) return;
    if (!this._ducking) {
      this._ducking = true;
      this._duckPrev = this.mvol;
    }
    if (this.musicGain) {
      this.musicGain.gain.setTargetAtTime(this.mvol * 0.3, this.ctx.currentTime, 0.05);
    }
    clearTimeout(this._duckTimer);
    this._duckTimer = setTimeout(() => this.unduck(), ms || 12000);
  };

  Sfx.prototype.unduck = function () {
    clearTimeout(this._duckTimer);
    if (!this._ducking) return;
    this._ducking = false;
    this.setMusicVolume(this._duckPrev);
  };

  // 老接口，留着给别处用
  Sfx.prototype.startBeat = function (bpm) {
    this.startMusic(bpm, 0.06);
  };

  Sfx.prototype.stopBeat = function () {
    this.stopMusic();
  };

  /* 名字只有两种：
   *   'ding' / 'win' …      游戏自己的提示音，现场合成
   *   'file:xxx' / 'media:xxx'  主持人传的音频：私密音效库 / 曲库
   * 别的一律给一声轻响，不要静悄悄 —— 现场「没声」是最难查的故障。 */
  Sfx.prototype.play = function (name) {
    if (!this.ready) return;
    if (typeof name === 'string' && name.indexOf('file:') === 0) {
      this.playFile('/sfx/' + encodeURIComponent(name.slice(5)));
      return;
    }
    if (typeof name === 'string' && name.indexOf('media:') === 0) {
      this.playFile('/media/' + encodeURIComponent(name.slice(6)));
      return;
    }
    switch (name) {
      case 'ding':
        this.tone({ f: 1046, dur: 0.18, gain: 0.2 });
        this.tone({ f: 1568, dur: 0.28, gain: 0.14, delay: 0.1 });
        break;
      case 'tick':
        this.tone({ f: 1400, dur: 0.05, type: 'square', gain: 0.08 });
        break;
      case 'buzzErr':
        this.tone({ f: 180, to: 90, dur: 0.32, type: 'square', gain: 0.14 });
        break;
      case 'win': {
        const notes = [523, 659, 784, 1046];
        notes.forEach((f, i) =>
          this.tone({ f, dur: 0.22, gain: 0.16, delay: i * 0.09, type: 'triangle' })
        );
        break;
      }
      case 'boom':
        this.noise({ dur: 0.7, f: 900, to: 80, gain: 0.3 });
        this.tone({ f: 90, to: 40, dur: 0.8, gain: 0.3 });
        break;
      case 'wolf':
        this.tone({ f: 120, to: 70, dur: 1.1, type: 'sawtooth', gain: 0.12 });
        this.tone({ f: 61, dur: 1.2, type: 'sine', gain: 0.18, delay: 0.05 });
        break;
      // 全场警报：好几个游戏「开始投票」都用它，别当整蛊音删了
      case 'siren':
        this.tone({ f: 720, to: 980, dur: 0.28, type: 'square', gain: 0.1 });
        this.tone({ f: 980, to: 720, dur: 0.28, type: 'square', gain: 0.1, delay: 0.28 });
        this.tone({ f: 720, to: 980, dur: 0.28, type: 'square', gain: 0.1, delay: 0.56 });
        break;
      default:
        this.tone({ f: 660, dur: 0.15, gain: 0.15 });
    }
  };

  Sfx.prototype.vibrate = function (p) {
    if (navigator.vibrate) navigator.vibrate(p);
  };

  g.Sfx = Sfx;
})(window);
