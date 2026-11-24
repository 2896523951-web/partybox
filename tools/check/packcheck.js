'use strict';

/* 词库检查：主持台加词这条链路的专项测试。
 *
 * 这个工具回答的是：
 *   · 在主持台加的词，重启之后还在不在？
 *   · 会不会把内置的 packs/*.json 改坏？
 *   · 空词库、超长词、重复词、类型不对的词，能不能挡住？
 *   · 加完词，游戏里真的会用上吗？
 *   · 玩家手机能不能偷偷改词库、能不能直接读题库？
 *
 * 会写 packs/_custom.json，跑完自动还原，不影响你真实加的词。
 *
 * 用法：先起服务，再
 *   BASE=http://127.0.0.1:3321 node tools/check/packcheck.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = process.env.BASE || 'http://127.0.0.1:3321';
const ROOT = path.join(__dirname, '../..');
const CUSTOM = path.join(ROOT, 'packs', '_custom.json');

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

// 带 Host 头模拟「玩家手机从局域网访问」
function rawPost(host_, p, body) {
  return new Promise((resolve) => {
    const u = new URL(BASE);
    const data = JSON.stringify(body || {});
    const req = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        path: p,
        method: 'POST',
        headers: { Host: host_, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', () => resolve(0));
    req.end(data);
  });
}

function rawGetAs(host_, p) {
  return new Promise((resolve) => {
    const u = new URL(BASE);
    const req = http.request({ host: u.hostname, port: u.port || 80, path: p, method: 'GET', headers: { Host: host_ } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}

// 子进程重新 require 一次 packs —— 等价于「重启服务后读到什么」
function reloadInChild() {
  const code = `
    const P = require(${JSON.stringify(path.join(ROOT, 'core', 'packs.js'))});
    P.loadAll();
    process.stdout.write(JSON.stringify(P.list().map(p => ({
      id: p.id, name: p.name, type: p.type, count: p.items.length, custom: !!p.custom,
    }))));
  `;
  const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  return JSON.parse(out);
}

let backup = null;

(async () => {
  console.log('\n  词库检查 ─────────────────────────');

  // 备份现场已有的自定义层，跑完原样放回去
  if (fs.existsSync(CUSTOM)) {
    backup = fs.readFileSync(CUSTOM, 'utf8');
  }

  const idiomBefore = fs.readFileSync(path.join(ROOT, 'packs', 'idiom.json'), 'utf8');

  /* ------------------------------------------------ 一、内置主题都在 */

  const l0 = await host('pack/list');
  const packs0 = (l0.data && l0.data.packs) || [];
  ok(packs0.length >= 8, '词库列表拿得到', packs0.length);

  const pairs = packs0.filter((p) => p.type === 'pair');
  ok(pairs.length >= 5, '谁是卧底有 5 套以上主题可选', pairs.map((p) => p.name));
  ok(
    ['综合', '吃的喝的', '影视综艺', '人物角色', '日常用品'].every((k) => pairs.some((p) => p.name.includes(k))),
    '五个主题都在（综合 / 吃的喝的 / 影视综艺 / 人物角色 / 日常用品）',
    pairs.map((p) => p.name)
  );
  ok(pairs.every((p) => p.count >= 25), '每套主题都有 25 对以上', pairs.map((p) => p.count));
  ok(new Set(packs0.map((p) => p.name)).size === packs0.length, '没有重名的词库');

  /* ------------------------------------------------ 二、建词库 */

  const cn = '测试词库' + Date.now().toString(36).slice(-4);
  const c1 = await host('pack/create', { name: cn, type: 'word' });
  ok(c1.data && c1.data.ok && c1.data.id, '能新建一个 word 词库', c1.data);
  const cid = c1.data && c1.data.id;
  ok(c1.data && c1.data.custom === true, '新建的标成了「自己建的」');
  ok(c1.data && c1.data.items.length === 0, '新词库是空的');

  const c2 = await host('pack/create', { name: cn, type: 'word' });
  ok(c2.data && /已经有/.test(c2.data.error || ''), '重名不给建');
  const c3 = await host('pack/create', { name: '', type: 'word' });
  ok(c3.data && c3.data.error, '没名字不给建');
  const c4 = await host('pack/create', { name: '瞎写类型', type: 'what' });
  ok(c4.data && /类型/.test(c4.data.error || ''), '类型不对不给建');

  /* ------------------------------------------------ 三、加词 */

  const a1 = await host('pack/item/add', { id: cid, w: '测试词甲', hint: '提示甲' });
  ok(a1.data && a1.data.ok, '能加一条词', a1.data);
  const a2 = await host('pack/item/add', { id: cid, w: '测试词乙' });
  ok(a2.data && a2.data.ok, '提示可以不填');

  const d1 = await host('pack/detail', { id: cid });
  ok(d1.data && d1.data.total === 2, '两条都进了词库', d1.data && d1.data.total);
  ok(d1.data && d1.data.items.length > 0 && d1.data.items.every((x) => x.own === true), '自己加的标了 own');
  ok(d1.data && (d1.data.items[0] || {}).hint === '提示甲', '提示存下来了');

  const a3 = await host('pack/item/add', { id: cid, w: '测试词甲' });
  ok(a3.data && /已经有了/.test(a3.data.error || ''), '同一个词不给加两遍');
  const a4 = await host('pack/item/add', { id: cid, w: '   ', hint: 'x' });
  ok(a4.data && /不能空着/.test(a4.data.error || ''), '空词不给加');
  const a5 = await host('pack/item/add', { id: cid, w: '一'.repeat(21) });
  ok(a5.data && /最多 20 个字/.test(a5.data.error || ''), '超过 20 字的词不给加');
  const a6 = await host('pack/item/add', { id: cid, hint: '只有提示没有词' });
  ok(a6.data && a6.data.error, '只填提示不给加');

  /* ------------------------------------------------ 四、类型对不上要挡住 */

  const pr = await host('pack/create', { name: '测试词对' + cn, type: 'pair' });
  const pid = pr.data && pr.data.id;
  ok(!!pid, '能新建 pair 词库');

  const pa = await host('pack/item/add', { id: pid, a: '同', b: '同' });
  ok(pa.data && /不能一样/.test(pa.data.error || ''), '词对两个词一样要挡住');
  const pb = await host('pack/item/add', { id: pid, a: '甲对' });
  ok(pb.data && pb.data.error, '词对只填一半要挡住');
  const pc = await host('pack/item/add', { id: pid, a: '甲对', b: '乙对' });
  ok(pc.data && pc.data.ok, '词对能加', pc.data);

  // 往 pair 库塞一个 word 字段：a/b 空着，应该挡住
  const pd = await host('pack/item/add', { id: pid, w: '错字段' });
  ok(pd.data && pd.data.error, '给词对库传 word 字段要挡住');

  /* ------------------------------------------------ 五、删词 */

  const r1 = await host('pack/item/remove', { id: cid, key: '测试词甲' });
  ok(r1.data && r1.data.ok && r1.data.removedBuiltin === false, '删自己加的词是真删', r1.data);
  const d2 = await host('pack/detail', { id: cid });
  ok(d2.data && d2.data.total === 1, '删完少一条', d2.data && d2.data.total);

  const r2 = await host('pack/item/remove', { id: 'idiom', key: '画蛇添足' });
  ok(r2.data && r2.data.removedBuiltin === true, '删内置词走的是「屏蔽」', r2.data && r2.data.removedBuiltin);
  const dIdiom = await host('pack/detail', { id: 'idiom' });
  ok(dIdiom.data && !dIdiom.data.items.some((x) => x.w === '画蛇添足'), '屏蔽后词库里取不到');
  ok(dIdiom.data && dIdiom.data.hiddenCount === 1, 'hiddenCount 记了 1', dIdiom.data && dIdiom.data.hiddenCount);
  ok(
    fs.readFileSync(path.join(ROOT, 'packs', 'idiom.json'), 'utf8') === idiomBefore,
    '内置 idiom.json 一个字没动'
  );

  const r3 = await host('pack/item/remove', { id: 'idiom', key: '根本不存在的词' });
  ok(r3.data && /没找到/.test(r3.data.error || ''), '删不存在的词要报错');

  // 恢复默认：屏蔽和自加的都清掉，但自建词库本身留着
  const rs = await host('pack/reset', { id: 'idiom' });
  ok(rs.data && rs.data.ok, '恢复默认能跑');
  const dIdiom2 = await host('pack/detail', { id: 'idiom' });
  ok(dIdiom2.data && dIdiom2.data.items.some((x) => x.w === '画蛇添足'), '恢复默认后内置词回来了');
  ok(dIdiom2.data && dIdiom2.data.hiddenCount === 0, '恢复默认后 hiddenCount 归零');

  /* ------------------------------------------------ 六、删词库 */

  const del1 = await host('pack/remove', { id: 'idiom' });
  ok(del1.data && /内置词库不能删/.test(del1.data.error || ''), '内置词库删不掉');
  const del2 = await host('pack/remove', { id: cid });
  ok(del2.data && del2.data.ok, '自建词库能删');
  const after = await host('pack/list');
  ok(after.data && !after.data.packs.some((p) => p.id === cid), '删完列表里没有了');

  /* ------------------------------------------------ 七、落盘与重启 */

  const raw = JSON.parse(fs.readFileSync(CUSTOM, 'utf8'));
  ok(Array.isArray(raw.packs) && raw.packs.some((p) => p.id === pid), '自建词库落盘了', raw.packs);
  ok(raw.add && Array.isArray(raw.add[pid]) && raw.add[pid].length === 1, '词条落进 add 层', raw.add);

  const child = reloadInChild();
  ok(child.some((p) => p.id === pid && p.count === 1), '重新加载（等于重启服务）后词库和词条都还在', child.map((p) => p.id));
  ok(child.filter((p) => p.type === 'pair').length >= 5, '重启后主题数量不变');

  /* ------------------------------------------------ 八、权限：玩家改不了 */

  ok((await rawPost('192.168.1.5:3321', '/api/host', { cmd: 'pack/list' })) === 403, '局域网地址 + 没密钥：列词库 403');
  ok(
    (await rawPost('192.168.1.5:3321', '/api/host', { cmd: 'pack/item/add', id: 'idiom', w: '玩家偷加的' })) === 403,
    '局域网地址 + 没密钥：加词 403'
  );
  ok((await rawGetAs('192.168.1.5:3321', '/api/packs')) === 403, '局域网地址 + 没密钥：直接读题库 403');

  const badId = await host('pack/detail', { id: '' });
  ok(badId.status === 200 && badId.data && badId.data.error, '空 id 只报错，不崩');
  const noId = await host('pack/item/add', { id: 'nope', w: 'x' });
  ok(noId.data && /没有这个词库/.test(noId.data.error || ''), '往不存在的词库加词只报错');
  const nullBody = await host('pack/detail');
  ok(nullBody.status === 200, '不带参数也不 500');
  const alive = await api('/api/health');
  ok(alive.status === 200, '以上折腾完服务还活着');

  /* ------------------------------------------------ 九、加完词，游戏真的用上 */

  await host('room/kickAll');
  const P = [];
  for (const n of ['词甲', '词乙', '词丙', '词丁']) {
    const r = await api('/api/join', { name: n, headset: true });
    if (r.data && r.data.id) P.push(r.data);
  }
  ok(P.length === 4, '四个测试玩家进场', P.length);

  const uniq = '独特词' + Date.now().toString(36).slice(-3);
  const up = await host('pack/create', { name: '端到端对' + uniq, type: 'pair' });
  const upid = up.data && up.data.id;
  await host('pack/item/add', { id: upid, a: uniq + 'A', b: uniq + 'B' });

  await host('game/select', { id: 'undercover' });
  await host('game/act', { action: 'host_pack', packId: upid });
  const st = await host('game/start', {});
  ok(!st.data || !st.data.error, '换上新词库后能开局', st.data);

  const hs = await api('/api/state?role=host');
  const info = (hs.data && hs.data.panel && hs.data.panel.info) || [];
  const wordA = (info.find((x) => x.label === '平民词') || {}).value;
  const wordB = (info.find((x) => x.label === '卧底词') || {}).value;
  ok(wordA === uniq + 'A' && wordB === uniq + 'B', '发下去的词就是这个新词库里的', { wordA, wordB });

  // 换主题后，下拉里的条数跟着变
  const ctl = ((hs.data && hs.data.panel && hs.data.panel.controls) || []).find(
    (c) => c.kind === 'select' && c.name === 'packId'
  );
  ok(!!ctl, '谁是卧底主持台上有「词库」下拉');
  ok(
    ctl && ctl.options.some((o) => o.value === upid && /\(1\)|（1）/.test(o.label)),
    '下拉里能看到新词库，带条数',
    ctl && ctl.options.map((o) => o.label)
  );
  ok(ctl && ctl.options.filter((o) => /卧底 ·/.test(o.label)).length >= 4, '下拉里有 4 个以上主题', ctl && ctl.options.length);

  /* 新建的 word 词库要立刻出现在你画我猜的下拉里，不用重开服务 */
  const w1 = await host('pack/create', { name: '端到端词' + uniq, type: 'word' });
  const wid = w1.data && w1.data.id;
  await host('pack/item/add', { id: wid, w: uniq + '画' });
  await host('game/select', { id: 'drawguess' });
  const hs2 = await api('/api/state?role=host');
  const ctl2 = ((hs2.data && hs2.data.panel && hs2.data.panel.controls) || []).find(
    (c) => c.kind === 'select' && c.name === 'packId'
  );
  ok(ctl2 && ctl2.options.some((o) => o.value === wid), '刚建的 word 词库立刻进了你画我猜的下拉', ctl2 && ctl2.options.map((o) => o.value));
  ok(ctl2 && !ctl2.options.some((o) => o.value === upid), '词对（pair）词库不会混进你画我猜的下拉（类型隔离）');
  await host('pack/remove', { id: wid });

  // 空的 word 词库不该出现在你画我猜的下拉里（选中它等于这一局出不来词）
  const empty = await host('pack/create', { name: '空词库' + uniq, type: 'word' });
  const eid = empty.data && empty.data.id;
  const hs3 = await api('/api/state?role=host');
  const ctl3 = ((hs3.data && hs3.data.panel && hs3.data.panel.controls) || []).find(
    (c) => c.kind === 'select' && c.name === 'packId'
  );
  ok(ctl3 && !ctl3.options.some((o) => o.value === eid), '空词库不出现在游戏下拉里（只在主持台词库面板里）', ctl3 && ctl3.options.map((o) => o.value));
  await host('pack/remove', { id: eid });

  /* ------------------------------------------------ 收尾 */

  await host('pack/remove', { id: upid });
  await host('pack/remove', { id: pid });
  await host('room/kickAll');

  if (backup === null) {
    try {
      fs.unlinkSync(CUSTOM);
    } catch (e) {}
  } else {
    fs.writeFileSync(CUSTOM, backup);
  }
  // 让服务重新读一遍，别把测试残留留在内存里
  await host('pack/list');

  console.log(`\n  ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  if (backup === null) {
    try {
      fs.unlinkSync(CUSTOM);
    } catch (e2) {}
  } else {
    fs.writeFileSync(CUSTOM, backup);
  }
  process.exit(1);
});
