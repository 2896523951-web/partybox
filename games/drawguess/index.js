'use strict';

const packs = require('../../core/packs');
const T = require('../../core/text');

/* 你画我猜（纸笔版）：画在纸上，手机只管三件事——
 * 给画手发词、给猜的人输入框、计时判分。 */

const PACKS = () => packs.usable('word');

function init() {
  return {
    /* C2：主持判分模式。开着时手机不提交答案，改举手/喊，由主持人判。 */
    handMode: false,
    packId: (PACKS()[0] || {}).id || 'idiom',
    durationSec: 120,
    phase: 'idle', // idle | drawing | result
    drawer: null,
    word: '',
    hint: '',
    guesses: [],
    solvedBy: null,
    used: [],
    // 猜对统计：整局累计，换题不清零。主挂人，队伍分另外算。
    stats: {}, // pid -> { tries, right }
    rounds: [], // [{ word, solvedBy, at }]
  };
}

module.exports = {
  id: 'drawguess',
  name: '你画我猜',
  desc: '画手在纸上画，其他人手机抢答。手机只发词、计时、判分。',
  minPlayers: 2,
  // 自动推进：主持台那颗「开自动」到点会替主持人点这个动作。
  // 只挑「点了不会毁局」的那个 —— 狼人杀那种一步错满盘皆输的流程不配。
  pacing: { action: 'host_next', label: '换一题', sec: 60 },
  slogan: '画的人不能说话，猜的人什么都敢说',
  // 开局前打上投屏的 3 条规则。大屏、玩家手机、主持台共用这一份，
  // 别在别处再抄一遍 —— 改了规则只改这里。
  rules: [
    '系统指定一位画手，画手按住手机看词',
    '在纸上画，不能写字、不能写拼音、不能出声',
    '其他人在手机上提交答案，猜中 +3、画手 +1',
  ],

  init,

  setup(room, cfg) {
    const s = room.game.state;
    const live = room.players.filter((p) => p.online);
    if (live.length < 2) throw new Error('至少两个人');
    if (cfg.packId) s.packId = cfg.packId;
    // 2：开局前在主持台点的人优先（s.preDrawer），其次 cfg，最后随机
    const want = s.preDrawer && live.some((p) => p.id === s.preDrawer) ? s.preDrawer : cfg.drawerId;
    const drawer = want && live.some((p) => p.id === want)
      ? want
      : live[Math.floor(Math.random() * live.length)].id;
    s.preDrawer = '';
    const item = packs.pick(s.packId, new Set(s.used)) || { w: '画蛇添足', hint: '' };

    s.drawer = drawer;
    s.word = item.w;
    s.hint = item.hint || '';
    s.used = [...s.used, s.word].slice(-30);
    s.guesses = [];
    s.solvedBy = null;
    s.phase = 'drawing';
    room.game.timer = {
      endsAt: Date.now() + s.durationSec * 1000,
      label: '画吧',
      total: s.durationSec,
    };
    return { ok: true };
  },

  actions: {
    host_mode(room, c) {
      const s = room.game.state;
      s.handMode = !s.handMode;
      c.log(s.handMode ? '切到举手判分（手机不提交）' : '切回手机提交答案');
      return { ok: true, handMode: s.handMode };
    },

    host_drawer(room, c) {
      const s = room.game.state;
      if (!c.targetId) throw new Error('先在右边点一个玩家');
      if (!room.players.some((p) => p.id === c.targetId)) throw new Error('没有这个人');
      // 2：还没开局就记成「下一局画手」，开局时生效
      if (s.phase === 'idle') {
        s.preDrawer = c.targetId;
        c.log(`${c.target ? c.target.name : '?'} 下一局当画手`);
        return { ok: true, pre: true };
      }
      if (s.phase !== 'drawing') throw new Error('这一轮已经结束了');
      if (c.targetId === s.drawer) return { ok: true };
      s.drawer = c.targetId;
      c.log(`画手换成 ${c.target ? c.target.name : '?'}`);
      return { ok: true };
    },

    guess(room, c) {
      const s = room.game.state;
      if (s.phase !== 'drawing') throw new Error('这轮结束了');
      if (c.pid === s.drawer) throw new Error('你是画的人');
      const text = String(c.payload.text || '').trim();
      if (!text) throw new Error('写点什么');
      s.guesses.push({ pid: c.pid, text: String(text).slice(0, 20) });
      if (s.guesses.length > 40) s.guesses.shift();

      const stat = s.stats[c.pid] || (s.stats[c.pid] = { tries: 0, right: 0 });
      stat.tries += 1;

      if (T.match(text, s.word)) {
        stat.right += 1;
        s.solvedBy = c.pid;
        s.phase = 'result';
        room.game.timer = null;
        s.rounds.push({ word: s.word, solvedBy: c.pid, at: Date.now() });
        c.sfx(c.pid, 'win');
        const gp = room.players.find((p) => p.id === c.pid);
        const dp = room.players.find((p) => p.id === s.drawer);
        if (gp) {
          gp.score += 3;
          room.teams[gp.team] && (room.teams[gp.team].score += 3);
        }
        if (dp) {
          dp.score += 1;
          room.teams[dp.team] && (room.teams[dp.team].score += 1);
        }
        c.log(`${gp ? gp.name : '?'} 猜中「${s.word}」`);
        return { ok: true, correct: true };
      }
      c.sfx(c.pid, 'buzzErr');
      return { ok: true, correct: false };
    },

    host_judge(room, c) {
      const s = room.game.state;
      if (!c.targetId) throw new Error('先选一个猜对的人');
      s.solvedBy = c.targetId;
      s.phase = 'result';
      room.game.timer = null;
      const st = s.stats[c.targetId] || (s.stats[c.targetId] = { tries: 0, right: 0 });
      st.right += 1;
      s.rounds.push({ word: s.word, solvedBy: c.targetId, at: Date.now() });
      const gp = room.players.find((p) => p.id === c.targetId);
      if (gp) {
        gp.score += 3;
        room.teams[gp.team] && (room.teams[gp.team].score += 3);
      }
      c.log(`判 ${c.target ? c.target.name : '?'} 猜中`);
      return { ok: true };
    },

    host_reveal(room, c) {
      const s = room.game.state;
      s.phase = 'result';
      room.game.timer = null;
      s.rounds.push({ word: s.word, solvedBy: null, at: Date.now() });
      c.log(`公布答案：${s.word}`);
      return { ok: true };
    },

    host_next(room, c) {
      module.exports.setup(room, { packId: room.game.state.packId }, c);
      room.game.round += 1;
      return { ok: true };
    },

    host_pack(room, c) {
      if (c.payload.packId) room.game.state.packId = c.payload.packId;
      return { ok: true };
    },
  },

  /* C2：主持判分模式下的记分。判对就按原规则 +3（画手 +1）。 */
  judge(room, pid, ok, c) {
    const s = room.game.state;
    if (!s.handMode || !ok || s.phase !== 'drawing' || pid === s.drawer) return null;
    s.solvedBy = pid;
    s.phase = 'result';
    room.game.timer = null;
    const st = s.stats[pid] || (s.stats[pid] = { tries: 0, right: 0 });
    st.right += 1;
    s.rounds.push({ word: s.word, solvedBy: pid, at: Date.now() });
    const gp = room.players.find((p) => p.id === pid);
    const dp = room.players.find((p) => p.id === s.drawer);
    if (gp) { gp.score += 3; room.teams[gp.team] && (room.teams[gp.team].score += 3); }
    if (dp) { dp.score += 1; room.teams[dp.team] && (room.teams[dp.team].score += 1); }
    c.sfxAll('win');
    c.log(`${gp ? gp.name : '?'} 猜中「${s.word}」`);
    return { points: 3 };
  },

  hostView(room) {
    const s = room.game.state;
    const d = room.players.find((p) => p.id === s.drawer);
    const tot = totalStats(s);
    return {
      info: [
        { label: '本轮词', value: s.word || '—', strong: true },
        { label: '提示', value: s.hint || '—' },
        { label: '画手', value: d ? d.name : '—' },
        { label: '猜中', value: s.solvedBy ? nameOf(room, s.solvedBy) : '—' },
        { label: '累计猜中', value: `${tot.right} 次 / 共猜 ${tot.tries} 次` },
        { label: '已出题', value: `${s.rounds.length} 题` },
      ],
      controls: [
        { kind: 'btn', action: 'host_next', label: s.phase === 'idle' ? '开始' : '换一题', style: 'primary' },
        { kind: 'btn', action: 'host_judge', label: '选中的人猜对了', target: true, style: 'ok' },
        { kind: 'btn', action: 'host_drawer', label: s.phase === 'idle' ? '选中的人下一局当画手' : '选中的人当画手', target: true, style: 'plain' },
        { kind: 'btn', action: 'host_mode', label: s.handMode ? '切回手机提交' : '切到举手判分', style: 'plain' },
        { kind: 'btn', action: 'host_reveal', label: '公布答案', style: 'danger' },
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
        columns: ['玩家', '猜中', '猜了', '命中率', '最新猜测'],
        rows: statRows(room, s),
      },
    };
  },

  playerView(room, pid) {
    const s = room.game.state;
    if (s.phase === 'idle') return { type: 'text', title: '你画我猜', sub: '等人齐' };
    if (s.phase === 'result') {
      return {
        type: 'text',
        title: s.solvedBy ? `${nameOf(room, s.solvedBy)} 猜中` : '没人猜中',
        sub: `答案是「${s.word}」`,
        tone: 'done',
        reveal: s.word,
      };
    }
    if (pid === s.drawer) {
      return {
        type: 'word',
        title: '你是画手',
        sub: '画在纸上，不能写字、不能出声。他们手机上会看到字数。',
        text: s.word,
        hint: s.hint,
        len: T.len(s.word),
        hold: true,
        footer: `共 ${T.len(s.word)} 个字`,
      };
    }
    if (s.handMode) {
      return {
        type: 'text',
        title: '喊出来',
        sub: `共 ${T.len(s.word)} 个字，想到就喊，主持人判`,
        tone: 'active',
        hint: `${T.len(s.word)} 个字`,
        footer: '这轮不用在手机上写',
      };
    }
    const mine = s.stats[pid] || { tries: 0, right: 0 };
    return {
      type: 'answer',
      title: '猜猜画的是什么',
      sub: `共 ${T.len(s.word)} 个字，想到就写`,
      placeholder: '你的答案',
      action: 'guess',
      hint: `${T.len(s.word)} 个字`,
      footer: `你已猜中 ${mine.right} 次 · 本轮 ${s.guesses.length} 次猜测`,
    };
  },

  screenView(room) {
    const s = room.game.state;
    const tot = totalStats(s);
    const lead = statRows(room, s)
      .map((r) => ({ name: r[0], right: Number(r[1]) }))
      .filter((x) => x.right > 0)
      .slice(0, 3)
      .map((x) => `${x.name} ${x.right}`)
      .join(' · ');
    return {
      type: 'relay',
      title: '你画我猜',
      big: s.phase === 'drawing' ? `${T.len(s.word)} 个字` : s.word,
      sub: s.phase === 'idle' ? '等人齐' : `画手：${nameOf(room, s.drawer)}`,
      hint:
        s.phase === 'drawing'
          ? '画在纸上'
          : tot.tries
          ? `累计猜中 ${tot.right} 次${lead ? ' · ' + lead : ''}`
          : '',
    };
  },

  tick(room, now) {
    const s = room.game.state;
    const t = room.game.timer;
    if (!t || !t.endsAt) return false;
    if (now < t.endsAt) return false;
    if (s.phase === 'drawing') {
      s.phase = 'result';
      room.game.timer = null;
      return true;
    }
    return false;
  },
};

function latestGuesses(room, s) {
  const last = {};
  for (const g of s.guesses) last[g.pid] = g.text;
  return Object.entries(last).map(([pid, text]) => [nameOf(room, pid), text]);
}

// 谁猜中了几次 / 一共猜了几次。按猜中次数排，没猜过的排后面。
function statRows(room, s) {
  const last = {};
  for (const g of s.guesses) last[g.pid] = g.text;
  const rows = room.players.map((p) => {
    const st = s.stats[p.id] || { tries: 0, right: 0 };
    const rate = st.tries ? Math.round((st.right / st.tries) * 100) + '%' : '—';
    return {
      score: st.right,
      row: [p.name, String(st.right), String(st.tries), rate, last[p.id] || '—'],
    };
  });
  rows.sort((a, b) => b.score - a.score);
  return rows.map((x) => x.row);
}

function totalStats(s) {
  let right = 0;
  let tries = 0;
  for (const k of Object.keys(s.stats || {})) {
    right += s.stats[k].right || 0;
    tries += s.stats[k].tries || 0;
  }
  return { right, tries };
}

function nameOf(room, id) {
  const p = room.players.find((x) => x.id === id);
  return p ? p.name : '—';
}
