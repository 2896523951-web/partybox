'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = require('../lib/chrome');
const PORT = 9333;
const BASE = process.env.BASE || 'http://127.0.0.1:3321';
const testsfx = require('../lib/testsfx');
const OUT = process.env.OUT || path.join(__dirname, '../..', 'docs', 'screens');

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

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) {
        this.waiting.get(m.id)(m);
        this.waiting.delete(m.id);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
}

const shots = [];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // 造数据
  await api('/api/host', { cmd: 'room/kickAll' });
  const players = [];
  for (const n of ['阿凯', '小雨', '老周', '小美', '大鹏', '阿哲']) {
    const r = await api('/api/join', { name: n, headset: true });
    if (r.id) players.push(r);
  }
  await api('/api/host', { cmd: 'game/select', id: 'relay' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });

  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--user-data-dir=C:\\temp\\pb-shot-profile',
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
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  async function shot(name, url, w, h, mobile, before) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: mobile ? 2 : 1,
      mobile: !!mobile,
    });
    await cdp.send('Page.navigate', { url });
    await sleep(2600);
    /* H2 之后，开局状态的中栏默认是提词器。这些截图是给手册和文档看的，
       要的是游戏面板，所以先点一下「展开面板」；拍提词器本身的图除外。 */
    if (!/prompter/.test(name)) {
      await cdp.send('Runtime.evaluate', {
        expression: "(()=>{const b=document.getElementById('btnPanel');if(b&&b.style.display!=='none'&&b.textContent.indexOf('展开')>=0)b.click();return 1})()",
      });
      await sleep(500);
    }
    if (before) {
      await cdp.send('Runtime.evaluate', { expression: before, awaitPromise: true });
      await sleep(1600);
    }
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    shots.push(file);
    console.log('  saved', file);
  }

  await api('/api/host', { cmd: 'room/group' });
  await shot('01-host', BASE + '/host', 1600, 1000, false);
  if (process.env.PROBE) {
    const r = await cdp.send('Runtime.evaluate', {
      expression:
        "JSON.stringify({count:document.getElementById('mCount').textContent," +
        "players:document.getElementById('players').innerHTML.slice(0,400)," +
        "errs:(window.__errs||[]).slice(0,5)})",
      returnByValue: true,
    });
    console.log('  PROBE', r.result && r.result.result && r.result.result.value);
  }
  // 游戏目录下拉展开的样子
  await shot(
    '01b-host-menu',
    BASE + '/host',
    1600,
    1000,
    false,
    "document.getElementById('gbtn').click()"
  );
  /* 扫码大厅只在一个条件下存在：房间还没选游戏。
     装了存档直接跑就没有这张，所以有就拍、没有就跳过，
     免得为了它专门清一次存档。 */
  const st0 = await api('/api/state?role=screen');
  if (!st0.gameName) await shot('38-screen-lobby', BASE + '/screen', 1280, 780, false);

  await shot('02-screen', BASE + '/screen', 1280, 780, false);
  await shot('03-join', BASE + '/', 390, 844, true);

  // 玩家端：塞入身份后点「继续」
  const pid = players[0].id;
  const seed = `localStorage.setItem('pb_pid','${pid}');localStorage.setItem('pb_name','${players[0].name}');location.reload();`;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(900);
  await cdp.send('Runtime.evaluate', { expression: seed });
  await sleep(1200);
  await cdp.send('Runtime.evaluate', { expression: "document.getElementById('resume') && document.getElementById('resume').click()" });
  await sleep(1800);
  const r1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '04-play.png'), Buffer.from(r1.result.data, 'base64'));
  console.log('  saved', path.join(OUT, '04-play.png'));

  // 换到卧底，看「按住查看」的词卡
  await api('/api/host', { cmd: 'game/select', id: 'undercover' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });
  await sleep(1200);
  const r2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '05-play-word.png'), Buffer.from(r2.result.data, 'base64'));
  console.log('  saved', path.join(OUT, '05-play-word.png'));

  // 按住状态
  await cdp.send('Runtime.evaluate', {
    expression: "document.querySelector('.wordbox') && document.querySelector('.wordbox').classList.add('show')",
  });
  await sleep(300);
  const r3 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '06-play-hold.png'), Buffer.from(r3.result.data, 'base64'));
  console.log('  saved', path.join(OUT, '06-play-hold.png'));

  // 投票阶段：词卡 + 选项同屏
  await api('/api/host', { cmd: 'game/act', action: 'host_vote' });
  await sleep(1200);
  const r4 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '07-play-vote.png'), Buffer.from(r4.result.data, 'base64'));
  console.log('  saved', path.join(OUT, '07-play-vote.png'));

  // 白板局：手里没词的人，屏幕上写着「白板」—— 但没按住时和别人一模一样
  await api('/api/host', { cmd: 'game/act', action: 'host_mode', mode: 'blank' });
  await api('/api/host', { cmd: 'game/act', action: 'host_nextRound' });
  await sleep(900);
  const bState = await (await fetch(BASE + '/api/state?role=host')).json();
  const blankName = ((bState.panel.info || []).find((x) => x.label === '白板') || {}).value;
  const blankP = players.find((p) => p.name === blankName) || players[0];
  await playShot('07b-play-blank', blankP.id, blankP.name);
  await cdp.send('Runtime.evaluate', {
    expression: "document.querySelector('.wordbox') && document.querySelector('.wordbox').classList.add('show')",
  });
  await sleep(400);
  let rs = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '07c-play-blank-hold.png'), Buffer.from(rs.result.data, 'base64'));
  console.log('  saved', path.join(OUT, '07c-play-blank-hold.png'));

  // 双卧底：按住之后，词底下多一行「同伙：XXX」
  await api('/api/host', { cmd: 'game/act', action: 'host_mode', mode: 'team' });
  await api('/api/host', { cmd: 'game/act', action: 'host_nextRound' });
  await sleep(900);
  const tState = await (await fetch(BASE + '/api/state?role=host')).json();
  const teamNames = String(((tState.panel.info || []).find((x) => x.label === '卧底') || {}).value || '').split('、');
  const underP = players.find((p) => teamNames.includes(p.name)) || players[0];
  await playShot('07d-play-team', underP.id, underP.name);
  await cdp.send('Runtime.evaluate', {
    expression: "document.querySelector('.wordbox') && document.querySelector('.wordbox').classList.add('show')",
  });
  await sleep(400);
  rs = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '07e-play-team-hold.png'), Buffer.from(rs.result.data, 'base64'));
  console.log('  saved', path.join(OUT, '07e-play-team-hold.png'));

  // 主持台上的三种玩法
  await shot('07f-host-undercover-mode', BASE + '/host', 1600, 1000, false);

  // ---- 新游戏 ----
  const hi = (d, l) => {
    const it = (d.panel.info || []).find((x) => x.label === l);
    return it ? it.value : '';
  };

  async function playShot(name, pid, pname) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(800);
    await cdp.send('Runtime.evaluate', {
      expression: `localStorage.setItem('pb_pid','${pid}');localStorage.setItem('pb_name','${pname}');location.reload();`,
    });
    await sleep(1500);
    // 点「继续」，然后等舞台真的出来 —— 只点一次容易拍到入场页
    for (let i = 0; i < 10; i += 1) {
      const r = await cdp.send('Runtime.evaluate', {
        expression:
          "(function(){var s=document.getElementById('stage');" +
          "if(s&&s.classList.contains('on'))return 'done';" +
          "var b=document.getElementById('resume');" +
          "if(b&&b.style.display!=='none'){b.click();return 'clicked';}return 'wait';})()",
        returnByValue: true,
      });
      const v = r.result && r.result.result && r.result.result.value;
      if (v === 'done') break;
      await sleep(500);
    }
    await sleep(1600);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
    console.log('  saved', path.join(OUT, name + '.png'));
  }

  // 舞蹈狼人杀
  await api('/api/host', { cmd: 'game/select', id: 'dancewolf' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });
  await sleep(900);
  await shot('08-host-dancewolf', BASE + '/host', 1600, 1000, false);

  const dState = await (await fetch(BASE + '/api/state?role=host')).json();
  const kingName = hi(dState, '狼王');
  const king = players.find((p) => p.name === kingName) || players[0];
  await api('/api/host', { cmd: 'game/act', action: 'host_start' });
  await sleep(700);
  await playShot('09-play-dancewolf', king.id, king.name);

  // 好人端：音乐条要有声，界面和狼王完全一样
  const goodOne = players.find((p) => p.id !== king.id) || players[1];
  await playShot('14-play-dance-good', goodOne.id, goodOne.name);

  // 主持台在播放中：曲目进度条拖到中间的样子
  await api('/api/host', { cmd: 'game/act', action: 'host_seek', sec: 24 });
  await sleep(1300);
  await shot('18-host-dance-play', BASE + '/host', 1600, 1000, false);

  // 换成曲库里的真歌：手机本地放，狼王那台还是不播
  const mp3 = (dState.media || []).find((m) => m.ext === '.mp3');
  if (mp3) {
    await api('/api/host', { cmd: 'game/act', action: 'host_track', trackId: mp3.id });
    await sleep(1400);
    await playShot('19-play-dance-song', goodOne.id, goodOne.name);
    await shot('20-host-dance-song', BASE + '/host', 1600, 1000, false);
  }

  // 笨蛋杀手
  await api('/api/host', { cmd: 'game/select', id: 'dumbkill' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });
  await sleep(900);
  await shot('10-host-dumbkill', BASE + '/host', 1600, 1000, false);

  const kState = await (await fetch(BASE + '/api/state?role=host')).json();
  const killerName = hi(kState, '杀手');
  const killer = players.find((p) => p.name === killerName) || players[1];
  await playShot('11-play-dumbkill', killer.id, killer.name);

  // 重复就打飞：组按钮多，看会不会挤爆
  await api('/api/host', { cmd: 'game/select', id: 'dupfly' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });
  await api('/api/host', { cmd: 'game/act', action: 'host_stop' });
  await sleep(900);
  await shot('12-host-dupfly', BASE + '/host', 1600, 1100, false);
  await shot('13-screen-dupfly', BASE + '/screen', 1280, 780, false);

  // 好奇宝
  await api('/api/host', { cmd: 'game/select', id: 'curious' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });
  await sleep(800);
  await playShot('15-play-curious', players[0].id, players[0].name);

  // 接力猜词
  await api('/api/host', { cmd: 'game/select', id: 'drawrelay' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });
  await sleep(800);
  await playShot('16-play-drawrelay', players[0].id, players[0].name);

  // 狼人杀 · 第一夜
  await api('/api/host', { cmd: 'game/select', id: 'werewolf' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });
  await sleep(800);
  await playShot('17-play-werewolf', players[0].id, players[0].name);

  // 你画我猜 · 猜中统计
  await api('/api/host', { cmd: 'game/select', id: 'drawguess' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });
  await sleep(700);
  const dg = await (await fetch(BASE + '/api/state?role=host')).json();
  const dgWord = hi(dg, '本轮词');
  const dgDrawer = hi(dg, '画手');
  const dgGuesser = players.find((p) => p.name !== dgDrawer);
  if (dgGuesser && dgWord && dgWord !== '—') {
    await api('/api/game', { id: dgGuesser.id, action: 'guess', text: dgWord });
    await sleep(600);
  }
  await shot('21-host-drawguess', BASE + '/host', 1600, 1000, false);

  // 接力猜词 · 队伍对错统计
  await api('/api/host', { cmd: 'game/select', id: 'drawrelay' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });
  await sleep(700);
  await api('/api/host', { cmd: 'game/act', action: 'host_judge', ok: true });
  await sleep(400);
  await api('/api/host', { cmd: 'game/act', action: 'host_next' });
  await api('/api/host', { cmd: 'game/act', action: 'host_judge', ok: false });
  await sleep(600);
  await shot('22-host-drawrelay', BASE + '/host', 1600, 1000, false);

  // 私密音效 · 跨游戏工具：左栏点一个人就能往他耳机里放，不用开局
  await api('/api/host', { cmd: 'game/select', id: 'relay' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });
  await sleep(600);
  await api('/api/host', {
    cmd: 'sfx/poke',
    id: players[0].id,
    sound: await testsfx.ensure(),
  });
  await sleep(500);
  await shot(
    '23-host-whisper',
    BASE + '/host',
    1600,
    1000,
    false,
    "(()=>{const r=document.querySelectorAll('#players .pl')[0]; if(r) r.click(); return 1;})()"
  );

  // 传声筒 · 灌杂音能选音效
  await api('/api/host', { cmd: 'game/select', id: 'relay' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });
  await sleep(900);
  await api('/api/host', {
    cmd: 'game/act',
    action: 'host_disturbSound',
    sound: await testsfx.ensure(),
  });
  await sleep(500);
  await shot('24-host-relay', BASE + '/host', 1600, 1000, false);

  // 开局面板：选完游戏先把 3 条规则打上投屏
  await api('/api/host', { cmd: 'game/select', id: 'undercover' });
  await sleep(900);
  await shot('25-screen-rules', BASE + '/screen', 1280, 780, false);
  await shot('26-host-rules', BASE + '/host', 1600, 1000, false);
  await playShot('27-play-rules', players[0].id, players[0].name);

  /* -------------------------------------------------- O 系列（这一晚）
   * 好奇宝每轮只抽一支队伍，剩下的人「在旁边看」—— 那正是要下注的人。 */

  await api('/api/host', { cmd: 'game/select', id: 'curious' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });
  await sleep(700);

  /* 先认人，再开下注。
   * 开了下注之后，围观者的视图已经被换成下注面板了，
   * 那时候再去查「谁在旁边看」是查不到的 —— 顺序错了就永远找不到人。 */
  let watcher = null;
  for (const p of players) {
    const st = await api('/api/state?role=play&pid=' + p.id);
    const v = (st && st.view) || {};
    if (/旁边看|围观|不在队里/.test(String(v.title || '') + String(v.sub || ''))) {
      watcher = p;
      break;
    }
  }

  // 塞点分，结算页和总榜才不是一排 0。
  // 旁观的人不给分 —— 他本来就没上场，给了分总榜第一名就是个没玩的人，
  // 截图里的「谁是赢家」和「榜首」还会对不上。
  const scores = [9, 7, 5, 3, 2, 1];
  let si = 0;
  for (const p of players) {
    if (watcher && p.id === watcher.id) continue;
    await api('/api/host', { cmd: 'player/score', id: p.id, delta: scores[si] || 1 });
    si += 1;
  }

  await api('/api/host', { cmd: 'bet/open' });
  // 先让围观的人真的押一注，28 才会写「1 人押了」，30 才会写「1 人押中」。
  // 押自己会被服务端挡掉（不能押自己），所以押场上分最高的那位。
  const betTarget = players.find((p) => !watcher || p.id !== watcher.id) || players[0];
  if (watcher) await api('/api/bet', { id: watcher.id, targetId: betTarget.id });
  await sleep(600);
  await shot('28-host-livebar', BASE + '/host', 1600, 1000, false);

  if (watcher) {
    await playShot('29-play-bet', watcher.id, watcher.name);
  }

  await api('/api/host', { cmd: 'bet/settle', id: betTarget.id });
  await api('/api/host', { cmd: 'settle/round' });
  await sleep(600);
  await shot('30-screen-settle', BASE + '/screen', 1280, 780, false);
  await shot('31-host-settle', BASE + '/host', 1600, 1000, false);

  await api('/api/host', { cmd: 'settle/wrap' });
  await sleep(600);
  await shot('32-screen-board', BASE + '/screen', 1280, 780, false);
  if (watcher) await playShot('33-play-board', watcher.id, watcher.name);

  // 今晚弹层（节目单 + 语音 + 皮肤）
  await shot(
    '34-host-tonight',
    BASE + '/host',
    1600,
    1000,
    false,
    "document.getElementById('btnShow').click()"
  );

  // 复盘弹层
  await shot(
    '35-host-review',
    BASE + '/host',
    1600,
    1000,
    false,
    "document.getElementById('btnReview').click()"
  );

  // 过年皮肤：只换颜色，布局不动
  await api('/api/host', { cmd: 'theme/set', name: 'festive' });
  await api('/api/host', { cmd: 'game/select', id: 'undercover' });
  await sleep(700);
  await shot('36-screen-festive', BASE + '/screen', 1280, 780, false);
  await shot('37-host-festive', BASE + '/host', 1600, 1000, false);
  await api('/api/host', { cmd: 'theme/set', name: 'night' });

  // 提词器（H2）：开局后的默认样子。这张不展开面板，就是要拍提词器本身
  await api('/api/host', { cmd: 'game/select', id: 'werewolf' });
  await api('/api/host', { cmd: 'game/start', cfg: {} });
  await sleep(900);
  await shot('38-host-prompter', BASE + '/host', 1600, 1000, false);

  // 手机遥控（H4）：先要一个码，再拍手机尺寸；主持台那份拍弹层
  const rc = await api('/api/host', { cmd: 'remote/new' });
  const code = (rc && rc.code) || '';
  await shot('39-remote', BASE + '/remote?code=' + code, 390, 844, true);
  await shot(
    '40-host-remote',
    BASE + '/host',
    1600,
    1000,
    false,
    "(()=>{document.getElementById('btnMore').click();setTimeout(()=>document.getElementById('btnRemote').click(),200);return 1})()"
  );

  ws.close();
  proc.kill();
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
