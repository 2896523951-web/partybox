'use strict';

const fs = require('fs');
const path = require('path');

const GAMES_DIR = path.join(__dirname, '..', 'games');

function loadGames() {
  const out = new Map();
  let dirs = [];
  try {
    dirs = fs.readdirSync(GAMES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    console.log('  ⚠ games 目录不存在');
    return out;
  }
  for (const d of dirs) {
    const file = path.join(GAMES_DIR, d.name, 'index.js');
    if (!fs.existsSync(file)) continue;
    try {
      const g = require(file);
      if (!g.id || !g.name) throw new Error('缺少 id / name');
      if (typeof g.playerView !== 'function') throw new Error('缺少 playerView');
      out.set(g.id, g);
    } catch (e) {
      console.log(`  ⚠ 游戏 ${d.name} 加载失败：${e.message}`);
    }
  }
  return out;
}

module.exports = { loadGames };
