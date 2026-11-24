'use strict';

/* 数字炸弹：轮流在区间里报数，区间越缩越小，谁报到炸弹谁出局。 */

function init() {
  return {
    phase: 'idle', // idle | run | done
    lo: 1,
    hi: 100,
    secret: 0,
    order: [],
    turn: 0,
    out: [],
    history: [],
    round: 0,
  };
}

module.exports = {
  id: 'numberbomb',
  name: '数字炸弹',
  desc: '轮流在区间里报数，越缩越窄，踩到炸弹的人出局。',
  minPlayers: 3,
  // 自动推进：主持台那颗「开自动」到点会替主持人点这个动作。
  // 只挑「点了不会毁局」的那个 —— 狼人杀那种一步错满盘皆输的流程不配。
  pacing: { action: 'host_next', label: '下一位', sec: 30 },
  slogan: '1 到 100，谁踩到谁出局',
  // 开局前打上投屏的 3 条规则。大屏、玩家手机、主持台共用这一份，
  // 别在别处再抄一遍 —— 改了规则只改这里。
  rules: [
    '系统在 1–100 里藏一个炸弹数字',
    '轮流报数，没踩中就缩窄区间，越往后越险',
    '踩中的人出局，其他在场的人各 +1',
  ],

  init,

  setup(room) {
    const s = room.game.state;
    const live = room.players.filter((p) => p.online).map((p) => p.id);
    if (live.length < 3) throw new Error('至少 3 个人');
    s.phase = 'run';
    s.lo = 1;
    s.hi = 100;
    s.secret = 2 + Math.floor(Math.random() * 97); // 2..98
    s.order = live;
    s.turn = 0;
    s.out = [];
    s.history = [];
    s.round += 1;
    room.game.timer = null;
    return { ok: true };
  },

  actions: {
    pick(room, c) {
      const s = room.game.state;
      if (s.phase !== 'run') throw new Error('这局还没开始');
      if (s.order[s.turn] !== c.pid) throw new Error('还没轮到你');
      const n = Math.floor(Number(c.payload.n));
      if (!Number.isFinite(n)) throw new Error('输入一个数字');
      if (n <= s.lo || n >= s.hi) throw new Error(`要在 ${s.lo} 到 ${s.hi} 之间`);

      s.history.push({ pid: c.pid, n });

      if (n === s.secret) {
        s.out.push(c.pid);
        c.sfx(c.pid, 'boom');
        c.log(`${c.player.name} 踩到 ${n}，出局`);
        for (const id of s.order) {
          if (id === c.pid || s.out.includes(id)) continue;
          const p = room.players.find((x) => x.id === id);
          if (p) {
            p.score += 1;
            room.teams[p.team] && (room.teams[p.team].score += 1);
          }
        }
        /* 10：踩中就结束。炸弹数字已经喊出来了，再换个新炸弹继续，
         * 玩家会觉得「刚才那一下白踩」——一轮一个炸弹，踩完就见分晓。 */
        s.phase = 'done';
        c.log(`炸了：${n}，本轮结束`);
        return { ok: true, boom: true, n };
      }

      if (n > s.secret) s.hi = n;
      else s.lo = n;
      nextTurn(room, s);
      return { ok: true, boom: false, n, lo: s.lo, hi: s.hi };
    },

    /* B1：主持人替当前这位报数。手机退场，报数变成一句话。 */
    host_pick(room, c) {
      const s = room.game.state;
      if (s.phase !== 'run') throw new Error('这局还没开始');
      const pid = s.order[s.turn];
      // 主持动作的 payload 是整包传进来的（可能嵌一层 payload），两种都认
      const n = c.payload && c.payload.n != null ? c.payload.n : c.payload && c.payload.payload && c.payload.payload.n;
      const ctx2 = Object.assign({}, c, {
        pid,
        player: room.players.find((x) => x.id === pid),
        payload: { n },
      });
      return module.exports.actions.pick(room, ctx2);
    },

    host_next(room, c) {
      const s = room.game.state;
      nextTurn(room, s);
      return { ok: true, turn: s.turn };
    },

    host_reveal(room, c) {
      const s = room.game.state;
      s.phase = 'done';
      c.log(`炸弹是 ${s.secret}`);
      return { ok: true, secret: s.secret };
    },

    host_restart(room, c) {
      module.exports.setup(room, {}, c);
      return { ok: true };
    },
  },

  hostView(room) {
    const s = room.game.state;
    return {
      info: [
        { label: '炸弹', value: s.phase === 'done' ? String(s.secret) : '保密', strong: true },
        { label: '区间', value: `${s.lo} — ${s.hi}` },
        { label: '轮到', value: nameOf(room, s.order[s.turn]) || '—' },
        { label: '出局', value: s.out.map((id) => nameOf(room, id)).join('、') || '—' },
      ],
      controls: [
        { kind: 'btn', action: 'host_restart', label: s.phase === 'idle' ? '开始' : '重开', style: 'primary' },
        { kind: 'num', action: 'host_pick', label: s.phase === 'run' ? `替 ${nameOf(room, s.order[s.turn])} 报` : '报一个', min: s.lo + 1, max: s.hi - 1, placeholder: `${s.lo + 1} ~ ${s.hi - 1}`, cta: '报', name: 'n' },
        { kind: 'btn', action: 'host_next', label: '跳过这个人', style: 'plain' },
        { kind: 'btn', action: 'host_reveal', label: '公布炸弹', style: 'danger' },
      ],
      table: {
        columns: ['玩家', '状态'],
        rows: s.order.map((id) => [
          nameOf(room, id),
          s.out.includes(id) ? '出局' : id === s.order[s.turn] ? '轮到' : '在场',
        ]),
      },
    };
  },

  playerView(room, pid) {
    const s = room.game.state;
    if (s.phase === 'idle') return { type: 'text', title: '数字炸弹', sub: '等人齐' };
    if (s.phase === 'done') {
      return { type: 'text', title: '本轮结束', sub: `炸弹是 ${s.secret}`, tone: 'done' };
    }
    if (s.out.includes(pid)) return { type: 'text', title: '你出局了', sub: '安静看戏', tone: 'muted' };

    // B1：手机上不再报数，由主持人控场；手机只告诉玩家「看大屏」
    const mine = s.order[s.turn] === pid;
    return {
      type: 'text',
      title: mine ? '轮到你，看大屏' : '看大屏',
      sub: mine ? `报一个 ${s.lo} 到 ${s.hi} 之间的数` : `轮到 ${nameOf(room, s.order[s.turn])}`,
      prog: `${s.lo} — ${s.hi}`,
      tone: mine ? 'active' : 'muted',
    };
  },

  screenView(room) {
    const s = room.game.state;
    return {
      type: 'range',
      title: '数字炸弹',
      big: `${s.lo} — ${s.hi}`,
      sub: s.phase === 'done' ? `炸弹是 ${s.secret}` : `轮到 ${nameOf(room, s.order[s.turn])}`,
      note: s.out.length ? `已出局 ${s.out.length} 人` : '',
    };
  },
};

function nextTurn(room, s) {
  if (!s.order.length) return;
  let guard = 0;
  do {
    s.turn = (s.turn + 1) % s.order.length;
  } while (s.out.includes(s.order[s.turn]) && guard++ < s.order.length);
}

function nameOf(room, id) {
  const p = room.players.find((x) => x.id === id);
  return p ? p.name : '—';
}
