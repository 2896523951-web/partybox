'use strict';

/* 称号 —— 散场的时候，每人一个。
 *
 * 纯分数记不住人。一晚上过去，大家记得的是「那个一直装好人的」，
 * 不是「78 分那位」。所以收工时给每人贴一个标签，比排行榜更容易被
 * 拿出去讲。
 *
 * 只用系统本来就知道的东西算（总分 / 押注 / 点了多少次），
 * 不为称号改任何游戏的插件接口 —— 加了字段就得 14 个游戏一起改，
 * 改漏一个就永远评不上。
 */

/* list: [{ key, name, score, bet, act }] —— key 用来去重，
 * 本局用 pid，收工累计用名字（history 里存的是名字）。 */
/* 综艺模式只换说法，不换算法：分照算，只是「被记住的人」不再是分最高的那个。
 * 一半称号本来就是节目腔（神预言、静观其变），要换的只有两个。 */
const VARIETY_TITLE = {
  '今晚 MVP': '最佳搅局者',
  '最忙的一双手': '最强信念感',
};

function computeFrom(list, mode) {
  if (!list.length) return [];

  const out = [];
  const used = new Set();

  // 取某个指标最高的、还没被贴过标签的人
  const best = (key, min) => {
    let win = null;
    for (const x of list) {
      if (used.has(x.key)) continue;
      if (x[key] < min) continue;
      if (!win || x[key] > win[key]) win = x;
    }
    return win;
  };
  const assign = (p, title, why) => {
    used.add(p.key);
    out.push({ key: p.key, name: p.name, title, why, score: p.score, bet: p.bet, act: p.act });
  };

  // 一人只能拿一个，所以顺序就是优先级：先给最有说服力的
  const label = (x) => (mode === 'variety' ? VARIETY_TITLE[x] || x : x);

  let w = best('score', 1);
  if (w) assign(w, label('今晚 MVP'), `总分 ${w.score}`);

  w = best('bet', 1);
  if (w) assign(w, '神预言', `押中拿到 ${w.bet} 分`);

  w = best('act', 3);
  if (w) assign(w, label('最忙的一双手'), `点了 ${w.act} 次`);

  /* 「静观其变」只给一个人。
   * 一开始写的是「所有 act 为 0 的人都给」，结果一局下来一半人是这个称号 ——
   * 人人都有等于人人都没有，称号就失去了「记住某个人」的意义。
   * 取动作最少的那一个，其余落到下面的通用称号里。 */
  let quiet = null;
  for (const x of list) {
    if (used.has(x.key)) continue;
    if (!quiet || x.act < quiet.act) quiet = x;
  }
  if (quiet && quiet.act <= 1) {
    assign(quiet, '静观其变', quiet.act ? `只点了 ${quiet.act} 次` : '一次都没动手');
  }

  const rest = list.filter((x) => !used.has(x.key));
  if (rest.length) {
    const avg = rest.reduce((a, x) => a + x.score, 0) / rest.length;
    for (const p of rest) {
      if (p.score >= avg && p.score > 0) assign(p, '稳定输出', `总分 ${p.score}`);
      else assign(p, '气氛组', p.score > 0 ? `总分 ${p.score}` : '分没拿到，人一直在');
    }
  }

  return out;
}

function compute(room) {
  const mode = room && room.mode;
  const list = (room.players || []).map((p) => ({
    key: p.id,
    name: p.name,
    score: p.score || 0,
    bet: p.betScore || 0,
    act: p.actN || 0,
  }));
  const out = computeFrom(list, mode);
  out.sort((a, b) => b.score - a.score);
  return out;
}

/* 收工榜：一晚上的累计，从 history 加出来。
 * 不能用 player.score —— 那是「这一局」的分，每局开头都会清零。 */
function cumulative(room) {
  const people = {};
  for (const g of room.history || []) {
    for (const p of g.players || []) {
      const k = p.name;
      if (!people[k]) people[k] = { key: k, name: k, score: 0, bet: 0, act: 0 };
      people[k].score += p.score || 0;
      people[k].bet += p.bet || 0;
      people[k].act += p.act || 0;
    }
  }
  const list = Object.keys(people).map((k) => people[k]);
  // 一局都没记过（比如刚开机就点收工）：退回到当前房间的人，全 0 分也认
  if (!list.length) {
    for (const p of room.players || []) {
      list.push({ key: p.name, name: p.name, score: p.score || 0, bet: p.betScore || 0, act: p.actN || 0 });
    }
  }
  const labeled = computeFrom(list, room.mode);
  return labeled
    .map((x) => Object.assign({}, x, { total: x.score + x.bet }))
    .sort((a, b) => b.total - a.total || b.score - a.score);
}

module.exports = { compute, computeFrom, cumulative };
