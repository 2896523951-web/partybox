'use strict';

/* 听歌识曲：音乐从主持人的电脑/电视外放，玩家在手机上抢答。
 * 抢答用「服务端授时 + 客户端到点触发」，不是谁先点谁赢。 */

function init() {
  return {
    /* B4：默认大屏——歌从音响外放，听出来直接喊，主持人判。 */
    big: true,
    phase: 'idle', // idle | open | given | done
    openAt: 0,
    armLeadMs: 800,
    winner: null,
    buzzes: [],
    blocked: [],
    songName: '',
    result: '',
    correct: 0,
  };
}

module.exports = {
  id: 'songquiz',
  name: '听歌识曲',
  desc: '音乐从电视外放，谁先抢到谁答。抢跑判负，抢到答错换人。',
  submitActions: ['buzz'],
  minPlayers: 2,
  slogan: '前奏一响，谁先按到谁答',
  // 开局前打上投屏的 3 条规则。大屏、玩家手机、主持台共用这一份，
  // 别在别处再抄一遍 —— 改了规则只改这里。
  rules: [
    '音乐从音响外放，大家一起听前奏',
    '主持人点「开抢」，按钮变绿才能按',
    '答对 +3、答错 -1，同一首可以反复抢',
  ],

  init,

  setup(room, cfg) {
    const s = room.game.state;
    s.big = !(cfg && cfg.big === false);
    s.phase = 'idle';
    s.openAt = 0;
    s.winner = null;
    s.buzzes = [];
    s.blocked = [];
    s.result = '';
    s.songName = cfg.songName || '';
    s.correct = 0;
    room.game.timer = null;
    return { ok: true };
  },

  actions: {
    buzz(room, c) {
      const s = room.game.state;
      if (s.big !== false) throw new Error('这轮看大屏：听出来直接喊');
      if (s.phase !== 'open') return { ok: false, reason: 'closed' };
      if (s.blocked.includes(c.pid)) return { ok: false, reason: 'blocked' };
      if (s.winner && s.winner !== c.pid) return { ok: false, reason: 'taken' };
      const now = Date.now();
      // 客户端带本地时间戳，服务端用它的 offset 校正，剔除网络抖动
      const clientTs = Number(c.payload.clientTs) || 0;
      const corrected = clientTs ? clientTs + (c.player.offset || 0) : now;

      // 还没到开抢时刻：直接告诉他不算，不罚分、不禁答。
      // 手机端按钮本来就是灰的，走到这里多半是两边时钟差了几十毫秒。
      if (corrected < s.openAt - 40) {
        return { ok: false, reason: 'too_early', waitMs: Math.max(0, s.openAt - corrected) };
      }

      s.buzzes.push({ pid: c.pid, at: corrected, early: false });
      s.buzzes.sort((a, b) => a.at - b.at);
      if (!s.winner) {
        s.winner = s.buzzes[0].pid;
        s.phase = 'given';
        c.sfxAll('ding');
        const w = room.players.find((p) => p.id === s.winner);
        c.log(`${w ? w.name : '?'} 抢到`);
      }
      return { ok: true };
    },

    // ---- 主持 ----
    host_open(room, c) {
      for (const pl of room.players) pl.submitRound = 0; // 新一轮，完成态清零
      const s = room.game.state;
      s.phase = 'open';
      s.winner = null;
      s.buzzes = [];
      s.blocked = [];
      s.result = '';
      s.openAt = Date.now() + s.armLeadMs;
      c.sfxAll('tick');
      c.log('开抢');
      return { ok: true, openAt: s.openAt };
    },

    host_right(room, c) {
      const s = room.game.state;
      if (!s.winner) throw new Error('还没人抢到');
      const w = room.players.find((p) => p.id === s.winner);
      if (w) {
        w.score += 3;
        room.teams[w.team] && (room.teams[w.team].score += 3);
      }
      s.correct += 1;
      s.phase = 'done';
      s.result = `${w ? w.name : '?'} 答对`;
      c.sfxAll('win');
      c.log(`${w ? w.name : '?'} 答对`);
      return { ok: true };
    },

    host_wrong(room, c) {
      const s = room.game.state;
      if (!s.winner) throw new Error('还没人抢到');
      const w = room.players.find((p) => p.id === s.winner);
      s.blocked.push(s.winner);
      if (w) w.score = Math.max(0, w.score - 1);
      s.winner = null;
      s.phase = 'open';
      s.openAt = Date.now() + s.armLeadMs;
      c.sfxAll('buzzErr');
      c.log(`${w ? w.name : '?'} 答错，重新开抢`);
      return { ok: true };
    },

    host_mode(room, c) {
      const s = room.game.state;
      s.big = !(s.big !== false);
      c.log(s.big ? '切到大屏：听出来直接喊' : '切回手机抢答');
      return { ok: true, big: s.big };
    },

    host_reset(room, c) {
      const s = room.game.state;
      s.phase = 'idle';
      s.winner = null;
      s.buzzes = [];
      s.blocked = [];
      s.result = '';
      room.game.round += 1;
      c.log(`第 ${room.game.round} 题`);
      return { ok: true };
    },
  },

  /* B4：大屏模式判分。判对 = 抢到并答对；判错 = 禁答、重新听。 */
  judge(room, pid, ok, c) {
    const s = room.game.state;
    if (s.phase !== 'open' || s.winner) return null;
    const w = room.players.find((p) => p.id === pid);
    if (!w) return null;
    s.winner = pid;
    if (ok) {
      w.score += 3;
      room.teams[w.team] && (room.teams[w.team].score += 3);
      s.correct += 1;
      s.phase = 'done';
      s.result = `${w.name} 答对`;
      c.sfxAll('win');
      return { points: 3 };
    }
    s.blocked.push(pid);
    s.winner = null;
    s.phase = 'open';
    w.score = Math.max(0, w.score - 1);
    c.sfxAll('buzzErr');
    return { points: -1 };
  },

  hostView(room) {
    const s = room.game.state;
    const w = room.players.find((p) => p.id === s.winner);
    return {
      info: [
        { label: '状态', value: { idle: '待开抢', open: '抢答中', given: '已抢到', done: '本轮结束' }[s.phase] },
        { label: '抢到', value: w ? w.name : '—', strong: true },
        { label: '本轮答对', value: String(s.correct) },
      ],
      controls: [
        { kind: 'btn', action: 'host_open', label: '开抢', style: 'primary' },
        { kind: 'btn', action: 'host_right', label: '答对了 ✓', style: 'ok' },
        { kind: 'btn', action: 'host_wrong', label: '答错了 ✗', style: 'danger' },
        { kind: 'btn', action: 'host_mode', label: s.big !== false ? '切回手机抢答' : '切到大屏', style: 'plain' },
        { kind: 'btn', action: 'host_reset', label: '下一题', style: 'plain' },
      ],
      table: {
        columns: ['抢答顺序', '玩家', '结果'],
        rows: s.buzzes.map((b, i) => {
          const p = room.players.find((x) => x.id === b.pid);
          return [`${i + 1}`, p ? p.name : '—', b.pid === s.winner ? '抢到' : '慢了'];
        }),
      },
    };
  },

  playerView(room, pid) {
    const s = room.game.state;
    if (s.phase === 'idle') {
      return { type: 'text', title: '听歌识曲', sub: '听电视里的歌，主持人喊开抢再按' };
    }
    if (s.big !== false) {
      return {
        type: 'text',
        title: s.phase === 'open' ? '听出来就喊' : s.phase === 'given' ? '有人抢了' : '听歌',
        sub: s.blocked.includes(pid) ? '这轮你答错过，听下一首' : '歌从音响出来，不用看手机',
        tone: s.phase === 'open' && !s.blocked.includes(pid) ? 'active' : 'muted',
      };
    }
    const blocked = s.blocked.includes(pid);
    if (s.phase === 'done') {
      return { type: 'text', title: s.result || '本轮结束', sub: '下一题马上来', tone: 'done' };
    }
    if (s.phase === 'given') {
      const w = room.players.find((p) => p.id === s.winner);
      const mine = s.winner === pid;
      return {
        type: 'text',
        title: mine ? '你抢到了' : `${w ? w.name : '?'} 抢到了`,
        sub: mine ? '说歌名，答错换人' : '等他答，答错还有机会',
        tone: mine ? 'active' : '',
      };
    }
    return {
      type: 'buzz',
      title: blocked ? '本轮禁答' : '抢答',
      sub: blocked ? '抢跑了，这题没你' : '听到就按，别抢跑',
      openAt: s.openAt,
      disabled: blocked,
    };
  },

  screenView(room) {
    const s = room.game.state;
    const w = room.players.find((p) => p.id === s.winner);
    return {
      type: 'bars',
      title: '听歌识曲',
      sub: s.phase === 'idle' ? '准备' : s.phase === 'open' ? '谁先抢到？' : w ? `${w.name} 抢到` : '',
      bars: s.buzzes.slice(0, 6).map((b, i) => {
        const p = room.players.find((x) => x.id === b.pid);
        return { label: `${i + 1}. ${p ? p.name : '?'}`, value: 6 - i };
      }),
      note: s.phase === 'done' ? s.result : s.big !== false ? '听出来直接喊，主持人判' : '',
    };
  },
};
