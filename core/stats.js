'use strict';

/* 每局留一条记录，散场后拿出来看。
 *
 * 记的都是系统本来就在算的数（分数、动作次数、押注命中），
 * 不新增采集点 —— 现场没有第二个人去点「记录一下」。
 *
 * 只留最近 30 局：一晚上玩不到 30 局，多了占内存，还会把
 * 「今晚」和「上个月那次」混在一起。
 */

const KEEP = 30;

function record(room, info) {
  const it = info || {};
  const entry = {
    at: Date.now(),
    gameId: it.gameId || room.gameId || '',
    name: it.name || '',
    ms: Math.max(0, Number(it.ms) || 0),
    players: (room.players || []).map((p) => ({
      name: p.name,
      score: p.score || 0,
      bet: p.betScore || 0,
      act: p.actN || 0,
    })),
  };
  if (!Array.isArray(room.history)) room.history = [];
  room.history.push(entry);
  while (room.history.length > KEEP) room.history.shift();
  return entry;
}

/* 汇总：按人算「参与度」，按局列「玩了什么」。
 * 参与度 = 出场局数 + 平均动作次数，用来看出谁整晚都在状态里。 */
function review(room) {
  const hist = Array.isArray(room.history) ? room.history : [];
  const people = {};
  for (const g of hist) {
    for (const p of g.players || []) {
      const k = p.name;
      if (!people[k]) people[k] = { name: k, plays: 0, score: 0, bet: 0, act: 0, best: 0 };
      people[k].plays += 1;
      people[k].score += p.score;
      people[k].bet += p.bet;
      people[k].act += p.act;
      if (p.score > people[k].best) people[k].best = p.score;
    }
  }
  const list = Object.keys(people).map((k) => {
    const x = people[k];
    return {
      name: x.name,
      plays: x.plays,
      score: x.score,
      bet: x.bet,
      act: x.act,
      avgAct: x.plays ? Math.round((x.act / x.plays) * 10) / 10 : 0,
      best: x.best,
    };
  });
  list.sort((a, b) => b.score - a.score || b.act - a.act);

  const games = hist.map((g) => ({
    at: g.at,
    name: g.name,
    gameId: g.gameId,
    mins: Math.round((g.ms || 0) / 60000),
    plays: (g.players || []).length,
    total: (g.players || []).reduce((a, p) => a + (p.score || 0), 0),
    top: (g.players || []).slice().sort((a, b) => b.score - a.score).slice(0, 3),
  }));

  return {
    games,
    people: list,
    count: hist.length,
    totalMs: hist.reduce((a, g) => a + (g.ms || 0), 0),
  };
}

/* 导出 CSV。给的是「一场一场」的明细，不是汇总 ——
 * 汇总在界面里已经看得到，导出去是为了留档和发群里。 */
function toCsv(room) {
  const hist = Array.isArray(room.history) ? room.history : [];
  const rows = [['时间', '游戏', '时长(分)', '玩家', '得分', '押注分', '动作次数']];
  for (const g of hist) {
    const t = new Date(g.at);
    const stamp =
      `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ` +
      `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    const mins = Math.round((g.ms || 0) / 60000);
    const ps = g.players || [];
    if (!ps.length) rows.push([stamp, g.name, mins, '', '', '', '']);
    for (const p of ps) {
      rows.push([stamp, g.name, mins, p.name, p.score, p.bet, p.act]);
    }
  }
  // 逗号、引号、换行都得包起来，名字里出现逗号很常见
  return rows
    .map((r) =>
      r
        .map((c) => {
          const s = String(c == null ? '' : c);
          return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        })
        .join(',')
    )
    .join('\n');
}

module.exports = { record, review, toCsv, KEEP };
