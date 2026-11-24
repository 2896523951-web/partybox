'use strict';

/* P0 裁决台：大屏控场那一组游戏（B1–B4）共用的「谁对谁错」。
 *
 * 手机抢答一旦退场，判定就回到人身上：主持人看谁先举手、谁先喊，
 * 然后在主持台上点一下「对」或「错」。这套东西如果每个游戏各写一遍，
 * 现场会出现四套手感不一样的按钮 —— 所以提到 core。
 *
 * 两条边界：
 * 1. 裁决本身不决定加分。加多少由游戏自己声明（judge 钩子），
 *    没有声明就只记一条日志 + 一次参与度。
 * 2. 「参与打点」和「裁决」是两件事：不判分也要能记谁动了手，
 *    所以 tap 单独留着。
 */

const MAX_LOG = 60;

function blank() {
  return { on: false, label: '', sel: '', log: [] };
}

function open(room, label) {
  room.judge = Object.assign(blank(), { on: true, label: String(label || '本局').slice(0, 12) });
  return { ok: true, judge: view(room) };
}

function close(room) {
  room.judge = blank();
  return { ok: true };
}

function select(room, pid) {
  if (!room.judge || !room.judge.on) return { error: '先开裁决' };
  if (!pid) return { error: '先点一个人' };
  room.judge.sel = String(pid);
  return { ok: true, sel: room.judge.sel };
}

function next(room) {
  if (room.judge) room.judge.sel = '';
  return { ok: true };
}

function record(room, pid, ok, note) {
  if (!room.judge || !room.judge.on) return { error: '先开裁决' };
  const id = String(pid || room.judge.sel || '');
  if (!id) return { error: '先点一个人' };
  const row = { pid: id, ok: !!ok, at: Date.now(), note: String(note || '').slice(0, 20) };
  room.judge.log.push(row);
  while (room.judge.log.length > MAX_LOG) room.judge.log.shift();
  room.judge.sel = '';
  return { ok: true, row, judge: view(room) };
}

/* 打点：不判分，只记「这个人动了一次手」。
 * 称号里的「最忙的一双手」和复盘参与度都吃这个数。 */
function tap(player) {
  if (!player) return { error: '没有这个人' };
  player.actN = (player.actN || 0) + 1;
  return { ok: true, actN: player.actN };
}

function view(room) {
  const j = room.judge || blank();
  return {
    on: !!j.on,
    label: j.label || '',
    sel: j.sel || '',
    n: (j.log || []).length,
    last: (j.log || []).slice(-1)[0] || null,
  };
}

module.exports = { blank, open, close, select, next, record, tap, view };
