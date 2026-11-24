'use strict';

/* 停音效这条链路没法靠接口测 —— 声音在手机里。
 * 这个脚本用真实浏览器：起一个 AudioContext，放一段合成音和一段真人音频，
 * 调 stopFx()，看总线上新、音频元素真的停住。
 * 顺便查两件事：R4 删掉的内置整蛊音效是不是真没了，主持台音效那栏是不是只剩一栏。
 *
 * 用法：先起服务（PORT=3321），再 node tools/check/audiocheck.js
 */

const { spawn } = require('child_process');
const http = require('http');

const CHROME = require('../lib/chrome');
const PORT = 9336;
const BASE = process.env.BASE || 'http://127.0.0.1:3321';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(p) {
  return new Promise((res, rej) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try { res(JSON.parse(d)); } catch (e) { res(d); }
        });
      })
      .on('error', rej);
  });
}

function api(path, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : '';
    const u = new URL(BASE);
    const req = http.request(
      { host: u.hostname, port: u.port || 80, path, method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try { res(JSON.parse(d)); } catch (e) { res(d); }
        });
      }
    );
    req.on('error', rej);
    if (body) req.write(data);
    req.end();
  });
}

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + label);
  } else {
    fail += 1;
    console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  }
}

(async () => {
  // 找一首曲子当「自己传的音效」，换成真实文件才有意义
  const hstate = await api('/api/state?role=host');
  const track = (hstate.media || [])[0];
  const url = track ? '/media/' + encodeURIComponent(track.file || track.id) : '';
  console.log('  测试音频：' + (url || '（曲库是空的，跳过文件那项）'));

  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--autoplay-policy=no-user-gesture-required',
      '--user-data-dir=C:\\temp\\pb-audio',
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
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  // 玩家端在根路径（/play.html），扫码进的就是它
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(2200);

  ok((await evalJs('typeof window.Sfx')) === 'function', '玩家端加载了音效引擎');
  ok((await evalJs('typeof window.Sfx.prototype.stopFx')) === 'function', '有 stopFx（停音效）');

  // ---- 合成音：换了总线才算真停 ----
  const synth = await evalJs(`(async () => {
    const s = new window.Sfx();
    await s.init();
    if (!s.ready) return { ready: false };
    const bus1 = s.fxBus;
    const conn1 = !!(bus1 && bus1.numberOfOutputs >= 0);
    s.play('siren');
    s.stopFx();
    return {
      ready: true,
      hadBus: !!bus1,
      busReplaced: s.fxBus !== bus1,
      newBusLive: !!(s.fxBus && s.fxBus.gain.value === 1),
      conn1,
    };
  })()`);
  ok(synth && synth.ready, 'AudioContext 起来了', synth);
  ok(synth && synth.hadBus, '合成音走独立总线 fxBus');
  ok(synth && synth.busReplaced, '按「停」后总线被换掉（在响的音符一起哑）', synth);
  ok(synth && synth.newBusLive, '换完的新总线是通的（下次还能放）', synth);

  // ---- 真人音频：元素必须真的 pause ----
  if (url) {
    const fileRes = await evalJs(`(async () => {
      const s = new window.Sfx();
      await s.init();
      s.stopFx();
      const el = s.playFile(${JSON.stringify(url)});
      await new Promise((r) => setTimeout(r, 600));
      const tracked = s._oneShots.length;
      const wasPlaying = el ? !el.paused : false;
      s.stopFx();
      await new Promise((r) => setTimeout(r, 120));
      return { tracked, wasPlaying, pausedAfter: el ? el.paused : null, left: s._oneShots.length };
    })()`);
    ok(fileRes && fileRes.tracked === 1, '自传音效被登记下来（能停的前提）', fileRes);
    ok(fileRes && fileRes.wasPlaying === true, '自传音效确实在放', fileRes);
    ok(fileRes && fileRes.pausedAfter === true, '按「停」后真人音频停住', fileRes);
    ok(fileRes && fileRes.left === 0, '停完清空引用，不会越积越多', fileRes);

    /* 前缀到地址的翻译：file: → /sfx/，media: → /media/
     * 这两条错了现场没有任何提示，耳机里就是没声 —— 最值得测的一步。 */
    const routed = await evalJs(`(async () => {
      const s = new window.Sfx();
      await s.init();
      s.stopFx();
      s.play('media:' + ${JSON.stringify(track.id)});
      await new Promise((r) => setTimeout(r, 400));
      const el = s._oneShots[0];
      const out = { n: s._oneShots.length, src: el ? el.src : '' };
      s.stopFx();
      return out;
    })()`);
    ok(routed && routed.n === 1 && /\/media\//.test(decodeURIComponent(routed.src || '')),
      "media: 前缀翻译成 /media/ 地址", routed);
  }

  const hst0 = await api('/api/state?role=host');
  const sfx0 = (hst0.sfx || [])[0];
  if (sfx0) {
    const routed2 = await evalJs(`(async () => {
      const s = new window.Sfx();
      await s.init();
      s.stopFx();
      s.play('file:' + ${JSON.stringify(sfx0.id)});
      await new Promise((r) => setTimeout(r, 400));
      const el = s._oneShots[0];
      const out = { n: s._oneShots.length, src: el ? el.src : '' };
      s.stopFx();
      return out;
    })()`);
    ok(routed2 && routed2.n === 1 && /\/sfx\//.test(decodeURIComponent(routed2.src || '')),
      'file: 前缀翻译成 /sfx/ 地址', routed2);
  }

  /* ---- R4：内置合成音效必须真的从引擎里删干净 ---- */
  const src = await new Promise((res) => {
    http
      .get(BASE + '/assets/js/sfx.js', (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => res(d));
      })
      .on('error', () => res(''));
  });
  ok(!/airhorn|boing|speechSynthesis|SpeechSynthesisUtterance/.test(src),
    '整蛊合成音（汽笛/弹簧）和 TTS 都从引擎里删干净了');
  ok(!/pitch:\s*1\.8|土味情话/.test(src), 'TTS 台词表也删了');
  ok(/case 'siren'/.test(src), '全场警报（siren）留着 —— 5 个游戏拿它当「开始投票」');
  ok(/case 'ding'/.test(src) && /case 'win'/.test(src) && /case 'buzzErr'/.test(src),
    '游戏提示音（ding / win / buzzErr）还在');
  ok(/media:/.test(src) && /file:/.test(src), '引擎认 file: 和 media: 两种真文件前缀');

  // ---- 主持台：音效只剩一栏真文件 ----
  await api('/api/host', { cmd: 'game/select', id: 'relay' });
  await send('Page.navigate', { url: BASE + '/host' });
  await sleep(2400);
  const st = await api('/api/state?role=host');
  const want = ((st.sfx || []).length + (st.media || []).length) || 0;
  const ui = await evalJs(
    "JSON.stringify({groups:document.querySelectorAll('.sfxpick .sp-group').length," +
      "heads:Array.from(document.querySelectorAll('.sfxpick .sp-head')).map(function(e){return e.textContent;})," +
      "chips:document.querySelectorAll('.sfxpick .chip').length," +
      "title:(document.querySelector('.sfxpick .sp-title')||{}).textContent})"
  );
  const u = JSON.parse(ui || '{}');
  ok(u.groups === 0, '不再分组（原来「内置合成 / 我上传的」两块合成一栏）', u.groups);
  ok(!u.heads || !u.heads.length, '没有分组头了', u.heads);
  ok(u.chips === want, '方块数 = 库里真文件数（自己传的 + 曲库）', { chips: u.chips, want });
  ok(/音效|放哪|哪一段/.test(u.title || ''), '一栏上面有标题和数量', u.title);

  // 点一下方块，看选中状态跟服务端对齐
  const first = await evalJs(
    "(function(){var b=document.querySelector('.sfxpick .chip');if(!b)return null;b.click();return b.textContent;})()"
  );
  await sleep(700);
  const on = await evalJs("(document.querySelector('.sfxpick .chip.on')||{}).textContent");
  ok(first && on === first, '点方块能换音效并高亮', { first, on });

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
  ws.close();
  proc.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
