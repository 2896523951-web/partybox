'use strict';

/* 私密音效的可选清单 —— 只认真实存在的音频文件。
 *
 * R4 把内置合成音效全删了（现场合成的汽笛 / 猫叫 / 弹簧，加上 5 段浏览器 TTS）。
 * 理由很实在：合成出来的东西现场没有一个人会笑，那些方块唯一的作用是把
 * 真正能用的「自己传的」挤到第二栏去，主持人还得先划过去才找得到。
 *
 * 现在只剩两个来源，都在主持台右边「音频库」里：
 *   file:xxx  第二个上传口「上传私密音效」 → sfx/ 目录，只进被点名那台的耳机
 *   media:xxx 第一个上传口「上传音频」     → 曲库，舞蹈狼人杀那些游戏也在用它
 *
 * 两边共用一套 id 前缀，手机端 sfx.js 负责把前缀翻译成 /sfx/ 或 /media/ 地址。
 */

const FILE_PREFIX = 'file:';
const MEDIA_PREFIX = 'media:';

/* 文件名是 `${时间戳}-${随机}__原名.mp3`，前缀只是防重名，
 * 显示的时候要去掉，否则主持人看到的是「mw7bfinz-ff75c4__雷军 - Are You OK」。 */
function pretty(id) {
  const s = String(id || '');
  const i = s.indexOf('__');
  return i >= 0 ? s.slice(i + 2) : s;
}

// 能选的音效：我传的私密音效在前，曲库里的歌在后
function list(files, media) {
  const out = [];
  for (const f of files || []) {
    if (!f || !f.id) continue;
    out.push({ value: FILE_PREFIX + f.id, label: '我的：' + (f.name || pretty(f.id)), kind: 'file' });
  }
  for (const m of media || []) {
    if (!m || !m.id) continue;
    out.push({ value: MEDIA_PREFIX + m.id, label: '曲库：' + (m.name || pretty(m.id)), kind: 'media' });
  }
  return out;
}

function has(id, opts) {
  const v = String(id == null ? '' : id);
  return !!v && (opts || []).some((o) => o.value === v);
}

/* 存档里的音效名可能是上一版的内置名字（'laugh' / 'noise'），
 * 也可能是已经被主持人删掉的文件。这两种都得纠正成清单里第一个能用的。
 * 现场不需要多一个报错弹窗，但也绝不能把一个空名字发给手机 ——
 * 那样耳机里一声不响，主持人会以为是玩家耳机坏了。 */
function resolve(id, opts) {
  const arr = opts || [];
  if (has(id, arr)) return String(id);
  return arr.length ? arr[0].value : '';
}

// 显示用。清单里没有（老存档 / 文件已删）就退回文件名，别显示成一串 id
function label(id, opts, fallback) {
  const v = String(id == null ? '' : id);
  const hit = (opts || []).find((o) => o.value === v);
  if (hit) return hit.label;
  if (v.indexOf(FILE_PREFIX) === 0) return '我的：' + pretty(v.slice(FILE_PREFIX.length));
  if (v.indexOf(MEDIA_PREFIX) === 0) return '曲库：' + pretty(v.slice(MEDIA_PREFIX.length));
  return fallback || '未选';
}

module.exports = { list, has, resolve, label, pretty, FILE_PREFIX, MEDIA_PREFIX };
