'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'snapshots');
const FILE = path.join(DIR, 'state.json');

function ensure() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

// 原子写：先写 .tmp 再 rename，防止进程被杀时留下半个 JSON
function save(room) {
  ensure();
  try {
    const body = JSON.stringify({ savedAt: Date.now(), room });
    fs.writeFileSync(FILE + '.tmp', body);
    fs.renameSync(FILE + '.tmp', FILE);
    return true;
  } catch (e) {
    return false;
  }
}

function load() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const d = JSON.parse(raw);
    if (!d || !d.room || !Array.isArray(d.room.players)) return null;
    // 上次的在线状态不能带过来，全部标记离线，等客户端重连
    for (const p of d.room.players) p.online = false;
    if (d.room.audio) d.room.audio.phase = 'idle';
    return d.room;
  } catch (e) {
    return null;
  }
}

function clear() {
  try {
    fs.unlinkSync(FILE);
  } catch (e) {}
}

function start(room, everyMs = 2000) {
  ensure();
  const timer = setInterval(() => save(room), everyMs);
  timer.unref && timer.unref();
  return timer;
}

module.exports = { save, load, clear, start, FILE };
