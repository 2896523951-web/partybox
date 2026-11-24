'use strict';

/* 冒烟测试：把九个游戏的主流程跑一遍，确认没有当场炸的地方。
 *   先开服务：PORT=3321 node server.js
 *   再跑：      PORT=3321 node tools/check/smoke.js
 */

const BASE = `http://127.0.0.1:${process.env.PORT || 3210}`;
const testsfx = require('../lib/testsfx');
let pass = 0;
let fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ok(cond, name, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ' → ' + JSON.stringify(extra) : ''}`);
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
const act = (id, action, rest) => api('/api/game', Object.assign({ id, action }, rest || {}));
const state = (pid) => api('/api/state?role=play&pid=' + pid);
const hostState = () => api('/api/state?role=host');
const screenState = () => api('/api/state?role=screen');
const info2 = (d, label) => {
  const it = (d.panel.info || []).find((i) => i.label === label);
  return it ? it.value : '';
};
const info = info2;

(async () => {
  console.log('\n  冒烟测试 ─────────────────────────');

  // R4 之后音效库里只有真文件，空库时两个音效游戏都点不动（设计如此）。
  // 测试不能因此挂掉：库里没东西就自己塞一个静音 wav 进去。
  const fxId = await testsfx.ensure();

  /* 鉴权 */
  const noKey = await fetch(BASE + '/api/state?role=host');
  ok(noKey.status === 200 || noKey.status === 403, '主持台接口有鉴权（本机放行 / 局域网 403）');

  const hostHtml = await fetch(BASE + '/host');
  ok(hostHtml.status === 200 || hostHtml.status === 403, '/host 可访问且受密钥保护');

  /* 玩家进场 */
  await host('room/kickAll');
  const players = [];
  for (const n of ['阿凯', '小雨', '老周', '小美', '大鹏', '阿哲']) {
    const r = await api('/api/join', { name: n, headset: true });
    if (r.data && r.data.id) players.push(r.data);
  }
  ok(players.length === 6, '6 个人能进房', players.length);
  ok(players.every((p) => !p.team), '进场不自动分队（等主持人点分组）');

  const grouped = await host('room/group');
  ok(!grouped.data.error, '一键分组能用', grouped.data);
  let hs0 = await hostState();
  const aN = hs0.data.players.filter((p) => p.team === 'A').length;
  const bN = hs0.data.players.filter((p) => p.team === 'B').length;
  ok(aN === 3 && bN === 3, '6 人分成 3 / 3', { aN, bN });

  const tplus = await host('team/score', { team: 'A', delta: 5 });
  const tminus = await host('team/score', { team: 'A', delta: -2 });
  hs0 = await hostState();
  ok(!tplus.data.error && !tminus.data.error && hs0.data.teams.A.score === 3, '队伍能加分减分', hs0.data.teams);

  const tset = await host('team/setScore', { team: 'B', score: 7 });
  hs0 = await hostState();
  ok(!tset.data.error && hs0.data.teams.B.score === 7, '队伍分数能直接改', hs0.data.teams.B);

  // 在场的人都在线，清离线不该误伤
  const pruneRes = await host('room/prune');
  ok(!pruneRes.data.error && pruneRes.data.removed === 0, '清离线：没人离线就不动', pruneRes.data);
  hs0 = await hostState();
  ok(hs0.data.players.length === 6, '清离线后人数不变', hs0.data.players.length);

  const noHeadset = await api('/api/join', { name: '外放哥', headset: false });
  ok(noHeadset.status === 400, '没勾耳机不让进');

  /* 传声筒 */
  await host('game/select', { id: 'relay' });
  let st = await host('game/start', {});
  ok(!st.data.error, '传声筒能开局', st.data);

  let hs = await hostState();
  ok(info2(hs.data, '挑棒次').includes('/'), '开局先让玩家自己挑棒次', info2(hs.data, '挑棒次'));
  const pickViews = [];
  for (const p of players) pickViews.push((await state(p.id)).data.view);
  ok(pickViews.every((v) => v.type === 'choice'), '每个人都能挑棒次', pickViews.map((v) => v.type));

  // 按顺序各占一棒：第 i 个人挑第 i+1 棒
  for (let i = 0; i < players.length; i += 1) {
    const r = await act(players[i].id, 'pick', { targetId: String(i + 1) });
    ok(!r.data.error, `第 ${i + 1} 个人挑了第 ${i + 1} 棒`, r.data);
  }
  hs = await hostState();
  ok(info2(hs.data, '进度') === '1 / 6', '挑满了自动开始', info2(hs.data, '进度'));

  const word = (hs.data.panel.info.find((i) => i.label === '本轮词') || {}).value;
  ok(!!word && word !== '—', '主持台看到本轮词：' + word);

  // 灌杂音：音效自己挑，选完按「灌」放的就是那个
  // （R4 之后只剩真文件，内置合成的全删了，所以 chip 数 = 库里文件数）
  const dpick = (hs.data.panel.controls || []).find((c) => c.kind === 'sfxPick');
  ok(dpick && dpick.custom.length >= 1, '灌杂音能选音效', dpick && dpick.custom.length);
  ok(dpick && Array.isArray(dpick.builtin) && !dpick.builtin.length, '内置合成都删干净了', dpick && dpick.builtin);
  const dset = await host('game/act', { action: 'host_disturbSound', sound: fxId });
  ok(!dset.data.error, '能选灌哪种杂音');
  const dgo = await host('game/act', { action: 'host_disturb', targetId: players[0].id });
  ok(!dgo.data.error, '能灌杂音');
  const ds2 = (await hostState()).data.panel.controls.find((c) => c.kind === 'sfxPick');
  ok(ds2 && ds2.value === fxId, '选的杂音记住了', ds2 && ds2.value);
  // 老存档里可能留着 'noise' 这种已经删掉的内置名字，不能报错也不能空着
  const dold = await host('game/act', { action: 'host_disturbSound', sound: 'noise' });
  const ds3 = (await hostState()).data.panel.controls.find((c) => c.kind === 'sfxPick');
  ok(!dold.data.error && ds3 && ds3.value === fxId, '旧的内置名字自动落到真文件上', ds3 && ds3.value);
  const dstop = await host('game/act', { action: 'host_disturbStop' });
  ok(!dstop.data.error, '杂音能停');

  const views = [];
  for (const p of players) {
    const s = await state(p.id);
    views.push(s.data.view);
  }
  const wordViews = views.filter((v) => v.type === 'word');
  ok(wordViews.length === 1, '只有第 1 棒能看词', wordViews.length);
  ok(wordViews[0] && wordViews[0].text === word, '第 1 棒看到的词正确');
  ok(views.filter((v) => v.type === 'answer').length === 0, 'C3 最后一棒不再用输入框');

  // 一路传到底
  const order = (hs.data.panel.table.rows || []).map((r) => r[1]);
  let guard = 0;
  while (guard++ < 8) {
    const cur = (await hostState()).data.panel.info.find((i) => i.label === '进度').value;
    if (cur.includes('/') && Number(cur.split('/')[0]) >= 6) break;
    const before = cur;
    // C3 之后由主持人推进（手机不再有「我传完了」）
    const step = await host('game/act', { action: 'host_step' });
    if (step.data.error) break;
  }
  hs = await hostState();
  const prog = hs.data.panel.info.find((i) => i.label === '进度');
  ok(prog && prog.value === '6 / 6', '传到最后一个人', prog);

  // C3：最后一棒改成口头说，手机不再有输入框
  let hasInput = false;
  for (const p of players) {
    const v = (await state(p.id)).data.view;
    if (v.type === 'answer') hasInput = true;
  }
  ok(!hasInput, 'C3 手机上不再有作答框');

  const relayScr = await screenState();
  ok(!JSON.stringify(relayScr.data).includes(word), '大屏不显示本轮词');

  const hj = await host('game/act', { action: 'host_judge', payload: { ok: true } });
  ok(!hj.data.error, 'C3 主持人能判对');

  /* 谁是卧底 */
  await host('game/select', { id: 'undercover' });
  st = await host('game/start', {});
  ok(!st.data.error, '卧底能开局', st.data);

  const words = [];
  for (const p of players) {
    const v = (await state(p.id)).data.view;
    if (v.type === 'word') words.push(v.text);
  }
  ok(words.length === 6, '6 个人都拿到词', words.length);
  ok(new Set(words).size === 2, '只出现两个词（平民词 / 卧底词）', [...new Set(words)]);

  hs = await hostState();
  const uc = hs.data.panel.info.find((i) => i.label === '卧底').value;
  ok(uc && uc !== '—', '主持台知道谁是卧底：' + uc);

  await host('game/act', { action: 'host_vote' });
  for (const p of players) {
    const target = players.find((x) => x.id !== p.id);
    await act(p.id, 'vote', { targetId: target.id });
  }
  const tally = await host('game/act', { action: 'host_tally' });
  ok(!tally.data.error && tally.data.out, '计票能投出一个人', tally.data);

  /* 你们认了吗 */
  await host('game/select', { id: 'poll' });
  st = await host('game/start', {});
  ok(!st.data.error, '投票题能开局', st.data);
  for (const p of players) {
    const others = players.filter((x) => x.id !== p.id).slice(0, 2).map((x) => x.id);
    await act(p.id, 'vote', { targets: others });
  }
  hs = await hostState();
  ok(String(hs.data.panel.info.find((i) => i.label === '已投').value).startsWith('6'), '6 人投票都记上了');
  const sc = await screenState();
  ok(Array.isArray(sc.data.bars) && sc.data.bars.length === 6, '大屏有票数条');

  /* 数字炸弹 */
  await host('game/select', { id: 'numberbomb' });
  st = await host('game/start', {});
  ok(!st.data.error, '数字炸弹能开局', st.data);
  hs = await hostState();
  const turnName = hs.data.panel.info.find((i) => i.label === '轮到').value;
  const turner = players.find((p) => p.name === turnName);
  const pr = await act(turner.id, 'pick', { n: 50 });
  ok(!pr.data.error, '轮到的人能报数', pr.data);

  /* 私密音效（原耳返攻击，现在是跨游戏工具：不挑游戏、不用开局） */
  const pr2 = await host('sfx/poke', { id: players[0].id, sound: fxId });
  ok(!pr2.data.error, '开了局就能对指定人放（不要求是某个游戏）', pr2.data);
  hs = await hostState();
  ok(hs.data.whisper && hs.data.whisper.id === players[0].id, '主持台记得谁耳机里在响', hs.data.whisper);
  ok(hs.data.whisper.left > 0, '带剩余时间（到点自动收）', hs.data.whisper.left);

  const pr3 = await host('sfx/poke', { id: players[1].id, sound: fxId });
  ok(!pr3.data.error, '换个人放也能放', pr3.data);
  hs = await hostState();
  ok(hs.data.whisper.id === players[1].id, '换人之后只剩新的这个在响', hs.data.whisper);

  const stp = await host('sfx/pokeStop');
  ok(!stp.data.error, '能停');
  hs = await hostState();
  ok(hs.data.whisper.id === null, '停完就不记得有人在响', hs.data.whisper);

  // 没戴耳机的人不给放：放出来是全场公放，不是私密音效
  const bare = await api('/api/join', { name: '没耳机', headset: true });
  await api('/api/headset', { id: bare.data.id, headset: false });
  const barePoke = await host('sfx/poke', { id: bare.data.id, sound: fxId });
  ok(!!barePoke.data.error && /耳机/.test(barePoke.data.error), '没戴耳机的人放不了，且说清原因', barePoke.data);
  await host('player/kick', { id: bare.data.id });

  // 老存档里可能还是 'laugh' 这种已经删掉的内置名字：落到第一个真文件，别发空指令
  const oldName = await host('sfx/poke', { id: players[0].id, sound: 'laugh' });
  ok(!oldName.data.error, '旧的内置名字不会报错', oldName.data);
  hs = await hostState();
  ok(hs.data.whisper.sound === fxId, '旧名字自动落到第一个真文件', hs.data.whisper);
  await host('sfx/pokeStop');

  /* 狼人杀（带神职） */
  await host('game/select', { id: 'werewolf' });
  st = await host('game/start', {});
  ok(!st.data.error, '狼人杀能开局', st.data);

  const roleOf = {};
  hs = await hostState();
  for (const r of hs.data.panel.table.rows) roleOf[r[0]] = r[1];
  const wolfP = players.find((p) => roleOf[p.name] === '狼人');
  const seerP = players.find((p) => roleOf[p.name] === '预言家');
  const witchP = players.find((p) => roleOf[p.name] === '女巫');
  ok(wolfP && seerP && witchP, '6 人局自动配出 狼 / 预言家 / 女巫', roleOf);

  const victim = players.find((p) => p.id !== wolfP.id && roleOf[p.name] !== '狼人');
  const bite = await act(wolfP.id, 'wolfbite', { targetId: victim.id });
  ok(!bite.data.error, '狼人夜里能刀人', bite.data);

  await host('game/act', { action: 'host_nextStep' });
  const check = await act(seerP.id, 'seercheck', { targetId: wolfP.id });
  ok(!check.data.error, '预言家能验人', check.data);
  const seerView = (await state(seerP.id)).data.view;
  ok(seerView.type === 'word' && /狼人/.test(seerView.text || ''), '预言家验到狼会看到狼', seerView.text);

  const nonSeer = players.find((p) => p.id !== seerP.id);
  const fakeCheck = await act(nonSeer.id, 'seercheck', { targetId: wolfP.id });
  ok(!!fakeCheck.data.error, '非预言家验不了人', fakeCheck.data);

  await host('game/act', { action: 'host_nextStep' });
  const noSave = await act(witchP.id, 'witchsave', { targetId: 'no' });
  ok(!noSave.data.error, '女巫能决定不救', noSave.data);
  const noPoison = await act(witchP.id, 'witchpoison', { targetId: '__none__' });
  ok(!noPoison.data.error, '女巫能选择不毒', noPoison.data);

  await host('game/act', { action: 'host_dawn' });
  hs = await hostState();
  const outN = hs.data.panel.table.rows.filter((r) => r[2] === '出局').length;
  ok(outN >= 1, '天亮后有人出局', outN);
  ok(info(hs.data, '阶段').includes('白天') || info(hs.data, '阶段') === '白天', '天亮进入白天', info(hs.data, '阶段'));

  /* 你画我猜（纸笔版） */
  await host('game/select', { id: 'drawguess' });
  st = await host('game/start', {});
  ok(!st.data.error, '你画我猜能开局', st.data);
  hs = await hostState();
  const dWord = hs.data.panel.info.find((i) => i.label === '本轮词').value;
  let drawerId = null;
  let guesserId = null;
  for (const p of players) {
    const v = (await state(p.id)).data.view;
    if (v.type === 'word') drawerId = p.id;
    if (v.type === 'answer') guesserId = p.id;
  }
  ok(drawerId && guesserId, '画手看词、其他人能猜', { drawerId, guesserId });
  const gm = await act(guesserId, 'guess', { text: dWord + '！' });
  ok(gm.data.correct === true, '带标点也能判对（模糊匹配）', gm.data);

  hs = await hostState();
  ok((hs.data.panel.table.columns || []).includes('猜中'), '你画我猜有猜中统计列', hs.data.panel.table.columns);
  const gRow = (hs.data.panel.table.rows || []).find(
    (r) => r[0] === (players.find((p) => p.id === guesserId) || {}).name
  );
  ok(gRow && Number(gRow[1]) >= 1, '猜对的人统计 +1', gRow);
  ok(/次/.test(info(hs.data, '累计猜中')), '主持台有累计猜中', info(hs.data, '累计猜中'));

  /* 舞蹈狼人杀 */
  await host('game/select', { id: 'dancewolf' });
  st = await host('game/start', {});
  ok(!st.data.error, '舞蹈狼人杀能开局', st.data);
  hs = await hostState();
  const kingP = players.find((p) => p.name === info(hs.data, '狼王'));
  ok(!!kingP, '抽出了狼王：' + info(hs.data, '狼王'));

  await host('game/act', { action: 'host_start' });
  const goodP = players.find((p) => p.id !== kingP.id);
  const kingView = (await state(kingP.id)).data.view;
  const goodView = (await state(goodP.id)).data.view;
  ok(kingView.beat && kingView.beat.on === false, '狼王的手机不放歌', kingView.beat);
  ok(goodView.beat && goodView.beat.on === true, '好人耳机里有音乐', goodView.beat);
  ok(
    kingView.beat.show === true && goodView.beat.show === true,
    '音乐条对所有人都显示（界面一致，才不会一眼看出谁是狼王）'
  );
  ok(
    typeof goodView.beat.startAt === 'number' &&
      goodView.beat.startAt === kingView.beat.startAt,
    '所有人拿到同一个开始时刻，踩同一拍'
  );
  ok(
    kingView.sub === goodView.sub && kingView.title === goodView.title,
    '词卡外面的文案对所有身份一致（不泄露狼王）',
    { king: kingView.sub, good: goodView.sub }
  );

  const kingHidden = JSON.stringify((await state(goodP.id)).data);
  ok(!kingHidden.includes('狼王'), '好人接口里查不到谁是狼王');

  /* 曲目进度条：主持人拖，全场一起跳 —— 不是各拖各的 */
  hs = await hostState();
  const seekCtl = (hs.data.panel.controls || []).find((c) => c.kind === 'seek');
  ok(!!seekCtl, '主持台上有曲目进度条', !!(seekCtl && seekCtl.kind));
  ok(Math.abs((seekCtl.duration || 0) - 60) < 0.01, '进度条总长 = 本轮跳舞时长', seekCtl.duration);

  const seek = await host('game/act', { action: 'host_seek', sec: 25 });
  ok(!seek.data.error, '主持人能拖动进度', seek.data);
  const gv2 = (await state(goodP.id)).data.view;
  const kv2 = (await state(kingP.id)).data.view;
  ok(Math.abs((gv2.beat.offset || 0) - 25) < 0.2, '好人跳到第 25 秒', gv2.beat.offset);
  ok(
    gv2.beat.offset === kv2.beat.offset && gv2.beat.startAt === kv2.beat.startAt,
    '狼王和好人拿到同一个位置、同一个时刻',
    { good: gv2.beat, king: kv2.beat }
  );
  ok(gv2.beat.on === true && kv2.beat.on === false, '拖动之后还是只有狼王没声音');
  ok(
    Math.abs(gv2.beat.duration - 60) < 0.01,
    '拖动不会改变曲目总长',
    gv2.beat.duration
  );

  const over = await host('game/act', { action: 'host_seek', sec: 999 });
  ok(!over.data.error, '拖过头不报错', over.data);
  const gv3 = (await state(goodP.id)).data.view;
  ok(gv3.beat.offset <= 60, '位置被夹在曲目长度以内', gv3.beat.offset);

  const back = await host('game/act', { action: 'host_seek', sec: 0 });
  ok(!back.data.error, '能拖回开头', back.data);

  /* 音量归主持人：手机端不再自己调（不然谁都能静音装听不见） */
  const volDown = await host('game/act', { action: 'host_vol', vol: 35 });
  ok(!volDown.data.error, '主持人能调耳机音量', volDown.data);
  const gvVol = (await state(goodP.id)).data.view;
  ok(gvVol.beat.vol === 35, '每台手机拿到的是主持人设的音量', gvVol.beat.vol);
  const kvVol = (await state(kingP.id)).data.view;
  ok(kvVol.beat.vol === 35, '狼王那台的音量也一样（界面一致）', kvVol.beat.vol);

  const trackHost = await host('game/act', { action: 'host_track', trackId: 'synth' });
  ok(!trackHost.data.error, '能选曲目', trackHost.data);
  const gvTrack = (await state(goodP.id)).data.view;
  ok(gvTrack.beat.track && gvTrack.beat.track.kind === 'synth', '默认是手机本地合成的舞曲', gvTrack.beat.track);

  await host('game/act', { action: 'host_stop' });
  const talkView = (await state(goodP.id)).data.view;
  ok(!talkView.beat || talkView.beat.on === false, '停音乐后音乐自动关闭', talkView.beat);
  ok(!talkView.beat || talkView.beat.show === false, '停音乐后音量条一起收起');

  const lateSeek = await host('game/act', { action: 'host_seek', sec: 10 });
  ok(!!lateSeek.data.error, '音乐没在放的时候拖不动', lateSeek.data);

  const conv = await host('game/act', { action: 'host_convert', targetId: goodP.id });
  ok(!conv.data.error, '狼王能同化一个人', conv.data);
  const restGuy = players.find((p) => p.id !== kingP.id && p.id !== goodP.id);
  const conv2 = await host('game/act', { action: 'host_convert', targetId: restGuy.id });
  ok(!!conv2.data.error, '同化次数用完会被拦住', conv2.data);

  await host('game/act', { action: 'host_vote' });
  for (const p of players) await act(p.id, 'vote', { targetId: kingP.id });
  await host('game/act', { action: 'host_settle' });
  const danceResult = (await state(goodP.id)).data.view;
  ok(/好人胜/.test(danceResult.title || ''), '全员投狼王 → 好人胜', danceResult.title);

  /* 笨蛋杀手 */
  await host('game/select', { id: 'dumbkill' });
  st = await host('game/start', {});
  ok(!st.data.error, '笨蛋杀手能开局', st.data);
  hs = await hostState();
  const bossP = players.find((p) => p.name === info(hs.data, '老板'));
  const killerP = players.find((p) => p.name === info(hs.data, '杀手'));
  const targetP = players.find((p) => p.name === info(hs.data, '当前目标'));
  ok(bossP && killerP && targetP, '老板 / 杀手 / 目标都抽出来了');
  ok(bossP.id !== killerP.id, '老板和杀手不是同一个人');

  // 接头提示只有老板和杀手知道。打上大屏，全场都能做这个动作，杀手就永远找不到老板了。
  const dkAct = info(hs.data, '接头提示');
  ok(dkAct && dkAct !== '—', '主持人能看到接头提示：' + dkAct);
  const dkScr = JSON.stringify((await screenState()).data);
  ok(!dkScr.includes(dkAct), '大屏上没有接头提示');
  const dkKillerDump = JSON.stringify((await state(killerP.id)).data);
  ok(dkKillerDump.includes(dkAct), '杀手手机上能看到接头提示（不然认不出老板）');
  const dkGood = await state(
    players.find((p) => p.id !== bossP.id && p.id !== killerP.id).id
  );
  ok(!JSON.stringify(dkGood.data).includes(dkAct), '好人手机上查不到接头提示');

  const bossView = (await state(bossP.id)).data.view;
  ok(
    bossView.type === 'word' && String(bossView.text || '').includes(targetP.name),
    '老板手机上看到击杀目标',
    bossView.text
  );

  // 杀手能看到所有人名（要选人），但接口里不能有「哪个是目标」这个字段
  const killerView = (await state(killerP.id)).data.view;
  ok(!killerView.targetId && !killerView.target && !killerView.reveal, '杀手接口里没有目标字段');
  ok(!killerView.selected || !killerView.selected.length, '杀手没有被预先选中的人');

  const otherP = players.find(
    (p) => p.id !== killerP.id && p.id !== targetP.id && p.id !== bossP.id
  );
  const miss = await act(killerP.id, 'shoot', { targetId: otherP.id });
  ok(miss.data.hit === false, '喊错会打偏', miss.data);
  const hit = await act(killerP.id, 'shoot', { targetId: targetP.id });
  ok(hit.data.hit === true, '喊对能击杀', hit.data);
  const plainGuy = players.find((p) => p.id !== bossP.id && p.id !== killerP.id);
  const wrongShooter = await act(plainGuy.id, 'shoot', { targetId: otherP.id });
  ok(!!wrongShooter.data.error, '好人不能开枪', wrongShooter.data);
  const bossShoot = await act(bossP.id, 'shoot', { targetId: otherP.id });
  ok(!!bossShoot.data.error, '老板也不能自己开枪', bossShoot.data);

  /* 好奇宝 */
  await host('game/select', { id: 'curious' });
  st = await host('game/start', {});
  ok(!st.data.error, '好奇宝能开局', st.data);
  hs = await hostState();
  const badNames = info(hs.data, '好奇宝').split('、');
  const teamNames = info(hs.data, '本轮队伍').split('、');
  ok(badNames.length >= 1, '抽出好奇宝', badNames);
  ok(teamNames.length >= 2, '抽出本轮队伍', teamNames);

  const badP = players.find((x) => x.name === badNames[0]);
  const badView = (await state(badP.id)).data.view;
  ok(badView.type === 'word' && /好奇宝/.test(badView.text || ''), '好奇宝本人有身份卡', badView.text);
  const cleanP = players.find((x) => !badNames.includes(x.name));
  const cleanView = (await state(cleanP.id)).data.view;
  ok(!/你是好奇宝/.test(cleanView.text || ''), '普通人看到的是普通人', cleanView.text);
  // 「在不在队伍里」是公开信息（大屏会显示），只有身份差异不能写在外层
  const badIn = teamNames.includes(badP.name);
  const cleanIn = teamNames.includes(cleanP.name);
  if (badIn === cleanIn) {
    ok(badView.sub === cleanView.sub, '身份卡外面的文案一致（不泄露好奇宝）', {
      bad: badView.sub,
      clean: cleanView.sub,
    });
  } else {
    const mateOfClean = players.find(
      (x) => !badNames.includes(x.name) && teamNames.includes(x.name) === cleanIn && x.id !== cleanP.id
    );
    const mateView = mateOfClean ? (await state(mateOfClean.id)).data.view : null;
    ok(
      !mateView || mateView.sub === cleanView.sub,
      '同为普通人，在不在队里之外文案一致',
      mateView && mateView.sub
    );
  }

  await host('game/act', { action: 'host_vote' });
  for (const n of teamNames) {
    const p = players.find((x) => x.name === n);
    if (p) await act(p.id, 'vote', { targetId: 'noeat' });
  }
  const cSettle = await host('game/act', { action: 'host_settle' });
  ok(!cSettle.data.error, '好奇宝能结算一轮', cSettle.data);
  hs = await hostState();
  ok(/成功 1/.test(info(hs.data, '比分')), '全员不吃 → 任务成功', info(hs.data, '比分'));

  await host('game/act', { action: 'host_open' });
  hs = await hostState();
  const team2 = info(hs.data, '本轮队伍').split('、');
  const badInTeam = team2.find((n) => badNames.includes(n));
  await host('game/act', { action: 'host_vote' });
  for (const n of team2) {
    const p = players.find((x) => x.name === n);
    if (p) await act(p.id, 'vote', { targetId: n === badInTeam ? 'eat' : 'noeat' });
  }
  await host('game/act', { action: 'host_settle' });
  hs = await hostState();
  if (badInTeam) {
    ok(/失败 1/.test(info(hs.data, '比分')), '好奇宝投吃 → 任务失败', info(hs.data, '比分'));
  } else {
    ok(/成功 2/.test(info(hs.data, '比分')), '这轮队里没好奇宝，必然成功', info(hs.data, '比分'));
  }

  const badDump = JSON.stringify((await state(badP.id)).data);
  ok(!badDump.includes('"badIds"'), '好奇宝接口里没有整份名单');

  /* 接力猜词 */
  await host('game/select', { id: 'drawrelay' });
  st = await host('game/start', {});
  ok(!st.data.error, '接力猜词能开局', st.data);
  // C1 之后开局先进入「挑棒次」，没人挑就由主持人补位开始
  await host('game/act', { action: 'host_next' });
  hs = await hostState();
  const rWord = info(hs.data, '本轮词');
  const relayOrder = hs.data.panel.table.rows.map((r) => players.find((p) => p.name === r[1]));
  const relayKinds = hs.data.panel.table.rows.map((r) => r[3]);
  ok(relayOrder.length === players.length, '每个人都排进了棒次', relayOrder.length);
  ok(
    relayKinds[0] === '画' && relayKinds[relayKinds.length - 1] === '猜',
    '第 1 棒画、最后一棒猜',
    relayKinds
  );

  const firstView = (await state(relayOrder[0].id)).data.view;
  ok(firstView.type === 'word' && firstView.text === rWord, '第 1 棒只有他看到词', firstView.text);
  const midView = (await state(relayOrder[1].id)).data.view;
  ok(!JSON.stringify(midView).includes(rWord), '第 2 棒看不到原词');

  for (let i = 0; i < relayOrder.length - 1; i++) {
    await act(relayOrder[i].id, 'handover', {});
  }
  const relGuess = await act(relayOrder[relayOrder.length - 1].id, 'guess', { text: rWord });
  ok(relGuess.data.correct === true, '最后一棒猜对', relGuess.data);

  hs = await hostState();
  ok(
    /对 \d+ · 错 \d+/.test(info(hs.data, 'A 队')) && /对 \d+ · 错 \d+/.test(info(hs.data, 'B 队')),
    '接力能按队统计猜对 / 没中',
    { A: info(hs.data, 'A 队'), B: info(hs.data, 'B 队') }
  );
  ok((hs.data.panel.table.columns || []).includes('队伍'), '接力表格里有队伍列');

  /* 重复就打飞 */
  await host('game/select', { id: 'dupfly' });
  st = await host('game/start', {});
  ok(!st.data.error, '重复就打飞能开局', st.data);
  await host('game/act', { action: 'host_stop' });
  hs = await hostState();
  ok(info(hs.data, '本轮主题') && info(hs.data, '本轮主题') !== '—', '音乐停后随机出主题：' + info(hs.data, '本轮主题'));
  ok(hs.data.panel.table.rows.length >= 2, '自动两两配对', hs.data.panel.table.rows.length);

  await host('game/act', { action: 'host_toggleGroup', group: 0 });
  hs = await hostState();
  ok(info(hs.data, '撞车') === '1 组', '能判某组撞车', info(hs.data, '撞车'));

  const beforeScore = hs.data.players.reduce((a, p) => a + p.score, 0);
  await host('game/act', { action: 'host_settle' });
  hs = await hostState();
  const afterScore = hs.data.players.reduce((a, p) => a + p.score, 0);
  ok(afterScore > beforeScore, '原创的组能加分，撞车的不加', { beforeScore, afterScore });

  /* 抢答 */
  await host('game/select', { id: 'songquiz' });
  // 这一段验的是手机抢答的判定，B4 之后默认大屏，显式关掉
  await host('game/start', { cfg: { big: false } });
  const opened = await host('game/act', { action: 'host_open' });
  ok(opened.data.openAt > 0, '听歌识曲能开抢');

  // 抢跑：不算，也不罚。手机端按钮这时候本来就是灰的。
  const tooEarly = await act(players[0].id, 'buzz', { clientTs: Date.now() });
  ok(tooEarly.data.reason === 'too_early', '没到点按不下来（不罚分、不禁答）', tooEarly.data);

  await sleep(950);
  const preBuzz = (await state(players[0].id)).data.view;
  ok(preBuzz.type === 'buzz' && !preBuzz.disabled, '到点之后按钮是可按的', preBuzz.disabled);
  const b1 = await act(players[1].id, 'buzz', { clientTs: Date.now() });
  const b2 = await act(players[2].id, 'buzz', { clientTs: Date.now() });
  ok(b1.data.ok === true, '第一个抢答有效');
  ok(!b2.data.ok || b2.data.reason === 'taken', '第二个人抢不到');
  const right = await host('game/act', { action: 'host_right' });
  ok(!right.data.error, '判答对能加分');

  await host('game/select', { id: 'buzzdance' });
  // S5 这几条验的是手机抢答的毫秒判定，B3 之后默认走大屏，这里显式关掉
  await host('game/start', { cfg: { big: false } });
  const early = await act(players[0].id, 'buzz', {});
  ok(early.data.reason === 'early', '报数抢答能识别抢跑');
  await sleep(5200);
  const onTime = await act(players[1].id, 'buzz', {});
  ok(onTime.data.ok === true && onTime.data.rank === 1, '开抢后第一个是第 1 名', onTime.data);
  const blockedAgain = await act(players[0].id, 'buzz', {});
  ok(blockedAgain.data.reason === 'blocked', '抢跑的人这轮不能再抢');

  /* 泄密检查 */
  const sc2 = await screenState();
  const dump = JSON.stringify(sc2.data);
  ok(!/"wolf"|"wordOf"|"undercover"|"secretWord"/.test(dump), '大屏快照里没有身份字段');
  ok(!/卧底词|平民词/.test(dump), '大屏没有卧底词');
  const playerDump = JSON.stringify((await state(players[1].id)).data);
  ok(!/"wolf":true/.test(playerDump), '其他玩家接口里没有狼人标记');

  /* 越权 */
  const evil = await act(players[0].id, 'host_stop', {});
  ok(!!evil.data.error, '玩家不能调主持动作', evil.data);

  const screenNoSecret = await fetch(BASE + '/api/state?role=screen&pid=' + players[0].id);
  ok(screenNoSecret.status === 200, '大屏接口可用');

  /* 资源 */
  for (const p of ['/', '/host', '/screen', '/assets/css/base.css', '/assets/js/view.js']) {
    const r = await fetch(BASE + p);
    ok(r.status === 200, `静态资源 ${p}`);
  }

  await testsfx.cleanup();
  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试崩了：', e);
  process.exit(1);
});
