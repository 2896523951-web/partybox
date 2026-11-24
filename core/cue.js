'use strict';

/* 主持脚本 + 提词器（方案 H1 / H2）。
 *
 * 以前 show.js 只回答「今晚玩哪几个游戏」，不回答「这一局第三步该干嘛」。
 * 现场全靠主持人记：记得住就顺，记不住就卡在台上翻手机。
 *
 * 脚本写在 games/<id>/index.js 的 script 字段里 —— 跟着游戏走，
 * 删游戏目录时脚本一起消失，不留孤儿文件；core 只认字段、不认内容，
 * 所以「主干不出现游戏名」这条红线不用破。
 *
 * 没写脚本的游戏用一条通用三段式兜底，保证 13 个游戏都能跑，
 * 不会因为「没写台词」而不可用。
 */

const FALLBACK = [
  { cue: '开始', say: '规则讲完了，现在开始。', wait: true },
  { cue: '进行中', say: '看着场上，谁卡住就推一下。', wait: false },
  { cue: '结算', say: '这一局到这儿，抬头看大屏。', wait: true },
];

const CUE_MAX = 8;
const SAY_MAX = 40;

function norm(list) {
  return (list || [])
    .map((x, i) => ({
      at: Number(x && x.at) || i * 1000,
      cue: String((x && x.cue) || '').trim(),
      say: String((x && x.say) || '').trim(),
      fx: (x && x.fx) || null,
      wait: !(x && x.wait === false),
    }))
    // 空 cue 的项直接丢掉：提词器上留一行空白，主持人会以为坏了
    .filter((x) => x.cue)
    .sort((a, b) => a.at - b.at);
}

/* 这个游戏用哪套脚本：自己声明的，或者通用兜底 */
function itemsOf(game) {
  const own = game && Array.isArray(game.script) ? norm(game.script) : [];
  return own.length ? own : norm(FALLBACK);
}

function hasOwn(game) {
  return !!(game && Array.isArray(game.script) && norm(game.script).length);
}

function state(room, game) {
  const items = itemsOf(game);
  const raw = room && room.cue && room.cue.gameId === (game && game.id) ? room.cue.index : 0;
  const index = Math.min(items.length - 1, Math.max(0, Number(raw) || 0));
  const it = items[index];
  const nx = items[index + 1];
  return {
    index,
    total: items.length,
    cue: it.cue,
    say: it.say,
    fx: it.fx,
    wait: it.wait,
    next: nx ? nx.cue : '',
    last: index === items.length - 1,
    source: hasOwn(game) ? 'game' : 'fallback',
  };
}

function reset(room, gameId) {
  room.cue = { gameId: gameId || null, index: 0 };
}

function step(room, game, delta) {
  const items = itemsOf(game);
  const st = state(room, game);
  // 走到最后一项就停住，不会绕回开头 —— 现场点多了两下不该突然回到第一步
  const index = Math.min(items.length - 1, Math.max(0, st.index + delta));
  room.cue = { gameId: game && game.id, index };
  return state(room, game);
}

function clear(room) {
  room.cue = { gameId: null, index: 0 };
}

module.exports = { CUE_MAX, SAY_MAX, itemsOf, state, reset, step, clear, hasOwn, FALLBACK };
