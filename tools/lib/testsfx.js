'use strict';

/* 测试用的「一个真音效」。
 *
 * R4 之后音效库里只剩真文件：主持台传的私密音效（file:）和曲库（media:）。
 * 内置合成音全没了，所以空库的时候两个音效游戏都点不动 ——
 * 这不是 bug，是设计。测试不能因此就挂，自己造一个塞进去。
 *
 * 优先用现场真有的文件；一个都没有就写一个 2 秒静音 wav 到 sfx/，
 * 跑完 cleanup() 删掉。静音没关系，测的是「有没有发指令 / 界面有没有对」，
 * 不是好不好听。
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 3210}`;
const SFX_DIR = path.join(__dirname, '../..', 'sfx');
const NAME = '0-test-silence.wav';

let created = false;

function wavBytes(sec) {
  const rate = 8000;
  const n = Math.round(rate * sec);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

async function getJson(url) {
  const r = await fetch(url);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

/* 返回一个现在就能用的 id（形如 file:xxx.mp3） */
async function ensure() {
  const hs = await getJson(BASE + '/api/state?role=host');
  const files = (hs && hs.sfx) || [];
  if (files.length) return 'file:' + files[0].id;
  if (!fs.existsSync(path.join(SFX_DIR, NAME))) {
    fs.writeFileSync(path.join(SFX_DIR, NAME), wavBytes(2));
    created = true;
  }
  await post(BASE + '/api/host', { cmd: 'sfx/refresh' });
  return 'file:' + NAME;
}

async function cleanup() {
  if (!created) return;
  try {
    fs.unlinkSync(path.join(SFX_DIR, NAME));
  } catch (e) {}
  created = false;
  await post(BASE + '/api/host', { cmd: 'sfx/refresh' }).catch(() => {});
}

module.exports = { ensure, cleanup, BASE };
