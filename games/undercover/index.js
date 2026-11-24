'use strict';

const packs = require('../../core/packs');

/* 谁是卧底 / 伪装大师：大多数人拿到同一个词，卧底拿到近义词。
 * 手机只给本人看词，按住才显示。投票匿名，计票在服务端。
 *
 * 三种玩法：
 *   standard  标准   —— 大多数人一个词，卧底拿近义词
 *   blank     白板   —— 一个人根本没词，全靠听别人怎么描述来猜
 *   team      双卧底 —— 两个卧底拿同一个词，而且开场就互相知道
 *
 * 硬规则：三种玩法在玩家手机上必须长得一模一样。
 * 白板不能因为「屏幕上少了点什么」被抓出来；
 * 卧底的「同伙：XXX」也只能在遮罩下面看 —— 放进 hint（遮罩外面）
 * 等于把身份贴在脸上，旁边一歪头就看见。
 */

const PACKS = () => packs.usable('pair');

const MODES = [
  { id: 'standard', label: '标准', desc: '大多数人同一个词，卧底拿近义词' },
  { id: 'blank', label: '白板', desc: '一个人没词，靠听别人描述猜' },
  { id: 'team', label: '双卧底', desc: '两个卧底同一个词，而且互相知道' },
];
const MODE_IDS = MODES.map((m) => m.id);

// 所有玩法共用这一层壳。「别人看到的是另一个词」在白板局不成立，
// 所以文案写死成中性的，靠词卡内容区分身份。
const SKIN = {
  title: '你的词',
  sub: '按住看，松手就消失。别让旁边的人瞄到。',
};

function init() {
  return {
    packId: (PACKS()[0] || {}).id || 'undercover',
    // mode 是本局真正在用的；nextMode 是主持人在下拉里选的、下一局才生效。
    // 分开存是因为下拉值一改就覆盖 mode 的话，主持台上会显示「白板局」，
    // 但场上这几个人手里拿的还是标准局的词。
    mode: 'standard',
    nextMode: '',
    undercoverCount: 1,
    nextCount: 0,
    blank: [],
    phase: 'idle', // idle | speak | vote | result
    /* S2 逐条揭晓：计票后先把「谁投了谁」一条条放出来，最后一条是汇总。
     * 结果是当场就定下的，只是放慢给观众看 —— 所以它只影响显示。 */
    reveal: null,
    pair: { a: '', b: '' },
    wordOf: {},
    undercover: [],
    order: [],
    turn: 0,
    votes: {},
    out: [],
    round: 1,
    lastOut: null,
    result: '',
  };
}

/* 主持脚本（H1）：三个主力游戏之一，全套台词。 */
const SCRIPT = [
  { at: 0, cue: '发词', say: '每人一个词，看完锁屏。有人的词跟别人不一样。', fx: 'deal' },
  { at: 20, cue: '描述', say: '从左手边开始，一人一句话，别把词说破。' },
  { at: 40, cue: '投票', say: '同时指人，三、二、一。' },
  { at: 60, cue: '平票', say: '平票就再来一轮描述，只准说别人没说过的。' },
  { at: 80, cue: '揭晓', say: '翻牌吧，看看谁是卧底。', fx: 'reveal' },
  { at: 100, cue: '下一轮', say: '这局到这儿，下一局换个词，还是这些人。' },
];

module.exports = {
  script: SCRIPT,

  id: 'undercover',
  name: '谁是卧底',
  desc: '绝大多数人拿到同一个词，卧底拿到近义词。轮流描述，然后投票把人投出去。',
  minPlayers: 4,
  // 自动推进：主持台那颗「开自动」到点会替主持人点这个动作。
  // 只挑「点了不会毁局」的那个 —— 狼人杀那种一步错满盘皆输的流程不配。
  pacing: { action: 'host_next', label: '下一位', sec: 30 },
  // P2：这几个动作交上去就算「完成」，玩家端会显示「还差几人」
  // S4：现在是不是在投票（core 拿它起 60 秒倒计时）
  voteOpen(room) {
    const s = room.game.state;
    return s.phase === 'vote';
  },

  submitActions: ['vote'],
  slogan: '一个词之差，谁在装？',
  // 开局前打上投屏的 3 条规则。大屏、玩家手机、主持台共用这一份，
  // 别在别处再抄一遍 —— 改了规则只改这里。
  rules: [
    '每人按住看词，卧底拿的是近义词',
    '轮流用一句话描述，不能说出词本身',
    '投票投出最可疑的人，卧底全出平民赢',
  ],

  init,
  MODES,

  setup(room, cfg) {
    const s = room.game.state;
    const live = room.players.filter((p) => p.online);
    const n = live.length;
    if (n < 4) throw new Error('卧底局至少要 4 个人');

    if (cfg && cfg.packId) s.packId = cfg.packId;

    // 优先级：本次调用显式传的 > 主持人之前选好待用的 > 上一局用的
    // （主持台点「开局」走的是 b.cfg，里面没有 mode，只能从 state 里读）
    const cfgMode = String((cfg && (cfg.nextMode || cfg.mode)) || '');
    let mode = cfgMode || s.nextMode || s.mode || 'standard';
    if (MODE_IDS.indexOf(mode) < 0) mode = 'standard';

    // 人数：先用主持人选的，没有就用上一局实际的
    const wantCount =
      Number((cfg && cfg.nextCount) || 0) || Number(s.nextCount) || Number(s.undercoverCount) || 1;

    // 双卧底 2 打 2 就是开局即结束，所以卡在 5 个人
    if (mode === 'team' && n < 5) {
      throw new Error(`双卧底至少要 5 个人（2 卧底 + 3 平民），现在只有 ${n} 个`);
    }

    const item = packs.pick(s.packId, null) || { a: '豆浆', b: '豆奶' };
    const shuffled = packs.shuffle(live.map((p) => p.id));

    // 校验都过了才动状态 —— 报错的时候不能把 nextMode 吃掉
    s.nextMode = '';
    s.nextCount = 0;
    s.mode = mode;
    s.undercover = [];
    s.blank = [];
    s.wordOf = {};

    if (mode === 'blank') {
      s.blank = shuffled.slice(0, 1);
      // 用词对里的哪一边随机：否则白板只要盯死「永远是左边那个词」就够了
      const word = Math.random() < 0.5 ? item.a : item.b;
      s.pair = { a: word, b: '' };
      s.undercoverCount = 0;
      for (const pid of shuffled) if (!s.blank.includes(pid)) s.wordOf[pid] = word;
    } else if (mode === 'team') {
      s.pair = { a: item.a, b: item.b };
      s.undercover = shuffled.slice(0, 2);
      s.undercoverCount = 2;
      for (const pid of shuffled) s.wordOf[pid] = s.undercover.includes(pid) ? item.b : item.a;
    } else {
      const count = Math.max(1, Math.min(wantCount, Math.floor((n - 1) / 2)));
      s.pair = { a: item.a, b: item.b };
      s.undercover = shuffled.slice(0, count);
      s.undercoverCount = count;
      for (const pid of shuffled) s.wordOf[pid] = s.undercover.includes(pid) ? item.b : item.a;
    }

    s.order = shuffled;
    s.turn = 0;
    s.votes = {};
    s.out = [];
    s.phase = 'speak';
    s.round = 1;
    s.lastOut = null;
    s.result = '';
    room.game.timer = null;
    return { ok: true };
  },

  actions: {
    vote(room, c) {
      const s = room.game.state;
      if (s.phase !== 'vote') throw new Error('还没开始投票');
      if (s.out.includes(c.pid)) throw new Error('你出局了');
      const target = String(c.payload.targetId || '');
      const alive = aliveIds(room, s);
      if (!alive.includes(target)) throw new Error('投不了这个人');
      if (target === c.pid) throw new Error('不能投自己');
      s.votes[c.pid] = target;
      return { ok: true };
    },

    host_next(room, c) {
      const s = room.game.state;
      s.turn = Math.min(s.turn + 1, s.order.length - 1);
      return { ok: true };
    },

    host_vote(room, c) {
      const s = room.game.state;
      s.phase = 'vote';
      s.votes = {};
      s.reveal = null;
      c.log('开始投票');
      return { ok: true };
    },

    host_tally(room, c) {
      const s = room.game.state;
      const alive = aliveIds(room, s);
      const count = {};
      for (const id of alive) count[id] = 0;
      for (const [voter, target] of Object.entries(s.votes)) {
        if (count[target] !== undefined) count[target] += 1;
      }
      const max = Math.max(0, ...Object.values(count));
      if (max === 0) throw new Error('还没有人投票');
      const tops = Object.keys(count).filter((id) => count[id] === max);
      if (tops.length > 1) {
        s.votes = {};
        s.phase = 'speak';
        c.log(`平票（${tops.length} 人 ${max} 票），重投`);
        return { ok: true, tie: true };
      }
      const outId = tops[0];
      s.out.push(outId);
      s.lastOut = outId;
      const p = room.players.find((x) => x.id === outId);
      c.log(`${p ? p.name : '?'} 被投出，身份是${roleOf(s, outId)}`);
      // 投票是一张张投的，揭晓也一条条来；最后一条汇总
      const lines = Object.entries(s.votes).map(
        ([voter, target]) => `${nameOf(room, voter)} → ${nameOf(room, target)}`
      );
      lines.push(`共 ${lines.length} 票 · ${p ? p.name : '?'} 最高（${max} 票）`);
      s.reveal = { lines, n: 0, at: Date.now() };
      s.votes = {};
      s.phase = 'speak';
      checkEnd(room, c);
      return { ok: true, out: outId };
    },

    /* S2：主持点一下出一条；8 秒没人点自动往下走，不会卡在中间那条 */
    host_revealNext(room, c) {
      const s = room.game.state;
      if (!s.reveal) return { ok: true };
      s.reveal.n += 1;
      s.reveal.at = Date.now();
      if (s.reveal.n >= s.reveal.lines.length) s.reveal = null;
      return { ok: true };
    },

    host_reveal(room, c) {
      const s = room.game.state;
      checkEnd(room, c, true);
      return { ok: true };
    },

    host_nextRound(room, c) {
      for (const pl of room.players) pl.submitRound = 0; // 新一轮，完成态清零
      const s = room.game.state;
      // 把本局实际用的配置一起带过去：next* 在 setup 里会被清空，
      // 不显式传的话第二局之后就退回默认了
      module.exports.setup(
        room,
        {
          packId: s.packId,
          mode: s.mode,
          nextMode: s.nextMode,
          undercoverCount: s.undercoverCount,
          nextCount: s.nextCount,
        },
        c
      );
      room.game.round += 1;
      return { ok: true };
    },

    /* 换玩法。这局已经发完词了，改规则会让手上拿着词的人无所适从，
     * 所以只记下来，下一局生效 —— 和换词库一个道理。 */
    host_mode(room, c) {
      const s = room.game.state;
      const id = String(c.payload.mode || '');
      const m = MODES.find((x) => x.id === id);
      if (!m) throw new Error('没有这个玩法');
      s.nextMode = id === s.mode ? '' : id;
      if (s.phase === 'idle' || s.phase === 'result') c.log(`玩法：${m.label}`);
      else if (s.nextMode) c.log(`下一局换成「${m.label}」—— 这局的词已经发出去了，规则照旧`);
      else c.log(`下一局还是「${m.label}」`);
      return { ok: true };
    },

    host_undercover(room, c) {
      const s = room.game.state;
      const n = Math.max(1, Math.min(Number(c.payload.count) || 1, 4));
      s.nextCount = n === s.undercoverCount ? 0 : n;
      if (s.phase !== 'idle' && s.phase !== 'result') c.log(`下一局卧底 ${n} 人`);
      return { ok: true };
    },

    /* 换主题。这局的词已经发出去了，改的是下一局 —— 所以不重开，
     * 只在日志里说清楚，免得主持人以为当场就换了。 */
    host_pack(room, c) {
      const s = room.game.state;
      const id = String(c.payload.packId || '');
      if (!id || !packs.get(id)) throw new Error('没有这个词库');
      s.packId = id;
      const p = packs.get(id);
      if (s.phase === 'idle') c.log(`词库换成「${p.name}」（${p.items.length} 对）`);
      else c.log(`下一局换成「${p.name}」（${p.items.length} 对），这局继续用原来的词`);
      return { ok: true };
    },
  },

  hostView(room) {
    const s = room.game.state;
    const tally = tallyOf(room, s);
    const mode = s.mode || 'standard';
    const modeLabel = modeName(mode);

    const info = [
      { label: mode === 'blank' ? '全民词' : '平民词', value: s.pair.a || '—', strong: true },
    ];
    if (mode !== 'blank') info.push({ label: '卧底词', value: s.pair.b || '—', strong: true });

    if (mode === 'blank') {
      const b = (s.blank || []).map((id) => nameOf(room, id)).join('、') || '—';
      info.push({ label: '白板', value: b, strong: true });
    } else {
      const u = s.undercover.map((id) => nameOf(room, id)).join('、') || '—';
      info.push({ label: '卧底', value: u, strong: true });
    }

    info.push({ label: '玩法', value: modeLabel + (s.nextMode ? ` → 下局：${modeName(s.nextMode)}` : '') });
    info.push({ label: '阶段', value: { idle: '未开始', speak: '发言中', vote: '投票中', result: '已结束' }[s.phase] });
    info.push({ label: '轮到', value: nameOf(room, s.order[s.turn]) || '—' });
    info.push({ label: '出局', value: s.out.map((id) => nameOf(room, id)).join('、') || '—' });

    const controls = [
      { kind: 'btn', action: 'host_nextRound', label: s.phase === 'idle' ? '发词开局' : '重开一局', style: 'primary' },
      { kind: 'btn', action: 'host_next', label: '下一位发言', style: 'plain' },
      { kind: 'btn', action: 'host_vote', label: '开始投票', style: 'plain' },
      { kind: 'btn', action: 'host_tally', label: '计票', style: 'ok' },
      { kind: 'btn', action: 'host_revealNext', label: '下一条揭晓', style: s.reveal ? 'primary' : 'plain' },
      { kind: 'btn', action: 'host_reveal', label: '直接摊牌', style: 'danger' },
      {
        kind: 'select',
        action: 'host_pack',
        name: 'packId',
        label: '词库',
        value: s.packId,
        options: PACKS().map((p) => ({ value: p.id, label: `${p.name}（${p.items.length}）` })),
      },
      {
        kind: 'select',
        action: 'host_mode',
        name: 'mode',
        label: '玩法',
        value: s.nextMode || s.mode,
        options: MODES.map((m) => ({ value: m.id, label: `${m.label} · ${m.desc}` })),
      },
    ];

    // 白板固定一个、双卧底固定两个，只有标准局才让人调人数
    if (mode === 'standard') {
      controls.push({
        kind: 'select',
        action: 'host_undercover',
        name: 'count',
        label: '卧底人数',
        value: String(s.nextCount || s.undercoverCount || 1),
        options: [1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n} 人` })),
      });
    }

    return {
      info,
      controls,
      table: {
        columns: ['玩家', '票数', '状态'],
        rows: room.players.map((p) => [
          p.name,
          String(tally[p.id] || 0),
          s.out.includes(p.id) ? `出局 · ${roleOf(s, p.id)}` : '在场',
        ]),
      },
    };
  },

  playerView(room, pid) {
    const s = room.game.state;
    if (s.phase === 'idle') return { type: 'text', title: '谁是卧底', sub: '等人齐，主持发词' };

    const mode = s.mode || 'standard';
    const isBlank = (s.blank || []).includes(pid);
    // 白板手里也有「一个词」，只是那个词叫白板 —— 屏幕不能空着，
    // 空着的手机在桌上一眼就能认出来
    const myWord = isBlank ? '白板' : s.wordOf[pid];
    if (!myWord) return { type: 'text', title: '围观席', sub: '这一局你没拿到词' };

    const out = s.out.includes(pid);
    const head = {
      type: 'word',
      title: out ? '你出局了' : SKIN.title,
      sub: out ? '安静看戏，别提示' : SKIN.sub,
      text: out ? '出局' : myWord,
      hold: !out,
      tone: out ? 'muted' : '',
    };

    // 同伙只在遮罩下面看。note 走词卡内部，不走 hint（hint 在遮罩外面）
    if (!out && mode === 'team' && s.undercover.includes(pid)) {
      const mates = s.undercover.filter((id) => id !== pid).map((id) => nameOf(room, id));
      if (mates.length) head.note = '同伙：' + mates.join('、');
    }

    if (s.phase === 'result') {
      const sub =
        mode === 'blank'
          ? `全民词：${s.pair.a} · 白板：${(s.blank || []).map((id) => nameOf(room, id)).join('、')}`
          : `平民词：${s.pair.a} · 卧底词：${s.pair.b}`;
      return { type: 'text', title: s.result || '本局结束', sub, tone: 'done' };
    }

    if (out) return { type: 'text', title: '你出局了', sub: '安静看戏，别给提示' };

    if (s.phase === 'vote') {
      const alive = aliveIds(room, s).filter((id) => id !== pid);
      head.sub = mode === 'blank' ? '现在投票：谁最像白板' : '现在投票：选一个你认为是卧底的人';
      head.choice = {
        title: '投票',
        action: 'vote',
        options: alive.map((id) => ({ value: id, label: nameOf(room, id) })),
        submitLabel: '投他',
      };
      return head;
    }

    const cur = s.order[s.turn];
    head.sub =
      cur === pid ? '轮到你发言：描述你的词，别说得太清楚' : `轮到 ${nameOf(room, cur)} 发言`;
    head.tone = cur === pid ? 'active' : '';
    return head;
  },

  tick(room, now) {
    const s = room.game.state;
    if (!s.reveal) return false;
    if (now - s.reveal.at < 8000) return false;
    s.reveal.n += 1;
    s.reveal.at = now;
    if (s.reveal.n >= s.reveal.lines.length) s.reveal = null;
    return true;
  },

  screenView(room) {
    const s = room.game.state;
    if (s.reveal) {
      return {
        type: 'reveal',
        title: '投票揭晓',
        sub: `${Math.min(s.reveal.n + 1, s.reveal.lines.length)} / ${s.reveal.lines.length}`,
        lines: s.reveal.lines.slice(0, s.reveal.n + 1),
        note: '主持人点「下一条」，或 8 秒自动往下',
      };
    }
    const tally = tallyOf(room, s);
    if (s.phase === 'result') {
      return { type: 'podium', title: s.result || '本局结束', sub: '看主持台' };
    }
    return {
      type: 'bars',
      title: '谁是卧底',
      sub:
        s.phase === 'vote'
          ? '投票中'
          : s.phase === 'speak'
            ? `轮到 ${nameOf(room, s.order[s.turn])} 发言`
            : '等人齐',
      bars: room.players
        .filter((p) => !s.out.includes(p.id))
        .map((p) => ({ label: p.name, value: tally[p.id] || 0 }))
        .sort((a, b) => b.value - a.value),
      note: s.lastOut ? `上一轮出局：${nameOf(room, s.lastOut)}` : '',
    };
  },
};

function modeName(id) {
  const m = MODES.find((x) => x.id === id);
  return m ? m.label : '标准';
}

// 主持台和日志都用这个：白板局的「卧底」其实是白板
function roleOf(s, id) {
  if ((s.mode || 'standard') === 'blank') return (s.blank || []).includes(id) ? '白板' : '平民';
  return (s.undercover || []).includes(id) ? '卧底' : '平民';
}

function aliveIds(room, s) {
  return room.players.filter((p) => !s.out.includes(p.id)).map((p) => p.id);
}

function tallyOf(room, s) {
  const count = {};
  for (const target of Object.values(s.votes)) count[target] = (count[target] || 0) + 1;
  return count;
}

function nameOf(room, id) {
  const p = room.players.find((x) => x.id === id);
  return p ? p.name : '—';
}

function checkEnd(room, c, force) {
  const s = room.game.state;
  const alive = aliveIds(room, s);

  if (force) {
    s.phase = 'result';
    s.result = '主持人摊牌';
    return;
  }

  if ((s.mode || 'standard') === 'blank') {
    const blankAlive = alive.filter((id) => (s.blank || []).includes(id));
    if (!blankAlive.length) {
      s.phase = 'result';
      s.result = '平民获胜';
      for (const id of alive) {
        const p = room.players.find((x) => x.id === id);
        if (p) {
          p.score += 3;
          room.teams[p.team] && (room.teams[p.team].score += 3);
        }
      }
      c.log('平民获胜 —— 白板被投出去了');
      return;
    }
    // 剩两个人还没把白板投出去，这局就结束了：一票对一票永远平
    if (alive.length <= 2) {
      s.phase = 'result';
      s.result = '白板获胜';
      for (const id of blankAlive) {
        const p = room.players.find((x) => x.id === id);
        if (p) {
          p.score += 5;
          room.teams[p.team] && (room.teams[p.team].score += 5);
        }
      }
      c.log('白板获胜 —— 撑到了最后两个');
      return;
    }
    return;
  }

  const underAlive = alive.filter((id) => s.undercover.includes(id));
  const civAlive = alive.length - underAlive.length;

  if (underAlive.length === 0) {
    s.phase = 'result';
    s.result = '平民获胜';
    for (const id of alive) {
      const p = room.players.find((x) => x.id === id);
      if (p && !s.undercover.includes(id)) {
        p.score += 3;
        room.teams[p.team] && (room.teams[p.team].score += 3);
      }
    }
    c.log('平民获胜');
    return;
  }
  if (underAlive.length >= civAlive) {
    s.phase = 'result';
    s.result = '卧底获胜';
    for (const id of underAlive) {
      const p = room.players.find((x) => x.id === id);
      if (p) {
        p.score += 5;
        room.teams[p.team] && (room.teams[p.team].score += 5);
      }
    }
    c.log('卧底获胜');
  }
}
