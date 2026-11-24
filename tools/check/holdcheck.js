'use strict';
/* 笨蛋杀手：杀手手机上的名单要「按住才看得见，滑到名字上松手才发」。
 * 这个坑看不见 —— 服务端视图对不对，和手机上有没有真的遮住，是两件事。
 * 所以在真浏览器里按住遮罩、滑到某个名字、松手，看服务端有没有收到那一枪。 */

const { spawn } = require('child_process');
const http = require('http');

const CHROME = require('../lib/chrome');
const PORT = 9336;
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
  await api('/api/host', { cmd: 'room/kickAll' });
  const players = [];
  for (const n of ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛']) {
    const r = await api('/api/join', { name: n, headset: true });
    if (r.id) players.push(r);
  }
  await api('/api/host', { cmd: 'game/select', id: 'dumbkill' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });

  const hs0 = await api('/api/state?role=host');
  const rows = (hs0.panel && hs0.panel.table && hs0.panel.table.rows) || [];
  const killerName = (rows.find((r) => r[1] === '杀手') || [])[0];
  const killer = hs0.players.find((p) => p.name === killerName);
  ok(!!killer, '从主持台读出杀手是谁', killerName);

  const v0 = (await api('/api/state?role=player&pid=' + killer.id)).view;
  ok(v0.type === 'choice' && v0.hold === true, '杀手拿到的是一张「按住才看」的选项视图', {
    type: v0.type, hold: v0.hold,
  });
  const outside = [v0.title, v0.sub, v0.footer].join(' | ');
  ok(!/接头提示/.test(outside), '遮罩外没有接头提示', outside);
  ok(!/喊谁|子弹|剩/.test(outside), '遮罩外没有「喊谁 / 剩几发」', outside);
  ok(/接头提示/.test(v0.note || ''), '接头提示写在遮罩里面', v0.note);
  ok((v0.options || []).length === players.length - 1, '名单里是除自己以外的所有人', (v0.options || []).length);

  // 好人拿到的是身份卡，遮罩外三行必须和杀手一字不差
  const goodName = (rows.find((r) => r[1] === '好人') || [])[0];
  const good = hs0.players.find((p) => p.name === goodName);
  const vg = (await api('/api/state?role=player&pid=' + good.id)).view;
  ok(v0.title === vg.title, '杀手和好人的标题一字不差', { k: v0.title, g: vg.title });
  ok(v0.sub === vg.sub, '杀手和好人的提示一字不差', { k: v0.sub, g: vg.sub });
  ok(v0.footer === vg.footer, '杀手和好人的底部一字不差', { k: v0.footer, g: vg.footer });

  /* ------------------------------------------------ 真浏览器里按一次 */
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=C:\\temp\\pb-hold-profile',
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
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    return r.result && r.result.result ? r.result.result.value : null;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('EX ' + JSON.stringify(m.params.exceptionDetails.text) + ' ' + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || ''));
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push('LOG ' + m.params.args.map((a) => a.value || a.description).join(' '));
    }
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(1200);
  await evalJs(`localStorage.setItem('pb_pid', ${JSON.stringify(killer.id)}); 1`);
  await evalJs(`localStorage.setItem('pb_name', ${JSON.stringify(killer.name)}); 1`);
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(2000);
  // 必须用真实鼠标事件点「继续」：DOM 的 .click() 不算用户手势，
  // AudioContext 会一直停在 suspended，boot() 就卡在 await sfx.init() 上。
  const rbtn = await evalJs(`(() => {
    const b = document.querySelector('#resume');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: b.textContent };
  })()`);
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: rbtn.x, y: rbtn.y, button: 'left', clickCount: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: rbtn.x, y: rbtn.y, button: 'left', clickCount: 1,
  });
  await sleep(2600);

  const geo = await evalJs(`(() => {
    const m = document.querySelector('.holdpick-mask');
    if (!m) return { exists: false, html: document.body.innerText.slice(0, 200) };
    const cs = getComputedStyle(m);
    const r = m.getBoundingClientRect();
    const btns = [...document.querySelectorAll('.holdpick .choice')].map((b) => {
      const q = b.getBoundingClientRect();
      return { v: b.dataset.value, label: b.textContent, x: q.x + q.width / 2, y: q.y + q.height / 2 };
    });
    const note = (document.querySelector('.holdpick-note') || {}).textContent || '';
    return {
      exists: true, opacity: Number(cs.opacity), pe: cs.pointerEvents,
      x: r.x + r.width / 2, y: r.y + r.height / 2,
      maskH: r.height, btns, note,
      covered: btns.every((b) => b.x > r.x && b.x < r.x + r.width && b.y > r.y && b.y < r.y + r.height),
      bg: cs.backgroundImage,
      maskText: m.innerText.replace(/\s+/g, ''),
      maskFont: cs.fontSize,
      maskColor: cs.color,
      visibleText: document.querySelector('.vw').innerText.replace(/\\s+/g, ' ').slice(0, 200),
    };
  })()`);
  ok(geo && geo.exists, '杀手手机上渲染出了遮罩', geo && geo.visibleText);
  ok(geo && geo.opacity === 1 && geo.pe !== 'none', '没按住的时候遮罩是盖着的（opacity 1、能接事件）', geo);
  // innerText 会把遮罩下面的字也读出来，那不代表看得见 ——
  // 真正要验的是遮罩不透明、并且几何上把每个名字都盖住了
  ok(geo && geo.covered, '遮罩把每个名字都盖在下面（几何上完全覆盖）', geo && { covered: geo.covered, btns: geo.btns ? geo.btns.length : 0 });
  ok(geo && !/rgba\(0, 0, 0, 0\)/.test(geo.bg || 'rgba(0, 0, 0, 0)'), '遮罩是不透明的（不是只加了一层几乎看不见的暗色）', geo && (geo.bg || '').slice(0, 60));
  ok(geo && geo.maskH > 120, '遮罩盖住了整块名单，不是只盖住标题', geo && geo.maskH);
  ok(geo && geo.maskH < 620, '8 人局的名单也没顶出屏幕（遮罩高度受控）', geo && geo.maskH);
  const cols = await evalJs(`(() => {
    const l = document.querySelector('.holdpick .choices');
    return l ? { many: l.classList.contains('many'), cols: getComputedStyle(l).gridTemplateColumns } : null;
  })()`);
  ok(cols && cols.many && cols.cols.split(' ').length === 2, '7 个名字以上自动排两列', cols);

  if (geo && geo.exists && geo.btns.length >= 2) {
    // ① 只按不滑：不该发出任何指令
    const before = (await api('/api/state?role=player&pid=' + killer.id)).view;
    const bullets0 = Number((/剩 (\d+) 发/.exec(before.note || '') || [])[1]);

    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: Math.round(geo.x), y: Math.round(geo.y), button: 'left', clickCount: 1,
    });
    await sleep(260);
    const held = await evalJs(`(() => {
      const m = document.querySelector('.holdpick-mask');
      const cs = getComputedStyle(m);
      return {
        show: document.querySelector('.holdpick').classList.contains('show'),
        opacity: Number(cs.opacity),
        text: document.querySelector('.vw').innerText.replace(/\\s+/g, ' ').slice(0, 120),
      };
    })()`);
    ok(held && held.show, '按住后遮罩打开了', held);
    ok(held && held.opacity < 0.05, '按住后遮罩真的透明（不是只改了个 class）', held && held.opacity);
    ok(held && /走你/.test(held.text), '按住后能看到名字', held && held.text);

    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: Math.round(geo.x), y: Math.round(geo.y), button: 'left', clickCount: 1,
    });
    await sleep(700);
    const afterTap = (await api('/api/state?role=player&pid=' + killer.id)).view;
    const bullets1 = Number((/剩 (\d+) 发/.exec(afterTap.note || '') || [])[1]);
    ok(bullets0 === bullets1, '只按不滑松手：没扣子弹（防手滑）', { before: bullets0, after: bullets1 });
    const backMask = await evalJs(
      `(() => { const m = document.querySelector('.holdpick-mask'); return Number(getComputedStyle(m).opacity); })()`
    );
    ok(backMask === 1, '松手后遮罩自己盖回去了', backMask);

    // ② 按住 → 滑到第二个名字 → 松手：应该喊出他
    const t = geo.btns[1];
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: Math.round(geo.x), y: Math.round(geo.y), button: 'left', clickCount: 1,
    });
    await sleep(140);
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.round(t.x), y: Math.round(t.y), button: 'left',
    });
    await sleep(180);
    const hot = await evalJs(`(() => {
      const b = document.querySelector('.holdpick .choice.hot');
      return b ? { v: b.dataset.value, label: b.textContent } : null;
    })()`);
    ok(hot && hot.v === t.v, '滑到谁身上，谁就高亮（手指位置认得准）', hot);

    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: Math.round(t.x), y: Math.round(t.y), button: 'left', clickCount: 1,
    });
    await sleep(900);
    const afterShot = (await api('/api/state?role=player&pid=' + killer.id)).view;
    const bullets2 = Number((/剩 (\d+) 发/.exec(afterShot.note || '') || [])[1]);
    ok(bullets2 === bullets0 - 1, '滑到名字上松手＝真的喊了他（扣 1 发子弹）', {
      before: bullets0, after: bullets2,
    });

    const goodView = (await api('/api/state?role=player&pid=' + good.id)).view;
    ok(!/走你/.test(JSON.stringify(goodView)), '好人手机上永远拿不到这份名单');
  }

  /* ------------------------------------ 两张卡在邻座眼里必须一模一样 */
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(900);
  await evalJs(`localStorage.setItem('pb_pid', ${JSON.stringify(good.id)}); localStorage.setItem('pb_name', ${JSON.stringify(good.name)}); 1`);
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(1700);
  const rb = await evalJs(`(() => {
    const b = document.querySelector('#resume');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rb.x, y: rb.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rb.x, y: rb.y, button: 'left', clickCount: 1 });
  await sleep(2400);
  const gm = await evalJs(`(() => {
    const m = document.querySelector('.wordmask');
    if (!m) return null;
    const cs = getComputedStyle(m);
    return { text: m.innerText.replace(/\s+/g, ''), font: cs.fontSize, color: cs.color };
  })()`);
  ok(gm && geo && gm.text === geo.maskText, '好人卡和杀手卡的遮罩文字一字不差', {
    good: gm && gm.text, killer: geo && geo.maskText,
  });
  ok(gm && geo && gm.font === geo.maskFont, '两张卡的遮罩字号一样', {
    good: gm && gm.font, killer: geo && geo.maskFont,
  });
  ok(gm && geo && gm.color === geo.maskColor, '两张卡的遮罩文字颜色一样', {
    good: gm && gm.color, killer: geo && geo.maskColor,
  });

  ws.close();
  proc.kill();
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
