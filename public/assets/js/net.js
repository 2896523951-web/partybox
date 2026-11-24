/* 客户端网络层：SSE + 授时 + 请求。 */
(function (g) {
  const NET = {
    pid: '',
    key: new URLSearchParams(location.search).get('k') || '',
    offset: 0,
    es: null,

    withKey(url) {
      if (!this.key) return url;
      return url + (url.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(this.key);
    },

    serverNow() {
      return Date.now() + this.offset;
    },

    async post(path, body) {
      const r = await fetch(this.withKey(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return r.json();
    },

    async ping() {
      const t0 = Date.now();
      const r = await fetch(this.withKey('/api/clock/ping'), { cache: 'no-store' });
      const d = await r.json();
      const t1 = Date.now();
      return { offset: d.s - (t0 + t1) / 2, rtt: t1 - t0 };
    },

    /* 抢答精度靠这一步：取 RTT 最小的三次，再取中位数，避免一次抖动把结果带偏 */
    async syncClock() {
      const samples = [];
      for (let i = 0; i < 5; i++) {
        try {
          samples.push(await this.ping());
        } catch (e) {}
      }
      if (!samples.length) return 0;
      samples.sort((a, b) => a.rtt - b.rtt);
      const best = samples.slice(0, 3).map((x) => x.offset).sort((a, b) => a - b);
      this.offset = best[Math.floor(best.length / 2)] || 0;
      if (this.pid) {
        this.post('/api/clock', { id: this.pid, offset: this.offset }).catch(() => {});
      }
      return this.offset;
    },

    stream(role, pid, onEvent, onState) {
      if (this.es) {
        this.es.close();
        this.es = null;
      }
      const q = role === 'play' ? `role=play&pid=${encodeURIComponent(pid)}` : `role=${role}`;
      const es = new EventSource(this.withKey('/api/stream?' + q));
      this.es = es;
      es.onopen = () => onState && onState(true);
      es.onerror = () => onState && onState(false);
      es.onmessage = (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch (e) {
          return;
        }
        onEvent(m);
      };
      return es;
    },
  };

  g.NET = NET;
})(window);
