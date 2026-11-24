'use strict';

/* 空档互动 —— 等下一局的几十秒里，手机上点一下，投屏飘一个。
 *
 * 三个约束：
 * 1. 必须 3 秒内能做完（现场的空档就几十秒，做不完的东西没人碰）；
 * 2. 不能占用主持人的注意力（所以没有"提交"、不用审批，点了就飘）；
 * 3. 不能变成聊天室 —— 只给 6 个表情，不给打字。
 *    现场一旦能打字，就会有人开始骂人，你还得管。
 */

const EMOJI = ['😂', '😱', '👏', '🤔', '😭', '🔥'];
const MAX_KEEP = 30;
const LIVE_MS = 6000; // 投屏上飘多久（飘完就没必要再传了）

function add(room, pid, emoji) {
  const e = String(emoji || '');
  if (EMOJI.indexOf(e) < 0) return { error: '没有这个表情' };
  const p = room.players.find((x) => x.id === pid);
  if (!p) return { error: '没这个人' };
  if (!room.mood || !Array.isArray(room.mood.list)) room.mood = { list: [] };
  room.mood.list.push({ at: Date.now(), name: p.name, emoji: e });
  while (room.mood.list.length > MAX_KEEP) room.mood.list.shift();
  return { ok: true };
}

/* 投屏只需要最近几秒的：一直往回传，重连一次就会把攒了半小时的表情全飘一遍 */
function recent(room, ms) {
  const cut = Date.now() - (ms || LIVE_MS);
  const list = (room.mood && room.mood.list) || [];
  return list.filter((x) => x.at >= cut).slice(-8);
}

module.exports = { add, recent, EMOJI, LIVE_MS };
