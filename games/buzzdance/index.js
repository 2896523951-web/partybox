'use strict';

/* 报数抢答：主持人喊开始后不定时开抢，先按的人赢。
 * 抢跑扣分——这才有意思，大家都怕早按。 */

function init() {
  return {
    /* B3：默认大屏控场——倒数结束大家一起喊，主持人判名次。
     * 关掉 big 就回到手机抢答（毫秒判定那条路）。 */
    big: true,
    phase: 'idle', // idle | arming | open | done
    armAt: 0,
    openAt: 0,
    buzzes: [],
    blocked: [],
    round: 0,
  };
}

module.exports = {
  id: 'buzzdance',
  name: '报数抢答',
  desc: '喊开始后随机 1.5–5 秒才开抢。抢跑扣分，前三名拿分。',
  minPlayers: 2,
  // 自动推进：主持台那颗「开自动」到点会替主持人点这个动作。
  // 只挑「点了不会毁局」的那个 —— 狼人杀那种一步错满盘皆输的流程不配。
  pacing: { action: 'host_next', label: '下一轮', sec: 30 },
  slogan: '喊开始不算开始，屏幕变绿才算',
  // 开局前打上投屏的 3 条规则。大屏、玩家手机、主持台共用这一份，
  // 别在别处再抄一遍 —— 改了规则只改这里。
  rules: [
    '主持人点「开始」，随机等 1.5–5 秒后才开抢',
    '屏幕变绿立刻按，前三个按到的拿分',
    '抢跑扣 1 分，而且这一轮不能再抢',
  ],

  init,

  setup(room, cfg) {
    const s = room.game.state;
    s.big = !(cfg && cfg.big === false);
    s.phase = 'arming';
    s.armAt = Date.now() + 1200 + Math.random() * 3500;
    s.openAt = 0;
    s.buzzes = [];
    s.blocked = [];
    s.round += 1;
    room.game.timer = null;
    return { ok: true };
  },

  actions: {
    buzz(room, c) {
      const s = room.game.state;
      if (s.big !== false) throw new Error('这轮看大屏：举手，主持人判');
      if (s.phase === 'arming') {
        s.blocked.push(c.pid);
        c.addScore(c.pid, -1);
        c.sfx(c.pid, 'buzzErr');
        c.say(c.pid, '抢跑！扣 1 分');
        c.log(`${c.player.name} 抢跑`);
        return { ok: false, reason: 'early' };
      }
      if (s.phase !== 'open') return { ok: false, reason: 'closed' };
      if (s.blocked.includes(c.pid)) return { ok: false, reason: 'blocked' };
      if (s.buzzes.find((b) => b.pid === c.pid)) return { ok: false, reason: 'again' };

      /* S5：记客户端时间戳（已经过服务端授时校正），不是服务端收到的时刻 ——
       * 网络抖动几十毫秒，用收包时间算「谁先到」会把结论算反。 */
      const at = Number(c.payload && c.payload.clientTs) || Date.now();
      s.buzzes.push({ pid: c.pid, at, atWall: Date.now() });
      const rank = s.buzzes.length;
      const points = rank === 1 ? 3 : rank === 2 ? 2 : rank === 3 ? 1 : 0;
      if (points) c.addScore(c.pid, points);
      c.sfx(c.pid, rank <= 3 ? 'ding' : 'buzzErr');
      if (s.buzzes.length >= 3) s.phase = 'done';
      return { ok: true, rank, points };
    },

    /* S5：两个裁决按钮。只写记录，不动分数 —— 加不加分仍然由人决定。 */
    host_tie(room, c) {
      const s = room.game.state;
      s.verdict = '并列';
      c.log('主持人判：本轮并列');
      return { ok: true };
    },

    host_best3(room, c) {
      const s = room.game.state;
      s.verdict = '三局两胜';
      c.log('主持人判：三局两胜');
      return { ok: true };
    },

    host_next(room, c) {
      const s = room.game.state;
      s.phase = 'arming';
      s.armAt = Date.now() + 1200 + Math.random() * 3500;
      s.openAt = 0;
      s.buzzes = [];
      s.blocked = [];
      s.round += 1;
      c.log(`第 ${s.round} 轮准备`);
      return { ok: true };
    },

    host_open(room, c) {
      const s = room.game.state;
      s.phase = 'open';
      s.openAt = Date.now();
      c.sfxAll('ding');
      return { ok: true };
    },

    host_stop(room, c) {
      const s = room.game.state;
      s.phase = 'done';
      c.log('本轮结束');
      return { ok: true };
    },

    host_mode(room, c) {
      const s = room.game.state;
      s.big = !(s.big !== false);
      c.log(s.big ? '切到大屏：举手，主持判' : '切回手机抢答');
      return { ok: true, big: s.big };
    },
  },

  /* B3：大屏模式下，主持点「对」= 记一个名次（3 / 2 / 1）。 */
  judge(room, pid, ok, c) {
    const s = room.game.state;
    if (!ok || s.phase !== 'open') return null;
    if (s.buzzes.find((b) => b.pid === pid)) return null;
    s.buzzes.push({ pid, at: Date.now(), manual: true });
    const rank = s.buzzes.length;
    const points = [3, 2, 1][rank - 1] || 0;
    if (points) c.addScore(pid, points);
    if (s.buzzes.length >= 3) s.phase = 'done';
    return { points, rank };
  },

  hostView(room) {
    const s = room.game.state;
    return {
      info: [
        { label: '状态', value: { idle: '待开始', arming: '憋着', open: '开抢', done: '结束' }[s.phase] },
        { label: '第几轮', value: String(s.round) },
        { label: '抢跑', value: s.blocked.map((id) => nameOf(room, id)).join('、') || '—' },
        { label: '方式', value: s.big !== false ? '大屏 · 举手' : '手机 · 计时' },
      ],
      controls: [
        { kind: 'btn', action: 'host_next', label: '开始（随机延迟）', style: 'primary' },
        { kind: 'btn', action: 'host_open', label: '立刻开抢', style: 'ok' },
        { kind: 'btn', action: 'host_stop', label: '结束本轮', style: 'plain' },
        { kind: 'btn', action: 'host_mode', label: s.big !== false ? '切回手机抢答' : '切到大屏', style: 'plain' },
        { kind: 'btn', action: 'host_tie', label: '判并列', style: 'plain' },
        { kind: 'btn', action: 'host_best3', label: '三局两胜', style: 'plain' },
      ],
      table: {
        columns: ['名次', '玩家', '时间差', '得分'],
        rows: s.buzzes.map((b, i) => {
          const p = room.players.find((x) => x.id === b.pid);
          // 只报档位，不报毫秒：输的人看到「就差 0.02 秒」比不知道更不服，
          // 而且一旦上屏精确到毫秒，等于把「系统不准」的话柄递出去。
          let gap = '—';
          if (i > 0) {
            const d = b.at - s.buzzes[0].at;
            gap = `${(d / 1000).toFixed(2)} 秒 · ${d < 80 ? '几乎同时' : '明显先到'}`;
          }
          return [`${i + 1}`, p ? p.name : '—', gap, `${[3, 2, 1][i] || 0}`];
        }),
      },
    };
  },

  playerView(room, pid) {
    const s = room.game.state;
    if (s.phase === 'idle') return { type: 'text', title: '报数抢答', sub: '等主持人喊开始' };
    if (s.big !== false) {
      const open = s.phase === 'open';
      return {
        type: 'text',
        title: open ? '举手！' : s.phase === 'arming' ? '别动，准备' : '看大屏',
        sub: open ? '喊出来，主持人判名次' : '倒数结束再动，抢跑要扣分',
        tone: open ? 'active' : 'muted',
      };
    }
    const blocked = s.blocked.includes(pid);
    const mine = s.buzzes.find((b) => b.pid === pid);
    const rank = mine ? s.buzzes.indexOf(mine) + 1 : 0;

    if (mine) {
      return {
        type: 'text',
        title: `第 ${rank} 名`,
        sub: rank <= 3 ? '拿分了' : '慢了，下次' ,
        tone: rank <= 3 ? 'active' : '',
      };
    }
    return {
      type: 'buzz',
      title: s.phase === 'arming' ? '准备好' : blocked ? '你抢跑了' : '开抢',
      sub: s.phase === 'arming' ? '还别按，等屏幕变绿' : blocked ? '扣 1 分，这轮歇着' : '按！',
      openAt: s.phase === 'open' ? s.openAt : 0,
      disabled: blocked || s.phase === 'done',
      live: s.phase === 'open',
    };
  },

  screenView(room) {
    const s = room.game.state;
    // 3：大屏要有明确的「准备 / 抢」大字，不能只有一排空条
    if (s.phase === 'arming' || s.phase === 'open' || s.phase === 'idle') {
      return {
        type: 'podium',
        title: '报数抢答',
        big: s.phase === 'open' ? '抢！' : s.phase === 'arming' ? '准备…' : '等主持',
        sub: s.phase === 'open' ? (s.big !== false ? '喊出来，主持人判名次' : '按手机') : '别动，倒数结束再抢',
        note: s.phase === 'idle' ? '' : `第 ${s.round} 轮`,
      };
    }
    return {
      type: 'bars',
      title: '报数抢答',
      sub: '本轮结束',
      big: '',
      note: s.big !== false ? '举手或喊出来，主持人判名次' : '',
      bars: s.buzzes.map((b, i) => {
        const p = room.players.find((x) => x.id === b.pid);
        return { label: `${i + 1}. ${p ? p.name : '?'}`, value: 4 - i };
      }),
    };
  },

  tick(room, now) {
    const s = room.game.state;
    if (s.phase !== 'arming' || !s.armAt) return false;
    if (now < s.armAt) return false;
    s.phase = 'open';
    s.openAt = now;
    return true;
  },
};

function nameOf(room, id) {
  const p = room.players.find((x) => x.id === id);
  return p ? p.name : '—';
}
