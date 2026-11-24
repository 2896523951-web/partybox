'use strict';

/* 双卧底的「同伙：XXX」必须在遮罩下面。
 * 服务端视图正确 ≠ 手机上真的看不见 —— 所以这里开真浏览器按一次：
 *   ① 没按住时 .wordnote 是透明的
 *   ② 按住后能看见「同伙：」
 *   ③ 松手自己盖回去
 *   ④ 卧底手机和平民手机，词在卡里的位置完全一样（多一行小字不能把版式挤歪）
 *
 * 用法：先起服务（PORT=3321），再 node tools/check/notecheck.js
 */

const { spawn } = require('child_process');
const http = require('http');

const CHROME = require('../lib/chrome');
const PORT = 9337;
const BASE = process.env.BASE || 'http://127.0.0.1:3321';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function get(p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            resolve(d);
          }
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

const host = (cmd, rest) => api('/api/host', Object.assign({ cmd }, rest || {}));

(async () => {
  console.log('\n  同伙可见性检查 ───────────────────');

  await host('room/kickAll');
  const players = [];
  for (const n of ['阿凯', '小雨', '老周', '小美', '大鹏', '阿哲']) {
    const r = await api('/api/join', { name: n, headset: true });
    if (r.id) players.push(r);
  }
  ok(players.length === 6, '6 个人进场', players.length);

  await host('game/select', { id: 'undercover' });
  await host('game/act', { action: 'host_mode', mode: 'team' });
  const st = await host('game/start', {});
  ok(!st.error, '双卧底能开局', st);

  const hs = await api('/api/state?role=host');
  const info = (hs.panel && hs.panel.info) || [];
  const underNames = String((info.find((i) => i.label === '卧底') || {}).value || '').split('、');
  const under = players.filter((p) => underNames.includes(p.name));
  const civ = players.filter((p) => !underNames.includes(p.name));
  ok(under.length === 2 && civ.length === 4, '两个人是卧底', { under: under.length, civ: civ.length });

  /* ------------------------------------------------ 起浏览器 */
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=C:\\temp\\pb-note-profile',
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
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  const GEO = `(() => {
    const box = document.querySelector('.wordbox');
    if (!box) return { ok: false, html: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160) };
    const text = document.querySelector('.wordtext');
    const mask = document.querySelector('.wordmask');
    const note = document.querySelector('.wordnote');
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const bb = r(box);
    const tb = r(text);
    const cs = getComputedStyle(mask);
    return {
      ok: true,
      show: box.classList.contains('show'),
      box: bb,
      text: tb,
      textDy: tb.y - bb.y,
      // 两个词字数不一样，靠左对齐会差几个像素 —— 比中心点才准
      textDcx: Math.round(tb.x + tb.width / 2 - (bb.x + bb.width / 2)),
      note: note ? r(note) : null,
      noteDy: note ? r(note).y - bb.y : null,
      noteText: note ? note.textContent : '',
      noteOpacity: note ? Number(getComputedStyle(note).opacity) : -1,
      noteFilter: note ? getComputedStyle(note).filter : '',
      maskText: mask.innerText.replace(/\\s+/g, ''),
      maskFont: cs.fontSize,
      maskColor: cs.color,
      title: (document.querySelector('.vw-title') || {}).textContent || '',
    };
  })()`;

  async function openPlayer(p) {
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(800);
    await evalJs(
      `localStorage.setItem('pb_pid', ${JSON.stringify(p.id)}); localStorage.setItem('pb_name', ${JSON.stringify(p.name)}); 1`
    );
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(1600);
    // 必须用真鼠标事件点「继续」，.click() 不算用户手势，AudioContext 会卡在 suspended
    const rb = await evalJs(`(() => {
      const b = document.querySelector('#resume');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (rb) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rb.x, y: rb.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rb.x, y: rb.y, button: 'left', clickCount: 1 });
    }
    await sleep(2200);
    return evalJs(GEO);
  }

  /* ------------------------------------------------ 卧底那台 */
  const gU = await openPlayer(under[0]);
  ok(gU && gU.ok, '卧底的手机渲染出了词卡', gU && gU.html);
  ok(gU && gU.noteText && /^同伙：/.test(gU.noteText), '词卡里真有「同伙：」这一行', gU && gU.noteText);
  ok(gU && gU.noteOpacity === 0, '没按住的时候同伙是透明的（opacity 0）', gU && gU.noteOpacity);
  ok(gU && /blur/.test(gU.noteFilter || ''), '没按住的时候同伙是糊的（不是只靠透明）', gU && gU.noteFilter);
  ok(gU && gU.show === false, '词卡没被按住');

  if (gU && gU.ok) {
    const cx = Math.round(gU.box.x + gU.box.w / 2);
    const cy = Math.round(gU.box.y + gU.box.h / 2);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await sleep(300);
    const held = await evalJs(GEO);
    ok(held && held.show === true, '按住后词卡打开了', held && held.show);
    ok(held && held.noteOpacity === 1, '按住后同伙看得见（opacity 1）', held && held.noteOpacity);
    ok(held && !/blur/.test(held.noteFilter || ''), '按住后同伙是清楚的（不再糊）', held && held.noteFilter);
    ok(held && /同伙：/.test(held.noteText || ''), '按住后读到的是同伙', held && held.noteText);

    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
    await sleep(400);
    const back = await evalJs(GEO);
    ok(back && back.noteOpacity === 0, '松手后同伙自己盖回去了', back && back.noteOpacity);
    ok(back && back.show === false, '松手后词卡合上', back && back.show);
  }

  const gC = await openPlayer(civ[0]);
  ok(gC && gC.ok, '平民的手机也渲染出了词卡', gC && gC.html);
  ok(gC && gC.note === null, '平民的词卡里没有同伙那一行');
  ok(gC && gC.show === false, '平民的词卡也没被按住');

  /* ------------------------------------ 多一行不能把版式挤歪 */
  ok(gU && gC && gU.box.w === gC.box.w, '两张卡宽度一样', { u: gU && gU.box.w, c: gC && gC.box.w });
  ok(gU && gC && gU.box.h === gC.box.h, '两张卡高度一样', { u: gU && gU.box.h, c: gC && gC.box.h });
  ok(gU && gC && Math.abs(gU.textDy - gC.textDy) <= 1, '词在卡里的纵向位置一样', {
    u: gU && gU.textDy,
    c: gC && gC.textDy,
  });
  ok(gU && gC && Math.abs(gU.textDcx - gC.textDcx) <= 1, '词在卡里的横向位置一样（居中，不受字数影响）', {
    u: gU && gU.textDcx,
    c: gC && gC.textDcx,
  });
  ok(gU && gC && gU.title === gC.title, '标题一样', { u: gU && gU.title, c: gC && gC.title });
  ok(gU && gC && gU.maskText === gC.maskText, '遮罩文字一样', { u: gU && gU.maskText, c: gC && gC.maskText });
  ok(gU && gC && gU.maskFont === gC.maskFont, '遮罩字号一样', { u: gU && gU.maskFont, c: gC && gC.maskFont });
  ok(gU && gC && gU.maskColor === gC.maskColor, '遮罩文字颜色一样', { u: gU && gU.maskColor, c: gC && gC.maskColor });

  ws.close();
  proc.kill();
  await host('room/kickAll');

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
