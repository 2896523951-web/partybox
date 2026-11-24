'use strict';

const packs = require('../../core/packs');

/* 你们认了吗：一道主观题，每人匿名投两个人，实时出票数。
 * 匿名才敢真投，大屏实时出图才有综艺感。 */

const PACKS = () => packs.usable('question');

function init() {
  return {
    packId: (PACKS()[0] || {}).id || 'poll',
    question: '',
    open: false,
    closed: false,
    votes: {},
    limit: 2,
    round: 0,
  };
}

module.exports = {
  id: 'poll',
  name: '你们认了吗',
  desc: '一道主观题，每人匿名投两个人，票数实时上大屏。',
  // S4：现在是不是在投票（core 拿它起 60 秒倒计时）
  voteOpen(room) {
    const s = room.game.state;
    return s.open && !s.closed;
  },

  submitActions: ['vote'],
  minPlayers: 3,
  slogan: '一道题，投两个人，全场匿名',
  // 开局前打上投屏的 3 条规则。大屏、玩家手机、主持台共用这一份，
  // 别在别处再抄一遍 —— 改了规则只改这里。
  rules: [
    '主持人出题，比如「谁最容易被表白」',
    '每人匿名选两个人，不能投自己，截止前能改',
    '截止后看票数，得票最高的人解释',
  ],

  init,

  setup(room, cfg) {
    const s = room.game.state;
    if (cfg.packId) s.packId = cfg.packId;
    const q = cfg.question || (packs.pick(s.packId, null) || {}).q || '谁最像卧底？';
    s.question = q;
    s.open = true;
    s.closed = false;
    s.votes = {};
    s.round += 1;
    room.game.timer = null;
    return { ok: true };
  },

  actions: {
    vote(room, c) {
      const s = room.game.state;
      if (!s.open || s.closed) throw new Error('投票已关闭');
      const targets = Array.isArray(c.payload.targets) ? c.payload.targets.slice(0, s.limit) : [];
      const valid = targets.filter((id) => id !== c.pid && room.players.some((p) => p.id === id));
      if (!valid.length) throw new Error('至少选一个');
      s.votes[c.pid] = [...new Set(valid)];
      return { ok: true };
    },

    host_close(room, c) {
      const s = room.game.state;
      s.closed = true;
      s.open = false;
      c.sfxAll('win');
      c.log('投票关闭');
      return { ok: true };
    },

    host_open(room, c) {
      for (const pl of room.players) pl.submitRound = 0; // 新一轮，完成态清零
      const s = room.game.state;
      s.open = true;
      s.closed = false;
      s.votes = {};
      c.log('重新开放投票');
      return { ok: true };
    },

    host_next(room, c) {
      module.exports.setup(room, { packId: room.game.state.packId }, c);
      return { ok: true };
    },

    host_pack(room, c) {
      if (c.payload.packId) room.game.state.packId = c.payload.packId;
      return { ok: true };
    },
  },

  hostView(room) {
    const s = room.game.state;
    const tally = tallyOf(room, s);
    return {
      info: [
        { label: '题目', value: s.question || '—', strong: true },
        { label: '已投', value: `${Object.keys(s.votes).length} / ${room.players.length}` },
      ],
      controls: [
        { kind: 'btn', action: 'host_next', label: '下一题', style: 'primary' },
        { kind: 'btn', action: 'host_close', label: '截止投票', style: 'ok' },
        { kind: 'btn', action: 'host_open', label: '重开投票', style: 'plain' },
        {
          kind: 'select',
          action: 'host_pack',
          name: 'packId',
          label: '题库',
          value: s.packId,
          options: PACKS().map((p) => ({ value: p.id, label: `${p.name}（${p.items.length}）` })),
        },
      ],
      table: {
        columns: ['玩家', '票数'],
        rows: room.players
          .map((p) => [p.name, String(tally[p.id] || 0)])
          .sort((a, b) => Number(b[1]) - Number(a[1])),
      },
    };
  },

  playerView(room, pid) {
    const s = room.game.state;
    if (!s.question) return { type: 'text', title: '你们认了吗', sub: '等主持人出题' };
    if (s.closed) {
      const tally = tallyOf(room, s);
      const top = room.players
        .map((p) => ({ name: p.name, n: tally[p.id] || 0 }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 2);
      return {
        type: 'text',
        title: '投票结束',
        sub: top.map((t) => `${t.name} ${t.n} 票`).join(' · '),
        tone: 'done',
        reveal: s.question,
      };
    }
    const mine = s.votes[pid] || [];
    return {
      type: 'choice',
      title: s.question,
      sub: `匿名投 ${s.limit} 个人${mine.length ? '，已投（可改）' : ''}`,
      options: room.players
        .filter((p) => p.id !== pid)
        .map((p) => ({ value: p.id, label: p.name })),
      selected: mine,
      multi: true,
      limit: s.limit,
      action: 'vote',
      submitLabel: '就这么投',
    };
  },

  screenView(room) {
    const s = room.game.state;
    const tally = tallyOf(room, s);
    return {
      type: 'bars',
      title: s.question || '你们认了吗',
      sub: s.closed ? '投票已截止' : `已投 ${Object.keys(s.votes).length} 人`,
      bars: room.players
        .map((p) => ({ label: p.name, value: tally[p.id] || 0 }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8),
    };
  },
};

function tallyOf(room, s) {
  const count = {};
  for (const arr of Object.values(s.votes)) {
    for (const id of arr) count[id] = (count[id] || 0) + 1;
  }
  return count;
}
