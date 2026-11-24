'use strict';

/* O 系列检查 —— 竞品对比方案里「还没做的那 11 项」。
 *
 *   O1 围观下注     没在局里的人押谁赢
 *   O2 自动推进     到点替主持人点一次「下一步」
 *   O4 空档表情     等下一局时手机点一下，投屏飘一个
 *   O5 一键再来     本局结束后的三个出口
 *   O6 断线保护     局中不自动清人
 *   O8 语音播报     时间到 / 本局结束，从这台电脑出声
 *   O9 称号         收工时每人一个标签
 *   O10 主题皮肤    日常 / 过年
 *   O11 节目单      暖场 → 主游戏 → 惩罚 → 收尾
 *   O12 复盘        一晚上玩了什么、谁一直在状态里
 *
 * 前一半是纯逻辑（直接 require core/），后一半走接口 ——
 * 逻辑对但接口没接上，现场一样是点了没反应。
 *
 *   先开服务：PORT=3321 node server.js
 *   再跑：    BASE=http://127.0.0.1:3321 node tools/check/extracheck.js
 */

const http = require('http');
const roomLib = require('../../core/room');
const betLib = require('../../core/bet');
const moodLib = require('../../core/mood');
const titlesLib = require('../../core/titles');
const showLib = require('../../core/show');
const statsLib = require('../../core/stats');

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3321}`;
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
const pview = async (pid) => (await api('/api/state?role=play&pid=' + encodeURIComponent(pid))).data.view;
const screen = async () => (await api('/api/state?role=screen')).data;
const hostSnap = async () => (await api('/api/state?role=host')).data;

async function join(names) {
  await host('room/kickAll');
  const out = [];
  for (const n of names) {
    const r = await api('/api/join', { name: n, headset: true });
    if (r.data && r.data.id) out.push(r.data);
  }
  return out;
}

/* 订阅某一路 SSE，把事件攒起来 */
function sse(role, pid) {
  return new Promise((resolve) => {
    const events = [];
    const u = new URL(BASE);
    const q = '/api/stream?role=' + role + (pid ? '&pid=' + encodeURIComponent(pid) : '');
    const req = http.get({ host: u.hostname, port: u.port || 80, path: q }, (res) => {
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
    });
    req.on('error', () => resolve({ events, close: () => {} }));
  });
}

const since = (ev, from, fn) => ev.slice(from).some(fn);

(async () => {
  console.log('\n  O 系列检查 ───────────────────────');

  /* ------------------------------------------------ 一、O6 断线保护
   * 有人去个洗手间、手机息屏两分钟，回来发现被移出房间，
   * 这一局就没法玩了。所以局中一律不自动清。 */
  {
    const r = roomLib.createRoom();
    roomLib.addPlayer(r, '甲', true);
    roomLib.addPlayer(r, '乙', true);
    r.phase = 'playing';
    for (const p of r.players) {
      p.online = false;
      p.lastSeen = Date.now() - 60 * 60000;
    }
    const gone = roomLib.pruneOffline(r, 0);
    ok(gone.length === 0, 'O6 局中不动手：离线一小时也不清', gone.length);
    ok(r.players.length === 2, 'O6 局中人都还在', r.players.length);

    const forced = roomLib.pruneOffline(r, 0, { force: true });
    ok(forced.length === 2, 'O6 主持台手动点「清离线」能清掉', forced.length);

    const r2 = roomLib.createRoom();
    roomLib.addPlayer(r2, '丙', true);
    roomLib.addPlayer(r2, '丁', true);
    r2.phase = 'lobby';
    for (const p of r2.players) {
      p.online = false;
      p.lastSeen = Date.now() - 60 * 60000;
    }
    const g2 = roomLib.pruneOffline(r2, 0);
    ok(g2.length === 2, 'O6 不在局中时照旧清掉早就走的人', g2.length);
  }

  /* ------------------------------------------------ 二、O9 称号 */
  {
    const r = roomLib.createRoom();
    const a = roomLib.addPlayer(r, '甲', true);
    const b = roomLib.addPlayer(r, '乙', true);
    const c = roomLib.addPlayer(r, '丙', true);
    const d = roomLib.addPlayer(r, '丁', true);
    // 戊是故意加的：「静观其变」要取动作最少的那个，
    // 只剩一个人时取大取小都一样，测不出错。留两个人比才有意义。
    const e = roomLib.addPlayer(r, '戊', true);
    a.score = 12;
    a.actN = 4;
    b.score = 5;
    b.betScore = 4;
    b.actN = 2;
    c.score = 3;
    c.actN = 9;
    d.score = 0;
    d.actN = 0;
    e.score = 0;
    e.actN = 1;

    const t = titlesLib.compute(r);
    ok(t.length === 5, 'O9 每个人都拿到称号', t.length);
    ok(new Set(t.map((x) => x.key)).size === 5, 'O9 一人一个，不重复', t.map((x) => x.key));
    const byName = {};
    for (const x of t) byName[x.name] = x.title;
    // 默认是综艺模式（7.1），分最高的叫「最佳搅局者」；比赛模式的 MVP 另有断言
    ok(byName['甲'] === '最佳搅局者', 'O9 分最高的拿「最佳搅局者」（默认综艺）', byName['甲']);
    ok(byName['乙'] === '神预言', 'O9 押注中的拿「神预言」', byName['乙']);
    ok(byName['丁'] === '静观其变', 'O9 一次没动手的拿「静观其变」', byName['丁']);
    ok(byName['戊'] !== '静观其变', 'O9 动过手的拿不到「静观其变」', byName['戊']);
    ok(Object.keys(byName).length === 5, 'O9 有人的称号没落下');
  }

  /* ------------------------------------------------ 三、O11 节目单 */
  {
    const r = roomLib.createRoom();
    const l = showLib.load(r, 'standard');
    ok(l.show.items.length === 5, 'O11 标准一晚排了 5 项', l.show.items.length);

    const n1 = showLib.next(r);
    ok(n1.item.gameId === 'numberbomb', 'O11 第一项是暖场（报数炸弹）', n1.item);
    const n2 = showLib.next(r);
    ok(n2.index === 1 && n2.item.gameId === 'undercover', 'O11 第二项是主游戏');
    // 一路点到底，不能绕回开头
    for (let i = 0; i < 9; i += 1) showLib.next(r);
    ok(r.show.index === 4, 'O11 点多了停在最后一项，不绕回开头', r.show.index);

    const r2 = roomLib.createRoom();
    showLib.load(r2, 'free');
    ok(!!showLib.next(r2).error, 'O11 自由模式下没有「下一项」');

    const r3 = roomLib.createRoom();
    showLib.load(r3, 'standard');
    r3.show.items[1].label = '改过';
    const fresh = showLib.template('standard');
    ok(fresh.items[1].label === '主游戏', 'O11 改节目单不会改到模板本身', fresh.items[1].label);

    /* 综艺同款（V1.7 的 6.1）：体力 → 信息差 → 推理，过渡那一项是工具不是游戏 */
    const rv = roomLib.createRoom();
    showLib.load(rv, 'variety');
    ok(rv.show.items.length === 5, 'O11 综艺同款排了 5 项', rv.show.items.length);
    ok(rv.show.items[2].kind === 'whisper', 'O11 过渡环节是「耳机里放」工具，不是游戏', rv.show.items[2]);
    ok(rv.show.warn.length > 0 && /6 人/.test(rv.show.warn.join('')), 'O11 人不够时选模板就提示', rv.show.warn);

    for (let i = 0; i < 6; i += 1) rv.players.push({ id: 'p' + i, name: 'P' + i, headset: true });
    const w6 = showLib.check(rv, showLib.template('variety'));
    ok(w6.length === 0, 'O11 六个人都戴耳机就不提示', w6);
    rv.players[2].headset = false;
    const w5 = showLib.check(rv, showLib.template('variety'));
    ok(w5.some((x) => /耳机/.test(x)), 'O11 有人没戴耳机时提示舞蹈狼人杀要全员戴', w5);
  }

  /* ------------------------------------------- H1 主持脚本（纯逻辑） */
  {
    const cueLib = require('../../core/cue');
    const wolf = require('../../games/werewolf');
    const it = cueLib.itemsOf(wolf);
    ok(it.length === 8 && it[0].cue === '发身份', 'H1 狼人杀写了 8 步脚本', it.length);
    ok(it.every((x) => x.cue.length <= 8 && x.say.length <= 40), 'H1 每步 cue ≤8 字、say ≤40 字');
    ok(cueLib.hasOwn(wolf), 'H1 能认出「这个游戏自己写了脚本」');

    const r = roomLib.createRoom();
    const s0 = cueLib.state(r, wolf);
    ok(s0.index === 0 && s0.source === 'game', 'H1 从第一步开始');
    const s1 = cueLib.step(r, wolf, 1);
    ok(s1.index === 1 && s1.cue === '天黑', 'H1 下一步往前走', s1.cue);
    for (let i = 0; i < 20; i += 1) cueLib.step(r, wolf, 1);
    ok(cueLib.state(r, wolf).index === 7, 'H1 点多了停在最后一步，不绕回开头');

    const bare = { id: 'bare' };
    ok(!cueLib.hasOwn(bare) && cueLib.itemsOf(bare).length === 3, 'H1 没写脚本的游戏用三段式兜底');
  }

  /* ------------------------------------------- H3 仪式动作（纯逻辑） */
  {
    const fxLib = require('../../core/fx');
    ok(fxLib.list().length === 6, 'H3 六个仪式动作', fxLib.list().length);
    ok(fxLib.payload('nope').error, 'H3 未知动作直接拒绝');
    ok(fxLib.payload('bigtext', '   ').error, 'H3 大字不能是空白');
    const long = fxLib.payload('bigtext', '一'.repeat(30));
    ok(long.ok && long.arg.length === 20, 'H3 大字截到 20 字', long.arg.length);
    ok(fxLib.payload('dead', '偷偷塞一句身份').arg === '', 'H3 不收参数的动作会把参数丢掉');
  }

  /* ------------------------------------------- 7.1 综艺 / 比赛模式（纯逻辑） */
  {
    const titleLib = require('../../core/titles');
    const list = [
      { key: 'a', name: 'A', score: 9, bet: 0, act: 0 },
      { key: 'b', name: 'B', score: 1, bet: 0, act: 9 },
    ];
    const v = titleLib.computeFrom(list, 'variety');
    ok(v[0].title === '最佳搅局者', '7.1 综艺模式最高分叫「最佳搅局者」', v[0].title);
    const m = titleLib.computeFrom(list, 'match');
    ok(m[0].title === '今晚 MVP', '7.1 比赛模式仍然是 MVP', m[0].title);
  }

  /* ------------------------------------------------ 四、O12 复盘 */
  {
    const r = roomLib.createRoom();
    roomLib.addPlayer(r, '甲', true);
    roomLib.addPlayer(r, '乙', true);
    r.players[0].score = 7;
    r.players[0].actN = 5;
    statsLib.record(r, { gameId: 'undercover', name: '谁是卧底', ms: 6 * 60000 });
    // 第二局开始前 actN 会被清掉（真的流程里是 softResetPlayers 干的）
    r.players[0].score = 2;
    r.players[0].actN = 0;
    r.players[1].score = 9;
    r.players[1].betScore = 2;
    statsLib.record(r, { gameId: 'relay', name: '传声筒', ms: 4 * 60000 });

    const rev = statsLib.review(r);
    ok(rev.count === 2, 'O12 记了两局', rev.count);
    ok(rev.totalMs === 10 * 60000, 'O12 总时长算对了', rev.totalMs);
    const jia = rev.people.find((p) => p.name === '甲');
    ok(jia && jia.plays === 2 && jia.score === 9, 'O12 按人累加对得上', jia);
    ok(jia.avgAct === 2.5, 'O12 平均动作次数算对了', jia.avgAct);
    ok(jia.best === 7, 'O12 记住单局最高分', jia.best);

    const csv = statsLib.toCsv(r);
    ok(csv.split('\n')[0] === '时间,游戏,时长(分),玩家,得分,押注分,动作次数', 'O12 CSV 表头固定');
    ok(csv.split('\n').length >= 5, 'O12 CSV 有明细行', csv.split('\n').length);

    // 名字里有逗号也不能把表撑坏
    const r3 = roomLib.createRoom();
    roomLib.addPlayer(r3, '张,三', true);
    statsLib.record(r3, { gameId: 'poll', name: '投票', ms: 1000 });
    ok(statsLib.toCsv(r3).indexOf('"张,三"') > 0, 'O12 名字带逗号会加引号');

    // 只留最近 30 局
    const r4 = roomLib.createRoom();
    for (let i = 0; i < 40; i += 1) statsLib.record(r4, { gameId: 'poll', name: '第' + i + '局', ms: 1000 });
    ok(r4.history.length === statsLib.KEEP, 'O12 只留最近 30 局', r4.history.length);
  }

  /* ------------------------------------------------ 五、O1 下注（纯逻辑） */
  {
    const r = roomLib.createRoom();
    const a = roomLib.addPlayer(r, '甲', true);
    const b = roomLib.addPlayer(r, '乙', true);
    const c = roomLib.addPlayer(r, '丙', true);

    ok(!!betLib.pick(r, a.id, b.id).error, 'O1 没开下注时押不了');
    betLib.open(r);
    ok(!!betLib.pick(r, a.id, a.id).error, 'O1 不能押自己');
    ok(!betLib.pick(r, a.id, b.id).error, 'O1 能押别人');
    ok(!betLib.pick(r, c.id, b.id).error, 'O1 第二个人也能押');
    ok(betLib.state(r).n === 2, 'O1 两个人押了', betLib.state(r).n);

    const s = betLib.settle(r, b.id);
    ok(s.hits.length === 2, 'O1 两个人都押中', s.hits);
    ok(b.betScore === 0, 'O1 赢家自己没押就不加分', b.betScore);
    ok(a.betScore === betLib.HIT_SCORE, 'O1 押中的人拿到分', a.betScore);
    ok(c.betScore === betLib.HIT_SCORE, 'O1 另一个押中的也拿到分', c.betScore);
    ok(betLib.state(r).settled === true, 'O1 结算后状态是「已结束」');
    ok(!!betLib.pick(r, a.id, b.id).error, 'O1 结算之后不能再押');
  }

  /* ------------------------------------------------ 六、O4 表情（纯逻辑） */
  {
    const r = roomLib.createRoom();
    const a = roomLib.addPlayer(r, '甲', true);
    ok(!moodLib.add(r, a.id, '😂').error, 'O4 白名单里的表情能发');
    ok(!!moodLib.add(r, a.id, '💩').error, 'O4 白名单外的不收');
    ok(!!moodLib.add(r, 'nobody', '😂').error, 'O4 不认识的人不收');
    ok(moodLib.recent(r).length === 1, 'O4 最近列表里有 1 条');
    for (let i = 0; i < 40; i += 1) moodLib.add(r, a.id, '🔥');
    ok(r.mood.list.length <= 30, 'O4 攒太多会丢老的', r.mood.list.length);
  }

  /* ======================================================= 接口部分 */

  const players = await join(['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛']);
  ok(players.length === 8, '八个人进场', players.length);

  const screenSSE = await sse('screen', '');
  await sleep(200);
  ok(screenSSE.events.length > 0, '投屏连上了');

  /* ------------------------------------------- 七、O1 围观下注（接口） */
  await host('game/select', { id: 'curious' });
  await host('game/start', { cfg: {} });
  const views = [];
  for (const p of players) views.push({ p, v: await pview(p.id) });
  const watchers = views.filter((x) => /旁边看|围观|不在队里/.test(String(x.v.sub || '') + String(x.v.title || '')));
  ok(watchers.length > 0, '好奇宝里有「这轮在旁边看」的人', watchers.length);
  const actors = views.filter((x) => /执行者/.test(String(x.v.title || '')));

  const bo = await host('bet/open');
  ok(!bo.data.error, 'O1 能开下注');
  const wv = await pview(watchers[0].p.id);
  ok(wv.type === 'bet', 'O1 围观者手机上变成下注面板', wv.type);
  ok((wv.options || []).length >= 3, 'O1 下注对象是场上的人', (wv.options || []).length);
  ok(
    !(wv.options || []).some((o) => o.value === watchers[0].p.id),
    'O1 名单里没有自己（不能押自己）'
  );

  const av = await pview(actors[0].p.id);
  ok(av.type !== 'bet', 'O1 在局里的人看不到下注面板（手机上有正事）', av.type);

  const bet1 = await api('/api/bet', { id: watchers[0].p.id, targetId: actors[0].p.id });
  ok(!bet1.data.error, 'O1 押注能提交', bet1.data);
  let snap = await hostSnap();
  ok(snap.bet && snap.bet.n === 1, 'O1 主持台看到 1 人押了', snap.bet);
  ok(
    !JSON.stringify(snap.bet).includes(actors[0].p.name + '→') &&
      !JSON.stringify(snap.bet).includes(watchers[0].p.name),
    'O1 主持台/大屏不显示谁押了谁'
  );

  const bet2 = await api('/api/bet', { id: watchers[0].p.id, targetId: actors[1].p.id });
  ok(!bet2.data.error, 'O1 结算前可以改押注');
  const st = await host('bet/settle', { id: actors[1].p.id });
  ok(!st.data.error && st.data.winner === actors[1].p.name, 'O1 能结算给指定的人', st.data);

  snap = await hostSnap();
  const w1 = snap.players.find((x) => x.id === watchers[0].p.id);
  ok(w1 && w1.score === 0, 'O1 押注分不混进正赛分', w1 && w1.score);

  const wv2 = await pview(watchers[0].p.id);
  ok(wv2.type === 'bet' && /押中/.test(wv2.title || ''), 'O1 押中的人手机上说「押中了」', wv2.title);

  /* ------------------------------------------------ 八、O4 表情（接口） */
  const m1 = await api('/api/mood', { id: players[0].id, emoji: '😂' });
  ok(!m1.data.error, 'O4 表情能发', m1.data);
  const m2 = await api('/api/mood', { id: players[0].id, emoji: '💩' });
  ok(!!m2.data.error, 'O4 白名单外的表情被拒');
  await sleep(200);
  ok(
    since(screenSSE.events, 0, (e) => e.t === 'mood' && (e.list || []).length > 0),
    'O4 投屏收到表情事件（独立事件，不重绘整屏）'
  );

  /* ------------------------------------------------ 九、O5 一键再来 */
  const sr = await host('settle/round');
  ok(!sr.data.error, 'O5 能收本局', sr.data);
  const sv = await pview(players[0].id);
  ok(sv.type === 'settle', 'O5 玩家手机换成结算页', sv.type);
  const scr = await screen();
  ok(scr.type === 'settle', 'O5 投屏换成结算页', scr.type);
  ok(Array.isArray(scr.rows) && scr.rows.length === 8, 'O5 结算页有全部 8 个人', scr.rows && scr.rows.length);
  const again = await host('settle/round');
  ok(!!again.data.error, 'O5 已经在结算页时不能重复收', again.data);

  /* ------------------------------------------------ 十、O9 收工榜 */
  const wr = await host('settle/wrap');
  ok(!wr.data.error, 'O9 能收工', wr.data);
  const board = await screen();
  ok(board.type === 'board', 'O9 投屏换成总榜', board.type);
  ok((board.rows || []).length === 8, 'O9 总榜上 8 个人', (board.rows || []).length);
  ok((board.rows || []).every((x) => !!x.title), 'O9 每个人都有称号');
  ok(
    new Set((board.rows || []).map((x) => x.title)).size <= 4,
    'O9 称号种类是有限的那几个',
    (board.rows || []).map((x) => x.title)
  );
  const bv = await pview(players[0].id);
  ok(bv.type === 'settle' && /收工/.test(bv.title || ''), 'O9 玩家手机也是收工页', bv.title);

  /* ------------------------------------------------ 十一、O12 复盘 */
  const rv = await host('review/get');
  ok(!rv.data.error && rv.data.count >= 1, 'O12 复盘里至少有一局', rv.data.count);
  ok((rv.data.people || []).length === 8, 'O12 复盘里 8 个人都有记录', (rv.data.people || []).length);
  const csv = await host('review/csv');
  ok(!csv.data.error && /时间,游戏/.test(csv.data.csv || ''), 'O12 能导出 CSV');

  /* ------------------------------------------------ 十二、O10 皮肤 */
  await host('theme/set', { name: 'festive' });
  snap = await hostSnap();
  ok(snap.theme === 'festive', 'O10 皮肤切到过年', snap.theme);
  const sc2 = await screen();
  ok(sc2.theme === 'festive', 'O10 投屏也拿到皮肤');
  await host('theme/set', { name: 'night' });
  snap = await hostSnap();
  ok(snap.theme === 'night', 'O10 能切回日常');
  await host('theme/set', { name: '乱写的' });
  snap = await hostSnap();
  ok(snap.theme === 'night', 'O10 乱传的值落到日常，不会白屏');

  /* ------------------------------------------------ 十三、O8 语音 */
  const v0 = await host('voice/set', { on: false });
  ok(!v0.data.error, 'O8 能关语音');
  const say0 = await host('voice/say', { text: '时间到' });
  ok(!!say0.data.error, 'O8 没开的时候不播', say0.data);
  await host('voice/set', { on: true });
  const markSay = screenSSE.events.length;
  const say1 = await host('voice/say', { text: '本局结束' });
  ok(!say1.data.error, 'O8 开了之后能播', say1.data);
  await sleep(150);
  ok(since(screenSSE.events, markSay, (e) => e.t === 'say'), 'O8 投屏收到播报指令');
  await host('voice/set', { on: false });

  /* ------------------------------------------------ 十四、O2 自动推进 */
  await host('game/select', { id: 'undercover' });
  await host('game/start', { cfg: {} });
  const ao = await host('auto/on', { sec: 5 });
  ok(!ao.data.error, 'O2 有 pacing 的游戏能开自动', ao.data);
  snap = await hostSnap();
  ok(snap.auto && snap.auto.on === true && snap.auto.sec === 5, 'O2 自动开了、秒数记得', snap.auto);

  /* H1/H2 提词器：开局从第 1 步起，下一步 / 跳过 / 再说一遍都走得通 */
  ok(snap.cue && snap.cue.index === 0 && snap.cue.total === 6, 'H1 开局提词器在第 1 步', snap.cue);
  /* P1：每张玩家视图都要带一句「现在该干嘛」和一行进度 */
  const pv1 = await pview(players[0].id);
  ok(!!pv1.lead, 'P1 玩家视图带一句话指令', pv1.lead);
  ok(/第 \d+ 轮 · 场上 \d+ 人/.test(String(pv1.prog || '')), 'P1 进度写清第几轮、还剩几人', pv1.prog);

  const cn = await host('cue/next');
  ok(!cn.data.error && cn.data.index === 1, 'H1 「完成」会走到下一步', cn.data);
  const ck = await host('cue/skip');
  ok(!ck.data.error && ck.data.index === 2, 'H1 「跳过」也会往下走', ck.data);
  const ca = await host('cue/again');
  ok(!ca.data.error && !!ca.data.say, 'H1 「再说一遍」把这句台词交回来', ca.data.say);
  snap = await hostSnap();
  ok(snap.cue.index === 2, 'H1 再说一遍不改进度', snap.cue.index);

  /* H3 仪式动作：六个动作都能单独触发，投屏收得到 */
  const fxMark = screenSSE.events.length;
  const fxBig = await host('fx/fire', { name: 'bigtext', arg: '先吃饭，十分钟' });
  ok(!fxBig.data.error, 'H3 能推一句大字', fxBig.data);
  await sleep(150);
  ok(since(screenSSE.events, fxMark, (e) => e.t === 'fx' && e.name === 'bigtext'), 'H3 投屏收到大字');
  const fxNo = await host('fx/fire', { name: 'nope' });
  ok(!!fxNo.data.error, 'H3 未知动作直接拒绝', fxNo.data);
  const fxEmpty = await host('fx/fire', { name: 'bigtext', arg: '   ' });
  ok(!!fxEmpty.data.error, 'H3 空大字不给上屏', fxEmpty.data);

  /* 7.1 模式切换：只改显示，不动分数 */
  const mv = await host('mode/set', { name: 'match' });
  ok(!mv.data.error, '7.1 能切到比赛模式', mv.data);
  snap = await hostSnap();
  ok(snap.mode === 'match', '7.1 主持台记住了模式', snap.mode);
  const mBad = await host('mode/set', { name: 'x' });
  ok(!!mBad.data.error, '7.1 只认 variety / match', mBad.data);
  const mMark = screenSSE.events.length;
  await host('mode/set', { name: 'variety' });
  await sleep(150);
  ok(since(screenSSE.events, mMark, (e) => e.t === 'screen' && e.view && e.view.mode === 'variety'),
    '7.1 投屏收到「综艺」标记（它靠这个藏比分条）');

  await sleep(6500);
  snap = await hostSnap();
  ok(snap.auto.runs >= 1, 'O2 到点真的替主持人点了一次', snap.auto.runs);
  const off = await host('auto/off');
  ok(!off.data.error, 'O2 能关掉');
  snap = await hostSnap();
  ok(snap.auto.on === false, 'O2 关掉之后不再点');

  await host('game/select', { id: 'dumbkill' });
  const ao2 = await host('auto/on', { sec: 10 });
  ok(!!ao2.data.error, 'O2 没配 pacing 的游戏不给开（不乱点）', ao2.data);

  /* ------------------------------------------------ 十五、O5 三个出口 */
  await host('game/select', { id: 'undercover' });
  await host('game/start', { cfg: {} });
  await host('settle/round');
  const sw = await host('settle/switch');
  ok(!sw.data.error, 'O5 能「换个游戏」', sw.data);
  snap = await hostSnap();
  ok(!snap.gameId && !snap.settle, 'O5 换游戏后回到未选状态', { gameId: snap.gameId, settle: snap.settle });

  /* ------------------------------------------------ 十六、O11 节目单（接口） */
  const sl = await host('show/load', { id: 'standard' });
  ok(!sl.data.error && sl.data.show.items.length === 5, 'O11 能载入标准一晚', sl.data.show && sl.data.show.items.length);
  const sn1 = await host('show/next');
  ok(!sn1.data.error && sn1.data.item.gameId === 'numberbomb', 'O11 下一项会切游戏', sn1.data);
  snap = await hostSnap();
  ok(snap.gameId === 'numberbomb', 'O11 主持台跟着切了', snap.gameId);
  ok(snap.show.index === 0 && snap.show.total === 5, 'O11 节目单进度对', snap.show);

  // 一路点到「惩罚环节」：没有 gameId，投屏应该清空
  await host('show/next');
  await host('show/next');
  await host('show/next');
  snap = await hostSnap();
  ok(!snap.gameId, 'O11 惩罚环节没有游戏，投屏清空', snap.gameId);

  // 综艺同款：接口要把人数提示带回来，面板才显示得出来
  const svr = await host('show/load', { id: 'variety' });
  ok(!svr.data.error && svr.data.show.items.length === 5, 'O11 综艺同款能载入', svr.data.show && svr.data.show.items.length);
  ok(Array.isArray(svr.data.warn), 'O11 载入时带回 warn 字段（人够就是空数组）', svr.data.warn);
  snap = await hostSnap();
  ok(Array.isArray(snap.show.warn), 'O11 warn 存进快照，面板随时能读', snap.show.warn);

  /* P2 完成态：投完票要说「已提交，还差几人」 */
  await host('game/select', { id: 'poll' });
  await host('game/start', { cfg: {} });
  const p2v0 = await pview(players[0].id);
  ok(!p2v0.done, 'P2 还没交的时候没有对勾', p2v0.done);
  await api('/api/game', { id: players[0].id, action: 'vote', targets: [players[1].id] });
  const p2v1 = await pview(players[0].id);
  ok(p2v1.done === true, 'P2 投完显示已提交', p2v1.lead);
  ok(/还差 \d+ 人/.test(String(p2v1.lead)), 'P2 告诉他差几个人', p2v1.lead);

  /* S4 投票倒计时：进入投票就起 60 秒，关掉就撤 */
  await sleep(1300);
  snap = await hostSnap();
  ok(snap.vote && snap.vote.dueAt > Date.now(), 'S4 投票阶段起了倒计时', snap.vote);
  ok(snap.vote.total === 60000, 'S4 倒计时是 60 秒', snap.vote.total);
  await host('game/act', { action: 'host_close' });
  await sleep(1300);
  snap = await hostSnap();
  ok(!snap.vote, 'S4 投票关了就撤掉倒计时', snap.vote);

  /* S5 抢答只报档位：0.08 秒以内算「几乎同时」 */
  await host('game/select', { id: 'buzzdance' });
  await host('game/start', { cfg: { big: false } });
  await host('game/act', { action: 'host_open' });
  await api('/api/game', { id: players[0].id, action: 'buzz', clientTs: Date.now() });
  await api('/api/game', { id: players[1].id, action: 'buzz', clientTs: Date.now() + 5 });
  snap = await hostSnap();
  ok(/时间差/.test(String(snap.panel.table.columns.join(','))), 'S5 抢答表里有「时间差」一列', snap.panel.table.columns);
  ok(/几乎同时/.test(JSON.stringify(snap.panel.table.rows)), 'S5 差 5 毫秒标成「几乎同时」', snap.panel.table.rows);

  /* B3 大屏模式：倒数后举手，主持人判名次 */
  await host('game/select', { id: 'buzzdance' });
  await host('game/start', { cfg: { big: true } });
  snap = await hostSnap();
  ok(/大屏/.test(JSON.stringify(snap.panel.info)), 'B3 默认走大屏模式', snap.panel.info);
  const bzPhone = await api('/api/game', { id: players[0].id, action: 'buzz' });
  ok(!!bzPhone.data.error, 'B3 大屏模式下手机抢答无效', bzPhone.data);
  await host('game/act', { action: 'host_open' });
  await host('judge/open', { label: '报数抢答' });
  const j1 = await host('judge/pick', { pid: players[0].id, ok: true });
  ok(j1.data.hook && j1.data.hook.points === 3, 'B3 主持判第一个得 3 分', j1.data);
  const j2 = await host('judge/pick', { pid: players[1].id, ok: true });
  ok(j2.data.hook && j2.data.hook.points === 2, 'B3 第二个得 2 分', j2.data);
  snap = await hostSnap();
  ok(snap.panel.table.rows.length === 2, 'B3 名次表记下了两个人', snap.panel.table.rows);
  await host('judge/close');

  /* S2 逐条揭晓：一条条出，最后一条是汇总 */
  await host('game/select', { id: 'undercover' });
  await host('game/start', { cfg: {} });
  await host('game/act', { action: 'host_vote' });
  for (let i = 0; i < 7; i += 1) {
    await api('/api/game', { id: players[i].id, action: 'vote', targetId: players[7].id });
  }
  const markS2 = screenSSE.events.length;
  const tl = await host('game/act', { action: 'host_tally' });
  ok(!tl.data.error, 'S2 计票成功', tl.data);
  await sleep(200);
  const rv1 = screenSSE.events.slice(markS2).find((e) => e.t === 'screen' && e.view && e.view.type === 'reveal');
  ok(!!rv1, 'S2 计票后投屏切成「逐条揭晓」');
  ok(rv1 && rv1.view.lines.length === 1, 'S2 先只放第一条', rv1 && rv1.view.lines.length);
  await host('game/act', { action: 'host_revealNext' });
  await sleep(200);
  const rv2 = [...screenSSE.events].reverse().find((e) => e.t === 'screen' && e.view && e.view.type === 'reveal');
  ok(rv2 && rv2.view.lines.length === 2, 'S2 「下一条」多放一条', rv2 && rv2.view.lines.length);
  for (let i = 0; i < 10; i += 1) await host('game/act', { action: 'host_revealNext' });
  await sleep(200);
  const after = [...screenSSE.events].reverse().find((e) => e.t === 'screen');
  ok(after && after.view.type !== 'reveal', 'S2 放完自动回到正常视图', after && after.view.type);

  /* A1 素材库：删曲目的入口必须挡路径穿越 */
  const mdBad = await fetch(BASE + '/api/media/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '../server.js' }),
  }).then((r) => r.json());
  ok(!!mdBad.error, 'A1 删曲目挡掉路径穿越', mdBad.error);
  const mdNone = await fetch(BASE + '/api/media/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '不存在的歌.mp3' }),
  }).then((r) => r.json());
  ok(!!mdNone.error, 'A1 删不存在的曲目会报错', mdNone.error);

  /* A3 仪式常驻：除倒数外不自动撤，主持人点「撤掉」才收 */
  const fxr = await host('fx/fire', { name: 'hush' });
  ok(!fxr.data.error, 'A3 能放静场', fxr.data);
  snap = await hostSnap();
  ok(snap.fxNow && snap.fxNow.name === 'hush', 'A3 常驻动作记在房间里', snap.fxNow);
  const fxc = await host('fx/clear');
  ok(!fxc.data.error, 'A3 能撤掉');
  snap = await hostSnap();
  ok(!snap.fxNow, 'A3 撤掉后状态清空');
  await host('fx/fire', { name: 'dead' });
  await host('game/select', { id: 'poll' });
  snap = await hostSnap();
  ok(!snap.fxNow, 'A3 换游戏会自动收掉（防挡）');

  /* A2 惩罚卡自定义：加一张、进池、能删 */

  const pcAdd = await host('punish/add', { title: '背一句诗', body: '背一句小学课文', bar: '背一句，背错喝', sec: 6 });
  ok(!pcAdd.data.error && pcAdd.data.card.title === '背一句诗', 'A2 能加自定义卡', pcAdd.data);
  snap = await hostSnap();
  ok(snap.punishCustom.some((c) => c.id === pcAdd.data.card.id), 'A2 自定义卡进了列表', snap.punishCustom.length);
  ok(snap.punishCustom.length >= 1, 'A2 快照里能看到自定义卡', snap.punishCustom.length);
  const pcDel = await host('punish/del', { id: pcAdd.data.card.id });
  ok(!pcDel.data.error, 'A2 能删自定义卡');
  snap = await hostSnap();
  ok(!snap.punishCustom.some((c) => c.id === pcAdd.data.card.id), 'A2 删掉后不在列表里');

  /* C1 接力猜词：先挑棒次，没人挑由主持人补位 */
  await host('game/select', { id: 'drawrelay' });
  await host('game/start', { cfg: {} });
  const drView = await pview(players[0].id);
  ok(drView.type === 'choice' && (drView.options || []).length >= 3, 'C1 玩家能挑棒次', drView.type);
  await api('/api/game', { id: players[0].id, action: 'pick', targetId: '1' });
  const drView2 = await pview(players[1].id);
  ok((drView2.options || []).some((o) => o.value === '1' && o.disabled), 'C1 被占的棒次对别人是灰的');
  await host('game/act', { action: 'host_next' });
  const drView3 = await pview(players[0].id);
  ok(drView3.type !== 'choice', 'C1 主持人补位后进入正题', drView3.type);

  /* P0 裁决台：开 / 选人 / 判对 / 打点 / 结束 */
  const jOpen = await host('judge/open', { label: '听歌识曲' });
  ok(!jOpen.data.error && jOpen.data.judge.on, 'P0 能开裁决', jOpen.data);
  const jSel = await host('judge/select', { pid: players[0].id });
  ok(!jSel.data.error && jSel.data.sel === players[0].id, 'P0 能选中一个人', jSel.data);
  const before = (await hostSnap()).players[0].score;
  const jPick = await host('judge/pick', { pid: players[0].id, ok: true });
  ok(!jPick.data.error && jPick.data.actN >= 1, 'P0 判一次会记参与度', jPick.data);
  snap = await hostSnap();
  ok(snap.judge.n === 1 && snap.judge.sel === '', 'P0 判完清掉选中并留一条记录', snap.judge);
  const jTap = await host('player/tap', { pid: players[1].id });
  ok(!jTap.data.error && jTap.data.actN >= 1, 'P0 打点单独可用（不判分）', jTap.data);
  const jBad = await host('judge/pick', { pid: 'nope', ok: true });
  ok(!!jBad.data.error, 'P0 判不存在的人会报错', jBad.data);
  await host('judge/close');
  snap = await hostSnap();
  ok(!snap.judge.on, 'P0 能结束裁决');

  /* P0 倒数：默认 3 秒，也接 1–10 秒 */
  {
    const fxLib = require('../../core/fx');
    ok(fxLib.payload('countdown').arg === '3', 'P0 倒数默认 3 秒');
    ok(fxLib.payload('countdown', '5').arg === '5', 'P0 倒数能指定 5 秒');
    ok(!!fxLib.payload('countdown', '30').error, 'P0 倒数超过 10 秒被拒');
  }

  /* 7.1 惩罚卡：12 张、不连着重样、投屏收得到 */
  {
    const pl = require('../../core/punish');
    ok(pl.list().length >= 12, '内置惩罚卡至少 12 张', pl.list().length);
    ok(['sing', 'praise', 'imitate', 'ad', 'pose', 'story', 'apology', 'rap', 'count', 'toast', 'secret', 'slowmo']
      .every((id) => pl.list().some((c) => c.id === id)), '内置 12 张一张不少');
    const r = roomLib.createRoom();
    const ids = [];
    for (let i = 0; i < 12; i += 1) ids.push(pl.draw(r).card.id);
    ok(new Set(ids).size === 12, '连抽 12 张不重样', ids);
    const again = pl.draw(r).card.id;
    ok(!!again, '抽完一轮能洗牌重来', again);
  }
  // 两种口径：默认清爽，切到酒桌后抽出来的是酒桌说法
  const pmBad = await host('punish/mode', { mode: 'x' });
  ok(!!pmBad.data.error, '惩罚卡只认 clean / bar', pmBad.data);
  const pmBar = await host('punish/mode', { mode: 'bar' });
  ok(!pmBar.data.error && pmBar.data.mode === 'bar', '能切到酒桌口径', pmBar.data);
  const punishLib2 = require('../../core/punish');
  const barBodies = new Set(punishLib2.list('bar').map((x) => x.body));
  const cleanBodies = new Set(punishLib2.list('clean').map((x) => x.body));
  const pcBar = await host('punish/draw');
  ok(barBodies.has(pcBar.data.card.body) && !cleanBodies.has(pcBar.data.card.body),
    '酒桌口径抽出来的是酒桌说法', pcBar.data.card.body);
  await host('punish/mode', { mode: 'clean' });
  const pcClean = await host('punish/draw');
  ok(cleanBodies.has(pcClean.data.card.body), '切回清爽后抽到的是清爽说法', pcClean.data.card.body);

  const pcMark = screenSSE.events.length;
  const pc = await host('punish/draw');
  ok(!pc.data.error && pc.data.card && pc.data.card.title, '惩罚卡能从主持台抽', pc.data.card);
  await sleep(200);
  const pcs = screenSSE.events.slice(pcMark).find((e) => e.t === 'screen' && e.view && e.view.card);
  ok(!!pcs, '投屏收到惩罚卡');

  /* 7.2 名场面：一句话记下，空的不收，超长截断 */
  const moBad = await host('moment/add', { text: '   ' });
  ok(!!moBad.data.error, '名场面空话不收', moBad.data);
  const moOk = await host('moment/add', { text: '老周说他从来没抽到过狼' });
  ok(!moOk.data.error && moOk.data.moment.text, '名场面能记下', moOk.data.moment);
  const moLong = await host('moment/add', { text: '一'.repeat(60) });
  ok(moLong.data.moment.text.length === 40, '名场面截到 40 字', moLong.data.moment.text.length);
  snap = await hostSnap();
  ok(snap.moments.length >= 2, '主持台能看到最近记的名场面', snap.moments.length);

  /* H4 手机遥控：6 位码 + 白名单 */
  const rn = await host('remote/new');
  ok(/^\d{6}$/.test(String(rn.data.code || '')), 'H4 生成 6 位数字码', rn.data.code);
  const rBad = await fetch(BASE + '/api/remote?code=000000').then((r) => r.json()).catch(() => null);
  ok(!rBad || rBad.error, 'H4 码不对进不来', rBad && rBad.error);
  const rGood = await fetch(BASE + '/api/remote?code=' + rn.data.code).then((r) => r.json());
  ok(rGood.ok === true && rGood.cue && typeof rGood.cue.index === 'number', 'H4 码对能看到提词器', rGood.cue);
  const rNext = await fetch(BASE + '/api/remote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: rn.data.code, cmd: 'cue/next' }),
  }).then((r) => r.json());
  ok(!rNext.error, 'H4 遥控能点「完成」', rNext.error);
  const rReset = await fetch(BASE + '/api/remote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: rn.data.code, cmd: 'game/act', action: 'vote' }),
  }).then((r) => r.json());
  ok(!!rReset.error, 'H4 遥控不能替玩家投票', rReset.error);
  const rFx = await fetch(BASE + '/api/remote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: rn.data.code, cmd: 'fx/fire', name: 'nope' }),
  }).then((r) => r.json());
  ok(!!rFx.error, 'H4 遥控只放白名单里的仪式动作', rFx.error);

  /* 1/5 选完游戏：大屏先出规则（带人数），主持台出现「开始」 */
  await host('game/select', { id: 'drawguess' });
  snap = await hostSnap();
  ok(snap.canStart === true, '5 选完游戏后主持台可以开始', snap.canStart);
  const scRules = await fetch(BASE + '/api/state?role=screen').then((r) => r.json());
  ok(scRules.type === 'rules' && scRules.need >= 2, '1 规则卡带「需要几人」', { type: scRules.type, need: scRules.need });
  await host('game/start', { cfg: {} });
  snap = await hostSnap();
  ok(!snap.canStart, '5 开局后「开始」按钮收起');

  /* 7 围观下注：结算后能清掉，不只剩一条路 */
  await host('bet/open');
  await host('bet/clear');
  snap = await hostSnap();
  ok(!snap.bet.open && !snap.bet.settled, '7 下注可以清回空闲', snap.bet);

  /* B1 数字炸弹：主持人替玩家报数，手机不参与 */
  await host('game/select', { id: 'numberbomb' });
  await host('game/start', { cfg: {} });
  const nbView = await pview(players[0].id);
  ok(nbView.type === 'text', 'B1 玩家端不再有输入框', nbView.type);
  snap = await hostSnap();
  const nbRange = snap.panel.info.find((i) => i.label === '区间').value;
  const nbLo = Number(nbRange.split('—')[0].trim());
  const nbPick = await host('game/act', { action: 'host_pick', n: nbLo + 1 });
  ok(!nbPick.data.error, 'B1 主持人能替当前玩家报数', nbPick.data);

  /* B2 重复就打飞：大屏分组，人数 2–4 */
  await host('game/select', { id: 'dupfly' });
  await host('game/start', { cfg: {} });
  await host('game/act', { action: 'host_stop' });
  snap = await hostSnap();
  const dupRows = snap.panel.table.rows.filter((r) => r[0] !== '—');
  ok(dupRows.length >= 1, 'B2 音乐停后出了分组', dupRows.length);
  ok(dupRows.every((r) => r[1].split(' / ').length <= 4), 'B2 每组不超过 4 人', dupRows.map((r) => r[1]));
  const dupView = await pview(players[0].id);
  ok(dupView.type === 'text' && /看大屏/.test(dupView.title + dupView.sub), 'B2 手机只提醒看大屏', dupView);

  /* B4 听歌识曲：默认大屏，主持判分 */
  await host('game/select', { id: 'songquiz' });
  await host('game/start', { cfg: {} });
  await host('game/act', { action: 'host_open' });
  const sqPhone = await api('/api/game', { id: players[0].id, action: 'buzz' });
  ok(!!sqPhone.data.error, 'B4 大屏模式下手机抢答无效', sqPhone.data);
  await host('judge/open', { label: '听歌识曲' });
  const sqJudge = await host('judge/pick', { pid: players[1].id, ok: true });
  ok(sqJudge.data.hook && sqJudge.data.hook.points === 3, 'B4 主持判对得 3 分', sqJudge.data);
  await host('judge/close');

  /* C2 你画我猜：举手判分模式 + 指定画手 */
  await host('game/select', { id: 'drawguess' });
  await host('game/start', { cfg: {} });
  await host('game/act', { action: 'host_mode' });
  const dgView = await pview(players[0].id);
  ok(dgView.type !== 'answer', 'C2 举手模式下手机不再作答', dgView.type);
  await host('judge/open', { label: '你画我猜' });
  // 画手本人不能被判对，先避开他
  snap = await hostSnap();
  const drawerName = (snap.panel.info.find((i) => /画手/.test(i.label)) || {}).value || '';
  const guesser = (snap.players.find((p) => p.name !== drawerName) || {}).id;
  const dgJudge = await host('judge/pick', { pid: guesser, ok: true });
  ok(dgJudge.data.hook && dgJudge.data.hook.points === 3, 'C2 主持判对得 3 分', dgJudge.data);
  await host('judge/close');

  /* C3 传声筒：只有第 1 棒看词，主持推进 */
  await host('game/select', { id: 'relay' });
  await host('game/start', { cfg: {} });
  await host('game/act', { action: 'host_next' });
  let rlWord = 0;
  let rlAnswer = 0;
  for (const p of players) {
    const v = await pview(p.id);
    if (v.type === 'word') rlWord += 1;
    if (v.type === 'answer') rlAnswer += 1;
  }
  ok(rlWord === 1, 'C3 只有第 1 棒看到词', rlWord);
  ok(rlAnswer === 0, 'C3 最后一棒不再用输入框', rlAnswer);
  const rlStep = await host('game/act', { action: 'host_step' });
  ok(!rlStep.data.error, 'C3 主持人能推进下一棒', rlStep.data);

  /* 7 结算页：能返回本局；人数不够时「再来一局」灰掉并退回开局前 */
  await host('game/select', { id: 'undercover' });
  await host('game/start', { cfg: {} });
  await host('settle/round');
  snap = await hostSnap();
  ok(snap.settle && snap.settleMeta.canAgain === true, '7 人数够时能再来一局', snap.settleMeta);
  await host('settle/cancel');
  snap = await hostSnap();
  ok(!snap.settle && snap.phase === 'playing', '7 返回本局：结算关掉、这一局没被清', { settle: snap.settle, phase: snap.phase });

  await host('settle/round');
  for (let i = 1; i < players.length; i += 1) {
    await host('player/kick', { id: players[i].id });
  }
  await sleep(200);
  snap = await hostSnap();
  ok(snap.settleMeta.canAgain === false && snap.settleMeta.short > 0, '7 人数不够时不能再来一局', snap.settleMeta);
  const againBad = await host('settle/again');
  ok(!!againBad.data.error, '7 人不够点再来一局会报错', againBad.data);
  snap = await hostSnap();
  ok(snap.phase === 'lobby' && snap.canStart === true, '7 失败后退回开局前（出现开始按钮）', { phase: snap.phase, canStart: snap.canStart });
  const scBack = await fetch(BASE + '/api/state?role=screen').then((r) => r.json());
  ok(scBack.type === 'rules', '7 失败后大屏回到规则卡', scBack.type);

  /* ------------------------------------------------ 收尾 */
  screenSSE.close();
  await host('room/kickAll');
  await host('show/load', { id: 'free' });
  await host('theme/set', { name: 'night' });

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail ? 1 : 0);
})();
