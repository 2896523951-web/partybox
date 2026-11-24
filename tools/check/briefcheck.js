'use strict';

/* 开局面板（规则卡）检查。
 *
 * 这一版做的是「选完游戏先把 3 条规则打上投屏，主持人照着念」：
 *   - 大屏：游戏名 + 口号 + 3 条规则 + 二维码（后到的人还能扫）
 *   - 玩家手机：同样的 3 条，不用凑到别人屏幕前
 *   - 主持台：同一份字，大屏在身后也念得对
 *   - 收起：主持人做第一个真动作（发词开局 / 开始 / 放歌）就自动收，
 *     不需要再按一次「我讲完了」—— 那个按钮现场一定会被忘掉
 *
 *   先开服务：PORT=3321 node server.js
 *   再跑：    BASE=http://127.0.0.1:3321 node tools/check/briefcheck.js
 */

const path = require('path');
const fs = require('fs');

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
const act = (pid, action, rest) => api('/api/game', Object.assign({ id: pid, action }, rest || {}));
const view = async (pid) => (await api('/api/state?role=play&pid=' + pid)).data.view;
const screen = async () => (await api('/api/state?role=screen')).data;
const hostPanel = async () => (await api('/api/state?role=host')).data.panel;

async function join(names) {
  await host('room/kickAll');
  const out = [];
  for (const n of names) {
    const r = await api('/api/join', { name: n, headset: true });
    if (r.data && r.data.id) out.push(r.data);
  }
  return out;
}

/* 每个游戏「真正开始」的那个按钮。规则卡收不收就看它。 */
const STARTER = {
  relay: { action: 'host_next' },
  drawguess: { action: 'host_next' },
  drawrelay: { action: 'host_next' },
  numberbomb: { action: 'host_restart' },
  songquiz: { action: 'host_open' },
  buzzdance: { action: 'host_next' },
  dupfly: { action: 'host_musicPlay' },
  undercover: { action: 'host_nextRound' },
  dumbkill: { action: 'host_next' },
  dancewolf: { action: 'host_start' },
  werewolf: { action: 'host_next' },
  poll: { action: 'host_next' },
  curious: { action: 'host_next' },
};

/* 插件漏了规则卡内容，大屏上就是一张空卡 —— 现场等于没有。
 * check.js 也查这一条（静态查），这里再按代码加载一次，
 * 保证「跑起来的那份」和「盘上的那份」是同一个东西。 */
function loadGames() {
  const dir = path.join(__dirname, '../..', 'games');
  const out = {};
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = path.join(dir, d.name, 'index.js');
    if (!fs.existsSync(f)) continue;
    try {
      const g = require(f);
      if (g && g.id) out[g.id] = g;
    } catch (e) {}
  }
  return out;
}

(async () => {
  console.log('\n  开局面板检查 ─────────────────────');

  const GAMES = loadGames();
  const ids = Object.keys(GAMES);

  /* ------------------------------------------------ 一、内容齐不齐 */
  ok(ids.length >= 13, '游戏都加载到了', ids.length);

  const badSlogan = ids.filter((id) => !String(GAMES[id].slogan || '').trim());
  ok(!badSlogan.length, '每个游戏都有投屏口号', badSlogan);

  const badCount = ids.filter((id) => !Array.isArray(GAMES[id].rules) || GAMES[id].rules.length !== 3);
  ok(!badCount.length, '每个游戏正好 3 条规则', badCount);

  const tooLong = [];
  for (const id of ids) {
    for (const r of GAMES[id].rules || []) {
      if (String(r).length > 24) tooLong.push(`${id}: ${r.length} 字`);
    }
    if (String(GAMES[id].slogan || '').length > 20) tooLong.push(`${id}: slogan 超长`);
  }
  ok(!tooLong.length, '每条规则 ≤ 24 字（三米外念得下来）', tooLong);

  /* ------------------------------------------------ 二、选完游戏就上屏 */
  const players = await join(['阿凯', '小雨', '老周', '小美', '大鹏', '阿哲']);
  ok(players.length === 6, '6 个人进场', players.length);

  for (const id of ids) {
    const g = GAMES[id];
    await host('game/select', { id });
    const sc = await screen();
    const pv = await view(players[0].id);
    const hp = await hostPanel();

    const okScreen = sc.type === 'rules';
    const okRules =
      okScreen && JSON.stringify(sc.rules) === JSON.stringify(g.rules.slice(0, 3));
    const okName = okScreen && sc.gameName === g.name;
    const okSlogan = okScreen && sc.slogan === g.slogan;
    if (!(okScreen && okRules && okName && okSlogan)) {
      ok(false, `${g.name}：选完游戏规则卡上屏`, {
        type: sc.type,
        gameName: sc.gameName,
        rules: sc.rules,
      });
      continue;
    }

    const pvOk = pv.type === 'rules' && JSON.stringify(pv.rules) === JSON.stringify(g.rules);

    ok(true, `${g.name}：大屏规则卡（名 / 口号 / 3 条）`);
    ok(pvOk, `${g.name}：玩家手机上也是同一份 3 条`, pv.type);
    ok(
      hp.brief && hp.brief.gameId === id && JSON.stringify(hp.brief.rules) === JSON.stringify(g.rules),
      `${g.name}：主持台上摆的是同一份字`
    );
  }

  /* ------------------------------------------------ 三、二维码还在 */
  await host('game/select', { id: 'undercover' });
  const scQr = await screen();
  ok(scQr.type === 'rules' && scQr.qr === true, '规则卡上带二维码标记（后到的人还能扫）', scQr.qr);
  ok(typeof scQr.online === 'number' && typeof scQr.count === 'number', '规则卡上有在场人数');

  /* ------------------------------------------------ 四、开局就收起 */
  for (const id of ids) {
    const g = GAMES[id];
    const s = STARTER[id];
    if (!s) {
      ok(false, `${g.name}：测试里没写「怎么开始」`);
      continue;
    }
    await host('game/select', { id });
    let before = await screen();
    if (before.type !== 'rules') {
      ok(false, `${g.name}：开局前规则卡没上屏`, before.type);
      continue;
    }
    const body = { cmd: 'game/act', action: s.action };
    if (s.target && players[0]) body.targetId = players[0].id;
    const r = await api('/api/host', body);
    const after = await screen();
    if (r.data && r.data.error) {
      // 开不了局（人不够 / 没音效）不算错，但规则卡也不该自己偷跑
      ok(after.type === 'rules', `${g.name}：开局失败时规则卡还在`, r.data.error);
      continue;
    }
    ok(after.type !== 'rules', `${g.name}：一开局规则卡就收起`, after.type);
  }

  /* ------------------------------------------------ 五、配置动作不算开始 */
  await host('game/select', { id: 'undercover' });
  await host('game/act', { action: 'host_mode', mode: 'blank' });
  ok((await screen()).type === 'rules', '开局前改玩法，规则卡不被收掉');
  await host('game/act', { action: 'host_pack', packId: 'undercover_food' });
  ok((await screen()).type === 'rules', '开局前换词库，规则卡不被收掉');
  await host('game/act', { action: 'host_count', count: 2 });
  ok((await screen()).type === 'rules', '开局前改卧底人数，规则卡不被收掉');

  /* ------------------------------------------------ 六、手动上屏 / 收起 */
  const show = await host('brief/show');
  ok(!show.data.error && (await screen()).type === 'rules', '能手动把规则卡重新打上屏');
  const hide = await host('brief/hide');
  ok(!hide.data.error && (await screen()).type !== 'rules', '能手动收起来');
  await host('brief/show');
  ok((await screen()).type === 'rules', '收起后还能再上屏（新来的两个人要听）');

  /* ------------------------------------------------ 七、换游戏要跟着换 */
  await host('game/select', { id: 'relay' });
  const a = await screen();
  await host('game/select', { id: 'werewolf' });
  const b = await screen();
  ok(a.gameName === '传声筒' && b.gameName === '狼人杀', '换游戏后规则卡跟着换', {
    a: a.gameName,
    b: b.gameName,
  });
  ok(
    JSON.stringify(a.rules) !== JSON.stringify(b.rules),
    '换游戏后规则文字确实换了（不是卡住不刷新）'
  );

  /* ------------------------------------------------ 八、不泄密 */
  await host('game/select', { id: 'undercover' });
  const sc2 = JSON.stringify(await screen());
  ok(!/卧底词|身份|wordOf|同伙/.test(sc2), '规则卡上没有身份 / 词这类私密字段');
  ok(!/白板那位的词卡/.test(sc2), '规则卡不带内部实现说明');

  /* 玩家手机上的规则卡也不许带身份 */
  const pv2 = await view(players[0].id);
  ok(pv2.type === 'rules' && !/同伙|你是卧底|白板/.test(JSON.stringify(pv2)), '玩家规则卡不按身份变样');

  /* ------------------------------------------------ 九、重置后不残留 */
  await host('room/reset');
  const sc3 = await screen();
  ok(sc3.type !== 'rules', '整场重置后规则卡不残留', sc3.type);

  await host('room/kickAll');
  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n  崩了：', e && e.stack);
  process.exit(1);
});
