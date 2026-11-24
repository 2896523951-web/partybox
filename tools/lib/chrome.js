'use strict';

/* 浏览器路径 —— 测试和截图脚本共用这一处。
 *
 * 以前 8 个脚本各自写了一句
 *   const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
 * 换一台机器、装的是 Edge、或者 Chrome 在用户目录下，就全部跑不起来，
 * 而且报错是「spawn ENOENT」，看不出是路径的问题。
 *
 * 顺序：环境变量 CHROME → 常见安装位置 → 返回默认值（让 spawn 报错时
 * 至少能看出找的是哪个文件）。
 */

const fs = require('fs');

const CANDIDATES = [
  process.env.CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  for (const p of CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {}
  }
  return CANDIDATES[1] || 'chrome';
}

module.exports = findChrome();
