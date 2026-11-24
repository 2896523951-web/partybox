'use strict';

const crypto = require('crypto');
const room = require('./room');
const bus = require('./bus');
const persist = require('./persist');
const packs = require('./packs');
const bet = require('./bet');
const mood = require('./mood');
const titles = require('./titles');
const show = require('./show');
const stats = require('./stats');
const sfxlib = require('./sfxlib');
const cue = require('./cue');
const fx = require('./fx');
const punish = require('./punish');
const judge = require('./judge');
const { loadGames } = require('./registry');

const ROOM = room.createRoom();

const app = {
  room: ROOM,
  games: loadGames(),
  game: null,
  media: [],
  sfx: [], // 自传的私密音效（左栏「耳机里放」、传声筒灌杂音用）
};

/* 恢复上次局面：进程被杀、笔记本重启，都不该让一屋子人重开 */
(function restore() {
  const saved = persist.load();
  if (!saved) return;
  Object.assign(app.room, saved);
  // 老存档没有这轮新增的字段（下注 / 结算 / 节目单…），
  // 直接读会炸在 undefined 上。补齐再往下走。
  room.migrate(app.room);
  for (const p of app.room.players) {
    p.online = false;
    p.awake = false;
  }
  // 上次那批人如果已经是几十分钟前的事，直接清掉 ——
  // 否则主持台一打开就顶着一排早就不在的人，还得手动一个个删。
  const gone = room.pruneOffline(app.room, 30 * 60000);
  if (app.room.gameId && app.games.has(app.room.gameId)) {
    app.game = app.games.get(app.room.gameId);
  }
  const mins = Math.max(0, Math.round((Date.now() - (saved.createdAt || Date.now())) / 60000));
  if (app.room.players.length) {
    console.log(`  已恢复上次局面：${app.room.players.length} 人，${mins} 分钟前`);
  }
  if (gone.length) {
    console.log(`  清掉 ${gone.length} 个早就离线的人：${gone.map((p) => p.name).join('、')}`);
  }
})();

persist.start(app.room, 2000);

/* ------------------------------------------------------------- 上下文 */

function ctx(pid, payload) {
  return {
    pid,
    player: room.get(app.room, pid),
    payload: payload || {},
    now: Date.now(),
    room: app.room,
    log: (t) => room.addLog(app.room, t),
    send: (targetPid, ev) => bus.sendPlayer(targetPid, ev),
    // 游戏插件也能控制主持台那台音响（「重复就打飞」需要音乐随时停）
    music: (op) => {
      if (op === 'play') return audioPlay();
      if (op === 'pause') return audioPause();
      return audioStop();
    },
    sfx: (targetPid, name) => bus.sendPlayer(targetPid, { t: 'sfx', name }),
    // 掐掉某个人耳机里正在响的东西（耳返攻击的「停」）
    sfxStop: (targetPid) => {
      if (targetPid) bus.sendPlayer(targetPid, { t: 'sfx_stop' });
      else for (const p of app.room.players) bus.sendPlayer(p.id, { t: 'sfx_stop' });
    },
    sfxAll: (name) => {
      for (const p of app.room.players) bus.sendPlayer(p.id, { t: 'sfx', name });
    },
    say: (targetPid, text) => bus.sendPlayer(targetPid, { t: 'toast', text }),
    push: () => app.push(),
    addScore: (id, d) => room.addScore(app.room, id, d),
    addTeamScore: (team, d) => room.addTeamScore(app.room, team, d),
    // 游戏插件能看到曲库 / 自传音效，用来做「这首歌」和「放这个音效」
    media: app.media,
    sfxFiles: app.sfx,
    track: () => app.room.track,
  };
}

/* --------------------------------------------------------------- 视图 */

function safe(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch (e) {
    console.log('  视图计算失败：', e.message);
    return fallback;
  }
}

function timerView() {
  const t = app.room.game.timer;
  if (!t || !t.endsAt) return null;
  return { endsAt: t.endsAt, label: t.label || '', total: t.total || 0 };
}

function gameOf() {
  return app.game;
}

/* ---------------------------------------------------- 谁在局里
 *
 * 游戏没给统一接口说「这局有几个人、哪几个」。但它一定会在
 * playerView 里说清楚：没位置的人拿到的是 type:'text' 的
 * 「看大屏吧」「你出局了」。所以按这个判 —— 不用改 14 个游戏。
 *
 * 注意这里调的是游戏原始 playerView，不是外面的 playerView()，
 * 否则就自己调自己了。 */
const LOOK_ON = /看大屏|没有你的位置|出局|旁观|围观|旁边看|不在队里|等待中|等主持人|等别人|没你的份/;

function rawPlayerView(pid) {
  const g = gameOf();
  if (!g || !g.playerView) return null;
  return safe(() => g.playerView(app.room, pid, ctx(pid, {})), null);
}

function isSpectator(pid) {
  if (app.room.phase !== 'playing') return false;
  const v = rawPlayerView(pid);
  if (!v) return true;
  /* 不能只认 type:'text'。「好奇宝」给旁观者发的是一张空的词卡
   * （type:'word'，标题写「这轮你在旁边看」），只看类型就会漏掉
   * 一整种围观场景 —— 而那正是人最多、最需要下注的时候。
   * 所以统一看标题和副标题怎么说。 */
  return LOOK_ON.test(String(v.title || '') + ' ' + String(v.sub || ''));
}

/* ------------------------------------------------ 围观下注（O1）
 *
 * 下注只在「局中」开放，而且只给没在局里的人看。
 * 在局里的人手机上有正事，别拿下注去分他的心。 */

function betView(pid) {
  const b = app.room.bet;
  if (!b) return null;
  const live = b.open || !!b.settledAt;
  if (!live) return null;
  if (!isSpectator(pid)) return null;

  const me = room.get(app.room, pid);
  if (!me) return null;

  if (b.open) {
    const options = app.room.players
      .filter((p) => p.id !== pid)
      .map((p) => ({ value: p.id, label: p.name }));
    return {
      type: 'bet',
      title: '押一个',
      sub: `这局谁会赢？押中 +${bet.HIT_SCORE}`,
      options,
      pick: b.picks[pid] || null,
      mood: true,
    };
  }

  const hit = (b.hits || []).indexOf(me.name) >= 0;
  return {
    type: 'bet',
    title: hit ? '押中了' : '这局没押中',
    sub: `${b.winnerName || '?'} 赢了${hit ? ` · +${bet.HIT_SCORE}` : ''}`,
    big: hit ? '+' + bet.HIT_SCORE : '',
    done: true,
    mood: true,
  };
}

/* ------------------------------------------------ 本局结算（O5）
 *
 * 主持台点「本局结束」之后亮出来。玩家手机只报自己的成绩，
 * 名次和完整榜在投屏上 —— 手机上排一屏人名，谁也看不清。 */

function settleOf() {
  const s = app.room.settle;
  return s && s.on ? s : null;
}

/* 结算页的「再来一局」能不能点，取决于在线人数够不够。
 * 判断口径和 startGame 保持一致（都用 online），否则两边会打架。 */
function settleMeta() {
  const g = gameOf();
  const online = app.room.players.filter((p) => bus.isOnline(p.id) || p.online).length;
  const need = (g && g.minPlayers) || 2;
  return {
    online,
    need,
    canAgain: !!g && online >= need,
    short: Math.max(0, need - online),
    gameName: g ? g.name : '',
  };
}

function settlePlayerView(pid) {
  const s = settleOf();
  if (!s) return null;
  const me = room.get(app.room, pid);
  const rows = s.scores || [];
  const i = rows.findIndex((x) => x.id === pid);
  const mine = i >= 0 ? rows[i] : null;

  if (s.stage === 'board') {
    return {
      type: 'settle',
      title: '今晚收工',
      sub: me ? `你一共 ${(me.score || 0) + (me.betScore || 0)} 分` : '',
      rows: (s.board || []).slice(0, 6).map((x, n) => ({
        rank: n + 1,
        name: x.name,
        num: x.total,
        tag: x.title || '',
      })),
      footer: '辛苦了，路上小心',
      mood: true,
    };
  }

  return {
    type: 'settle',
    title: i === 0 ? '本局第一' : '本局结束',
    sub: mine ? `你拿了 ${mine.score} 分` : '这局没你的分',
    big: i >= 0 ? `第 ${i + 1} 名 · ${rows.length} 人` : '',
    rows: rows.slice(0, 6).map((x, n) => [n + 1, x.name, x.score]),
    footer: '等主持人安排下一局',
    mood: true,
  };
}

function settleScreenView() {
  const s = settleOf();
  if (!s) return null;
  if (s.stage === 'board') {
    return {
      type: 'board',
      title: '今晚收工',
      sub: s.name || '',
      rows: (s.board || []).map((x, n) => ({
        rank: n + 1,
        name: x.name,
        score: x.score,
        bet: x.bet,
        total: x.total,
        title: x.title,
        why: x.why,
      })),
    };
  }
  const ms = (app.room.moments || []).filter((m) => m.gameId === app.room.gameId).slice(-3);
  return {
    type: 'settle',
    kicker: app.room.mode === 'variety' ? '本局结束' : '本局排行',
    title: s.name || '本局结束',
    mode: app.room.mode,
    moments: ms.map((m) => m.text),
    rows: (s.scores || []).map((x, n) => ({ rank: n + 1, name: x.name, score: x.score })),
    note: '主持人开始下一局，这一页会自己收走',
  };
}

/* ------------------------------------------------ 开局面板（规则卡）

 * 选游戏的那一刻就把 3 条规则打上投屏，而不是等主持点了「开始」才弹。
 * 现场顺序本来就是「选游戏 → 讲规则 → 发词」，规则卡要是等到开局才出现，
 * 那在主持人点开局之前的那几分钟里大屏是空的、人也不看。
 *
 * 收起规则卡靠「主持人做的第一个真动作」（发词开局 / 开始 / 放歌），
 * 不需要再单独按一次「我讲完了」—— 那个按钮在现场只会被忘掉，
 * 然后大屏一直停在规则页，全场以为卡住了。
 * 中途调配置（换词库、改人数、拖进度条）不算开始，卡片留着。 */

const CONFIG_ACT = /^host_(pack|mode|count|dialect|sound|disturbSound|seek)$/;

function briefOf() {
  const g = gameOf();
  if (!g || !app.room.brief || !app.room.brief.on) return null;
  return {
    gameId: g.id,
    gameName: g.name,
    slogan: g.slogan || '',
    rules: (g.rules || []).slice(0, 3),
    need: g.minPlayers || 2,
    count: app.room.players.length,
    online: app.room.players.filter((p) => bus.isOnline(p.id) || p.online).length,
  };
}

function showBrief() {
  if (!app.game) return { error: '先选一个游戏' };
  app.room.brief = { on: true, at: Date.now() };
  room.addLog(app.room, `规则卡上屏：${app.game.name}`);
  push();
  return { ok: true };
}

function hideBrief() {
  const was = !!(app.room.brief && app.room.brief.on);
  app.room.brief = { on: false, at: 0 };
  if (was) push();
  return { ok: true };
}

function hostView() {
  const g = gameOf();
  const base = {
    title: g ? g.name : '未选择游戏',
    desc: g ? g.desc || '' : '在左边选一个游戏开始',
    info: [],
    controls: [],
    table: null,
  };
  if (!g || !g.hostView) return base;
  const v = safe(() => g.hostView(app.room, ctx('host', {})), {});
  const out = Object.assign(base, v);
  // 规则卡在投屏上的时候，主持台上也把 3 条摆出来 ——
  // 现场经常是「大屏在身后，主持人低头看台子」，两边得是同一份字
  const brief = briefOf();
  if (brief) {
    out.brief = brief;
    if (brief.slogan) out.desc = brief.slogan;
  }
  return out;
}

function playerView(pid) {
  const brief = briefOf();
  if (brief) {
    return {
      type: 'rules',
      title: '抬头看大屏',
      sub: brief.slogan,
      rules: brief.rules,
      footer: '主持人讲完规则，手机自动切到游戏',
      mood: true,
    };
  }
  // 结算页压在游戏视图前面：这一局已经结束了，
  // 再让他盯着一手的词没有意义
  const st = settlePlayerView(pid);
  if (st) return st;

  const bv = betView(pid);
  if (bv) return bv;

  const g = gameOf();
  if (!g) return { type: 'text', title: '等主持人开局', sub: '先喝口水', mood: true };
  const v = safe(() => g.playerView(app.room, pid, ctx(pid, {})), {
    type: 'text',
    title: '这局没有你的位置',
    sub: '看大屏吧',
  });
  return decorate(v || { type: 'text', title: '等待中' }, pid);
}

/* P1：给每张玩家视图补两样「不用猜」的东西。
 *  - lead：现在该干嘛（一句话）。有 view.lead 的游戏用自己的，没有就用通用话术。
 *  - prog：这是第几轮、场上还剩几个人 —— 玩家「一直点亮屏幕」的根源就是不知道进度。
 * 十三張视图共用这一层，游戏不用改；愿意写得更具体就自己给 lead。 */
function decorate(v, pid) {
  if (!v || v === null) return v;
  if (v.type === 'rules' || v.type === 'bet' || v.type === 'settle') return v;
  const alive = app.room.players.filter((p) => p.alive !== false).length;
  const round = app.room.game.round || 1;
  const playing = app.room.phase === 'playing';
  // 按控件类型给一句最贴身的话；同一句话套到词卡和抢答按钮上都别扭
  const BY_TYPE = {
    word: v.hold ? '按住看，看完就松手' : '看一眼就锁屏，别给旁边人看',
    choice: '选一个，然后确认',
    answer: '写下来，或者直接说出来',
    buzz: '手放在按钮上，准备抢',
    list: '照屏幕上的顺序来',
  };
  let lead = v.lead;
  if (!lead) {
    if (v.tone === 'active') lead = '轮到你了，照屏幕上的做';
    else if (playing && BY_TYPE[v.type]) lead = BY_TYPE[v.type];
    else if (playing) lead = '等下一步，先别扣手机';
    else lead = '';
  }
  const prog = playing ? `第 ${round} 轮 · 场上 ${alive} 人` : '';
  // P2：这局已经交了，就把话换成「还差几个人」，别让他反复点
  let done = false;
  const mine = app.room.players.find((p) => p.id === pid);
  if (playing && mine && mine.submitRound === round) {
    const left = app.room.players.filter(
      (p) => p.alive !== false && p.submitRound !== round
    ).length;
    done = true;
    lead = left ? `已提交，还差 ${left} 人` : '都交齐了，等主持人';
  }
  return Object.assign({}, v, { lead, prog, done });
}

function screenView() {
  const g = gameOf();
  const brief = briefOf();
  if (brief) {
    // 规则卡也要带二维码：选完游戏还有人陆续扫码进来，
    // 这时候把扫码页换掉、又不给码，后到的人就卡在门上了
    return {
      type: 'rules',
      ...brief,
      teams: app.room.teams,
      round: 0,
      qr: true,
    };
  }

  const st = settleScreenView();
  if (st) return st;

  const base = {
    type: 'podium',
    title: g ? g.name : '聚会游戏机',
    teams: app.room.teams,
    round: app.room.game.round,
  };
  if (!g || !g.screenView) return base;
  const v = safe(() => g.screenView(app.room, ctx('screen', {})), {});
  return Object.assign(base, v);
}

/* --------------------------------------------------------------- 推送 */

function hostSnapshot() {
  return {
    phase: app.room.phase,
    mode: app.room.mode,
    // 惩罚卡：卡片本身不是秘密，谁都能看
    card: punish.view(app.room),
    // 名场面：主持台显示最近几条，方便确认记没记上
    moments: (app.room.moments || []).slice(-5),
    punishMode: app.room.punishMode || 'clean',
    punishCustom: punish.customList(),
    judge: judge.view(app.room),
    // H4：只给主持台看，不进投屏、不进玩家视图
    remoteCode: (app.room.remote && app.room.remote.code) || '',
    // S4：倒计时给投屏和主持台各自本地渲染，不每秒推一次
    vote: app.room.vote && app.room.vote.dueAt
      ? { dueAt: app.room.vote.dueAt, expired: !!app.room.vote.expired, total: 60000 }
      : null,
    gameId: app.room.gameId,
    canStart: app.room.phase === 'lobby' && !!gameOf(),
    startName: gameOf() ? gameOf().name : '',
    round: app.room.game.round,
    timer: timerView(),
    players: app.room.players.map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      // 有 SSE 连接当然算在线；刚扫码还没连上、或者断线还在 45 秒宽限里的也算
      online: bus.isOnline(p.id) || p.online,
      awake: p.awake,
      headset: p.headset,
      score: p.score,
      alive: p.alive,
      away: p.online ? 0 : Date.now() - (p.lastSeen || Date.now()),
    })),
    teams: app.room.teams,
    log: app.room.log.slice(-40),
    track: app.room.track,
    audio: app.room.audio,
    media: app.media,
    sfx: app.sfx,
    brief: briefOf(),
    // 主持台要的这几块跟游戏无关，是「这一晚」层面的东西
    bet: bet.state(app.room),
    // 谁耳机里正在响（跨游戏的私密音效）。主持台要拿它显示「正在放」和停止键
    whisper: whisperView(),
    // 这一局走到哪一步（H1/H2 提词器）。lobby 阶段前端不显示
    cue: cue.state(app.room, gameOf()),
    fx: fx.list(),
    fxNow: app.room.fxNow || null,
    auto: Object.assign({}, app.room.auto),
    show: show.state(app.room),
    showTemplates: show.TEMPLATES.map((t) => ({ id: t.id, name: t.name, note: t.note })),
    settle: settleOf(),
    settleMeta: settleOf() ? settleMeta() : null,
    theme: app.room.theme,
    mode: app.room.mode,
    voice: !!(app.room.voice && app.room.voice.on),
    games: [...app.games.values()].map((g) => ({
      id: g.id,
      name: g.name,
      desc: g.desc || '',
      // 自动推进用哪个动作、多少秒，由游戏自己声明
      pacing: g.pacing || null,
    })),
    packs: packs.list().map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      count: p.items.length,
      custom: !!p.custom,
      own: p.ownCount || 0,
      hidden: p.hiddenCount || 0,
    })),
    panel: hostView(),
  };
}

function screenSnapshot() {
  const v = screenView();
  // 只放公开信息：比分、题面、票数。身份和私密词一律不许进来。
  return {
    ...v,
    teams: app.room.teams,
    timer: timerView(),
    round: app.room.game.round,
    gameName: gameOf() ? gameOf().name : '',
    phase: app.room.phase,
    count: app.room.players.length,
    online: app.room.players.filter((p) => bus.isOnline(p.id) || p.online).length,
    // 下注只报「几个人押了」，不报押的谁 —— 大屏写出来就没意思了
    bet: bet.state(app.room),
    moods: mood.recent(app.room),
    // 惩罚卡：投屏要显示（玩家端不需要，所以不进 playerView）
    card: punish.view(app.room),
    // 常驻仪式动作：投屏刷新/晚连上来时靠它补画面
    fxNow: app.room.fxNow || null,
    theme: app.room.theme,
    mode: app.room.mode,
    voice: !!(app.room.voice && app.room.voice.on),
    show: show.state(app.room),
  };
}

function push() {
  bus.sendHost({ t: 'sync', ...hostSnapshot() });
  bus.sendScreen({ t: 'screen', view: screenSnapshot() });
  for (const p of app.room.players) {
    if (!bus.isOnline(p.id)) continue;
    bus.sendPlayer(p.id, {
      t: 'view',
      view: playerView(p.id),
      timer: timerView(),
      round: app.room.game.round,
      theme: app.room.theme,
    });
  }
}

function pushHostOnly() {
  bus.sendHost({ t: 'sync', ...hostSnapshot() });
}

/* ----------------------------------------------------------- 游戏控制 */

/* 把所有人耳机里正在响的东西掐掉：私密音效 + 舞曲线。
 * 换游戏、整场重置、清空玩家、清存档都要走这里。
 * 只改服务端状态是没用的 —— 那台手机的耳机里会一直响到电池没电，
 * 而且它自己没有任何按钮能停（现场表现为「点了停止还在放」）。 */
function silenceAll() {
  for (const p of app.room.players) {
    bus.sendPlayer(p.id, { t: 'sfx_stop' });
    bus.sendPlayer(p.id, { t: 'beat', on: false });
  }
  // 服务端这边也得记住「已经没人响了」。不清的话，主持台上会一直显示
  // 「他耳机里正在放」，点停又停不掉一个早就不存在的声音。
  if (whisperTimer) {
    clearTimeout(whisperTimer);
    whisperTimer = null;
  }
  app.room.whisper = { id: null, sound: '', until: 0 };
}

/* ------------------------------------------------ 私密音效（跨游戏）
 *
 * 最早这是「耳返攻击」一个游戏的内部动作。后来发现它其实是件工具：
 * 谁在走神、谁在拖节奏，主持人随手往他耳机里放一段就够了，
 * 不必先开一局游戏。所以抽到 core，任何阶段都能用。
 *
 * 三条约束，都是现场踩出来的：
 *   1. 一场只能有一个人在响 —— 换人先停上一个；
 *   2. 12 秒自动收，别让一段声音一直缠着人家；
 *   3. 没戴耳机的人不给放 —— 那会变成全场公放，不是耳返攻击。 */

const WHISPER_MS = 12000;
let whisperTimer = null;

function sfxOptions() {
  return sfxlib.list(app.sfx, app.media);
}

function whisperView() {
  const w = app.room.whisper || {};
  const p = app.room.players.find((x) => x.id === w.id);
  return {
    id: w.id || null,
    name: p ? p.name : '',
    sound: w.sound || '',
    left: w.until ? Math.max(0, w.until - Date.now()) : 0,
  };
}

function whisperStop() {
  if (whisperTimer) {
    clearTimeout(whisperTimer);
    whisperTimer = null;
  }
  const w = app.room.whisper || {};
  if (w.id) bus.sendPlayer(w.id, { t: 'sfx_stop' });
  app.room.whisper = { id: null, sound: '', until: 0 };
  push();
  return { ok: true };
}

function whisper(id, sound) {
  const p = room.get(app.room, id);
  if (!p) throw new Error('先点一个人');
  if (!p.headset) throw new Error(`${p.name} 没戴耳机 —— 放出来就是全场公放`);
  const opts = sfxOptions();
  const pick = sfxlib.resolve(String(sound || ''), opts);
  if (!pick) {
    throw new Error('还没有能放的音效 —— 到右边「音频库」第二个上传口传一个，或者往曲库里放首歌');
  }
  // 换人之前先把上一个人停掉：不能先改 id 再停，那样上一台手机就没人管了
  if (whisperTimer) {
    clearTimeout(whisperTimer);
    whisperTimer = null;
  }
  const prev = app.room.whisper || {};
  if (prev.id && prev.id !== id) bus.sendPlayer(prev.id, { t: 'sfx_stop' });

  app.room.whisper = { id, sound: pick, until: Date.now() + WHISPER_MS };
  // duck: 真在放音乐的手机（舞蹈狼人杀）把这声压到 30%，别两条音轨打架
  bus.sendPlayer(id, { t: 'sfx', name: pick, duck: true });
  bus.sendPlayer(id, { t: 'toast', text: '耳机里有点东西' });
  room.addLog(app.room, `对 ${p.name} 的耳机放了一段「${sfxlib.label(pick, opts)}」`);
  whisperTimer = setTimeout(() => {
    whisperTimer = null;
    whisperStop();
  }, WHISPER_MS);
  push();
  return { ok: true };
}

function selectGame(id) {
  fxAutoClear('select');
  const g = app.games.get(id);
  if (!g) return { error: '没有这个游戏' };
  // 上一个游戏可能还有人在耳机里放着东西（耳返攻击），换游戏先全部掐掉。
  // 两路都要发：sfx_stop 管私密音效，beat:false 管舞蹈狼人杀那条舞曲线 ——
  // 只发前者的话，跳到一半换游戏，全场耳机里那首歌会一直循环下去，
  // 新界面上没有任何按钮能停它，只能挨个刷新页面。
  silenceAll();
  app.game = g;
  app.room.gameId = id;
  app.room.phase = 'lobby';
  room.softResetPlayers(app.room);
  // 1/5：选完游戏先把规则卡推上大屏，主持人讲完再点「开始」
  app.room.brief = { on: true, at: Date.now() };
  app.room.game = {
    id,
    state: g.init ? safe(() => g.init(app.room), {}) : {},
    round: 0,
    startedAt: 0,
    timer: null,
  };
  // 选完游戏立刻把规则打上投屏：这段文字主持人要照着念
  app.room.brief = { on: !!(g.rules && g.rules.length), at: Date.now() };
  // 上一局的结算页、下注、自动推进都不能跟到新游戏里
  app.room.settle = { on: false, stage: 'round', at: 0, gameId: null, name: '', scores: [], ms: 0 };
  bet.cancel(app.room);
  app.room.auto.on = false;
  room.addLog(app.room, `切换到「${g.name}」`);
  push();
  return { ok: true };
}

function startGame(cfg) {
  const g = gameOf();
  if (!g) return { error: '先选游戏' };
  if (typeof g.setup !== 'function') return { error: '这个游戏没有开局逻辑' };
  const live = app.room.players.filter((p) => p.online);
  if (live.length < (g.minPlayers || 2)) {
    return { error: `至少要 ${g.minPlayers || 2} 人在线` };
  }
  app.room.game.round += 1;
  // 新一局开始，所有人的「已提交」清零
  for (const p of app.room.players) p.submitRound = 0;
  app.room.game.startedAt = Date.now();
  app.room.game.timer = null;
  app.room.phase = 'playing';
  app.room.brief = { on: false, at: 0 };
  fxAutoClear('start');
  // 提词器从第一步开始。开局才算「这一局」，选游戏时不算
  cue.reset(app.room, g.id);
  try {
    g.setup(app.room, cfg || {}, ctx('host', cfg || {}));
  } catch (e) {
    console.log('  开局失败：', e.stack);
    return { error: '开局失败：' + e.message };
  }
  // 第一步就带仪式动作的（比如狼人杀的「发身份」），开局即演
  const first = cue.state(app.room, g);
  if (first && first.fx) fxFire(first.fx);
  push();
  return { ok: true };
}

function playerAction(action, pid, payload) {
  const g = gameOf();
  // 主持专用动作不能被玩家接口调到：加了 host_ 前缀的一律拦掉
  if (!g || !g.actions || !g.actions[action] || action.startsWith('host_') || action.startsWith('_')) {
    return { error: '没有这个动作' };
  }
  const p = room.get(app.room, pid);
  if (!p) return { error: '玩家不存在' };
  try {
    const r = g.actions[action](app.room, ctx(pid, payload));
    // 记一次动作：称号的「最忙的一双手」和复盘的参与度都靠它
    p.actN = (p.actN || 0) + 1;
    /* P2 完成态：这个动作是不是「交上去就算完」的（投票、猜、抢答）。
     * 由游戏自己声明 submitActions，core 只记账 —— 各游戏的「完成」语义
     * 差别太大，硬套一个通用判断会给出假状态。 */
    const subs = g.submitActions || [];
    if (subs.includes(action) && !(r && r.ok === false)) {
      p.submitRound = app.room.game.round;
    }
    push();
    return r || { ok: true };
  } catch (e) {
    console.log(`  动作 ${action} 失败：`, e.message);
    return { error: e.message };
  }
}

function hostAct(action, payload) {
  const g = gameOf();
  if (!g) return { error: '先选游戏' };
  const fn = g.actions && (g.actions[action] || g.actions['host_' + action]);
  if (!fn) return { error: '这个游戏没有该动作' };
  try {
    const c = ctx('host', payload);
    c.host = true;
    c.targetId = payload && payload.targetId;
    c.target = c.targetId ? room.get(app.room, c.targetId) : null;
    const r = fn(app.room, c);
    /* 规则卡收起来：主持人做了第一个真动作（发词开局 / 开始 / 放歌），
     * 就等于那句「我讲完了」。换词库、改人数这类配置动作不算，
     * 否则开局前调一下词库，大屏上的规则就没了。 */
    if (app.room.brief && app.room.brief.on && !CONFIG_ACT.test(action)) {
      app.room.brief.on = false;
    }
    push();
    return r || { ok: true };
  } catch (e) {
    console.log(`  主持动作 ${action} 失败：`, e.message);
    return { error: e.message };
  }
}

/* --------------------------------------------------- 围观下注（O1） */

function betOpen() {
  const r = bet.open(app.room);
  room.addLog(app.room, `开放围观下注（第 ${r.period} 轮）`);
  push();
  return r;
}

function betPick(pid, targetId) {
  const r = bet.pick(app.room, pid, targetId);
  if (r.error) return r;
  // 押注只推主持台：玩家那边自己会重画（选中态），
  // 全员推一遍会让所有人的手机闪一下
  pushHostOnly();
  return r;
}

function betClear() {
  bet.clear(app.room);
  room.addLog(app.room, '下注面板清空');
  push();
  return { ok: true };
}

function betSettle(winnerId) {
  const r = bet.settle(app.room, winnerId);
  if (r.error) return r;
  room.addLog(
    app.room,
    `下注结算：${r.winner} 赢 · ${r.hits.length ? r.hits.join('、') + ' 押中' : '没人押中'}`
  );
  push();
  return r;
}

function betCancel() {
  bet.cancel(app.room);
  room.addLog(app.room, '取消下注');
  push();
  return { ok: true };
}

/* --------------------------------------------------- 空档表情（O4） */

function moodAdd(pid, emoji) {
  const r = mood.add(app.room, pid, emoji);
  if (r.error) return r;
  // 走独立事件而不是整屏重绘：重绘会把正在飘的那几个打断，
  // 现场看到的就是「表情一卡一卡的」
  bus.sendScreen({ t: 'mood', list: mood.recent(app.room) });
  return r;
}

/* --------------------------------------------------- 自动推进（O2）
 *
 * 只在主持人明确打开时动，而且每次自动执行都写日志。
 * 自动点错一步最多毁一局，所以要能一眼看出「刚才那下是机器点的」。 */

function autoOn(sec) {
  const g = gameOf();
  const pacing = g && g.pacing;
  if (!pacing || !pacing.action) return { error: '这个游戏没配自动推进' };
  const s = Math.max(5, Math.min(180, Number(sec) || pacing.sec || 30));
  app.room.auto = {
    on: true,
    action: pacing.action,
    label: pacing.label || '下一步',
    sec: s,
    dueAt: Date.now() + s * 1000,
    runs: 0,
    fails: 0,
  };
  room.addLog(app.room, `自动推进：每 ${s} 秒点一次「${app.room.auto.label}」`);
  push();
  return { ok: true };
}

function autoOff() {
  const was = app.room.auto.on;
  app.room.auto = { on: false, action: '', label: '', sec: app.room.auto.sec || 30, dueAt: 0, runs: 0, fails: 0 };
  if (was) room.addLog(app.room, '自动推进关掉了');
  push();
  return { ok: true };
}

/* --------------------------------------------------- 本局结算（O5）
 *
 * 「本局结束」不看游戏自己有没有结算页 —— 14 个游戏的结算时机各不相同，
 * 有的自动跳、有的要主持人点摊牌。统一在这里收：主持人觉得这局完了，
 * 就点一下，全场同一页。 */

function settleRound() {
  if (settleOf()) return { error: '已经在结算页了' };
  const g = gameOf();
  const startedAt = app.room.game.startedAt || Date.now();
  const ms = Math.max(0, Date.now() - startedAt);

  const scores = app.room.players
    .map((p) => ({ id: p.id, name: p.name, score: p.score || 0, betScore: p.betScore || 0 }))
    .sort((a, b) => b.score - a.score);

  // 先记历史：这一局的分马上就会被下一局清掉，
  // 等结算完再记就只剩 0 了
  stats.record(app.room, { gameId: app.room.gameId, name: g ? g.name : '', ms });

  app.room.settle = {
    on: true,
    stage: 'round',
    at: Date.now(),
    gameId: app.room.gameId,
    name: g ? g.name : '',
    ms,
    scores,
  };
  // 结算了就没人还有下一步，自动推进必须先停
  app.room.auto.on = false;
  room.addLog(app.room, `本局结束：${g ? g.name : ''}（${Math.round(ms / 60000)} 分钟）`);
  push();
  return { ok: true };
}

/* 7：再来一局。失败时不能把主持人扔在「playing 但没开局」的中间态 ——
 * 退回到「已选游戏、还没开始」，把规则卡重新推上大屏、开始按钮也回来。 */
function backToLobby(reason) {
  app.room.phase = 'lobby';
  app.room.brief = { on: !!(gameOf() && gameOf().rules && gameOf().rules.length), at: Date.now() };
  room.addLog(app.room, `重开失败：${reason}，回到开局前`);
  push();
}

function settleAgain() {
  if (!app.game) return { error: '先选游戏' };
  const meta = settleMeta();
  if (!meta.canAgain) {
    backToLobby(`还差 ${meta.short} 人（需要 ${meta.need} 人，现在 ${meta.online} 人）`);
    return { error: `还差 ${meta.short} 人，已退回开局前` };
  }
  app.room.settle = { on: false, stage: 'round', at: 0, gameId: null, name: '', scores: [], ms: 0 };
  bet.cancel(app.room);
  app.room.auto.on = false;
  room.softResetPlayers(app.room);
  const r = startGame({});
  if (r.error) {
    backToLobby(r.error);
    return { error: r.error + '（已退回开局前）' };
  }
  return r;
}

/* 7：误点「本局结束」时能退回去。
 * 只关覆盖层，不动游戏状态，也不回滚已经记下的历史分。 */
function settleCancel() {
  if (!settleOf()) return { error: '现在不在结算页' };
  app.room.settle = { on: false, stage: 'round', at: 0, gameId: null, name: '', scores: [], ms: 0 };
  room.addLog(app.room, '取消结算，回到本局');
  push();
  return { ok: true };
}

function settleSwitch() {
  app.room.settle = { on: false, stage: 'round', at: 0, gameId: null, name: '', scores: [], ms: 0 };
  bet.cancel(app.room);
  app.room.auto.on = false;
  app.room.brief = { on: false, at: 0 };
  app.game = null;
  app.room.gameId = null;
  app.room.phase = 'lobby';
  app.room.game = { id: null, state: {}, round: 0, startedAt: 0, timer: null };
  room.addLog(app.room, '换一个游戏');
  push();
  return { ok: true };
}

/* 收工：把今晚的累计榜 + 称号打上投屏。
 * 用 history 累加，不用 player.score —— 那个是「这一局」的分，
 * 每局开头都会清。 */
function settleWrap() {
  if (!settleOf()) {
    const r = settleRound();
    if (r.error) return r;
  }
  const board = titles.cumulative(app.room);
  const s = app.room.settle;
  s.stage = 'board';
  s.board = board;
  s.name = `今晚共 ${app.room.history.length} 局`;
  room.addLog(app.room, '今晚收工');
  push();
  return { ok: true };
}

/* -------------------------------------------------------- 皮肤（O10） */

/* 综艺 / 比赛（7.1）：只影响显示与称号，不动计分逻辑。
 * 分照加，只是不摆出来 —— 中途切回比赛，数据是连续的。 */
function setMode(name) {
  const m = String(name || '');
  if (m !== 'variety' && m !== 'match') return { error: '只有 variety / match' };
  app.room.mode = m;
  room.addLog(app.room, m === 'variety' ? '切到综艺模式（不摆分数）' : '切到比赛模式（比分上屏）');
  push();
  return { ok: true, mode: m };
}

function setTheme(name) {
  app.room.theme = name === 'festive' ? 'festive' : 'night';
  room.addLog(app.room, `皮肤：${app.room.theme === 'festive' ? '过年' : '日常'}`);
  push();
  return { ok: true, theme: app.room.theme };
}

/* ---------------------------------------------------- 语音播报（O8）
 *
 * 声音从主持台 / 投屏那台电脑的浏览器出（speechSynthesis），
 * 不走玩家耳机 —— 那是「全场都能听见」的那一路，和私密音效是两回事。 */

function setVoice(on) {
  app.room.voice = { on: !!on };
  push();
  return { ok: true, on: !!on };
}

function voiceSay(text) {
  const t = String(text || '').slice(0, 40);
  if (!t) return { error: '要说什么' };
  if (!app.room.voice || !app.room.voice.on) return { error: '语音播报没打开' };
  bus.sendHost({ t: 'say', text: t });
  bus.sendScreen({ t: 'say', text: t });
  return { ok: true };
}

/* 内部用：到点自动播一句，没开就什么都不做 */
function say(text) {
  if (!app.room.voice || !app.room.voice.on) return;
  bus.sendHost({ t: 'say', text });
  bus.sendScreen({ t: 'say', text });
}

/* ------------------------------------------------------ 节目单（O11） */

function showLoad(id) {
  const r = show.load(app.room, id);
  room.addLog(app.room, `节目单：${r.show.name}`);
  push();
  return r;
}

/* ---------------------------------------------- 手机遥控（H4）

/* 主持人在手机上只做「点一下」的事。这里不放任何破坏性操作：
 * 换游戏、清空玩家、重置比分都不在遥控的权限里 —— 遥控只有一个用途：
 * 让人站在屋子中间也能推进流程。 */
const REMOTE_FX = ['deal', 'dead', 'reveal', 'hush', 'countdown', 'bigtext'];
const REMOTE_TTL = 4 * 60 * 60 * 1000;

/* ------------------------------------------------------------ P0 裁决台 */

function judgeOpen(label) {
  judge.open(app.room, label);
  room.addLog(app.room, `开裁决：${label || '本局'}`);
  push();
  return { ok: true, judge: judge.view(app.room) };
}

function judgeClose() {
  judge.close(app.room);
  room.addLog(app.room, '裁决结束');
  push();
  return { ok: true };
}

function judgeSelect(pid) {
  const r = judge.select(app.room, pid);
  if (!r.error) pushHostOnly();
  return r;
}

function judgeNext() {
  judge.next(app.room);
  pushHostOnly();
  return { ok: true };
}

/* 记一次判定：错了不扣分，对了加多少由游戏自己决定（judge 钩子）。
 * 没有钩子的游戏只记一条日志 —— 底座不替游戏定分数。 */
function judgePick(pid, ok) {
  const p = room.get(app.room, pid);
  if (!p) return { error: '没有这个人' };
  const g = gameOf();
  const r = judge.record(app.room, pid, ok);
  if (r.error) return r;
  const hook = g && typeof g.judge === 'function'
    ? safe(() => g.judge(app.room, pid, !!ok, ctx('host', {})), null)
    : null;
  judge.tap(p);
  room.addLog(app.room, `${p.name} ${ok ? '判对' : '判错'}${hook && hook.points ? ` +${hook.points}` : ''}`);
  push();
  return { ok: true, name: p.name, actN: p.actN, hook: hook || null };
}

/* 打点：不算分，只记「动过一次手」（称号与复盘参与度吃这个） */
function tapPlayer(pid) {
  const p = room.get(app.room, pid);
  const r = judge.tap(p);
  if (r.error) return r;
  pushHostOnly();
  return { ok: true, name: p.name, actN: r.actN };
}

/* 7.2 名场面：一句话记下刚才那段。最多留 40 条，多了丢最早的。 */
function momentAdd(text) {
  const t = String(text || '').trim().slice(0, 40);
  if (!t) return { error: '先写一句' };
  const g = gameOf();
  const m = {
    id: crypto.randomBytes(4).toString('hex'),
    at: Date.now(),
    gameId: app.room.gameId || '',
    gameName: g ? g.name : '',
    round: app.room.game.round || 0,
    text: t,
  };
  app.room.moments.push(m);
  while (app.room.moments.length > 40) app.room.moments.shift();
  room.addLog(app.room, `记下名场面：${t}`);
  push();
  return { ok: true, moment: m };
}

/* 自定义惩罚卡：增删都落 packs/_punish.json，和词库一个路子。 */
function punishAdd(input) {
  const r = punish.addCard(input || {});
  if (r.error) return r;
  room.addLog(app.room, `加了一张惩罚卡：${r.card.title}`);
  push();
  return r;
}

function punishDel(id) {
  const r = punish.removeCard(id);
  if (r.error) return r;
  room.addLog(app.room, '删了一张惩罚卡');
  push();
  return r;
}

/* 抽一张惩罚卡：投屏出卡片，8 秒后自己撤。不改任何人的分数。 */
function punishDraw() {
  const r = punish.draw(app.room);
  room.addLog(app.room, `惩罚卡：${r.card.title}`);
  push();
  return r;
}

/* 惩罚卡口径切换：clean 清爽 / bar 酒桌。切完下一张生效，不回溯已经抽过的。 */
function punishMode(mode) {
  const r = punish.setMode(app.room, String(mode || ''));
  if (r.error) return r;
  room.addLog(app.room, `惩罚卡切到${r.label}`);
  push();
  return r;
}

function remoteNew() {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  app.room.remote = { code, at: Date.now() };
  room.addLog(app.room, '生成了新的遥控码');
  push();
  return { ok: true, code };
}

function remoteCheck(code) {
  const r = app.room.remote || {};
  if (!r.code) return { error: '还没生成遥控码' };
  if (Date.now() - (r.at || 0) > REMOTE_TTL) return { error: '遥控码过期了，重新生成一个' };
  if (String(code || '') !== r.code) return { error: '码不对' };
  return { ok: true };
}

function remoteView(code) {
  const c = remoteCheck(code);
  if (c.error) return c;
  const g = gameOf();
  const panel = g ? safe(() => g.hostView(app.room, ctx('host', {})), null) : null;
  const controls = ((panel && panel.controls) || [])
    .filter((x) => x && x.kind === 'btn' && String(x.action || '').startsWith('host_'))
    .slice(0, 4)
    .map((x) => ({ action: x.action, label: x.label || x.action }));
  return {
    ok: true,
    phase: app.room.phase,
    gameName: g ? g.name : '',
    cue: cue.state(app.room, g),
    vote: app.room.vote && app.room.vote.dueAt ? { dueAt: app.room.vote.dueAt, expired: !!app.room.vote.expired } : null,
    controls,
    mode: app.room.mode,
  };
}

function remoteAct(code, cmd, payload) {
  const c = remoteCheck(code);
  if (c.error) return c;
  const p = payload || {};
  switch (String(cmd || '')) {
    case 'cue/next':
      return cueNext();
    case 'cue/skip':
      return cueSkip();
    case 'cue/again':
      return cueAgain();
    case 'show/next':
      return showNext();
    case 'fx/fire': {
      const name = String(p.name || '');
      if (!REMOTE_FX.includes(name)) return { error: '遥控不能放这个动作' };
      return fxFire(name, p.arg);
    }
    case 'game/act': {
      const action = String(p.action || '');
      // 只放开 host_ 前缀：玩家的动作、破坏性动作都不在遥控权限里
      if (!action.startsWith('host_')) return { error: '遥控不能执行这个动作' };
      return hostAct(action, p.payload || {});
    }
    default:
      return { error: '遥控不认识这个指令' };
  }
}

/* ---------------------------------------------- 提词器（H1 / H2） */

function cueStep(delta, skip) {
  const g = gameOf();
  if (!g) return { error: '先选游戏' };
  const st = cue.step(app.room, g, delta);
  room.addLog(app.room, `${skip ? '跳过一步' : '下一步'}：${st.cue}`);
  // 这一步声明了仪式动作，就顺手放出来 —— 脚本只用名字引用，动画由 core 统一实现
  if (st.fx) fxFire(st.fx);
  push();
  return Object.assign({ ok: true }, st);
}

function cueNext() {
  return cueStep(1, false);
}

function cueSkip() {
  return cueStep(1, true);
}

/* 仪式动作：投屏出动画，主持机出声。
 * 声音只从这台电脑出去 —— 投屏那条红线是「永不发声」。 */
function fxFire(name, arg) {
  const p = fx.payload(name, arg);
  if (p.error) return p;
  bus.sendScreen({ t: 'fx', name: p.id, arg: p.arg, ms: p.ms });
  bus.sendHost({ t: 'fx', name: p.id, arg: p.arg, ms: p.ms });
  // 常驻动作记在房间里：投屏晚连上来也能补上，主持人也有「撤掉」可按
  app.room.fxNow = p.ms > 0 ? null : { name: p.id, arg: p.arg, at: Date.now() };
  room.addLog(app.room, `仪式动作：${p.label}${p.arg ? '「' + p.arg + '」' : ''}`);
  pushHostOnly();
  return { ok: true, id: p.id, label: p.label };
}

/* 撤掉常驻动作。倒计时不用它 —— 那个自己有终点。 */
function fxClear() {
  const had = app.room.fxNow;
  app.room.fxNow = null;
  bus.sendScreen({ t: 'fx', clear: true });
  bus.sendHost({ t: 'fx', clear: true });
  if (had) room.addLog(app.room, '撤掉仪式动作');
  pushHostOnly();
  return { ok: true };
}

/* 防挡：换游戏、开新局、结算时自动把常驻动作收掉，
 * 否则主持人忘了关，下一局开场就是一块黑屏。 */
function fxAutoClear(reason) {
  if (!app.room.fxNow) return;
  app.room.fxNow = null;
  bus.sendScreen({ t: 'fx', clear: true });
  bus.sendHost({ t: 'fx', clear: true });
}

/* 「再说一遍」：不改进度，只把这句话交回给主持台（它会念 / 弹出来） */
function cueAgain() {
  const g = gameOf();
  if (!g) return { error: '先选游戏' };
  const st = cue.state(app.room, g);
  return { ok: true, cue: st.cue, say: st.say, index: st.index, total: st.total };
}

function showNext() {
  const r = show.next(app.room);
  if (r.error) return r;
  const it = r.item;
  room.addLog(app.room, `节目单 ${r.index + 1}/${r.total}：${it.label}`);
  if (it.gameId) {
    const sel = selectGame(it.gameId);
    if (sel.error) return sel;
  } else {
    // 惩罚 / 收尾这种没有游戏的环节：清空游戏，让投屏出大字
    app.game = null;
    app.room.gameId = null;
    app.room.phase = 'lobby';
    app.room.brief = { on: false, at: 0 };
    app.room.game = { id: null, state: {}, round: 0, startedAt: 0, timer: null };
    push();
  }
  return { ok: true, item: it, index: r.index, total: r.total, done: r.done };
}

/* ------------------------------------------------------ 复盘（O12） */

function reviewData() {
  const r = stats.review(app.room);
  return Object.assign({ ok: true }, r, { csv: '' });
}

function reviewCsv() {
  return { ok: true, csv: stats.toCsv(app.room) };
}

/* --------------------------------------------------------- 主持杂项 */

function setTeam(pid, team) {
  const p = room.get(app.room, pid);
  if (!p) return { error: 'no player' };
  p.team = ['A', 'B', null].includes(team) ? team : null;
  push();
  return { ok: true };
}

/* 一键分组 / 重新分组 */
function groupTeams(mode) {
  if (!app.room.players.length) return { error: '还没有人进来' };
  room.group(app.room, mode === 'shuffle' ? 'shuffle' : 'seq');
  const a = app.room.players.filter((p) => p.team === 'A').length;
  room.addLog(app.room, `分组：A ${a} 人 / B ${app.room.players.length - a} 人`);
  push();
  return { ok: true };
}

function clearTeams() {
  room.clearTeams(app.room);
  room.addLog(app.room, '取消分组');
  push();
  return { ok: true };
}

/* 手动清掉离线的人（老早走掉、锁屏后再没回来的那种）。
 * 局中自动清人是被拦住的，所以这里必须 force —— 主持人点了就说明
 * 他知道那个人真走了，不该再被 O6 的保护挡住。 */
function pruneOffline() {
  const gone = room.pruneOffline(app.room, 0, { force: true });
  if (gone.length) room.addLog(app.room, `清掉离线：${gone.map((p) => p.name).join('、')}`);
  push();
  return { ok: true, removed: gone.length };
}

function kick(pid) {
  const p = room.get(app.room, pid);
  if (!p) return { error: 'no player' };
  bus.sendPlayer(pid, { t: 'kicked', reason: 'byHost' });
  room.remove(app.room, pid);
  room.addLog(app.room, `${p.name} 被移出`);
  push();
  return { ok: true };
}

function score(pid, delta) {
  room.addScore(app.room, pid, Number(delta) || 0);
  push();
  return { ok: true };
}

function teamScore(team, delta) {
  room.addTeamScore(app.room, team, Number(delta) || 0);
  push();
  return { ok: true };
}

// 直接改成某个分数（现场常见的「这轮算 5 分」比连点加号快）
function setTeamScore(team, score) {
  if (!app.room.teams[team]) return { error: 'no team' };
  const n = Number(score);
  if (!isFinite(n)) return { error: '要填数字' };
  app.room.teams[team].score = Math.max(0, Math.round(n));
  push();
  return { ok: true };
}

function teamName(team, name) {
  if (!app.room.teams[team]) return { error: 'no team' };
  app.room.teams[team].name = String(name || '').slice(0, 10) || team + ' 队';
  push();
  return { ok: true };
}

function resetAll() {
  const keep = app.room.players;
  // 先掐声音：耳返攻击正在放的时候点「整场重置」，
  // 如果只重置状态，那台手机会一直响到自己停
  silenceAll();
  Object.assign(app.room, room.createRoom());
  app.room.players = keep;
  for (const p of keep) {
    p.score = 0;
    p.alive = true;
    p.team = null;
  }
  app.game = null;
  app.room.gameId = null;
  persist.save(app.room);
  room.addLog(app.room, '整场重置');
  push();
  return { ok: true };
}

// 换一批人：所有人退出房间，需要重新扫码
function kickAll() {
  // 掐声音必须发生在「人还在」的时候 —— 清完 players 就没人可通知了
  silenceAll();
  for (const p of app.room.players) bus.sendPlayer(p.id, { t: 'kicked', reason: 'byHost' });
  // 必须原地改：快照定时器持有的是这个对象的引用
  Object.assign(app.room, room.createRoom());
  app.game = null;
  persist.save(app.room);
  room.addLog(app.room, '已清空所有玩家');
  push();
  return { ok: true };
}

/* ----------------------------------------------------------- 公共音频 */

/* 4：可以从某一秒开始播（截掉前面的前奏/废话）。
 * 传了 fromSec 就把它当成新的起点，不传就接着上次暂停的位置。 */
function audioPlay(fromSec) {
  const a = app.room.audio;
  const n = Number(fromSec);
  if (Number.isFinite(n) && n >= 0) a.elapsedMs = Math.min(30 * 60, n) * 1000;
  a.phase = 'playing';
  a.startAt = Date.now();
  bus.sendHost({ t: 'audio', op: 'play', fromMs: a.elapsedMs, bpm: a.bpm, track: app.room.track });
  pushHostOnly();
  return { ok: true };
}

function audioPause() {
  const a = app.room.audio;
  if (a.phase === 'playing') a.elapsedMs = Date.now() - a.startAt;
  a.phase = 'paused';
  bus.sendHost({ t: 'audio', op: 'pause' });
  pushHostOnly();
  return { ok: true };
}

function audioStop() {
  const a = app.room.audio;
  a.phase = 'idle';
  a.elapsedMs = 0;
  a.startAt = 0;
  bus.sendHost({ t: 'audio', op: 'stop' });
  pushHostOnly();
  return { ok: true };
}

function audioBpm(bpm) {
  app.room.audio.bpm = Math.min(180, Math.max(80, Number(bpm) || 122));
  bus.sendHost({ t: 'audio', op: 'bpm', bpm: app.room.audio.bpm });
  pushHostOnly();
  return { ok: true };
}

function selectTrack(id) {
  if (!id || id === 'synth') {
    app.room.track = { kind: 'synth', id: null, name: '内置节拍' };
  } else {
    const m = app.media.find((x) => x.id === id);
    if (!m) return { error: '没有这首' };
    app.room.track = { kind: 'file', id: m.id, name: m.name };
  }
  if (app.room.audio.phase === 'playing') {
    app.room.audio.startAt = Date.now();
    app.room.audio.elapsedMs = 0;
    bus.sendHost({
      t: 'audio',
      op: 'play',
      fromMs: 0,
      bpm: app.room.audio.bpm,
      track: app.room.track,
    });
  }
  pushHostOnly();
  return { ok: true };
}

function setMedia(list) {
  app.media = list;
}

function setSfx(list) {
  app.sfx = list;
}

/* --------------------------------------------------------------- 心跳 */

let tickN = 0;
let spokenEnd = 0; // 已经播过「时间到」的那个截止时刻，别每秒播一次
setInterval(() => {
  const now = Date.now();
  let dirty = false;
  // 在线的人随时刷新 lastSeen：这样「离线多久」是从他真正断开算起的，
  // 而不是从他扫码那一刻算起 —— 不然坐了两小时的人一重启就被清掉。
  for (const p of app.room.players) {
    if (bus.isOnline(p.id)) {
      p.lastSeen = now;
      if (!p.online) {
        p.online = true;
        dirty = true;
      }
    }
  }
  const g = gameOf();
  /* S4：进入投票阶段就起一个 60 秒倒计时，退出就清掉。
   * 游戏只声明「现在是不是在投票」，倒计时是 core 的事。 */
  const voting = !!(g && g.voteOpen && safe(() => g.voteOpen(app.room), false));
  const v = app.room.vote || { dueAt: 0, expired: false };
  if (voting && !v.dueAt) {
    app.room.vote = { dueAt: now + 60000, expired: false };
    room.addLog(app.room, '投票开始，60 秒');
    dirty = true;
  } else if (!voting && v.dueAt) {
    app.room.vote = { dueAt: 0, expired: false };
    dirty = true;
  } else if (voting && v.dueAt && !v.expired && now >= v.dueAt) {
    app.room.vote = { dueAt: v.dueAt, expired: true };
    room.addLog(app.room, '投票超时，没投的算弃权');
    dirty = true;
  }

  if (g && typeof g.tick === 'function') {
    // 第三个参数是上下文：游戏要主动发消息（比如耳返到点自动停）时用得上
    const changed = safe(() => g.tick(app.room, now, ctx('sys', {})), false);
    if (changed) push();
  }

  /* ------------------------------------------------ 自动推进（O2）
   * 到点替主持人点一下「下一步」。三条保险：
   * 结算了 / 不在局中 / 动作不存在 —— 任何一种都直接停，
   * 不能让它在后台空转点出一个接一个的错误。 */
  const a = app.room.auto;
  if (a && a.on) {
    if (app.room.phase !== 'playing' || settleOf()) {
      a.on = false;
    } else if (!a.dueAt) {
      a.dueAt = now + a.sec * 1000;
    } else if (now >= a.dueAt) {
      const fn = g && g.actions && (g.actions[a.action] || g.actions['host_' + a.action]);
      if (!fn) {
        a.on = false;
        room.addLog(app.room, '自动推进停了：这个游戏没有该动作');
      } else {
        a.dueAt = now + a.sec * 1000;
        const r = hostAct(a.action, {});
        if (r && r.error) {
          a.fails = (a.fails || 0) + 1;
          // 连错三次说明现在不该点（还没发词、还没投票），停下来交回人手
          if (a.fails >= 3) {
            a.on = false;
            room.addLog(app.room, `自动推进停了：${r.error}`);
          }
        } else {
          a.fails = 0;
          a.runs = (a.runs || 0) + 1;
          room.addLog(app.room, `自动：${a.label}（第 ${a.runs} 次）`);
        }
        pushHostOnly();
      }
    }
  }

  /* 计时到点播一句「时间到」。
   * 只在语音播报打开时出声，但标记照样记 —— 关了再开不该补播历史。 */
  const tv = timerView();
  if (tv && tv.endsAt && now >= tv.endsAt && spokenEnd !== tv.endsAt) {
    spokenEnd = tv.endsAt;
    say('时间到');
  }

  // 每 10 秒把在线状态刷一次给主持台，防止某些机型掉线不报
  if (++tickN % 20 === 0) pushHostOnly();
  if (dirty && tickN % 4 === 0) pushHostOnly();
}, 500);

/* ------------------------------------------------------------- 导出 */

module.exports = {
  app,
  games: app.games,
  push,
  pushHostOnly,
  selectGame,
  startGame,
  playerAction,
  hostAct,
  setTeam,
  groupTeams,
  clearTeams,
  pruneOffline,
  kick,
  score,
  teamScore,
  setTeamScore,
  teamName,
  resetAll,
  kickAll,
  silenceAll,
  audioPlay,
  audioPause,
  audioStop,
  audioBpm,
  selectTrack,
  setMedia,
  setSfx,
  mediaList: () => app.media,
  hostSnapshot,
  screenSnapshot,
  playerView,
  timerView,
  gameOf,
  briefOf,
  showBrief,
  hideBrief,
  // O1 / O2 / O4 / O5 / O8 / O10 / O11 / O12
  betOpen,
  betPick,
  betSettle,
  betClear,
  betCancel,
  moodAdd,
  // 跨游戏的私密音效（原耳返攻击）
  whisper,
  whisperStop,
  whisperView,
  autoOn,
  autoOff,
  settleRound,
  settleAgain,
  settleCancel,
  settleSwitch,
  settleWrap,
  setTheme,
  setMode,
  setVoice,
  voiceSay,
  showLoad,
  showNext,
  punishDraw,
  punishMode,
  punishAdd,
  punishDel,
  judgeOpen,
  judgeClose,
  judgeSelect,
  judgeNext,
  judgePick,
  tapPlayer,
  momentAdd,
  remoteNew,
  remoteView,
  remoteAct,
  cueNext,
  cueSkip,
  cueAgain,
  fxFire,
  fxClear,
  reviewData,
  reviewCsv,
  newId: () => crypto.randomBytes(6).toString('hex'),
};
