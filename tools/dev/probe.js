'use strict';

/* 单页截图小工具，调界面的时候用（正式截图还是 tools/dev/shot.js）。
 *   node tools/dev/probe.js http://127.0.0.1:3321/screen preview/x.png 1280 780
 * 第五个参数是等多久再拍（毫秒），默认 2200；
 * 第七个参数（在 --clip 之后）是拍照前在页面里跑的一段 JS（调带选中态的界面用）。
 *   例："document.querySelectorAll('#players .pl')[0].click()"
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = require('../lib/chrome');
const PORT = 9334;
const url = process.argv[2] || 'http://127.0.0.1:3321/host';
const out = process.argv[3] || path.join(__dirname, '../..', 'docs', 'screens', 'probe.png');
const W = Number(process.argv[4]) || 1600;
const H = Number(process.argv[5]) || 1000;
const WAIT = Number(process.argv[6]) || 2200;
const BEFORE = process.argv[8] || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(p) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try {
            res(JSON.parse(d));
          } catch (e) {
            res(d);
          }
        });
      })
      .on('error', rej);
  });
}

(async () => {
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--user-data-dir=C:\\temp\\pb-probe',
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
  const wait = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) {
      wait.get(m.id)(m);
      wait.delete(m.id);
    }
  });
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id;
      wait.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url });
  await sleep(WAIT);
  if (BEFORE) {
    await send('Runtime.evaluate', { expression: BEFORE, awaitPromise: true });
    await sleep(900);
  }
  // 可选：局部放大截图  --clip=left,top,width,height,scale
  const clipArg = process.argv[7];
  let clip;
  if (clipArg) {
    const [x, y, w, h, s] = clipArg.split(',').map(Number);
    clip = { x, y, width: w, height: h, scale: s || 2 };
  }
  const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(r.result.data, 'base64'));
  console.log('saved', out);
  ws.close();
  proc.kill();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
