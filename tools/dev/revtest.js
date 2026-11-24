'use strict';

/* 反测（故意改坏代码，验证用例真的抓得住）
 *
 * 一次性脚本：每轮临时改坏一处实现 → 起一个临时端口的服务 →
 * 跑 extracheck → 看预期那几条是否变红 → 还原文件。
 * 任何一步炸了都会在 finally 里把文件还原，不会留脏代码。
 *
 *   node tools/dev/revtest.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 3399;
const BASE = 'http://127.0.0.1:' + PORT;

const FILES = ['core/bet.js', 'core/mood.js', 'core/titles.js', 'core/room.js', 'core/app.js', 'core/show.js', 'core/stats.js'];

/* 每轮：改哪个文件、怎么改、改完预期哪几条用例变红（用例名里的片段） */
const CASES = [
  {
    name: 'O1 押注结算：押中给 3 分（HIT_SCORE 是 2）',
    file: 'core/bet.js',
    from: 'p.betScore = (p.betScore || 0) + HIT_SCORE;',
    to: 'p.betScore = (p.betScore || 0) + HIT_SCORE + 1;',
    expect: ['押中的人拿到分'],
  },
  {
    name: 'O1 押注：放开「不能押自己」',
    file: 'core/bet.js',
    from: "if (pid === targetId) return { error: '不能押自己' };",
    to: "if (false) return { error: '不能押自己' };",
    expect: ['不能押自己'],
  },
  {
    name: 'O4 表情：把 💩 混进白名单',
    file: 'core/mood.js',
    from: "const EMOJI = ['😂', '😱', '👏', '🤔', '😭', '🔥'];",
    to: "const EMOJI = ['😂', '😱', '👏', '🤔', '😭', '🔥', '💩'];",
    expect: ['白名单外的不收'],
  },
  {
    name: 'O9 称号：静观其变挑动作最多的那个人',
    file: 'core/titles.js',
    from: 'if (!quiet || x.act < quiet.act) quiet = x;',
    to: 'if (!quiet || x.act > quiet.act) quiet = x;',
    expect: ['静观其变'],
  },
  {
    name: 'O6 断线保护：局中也照清不误',
    file: 'core/room.js',
    from: "if (!force && room.phase === 'playing') return [];",
    to: "if (false) return [];",
    expect: ['O6 局中不动手', 'O6 局中人都还在'],
  },
  {
    name: 'O11 节目单：点到底绕回开头',
    file: 'core/show.js',
    from: 'const i = Math.min(s.items.length - 1, (s.index == null ? -1 : s.index) + 1);',
    to: 'const i = ((s.index == null ? -1 : s.index) + 1) % s.items.length;',
    expect: ['O11 点多了停在最后一项'],
  },
  {
    name: 'O12 复盘：CSV 里逗号不再加引号',
    file: 'core/stats.js',
    from: 'return /[",\\n]/.test(s)',
    to: 'return /["\\n]/.test(s)',
    expect: ['名字带逗号'],
  },
  {
    // 好奇宝旁观者的副标题是「等主持人叫下一轮」，去掉「旁边看」还会被
    // 「等主持人」兜住，测不出单条词的效果。所以这里直接把整套判定打瞎，
    // 验证「围观识别一坏，下注面板就上不去」这条链路真的被测着。
    name: 'O1 围观判定：整套关键词失效',
    file: 'core/app.js',
    from: "const LOOK_ON = /看大屏|没有你的位置|出局|旁观|围观|旁边看|不在队里|等待中|等主持人|等别人|没你的份/;",
    to: 'const LOOK_ON = /^$/;',
    expect: ['围观者手机上变成下注面板'],
  },
];

function backup() {
  for (const f of FILES) {
    const abs = path.join(ROOT, f);
    fs.copyFileSync(abs, abs + '.revbak');
  }
}
function restore() {
  for (const f of FILES) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs + '.revbak')) {
      fs.copyFileSync(abs + '.revbak', abs);
      fs.unlinkSync(abs + '.revbak');
    }
  }
}

function run(cmdArgs, env, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, cmdArgs, {
      cwd: ROOT,
      env: Object.assign({}, process.env, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs || 180000);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

async function waitUp() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(BASE + '/api/state?role=screen');
      if (r.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

(async () => {
  console.log('\n  反测 ─────────────────────────────');
  // ONLY=4,8 只跑指定几条，调测例时用
  const only = process.env.ONLY ? process.env.ONLY.split(',').map((x) => parseInt(x, 10)) : null;
  const picked = CASES.filter((c, i) => !only || only.indexOf(i + 1) >= 0);
  backup();
  let warm = 0;
  try {
    for (const c of picked) {
      const abs = path.join(ROOT, c.file);
      const src = fs.readFileSync(abs, 'utf8');
      if (src.indexOf(c.from) < 0) {
        console.log(`  ! 跳过：${c.name}（在 ${c.file} 里找不到待改的片段）`);
        continue;
      }
      fs.writeFileSync(abs, src.replace(c.from, c.to));

      const srv = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { PORT: String(PORT) }),
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const up = await waitUp();
      let out = '';
      if (up) {
        const r = await run(['tools/check/extracheck.js'], { BASE, PORT: String(PORT) }, 180000);
        out = r.out;
      } else {
        out = '服务没起来';
      }
      srv.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 400));

      const red = out.split('\n').filter((l) => l.indexOf('✗') >= 0).map((l) => l.trim());
      const hit = c.expect.filter((k) => red.some((l) => l.indexOf(k) >= 0));
      if (hit.length > 0) {
        warm += 1;
        console.log(`  ✓ 抓住了：${c.name}`);
        console.log(`      ${red.slice(0, 3).join('\n      ')}`);
      } else {
        console.log(`  ✗ 没抓住：${c.name}（一条预期用例都没红）`);
        if (!red.length) console.log('      整个脚本没报错，可能是改动没生效');
      }
      fs.writeFileSync(abs, src);
    }
  } finally {
    restore();
  }
  console.log(`\n  反测结果：${warm} / ${picked.length} 条改动被测试抓到`);
  console.log('  代码已还原。\n');
})();
