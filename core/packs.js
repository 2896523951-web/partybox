'use strict';

/* 词库层。
 *
 * 内置词库是 packs/*.json，只读 —— 那几个文件以后还要维护，
 * 现场在主持台加的词如果直接写进去，下次更新就被覆盖或搞乱了。
 * 所以主持台的增删全部落在一个「覆盖层」文件 packs/_custom.json 里：
 *
 *   {
 *     "packs": [ { id, name, type } ],       // 自己新建的词库
 *     "add":   { 词库id: [ 词条, ... ] },     // 往任意词库追加的词
 *     "hide":  { 词库id: [ 词条文本, ... ] }  // 从内置词库里屏蔽掉的词
 *   }
 *
 * 读取时把三层叠起来（内置 → 屏蔽 → 追加），上层永远不动下层。
 * 这样「删掉内置的一个词」只是记一笔屏蔽，随时能「恢复默认」。
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'packs');
const CUSTOM_FILE = path.join(DIR, '_custom.json');
const cache = new Map();

const TYPES = ['word', 'pair', 'question'];

// 现场手滑粘贴一整篇文章的情况要挡住，不然词库里全是没法用的词条
const LIMITS = {
  packs: 30,
  items: 500,
  name: 20,
  word: 20,
  hint: 30,
  question: 60,
};

/* ------------------------------------------------------------ 读 */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`  ⚠ 词库读取失败：${path.basename(file)}（${e.message}）`);
    return null;
  }
}

// packs/custom.csv 每行「词,提示」，允许带表头，允许 # 注释
function readCsv(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    return null;
  }
  const items = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const [w, hint] = s.split(',');
    const word = (w || '').trim();
    if (!word || /^(词|词语|word)$/i.test(word)) continue;
    items.push({ w: word, hint: (hint || '').trim() });
  }
  if (!items.length) return null;
  return { id: 'custom', name: '自定义', type: 'word', items };
}

function emptyCustom() {
  return { packs: [], add: {}, hide: {} };
}

function readCustom() {
  const out = emptyCustom();
  let d = null;
  try {
    d = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8'));
  } catch (e) {
    // 第一次启动时还没有这个文件，这是正常的，不用报
    if (e.code !== 'ENOENT') console.log(`  ⚠ 自定义词库读取失败（${e.message}）`);
    return out;
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return out;
  const seen = new Set();
  for (const p of Array.isArray(d.packs) ? d.packs : []) {
    const id = String((p && p.id) || '').trim();
    if (!id || seen.has(id) || !TYPES.includes(p.type)) continue;
    seen.add(id);
    out.packs.push({ id, name: String(p.name || id).slice(0, LIMITS.name), type: p.type });
  }
  for (const key of ['add', 'hide']) {
    const src = d[key];
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const k of Object.keys(src)) {
      if (Array.isArray(src[k])) out[key][k] = src[k];
    }
  }
  return out;
}

// 原子写：先写 .tmp 再 rename。词库是现场资产，写坏一次就全废
function writeCustom(d) {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CUSTOM_FILE + '.tmp', JSON.stringify(d, null, 2));
  fs.renameSync(CUSTOM_FILE + '.tmp', CUSTOM_FILE);
}

/* ------------------------------------------------------ 词条工具 */

// 归一化：只用来比「是不是同一个词」，不改变显示内容
function norm(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function keyOf(it) {
  if (!it || typeof it !== 'object') return '';
  if (it.a != null && it.b != null) return `${it.a}|${it.b}`;
  return String(it.w != null ? it.w : it.q != null ? it.q : '');
}

function itemText(it) {
  return it.w || it.a || it.q || JSON.stringify(it);
}

/* 把主持台填进来的字段整成一条合法词条。抛出的消息是给主持人看的，要说人话。 */
function normalizeItem(type, input) {
  const inp = input && typeof input === 'object' ? input : {};
  const text = (v, max, label, required) => {
    const x = String(v == null ? '' : v)
      .replace(/\s+/g, ' ')
      .trim();
    if (!x) {
      if (required) throw new Error(`${label}不能空着`);
      return '';
    }
    if (x.length > max) throw new Error(`${label}最多 ${max} 个字（现在 ${x.length} 个）`);
    return x;
  };

  if (type === 'word') {
    return { w: text(inp.w, LIMITS.word, '词', true), hint: text(inp.hint, LIMITS.hint, '提示', false) };
  }
  if (type === 'pair') {
    const a = text(inp.a, LIMITS.word, '第一个词', true);
    const b = text(inp.b, LIMITS.word, '第二个词', true);
    if (norm(a) === norm(b)) throw new Error('两个词不能一样，不然卧底一眼就看出来了');
    return { a, b };
  }
  if (type === 'question') {
    return { q: text(inp.q, LIMITS.question, '问题', true) };
  }
  throw new Error('词库类型不对');
}

/* ------------------------------------------------------------ 装载 */

function loadAll() {
  cache.clear();
  const custom = readCustom();

  // 1. 内置（含 csv）
  const builtin = new Map();
  if (fs.existsSync(DIR)) {
    for (const f of fs.readdirSync(DIR)) {
      if (f.startsWith('_') || f.startsWith('.')) continue; // _custom.json 不是词库
      const full = path.join(DIR, f);
      let pack = null;
      if (f.endsWith('.json')) pack = readJson(full);
      else if (f.endsWith('.csv')) pack = readCsv(full);
      if (!pack || !pack.id || !Array.isArray(pack.items) || !pack.items.length) continue;
      pack.name = pack.name || pack.id;
      pack.type = pack.type || 'word';
      builtin.set(pack.id, pack);
    }
  }

  // 2. 内置，扣掉被屏蔽的词。内置排在前面 —— 主持台默认选中第一个，
  //    刚建的空词库抢到第一位的话，一打开就是「这个词库是空的」。
  const customIds = new Set(custom.packs.map((p) => p.id));
  for (const [id, pack] of builtin) {
    const hide = new Set((custom.hide[id] || []).map(norm));
    const items = hide.size ? pack.items.filter((it) => !hide.has(norm(keyOf(it)))) : pack.items.slice();
    cache.set(id, {
      id,
      name: pack.name,
      type: pack.type,
      items,
      custom: customIds.has(id),
      builtinCount: items.length,
      hiddenCount: pack.items.length - items.length,
      ownCount: 0,
    });
  }

  // 3. 自己建的词库（空着也要留着，不然刚起名就找不到了）
  for (const cp of custom.packs) {
    if (builtin.has(cp.id)) continue; // 跟内置撞 id 就不新建，往内置里追加
    cache.set(cp.id, { id: cp.id, name: cp.name, type: cp.type, items: [], custom: true });
  }

  // 4. 追加层
  for (const id of Object.keys(custom.add)) {
    const pack = cache.get(id);
    if (!pack) continue;
    const seen = new Set(pack.items.map((it) => norm(keyOf(it))));
    let own = 0;
    for (const it of custom.add[id]) {
      const k = norm(keyOf(it));
      if (!k || seen.has(k)) continue;
      seen.add(k);
      pack.items.push(it);
      own += 1;
    }
    pack.ownCount = own;
  }

  for (const pack of cache.values()) {
    if (pack.builtinCount == null) pack.builtinCount = 0;
    if (pack.ownCount == null) pack.ownCount = 0;
    if (pack.hiddenCount == null) pack.hiddenCount = 0;
  }

  return [...cache.values()];
}

function list(type) {
  if (!cache.size) loadAll();
  const all = [...cache.values()];
  return type ? all.filter((p) => p.type === type) : all;
}

/* 游戏侧用这个：空词库（刚建好还没加词的那种）不要出现在下拉里 ——
 * 选中它等于这一局出不来词。主持台那边的列表仍然用 list() 全量。 */
function usable(type) {
  const all = list(type).filter((p) => p.items.length);
  return all.length ? all : list(type);
}

function get(id) {
  if (!cache.size) loadAll();
  return cache.get(id) || null;
}

/* --------------------------------------------------------- 写操作 */

function requirePack(id) {
  const pack = get(id);
  if (!pack) throw new Error('没有这个词库');
  return pack;
}

// 建一个新词库（只建壳，词条另外加）
function createPack(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const d = readCustom();
  if (d.packs.length >= LIMITS.packs) throw new Error(`自己建的词库最多 ${LIMITS.packs} 个`);

  const name = String(inp.name == null ? '' : inp.name)
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) throw new Error('给词库起个名字');
  if (name.length > LIMITS.name) throw new Error(`名字最多 ${LIMITS.name} 个字`);

  const type = String(inp.type || 'word');
  if (!TYPES.includes(type)) throw new Error('词库类型不对');
  if (list().some((p) => p.name === name)) throw new Error(`已经有叫「${name}」的词库了`);

  const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  d.packs.push({ id, name, type });
  writeCustom(d);
  loadAll();
  return get(id);
}

// 往词库里加一条。内置词库也能加，落进 add 层。
function addItem(packId, input) {
  const pack = requirePack(packId);
  const d = readCustom();
  const it = normalizeItem(pack.type, input);
  const key = norm(keyOf(it));

  if (keyOf(it) === '') throw new Error('词条是空的');
  if (pack.items.some((x) => norm(keyOf(x)) === key)) throw new Error('这个词库里已经有了');
  if (pack.items.length >= LIMITS.items) throw new Error(`一个词库最多 ${LIMITS.items} 条`);

  if (!Array.isArray(d.add[packId])) d.add[packId] = [];
  d.add[packId].push(it);
  // 之前屏蔽过同一个词的话，这次加回来就把屏蔽撤掉
  if (Array.isArray(d.hide[packId])) {
    d.hide[packId] = d.hide[packId].filter((x) => norm(x) !== key);
    if (!d.hide[packId].length) delete d.hide[packId];
  }
  writeCustom(d);
  loadAll();
  return { item: it, pack: get(packId) };
}

/* 删一条。
 * 自己加的 → 从 add 层真删；
 * 内置的   → 记进 hide 层（文件不动，随时能恢复默认）。 */
function removeItem(packId, key) {
  const pack = requirePack(packId);
  const d = readCustom();
  const k = norm(key);
  if (!k) throw new Error('要删哪一条？');

  const own = Array.isArray(d.add[packId]) ? d.add[packId] : [];
  const kept = own.filter((it) => norm(keyOf(it)) !== k);
  const removedOwn = kept.length !== own.length;
  if (removedOwn) {
    if (kept.length) d.add[packId] = kept;
    else delete d.add[packId];
  }

  let removedBuiltin = false;
  if (!removedOwn && pack.builtinCount > 0) {
    const hit = pack.items.some((it) => norm(keyOf(it)) === k);
    if (hit) {
      if (!Array.isArray(d.hide[packId])) d.hide[packId] = [];
      if (!d.hide[packId].some((x) => norm(x) === k)) d.hide[packId].push(String(key));
      removedBuiltin = true;
    }
  }
  if (!removedOwn && !removedBuiltin) throw new Error('没找到这个词');

  writeCustom(d);
  loadAll();
  return { pack: get(packId), removedBuiltin };
}

// 只能删自己建的词库；内置的只能恢复默认，不能删
function removePack(id) {
  const d = readCustom();
  const i = d.packs.findIndex((p) => p.id === id);
  if (i < 0) throw new Error('内置词库不能删，只能「恢复默认」');
  d.packs.splice(i, 1);
  delete d.add[id];
  delete d.hide[id];
  writeCustom(d);
  loadAll();
  return { ok: true };
}

/* 恢复：把自己加的、自己屏蔽的都清掉。
 * 内置词库 = 回到出厂状态；自建词库 = 清空所有词（壳留着）。 */
function resetPack(id) {
  const pack = requirePack(id);
  const d = readCustom();
  delete d.add[id];
  delete d.hide[id];
  writeCustom(d);
  loadAll();
  return { pack: get(id), wasCustom: !!pack.custom };
}

/* 给主持台看的一份快照：哪些是自己加的、哪些是内置的 */
function detail(id) {
  const pack = requirePack(id);
  const d = readCustom();
  const ownKeys = new Set((d.add[id] || []).map((it) => norm(keyOf(it))));
  return {
    id: pack.id,
    name: pack.name,
    type: pack.type,
    custom: !!pack.custom,
    total: pack.items.length,
    ownCount: pack.ownCount || 0,
    hiddenCount: pack.hiddenCount || 0,
    limits: LIMITS,
    items: pack.items.map((it) => ({
      w: it.w,
      hint: it.hint,
      a: it.a,
      b: it.b,
      q: it.q,
      own: ownKeys.has(norm(keyOf(it))),
    })),
  };
}

/* ------------------------------------------------------------ 取词 */

// 取一条随机题。exclude 里是刚用过的词，避免连着出同一道。
function pick(id, exclude) {
  let pack = get(id);
  // 词库被清空了但游戏还指着它：别让整局都用兜底词，退到同类型第一个有词的
  if (!pack || !pack.items.length) {
    const pool = list(pack ? pack.type : undefined).filter((p) => p.items.length);
    if (pool.length) pack = pool[0];
  }
  if (!pack || !pack.items.length) return null;
  const pool = pack.items.filter((x) => !exclude || !exclude.has(itemText(x)));
  const arr = pool.length ? pool : pack.items;
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = {
  loadAll,
  list,
  usable,
  get,
  detail,
  pick,
  shuffle,
  itemText,
  keyOf,
  normalizeItem,
  createPack,
  addItem,
  removeItem,
  removePack,
  resetPack,
  LIMITS,
  TYPES,
  DIR,
  CUSTOM_FILE,
};
