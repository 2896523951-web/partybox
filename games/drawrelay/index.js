'use strict';

/* 接力猜词：节目第二季那个粤语版你画我猜。
 *
 * 一个人画，下一个人看着画用方言描述，再下一个人照着描述画……
 * 一路歪下去，最后一个人猜。
 *
 * 画画在纸上，描述靠嘴 —— 手机只做三件事：
 * 谁该看了、谁该说了、还剩多久。一旦允许打字，这游戏立刻变成复制粘贴。 */

const packs = require('../../core/packs');
const T = require('../../core/text');

const PACKS = () => packs.usable('word');
const DIALECTS = ['粤语', '贵州话', '东北话', '四川话', '上海话', '家乡话'];

function init() {
  return {
    packId: (PACKS()[0] || {}).id || 'idiom',
    dialect: '粤语',
    durationSec: 120,
    phase: 'idle', // idle | pick | run | guess | done
    order: [],
    pickedAt: {}, // 挑棒次的时间，先到先得
    idx: 0,
    word: '',
    hint: '',
    used: [],
    results: [],
    lastResult: '',
    // 队伍数据：猜对 / 没猜中，按「最后一棒」所在的队记
    teamStats: { A: { ok: 0, bad: 0 }, B: { ok: 0, bad: 0 } },
    history: [], // [{ round, word, ok, team }]
  };
}

function ensureStats(s) {
  if (!s.teamStats || !s.teamStats.A) s.teamStats = { A: { ok: 0, bad: 0 }, B: { ok: 0, bad: 0 } };
  if (!Array.isArray(s.history)) s.history = [];
}

/* C1：补位并开始。
 * 空位随机分给还没上场的在线玩家 —— 不选的人也有位置，不惩罚性安排。 */
function beginRun(room, c) {
  const s = room.game.state;
  const live = room.players.filter((p) => p.online);
  const seated = s.order.filter(Boolean);
  const rest = packs.shuffle(live.filter((p) => !seated.includes(p.id)).map((p) => p.id));
  for (let i = 0; i < s.order.length; i += 1) {
    if (!s.order[i]) s.order[i] = rest.shift() || '';
  }
  s.idx = 0;
  s.phase = 'run';
  room.game.timer = {
    endsAt: Date.now() + s.durationSec * 1000,
    label: `第 ${room.game.round} 题`,
    total: s.durationSec,
  };
  c.log(`开始 · ${s.word}（${s.dialect}）`);
}

// 第 1 棒画，最后一棒猜，中间都是「看画 / 说话」交替
function kindAt(i, total) {
  if (i === 0) return 'draw';
  if (i === total - 1) return 'guess';
  return i % 2 === 1 ? 'say' : 'draw';
}

function nameOf(room, id) {
  const p = room.players.find((x) => x.id === id);
  return p ? p.name : '？';
}

module.exports = {
  id: 'drawrelay',
  name: '接力猜词',
  desc: '画一张 → 用方言描述 → 再画一张 → 一路歪下去 → 最后一个人猜。',
  minPlayers: 3,
  // 自动推进：主持台那颗「开自动」到点会替主持人点这个动作。
  // 只挑「点了不会毁局」的那个 —— 狼人杀那种一步错满盘皆输的流程不配。
  pacing: { action: 'host_next', label: '新一轮', sec: 60 },
  slogan: '画一张、说一段，越传越歪',
  // 开局前打上投屏的 3 条规则。大屏、玩家手机、主持台共用这一份，
  // 别在别处再抄一遍 —— 改了规则只改这里。
  rules: [
    '第 1 棒画，第 2 棒方言描述，画说交替往下传',
    '方言是强制的，不会说也要硬说',
    '最后一棒只看最后一张画，猜对 +3、首棒 +1',
  ],

  init,

  setup(room, cfg, c) {
    const s = room.game.state;
    const live = room.players.filter((p) => p.online);
    if (live.length < 3) throw new Error('至少要 3 个人在线');

    if (cfg.packId) s.packId = cfg.packId;
    if (cfg.dialect) s.dialect = cfg.dialect;
    if (cfg.durationSec) s.durationSec = Math.min(300, Math.max(30, Number(cfg.durationSec) || 120));

    const item = packs.pick(s.packId, new Set(s.used));
    // C1：开局先给一排空位，谁想站哪棒自己点；没人点就由主持人补位
    // 2：开局前挑过的棒次沿用
    if (!(s.phase === 'pick' && s.order.length === live.length)) {
      s.order = live.map(() => '');
      s.pickedAt = {};
    }
    s.idx = 0;
    s.word = item ? item.w : '打草惊蛇';
    s.hint = item ? item.hint || '' : '';
    s.used = [...s.used, s.word].slice(-40);
    s.phase = 'pick';
    s.lastResult = '';
    room.game.timer = null;
    c.log(`第 ${room.game.round} 题 · 先挑棒次（${s.order.length} 棒）`);
  },

  actions: {
    // C1：自己挑棒次。先到先得，挑满了自动开始；位置换了会释放原来那一棒。
    pick(room, c) {
      const s = room.game.state;
      if (s.phase === 'idle') {
        const live = room.players.filter((p) => p.online);
        s.order = live.map(() => '');
        s.pickedAt = {};
        s.phase = 'pick';
      }
      if (s.phase !== 'pick') throw new Error('已经开始了');
      const slot = Number(c.payload.targetId) - 1;
      if (!(slot >= 0 && slot < s.order.length)) throw new Error('没这个棒次');
      if (s.order[slot] && s.order[slot] !== c.pid) throw new Error('这一棒被抢了');
      const old = s.order.indexOf(c.pid);
      if (old >= 0) s.order[old] = '';
      s.order[slot] = c.pid;
      s.pickedAt[c.pid] = Date.now();
      c.sfx(c.pid, 'ding');
      if (!s.order.includes('')) beginRun(room, c);
      return { ok: true, slot: slot + 1 };
    },

    handover(room, c) {
      const s = room.game.state;
      if (s.phase !== 'run') throw new Error('现在不能交接');
      if (s.order[s.idx] !== c.pid) throw new Error('还没轮到你');
      if (s.idx >= s.order.length - 1) throw new Error('你是最后一棒');
      s.idx += 1;
      const p = room.players.find((x) => x.id === s.order[s.idx]);
      c.log(`${p ? p.name : '?'} 接棒`);
      if (s.idx === s.order.length - 1) {
        s.phase = 'guess';
        c.sfxAll('ding');
      }
      return { ok: true, idx: s.idx };
    },

    guess(room, c) {
      const s = room.game.state;
      if (s.phase !== 'guess') throw new Error('还没传到你');
      if (s.order[s.order.length - 1] !== c.pid) throw new Error('不是你猜');
      const text = String(c.payload.text || '').trim();
      if (!text) throw new Error('写点什么');
      if (!T.match(text, s.word)) return { ok: true, correct: false };
      finish(room, c, true);
      return { ok: true, correct: true };
    },

    // ---- 主持 ----
    host_next(room, c) {
      const s = room.game.state;
      // 还在挑棒次：这一下是「补位并开始」，不是换题
      if (s.phase === 'pick') {
        beginRun(room, c);
        return { ok: true, started: true };
      }
      const live = room.players.filter((p) => p.online);
      if (live.length < 3) throw new Error('至少 3 个人');
      const item = packs.pick(s.packId, new Set(s.used));
      s.order = packs.shuffle(live.map((p) => p.id));
      s.idx = 0;
      s.word = item ? item.w : '打草惊蛇';
      s.hint = item ? item.hint || '' : '';
      s.used = [...s.used, s.word].slice(-40);
      s.phase = 'run';
      s.lastResult = '';
      room.game.round += 1;
      room.game.timer = {
        endsAt: Date.now() + s.durationSec * 1000,
        label: `第 ${room.game.round} 题`,
        total: s.durationSec,
      };
      c.log(`第 ${room.game.round} 题 · ${s.word}（方言：${s.dialect}）`);
    },

    host_judge(room, c) {
      finish(room, c, c.payload.ok !== false && c.payload.ok !== 'false');
    },

    host_dialect(room, c) {
      const s = room.game.state;
      if (c.payload.dialect) s.dialect = c.payload.dialect;
      return { ok: true };
    },

    host_pack(room, c) {
      const s = room.game.state;
      if (c.payload.packId) s.packId = c.payload.packId;
      return { ok: true };
    },
  },

  hostView(room) {
    const s = room.game.state;
    ensureStats(s);
    const last = s.order[s.order.length - 1];
    const A = s.teamStats.A;
    const B = s.teamStats.B;
    return {
      info: [
        { label: '本轮词', value: s.word || '—', strong: true },
        { label: '提示', value: s.hint || '—' },
        { label: '方言', value: s.dialect, strong: true },
        { label: '第 1 棒', value: s.order[0] ? nameOf(room, s.order[0]) : '—' },
        { label: '最后一棒', value: last ? nameOf(room, last) : '—' },
        { label: '进度', value: s.phase === 'idle' ? '未开始' : `${s.idx + 1} / ${s.order.length}` },
        { label: 'A 队', value: `对 ${A.ok} · 错 ${A.bad}` },
        { label: 'B 队', value: `对 ${B.ok} · 错 ${B.bad}` },
      ],
      controls: [
        {
          kind: 'btn',
          action: 'host_next',
          label: s.phase === 'idle' ? '开始第一题' : '换一题',
          style: 'primary',
        },
        { kind: 'btn', action: 'host_judge', label: '判对 ✓', style: 'ok', payload: { ok: true } },
        { kind: 'btn', action: 'host_judge', label: '判错 ✗', style: 'danger', payload: { ok: false } },
        {
          kind: 'select',
          action: 'host_dialect',
          name: 'dialect',
          label: '方言',
          value: s.dialect,
          options: DIALECTS.map((d) => ({ value: d, label: d })),
        },
        {
          kind: 'select',
          action: 'host_pack',
          name: 'packId',
          label: '词库',
          value: s.packId,
          options: PACKS().map((p) => ({ value: p.id, label: `${p.name}（${p.items.length}）` })),
        },
      ],
      table: {
        columns: ['棒次', '玩家', '队伍', '干什么', '状态'],
        rows: s.order.map((pid, i) => {
          const k = kindAt(i, s.order.length);
          const p = room.players.find((x) => x.id === pid);
          let st = '等待';
          if (s.phase === 'done') st = '已结束';
          else if (i < s.idx) st = '已过';
          else if (i === s.idx) st = k === 'guess' ? '在猜' : k === 'draw' ? '在画' : '在说';
          return [
            String(i + 1),
            nameOf(room, pid),
            p && p.team ? p.team + ' 队' : '—',
            k === 'draw' ? '画' : k === 'say' ? '描述' : '猜',
            st,
          ];
        }),
      },
    };
  },

  playerView(room, pid) {
    const s = room.game.state;
    if (s.phase === 'idle' || !s.order.length) {
      return { type: 'text', title: '接力猜词', sub: '主持人还没发题' };
    }
    if (s.phase === 'pick') {
      const taken = {};
      s.order.forEach((id, k) => { if (id) taken[k + 1] = room.players.find((p) => p.id === id).name; });
      const mine = s.order.indexOf(pid) + 1;
      return {
        type: 'choice',
        title: mine ? `你在第 ${mine} 棒` : '挑一个棒次',
        sub: '先到先得，没人挑的由主持人补位',
        tone: 'active',
        options: s.order.map((id, k) => ({
          value: String(k + 1),
          label: `${k + 1} 棒${taken[k + 1] ? ' · ' + taken[k + 1] : ''}`,
          disabled: !!(id && id !== pid),
        })),
        action: 'pick',
      };
    }
    const i = s.order.indexOf(pid);
    if (i < 0) return { type: 'text', title: '围观席', sub: '这一题你不上场，负责笑' };
    if (s.phase === 'done') {
      return {
        type: 'text',
        title: '本轮结束',
        sub: s.lastResult || '换下一题',
        tone: 'done',
        reveal: s.word,
      };
    }

    const total = s.order.length;
    const kind = kindAt(i, total);
    const mine = i === s.idx;

    if (kind === 'draw') {
      const first = i === 0;
      return {
        type: 'word',
        title: first ? '你是第 1 棒 · 画' : `你是第 ${i + 1} 棒 · 画`,
        sub: first
          ? `看完画在纸上，别写字。画完传给下一位。`
          : `看上一张画，把它画出来。别问、别写字。`,
        text: first ? s.word : '画你看到的',
        hint: first ? s.hint : '',
        len: first ? T.len(s.word) : 0,
        hold: first,
        footer: `${i + 1} / ${total}`,
        button: mine && i < total - 1 ? { label: '画完了 →', action: 'handover' } : null,
      };
    }

    if (kind === 'guess') {
      return {
        type: 'answer',
        title: '你是最后一棒 · 猜',
        sub: '打开最后那张画，说答案',
        placeholder: '你猜的词',
        action: 'guess',
        hint: `共 ${T.len(s.word)} 个字`,
        disabled: s.phase !== 'guess',
        footer: `${total} / ${total}`,
      };
    }

    return {
      type: 'text',
      title: `你是第 ${i + 1} 棒 · 描述`,
      sub: mine
        ? `看这张画，用「${s.dialect}」说给下一位听。不能说出词里的字。`
        : '还没到你，别偷看别人的画',
      tone: mine ? 'active' : 'idle',
      footer: `${i + 1} / ${total}`,
      button: mine ? { label: '我说完了 →', action: 'handover' } : null,
    };
  },

  screenView(room) {
    const s = room.game.state;
    ensureStats(s);
    const cur = s.order[s.idx];
    const kind = s.order.length ? kindAt(s.idx, s.order.length) : 'draw';
    const A = s.teamStats.A;
    const B = s.teamStats.B;
    const teamLine = `A 队 ${A.ok} 对 ${A.bad} 错 · B 队 ${B.ok} 对 ${B.bad} 错`;
    return {
      type: 'relay',
      title: '接力猜词',
      big: s.phase === 'idle' ? '准备' : `${Math.min(s.idx + 1, s.order.length)} / ${s.order.length}`,
      sub:
        s.phase === 'idle'
          ? '等人齐'
          : cur
          ? `${nameOf(room, cur)} 正在${kind === 'draw' ? '画' : kind === 'say' ? '描述' : '猜'}`
          : '',
      hint: s.phase === 'idle' ? '' : `${T.len(s.word)} 个字 · ${s.dialect}　|　${teamLine}`,
    };
  },

  tick(room, now) {
    const s = room.game.state;
    const t = room.game.timer;
    if (!t || !t.endsAt || now < t.endsAt) return false;
    if (s.phase === 'run' || s.phase === 'guess') {
      s.phase = 'done';
      s.lastResult = '时间到 —— 没猜出来';
      room.game.timer = null;
      return true;
    }
    return false;
  },
};

function finish(room, c, ok) {
  const s = room.game.state;
  ensureStats(s);
  s.phase = 'done';
  s.lastResult = ok ? `猜对了：${s.word}` : `没猜对，答案是「${s.word}」`;
  s.results.push({ word: s.word, ok });

  // 记到「最后一棒」那个人的队头上 —— 一支队伍有没有传明白，看这一棒就知道
  const gp = room.players.find((p) => p.id === s.order[s.order.length - 1]);
  const team = gp ? gp.team : null;
  if (team && s.teamStats[team]) {
    if (ok) s.teamStats[team].ok += 1;
    else s.teamStats[team].bad += 1;
  }
  s.history.push({ round: room.game.round, word: s.word, ok, team: team || '—' });
  if (s.history.length > 40) s.history.shift();

  room.game.timer = null;
  if (ok) {
    const fp = room.players.find((p) => p.id === s.order[0]);
    if (gp) {
      gp.score += 3;
      if (room.teams[gp.team]) room.teams[gp.team].score += 3;
    }
    if (fp && fp.id !== gp.id) fp.score += 1;
  }
  c.log(ok ? `猜对了：${s.word}` : `没猜对：${s.word}`);
}
