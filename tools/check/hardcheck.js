'use strict';

/* 破坏性检查：专挑「正常流程测不到」的地方。
 *
 * 冒烟测试回答的是「功能能不能跑通」；这个工具回答的是另外几个问题：
 *   · 旁边的人瞟一眼能不能看出身份？
 *   · 换个人放音，前一个人耳机里会不会一直响？
 *   · 有人喊一个字算不算猜对？
 *   · 手机访问一个畸形网址，会不把全场干掉？
 *
 * 用法：先起服务，再
 *   BASE=http://127.0.0.1:3321 node tools/check/hardcheck.js
 * 不指定 BASE 时默认 3321。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:3321';
const T = require('../../core/text');
const testsfx = require('../lib/testsfx');

let pass = 0;
let fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(cond, name, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    fail += 1;
    console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  }
}

async function api(p, body) {
  const r = await fetch(BASE + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try {
    return { status: r.status, data: JSON.parse(text) };
  } catch (e) {
    return { status: r.status, data: text };
  }
}

const host = (cmd, rest) => api('/api/host', Object.assign({ cmd }, rest || {}));
const act = (action, rest) => api('/api/host', Object.assign({ cmd: 'game/act', action }, rest || {}));
const view = (pid) => api('/api/state?role=play&pid=' + encodeURIComponent(pid));
const hostState = () => api('/api/state?role=host');

/* 原始请求：路径里的 %E0%A4%A 这种半截转义要原样发出去，
   fetch 会自己重新编码，测不到我们想测的东西 */
function rawGet(p) {
  return new Promise((resolve) => {
    const u = new URL(BASE);
    const req = http.request({ host: u.hostname, port: u.port || 80, path: p, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

/* 订阅某台手机的 SSE，把收到的事件攒起来 */
function sse(pid) {
  return new Promise((resolve) => {
    const events = [];
    const u = new URL(BASE);
    const req = http.get(
      { host: u.hostname, port: u.port || 80, path: '/api/stream?role=play&pid=' + encodeURIComponent(pid) },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          buf += c;
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const p of parts) {
            for (const line of p.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                events.push(JSON.parse(line.slice(5).trim()));
              } catch (e) {}
            }
          }
        });
        resolve({ events, close: () => req.destroy() });
      }
    );
    req.on('error', () => resolve({ events, close: () => {} }));
  });
}

// 从第 from 条往后找，有没有满足条件的事件
const since = (ev, from, fn) => ev.slice(from).some(fn);

(async () => {
  console.log('\n  破坏性检查 ───────────────────────');

  // R4 之后只剩真文件。空库时两个音效游戏点不动是设计，测试自己塞一个。
  const fxId = await testsfx.ensure();

  /* ---------------------------------------------- 一、答案不是随便喊个字就中 */

  ok(T.match('蛇', '打草惊蛇') === false, '喊「蛇」不算猜中「打草惊蛇」');
  ok(T.match('草', '打草惊蛇') === false, '喊「草」不算猜中');
  ok(T.match('惊蛇', '打草惊蛇') === false, '只答一半（惊蛇）不算猜中');
  ok(T.match('打草惊', '打草惊蛇') === true, '差一个字（打草惊）算猜中');
  ok(T.match('我猜是打草惊蛇', '打草惊蛇') === true, '带前后缀的整句算猜中');
  ok(T.match('泰坦尼克', '泰坦尼克号') === true, '「泰坦尼克」对「泰坦尼克号」算对');
  ok(T.match('泰坦', '泰坦尼克号') === false, '「泰坦」对「泰坦尼克号」不算对');
  ok(T.match('豆浆', '豆奶') === false, '「豆浆」对「豆奶」不算对');

  /* ---------------------------------------------- 二、畸形网址不能干掉全场 */

  ok((await rawGet('/media/%E0%A4%A')) === 404, '/media/%E0%A4%A 返回 404 而不是崩');
  ok((await rawGet('/sfx/%')) === 404, '/sfx/% 返回 404');
  ok((await rawGet('/media/')) === 404, '/media/ 指到目录返回 404');
  const alive = await api('/api/health');
  ok(alive.status === 200 && alive.data && typeof alive.data.players === 'number', '三个畸形请求之后服务还活着');

  /* ---------------------------------------------- 准备玩家 */

  await host('room/kickAll');
  const P = {};
  for (const n of ['测甲', '测乙', '测丙', '测丁']) {
    const r = await api('/api/join', { name: n, headset: true });
    if (r.data && r.data.id) P[n] = r.data;
  }
  const A = P['测甲'];
  const B = P['测乙'];
  ok(!!A && !!B, '测试玩家进场', Object.keys(P));

  const sseA = await sse(A.id);
  const sseB = await sse(B.id);
  await sleep(250);
  ok(sseA.events.length > 0, 'A 的手机连上了（收到首个视图）', sseA.events.length);

  /* ---------------------------------------------- 三、邻座偷看也看不出身份 */

  await host('game/select', { id: 'dumbkill' });
  await host('game/start');
  let hs = (await hostState()).data;
  const rows = (hs.panel && hs.panel.table && hs.panel.table.rows) || [];
  const bossName = (rows.find((r) => r[1] === '老板') || [])[0];
  const goodName = (rows.find((r) => r[1] === '好人') || [])[0];
  const killerName = (rows.find((r) => r[1] === '杀手') || [])[0];
  const boss = hs.players.find((p) => p.name === bossName);
  const good = hs.players.find((p) => p.name === goodName);
  const killer = hs.players.find((p) => p.name === killerName);

  if (boss && good) {
    const vb = (await view(boss.id)).data.view;
    const vg = (await view(good.id)).data.view;
    ok(vb.title === vg.title, '笨蛋杀手：老板和好人的标题一字不差', { boss: vb.title, good: vg.title });
    ok(vb.sub === vg.sub, '笨蛋杀手：遮罩外那句提示一字不差', { boss: vb.sub, good: vg.sub });
    ok(vb.footer === vg.footer, '笨蛋杀手：遮罩外底部一字不差', { boss: vb.footer, good: vg.footer });
    ok(/接头提示/.test(vb.text || ''), '笨蛋杀手：老板按住能看到接头提示');
    ok(!/接头提示/.test(vg.text || ''), '笨蛋杀手：好人按住也看不到接头提示');
    ok(!/接头提示/.test(vb.sub || '') && !/接头提示/.test(vb.footer || ''), '笨蛋杀手：接头提示没写在遮罩外');

    // 杀手的名单本身就写着「我是杀手」，必须同样压在遮罩下
    const vk = (await view(killer.id)).data.view;
    ok(vk.hold === true, '笨蛋杀手：杀手的名单是「按住才看」', { type: vk.type, hold: vk.hold });
    ok(vk.title === vg.title && vk.sub === vg.sub && vk.footer === vg.footer,
      '笨蛋杀手：杀手和好人的遮罩外三行一字不差', { k: vk.title, g: vg.title });
    ok(!/走你/.test([vk.title, vk.sub, vk.footer].join(' ')), '笨蛋杀手：名单没出现在遮罩外');
    ok(/接头提示/.test(vk.note || ''), '笨蛋杀手：杀手的接头提示在遮罩里（他得靠它认老板）');
    ok(!/走你/.test(JSON.stringify(vg.data || vg)), '笨蛋杀手：好人拿不到名单');
    const bossTone = vb.tone || '';
    const goodTone = vg.tone || '';
    ok(bossTone !== goodTone, '笨蛋杀手：阵营靠遮罩内的文字区分（tone 只影响按住后的颜色）');
  } else {
    ok(false, '笨蛋杀手：没能从主持台读出老板 / 好人', rows.slice(0, 3));
  }

  // 预言家验完人，结论不能写在遮罩外
  const wolfSrc = fs.readFileSync(path.join(__dirname, '../../games/werewolf/index.js'), 'utf8');
  const seerBlock = wolfSrc.slice(
    wolfSrc.indexOf("title: '验人结果'"),
    wolfSrc.indexOf("title: '验人结果'") + 400
  );
  ok(!/sub:\s*s\.seerCheck\.isWolf/.test(seerBlock), '狼人杀：预言家的结论没写在遮罩外');
  ok(/hold:\s*true/.test(seerBlock), '狼人杀：验人结果仍然要按住才看');

  /* ---------------------------------------------- 四、换个人放音，前一个要停 */

  /* 私密音效是核心能力，不依附游戏：这里故意不选游戏、不开局 */
  let mark = sseA.events.length;
  let r = await host('sfx/poke', { id: A.id, sound: fxId });
  await sleep(150);
  ok(!r.data.error, '私密音效：没开局也能给 A 放', r.data);
  ok(since(sseA.events, mark, (e) => e.t === 'sfx' && e.name === fxId), '私密音效：A 手机上开始响');
  ok(since(sseA.events, mark, (e) => e.duck === true), '私密音效：带 duck，舞曲会让路');

  mark = sseA.events.length;
  r = await host('sfx/poke', { id: B.id, sound: fxId });
  await sleep(150);
  ok(since(sseA.events, mark, (e) => e.t === 'sfx_stop'), '私密音效：改放 B 之后，A 被停掉');

  const markB = sseB.events.length;
  ok(since(sseB.events, Math.max(0, markB - 6), (e) => e.t === 'sfx'), '私密音效：B 手机上开始响');

  r = await host('sfx/pokeStop');
  await sleep(150);
  ok(since(sseB.events, markB, (e) => e.t === 'sfx_stop'), '私密音效：点停，B 被停掉');

  /* ---------------------------------------------- 五、放一段不该动分数 */

  const scoreBefore = (await hostState()).data.players.map((p) => p.id + ':' + p.score).join(',');
  await host('sfx/poke', { id: A.id, sound: fxId });
  await sleep(120);
  const scoreAfter = (await hostState()).data.players.map((p) => p.id + ':' + p.score).join(',');
  ok(scoreBefore === scoreAfter, '私密音效不动任何人的分数（它已经不是游戏了）');
  await host('sfx/pokeStop');
  await sleep(80);

  /* ---------------------------------------------- 六、传声筒灌杂音同样不能换人不停 */

  await host('game/select', { id: 'relay' });
  await host('game/start');

  mark = sseA.events.length;
  r = await act('host_disturb', { targetId: A.id, sound: fxId });
  await sleep(150);
  ok(!r.data.error, '传声筒：能给 A 灌杂音', r.data);
  ok(since(sseA.events, mark, (e) => e.t === 'sfx' && e.name === fxId), '传声筒：A 耳机里开始响');

  mark = sseA.events.length;
  await act('host_disturb', { targetId: B.id, sound: fxId });
  await sleep(150);
  ok(since(sseA.events, mark, (e) => e.t === 'sfx_stop'), '传声筒：改灌 B 之后，A 被停掉');

  const markB2 = sseB.events.length;
  await act('host_disturbStop');
  await sleep(150);
  ok(since(sseB.events, markB2, (e) => e.t === 'sfx_stop'), '传声筒：点停杂音，B 被停掉');

  /* ---------------------------------------------- 七、换游戏时舞曲要停 */

  await host('game/select', { id: 'dancewolf' });
  await host('game/start');
  mark = sseA.events.length;
  r = await act('host_start');
  await sleep(200);
  if (r.data.error) {
    ok(false, '舞蹈狼人杀：能开始放音乐', r.data);
  } else {
    /* 起拍指令是给全场发的，但狼王那一台天生 on:false（他听不见才是设计）。
     * 这里原来写死 on === true，A 恰好被抽成狼王时就会假红一次 —— 改成
     * 「收到了起拍指令」+「on 和是不是狼王对得上」。 */
    hs = (await hostState()).data;
    const beats = sseA.events.slice(mark).filter((e) => e.t === 'beat' && e.show === true);
    ok(beats.length > 0, '舞蹈狼人杀：A 耳机里音乐起来了（收到起拍指令）', beats.length);
    const aRow = (((hs.panel.table || {}).rows) || []).find((r2) => r2[0] === A.name);
    const aIsKing = !!(aRow && aRow[1] === '狼王');
    ok(beats.some((e) => e.on === !aIsKing), '狼王那台不放歌，其他人放', { aIsKing });
    const markBeat = sseA.events.length;
    await host('game/select', { id: 'poll' });
    await sleep(200);
    ok(
      since(sseA.events, markBeat, (e) => e.t === 'beat' && e.on === false),
      '切到别的游戏之后，舞曲收到停止指令'
    );
    ok(since(sseA.events, markBeat, (e) => e.t === 'sfx_stop'), '切游戏时私密音效也一起停');
  }

  /* ---------------------------------------------- 八、前端转义 */

  const hostHtml = fs.readFileSync(path.join(__dirname, '../../public/host.html'), 'utf8');
  ok(/replace\(\/&\/g,\s*'&amp;'\)/.test(hostHtml), '主持台的 esc 会转义 &');
  ok(/replace\(\/<\/g,\s*'&lt;'\)/.test(hostHtml), '主持台的 esc 会转义 <');

  /* -------------------------------------- 九、整场重置/清空玩家要掐声音
   * 这一条是补的：之前的 resetAll / kickAll 只改服务端状态，
   * 耳返攻击正在放的时候点重置，那台手机会一直响到电池没电。 */

  let markR = sseA.events.length;
  await host('room/reset');
  await sleep(280);
  ok(since(sseA.events, markR, (e) => e.t === 'sfx_stop'), '整场重置：耳机里的音效收到停止指令');
  ok(since(sseA.events, markR, (e) => e.t === 'beat' && e.on === false), '整场重置：舞曲线一起停');

  markR = sseA.events.length;
  await host('room/clearSave');
  await sleep(280);
  ok(since(sseA.events, markR, (e) => e.t === 'sfx_stop'), '清存档：先把声音掐掉再删档');

  markR = sseA.events.length;
  await host('room/kickAll');
  await sleep(320);
  const kicked = sseA.events.slice(markR);
  const iStop = kicked.findIndex((e) => e.t === 'sfx_stop');
  const iKick = kicked.findIndex((e) => e.t === 'kicked');
  ok(iStop >= 0, '清空玩家：先发停止指令');
  ok(iStop >= 0 && iKick > iStop, '停止指令排在「你被移出」之前（顺序反了就停不到）', { iStop, iKick });

  /* -------------------------------------- 十、两个按钮在顶栏、右栏不留空框 */

  const barSeg = hostHtml.slice(
    hostHtml.indexOf('<div class="hbar">'),
    hostHtml.indexOf('<!-- 左栏 -->')
  );
  ok(/id="moreMenu"/.test(barSeg) && /id="btnReset"/.test(barSeg) && /id="btnKickAll"/.test(barSeg),
    '「整场重置 / 清空玩家」收进了顶栏「⋯」菜单');
  ok(!/class="btn[^"]*"[^>]*id="btnReset"/.test(barSeg),
    '它们不再是顶栏上跟安全按钮并排的一个普通按钮（这是 H5 的重点）');
  ok(!/<h3>整场<\/h3>/.test(hostHtml), '右栏原来的「整场」面板删干净了，没留空框');
  ok(/btnReset'\).onclick|\("btnReset"\)\.onclick|btnReset"\)\.onclick/.test(hostHtml) ||
    /\$\('btnReset'\)\.onclick/.test(hostHtml), '重置按钮的事件绑定还在');
  ok(/confirm\(/.test(hostHtml), '这两个按钮仍然要二次确认');

  /* ------------------------------------- 十一、音效库空的时候（R4 之后的新常态）
   *
   * 内置合成音全删了，手里一个文件都没传过的人会直接撞上这个状态。
   * 这时候要是一声不响地发个空指令出去，现场看着就是「耳机坏了」。
   * 直接叫插件本身，不走接口 —— 接口那层正常库里总是有文件的。 */

  {
    // 耳返攻击已下架，私密音效变成 core 能力；这里只剩传声筒还用 sfxPick
    const rel = require('../../games/relay');
    const mk = (g) => ({
      players: [],
      teams: {},
      game: { state: g.init(), timer: null, round: 1 },
    });
    const base = {
      pid: 'host',
      payload: {},
      log() {},
      say() {},
      sfx() {},
      sfxStop() {},
      sfxAll() {},
      sfxFiles: [],
      media: [],
    };
    const throwOf = (fn) => {
      try {
        fn();
        return '';
      } catch (e) {
        return e.message;
      }
    };

    const rRel = mk(rel);
    const vRel = rel.hostView(rRel, base);
    const btnRel = vRel.controls.find((x) => x.action === 'host_disturb');
    ok(btnRel && btnRel.disabled === true, '空库：传声筒的「灌杂音」按钮是灰的');
    ok(/上传|曲库/.test(throwOf(() => rel.actions.host_disturb(rRel, { ...base, targetId: 'p1' }))),
      '空库：传声筒硬灌也会给出提示');

    /* 有文件之后：能选、能放，私密音效和曲库都算 */
    const withFiles = { ...base, sfxFiles: [{ id: 'a.mp3', name: 'a.mp3' }], media: [{ id: 'b.mp3', name: 'b.mp3' }] };

    const r3 = mk(rel);
    r3.game.state.disturb = 'noise';
    const v3 = rel.hostView(r3, withFiles);
    ok(r3.game.state.disturb === 'file:a.mp3', '传声筒的老 noise 也落到真文件', r3.game.state.disturb);
    ok(v3.controls.find((x) => x.kind === 'sfxPick').custom.length === 2, '传声筒同样只列真文件');
  }

  /* ---------------------------------------------- 收尾 */

  sseA.close();
  sseB.close();
  await host('room/kickAll');
  await testsfx.cleanup();

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('  检查本身出错：', e);
  process.exit(2);
});
