'use strict';
/* 临时验证：主持台的曲目进度条在真实浏览器里拖得动吗？
 * 1) 进度条存在且没禁用
 * 2) 改 value + 派发 input/change → 服务端 musicOffset 真的变了
 * 3) 拖完之后时间文字跟着走，狼王和好人拿到同一个位置
 * 用完即删。 */

const { spawn } = require('child_process');
const http = require('http');

const CHROME = require('../lib/chrome');
const PORT = 9334;
const BASE = process.env.BASE || 'http://127.0.0.1:3321';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch (e) { resolve(d); }
        });
      })
      .on('error', reject);
  });
}

async function api(p, body) {
  const r = await fetch(BASE + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + label);
  } else {
    fail += 1;
    console.log('  ✗ ' + label + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)));
  }
}

async function main() {
  // 造 4 个人，开局并开始放歌
  await api('/api/host', { cmd: 'room/kickAll' });
  const players = [];
  for (const n of ['甲', '乙', '丙', '丁']) {
    const r = await api('/api/join', { name: n, headset: true });
    if (r.id) players.push(r);
  }
  await api('/api/host', { cmd: 'game/select', id: 'dancewolf' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });

  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--user-data-dir=C:\\temp\\pb-drag-profile',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let list = null;
  for (let i = 0; i < 40; i++) {
    try {
      list = await get('/json/list');
      if (Array.isArray(list) && list.length) break;
    } catch (e) {}
    await sleep(300);
  }
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));

  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params: params || {} }));
    });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : null;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: BASE + '/host' });
  await sleep(2600);

  // 开局之前：进度条应该是禁用状态
  const before = await evalJs(`(() => {
    const r = document.querySelector('.seek-range');
    return r ? { exists: true, disabled: r.disabled } : { exists: false };
  })()`);
  ok(before && before.exists, '开局前主持台上已有进度条', before);
  ok(before && before.disabled === true, '开局前进度条是灰的（拖不动）', before);

  await api('/api/host', { cmd: 'game/act', action: 'host_start' });
  await sleep(1500);

  const ready = await evalJs(`(() => {
    const r = document.querySelector('.seek-range');
    return r ? {
      exists: true, disabled: r.disabled, value: Number(r.value),
      max: Number(r.max),
      text: (document.querySelector('.seek-time') || {}).textContent || '',
    } : { exists: false };
  })()`);
  ok(ready && ready.exists && ready.disabled === false, '开始放歌后进度条可以拖', ready);
  ok(ready && Math.abs(ready.max - 60) < 0.01, '滑块上限 = 60 秒', ready && ready.max);
  ok(ready && ready.value > 0.5 && ready.value < 8, '没人碰的时候进度自己在走', ready && ready.value);

  // 真的拖：改 value + 派发 input 再 change
  const dragged = await evalJs(`(() => {
    const r = document.querySelector('.seek-range');
    if (!r) return null;
    r.value = '40';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    const mid = (document.querySelector('.seek-time') || {}).textContent || '';
    r.dispatchEvent(new Event('change', { bubbles: true }));
    return { mid };
  })()`);
  ok(dragged && /0:40/.test(dragged.mid), '拖动时时间文字立刻跟手（0:40）', dragged);

  await sleep(700);

  // 服务端收到的位置
  const hs = await api('/api/state?role=host');
  const ctl = (hs.panel.controls || []).find((c) => c.kind === 'seek');
  ok(ctl && Math.abs(ctl.offset - 40) < 0.2, '服务端记下了拖到的位置（40 秒）', ctl && ctl.offset);

  // 所有玩家拿到同一个位置
  const views = [];
  for (const p of players) {
    const s = await api('/api/state?role=play&pid=' + p.id);
    if (s.view && s.view.beat) views.push({ name: p.name, beat: s.view.beat });
  }
  const offs = views.map((v) => Number(v.beat.offset) || 0);
  const starts = views.map((v) => Number(v.beat.startAt) || 0);
  ok(views.length >= 4, '四个玩家都拿到节拍信息', views.length);
  ok(
    offs.every((x) => Math.abs(x - 40) < 0.2),
    '所有人都跳到第 40 秒（不是各拖各的）',
    offs
  );
  ok(new Set(starts).size === 1, '所有人拿到同一个开始时刻，踩同一拍', starts);

  const onCount = views.filter((v) => v.beat.on).length;
  ok(onCount === views.length - 1, '只有狼王那台不出声', onCount);

  const shown = await evalJs(`(document.querySelector('.seek-time') || {}).textContent || ''`);
  ok(/0:4[0-9]/.test(shown), '拖完进度条停在 40 秒附近继续走', shown);

  /* ---- 耳机音量滑杆：手指按着的时候不许被重画 ----
   * 这根条是新加的，一开始没纳入拖动保护。真实的坏手感是这样出现的：
   * 手指按着拖到 40%，这时服务端因为别的原因推了一次状态（旧值 20%），
   * 控件整块被重画 → 滑杆跳回 20% → 表现成「一次只能跳 5%」。
   * 所以这里直接验证「拖动期间控件元素没有被替换」：
   * 打个标记，再人为制造一次推送，看标记还在不在。 */
  const volBefore = await evalJs(`(() => {
    const r = document.querySelector('.sel.rng input[type=range]');
    if (!r) return { exists: false };
    return { exists: true, value: Number(r.value), min: Number(r.min), max: Number(r.max) };
  })()`);
  ok(volBefore && volBefore.exists, '主持台上有耳机音量滑杆', volBefore);

  if (volBefore && volBefore.exists) {
    await evalJs(`(() => {
      const r = document.querySelector('.sel.rng input[type=range]');
      r.dataset.pbMark = 'dragging';
      r.value = '40';
      r.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

    // 手指还按着的时候，服务端推一次（音量被别处改成 20）
    await api('/api/host', { cmd: 'game/act', action: 'host_vol', vol: 20 });
    await sleep(260);

    const during = await evalJs(`(() => {
      const r = document.querySelector('.sel.rng input[type=range]');
      return r ? { mark: r.dataset.pbMark || '', value: Number(r.value) } : null;
    })()`);
    ok(during && during.mark === 'dragging', '拖动期间滑杆没有被重画（手指按着的还是那根条）', during);
    ok(during && during.value === 40, '拖动期间滑杆停在手指位置（40），没被服务端旧值顶回去', during);

    // 松手：这一下才允许重画
    await evalJs(`(() => {
      const r = document.querySelector('.sel.rng input[type=range]');
      if (!r) return false;
      r.value = '40';
      r.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(900);
    const volAfter = await evalJs(
      `(() => { const r = document.querySelector('.sel.rng input[type=range]'); return r ? Number(r.value) : null; })()`
    );
    ok(volAfter === 40, '松手后音量停在 40，没有弹回', volAfter);

    const hs2 = await api('/api/state?role=host');
    const volCtl = (hs2.panel.controls || []).find((c) => c.kind === 'range');
    ok(volCtl && Number(volCtl.value) === 40, '服务端记下了音量 40', volCtl && volCtl.value);
  }

  ws.close();
  proc.kill();
  console.log(`\n  通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('ERR', e && e.message);
  process.exit(1);
});
