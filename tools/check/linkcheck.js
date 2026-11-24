'use strict';
/* 断线兜底：手机和主持台失联的那一刻，耳机里的声音必须自己停。
 *
 * 为什么单独测：这条路径没有按钮。服务端崩了、热点断了、手机切了个 Wi-Fi，
 * 没人能给那台手机发「停」；如果本地不停，耳返里的东西会一直响到电池没电。
 * 这个在正常流程里永远测不到 —— 除非真的把网断掉。
 *
 * 用法：先起服务，再
 *   BASE=http://127.0.0.1:3321 node tools/check/linkcheck.js
 */

const { spawn } = require('child_process');
const http = require('http');

const CHROME = require('../lib/chrome');
const PORT = 9339;
const BASE = process.env.BASE || 'http://127.0.0.1:3321';
const testsfx = require('../lib/testsfx');
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

const OFF = { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 };
const ON = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };

async function main() {
  await api('/api/host', { cmd: 'room/kickAll' });
  const me = await api('/api/join', { name: '断网甲', headset: true });
  ok(!!me.id, '造一个测试玩家', me);

  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--user-data-dir=C:\\temp\\pb-link-profile',
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
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });

  await send('Page.navigate', { url: BASE + '/' });
  await sleep(1000);
  await evalJs(`localStorage.setItem('pb_pid', ${JSON.stringify(me.id)}); localStorage.setItem('pb_name', ${JSON.stringify(me.name)}); 1`);
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(1800);

  // 真实鼠标事件点「继续」：DOM 的 .click() 不算用户手势，AudioContext 会卡在 suspended
  const rbtn = await evalJs(`(() => {
    const b = document.querySelector('#resume');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rbtn.x, y: rbtn.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rbtn.x, y: rbtn.y, button: 'left', clickCount: 1 });
  await sleep(2400);

  ok((await evalJs(`document.querySelector('#stage').classList.contains('on')`)) === true, '玩家页进来了');

  // 数一数 stopFx 被调了几次。不改产品代码，只包一层原型。
  const hooked = await evalJs(`(() => {
    if (!window.Sfx) return 'no-Sfx';
    window.__stop = 0;
    const p = window.Sfx.prototype.stopFx;
    window.Sfx.prototype.stopFx = function () { window.__stop += 1; return p.apply(this, arguments); };
    return 'ok';
  })()`);
  ok(hooked === 'ok', '能在页面里数到「掐声音」的调用次数', hooked);

  // 先让服务端真给他放一段：证明后面停之前确实有东西在响
  const prank = await api('/api/host', {
    cmd: 'sfx/poke', id: me.id, sound: await testsfx.ensure(),
  });
  ok(!prank.error, '主持台给他耳机里放了一段', prank);
  await sleep(600);
  ok((await evalJs(`window.__stop`)) === 0, '放音的时候不该有人去掐它');

  /* ---- 断线 ----
   * 用 CDP 的 offline 模拟对已经建立的 SSE 长连接无效（数据已经在流里，
   * 不会触发 onerror），所以这里直接调 EventSource 上那个回调 ——
   * 真实拔网线 / 服务崩掉时，浏览器走的是同一条路径：onerror → onState(false)。 */

  const fire = (kind) =>
    evalJs(`(() => {
      const es = window.NET && NET.es;
      if (!es || typeof es.${kind} !== 'function') return false;
      es.${kind}(new Event('${kind}'));
      return true;
    })()`);

  ok((await fire('onerror')) === true, '能触发连接断开（真实断网走的是同一个回调）');
  await sleep(300);
  const afterOff = await evalJs(`window.__stop`);
  ok(afterOff >= 1, '一断线，本地立刻把声音掐掉（不用等谁来点停止）', afterOff);

  // EventSource 重连期间会反复报错，但只该掐一次
  await fire('onerror');
  await fire('onerror');
  await sleep(300);
  const afterRetry = await evalJs(`window.__stop`);
  ok(afterRetry === afterOff, '断线重试期间不会反复掐（只掐一次）', { first: afterOff, later: afterRetry });

  /* ---- 重连成功 ---- */
  ok((await fire('onopen')) === true, '能模拟重连成功');
  await sleep(300);
  const afterOn = await evalJs(`window.__stop`);
  ok(afterOn === afterOff, '重连那一下不会再掐一次', { before: afterOff, after: afterOn });

  /* ---- 再断一次：还得掐 ---- */
  await fire('onerror');
  await sleep(300);
  ok((await evalJs(`window.__stop`)) === afterOn + 1, '第二次断线仍然会掐，不是只生效一次');

  ws.close();
  proc.kill();
  await api('/api/host', { cmd: 'room/kickAll' });
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
