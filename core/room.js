'use strict';

const crypto = require('crypto');

/* 房间状态。全部字段必须可 JSON 序列化——快照靠它原样落盘。 */

function createRoom() {
  return {
    v: 1,
    createdAt: Date.now(),
    phase: 'lobby', // lobby | playing
    gameId: null,
    game: { id: null, state: {}, round: 0, startedAt: 0, timer: null },
    teams: {
      A: { name: 'A 队', score: 0 },
      B: { name: 'B 队', score: 0 },
    },
    players: [],
    track: { kind: 'synth', id: null, name: '内置节拍' },
    audio: { phase: 'idle', startAt: 0, elapsedMs: 0, bpm: 122 },
    campaign: { name: '自由模式', index: 0, rounds: [] },
    /* 规则卡：选完游戏先把 3 条规则打上投屏，主持人照着念。
     * 存在房间状态里而不是内存变量，是为了笔记本意外重启后
     * 大屏能接着显示同一张卡 —— 一屋子人正等着听规则。 */
    brief: { on: false, at: 0 },

    /* 围观下注：没在局里的人也能押「这局谁赢」。
     * 人一多就有一半在干看，这是给他们留的一件事做。
     * picks 是 { 押注人 pid : 被押人 pid }，一局一清。 */
    bet: { open: false, period: 0, picks: {}, winnerId: null, settledAt: 0, hits: [] },

    /* 空档表情：等下一局的空档，手机上点一下，投屏飘一个。
     * 只存最近 30 条，飘完就没人看了。 */
    mood: { list: [] },

    /* 跨游戏的私密音效：主持人随手给某个人的耳机里放一段。
     * 任何时候都只有一个人在响 —— 换成别人时先把上一个停掉，
     * 否则上一台手机会一直放到音频结尾，没人负责停。 */
    whisper: { id: null, sound: '', until: 0 },

    /* 本局结算：主持台点「本局结束」后亮出来的那一页。
     * 三个出口（再来一局 / 换游戏 / 收工）都挂在这里，
     * 存在房间状态里是为了笔记本重启后还在。 */
    settle: { on: false, at: 0, gameId: null, name: '', scores: [], ms: 0 },

    /* 自动推进：到点自动点一次「下一步」。
     * 默认关 —— 自动点错了会毁一局，只在主持人明确打开时动。 */
    auto: { on: false, action: '', label: '', sec: 30, dueAt: 0, runs: 0 },

    /* 这一晚的取向（7.1）：variety 综艺（默认，不摆分数）| match 比赛。
     * 只影响显示与称号，不改任何计分逻辑 —— 中途切回去分数是连续的。 */
    mode: 'variety',

    theme: 'night', // night | festive
    voice: { on: false }, // 投屏语音播报（浏览器 TTS，默认关）

    /* 一晚节目单：暖场 → 主游戏 → 惩罚 → 收尾。
     * 主持人按顺序点「下一项」，不用现场想玩什么。 */
    show: { id: 'free', name: '自由模式', items: [], index: -1 },

    /* 每局历史，散场后复盘用。只留最近 30 局。 */
    /* 这一局走到第几步（H1 主持脚本。脚本本身在 games/<id>/script 里，
     * 这里只存进度；换局/开局会重置） */
    cue: { gameId: null, index: 0 },

    /* S4 投票倒计时：dueAt 由心跳在「进入投票阶段」时设成 now+60s。
     * 超时只标记 + 记日志，不替游戏改状态 —— 没投的本来就是弃权。 */
    vote: { dueAt: 0, expired: false },

    /* H4 手机遥控：6 位临时码。不用主持台密钥 —— 那是 URL 里的长期钥匙，
     * 念给别人听等于把整台机器交出去；临时码可以随时换。 */
    remote: { code: '', at: 0 },

    /* 7.2 名场面：主持人随手记一句「刚才那段」。
     * 只存文字，不存截图/录音 —— 现场记的是那句话，不是证据。 */
    moments: [],

    /* 惩罚卡口径：clean 清爽（默认）/ bar 酒桌。只换说法，不影响抽取与计分。 */
    punishMode: 'clean',

    /* P0 裁决台：手机退场后，「谁先答对」由主持人在这里点。 */
    judge: { on: false, label: '', sel: '', log: [] },

    history: [],

    log: [],
  };
}

/* 老存档没有新字段。直接 Object.assign 上去的话，
 * 读 room.bet.open 会炸在 undefined 上 —— 一屋子人正等着开局。
 * 所以恢复之后补一遍默认值，一个都不能漏。 */
function migrate(room) {
  const base = createRoom();
  for (const k of Object.keys(base)) {
    if (room[k] === undefined) room[k] = base[k];
  }
  for (const p of room.players || []) {
    if (p.betScore === undefined) p.betScore = 0;
    if (p.actN === undefined) p.actN = 0;
  }
  if (room.bet && !room.bet.picks) room.bet.picks = {};
  if (room.mood && !Array.isArray(room.mood.list)) room.mood.list = [];
  if (!room.whisper || typeof room.whisper !== 'object') room.whisper = { id: null, sound: '', until: 0 };
  if (!room.cue || typeof room.cue !== 'object') room.cue = { gameId: null, index: 0 };
  if (room.mode !== 'match') room.mode = 'variety';
  if (!room.vote || typeof room.vote !== 'object') room.vote = { dueAt: 0, expired: false };
  if (!room.remote || typeof room.remote !== 'object') room.remote = { code: '', at: 0 };
  if (!Array.isArray(room.moments)) room.moments = [];
  if (room.punishMode !== 'bar') room.punishMode = 'clean';
  if (!room.judge || typeof room.judge !== 'object') {
    room.judge = { on: false, label: '', sel: '', log: [] };
  }
  if (!Array.isArray(room.judge.log)) room.judge.log = [];
  if (room.whisper.until === undefined) room.whisper.until = 0;
  if (room.auto && room.auto.sec === undefined) room.auto.sec = 30;
  if (!Array.isArray(room.history)) room.history = [];
  return room;
}

function makePlayer(name, headset) {
  return {
    id: crypto.randomBytes(6).toString('hex'),
    name: String(name).slice(0, 14),
    team: null, // 进场不分队，等主持人点「分组」
    online: true,
    awake: false,
    headset: !!headset,
    offset: 0, // serverTime - clientTime，抢答裁决用
    score: 0,
    betScore: 0, // 围观下注赢来的分，和正赛分分开记
    actN: 0, // 这局点了多少次动作，称号和复盘要用
    alive: true,
    joinedAt: Date.now(),
    lastSeen: Date.now(), // 离线多久了 —— 用来清掉早就不在的人
  };
}

function addPlayer(room, name, headset) {
  let n = String(name || '').trim().slice(0, 14);
  if (!n) n = '玩家';
  const taken = new Set(room.players.map((p) => p.name));
  if (taken.has(n)) {
    let i = 2;
    while (taken.has(`${n} ${i}`)) i += 1;
    n = `${n} ${i}`;
  }
  const p = makePlayer(n, headset);
  // 进场一律不排队。现场经常是「先来几个人、后面陆续到」，
  // 自动分队会把他们拆开，反而要主持人一个个改回来。
  room.players.push(p);
  return p;
}

/* 一键分组：按到场顺序左右交替，人数差最多 1。
   mode='shuffle' 时先打乱再分，用于「重新分组」。 */
function group(room, mode) {
  const list = room.players.slice();
  if (mode === 'shuffle') {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  list.forEach((p, i) => {
    p.team = i % 2 === 0 ? 'A' : 'B';
  });
  return room.players;
}

function clearTeams(room) {
  for (const p of room.players) p.team = null;
}

/* 清掉早就不在的人。锁个屏、切个后台不算走，所以按「离开多久」算，
   而不是「现在有没有连着」。

   局中（phase === 'playing'）一律不自动清 —— 有人去个洗手间、手机息屏
   两分钟，回来发现自己已经被移出房间，这局就没法玩了。局中要清人只能
   主持台手动点「清离线」（force）。 */
function pruneOffline(room, olderThanMs, opts) {
  const force = !!(opts && opts.force);
  if (!force && room.phase === 'playing') return [];
  const cut = Date.now() - (olderThanMs == null ? 30 * 60000 : olderThanMs);
  const keep = [];
  const gone = [];
  for (const p of room.players) {
    if (p.online) keep.push(p);
    else if ((p.lastSeen || 0) < cut) gone.push(p);
    else keep.push(p);
  }
  room.players = keep;
  return gone;
}

function get(room, id) {
  return room.players.find((p) => p.id === id) || null;
}

function byName(room, name) {
  return room.players.find((p) => p.name === name) || null;
}

function remove(room, id) {
  const i = room.players.findIndex((p) => p.id === id);
  if (i < 0) return null;
  return room.players.splice(i, 1)[0];
}

function online(room) {
  return room.players.filter((p) => p.online);
}

function alive(room) {
  return room.players.filter((p) => p.alive);
}

function addScore(room, pid, delta) {
  const p = get(room, pid);
  if (!p) return;
  p.score = Math.max(0, p.score + delta);
}

function addTeamScore(room, team, delta) {
  if (!room.teams[team]) return;
  room.teams[team].score = Math.max(0, room.teams[team].score + delta);
}

function addLog(room, text) {
  const entry = { at: Date.now(), text: String(text).slice(0, 200) };
  room.log.push(entry);
  if (room.log.length > 150) room.log.shift();
  return entry;
}

// 换局时清掉个人分数与存活态，房间与队伍保留
function softResetPlayers(room) {
  for (const p of room.players) {
    p.score = 0;
    p.alive = true;
    p.actN = 0;
  }
}

module.exports = {
  createRoom,
  migrate,
  addPlayer,
  group,
  clearTeams,
  pruneOffline,
  get,
  byName,
  remove,
  online,
  alive,
  addScore,
  addTeamScore,
  addLog,
  softResetPlayers,
};
