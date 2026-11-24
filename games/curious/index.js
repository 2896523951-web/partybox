'use strict';

/* 好奇宝：阿瓦隆的无淘汰简化版。
 *
 * 5 轮任务，每轮抽几个人去执行，执行者匿名投「吃 / 不吃」。
 * 只要出现一张「吃」，这一轮就失败 —— 但没人知道是谁投的，也没人被淘汰。
 * 所以社恐、怕出局的人也能从头玩到尾。
 *
 * 匿名这块必须由服务端兜住：好人投「吃」不算数，否则一个人手滑就毁了全场，
 * 而且他下轮一定会被排挤 —— 惩罚太重，不好玩。 */

const SIZES = [2, 3, 3, 4, 4];

function init() {
  return {
    phase: 'idle', // idle | pick | vote | result | done
    badIds: [],
    round: 1,
    team: [],
    size: 2,
    votes: {}, // pid -> 'eat' | 'noeat'
    results: [], // [{ round, size, fails, ok, team }]
    success: 0,
    fail: 0,
    winner: '',
    result: '',
  };
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
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

function live(room) {
  return room.players.filter((p) => p.online);
}

function nameOf(room, id) {
  const p = room.players.find((x) => x.id === id);
  return p ? p.name : '？';
}

function teamSizeFor(round, n) {
  const want = SIZES[round - 1] || 4;
  return Math.max(1, Math.min(want, n - 1));
}

function finish(room, c, winner) {
  const s = room.game.state;
  s.phase = 'done';
  s.winner = winner;
  s.result = `${winner === 'good' ? '好人胜' : '好奇宝胜'}：好奇宝是 ${s.badIds
    .map((id) => nameOf(room, id))
    .join('、')}`;
  if (winner === 'good') {
    for (const p of live(room)) if (!s.badIds.includes(p.id)) p.score += 2;
  } else {
    for (const id of s.badIds) {
      const p = room.players.find((x) => x.id === id);
      if (p) p.score += 3;
    }
  }
  c.sfxAll(winner === 'good' ? 'win' : 'wolf');
  c.log(s.result);
}

function newTeam(room, c) {
  const s = room.game.state;
  const ids = live(room).map((p) => p.id);
  s.size = teamSizeFor(s.round, ids.length);
  s.team = shuffle(ids).slice(0, s.size);
  s.votes = {};
  s.phase = 'pick';
  c.log(`第 ${s.round} 轮 · 执行者：${s.team.map((id) => nameOf(room, id)).join('、')}`);
}

module.exports = {
  id: 'curious',
  name: '好奇宝',
  desc: '5 轮任务，抽到的人匿名投「吃 / 不吃」。一张吃就失败，但没人出局，从头玩到尾。',
  minPlayers: 4,
  slogan: '五轮任务，队里藏着一个想搞事的人',
  // 开局前打上投屏的 3 条规则。大屏、玩家手机、主持台共用这一份，
  // 别在别处再抄一遍 —— 改了规则只改这里。
  rules: [
    '每轮抽一支队伍，队伍里的人按住看身份',
    '队伍匿名投「吃 / 不吃」，好奇宝会偷偷投吃',
    '五轮看谁赢：三轮成功好人赢，三轮失败好奇宝赢',
  ],

  init,

  setup(room, cfg, c) {
    const s = room.game.state;
    const list = live(room);
    if (list.length < 4) throw new Error('至少要 4 个人在线');

    const ids = list.map((p) => p.id);
    const badCount = Math.max(1, Math.min(Number(cfg.bad) || 2, Math.floor(ids.length / 3)));
    s.badIds = shuffle(ids).slice(0, badCount);
    s.round = 1;
    s.results = [];
    s.success = 0;
    s.fail = 0;
    s.winner = '';
    s.result = '';
    s.votes = {};

    for (const id of s.badIds) {
      c.send(id, { t: 'sfx', name: 'wolf' });
      c.say(id, '你是好奇宝 —— 混进队伍，找机会投「吃」');
    }
    for (const p of live(room)) if (!s.badIds.includes(p.id)) c.sfx(p.id, 'ding');

    newTeam(room, c);
  },

  actions: {
    vote(room, c) {
      const s = room.game.state;
      if (s.phase !== 'vote') throw new Error('还没开始投');
      if (!s.team.includes(c.pid)) throw new Error('你不在这一轮队伍里');
      const v = c.payload.targetId || c.payload.v || '';
      if (v !== 'eat' && v !== 'noeat') throw new Error('吃还是不吃？');
      s.votes[c.pid] = v;
      c.sfx(c.pid, 'tick');
      return { ok: true };
    },

    // ---- 主持 ----
    host_open(room, c) {
      const s = room.game.state;
      if (s.phase === 'done') throw new Error('这局已经结束了');
      if (s.phase === 'vote') throw new Error('这一轮还没结算');
      newTeam(room, c);
    },

    host_vote(room, c) {
      const s = room.game.state;
      if (s.phase !== 'pick' && s.phase !== 'result') throw new Error('先抽一轮队伍');
      s.phase = 'vote';
      s.votes = {};
      c.sfxAll('siren');
      c.log('开始投票');
    },

    host_settle(room, c) {
      const s = room.game.state;
      if (s.phase !== 'vote') throw new Error('先开始投票');

      // 只算好奇宝的「吃」；好人手滑投了吃也不作数
      let fails = 0;
      for (const id of s.team) {
        if (s.badIds.includes(id) && s.votes[id] === 'eat') fails += 1;
      }
      const ok = fails === 0;

      s.results.push({ round: s.round, size: s.size, fails, ok, team: s.team.slice() });
      if (ok) s.success += 1;
      else s.fail += 1;
      s.phase = 'result';

      if (ok) {
        c.sfxAll('win');
        c.log(`第 ${s.round} 轮任务成功（${s.success} 成功 / ${s.fail} 失败）`);
      } else {
        c.sfxAll('buzzErr');
        c.log(`第 ${s.round} 轮出现 ${fails} 张「吃」—— 任务失败`);
      }

      if (s.success >= 3) return finish(room, c, 'good');
      if (s.fail >= 3) return finish(room, c, 'wolf');
      if (s.round >= 5) {
        // 五轮打完还没到 3 次，按多的那边算
        return finish(room, c, s.success > s.fail ? 'good' : 'wolf');
      }

      s.round += 1;
      room.game.round = s.round;
    },

    host_next(room, c) {
      module.exports.setup(room, {}, c);
    },
  },

  hostView(room) {
    const s = room.game.state;
    return {
      info: [
        { label: '轮次', value: `第 ${s.round} / 5 轮`, strong: true },
        { label: '好奇宝', value: s.badIds.map((id) => nameOf(room, id)).join('、') || '—', strong: true },
        { label: '比分', value: `成功 ${s.success} · 失败 ${s.fail}`, strong: true },
        { label: '本轮队伍', value: s.team.map((id) => nameOf(room, id)).join('、') || '—' },
        { label: '已投', value: `${Object.keys(s.votes).length} / ${s.team.length}` },
        {
          label: '阶段',
          value:
            s.phase === 'pick'
              ? '等开始投票'
              : s.phase === 'vote'
              ? '投票中'
              : s.phase === 'result'
              ? '已结算'
              : s.phase === 'done'
              ? '结束'
              : '未开始',
        },
      ],
      controls: [
        { kind: 'btn', action: 'host_open', label: '重抽队伍', style: 'plain' },
        { kind: 'btn', action: 'host_vote', label: '开始投票', style: 'primary' },
        { kind: 'btn', action: 'host_settle', label: '结算本轮', style: 'ok' },
        { kind: 'btn', action: 'host_next', label: '重开一局', style: 'plain' },
      ],
      table: {
        columns: ['玩家', '身份', '这轮在队里', '投了吗'],
        rows: room.players.map((p) => [
          p.name,
          s.badIds.includes(p.id) ? '好奇宝' : '普通人',
          s.team.includes(p.id) ? '是' : '—',
          s.votes[p.id] ? '已投' : '—',
        ]),
      },
    };
  },

  playerView(room, pid) {
    const s = room.game.state;
    if (!room.players.some((p) => p.id === pid)) {
      return { type: 'text', title: '围观席', sub: '这一局你不上场' };
    }
    if (s.phase === 'idle') return { type: 'text', title: '好奇宝', sub: '等主持人开局' };
    if (s.phase === 'done') {
      return {
        type: 'text',
        title: s.winner === 'good' ? '好人胜' : '好奇宝胜',
        sub: s.result,
        tone: 'done',
      };
    }

    const isBad = s.badIds.includes(pid);
    const inTeam = s.team.includes(pid);

    if (s.phase === 'vote') {
      if (!inTeam) {
        return {
          type: 'text',
          title: '这轮你不在队里',
          sub: `等他们投（已投 ${Object.keys(s.votes).length} / ${s.team.length}）`,
          tone: 'idle',
        };
      }
      const mine = s.votes[pid];
      return {
        type: 'choice',
        title: '吃，还是不吃',
        sub: mine ? '已投，没人知道是你投的' : '匿名投票，投完就锁',
        action: 'vote',
        options: [
          { value: 'noeat', label: '不吃' },
          { value: 'eat', label: '吃' },
        ],
        selected: mine ? [mine] : [],
        footer: `第 ${s.round} 轮 · 队里 ${s.team.length} 人`,
      };
    }

    if (s.phase === 'result') {
      const last = s.results[s.results.length - 1];
      return {
        type: 'text',
        title: last && last.ok ? '这一轮过了' : '这一轮砸了',
        sub:
          last && last.ok
            ? '没人投吃 —— 任务成功'
            : last
            ? `出现 ${last.fails} 张「吃」，但没人知道是谁`
            : '',
        tone: last && last.ok ? 'good' : 'wolf',
        footer: `成功 ${s.success} · 失败 ${s.fail}`,
      };
    }

    return {
      type: 'word',
      title: inTeam ? '这轮你是执行者' : '这轮你在旁边看',
      // 遮罩外面不能写「你是好奇宝」，旁边的人一眼就看见了
      sub: inTeam ? '按住看你的身份，别给队友看见' : '等主持人叫下一轮',
      text: isBad ? '你是好奇宝' : '你是普通人',
      hold: true,
      tone: isBad ? 'wolf' : 'good',
      footer: `第 ${s.round} 轮 · 成功 ${s.success} / 失败 ${s.fail}`,
    };
  },

  screenView(room) {
    const s = room.game.state;
    if (s.phase === 'idle') {
      return { type: 'podium', title: '好奇宝', big: '准备', sub: '五轮任务，没人会被淘汰' };
    }
    if (s.phase === 'done') {
      return {
        type: 'podium',
        title: '好奇宝',
        big: s.winner === 'good' ? '好人胜' : '好奇宝胜',
        sub: s.result,
      };
    }
    if (s.phase === 'vote') {
      return {
        type: 'podium',
        title: `第 ${s.round} 轮 · 投票`,
        big: `${Object.keys(s.votes).length} / ${s.team.length}`,
        sub: '已投',
      };
    }
    if (s.phase === 'result') {
      const last = s.results[s.results.length - 1];
      return {
        type: 'podium',
        title: `第 ${last ? last.round : s.round} 轮结果`,
        big: last && last.ok ? '任务成功' : '任务失败',
        sub: last && last.ok ? '一张「吃」都没有' : `出现 ${last ? last.fails : 0} 张「吃」`,
        note: `成功 ${s.success} · 失败 ${s.fail}`,
      };
    }
    return {
      type: 'podium',
      title: `第 ${s.round} 轮`,
      big: s.team.map((id) => nameOf(room, id)).join(' · ') || '抽队伍',
      sub: `队伍 ${s.team.length} 人`,
      note: `成功 ${s.success} · 失败 ${s.fail}`,
    };
  },
};
