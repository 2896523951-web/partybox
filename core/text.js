'use strict';

/* 答案模糊匹配：综艺现场没人会因为少打一个「的」被判错。 */

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s，。、,.!！?？;；:：'"“”‘’()（）【】\[\]<>《》\-—_]/g, '')
    .replace(/[的了是在个呢吧啊呀]/g, '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248));
}

/* 至少两个字才算「猜中」。
 * 否则谜底是「打草惊蛇」，底下喊一声「蛇」就直接判对，游戏当场就废了。 */
const MIN_HIT = 2;

function match(guess, answer) {
  const g = norm(guess);
  const a = norm(answer);
  if (!g || !a) return false;
  // 一字不差（标点、语气词已经被 norm 抹掉了）
  if (g === a) return true;

  const ga = [...g];
  const aa = [...a];

  // 猜了整句：「我猜是打草惊蛇」「答案是打草惊蛇」
  if (aa.length >= MIN_HIT && g.includes(a)) return true;

  // 只答了一部分：必须够长，而且最多只容一个字
  // （「泰坦尼克」对「泰坦尼克号」算对，「惊蛇」对「打草惊蛇」不算）
  if (ga.length >= MIN_HIT && aa.length - ga.length <= 1 && a.includes(g)) return true;

  return false;
}

function len(s) {
  return [...String(s || '')].length;
}

function mask(s) {
  return [...String(s || '')].map(() => '·').join('');
}

module.exports = { norm, match, len, mask };
