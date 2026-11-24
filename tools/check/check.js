'use strict';

/* 启动自检：语法 + 插件接口 + 词库格式。
 * 之前那个项目就是因为主持台里多了一行 `let es`，整段脚本不执行、现场全废。
 * 跑这个能在开会前 3 秒发现问题。 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '../..');
let errors = 0;
let checked = 0;

function fail(msg) {
  errors += 1;
  console.log('  ✗ ' + msg);
}

function checkJs(file) {
  const src = fs.readFileSync(file, 'utf8');
  checked += 1;
  try {
    new vm.Script(src, { filename: file });
  } catch (e) {
    fail(`${path.relative(ROOT, file)} → ${e.message}`);
  }
}

function checkHtml(file) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let i = 0;
  while ((m = re.exec(src))) {
    i += 1;
    checked += 1;
    const code = m[1];
    try {
      new vm.Script(code, { filename: `${file}#inline${i}` });
    } catch (e) {
      fail(`${path.relative(ROOT, file)} 内联脚本#${i} → ${e.message}`);
    }
  }
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

console.log('\n  自检 ─────────────────────────────');

const files = walk(ROOT);
for (const f of files) {
  if (f.endsWith('.js')) checkJs(f);
  else if (f.endsWith('.html')) checkHtml(f);
}

/* 插件接口 */
const gamesDir = path.join(ROOT, 'games');
const ids = new Set();
let gameCount = 0;
for (const d of fs.readdirSync(gamesDir, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const f = path.join(gamesDir, d.name, 'index.js');
  if (!fs.existsSync(f)) continue;
  try {
    const g = require(f);
    gameCount += 1;
    if (!g.id) fail(`${d.name}: 缺少 id`);
    if (!g.name) fail(`${d.name}: 缺少 name`);
    if (ids.has(g.id)) fail(`${d.name}: id 重复（${g.id}）`);
    ids.add(g.id);
    for (const fn of ['setup', 'playerView', 'hostView', 'screenView']) {
      if (typeof g[fn] !== 'function') fail(`${d.name}: 缺少 ${fn}()`);
    }
    /* 开局面板（规则卡）的内容就长在这两个字段上。
     * 缺了就是一张空卡，现场等于没有，所以当成插件接口的一部分来校验。
     * 字数上限是照着「站在三米外念得下来」定的，不是随手写的。 */
    const slogan = String(g.slogan || '').trim();
    if (!slogan) fail(`${d.name}: 缺少 slogan（投屏上那句口号）`);
    else if (slogan.length > 20) fail(`${d.name}: slogan 超过 20 字（${slogan.length}）`);
    if (!Array.isArray(g.rules) || g.rules.length !== 3) {
      fail(`${d.name}: rules 必须是 3 条（现在 ${Array.isArray(g.rules) ? g.rules.length : '没有'}）`);
    } else {
      g.rules.forEach((r, i) => {
        const t = String(r || '').trim();
        if (!t) fail(`${d.name}: rules[${i}] 是空的`);
        else if (t.length > 24) fail(`${d.name}: rules[${i}] 超过 24 字（${t.length}）`);
      });
    }
    if (g.actions) {
      for (const k of Object.keys(g.actions)) {
        if (typeof g.actions[k] !== 'function') fail(`${d.name}: actions.${k} 不是函数`);
      }
    }
    /* 主持脚本（H1）：要么不写（用通用兜底），写了就必须能念 ——
     * cue ≤8 字、say ≤40 字、都不许空。空着上现场的后果是提词器一片空白，
     * 主持人以为功能坏了。 */
    if (g.script !== undefined) {
      if (!Array.isArray(g.script) || !g.script.length) {
        fail(`${d.name}: script 必须是数组（没写就删掉这个字段）`);
      } else {
        g.script.forEach((it, i) => {
          const c = String((it && it.cue) || '').trim();
          const say = String((it && it.say) || '').trim();
          if (!c) fail(`${d.name}: script[${i}] 缺 cue`);
          else if (c.length > 8) fail(`${d.name}: script[${i}] 的 cue 超过 8 字（${c.length}）`);
          if (it && it.fx) {
            const fxLib = require('../../core/fx');
            if (!fxLib.isFx(it.fx)) fail(`${d.name}: script[${i}] 的 fx「${it.fx}」不在动作库里`);
          }
          if (!say) fail(`${d.name}: script[${i}] 缺 say`);
          else if (say.length > 40) fail(`${d.name}: script[${i}] 的 say 超过 40 字（${say.length}）`);
        });
      }
    }
    /* 自动推进是可选的，但一旦声明了就必须指向真动作 ——
     * 指错了主持台那颗「开自动」会一直发一个不存在的指令，
     * 现场表现是「打开了但什么都不发生」，最难查的那种。 */
    if (g.pacing) {
      const a = String(g.pacing.action || '');
      if (!a) fail(`${d.name}: pacing 缺少 action`);
      else if (!g.actions || typeof g.actions[a] !== 'function') {
        fail(`${d.name}: pacing.action（${a}）不是这个游戏的动作`);
      }
      const sec = Number(g.pacing.sec);
      if (!isFinite(sec) || sec < 5 || sec > 180) {
        fail(`${d.name}: pacing.sec 必须在 5–180 之间（现在 ${g.pacing.sec}）`);
      }
      if (!String(g.pacing.label || '').trim()) fail(`${d.name}: pacing 缺少 label`);
    }
  } catch (e) {
    fail(`${d.name}: 加载失败 → ${e.message}`);
  }
}

/* 词库 */
const packsDir = path.join(ROOT, 'packs');
let packCount = 0;
const packIds = new Set();

/* 一条词条长什么样，取决于词库类型。只查 items 有几个是不够的 ——
 * 少一个字段，现场就是发不出词、手机上一片空白。 */
function checkItem(type, it, where) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return fail(`${where}: 词条不是对象`);
  const has = (k) => typeof it[k] === 'string' && it[k].trim();
  if (type === 'pair') {
    if (!has('a') || !has('b')) fail(`${where}: 词对要有 a 和 b`);
    else if (it.a.trim() === it.b.trim()) fail(`${where}: 词对两个词一样（${it.a}）`);
  } else if (type === 'question') {
    if (!has('q')) fail(`${where}: 问题词库要用 q 字段`);
  } else if (!has('w')) {
    fail(`${where}: 词库要用 w 字段`);
  }
}

for (const f of fs.readdirSync(packsDir)) {
  // _custom.json 是主持台写出来的覆盖层，不是词库本身，结构完全不一样
  if (f.startsWith('_') || f.startsWith('.')) continue;
  if (!f.endsWith('.json')) continue;
  const full = path.join(packsDir, f);
  try {
    const p = JSON.parse(fs.readFileSync(full, 'utf8'));
    packCount += 1;
    if (!p.id || !p.name || !Array.isArray(p.items)) fail(`${f}: 缺少 id/name/items`);
    else {
      if (packIds.has(p.id)) fail(`${f}: id 重复（${p.id}）`);
      packIds.add(p.id);
      if (!['word', 'pair', 'question'].includes(p.type || 'word')) fail(`${f}: type 不认识（${p.type}）`);
      if (!p.items.length) fail(`${f}: 词条为空`);
      p.items.forEach((it, i) => checkItem(p.type || 'word', it, `${f}#${i + 1}`));
    }
  } catch (e) {
    fail(`${f}: JSON 解析失败 → ${e.message}`);
  }
}

/* 自定义覆盖层：主持台写出来的，坏了要能一眼看出来 */
const customFile = path.join(packsDir, '_custom.json');
if (fs.existsSync(customFile)) {
  try {
    const d = JSON.parse(fs.readFileSync(customFile, 'utf8'));
    const customIds = new Set();
    for (const p of Array.isArray(d.packs) ? d.packs : []) {
      if (!p || !p.id || !p.name) fail('_custom.json: 自建词库缺少 id/name');
      else if (!['word', 'pair', 'question'].includes(p.type)) fail(`_custom.json: ${p.id} 的 type 不认识`);
      else customIds.add(p.id);
    }
    for (const key of ['add']) {
      for (const id of Object.keys(d[key] || {})) {
        if (!packIds.has(id) && !customIds.has(id)) fail(`_custom.json: 追加到了不存在的词库（${id}）`);
        if (!Array.isArray(d[key][id])) fail(`_custom.json: ${id} 的 add 不是数组`);
      }
    }
    for (const id of Object.keys(d.hide || {})) {
      if (!packIds.has(id) && !customIds.has(id)) fail(`_custom.json: 屏蔽了不存在的词库（${id}）`);
    }
  } catch (e) {
    fail(`_custom.json: JSON 解析失败 → ${e.message}`);
  }
}

console.log(`  检查文件 ${checked} 个 · 游戏 ${gameCount} 个 · 词库 ${packCount} 个`);
if (errors) {
  console.log(`  ✗ ${errors} 个问题，先修完再开场\n`);
  process.exit(1);
}
console.log('  ✓ 全部通过\n');
