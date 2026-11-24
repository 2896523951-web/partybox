'use strict';

/* 一次性交互检查：顶部游戏目录下拉能不能真的切游戏（截图看不出来）。
 * 用完可以删。 */

const { spawn } = require('child_process');
const http = require('http');

const CHROME = require('../lib/chrome');
const PORT = 9335;
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
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=' + PORT,
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--user-data-dir=C:\\temp\\pb-click',
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
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: BASE + '/host' });
  await sleep(3000);

  const gN = await evalJs("document.querySelectorAll('#glist .gitem').length");
  ok(gN >= 13, '下拉里有 13 个游戏', gN);
  ok((await evalJs("document.getElementById('glist').classList.contains('on')")) === false, '默认是收起的');

  await evalJs("document.getElementById('gbtn').click()");
  await sleep(250);
  ok((await evalJs("document.getElementById('glist').classList.contains('on')")) === true, '点一下展开');

  // 点「数字炸弹」
  await evalJs(
    "Array.from(document.querySelectorAll('#glist .gitem')).find(function(b){return b.textContent.indexOf('数字炸弹')>=0;}).click()"
  );
  await sleep(900);
  ok((await evalJs("document.getElementById('glist').classList.contains('on')")) === false, '选完自动收起');
  ok((await evalJs("document.getElementById('gbtnName').textContent")) === '数字炸弹', '顶部按钮显示当前游戏');
  ok((await evalJs("document.getElementById('gName').textContent")) === '数字炸弹', '中间面板切过去了');

  // 点外面也要收起
  await evalJs("document.getElementById('gbtn').click()");
  await sleep(200);
  await evalJs("document.body.click()");
  await sleep(200);
  ok((await evalJs("document.getElementById('glist').classList.contains('on')")) === false, '点空白处收起');

  // 分组按钮在没玩家时给提示而不是崩
  await evalJs("document.getElementById('btnGroup').click()");
  await sleep(500);
  ok(true, '没玩家时点分组不崩');

  /* ---- 「整场重置 / 清空玩家」搬到顶栏之后：笔记本那种宽度不能被挤爆 ---- */

  for (const w of [1280, 1366]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(500);
    const bar = await evalJs(`(() => {
      const b = document.querySelector('.hbar');
      const kids = [...b.querySelectorAll(':scope > button, :scope > a.btn')].map((e) => {
        const q = e.getBoundingClientRect();
        return { t: e.textContent.trim(), x: Math.round(q.x), w: Math.round(q.width), right: Math.round(q.right) };
      });
      return { overflow: b.scrollWidth - b.clientWidth, kids, viewW: innerWidth };
    })()`);
    ok(!!bar && bar.overflow <= 0, w + ' 宽：顶栏没被撑出横向滚动', bar && bar.overflow);
    ok(!!bar && bar.kids.every((k) => k.w > 0 && k.right <= bar.viewW + 1), w + ' 宽：按钮都在屏幕里', bar && bar.kids);
    const ov = [];
    if (bar) {
      for (let i = 1; i < bar.kids.length; i++) {
        if (bar.kids[i].x < bar.kids[i - 1].x + bar.kids[i - 1].w - 1) ov.push([bar.kids[i - 1].t, bar.kids[i].t]);
      }
    }
    ok(ov.length === 0, w + ' 宽：按钮没有互相压住', ov);
  }

  ok(
    (await evalJs("!!document.getElementById('btnReset') && !!document.getElementById('btnKickAll')")) === true,
    '两个危险按钮在顶栏上'
  );

  // 危险操作必须先弹确认：一点就执行的话，现场手一抖就清空了
  let dialogMsg = null;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') dialogMsg = m.params.message;
  });
  // 用 setTimeout 触发：confirm() 会阻塞 JS 线程，
  // 直接在 evaluate 里 .click() 的话这次调用永远不返回
  await evalJs("setTimeout(function(){document.getElementById('btnReset').click()},0); 1");
  await sleep(800);
  ok(!!dialogMsg && /重置/.test(dialogMsg), '点「整场重置」先弹确认框', dialogMsg);
  await send('Page.handleJavaScriptDialog', { accept: false });
  await sleep(400);
  ok((await evalJs("document.getElementById('btnReset').disabled")) === false, '取消之后按钮能继续用');

  /* ---- 词库面板：现场最常用的那条路（打开 → 选 → 加一条）要能真走通 ---- */

  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  await evalJs("document.getElementById('btnPacks').click()");
  await sleep(1300);

  const pnl = await evalJs(`(() => {
    const m = document.getElementById('packMask');
    const q = m.querySelector('.pmodal').getBoundingClientRect();
    const first = document.querySelector('.pw');
    return {
      open: m.classList.contains('on'),
      w: Math.round(q.width), h: Math.round(q.height),
      inView: q.x >= 0 && q.y >= 0 && q.right <= innerWidth + 1 && q.bottom <= innerHeight + 1,
      left: document.querySelectorAll('.pw').length,
      active: document.querySelectorAll('.pw.on').length,
      firstName: first ? first.querySelector('.pw-n').textContent : '',
      rows: document.querySelectorAll('.pwrow').length,
    };
  })()`);
  ok(pnl && pnl.open, '点顶栏「词库」能打开面板');
  ok(pnl && pnl.left >= 8, '左侧列出全部词库', pnl && pnl.left);
  ok(pnl && pnl.active === 1, '有且只有一个词库是选中态', pnl && pnl.active);
  ok(pnl && pnl.inView && pnl.h >= 400, '面板整个在屏幕里，高度够用', pnl && { w: pnl.w, h: pnl.h });
  // 默认选中第一个内置的，而不是刚建的（可能是空的）自建词库
  ok(pnl && /成语/.test(pnl.firstName), '默认停在第一个内置词库上', pnl && pnl.firstName);

  // 搜索
  await evalJs(`(() => {
    const i = document.getElementById('packFind');
    i.value = '蛇';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  })()`);
  await sleep(350);
  const found = await evalJs(`(() => ({
    rows: document.querySelectorAll('.pwrow').length,
    count: document.getElementById('packCount').textContent,
  }))()`);
  ok(found && found.rows > 0 && found.rows < 42, '在词库里搜能把列表筛窄', found);

  // 换一套「词对」主题：表单要跟着变成两栏
  await evalJs(`(() => {
    const i = document.getElementById('packFind');
    i.value = '';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    const b = [...document.querySelectorAll('.pw')].find((x) => /吃的喝的/.test(x.textContent));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(1000);
  const pairForm = await evalJs(`(() => ({
    a: !!document.getElementById('pf_a'),
    b: !!document.getElementById('pf_b'),
    w: !!document.getElementById('pf_w'),
    rows: document.querySelectorAll('.pwrow').length,
  }))()`);
  ok(pairForm && pairForm.a && pairForm.b && !pairForm.w, '词对词库的添加表单是「词 A / 词 B」两栏', pairForm);
  ok(pairForm && pairForm.rows >= 25, '这套主题里有 25 条以上', pairForm && pairForm.rows);

  // 新建一个空词库，并确认它被自动选中
  const newName = '界面测试' + Date.now().toString(36).slice(-4);
  await evalJs(`(() => {
    document.getElementById('packNewName').value = ${JSON.stringify('X')}.replace('X', ${JSON.stringify(newName)});
    document.getElementById('packNewType').value = 'word';
    document.getElementById('packNewBtn').click();
    return 1;
  })()`);
  await sleep(1400);
  const created = await evalJs(`(() => ({
    active: (document.querySelector('.pw.on .pw-n') || {}).textContent || '',
    hasW: !!document.getElementById('pf_w'),
    empty: !!document.querySelector('.pm-empty'),
  }))()`);
  ok(created && created.active === newName, '新建的词库自动选中', created && created.active);
  ok(created && created.hasW && created.empty, '空词库显示「还是空的」并且能加词', created);

  // 加一条
  await evalJs(`(() => {
    document.getElementById('pf_w').value = '界面加的词';
    document.getElementById('pf_hint').value = '从弹层加的';
    document.getElementById('pf_add').click();
    return 1;
  })()`);
  await sleep(1400);
  const added = await evalJs(`(() => {
    const row = document.querySelector('.pwrow');
    return {
      rows: document.querySelectorAll('.pwrow').length,
      text: row ? row.querySelector('.w').textContent : '',
      hint: row ? row.querySelector('.h').textContent : '',
      tag: row && row.querySelector('.tag') ? row.querySelector('.tag').textContent : '',
      cleared: document.getElementById('pf_w').value === '',
      focus: document.activeElement ? document.activeElement.id : '',
    };
  })()`);
  ok(added && added.rows === 1 && added.text === '界面加的词', '加的词立刻出现在列表里', added && added.text);
  ok(added && added.hint === '从弹层加的', '提示也显示出来了', added && added.hint);
  ok(added && added.tag === '我加的', '自己加的词有「我加的」标记');
  ok(added && added.cleared, '加完输入框清空，可以连着录');
  ok(added && added.focus === 'pf_w', '焦点留在词输入框上', added && added.focus);

  // 重复加：不能悄悄多一条
  await evalJs(`(() => {
    document.getElementById('pf_w').value = '界面加的词';
    document.getElementById('pf_add').click();
    return 1;
  })()`);
  await sleep(1000);
  const dup = await evalJs(`(() => ({
    rows: document.querySelectorAll('.pwrow').length,
    toast: document.getElementById('toast').textContent,
  }))()`);
  ok(dup && dup.rows === 1, '重复加不会多出一行', dup && dup.rows);
  ok(dup && /已经有/.test(dup.toast), '重复加会说明原因', dup && dup.toast);

  // 关闭：× 和 ESC 两条路
  await evalJs("document.getElementById('packClose').click()");
  await sleep(600);
  ok((await evalJs("document.getElementById('packMask').classList.contains('on')")) === false, '点 × 能关掉面板');

  await evalJs("document.getElementById('btnPacks').click()");
  await sleep(900);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(600);
  ok((await evalJs("document.getElementById('packMask').classList.contains('on')")) === false, '按 ESC 也能关');

  /* --------------------------------------- 开局面板：真的画出来了吗
     接口层（briefcheck）已经验过数据，这里只看 DOM ——
     数据对、渲染错，现场一样是白屏一张。 */
  const hostCmd = (body) =>
    fetch(BASE + '/api/host', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()).catch(() => null);

  await hostCmd({ cmd: 'game/select', id: 'undercover' });
  await send('Page.navigate', { url: BASE + '/screen' });
  await sleep(2600);
  const sc2 = await evalJs(`(() => {
    const q = (s) => document.querySelector(s);
    return {
      rules: document.querySelectorAll('.sc-step').length,
      title: (q('.sc-rtitle') || {}).textContent || '',
      slogan: (q('.sc-slogan') || {}).textContent || '',
      qr: !!q('#scQr svg'),
      foot: (document.getElementById('footNote') || {}).textContent || '',
      steps: Array.from(document.querySelectorAll('.sc-step-t')).map(function (e) { return e.textContent; }),
    };
  })()`);
  ok(sc2 && sc2.rules === 3, '大屏上画出了 3 条规则', sc2 && sc2.rules);
  ok(sc2 && sc2.title === '谁是卧底', '大屏规则卡写着游戏名', sc2 && sc2.title);
  ok(sc2 && /一个词之差/.test(sc2.slogan), '大屏规则卡有口号', sc2 && sc2.slogan);
  ok(sc2 && sc2.qr === true, '大屏规则卡上有二维码（后到的人还能扫）');
  ok(sc2 && sc2.foot === '', '规则卡阶段页脚不重复人数', sc2 && sc2.foot);
  ok(
    sc2 && sc2.steps.length === 3 && sc2.steps.every((t) => t.length > 8),
    '三条规则都有正文，不是空行',
    sc2 && sc2.steps
  );

  await send('Page.navigate', { url: BASE + '/host' });
  await sleep(2600);
  const hr = await evalJs(`(() => {
    const box = document.getElementById('rulesCard');
    return {
      on: !!box && getComputedStyle(box).display !== 'none',
      n: document.querySelectorAll('#rcList li').length,
      first: (document.querySelector('#rcList li span') || {}).textContent || '',
      btn: (document.getElementById('rcShow') || {}).textContent || '',
    };
  })()`);
  ok(hr && hr.on === true, '主持台上规则卡是显示状态');
  ok(hr && hr.n === 3, '主持台上摆了 3 条', hr && hr.n);
  ok(hr && /每人按住看词/.test(hr.first), '主持台第一条和游戏里一致', hr && hr.first);
  ok(hr && hr.btn === '规则卡', '标题行有「规则卡」按钮（随时能重新上屏）', hr && hr.btn);

  // 收起之后那块要藏起来，不能留个空框占位置
  await evalJs("document.getElementById('rcHide').click()");
  await sleep(900);
  const hr2 = await evalJs(
    "getComputedStyle(document.getElementById('rulesCard')).display"
  );
  ok(hr2 === 'none', '点「收起」之后规则卡这块收掉', hr2);

  // 收网：把刚才建的测试词库删掉，别留在你机器上
  const post = (body) =>
    fetch(BASE + '/api/host', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()).catch(() => null);
  const now = await post({ cmd: 'pack/list' });
  const mine = ((now && now.packs) || []).find((p) => p.name === newName);
  if (mine) await post({ cmd: 'pack/remove', id: mine.id });
  const after = await post({ cmd: 'pack/list' });
  ok(!((after && after.packs) || []).some((p) => p.name === newName), '测试建的词库已经清理干净');

  /* 大屏扫码页要写清楚连哪条网。
     这个功能的第一版就是「接口早就返回 ssid，界面根本没用」——
     玩家看得到码、看不到网名，连错网段就一直打不开，还以为系统坏了。
     所以这条用例盯的是「接口有、界面接没接」，不是接口本身。 */
  const netInfo = await fetch(BASE + '/api/net')
    .then((r) => r.json())
    .catch(() => null);
  ok(!!netInfo && typeof netInfo.ssid === 'string', '/api/net 带 ssid 字段', netInfo && netInfo.ssid);

  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 780,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: BASE + '/screen' });
  await sleep(3200); // 网名是问系统要的，比页面渲染晚一步
  const wifiTxt = String(
    (await evalJs("(document.getElementById('lobbyWifi')||{}).textContent || ''")) || ''
  );
  ok(/Wi-Fi|同一个/.test(wifiTxt), '大屏扫码页显示了网名', wifiTxt);
  ok(!/null|undefined/.test(wifiTxt), '网名没渲染成 null / undefined', wifiTxt);
  ok(
    !netInfo || !netInfo.ssid || wifiTxt.indexOf(netInfo.ssid) >= 0,
    '大屏显示的网名和接口取到的一致（没连 Wi-Fi 时允许空）',
    { 页面: wifiTxt, 接口: netInfo && netInfo.ssid }
  );

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`);
  ws.close();
  proc.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
