'use strict';

/* 重复就打飞：音乐一停，两个人立刻抱团，然后按主题摆一个动作。
 * 跟别人撞了就白忙 —— 所以每组都得偷看别人摆什么，再临时改。
 *
 * 音乐是主持台那台音响放，随时能停（要的就是「突然」）。
 * 手机只负责告诉你：和谁一组、主题是什么。动作必须是身体，不能是打字。 */

const TOPICS = [
  '过年',
  '拜年',
  '放烟花',
  '贴春联',
  '包饺子',
  '看春晚',
  '抢红包',
  '舞龙舞狮',
  '打麻将',
  '走亲戚',
  '压岁钱',
  '元宵灯会',
  '贴福字',
  '放鞭炮',
  '年夜饭',
  '守岁',
];

function init() {
  return {
    phase: 'idle', // idle | round | judge | done
    round: 0,
    topic: '',
    pairs: [], // [[pid, pid], ...]
    lonely: [], // 落单的人
    dup: [], // 本轮被判重复的组下标
    results: [], // [{ round, topic, groups, dup }]
    usedTopics: [],
  };
}

function live(room) {
  return room.players.filter((p) => p.online);
}

function nameOf(room, id) {
  const p = room.players.find((x) => x.id === id);
  return p ? p.name : '？';
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function groupOf(room, pid) {
  const s = room.game.state;
  return s.pairs.findIndex((g) => g.includes(pid));
}

/* B2：人数不固定。2–4 人一组，按在场人数随机，
 * 只剩 1 个人时从上一组借一个，避免出现「一个人自己摆动作」的尴尬。 */
function splitSizes(n) {
  const out = [];
  let left = n;
  while (left > 0) {
    if (left === 3) { out.push(3); left = 0; }
    else if (left === 1) {
      if (out.length && out[out.length - 1] > 2) { out[out.length - 1] -= 1; out.push(2); }
      else out.push(1);
      left = 0;
    } else {
      const max = Math.min(4, left);
      const size = 2 + Math.floor(Math.random() * (max - 1));
      out.push(size);
      left -= size;
    }
  }
  return out;
}

function drawRound(room, c) {
  const s = room.game.state;
  const ids = shuffle(live(room).map((p) => p.id));
  s.pairs = [];
  s.lonely = [];
  s.dup = [];
  let at = 0;
  for (const size of splitSizes(ids.length)) {
    const g = ids.slice(at, at + size);
    at += size;
    if (g.length === 1) s.lonely = g;
    else s.pairs.push(g);
  }

  const pool = TOPICS.filter((t) => !s.usedTopics.includes(t));
  s.topic = (pool.length ? shuffle(pool) : shuffle(TOPICS))[0];
  s.usedTopics = [...s.usedTopics, s.topic].slice(-10);

  s.round += 1;
  s.phase = 'round';
  room.game.round = s.round;
  c.log(`第 ${s.round} 轮 · 主题「${s.topic}」· ${s.pairs.length} 组`);
}

module.exports = {
  id: 'dupfly',
  name: '重复就打飞',
  desc: '音乐一停就按大屏分组抱团，按主题摆动作。跟别人撞了就这一轮白玩。',
  minPlayers: 4,
  // 自动推进：主持台那颗「开自动」到点会替主持人点这个动作。
  // 只挑「点了不会毁局」的那个 —— 狼人杀那种一步错满盘皆输的流程不配。
  pacing: { action: 'host_next', label: '重置一轮', sec: 45 },
  slogan: '音乐一停，配对摆造型，撞了就白玩',
  // 开局前打上投屏的 3 条规则。大屏、玩家手机、主持台共用这一份，
  // 别在别处再抄一遍 —— 改了规则只改这里。
  rules: [
    '音乐响的时候随便走，音乐一停看大屏',
    '大屏给出分组和主题，2–4 人一组',
    '摆一个动作定住，跟别的组撞了这轮没分',
  ],

  init,

  setup(room, cfg, c) {
    const s = room.game.state;
    if (live(room).length < 4) throw new Error('至少要 4 个人在线');
    s.round = 0;
    s.pairs = [];
    s.lonely = [];
    s.dup = [];
    s.results = [];
    s.usedTopics = [];
    s.phase = 'idle';
    if (cfg && cfg.topic) {
      s.topic = cfg.topic;
      s.usedTopics = [cfg.topic];
    }
  },

  actions: {
    // ---- 主持 ----
    host_musicPlay(room, c) {
      c.music('play');
      const s = room.game.state;
      if (s.phase === 'idle') s.phase = 'round';
      c.log('音乐起');
    },

    host_stop(room, c) {
      // 音乐一停，立刻配对 + 出主题
      c.music('stop');
      drawRound(room, c);
      c.sfxAll('siren');
    },

    host_toggleGroup(room, c) {
      const s = room.game.state;
      const i = Number(c.payload.group);
      if (!Number.isInteger(i) || i < 0 || i >= s.pairs.length) throw new Error('没有这个组');
      const at = s.dup.indexOf(i);
      if (at >= 0) {
        s.dup.splice(at, 1);
        c.log(`第 ${i + 1} 组改为原创`);
      } else {
        s.dup.push(i);
        c.log(`第 ${i + 1} 组判为重复`);
      }
    },

    host_settle(room, c) {
      const s = room.game.state;
      if (s.phase !== 'round') throw new Error('先配一轮');
      let scored = 0;
      s.pairs.forEach((g, i) => {
        if (s.dup.includes(i)) return;
        scored += 1;
        for (const id of g) {
          const p = room.players.find((x) => x.id === id);
          if (p) {
            p.score += 1;
            if (room.teams[p.team]) room.teams[p.team].score += 1;
          }
        }
      });
      s.results.push({ round: s.round, topic: s.topic, groups: s.pairs.length, dup: s.dup.length });
      s.phase = 'judge';
      c.sfxAll('win');
      c.log(`第 ${s.round} 轮结算：${scored} 组得分，${s.dup.length} 组撞车`);
    },

    host_next(room, c) {
      const s = room.game.state;
      s.phase = 'idle';
      s.pairs = [];
      s.lonely = [];
      s.dup = [];
      c.music('stop');
    },

    host_reset(room, c) {
      for (const p of room.players) p.score = 0;
      room.teams.A.score = 0;
      room.teams.B.score = 0;
      const s = room.game.state;
      s.round = 0;
      s.results = [];
      s.usedTopics = [];
      s.phase = 'idle';
      s.pairs = [];
      s.lonely = [];
      s.dup = [];
      c.log('分数清零');
    },
  },

  hostView(room) {
    const s = room.game.state;
    const groupBtns = s.pairs.map((g, i) => {
      const dup = s.dup.includes(i);
      return {
        kind: 'btn',
        action: 'host_toggleGroup',
        label: `第 ${i + 1} 组 ${g.map((id) => nameOf(room, id)).join('/')} · ${
          dup ? '重复 ✗' : '原创 ✓'
        }`,
        payload: { group: i },
        style: dup ? 'danger' : 'ok',
      };
    });

    return {
      info: [
        { label: '本轮主题', value: s.topic || '—', strong: true },
        { label: '轮次', value: s.round ? `第 ${s.round} 轮` : '未开始' },
        { label: '组数', value: `${s.pairs.length} 组` },
        { label: '撞车', value: `${s.dup.length} 组` },
        {
          label: '落单',
          value: s.lonely.length ? nameOf(room, s.lonely[0]) : '—',
        },
      ],
      controls: [
        { kind: 'btn', action: 'host_musicPlay', label: '放音乐', style: 'plain' },
        { kind: 'btn', action: 'host_stop', label: '停音乐 · 配对', style: 'primary' },
        ...groupBtns,
        { kind: 'btn', action: 'host_settle', label: '结算本轮', style: 'primary' },
        { kind: 'btn', action: 'host_next', label: '下一轮', style: 'plain' },
        { kind: 'btn', action: 'host_reset', label: '分数清零', style: 'danger' },
      ],
      table: {
        columns: ['组', '玩家', '判定'],
        rows: s.pairs.length
          ? s.pairs.map((g, i) => [
              `第 ${i + 1} 组`,
              g.map((id) => nameOf(room, id)).join(' / '),
              s.dup.includes(i) ? '重复' : '原创',
            ])
          : [['—', '等音乐停', '—']],
      },
    };
  },

  playerView(room, pid) {
    const s = room.game.state;
    if (!room.players.some((p) => p.id === pid)) {
      return { type: 'text', title: '围观席', sub: '这一局你不上场' };
    }
    if (s.phase === 'idle') {
      return { type: 'text', title: '重复就打飞', sub: '音乐响起来，先随便走' };
    }
    // B2：分组和主题都在大屏上，手机只提醒「抬头」
    if (s.phase === 'judge') {
      return { type: 'text', title: `第 ${s.round} 轮结束`, sub: `${s.pairs.length - s.dup.length} 组得分`, tone: 'done' };
    }
    return {
      type: 'text',
      title: '看大屏',
      sub: '找你的组，按主题摆动作。别跟别人撞。',
      tone: 'active',
      footer: `第 ${s.round} 轮 · ${s.topic}`,
    };
  },

  screenView(room) {
    const s = room.game.state;
    if (s.phase === 'idle') {
      return { type: 'podium', title: '重复就打飞', big: '走起来', sub: '音乐停的那一刻开始' };
    }
    if (s.phase === 'judge') {
      return {
        type: 'podium',
        title: `第 ${s.round} 轮`,
        big: s.topic,
        sub: `本轮主题：${s.topic} · ${s.pairs.length - s.dup.length} 组得分 · ${s.dup.length} 组撞车`,
        note: '下一轮会换主题，累计分看右边',
      };
    }
    // B2：手机不再显示分组，所以大屏要把它说全
    return {
      type: 'reveal',
      title: `第 ${s.round} 轮 · 主题`,
      big: s.topic,
      lines: s.pairs.map((g, i) => `第 ${i + 1} 组　${g.map((id) => nameOf(room, id)).join(' / ')}`),
      sub: s.lonely.length ? `${nameOf(room, s.lonely[0])} 落单` : '',
      note: '摆一个动作定住，别跟别的组撞',
    };
  },
};
