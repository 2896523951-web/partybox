'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const bus = require('./core/bus');
const room = require('./core/room');
const packs = require('./core/packs');
const persist = require('./core/persist');
const app = require('./core/app');

const PORT = Number(process.env.PORT || 3210);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MEDIA_DIR = path.join(__dirname, 'media');
const SFX_DIR = path.join(__dirname, 'sfx');
const MAX_UPLOAD = 60 * 1024 * 1024;

// 主持台密钥：本机免密钥，局域网必须带 ?k=。挡住玩家顺手翻 /host。
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(4).toString('hex');
const { room: R } = app.app;

// 断线宽限：pid -> Timeout。存在模块变量里而不是玩家对象上，
// 否则快照 JSON.stringify 会碰到 Timeout 的循环引用。
const offTimers = new Map();

const AUDIO_EXT = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
};

for (const d of [MEDIA_DIR, SFX_DIR, path.join(__dirname, 'snapshots')]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/* ------------------------------------------------------------- 媒体库 */

function scanMedia() {
  const out = [];
  let ents = [];
  try {
    ents = fs.readdirSync(MEDIA_DIR, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of ents) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!AUDIO_EXT[ext]) continue;
    const i = e.name.indexOf('__');
    out.push({
      id: e.name,
      name: i >= 0 ? e.name.slice(i + 2) : e.name,
      size: 0,
      ext,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return out;
}
app.setMedia(scanMedia());

/* 私密音效库：主持台自己传的音频，只有被点名的人耳机里会响。
   文件名就是标签，前缀只留时间戳，念起来还是原名。 */
function scanSfx() {
  const out = [];
  let ents = [];
  try {
    ents = fs.readdirSync(SFX_DIR, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of ents) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!AUDIO_EXT[ext]) continue;
    const i = e.name.indexOf('__');
    out.push({
      id: e.name,
      name: i >= 0 ? e.name.slice(i + 2) : e.name,
      ext,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return out;
}
app.setSfx(scanSfx());

function safeName(raw) {
  const base = path.basename(String(raw || 'track')).slice(0, 90);
  return base.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'track';
}

/* --------------------------------------------------------------- 工具 */

function hostAllowed(req, url) {
  const h = String(req.headers.host || '')
    .replace(/:\d+$/, '')
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  return url.searchParams.get('k') === HOST_KEY;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

let ssidCache = { at: 0, value: '' };

/* netsh 的输出是 GBK（中文系统的坑），SSID 里带中文的时候
   直接按 utf8 读会变成一串问号，所以先按 GBK 解，解不了再退回 utf8。 */
/* 终端输出的编码取决于当前代码页：start.bat 里 chcp 65001 之后是 UTF-8，
 * 直接开一个没 chcp 的窗口又是 GBK（936）。以前写死 GBK，在 65001 的机器上
 * Wi-Fi 名会变成「涔濆垎鐢�」，而它是投屏上最显眼的一行。
 * 所以先试 UTF-8，出现替换符再退回 GBK。 */
function decodeConsole(buf) {
  try {
    const utf8 = new TextDecoder('utf-8').decode(buf);
    if (!utf8.includes('\uFFFD')) return utf8;
  } catch (e) {}
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch (e) {
    return String(buf);
  }
}

/* 问 Wi-Fi 名字的两条路，先走快的。
   原来只用 PowerShell，冷启动经常 2 秒以上，超时设的 2.5 秒正好卡在它
   刚起来还没出结果的时候，于是永远是空串，而且空串还会被缓存一分钟——
   大屏上就一直是「和导演台连同一个 Wi-Fi」。
   netsh 一条命令百来毫秒，先用它；取不到再退回 PowerShell（超时也放宽）。 */
function winSsidByNetsh() {
  try {
    const buf = execFileSync('netsh', ['wlan', 'show', 'interfaces'], {
      timeout: 4000,
      windowsHide: true,
    });
    const text = decodeConsole(buf);
    // 只认行首的 SSID。下面紧跟一行 BSSID（那是路由器的 MAC），
    // 匹配写松了会把 MAC 当成网名。
    const m = text.match(/^[ \t]*SSID[ \t]*:[ \t]*(.+)$/m);
    return m ? m[1].trim() : '';
  } catch (e) {
    return '';
  }
}

function winSsidByProfile() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-NetConnectionProfile).Name',
      ],
      { encoding: 'utf8', timeout: 8000, windowsHide: true }
    );
    return (
      String(out)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)[0] || ''
    );
  } catch (e) {
    return '';
  }
}

function wifiName() {
  if (Date.now() - ssidCache.at < ssidTtl()) return ssidCache.value;
  let name = '';
  try {
    if (process.platform === 'win32') {
      name = winSsidByNetsh() || winSsidByProfile();
    } else if (process.platform === 'darwin') {
      name = String(
        execFileSync('sh', ['-c', "networksetup -getairportnetwork en0 | sed 's/.*: //'"], {
          encoding: 'utf8',
          timeout: 2000,
        })
      ).trim();
    } else {
      name = String(
        execFileSync('sh', [
          '-c',
          'nmcli -t -f active,ssid dev wifi 2>/dev/null | grep "^yes" | cut -d: -f2',
        ], { encoding: 'utf8', timeout: 2000 })
      ).trim();
    }
  } catch (e) {
    name = '';
  }
  // 有些名字不是真名字：没连 Wi-Fi（走网线）、或者系统报「未连接」，
  // 这些都不该显示到大屏上，宁可让人看到「和导演台连同一个」。
  if (/^(未连接|没有|无|none|n\/a|未识别的网络)/i.test(name)) name = '';
  ssidCache = { at: Date.now(), value: name };
  return name;
}

/* 拿到了就记一分钟；没拿到只记 8 秒，好让它早点重试。
   不给这个区别，第一次取不到就会空整场。 */
function ssidTtl() {
  return ssidCache.value ? 60000 : 8000;
}

// 取 Wi-Fi 名字要走一次系统命令，Windows 上可能要 1-2 秒。
// 这里绝不能让主持台等它：先返回缓存，后台刷新。
function wifiNameAsync() {
  if (Date.now() - ssidCache.at < ssidTtl()) return ssidCache.value;
  if (!ssidCache.pending) {
    ssidCache.pending = true;
    setImmediate(() => {
      try {
        wifiName();
      } catch (e) {}
      ssidCache.pending = false;
    });
  }
  return ssidCache.value;
}

/* ------------------------------------------------------------ 静态文件 */

function serveStatic(req, res, pathname) {
  let rel = pathname;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {}
  if (rel === '/') rel = '/play.html';
  if (rel === '/play') rel = '/play.html';
  if (rel === '/remote') rel = '/remote.html';
  if (rel === '/host') rel = '/host.html';
  if (rel === '/screen') rel = '/screen.html';

  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end('forbidden');

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// 音频必须支持 Range：iOS 上不支持的服务器会让 <audio> 直接不播
function serveMedia(req, res, dir, name) {
  // 转义坏掉 / 指到目录时，直接当没有这个文件
  if (!name) return res.writeHead(404).end('not found');
  const file = path.join(dir, path.basename(name));
  if (!file.startsWith(dir)) return res.writeHead(403).end('forbidden');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return res.writeHead(404).end('not found');
  }
  if (!stat.isFile()) return res.writeHead(404).end('not found');
  const type = AUDIO_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
  // 读一半失败（U 盘拔了、文件被删）不许把错误抛到进程上
  const pipe = (stream) => {
    stream.on('error', () => {
      try { res.destroy(); } catch (e) {}
    });
    stream.pipe(res);
  };
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (Number.isNaN(start) || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type,
      'Cache-Control': 'no-cache',
    });
    return pipe(fs.createReadStream(file, { start, end }));
  }
  res.writeHead(200, {
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Content-Type': type,
    'Cache-Control': 'no-cache',
  });
  pipe(fs.createReadStream(file));
}

/* ---------------------------------------------------------- 词库小工具 */

// 给下拉和列表用的一行摘要（不含词条内容，省得首页快照太大）
function packBrief(p) {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    count: p.items.length,
    custom: !!p.custom,
    own: p.ownCount || 0,
    hidden: p.hiddenCount || 0,
  };
}

/* 词库的写操作统一走这里：
 * 失败把 Error.message 直接回给主持台（那些消息是给人看的），
 * 成功就 push 一次 —— 游戏里的「词库（42）」得跟着变。 */
function packOp(fn) {
  try {
    const r = fn();
    app.push();
    return Object.assign({ ok: true }, r || {});
  } catch (e) {
    return { error: e.message };
  }
}

/* ---------------------------------------------------------------- 服务 */

/* 一个畸形网址不能把全场干掉。
 * 之前这里是 async 回调直接挂给 createServer：只要有一个请求抛错
 * （比如 /media/%E0%A4%A 这种不完整的转义，decodeURIComponent 会抛 URIError），
 * 就成了未捕获的 Promise rejection，Node 18 起默认直接退出进程 ——
 * 全场 SSE 断开、音乐全停，得跑回笔记本前面重启。
 * 现在统一包一层：单个请求出错只回 500，进程继续活着。 */
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.log('  请求出错（已忽略，服务继续跑）：', (req && req.url) || '', e && e.message);
    try {
      if (!res.headersSent) json(res, 500, { error: '服务器内部错误' });
      else res.end();
    } catch (e2) {}
  });
});

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  /* ------------------------------------------------------------ SSE */

  if (p === '/api/stream') {
    const role = url.searchParams.get('role') || 'play';
    const pid = url.searchParams.get('pid') || '';
    const isHost = role === 'host';

    if (isHost && !hostAllowed(req, url)) return res.writeHead(403).end('forbidden');
    if (role === 'play' && !room.get(R, pid)) {
      // 主持台重启 / 存档被清：告诉客户端重新输名字
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write(`data: ${JSON.stringify({ t: 'kicked', reason: 'gone' })}\n\n`);
      return res.end();
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');

    const client = bus.attach(res, role, pid);

    if (isHost) {
      bus.sendHost({ t: 'sync', ...app.hostSnapshot() });
    } else if (role === 'screen') {
      bus.sendScreen({ t: 'screen', view: app.screenSnapshot() });
    } else {
      bus.keepOnlyLatest(pid);
      const pl = room.get(R, pid);
      if (offTimers.has(pid)) {
        clearTimeout(offTimers.get(pid));
        offTimers.delete(pid);
      }
      pl.online = true;
      pl.lastSeen = Date.now();
      bus.sendPlayer(pid, {
        t: 'hello',
        me: { id: pl.id, name: pl.name, team: pl.team, score: pl.score, headset: pl.headset },
        round: R.game.round,
        phase: R.phase,
        gameName: app.gameOf() ? app.gameOf().name : '',
      });
      bus.sendPlayer(pid, { t: 'view', view: app.playerView(pid), timer: app.timerView() });
      app.pushHostOnly();
    }

    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (e) {}
    }, 12000);

    req.on('close', () => {
      clearInterval(ping);
      bus.detach(client);
      if (role === 'play' && !bus.isOnline(pid)) {
        const pl = room.get(R, pid);
        if (pl) {
          // 锁屏、切后台、刷新都会断一下，不代表人走了。
          // 给 45 秒宽限，否则一个人锁个屏就被踢出配对，现场直接崩。
          const old = offTimers.get(pid);
          if (old) clearTimeout(old);
          offTimers.set(
            pid,
            setTimeout(() => {
              offTimers.delete(pid);
              if (bus.isOnline(pid)) return;
              const cur = room.get(R, pid);
              if (!cur) return;
              cur.online = false;
              cur.lastSeen = Date.now(); // 从这一刻开始算「离开多久」
              app.pushHostOnly();
            }, 45000)
          );
        }
      }
    });
    return;
  }

  /* -------------------------------------------------------- 媒体文件 */

  if (p.startsWith('/media/')) return serveMedia(req, res, MEDIA_DIR, safeDecode(p.slice(7)));
  if (p.startsWith('/sfx/')) return serveMedia(req, res, SFX_DIR, safeDecode(p.slice(5)));

  /* ------------------------------------------------------------ 上传 */

  if (p === '/api/upload' && req.method === 'POST') {
    if (!hostAllowed(req, url)) return json(res, 403, { error: 'forbidden' });
    const name = safeName(url.searchParams.get('name') || 'track.mp3');
    const ext = path.extname(name).toLowerCase();
    if (!AUDIO_EXT[ext]) {
      return json(res, 400, {
        error: `《${name}》格式不支持`,
        hint: '转成 MP3 再传。',
      });
    }
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}__${name}`;
    const dest = path.join(MEDIA_DIR, id);
    let size = 0;
    const out = fs.createWriteStream(dest);
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) req.destroy();
    });
    req.pipe(out);
    out.on('finish', () => {
      app.setMedia(scanMedia());
      room.addLog(R, `上传了《${name}》`);
      app.pushHostOnly();
      json(res, 200, { ok: true, size });
    });
    out.on('error', () => json(res, 500, { error: '写入失败' }));
    return;
  }

  /* 私密音效上传：左栏「耳机里放」和传声筒灌杂音用 */
  /* A1：删一首上传的曲目。id 就是文件名，所以先挡路径穿越；
   * 删掉的如果是当前在用的那首，自动落回内置节拍（不留静音）。 */
  if (p === '/api/media/delete' && req.method === 'POST') {
    const b = await readBody(req);
    const id = String(b.id || '');
    if (!id || id !== path.basename(id) || id.startsWith('.')) {
      return json(res, 400, { error: '文件名不对' });
    }
    const hit = scanMedia().find((m) => m.id === id);
    if (!hit) return json(res, 404, { error: '没有这首' });
    try {
      fs.unlinkSync(path.join(MEDIA_DIR, id));
    } catch (e) {
      return json(res, 500, { error: '删不掉：' + e.message });
    }
    app.setMedia(scanMedia());
    if (R.track && R.track.kind === 'file' && R.track.id === id) {
      app.selectTrack('synth');
    }
    pushHostOnly();
    return json(res, 200, { ok: true });
  }

  if (p === '/api/upload-sfx' && req.method === 'POST') {
    if (!hostAllowed(req, url)) return json(res, 403, { error: 'forbidden' });
    const name = safeName(url.searchParams.get('name') || 'sound.mp3');
    const ext = path.extname(name).toLowerCase();
    if (!AUDIO_EXT[ext]) {
      return json(res, 400, { error: `《${name}》格式不支持`, hint: '转成 MP3 再传。' });
    }
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}__${name}`;
    const dest = path.join(SFX_DIR, id);
    let size = 0;
    const out = fs.createWriteStream(dest);
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) req.destroy();
    });
    req.pipe(out);
    out.on('finish', () => {
      app.setSfx(scanSfx());
      room.addLog(R, `上传了音效《${name}》`);
      app.pushHostOnly();
      json(res, 200, { ok: true, size, id });
    });
    out.on('error', () => json(res, 500, { error: '写入失败' }));
    return;
  }

  /* ------------------------------------------------------------ 基础 */

  if (p === '/api/net') {
    return json(res, 200, { addresses: lanAddresses(), port: PORT, ssid: wifiNameAsync() });
  }

  if (p === '/api/packs') {
    // 这是完整题库，小词库（比如自建 5 个词）等于直接给答案。
    // 只有主持台能拿，本机访问仍然免密钥。
    if (!hostAllowed(req, url)) return json(res, 403, { error: 'forbidden' });
    return json(res, 200, { packs: packs.list().map(packBrief) });
  }

  /* H4 手机遥控的接口：不用主持台密钥，用 6 位临时码。
   * GET 拿状态，POST 发指令（白名单在 core 里）。 */
  if (p === '/api/remote') {
    if (req.method === 'GET') {
      const code = url.searchParams.get('code') || '';
      return json(res, 200, app.remoteView(code));
    }
    const b = await readBody(req);
    return json(res, 200, app.remoteAct(String(b.code || ''), String(b.cmd || ''), b));
  }

  if (p === '/api/state') {
    const role = url.searchParams.get('role') || 'play';
    if (role === 'host') {
      if (!hostAllowed(req, url)) return json(res, 403, { error: 'forbidden' });
      return json(res, 200, app.hostSnapshot());
    }
    if (role === 'screen') return json(res, 200, app.screenSnapshot());
    const pid = url.searchParams.get('pid');
    if (!pid) return json(res, 400, { error: 'pid required' });
    return json(res, 200, {
      view: app.playerView(pid),
      timer: app.timerView(),
      round: R.game.round,
    });
  }

  if (p === '/api/health') {
    if (!hostAllowed(req, url)) return json(res, 403, { error: 'forbidden' });
    const players = R.players;
    return json(res, 200, {
      players: players.length,
      online: players.filter((x) => bus.isOnline(x.id)).length,
      noHeadset: players.filter((x) => !x.headset).map((x) => x.name),
      screenAwakeOff: players.filter((x) => !x.awake).map((x) => x.name),
      ssid: wifiNameAsync(),
      hosts: bus.countByRole('host'),
      screens: bus.countByRole('screen'),
      audio: R.audio.phase,
      track: R.track.name,
      game: app.gameOf() ? app.gameOf().name : null,
      savedAt: persist.FILE,
    });
  }

  /* ------------------------------------------------------------ 玩家 */

  if (p === '/api/join' && req.method === 'POST') {
    const b = await readBody(req);
    const name = String(b.name || '').trim();
    if (!name) return json(res, 400, { error: '名字不能为空' });
    if (!b.headset) return json(res, 400, { error: '请先确认已戴耳机' });
    if (R.players.length >= 26) return json(res, 400, { error: '人满了' });

    // 有人重新扫码，说明是新一轮了：上次那批早就离线的人顺手清掉
    const gone = room.pruneOffline(R, 30 * 60000);
    if (gone.length) room.addLog(R, `清掉离线：${gone.map((x) => x.name).join('、')}`);

    const pl = room.addPlayer(R, name, b.headset);
    room.addLog(R, `${pl.name} 加入`);
    app.pushHostOnly();
    return json(res, 200, { id: pl.id, name: pl.name, team: pl.team });
  }

  if (p === '/api/reconnect' && req.method === 'POST') {
    const b = await readBody(req);
    const pl = room.get(R, String(b.id || ''));
    if (!pl) return json(res, 404, { error: 'gone' });
    pl.online = true;
    pl.lastSeen = Date.now();
    app.pushHostOnly();
    return json(res, 200, {
      id: pl.id,
      name: pl.name,
      team: pl.team,
      score: pl.score,
      headset: pl.headset,
    });
  }

  if (p === '/api/awake' && req.method === 'POST') {
    const b = await readBody(req);
    const pl = room.get(R, b.id);
    if (!pl) return json(res, 404, { error: 'unknown' });
    if (pl.awake !== !!b.awake) {
      pl.awake = !!b.awake;
      app.pushHostOnly();
    }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/headset' && req.method === 'POST') {
    const b = await readBody(req);
    const pl = room.get(R, b.id);
    if (!pl) return json(res, 404, { error: 'unknown' });
    pl.headset = !!b.headset;
    app.pushHostOnly();
    return json(res, 200, { ok: true });
  }

  // 授时：客户端算好 offset 后回填，服务端用它校正抢答时间
  if (p === '/api/clock' && req.method === 'POST') {
    const b = await readBody(req);
    const pl = room.get(R, b.id);
    if (!pl) return json(res, 404, { error: 'unknown' });
    pl.offset = Math.max(-3000, Math.min(3000, Number(b.offset) || 0));
    return json(res, 200, { ok: true, offset: pl.offset });
  }

  if (p === '/api/clock/ping') {
    return json(res, 200, { s: Date.now() });
  }

  /* 围观下注：没在局里的人押「谁赢」。
   * 单独开一个口而不是塞进 /api/game —— 下注跟当前是哪个游戏无关，
   * 玩家在这个动作上也不该被游戏的 actions 表挡住。 */
  if (p === '/api/bet' && req.method === 'POST') {
    const b = await readBody(req);
    const pl = room.get(R, String(b.id || ''));
    if (!pl) return json(res, 404, { error: 'unknown' });
    return json(res, 200, app.betPick(pl.id, String(b.targetId || '')));
  }

  /* 空档表情：等下一局的时候手机上点一下，投屏飘一个。
   * 只认白名单里的 6 个，不给打字 —— 现场能打字就会有人开始骂人。 */
  if (p === '/api/mood' && req.method === 'POST') {
    const b = await readBody(req);
    const pl = room.get(R, String(b.id || ''));
    if (!pl) return json(res, 404, { error: 'unknown' });
    return json(res, 200, app.moodAdd(pl.id, String(b.emoji || '')));
  }

  /* ------------------------------------------------------------ 动作 */

  if (p === '/api/game' && req.method === 'POST') {
    const b = await readBody(req);
    const pl = room.get(R, b.id);
    if (!pl) return json(res, 404, { error: 'unknown' });
    const r = app.playerAction(String(b.action || ''), pl.id, b);
    return json(res, 200, r);
  }

  if (p === '/api/host' && req.method === 'POST') {
    if (!hostAllowed(req, url)) return json(res, 403, { error: 'forbidden' });
    const b = await readBody(req);
    const cmd = String(b.cmd || '');

    switch (cmd) {
      case 'game/select':
        return json(res, 200, app.selectGame(String(b.id || '')));
      case 'game/start':
        return json(res, 200, app.startGame(b.cfg || {}));
      /* 提词器：下一步 / 跳过 / 再说一遍。进度存在房间状态里，
       * 笔记本重启也接得上 —— 一屋子人等着，不能让主持人从头找。 */
      case 'cue/next':
        return json(res, 200, app.cueNext());
      case 'cue/skip':
        return json(res, 200, app.cueSkip());
      case 'cue/again':
        return json(res, 200, app.cueAgain());
      /* 仪式动作：投屏动画 + 主持机出声。六个通用动作，任何游戏下都能单独触发。 */
      case 'fx/clear':
        return json(res, 200, app.fxClear());
      case 'fx/fire': {
        const r = app.fxFire(String(b.name || ''), b.arg);
        return json(res, 200, r);
      }
      /* 规则卡手动上屏 / 收起。选游戏时会自动上屏，
       * 这两个是给「新来两个人没听到规则」和「讲完了直接收」用的。 */
      case 'brief/show':
        return json(res, 200, app.showBrief());
      case 'brief/hide':
        return json(res, 200, app.hideBrief());
      case 'game/act':
        return json(res, 200, app.hostAct(String(b.action || ''), b));
      case 'player/team':
        return json(res, 200, app.setTeam(b.id, b.team));
      case 'room/group':
        return json(res, 200, app.groupTeams(b.mode));
      case 'room/clearTeams':
        return json(res, 200, app.clearTeams());
      case 'room/prune':
        return json(res, 200, app.pruneOffline());
      case 'player/kick':
        return json(res, 200, app.kick(b.id));
      case 'player/score':
        return json(res, 200, app.score(b.id, b.delta));
      case 'team/score':
        return json(res, 200, app.teamScore(b.team, b.delta));
      case 'team/setScore':
        return json(res, 200, app.setTeamScore(b.team, b.score));
      case 'team/name':
        return json(res, 200, app.teamName(b.team, b.name));
      case 'audio/play':
        return json(res, 200, app.audioPlay(b.fromSec));
      case 'audio/pause':
        return json(res, 200, app.audioPause());
      case 'audio/stop':
        return json(res, 200, app.audioStop());
      case 'audio/bpm':
        return json(res, 200, app.audioBpm(b.bpm));
      case 'audio/track':
        return json(res, 200, app.selectTrack(b.id));
      case 'media/refresh':
        app.setMedia(scanMedia());
        app.pushHostOnly();
        return json(res, 200, { ok: true });
      case 'sfx/refresh':
        app.setSfx(scanSfx());
        app.pushHostOnly();
        return json(res, 200, { ok: true });
      /* 跨游戏的私密音效：谁走神、谁拖节奏，往他耳机里放一段。
       * 原来是「耳返攻击」那个游戏里的动作，现在是主持台随时能用的工具。 */
      case 'sfx/poke': {
        try {
          return json(res, 200, app.whisper(String(b.id || ''), b.sound));
        } catch (e) {
          return json(res, 200, { error: e.message });
        }
      }
      case 'sfx/pokeStop':
        return json(res, 200, app.whisperStop());
      case 'room/reset':
        return json(res, 200, app.resetAll());
      case 'room/kickAll':
        return json(res, 200, app.kickAll());

      /* -------------------------------------------------- 这一晚
       * 下面这些跟「玩哪个游戏」无关，都是围着整场转的：
       * 围观下注、自动推进、本局结算、皮肤、语音、节目单、复盘。 */
      case 'bet/clear':
        return json(res, 200, app.betClear());
      case 'bet/open':
        return json(res, 200, app.betOpen());
      case 'bet/settle':
        return json(res, 200, app.betSettle(String(b.id || '')));
      case 'bet/cancel':
        return json(res, 200, app.betCancel());
      case 'auto/on':
        return json(res, 200, app.autoOn(b.sec));
      case 'auto/off':
        return json(res, 200, app.autoOff());
      case 'settle/round':
        return json(res, 200, app.settleRound());
      case 'settle/again':
        return json(res, 200, app.settleAgain());
      case 'settle/cancel':
        return json(res, 200, app.settleCancel());
      case 'settle/switch':
        return json(res, 200, app.settleSwitch());
      case 'settle/wrap':
        return json(res, 200, app.settleWrap());
      case 'moment/add':
        return json(res, 200, app.momentAdd(String(b.text || '')));
      case 'judge/open':
        return json(res, 200, app.judgeOpen(String(b.label || '本局')));
      case 'judge/close':
        return json(res, 200, app.judgeClose());
      case 'judge/select':
        return json(res, 200, app.judgeSelect(String(b.pid || '')));
      case 'judge/next':
        return json(res, 200, app.judgeNext());
      case 'judge/pick':
        return json(res, 200, app.judgePick(String(b.pid || ''), !!b.ok));
      case 'player/tap':
        return json(res, 200, app.tapPlayer(String(b.pid || '')));
      case 'punish/add':
        return json(res, 200, app.punishAdd(b));
      case 'punish/del':
        return json(res, 200, app.punishDel(String(b.id || '')));
      case 'punish/mode':
        return json(res, 200, app.punishMode(String(b.mode || '')));
      case 'punish/draw':
        return json(res, 200, app.punishDraw());
      /* H4：生成 / 更换遥控码。只有主持台能调，手机端只能拿码换权限。 */
      case 'remote/new':
        return json(res, 200, app.remoteNew());
      case 'mode/set':
        return json(res, 200, app.setMode(String(b.name || '')));
      case 'theme/set':
        return json(res, 200, app.setTheme(String(b.name || '')));
      case 'voice/set':
        return json(res, 200, app.setVoice(b.on));
      case 'voice/say':
        return json(res, 200, app.voiceSay(b.text));
      case 'show/load':
        return json(res, 200, app.showLoad(String(b.id || 'free')));
      case 'show/next':
        return json(res, 200, app.showNext());
      case 'review/get':
        return json(res, 200, app.reviewData());
      case 'review/csv':
        return json(res, 200, app.reviewCsv());
      case 'room/clearSave':
        // 存档一清，就再没人记得「刚才谁耳机里在响」了，所以先掐声音
        app.silenceAll();
        persist.clear();
        return json(res, 200, { ok: true });

      /* -------------------------------------------------------- 词库
       * 全部走 /api/host 这条分支，天然带着主持权限。
       * 新开一个公开的写接口，任何一台玩家手机都能改你的词库。 */
      case 'pack/list':
        return json(res, 200, { packs: packs.list().map(packBrief) });
      case 'pack/detail':
        return json(res, 200, packOp(() => packs.detail(String(b.id || ''))));
      case 'pack/create':
        return json(res, 200, packOp(() => packs.createPack({ name: b.name, type: b.type })));
      case 'pack/item/add':
        return json(res, 200, packOp(() => packs.addItem(String(b.id || ''), b)));
      case 'pack/item/remove':
        return json(res, 200, packOp(() => packs.removeItem(String(b.id || ''), b.key)));
      case 'pack/remove':
        return json(res, 200, packOp(() => packs.removePack(String(b.id || ''))));
      case 'pack/reset':
        return json(res, 200, packOp(() => packs.resetPack(String(b.id || ''))));
      default:
        return json(res, 404, { error: '未知指令 ' + cmd });
    }
  }

  /* ------------------------------------------------------------ 静态 */

  if (req.method === 'GET') {
    if ((p === '/host' || p === '/host.html') && !hostAllowed(req, url)) {
      return res
        .writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('主持台需要密钥，请用终端打印的带 ?k= 的地址打开');
    }
    return serveStatic(req, res, p);
  }

  json(res, 404, { error: 'not found' });
}

/* 兜底：任何漏网的异步异常都不许把进程带走。
 * 宁可日志里多一行，也不要现场二十个人的手机一起白屏。 */
process.on('unhandledRejection', (e) => {
  console.log('  未捕获的异步异常（已忽略）：', (e && e.message) || e);
});
process.on('uncaughtException', (e) => {
  console.log('  未捕获的异常（已忽略）：', (e && e.stack) || e);
});

/* 路径里的转义坏了就当作没这个文件，别让它抛到外面去 */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return '';
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log(`  端口 ${PORT} 被占用了。换一个：`);
    console.log(`    Windows   set PORT=3211 && node server.js`);
    console.log(`    macOS     PORT=3211 node server.js`);
    console.log('');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  const games = [...app.games.values()].map((g) => g.name).join(' · ');
  console.log('');
  console.log('  聚会游戏机 · 局域网多功能游戏系统');
  console.log('  ────────────────────────────────────');
  console.log(`  主持台（本机）  http://localhost:${PORT}/host`);
  for (const a of addrs) {
    console.log(`  主持台（局域网）http://${a.address}:${PORT}/host?k=${HOST_KEY}`);
    console.log(`  玩家入口        http://${a.address}:${PORT}   (${a.name})`);
  }
  console.log(`  投屏            /screen  （只读，不发声）`);
  console.log('  ────────────────────────────────────');
  console.log(`  已装游戏 ${app.games.size} 个：${games}`);
  console.log(`  词库 ${packs.list().length} 个 · 曲库 ${app.mediaList().length} 首`);
  console.log('  只把「玩家入口」发给玩家；主持台地址带密钥，别外泄');

  /* 开机先把 Wi-Fi 名字问一次。
     前台第一个请求几乎一定赶在它前面，不预热的话大屏扫码页会空几秒，
     主持人正好在这个时候开投屏，就会看到「和导演台连同一个」。 */
  setTimeout(() => {
    try {
      const ssid = wifiName();
      console.log(ssid ? `  当前 Wi-Fi      ${ssid}` : '  当前 Wi-Fi      （没连 Wi-Fi，走网线也能玩）');
    } catch (e) {}
  }, 200);

  console.log('');
});
