'use strict';

/* 惩罚卡（方案 7.1）。
 *
 * 综艺模式不摆分数，收尾就得有别的记忆点。惩罚不是罚酒 ——
 * 是给全场一个「刚才那局结束了」的仪式，顺便把最安静的人推到台前。
 *
 * 十二条全是文案，没有一条要求道具、场地或体力。抽过的先不进池子，
 * 一轮抽完再洗牌 —— 连着抽到「唱一句」会让人以为程序坏了。
 */

const CARDS = [
  { id: 'sing', title: '唱一句', body: '随便一首，唱到副歌就行，跑调也是唱', sec: 8, bar: '唱一句，跑调就喝一口' },
  { id: 'praise', title: '夸三个人', body: '一人一句，必须具体到刚才做的事', sec: 10, bar: '夸三个人，被夸的喝' },
  { id: 'imitate', title: '学一个人', body: '学在场任何一个人的口头禅，被猜到就算过', sec: 8, bar: '学一个人，猜错的人喝' },
  { id: 'ad', title: '给输家打广告', body: '十秒，把他说成今晚的必需品', sec: 10, bar: '十秒广告，全场举杯' },
  { id: 'pose', title: '定住五秒', body: '摆一个「刚赢了一百万」的姿势，不许笑', sec: 5, bar: '定住五秒，动了喝' },
  { id: 'story', title: '编一句台词', body: '用上一局的词，说一句电影台词', sec: 8, bar: '用上一局的词说台词，说不出来喝' },
  { id: 'apology', title: '对着镜头道歉', body: '为刚才某个操作道歉，理由要荒诞', sec: 8, bar: '道歉，理由越荒唐越好，全场表决过不过' },
  { id: 'rap', title: '说唱一句', body: '把今晚最好笑的一件事，用说唱讲完', sec: 10, bar: '说唱一句，卡住就喝' },
  { id: 'count', title: '数一遍人', body: '用方言数一遍在场人数，数错重来', sec: 10, bar: '用方言数人，数错重来，重来一次喝一口' },
  { id: 'toast', title: '敬一杯', body: '对着全场举杯，说一句祝酒词，十秒内说完', sec: 10, bar: '对全场说祝酒词，十秒内说完' },
  { id: 'secret', title: '说个秘密', body: '不用真的秘密，编一个能过审的就行', sec: 8, bar: '编一个能过审的秘密，被识破喝' },
  { id: 'slowmo', title: '慢动作走三步', body: '像电影慢镜头一样走三步，全程别笑', sec: 6, bar: '慢动作走三步，笑场喝' },
];

function label(mode) {
  return MODES[mode] ? MODES[mode] : MODES.clean;
}

/* 两种口径（2026-11-21 加）：清爽是默认，酒桌是可选。
 * 只换说法，不换结构 —— 12 张卡、抽满才洗牌、不记分，全都不变。 */
const MODES = { clean: '清爽', bar: '酒桌' };

/* 自定义卡：和词库一样落在 packs/ 下的覆盖文件里，
 * 不写进这个模块 —— 现场加的东西不该混进代码。 */
const fs = require('fs');
const path = require('path');
const CUSTOM_FILE = path.join(__dirname, '..', 'packs', '_punish.json');
const LIMIT = { title: 8, body: 30, bar: 30, cards: 60 };
let custom = null;

function loadCustom() {
  if (custom) return custom;
  try {
    const raw = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8'));
    custom = Array.isArray(raw.cards) ? raw.cards : [];
  } catch (e) {
    custom = [];
  }
  return custom;
}

function saveCustom() {
  try {
    fs.writeFileSync(CUSTOM_FILE, JSON.stringify({ cards: custom }, null, 2), 'utf8');
  } catch (e) {
    console.log('  惩罚卡写盘失败：', e.message);
  }
}

function all() {
  return CARDS.concat(loadCustom());
}

function customList() {
  return loadCustom().map((c) => ({ id: c.id, title: c.title, body: c.body, bar: c.bar || '', sec: c.sec }));
}

function addCard(input) {
  const title = String((input && input.title) || '').trim().slice(0, LIMIT.title);
  const body = String((input && input.body) || '').trim().slice(0, LIMIT.body);
  if (!title || !body) return { error: '标题和说法都要填' };
  const bar = String((input && input.bar) || '').trim().slice(0, LIMIT.bar) || body;
  const sec = Math.min(20, Math.max(3, Math.round(Number(input && input.sec) || 8)));
  const list = loadCustom();
  if (list.length >= LIMIT.cards) return { error: '自定义卡到上限了' };
  const card = { id: 'c' + Date.now().toString(36), title, body, bar, sec };
  list.push(card);
  saveCustom();
  return { ok: true, card };
}

function removeCard(id) {
  const list = loadCustom();
  const i = list.findIndex((c) => c.id === String(id || ''));
  if (i < 0) return { error: '没有这张卡' };
  const [gone] = list.splice(i, 1);
  saveCustom();
  return { ok: true, id: gone.id };
}

function list(mode) {
  const m = MODES[mode] ? mode : 'clean';
  return all().map((c) => ({
    id: c.id,
    title: c.title,
    body: m === 'bar' ? (c.bar || c.body) : c.body,
    sec: c.sec,
  }));
}

function setMode(room, mode) {
  if (!MODES[mode]) return { error: '只有 clean / bar' };
  room.punishMode = mode;
  return { ok: true, mode, label: MODES[mode] };
}

function draw(room) {
  const st = room.punish || { seen: [] };
  const seen = Array.isArray(st.seen) ? st.seen : [];
  let pool = all().filter((c) => !seen.includes(c.id));
  // 一轮抽完，洗牌重来
  if (!pool.length) {
    pool = all();
    seen.length = 0;
  }
  const card = pool[Math.floor(Math.random() * pool.length)];
  // 整轮都留在 seen 里，抽满 12 张才洗牌 —— 裁到最近 5 张的话，
  // 第 6 张就可能撞回第 1 张，现场会以为程序坏了
  seen.push(card.id);
  room.punish = { card, at: Date.now(), seen };
  // 返回的是「这一张此刻该念的说法」，和投屏上的一致 ——
  // 主持台 toast 和投屏说两套话，现场最容易穿帮
  const m = MODES[room.punishMode] ? room.punishMode : 'clean';
  return {
    ok: true,
    card: { id: card.id, title: card.title, body: m === 'bar' ? card.bar : card.body, sec: card.sec },
  };
}

function view(room) {
  const st = room.punish;
  if (!st || !st.card) return null;
  const m = MODES[room.punishMode] ? room.punishMode : 'clean';
  // 卡片是有寿命的：过了自己那一档就不要再出现在快照里。
  // 否则刷新投屏会看到一张十秒前就该撤的卡，而且会一直盖着结算页。
  if (Date.now() - (st.at || 0) > (st.card.sec || 8) * 1000 + 800) return null;
  return {
    id: st.card.id,
    title: st.card.title,
    body: m === 'bar' ? (st.card.bar || st.card.body) : st.card.body,
    sec: st.card.sec,
    at: st.at,
    mode: m,
  };
}

module.exports = {
  CARDS,
  MODES,
  label,
  list,
  setMode,
  draw,
  view,
  customList,
  addCard,
  removeCard,
};
