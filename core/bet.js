'use strict';

/* 围观下注 —— 给「没在局里」的人一件事做。
 *
 * 现场最尴尬的不是输，是坐在那儿看别人玩。狼人杀死得早、卧底被投出去、
 * 人比座位多的时候，这些人的手机就是一块砖。下注把「干看」变成
 * 「有立场」：谁赢我押了钱，我就盯得住屏幕。
 *
 * 分数单独记在 player.betScore，不混进正赛分 —— 押对了不代表你玩得好，
 * 也不该影响谁拿 MVP。大屏和复盘里分开显示。
 */

const HIT_SCORE = 2;

function blank() {
  return { open: false, period: 0, picks: {}, winnerId: null, settledAt: 0, hits: [], winnerName: '' };
}

function open(room) {
  const period = (room.bet && room.bet.period ? room.bet.period : 0) + 1;
  // 开新一轮就把上一轮的押注清掉，别让上一局押的人白占着位置
  room.bet = { open: true, period, picks: {}, winnerId: null, settledAt: 0, hits: [], winnerName: '' };
  return { ok: true, period };
}

function pick(room, pid, targetId) {
  if (!room.bet || !room.bet.open) return { error: '现在没开下注' };
  const p = room.players.find((x) => x.id === pid);
  const t = room.players.find((x) => x.id === targetId);
  if (!p) return { error: '没这个人' };
  if (!t) return { error: '先点一个名字' };
  if (pid === targetId) return { error: '不能押自己' };
  // 结算前可以改，改了几次都算最后那一次 —— 现场就是会反悔
  room.bet.picks[pid] = targetId;
  return { ok: true, name: t.name };
}

function settle(room, winnerId) {
  if (!room.bet || !room.bet.open) return { error: '现在没开下注' };
  const w = room.players.find((x) => x.id === winnerId);
  if (!w) return { error: '先在左边点一个赢家' };

  const hits = [];
  for (const pid of Object.keys(room.bet.picks)) {
    if (room.bet.picks[pid] !== winnerId) continue;
    const p = room.players.find((x) => x.id === pid);
    if (!p) continue;
    p.betScore = (p.betScore || 0) + HIT_SCORE;
    hits.push(p.name);
  }

  room.bet.open = false;
  room.bet.winnerId = winnerId;
  room.bet.winnerName = w.name;
  room.bet.settledAt = Date.now();
  room.bet.hits = hits;
  return { ok: true, winner: w.name, hits, n: Object.keys(room.bet.picks).length };
}

function cancel(room) {
  room.bet = blank();
  return { ok: true };
}

function state(room) {
  const b = room.bet || blank();
  return {
    open: !!b.open,
    period: b.period || 0,
    n: Object.keys(b.picks || {}).length,
    winnerId: b.winnerId || null,
    winnerName: b.winnerName || '',
    hits: (b.hits || []).slice(0, 12),
    settled: !b.open && !!b.settledAt,
  };
}

/* 7：结算完之后把面板清回「可以再开」的状态，
 * 不然那一行只剩下「再开一轮」，看着像死路。 */
function clear(room) {
  room.bet = blank();
  return { ok: true };
}

module.exports = { open, pick, settle, cancel, clear, state, blank, HIT_SCORE };
