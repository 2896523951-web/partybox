#!/usr/bin/env node
'use strict';

/* 把 tools/dev/hooks/ 下的钩子装到 .git/hooks/。
 * .git 不参与版本控制，所以钩子必须放在仓库里、再复制过去，换台电脑重装一次即可。 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(__dirname, 'hooks');
const DST = path.join(ROOT, '.git', 'hooks');

if (!fs.existsSync(path.join(ROOT, '.git'))) {
  console.error('这里不是 git 仓库，先 git init');
  process.exit(1);
}
fs.mkdirSync(DST, { recursive: true });

for (const name of fs.readdirSync(SRC)) {
  const from = path.join(SRC, name);
  const to = path.join(DST, name);
  fs.copyFileSync(from, to);
  try {
    fs.chmodSync(to, 0o755);
  } catch (e) {
    // Windows 上 chmod 基本无意义，忽略
  }
  console.log('装好了：.git/hooks/' + name);
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.git/hooks'], { cwd: ROOT });
} catch (e) {}
console.log('完成。之后 git push 前会自动补 [Unreleased]。');
