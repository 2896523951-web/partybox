'use strict';

/* 谁是卧底的三种玩法：标准 / 白板 / 双卧底。
 * 重点是「玩家手机上长得一样」—— 身份只能出现在遮罩下面。
 *
 *   先开服务：PORT=3321 node server.js
 *   再跑：    BASE=http://127.0.0.1:3321 node tools/check/modecheck.js
 */

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3321}`;
let pass = 0;
let fail = 0;

function ok(cond, name, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
  }
}

async function api(path, body) {
  const r = await fetch(BASE + path, {
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
const act = (pid, action, rest) => api('/api/game', Object.assign({ id: pid, action }, rest || {}));
const view = async (pid) => (await api('/api/state?role=play&pid=' + pid)).data.view;
const hostPanel = async () => (await api('/api/state?role=host')).data.panel;
const info = (p, label) => {
  const it = (p.info || []).find((i) => i.label === label);
  return it ? it.value : '';
};
const ctrl = (p, name) =>
  (p.controls || []).find((c) => c.kind === 'select' && c.name === name);

async function join(names) {
  await host('room/kickAll');
  const out = [];
  for (const n of names) {
    const r = await api('/api/join', { name: n, headset: true });
    if (r.data && r.data.id) out.push(r.data);
  }
  return out;
}

// 玩家视图里那些「不该让旁人看出来」的字段
const SKIN_KEYS = ['type', 'title', 'sub', 'text', 'hold'];

(async () => {
  console.log('\n  玩法检查 ─────────────────────────');

  let players = await join(['阿凯', '小雨', '老周', '小美', '大鹏', '阿哲']);
  ok(players.length === 6, '6 个人进场', players.length);

  await host('game/select', { id: 'undercover' });

  /* ------------------------------------------------ 一、标准 */
  let st = await host('game/start', {});
  ok(!st.data.error, '标准局能开局', st.data);

  let p = await hostPanel();
  ok(/标准/.test(info(p, '玩法')), '主持台显示玩法：标准', info(p, '玩法'));
  ok(!!ctrl(p, 'mode'), '主持台有「玩法」下拉');
  ok(!!ctrl(p, 'count'), '标准局有「卧底人数」下拉');
  ok(!!ctrl(p, 'packId'), '标准局有「词库」下拉');
  ok(info(p, '玩法') === '标准', '没换玩法时不显示「→ 下局」', info(p, '玩法'));

  const std = [];
  for (const x of players) std.push(await view(x.id));
  const stdWords = std.map((v) => v.text);
  ok(stdWords.filter((w) => !!w).length === 6, '标准局 6 个人都拿到词', stdWords.length);
  ok(new Set(stdWords).size === 2, '标准局只出现两个词', [...new Set(stdWords)]);
  ok(std.every((v) => v.type === 'word' && v.hold === true), '所有人都是按住看的词卡');
  ok(info(p, '卧底') !== '—', '主持台知道卧底是谁', info(p, '卧底'));
  ok(info(p, '平民词') !== '—' && info(p, '卧底词') !== '—', '主持台两个词都看得到');

  /* ------------------------------------------------ 二、白板 */
  const m1 = await host('game/act', { action: 'host_mode', mode: 'blank' });
  ok(!m1.data.error, '能切到白板玩法', m1.data);
  p = await hostPanel();
  ok(/→ 下局：白板/.test(info(p, '玩法')), '切玩法只写在「下一局」，本局不变', info(p, '玩法'));
  ok(info(p, '玩法').indexOf('标准') === 0, '本局玩法仍然是标准', info(p, '玩法'));
  ok((await view(players[0].id)).text === std[0].text, '切玩法之后本局手里的词没被改');

  const m2 = await host('game/act', { action: 'host_mode', mode: 'nope' });
  ok(!!m2.data.error, '不存在的玩法会被拦住', m2.data);

  await host('game/act', { action: 'host_nextRound' });
  p = await hostPanel();
  ok(!/→ 下局/.test(info(p, '玩法')), '重开后待用玩法已清空', info(p, '玩法'));
  ok(info(p, '玩法') === '白板', '重开后真的进了白板局', info(p, '玩法'));
  ok(info(p, '全民词') !== '—' && info(p, '全民词') !== '', '白板局有「全民词」', info(p, '全民词'));
  ok(info(p, '卧底词') === '', '白板局没有「卧底词」这一条');
  ok(!ctrl(p, 'count'), '白板局不显示「卧底人数」下拉');

  const blankName = info(p, '白板');
  ok(blankName !== '—' && blankName !== '', '主持台知道白板是谁', blankName);

  const blankViews = [];
  for (const x of players) blankViews.push({ p: x, v: await view(x.id) });
  const blanks = blankViews.filter((x) => x.v.text === '白板');
  ok(blanks.length === 1, '恰好一个人拿到「白板」', blanks.length);
  const blank0 = blanks[0] || { p: { id: '', name: '?' } };
  ok(blank0.p.name === blankName, '主持台上的白板名字对得上', {
    blankName,
    got: blank0.p.name,
  });

  const civWord = info(p, '全民词');
  const civViews = blankViews.filter((x) => x.v.text !== '白板');
  ok(civViews.length === 5, '另外 5 个人都拿到词', civViews.length);
  ok(civViews.every((x) => x.v.text === civWord), '5 个人拿的是同一个词', civViews.map((x) => x.v.text));

  // 防泄密：白板的手机和平民的手机，遮罩外面必须一模一样
  ok(
    blankViews.every((x) => x.v.type === 'word' && x.v.hold === true),
    '白板也是按住看的词卡（不是空屏）'
  );
  ok(
    blankViews.every((x) => x.v.title === '你的词'),
    '所有人的标题一样',
    [...new Set(blankViews.map((x) => x.v.title))]
  );
  // 发言阶段只有「是不是你的回合」这一个区别，那是全场公开的信息
  ok(
    blankViews.every((x) => /^轮到你发言：/.test(x.v.sub) || /^轮到 .+ 发言$/.test(x.v.sub)),
    '所有人的副标题只有「轮到谁」这一种差别',
    [...new Set(blankViews.map((x) => x.v.sub))]
  );
  ok(
    blankViews.every((x) => !x.v.hint && !x.v.note && !x.v.badge),
    '白板局没人多出提示 / 小字 / 角标'
  );
  const keySets = blankViews.map((x) =>
    Object.keys(x.v).filter((k) => SKIN_KEYS.includes(k)).sort().join(',')
  );
  ok(new Set(keySets).size === 1, '白板和平民的词卡字段集合一致', [...new Set(keySets)]);

  /* 白板撑到最后两个 → 白板获胜 */
  // 投票阶段：不管拿的是词还是白板，遮罩外面的文案必须一模一样
  await host('game/act', { action: 'host_vote' });
  const voteViews = [];
  for (const x of players) voteViews.push(await view(x.id));
  ok(
    new Set(voteViews.map((v) => v.sub)).size === 1,
    '投票阶段所有人副标题完全一致',
    [...new Set(voteViews.map((v) => v.sub))]
  );
  ok(voteViews.every((v) => v.choice && v.choice.action === 'vote'), '所有人都能投票');

  const blankPid = blank0.p.id;
  const civPids = civViews.map((x) => x.p.id);
  let guard = 0;
  while (blankPid && guard++ < 8) {
    p = await hostPanel();
    if (info(p, '阶段') === '已结束') break;
    const alivePids = [];
    for (const x of players) {
      const v = await view(x.id);
      if (v.title !== '你出局了') alivePids.push(x.id);
    }
    const victim = civPids.find((id) => alivePids.includes(id));
    if (!victim) break;
    await host('game/act', { action: 'host_vote' });
    for (const pid of alivePids) await act(pid, 'vote', { targetId: victim });
    const t = await host('game/act', { action: 'host_tally' });
    if (t.data && t.data.tie) continue;
  }
  p = await hostPanel();
  ok(info(p, '阶段') === '已结束', '白板局能走到结束', info(p, '阶段'));
  const blankEnd = blankPid ? await view(blankPid) : {};
  ok(/白板获胜/.test(blankEnd.title || ''), '白板活到最后两个 → 白板获胜', blankEnd.title);
  ok(/白板/.test(blankEnd.sub || ''), '结束时公布白板是谁', blankEnd.sub);

  /* ------------------------------------------------ 三、白板被投出 → 平民胜 */
  await host('game/act', { action: 'host_nextRound' });
  await host('game/act', { action: 'host_vote' });
  p = await hostPanel();
  const blank2 = info(p, '白板');
  const blank2P = players.find((x) => x.name === blank2) || players[0];
  for (const x of players) {
    if ((await view(x.id)).title === '你出局了') continue;
    await act(x.id, 'vote', { targetId: blank2P.id });
  }
  const t2 = await host('game/act', { action: 'host_tally' });
  ok(!t2.data.error, '能投掉白板', t2.data);
  p = await hostPanel();
  ok(info(p, '阶段') === '已结束', '白板出局后本局结束');
  ok(/平民获胜/.test((await view(blank2P.id)).title || ''), '白板被投出 → 平民获胜');

  /* ------------------------------------------------ 四、双卧底 */
  const t1 = await host('game/act', { action: 'host_mode', mode: 'team' });
  ok(!t1.data.error, '能切到双卧底', t1.data);
  await host('game/act', { action: 'host_nextRound' });
  p = await hostPanel();
  ok(info(p, '玩法') === '双卧底', '重开后进了双卧底', info(p, '玩法'));
  ok(!ctrl(p, 'count'), '双卧底局不显示「卧底人数」下拉');

  const tv = [];
  for (const x of players) tv.push({ p: x, v: await view(x.id) });
  const under = tv.filter((x) => !!x.v.note);
  ok(under.length === 2, '恰好两个卧底拿到同伙信息', under.length);
  ok(under.every((x) => /^同伙：/.test(x.v.note)), '同伙信息的格式统一', under.map((x) => x.v.note));
  ok(
    under.every((x) => x.v.note.indexOf(under.find((y) => y.p.id !== x.p.id).p.name) > 0),
    '同伙指的是另一个人',
    under.map((x) => x.v.note)
  );
  const underWord = new Set(under.map((x) => x.v.text));
  ok(underWord.size === 1, '两个卧底拿的是同一个词', [...underWord]);
  ok(tv.filter((x) => !x.v.note).every((x) => !underWord.has(x.v.text)), '平民词和卧底词不同');
  ok(info(p, '卧底').split('、').length === 2, '主持台看到两个卧底', info(p, '卧底'));
  // 这一条是专门盯「有人多长出一行」的：hint 和角标都在遮罩外面
  ok(tv.every((x) => !x.v.hint && !x.v.badge), '双卧底局谁都没有多出 hint / 角标');

  // 同伙不能出现在遮罩外面
  ok(under.every((x) => x.v.title === '你的词'), '卧底和平民的标题一样');
  const subKinds = new Set(
    tv
      .map((x) => x.v.sub)
      .map((s) => String(s || '').replace(/^轮到 .+ 发言$/, '轮到某人').replace(/^轮到你发言：.*$/, '轮到某人'))
  );
  ok(subKinds.size === 1, '副标题只有「轮到谁」这一种差别', [...subKinds]);
  ok(under.every((x) => !x.v.hint), '同伙信息没走 hint（hint 在遮罩外）');
  ok(under.every((x) => !x.v.badge), '卧底没有角标');
  ok(
    under.every(
      (x) => JSON.stringify(Object.keys(x.v).sort()) === '["done","hold","lead","note","prog","sub","text","title","tone","type"]'
    ),
    '卧底只是多一个 note 字段，其余完全一致',
    under.map((x) => Object.keys(x.v).sort())
  );

  /* ------------------------------------------------ 五、双卧底人数不够 */
  const few = await join(['甲', '乙', '丙', '丁']);
  ok(few.length === 4, '重新进 4 个人', few.length);
  await host('game/select', { id: 'undercover' });
  await host('game/act', { action: 'host_mode', mode: 'team' });
  const bad = await host('game/start', {});
  ok(!!bad.data.error && /双卧底/.test(bad.data.error), '4 个人开不了双卧底', bad.data);
  const badP = await hostPanel();
  ok(/→ 下局：双卧底/.test(info(badP, '玩法')), '开不了的时候玩法设置没被吃掉', info(badP, '玩法'));

  /* ------------------------------------------------ 六、标准局人数仍然可调 */
  await host('game/act', { action: 'host_mode', mode: 'standard' });
  const six = await join(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);
  await host('game/select', { id: 'undercover' });
  await host('game/start', {});
  const c1 = await host('game/act', { action: 'host_undercover', count: 2 });
  ok(!c1.data.error, '标准局能选两个卧底', c1.data);
  p = await hostPanel();
  ok(ctrl(p, 'count') && ctrl(p, 'count').value === '2', '下拉记住了两人', ctrl(p, 'count'));
  await host('game/act', { action: 'host_nextRound' });
  p = await hostPanel();
  ok(info(p, '卧底').split('、').length === 2, '下一局真的发了两个卧底', info(p, '卧底'));
  ok(!!ctrl(p, 'count'), '标准局一直有人数下拉');

  /* ------------------------------------------------ 七、大屏不泄密 */
  const wA = info(p, '平民词');
  const wB = info(p, '卧底词');
  const dump = JSON.stringify((await api('/api/state?role=screen')).data);
  ok(!/同伙/.test(dump), '大屏上没有同伙信息');
  ok(!dump.includes(wA) || wA === '—', '大屏上没有平民词', wA);
  ok(!dump.includes(wB) || wB === '—', '大屏上没有卧底词', wB);

  for (const x of six) {
    const v = await view(x.id);
    ok(!/同伙/.test(v.hint || '') && !/同伙/.test(v.sub || ''), `${x.name}：遮罩外没有同伙字样`);
  }

  await host('room/kickAll');
  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
