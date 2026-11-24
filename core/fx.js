'use strict';

/* 仪式动作库（方案 H3）。
 *
 * 「发身份」「宣布死亡」这些现场效果，本质上不是功能，是仪式：
 * 同一件事，加上一层全屏动画和一声提示，就变成了节目。
 *
 * 六个动作是 core 提供的通用指令，游戏脚本只用名字引用，不自己实现动画 ——
 * 各写各的，观感就散了，半个月后也没人记得哪个游戏是什么风格。
 *
 * 动作一旦绑死某个游戏就退化成硬编码。判断标准：只有某一个游戏能用的动作，
 * 就不该进这张表。所以这里只有「跨游戏都成立」的六条。
 */

const FX = {
  deal: { label: '发身份', hint: '一直显示，点「撤掉」才收', arg: false, ms: 0 },
  dead: { label: '宣布死亡', hint: '一直显示，点「撤掉」才收', arg: false, ms: 0 },
  reveal: { label: '揭晓身份', hint: '一直显示，点「撤掉」才收', arg: false, ms: 0 },
  hush: { label: '静场', hint: '一直显示，点「撤掉」才收', arg: false, ms: 0 },
  countdown: { label: '倒计时', hint: '默认 3 秒，可传 1–10；自己会结束', arg: true, ms: 3200 },
  bigtext: { label: '推大字', hint: '一直显示，点「撤掉」才收', arg: true, ms: 0 },
};

const MAX_TEXT = 20;

function list() {
  return Object.keys(FX).map((id) => ({ id, label: FX[id].label, hint: FX[id].hint, arg: !!FX[id].arg }));
}

function isFx(name) {
  return Object.prototype.hasOwnProperty.call(FX, name);
}

/* 校验并整理成一条投屏指令。arg 只有 bigtext 用得上，其余一律丢掉，
 * 免得以后有人往里塞身份、词这种不能上屏的东西。 */
function payload(name, arg) {
  const id = String(name || '');
  if (!isFx(id)) return { error: '没有这个仪式动作' };
  const def = FX[id];
  // 只有倒计时自带终点；其余动作常驻，由主持人撤（2026-11-22 改）
  const ms = id === 'countdown' ? (Math.min(10, Math.max(1, Math.round(Number(arg) || 3))) * 1000 + 400) : 0;
  let text = '';
  if (def.arg) {
    text = String(arg == null ? '' : arg).trim().slice(0, MAX_TEXT);
    if (id === 'bigtext' && !text) return { error: '大字得先写一句话' };
    if (id === 'countdown') {
      const n = Number(text || 3);
      if (!Number.isFinite(n) || n < 1 || n > 10) return { error: '倒数只能是 1–10 秒' };
      text = String(Math.round(n));
    }
  }
  return { ok: true, id, label: def.label, arg: text, ms };
}

module.exports = { FX, MAX_TEXT, list, isFx, payload };
