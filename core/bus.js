'use strict';

/* SSE 连接池。三种角色：host / screen / play(pid)。
 * 注意：screen 只允许收到 screenView，绝不能下发 hostView —— 投屏是公开的。 */

const clients = new Set(); // { res, role, pid }

function attach(res, role, pid) {
  const c = { res, role, pid: pid || null };
  clients.add(c);
  return c;
}

function detach(c) {
  clients.delete(c);
}

function write(res, ev) {
  try {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  } catch (e) {}
}

function sendHost(ev) {
  for (const c of clients) if (c.role === 'host') write(c.res, ev);
}

function sendScreen(ev) {
  for (const c of clients) if (c.role === 'screen') write(c.res, ev);
}

function sendPlayer(pid, ev) {
  for (const c of clients) if (c.role === 'play' && c.pid === pid) write(c.res, ev);
}

// 同一个 pid 可能开着多个标签页：只保留最新那条，旧的会被关闭
function keepOnlyLatest(pid) {
  const list = [...clients].filter((c) => c.role === 'play' && c.pid === pid);
  if (list.length <= 1) return;
  for (const c of list.slice(0, -1)) {
    try {
      write(c.res, { t: 'kicked', reason: 'duplicate' });
      c.res.end();
    } catch (e) {}
    clients.delete(c);
  }
}

function isOnline(pid) {
  for (const c of clients) if (c.role === 'play' && c.pid === pid) return true;
  return false;
}

function countByRole(role) {
  let n = 0;
  for (const c of clients) if (c.role === role) n += 1;
  return n;
}

module.exports = {
  attach,
  detach,
  sendHost,
  sendScreen,
  sendPlayer,
  keepOnlyLatest,
  isOnline,
  countByRole,
};
