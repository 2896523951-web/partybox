/* 语音播报 —— 「时间到」「第 3 轮」「本局结束」。
 *
 * 走浏览器自带的 speechSynthesis，不依赖任何音频文件：
 * 断网、拷 U 盘、现场没网都能用。
 *
 * 默认是关的。机器不同，朗读声音差别很大：有的笔记本读中文像念经，
 * 有的直接不发声。所以让主持人自己听一遍再决定开不开，
 * 别默认把全场声音交给一个没试过的合成音。
 *
 * 音色不是重点 —— 现场真正有用的是「不用抬头也知道到点了」，
 * 这一点一声「时间到」就够了。
 */
(function (g) {
  function Voice() {
    this.on = false;
    this.rate = 1;
    this.volume = 1;
    this._last = '';
    this._lastAt = 0;
  }

  Voice.prototype.set = function (on) {
    this.on = !!on;
    if (!this.on) this.cancel();
  };

  Voice.prototype.cancel = function () {
    try {
      if (g.speechSynthesis) g.speechSynthesis.cancel();
    } catch (e) {}
  };

  /* 必须在用户手势里调一次：Chrome 会拦住没有交互的语音。
   * 播一个空串不算出声，但把开关打开了。 */
  Voice.prototype.prime = function () {
    try {
      if (!g.speechSynthesis) return;
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      g.speechSynthesis.speak(u);
      g.speechSynthesis.cancel();
    } catch (e) {}
  };

  Voice.prototype.say = function (text, opt) {
    if (!this.on) return false;
    const t = String(text || '').trim().slice(0, 60);
    if (!t) return false;
    try {
      if (!g.speechSynthesis) return false;
      // 同一句连着来两遍（时间到 + 结算同时触发）只说一遍
      const now = Date.now();
      if (t === this._last && now - this._lastAt < 1200) return false;
      this._last = t;
      this._lastAt = now;

      const u = new SpeechSynthesisUtterance(t);
      u.lang = 'zh-CN';
      u.rate = (opt && opt.rate) || this.rate;
      u.pitch = 1;
      u.volume = this.volume;
      g.speechSynthesis.cancel();
      g.speechSynthesis.speak(u);
      return true;
    } catch (e) {
      return false;
    }
  };

  /* 播报能不能用：有些机器一个中文音色都没装，开了也不出声。
   * 主持台点「试一句」时用它给个提示。 */
  Voice.prototype.supported = function () {
    try {
      return !!(g.speechSynthesis && typeof g.SpeechSynthesisUtterance === 'function');
    } catch (e) {
      return false;
    }
  };

  g.Voice = Voice;
})(window);
