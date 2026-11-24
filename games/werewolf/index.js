'use strict';

/* 狼人杀（节目休闲版）：2 狼 + 预言家 + 女巫 + 猎人 + 平民。
 *
 * 手机只做一件事：把「只有你能知道」的东西发给你一个人。
 *   - 狼人夜里看到队友和刀口
 *   - 预言家看到验人结果
 *   - 女巫看到今晚谁被刀，决定救还是毒
 * 发言、表情、盘逻辑全在桌上，手机不参与 —— 一旦能打字，这游戏就废了。 */

const ROLE_NAME = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  villager: '平民',
};

function init() {
  return {
    phase: 'idle', // idle | night | day | vote | done
    step: '', // wolf | seer | witch | ''
    round: 0,
    roles: {}, // pid -> 'wolf' | 'seer' | 'witch' | 'hunter' | 'villager'
    wolfVotes: {}, // 狼人 pid -> 目标 pid
    wolfTarget: '',
    seerId: '',
    seerCheck: null, // { at, targetId, isWolf }
    witchId: '',
    witchStep: '', // save | poison | done
    witchSave: null, // true / false / null
    witchPoison: '',
    potion: { heal: true, poison: true },
    deaths: [], // 今夜死亡
    lastDeaths: [],
    votes: {},
    history: [],
    winner: '',
    result: '',
    round1wolves: [],
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

function nameOf(room, id) {
  const p = room.players.find((x) => x.id === id);
  return p ? p.name : '—';
}

function inGame(room) {
  const s = room.game.state;
  return room.players.filter((p) => s.roles[p.id]);
}

function aliveOf(room) {
  return inGame(room).filter((p) => p.alive);
}

function wolvesAlive(room) {
  const s = room.game.state;
  return aliveOf(room).filter((p) => s.roles[p.id] === 'wolf');
}

function roleOf(room, pid) {
  return room.game.state.roles[pid] || '';
}

// 按人数配一套能玩的身份
function makeRoles(n) {
  const wolves = n <= 5 ? 1 : n <= 8 ? 2 : n <= 11 ? 3 : 4;
  const gods = [];
  if (n >= 6) gods.push('seer', 'witch');
  if (n >= 7) gods.push('hunter');
  const rest = Math.max(0, n - wolves - gods.length);
  return shuffle([...Array(wolves).fill('wolf'), ...gods, ...Array(rest).fill('villager')]);
}

function checkWin(room) {
  const alive = aliveOf(room);
  const wolves = alive.filter((p) => roleOf(room, p.id) === 'wolf').length;
  const good = alive.length - wolves;
  if (wolves === 0) return 'good';
  if (wolves >= good) return 'wolf';
  return '';
}

function finish(room, c, winner) {
  const s = room.game.state;
  s.phase = 'done';
  s.winner = winner;
  const names = inGame(room)
    .map((p) => `${p.name}（${ROLE_NAME[roleOf(room, p.id)] || '?'}）`)
    .join('、');
  s.result = `${winner === 'good' ? '好人胜' : '狼人胜'}：${names}`;
  c.sfxAll(winner === 'good' ? 'win' : 'wolf');
  c.log(s.result);
}

function settleNight(room, c) {
  const s = room.game.state;
  const dead = [];
  const target = s.wolfTarget;
  if (target && s.witchSave !== true) dead.push(target);
  if (s.witchPoison && !dead.includes(s.witchPoison)) dead.push(s.witchPoison);

  for (const id of dead) {
    const p = room.players.find((x) => x.id === id);
    if (p) p.alive = false;
  }
  s.lastDeaths = dead;
  s.history.push({ round: s.round, deaths: dead.slice() });
  s.phase = 'day';
  s.step = '';

  if (dead.length) {
    c.sfxAll('wolf');
    c.log(`天亮了 · 出局：${dead.map((id) => nameOf(room, id)).join('、')}`);
  } else {
    c.sfxAll('ding');
    c.log('天亮了 · 平安夜');
  }

  const hunter = dead.find((id) => roleOf(room, id) === 'hunter');
  if (hunter) c.say(hunter, '你是猎人 —— 可以开枪带走一个人');

  const w = checkWin(room);
  if (w) finish(room, c, w);
}

/* 主持脚本（H1）：现场照着念，别背。cue 是短标题（≤8 字），
 * say 是嘴里要说的那句话（≤40 字，口语）。 */
const SCRIPT = [
  { at: 0, cue: '发身份', say: '身份发到手机上了，按住看，看完锁屏，别给旁边人看。', fx: 'deal' },
  { at: 20, cue: '天黑', say: '天黑请闭眼，手机也都扣到桌上。', fx: 'hush' },
  { at: 40, cue: '狼人睁眼', say: '狼人睁眼，认一下队友，定一个刀口。' },
  { at: 60, cue: '预言家', say: '预言家睁眼，验一个人，看完点头就行。' },
  { at: 80, cue: '女巫用药', say: '女巫睁眼，救不救、毒不毒，自己定。' },
  { at: 100, cue: '天亮', say: '天亮了。昨晚倒下的是——先别急着说。', fx: 'dead' },
  { at: 120, cue: '遗言', say: '你最后说一句，可以是真的，也可以是假的。' },
  { at: 140, cue: '发言投票', say: '从这边开始，一人一句，说完就投，投完翻牌。' },
];

module.exports = {
  script: SCRIPT,

  id: 'werewolf',
  name: '狼人杀',
  desc: '2 狼 + 预言家 + 女巫 + 猎人 + 平民。夜里手机只发给你一个人该看的，天亮靠嘴。',
  // S4：现在是不是在投票（core 拿它起 60 秒倒计时）
  voteOpen(room) {
    const s = room.game.state;
    return s.phase === 'vote';
  },

  submitActions: ['vote'],
  minPlayers: 4,
  slogan: '天黑请闭眼，天亮开始演',
  // 开局前打上投屏的 3 条规则。大屏、玩家手机、主持台共用这一份，
  // 别在别处再抄一遍 —— 改了规则只改这里。
  rules: [
    '夜里手机只把该你一个人看的信息发给你',
    '天亮公布死讯，猎人出局可以开枪带走一个人',
    '白天发言后投票，狼人全出好人赢',
  ],

  init,

  setup(room, cfg, c) {
    const s = room.game.state;
    const live = room.players.filter((p) => p.online);
    if (live.length < 4) throw new Error('至少 4 个人在线');

    const order = shuffle(live.map((p) => p.id));
    const roles = makeRoles(order.length);

    s.phase = 'night';
    s.step = 'wolf';
    s.round = 1;
    s.roles = {};
    s.wolfVotes = {};
    s.wolfTarget = '';
    s.seerCheck = null;
    s.witchStep = '';
    s.witchSave = null;
    s.witchPoison = '';
    s.potion = { heal: true, poison: true };
    s.deaths = [];
    s.lastDeaths = [];
    s.votes = {};
    s.history = [];
    s.winner = '';
    s.result = '';

    for (const p of room.players) p.alive = true;
    order.forEach((id, i) => {
      s.roles[id] = roles[i];
    });

    s.seerId = order.find((id) => s.roles[id] === 'seer') || '';
    s.witchId = order.find((id) => s.roles[id] === 'witch') || '';
    s.round1wolves = order.filter((id) => s.roles[id] === 'wolf');

    // 每个人都在自己手机上看身份，不用主持人一个一个告知
    for (const p of live) {
      const r = s.roles[p.id];
      c.sfx(p.id, r === 'wolf' ? 'wolf' : 'ding');
    }
    room.game.round = 1;
    room.game.timer = null;

    c.log(
      `第 1 夜 · ${order.length} 人局：狼 ${s.round1wolves.length} · 神 ${
        order.filter((id) => ['seer', 'witch', 'hunter'].includes(s.roles[id])).length
      }`
    );
  },

  actions: {
    // 狼人选刀口：谁最后点算谁的，但队友能看到同伴点了谁
    wolfbite(room, c) {
      const s = room.game.state;
      if (s.phase !== 'night' || s.step !== 'wolf') throw new Error('现在不是狼人回合');
      if (roleOf(room, c.pid) !== 'wolf') throw new Error('你不是狼人');
      const t = c.payload.targetId || (Array.isArray(c.payload.targets) ? c.payload.targets[0] : '');
      if (!t) throw new Error('选一个人');
      if (roleOf(room, t) === 'wolf') throw new Error('不能刀自己人');
      s.wolfVotes[c.pid] = t;
      s.wolfTarget = t;
      c.sfx(c.pid, 'tick');
      c.log(`狼人刀了 ${nameOf(room, t)}`);
      return { ok: true };
    },

    // 预言家验人
    seercheck(room, c) {
      const s = room.game.state;
      if (s.phase !== 'night' || s.step !== 'seer') throw new Error('现在不是预言家回合');
      if (c.pid !== s.seerId) throw new Error('你不是预言家');
      if (s.seerCheck && s.seerCheck.round === s.round) throw new Error('这一夜已经验过了');
      const t = c.payload.targetId || (Array.isArray(c.payload.targets) ? c.payload.targets[0] : '');
      if (!t) throw new Error('选一个人');
      if (t === c.pid) throw new Error('别验自己');
      s.seerCheck = { round: s.round, targetId: t, isWolf: roleOf(room, t) === 'wolf' };
      c.sfx(c.pid, 'ding');
      return { ok: true };
    },

    // 女巫：救 / 不救
    witchsave(room, c) {
      const s = room.game.state;
      if (c.pid !== s.witchId) throw new Error('你不是女巫');
      if (s.phase !== 'night' || s.step !== 'witch') throw new Error('现在不是女巫回合');
      const yes = c.payload.targetId === 'yes' || c.payload.yes === true;
      if (yes && !s.potion.heal) throw new Error('解药已经用掉了');
      s.witchSave = yes;
      if (yes) s.potion.heal = false;
      s.witchStep = 'poison';
      c.sfx(c.pid, yes ? 'ding' : 'tick');
      return { ok: true };
    },

    // 女巫：毒人
    witchpoison(room, c) {
      const s = room.game.state;
      if (c.pid !== s.witchId) throw new Error('你不是女巫');
      if (s.witchStep !== 'poison') throw new Error('先决定救不救');
      const t = c.payload.targetId || (Array.isArray(c.payload.targets) ? c.payload.targets[0] : '');
      if (t === '__none__' || !t) {
        s.witchStep = 'done';
        return { ok: true };
      }
      if (!s.potion.poison) throw new Error('毒药已经用掉了');
      s.witchPoison = t;
      s.potion.poison = false;
      s.witchStep = 'done';
      c.sfx(c.pid, 'buzzErr');
      return { ok: true };
    },

    vote(room, c) {
      const s = room.game.state;
      if (s.phase !== 'vote') throw new Error('还没到投票');
      const p = room.players.find((x) => x.id === c.pid);
      if (!p || !s.roles[c.pid]) throw new Error('你不在这一局');
      if (!p.alive) throw new Error('你已经出局了');
      const t = c.payload.targetId || (Array.isArray(c.payload.targets) ? c.payload.targets[0] : '');
      if (!t) throw new Error('选一个人');
      if (t === c.pid) throw new Error('不能投自己');
      s.votes[c.pid] = t;
      c.sfx(c.pid, 'ding');
      return { ok: true };
    },

    // ---- 主持 ----
    host_nextStep(room, c) {
      const s = room.game.state;
      if (s.phase !== 'night') throw new Error('不在夜里');
      if (s.step === 'wolf') {
        s.step = 'seer';
        c.log('预言家请睁眼');
      } else if (s.step === 'seer') {
        s.step = 'witch';
        s.witchStep = 'save';
        c.log('女巫请睁眼');
      } else {
        settleNight(room, c);
      }
    },

    host_dawn(room, c) {
      const s = room.game.state;
      if (s.phase !== 'night') throw new Error('不在夜里');
      settleNight(room, c);
    },

    host_vote(room, c) {
      const s = room.game.state;
      if (s.phase === 'done') throw new Error('这局已经结束');
      s.phase = 'vote';
      s.votes = {};
      c.sfxAll('siren');
      c.log('白天投票');
    },

    host_settle(room, c) {
      const s = room.game.state;
      if (s.phase !== 'vote') throw new Error('先开始投票');
      const tally = {};
      for (const t of Object.values(s.votes)) tally[t] = (tally[t] || 0) + 1;
      const list = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      if (!list.length) throw new Error('还没有人投票');
      if (list.length > 1 && list[0][1] === list[1][1]) {
        throw new Error(
          `平票：${list
            .filter((x) => x[1] === list[0][1])
            .map((x) => nameOf(room, x[0]))
            .join('、')} —— 点「直接放逐」定案`
        );
      }
      exec(room, c, list[0][0]);
    },

    host_exec(room, c) {
      if (!c.targetId) throw new Error('先在左边点一个人');
      exec(room, c, c.targetId);
    },

    host_hunter(room, c) {
      const s = room.game.state;
      if (!c.targetId) throw new Error('先选一个带走的人');
      const p = room.players.find((x) => x.id === c.targetId);
      if (p) p.alive = false;
      c.sfxAll('boom');
      c.log(`猎人开枪带走了 ${nameOf(room, c.targetId)}`);
      const w = checkWin(room);
      if (w) finish(room, c, w);
    },

    host_nextRound(room, c) {
      for (const pl of room.players) pl.submitRound = 0; // 新一轮，完成态清零
      const s = room.game.state;
      if (s.phase === 'done') throw new Error('这局已经结束');
      s.round += 1;
      s.phase = 'night';
      s.step = 'wolf';
      s.wolfVotes = {};
      s.wolfTarget = '';
      s.witchSave = null;
      s.witchPoison = '';
      s.witchStep = '';
      s.votes = {};
      room.game.round = s.round;
      c.log(`进入第 ${s.round} 夜`);
    },

    host_next(room, c) {
      module.exports.setup(room, {}, c);
    },
  },

  hostView(room) {
    const s = room.game.state;
    const wolves = inGame(room).filter((p) => roleOf(room, p.id) === 'wolf');
    const stepName =
      s.step === 'wolf' ? '狼人' : s.step === 'seer' ? '预言家' : s.step === 'witch' ? '女巫' : '';
    const seer = room.players.find((p) => p.id === s.seerId);
    const witch = room.players.find((p) => p.id === s.witchId);
    return {
      info: [
        { label: '阶段', value: s.phase === 'night' ? `第 ${s.round} 夜 · ${stepName}` : s.phase === 'day' ? '白天' : s.phase === 'vote' ? '投票' : s.phase === 'done' ? '已结束' : '未开始', strong: true },
        { label: '狼人', value: wolves.map((p) => p.name).join('、') || '—', strong: true },
        { label: '刀口', value: s.wolfTarget ? nameOf(room, s.wolfTarget) : '—' },
        { label: '预言家', value: seer ? seer.name : '—' },
        { label: '女巫', value: witch ? witch.name : '—' },
        { label: '解药 / 毒药', value: `${s.potion.heal ? '有' : '无'} / ${s.potion.poison ? '有' : '无'}` },
      ],
      controls: [
        { kind: 'btn', action: 'host_nextStep', label: '下一步 →', style: 'primary' },
        { kind: 'btn', action: 'host_dawn', label: '天亮了 · 结算', style: 'ok' },
        { kind: 'btn', action: 'host_vote', label: '开始投票', style: 'plain' },
        { kind: 'btn', action: 'host_settle', label: '统计票数', style: 'primary' },
        { kind: 'btn', action: 'host_exec', label: '直接放逐', target: true, style: 'danger' },
        { kind: 'btn', action: 'host_hunter', label: '猎人带走他', target: true, style: 'danger' },
        { kind: 'btn', action: 'host_nextRound', label: '下一夜', style: 'plain' },
        { kind: 'btn', action: 'host_next', label: '重开一局', style: 'plain' },
      ],
      table: {
        columns: ['玩家', '身份', '状态', '投给了'],
        rows: inGame(room).map((p) => [
          p.name,
          ROLE_NAME[roleOf(room, p.id)] || '?',
          p.alive ? '在场' : '出局',
          s.votes[p.id] ? nameOf(room, s.votes[p.id]) : '—',
        ]),
      },
    };
  },

  playerView(room, pid) {
    const s = room.game.state;
    if (s.phase === 'idle') return { type: 'text', title: '狼人杀', sub: '等主持人开局' };
    if (!s.roles[pid]) return { type: 'text', title: '围观席', sub: '这局你没上桌' };

    const me = room.players.find((p) => p.id === pid);
    const role = s.roles[pid];
    const others = inGame(room).filter((p) => p.id !== pid && p.alive);

    if (s.phase === 'done') {
      return { type: 'text', title: s.winner === 'good' ? '好人胜' : '狼人胜', sub: s.result, tone: 'done' };
    }
    if (me && !me.alive) {
      return { type: 'text', title: '你已出局', sub: '闭嘴，看戏', tone: 'muted' };
    }

    if (s.phase === 'vote') {
      const mine = s.votes[pid];
      return {
        type: 'choice',
        title: '投谁出局',
        sub: mine ? '已投，等其他人' : '想清楚再点，点了就定',
        action: 'vote',
        options: others.map((p) => ({ value: p.id, label: p.name })),
        selected: mine ? [mine] : [],
      };
    }

    if (s.phase === 'night' && s.step === 'wolf' && role === 'wolf') {
      const mates = wolvesAlive(room).filter((p) => p.id !== pid);
      const picked = s.wolfVotes[pid];
      return {
        type: 'choice',
        title: '今晚刀谁',
        sub: mates.length ? `队友：${mates.map((p) => p.name).join('、')}` : '你是独狼',
        action: 'wolfbite',
        options: inGame(room)
          .filter((p) => p.alive && roleOf(room, p.id) !== 'wolf')
          .map((p) => ({ value: p.id, label: p.name })),
        selected: picked ? [picked] : [],
        footer: s.wolfTarget ? `当前刀口：${nameOf(room, s.wolfTarget)}` : '',
      };
    }

    if (s.phase === 'night' && s.step === 'seer' && role === 'seer') {
      if (s.seerCheck && s.seerCheck.round === s.round) {
        return {
          type: 'word',
          title: '验人结果',
          // 这句在遮罩外面。原来直接写「他是狼人，明天带节奏」——
          // 旁边的人不只看到结论，还顺带确认了他就是预言家，下一晚就能刀他。
          sub: '按住查看，只有你能看见',
          text: `${nameOf(room, s.seerCheck.targetId)} · ${s.seerCheck.isWolf ? '狼人' : '好人'}`,
          tone: s.seerCheck.isWolf ? 'wolf' : 'good',
          hold: true,
        };
      }
      return {
        type: 'choice',
        title: '验一个人',
        sub: '只有你能看到结果',
        action: 'seercheck',
        options: others.map((p) => ({ value: p.id, label: p.name })),
      };
    }

    if (s.phase === 'night' && s.step === 'witch' && role === 'witch') {
      if (s.witchStep === 'save') {
        return {
          type: 'choice',
          title: '今晚倒的是他',
          sub: s.wolfTarget
            ? `${nameOf(room, s.wolfTarget)} 被刀了。救吗？`
            : '今晚没人被刀。',
          action: 'witchsave',
          options: [
            { value: 'yes', label: s.potion.heal ? '用解药救他' : '解药没了' },
            { value: 'no', label: '不救' },
          ],
        };
      }
      if (s.witchStep === 'poison') {
        return {
          type: 'choice',
          title: '要毒人吗',
          sub: s.potion.poison ? '毒药只有一瓶，毒完就没了' : '毒药已经用掉了',
          action: 'witchpoison',
          options: [{ value: '__none__', label: '不毒' }].concat(
            s.potion.poison ? others.map((p) => ({ value: p.id, label: `毒 ${p.name}` })) : []
          ),
        };
      }
      return { type: 'text', title: '女巫', sub: '等天亮', tone: 'idle' };
    }

    if (s.phase === 'night') {
      return {
        type: 'text',
        title: '天黑请闭眼',
        // 遮罩外面不能因为身份不同而不同，否则旁边的人一看就知道谁是狼
        sub: '闭眼，等主持人叫',
        tone: 'idle',
        footer: `第 ${s.round} 夜`,
      };
    }

    // 白天
    const last = s.lastDeaths.length
      ? `昨夜出局：${s.lastDeaths.map((id) => nameOf(room, id)).join('、')}`
      : '昨夜平安';
    return {
      type: 'word',
      title: '天亮了',
      sub: last,
      text: `你是${ROLE_NAME[role] || '好人'}`,
      hold: true,
      tone: role === 'wolf' ? 'wolf' : 'good',
      footer: `第 ${s.round} 轮发言`,
    };
  },

  screenView(room) {
    const s = room.game.state;
    if (s.phase === 'idle') return { type: 'podium', title: '狼人杀', big: '准备', sub: '天黑请闭眼' };
    if (s.phase === 'done') {
      return {
        type: 'podium',
        title: '狼人杀',
        big: s.winner === 'good' ? '好人胜' : '狼人胜',
        sub: s.result,
      };
    }
    if (s.phase === 'night') {
      return {
        type: 'podium',
        title: '狼人杀',
        big: `第 ${s.round} 夜`,
        sub: s.step === 'wolf' ? '狼人请睁眼' : s.step === 'seer' ? '预言家请睁眼' : '女巫请睁眼',
        note: '请闭眼玩家低头',
      };
    }
    if (s.phase === 'vote') {
      return {
        type: 'podium',
        title: '投票',
        big: `${Object.keys(s.votes).length}`,
        sub: '已投票',
      };
    }
    return {
      type: 'podium',
      title: '狼人杀',
      big: '天亮了',
      sub: s.lastDeaths.length
        ? `出局：${s.lastDeaths.map((id) => nameOf(room, id)).join('、')}`
        : '昨夜平安',
      note: '轮流发言',
    };
  },
};

function exec(room, c, outId) {
  const s = room.game.state;
  const p = room.players.find((x) => x.id === outId);
  if (p) p.alive = false;
  s.phase = 'day';
  s.votes = {};
  s.history.push({ round: s.round, voted: outId });
  c.sfxAll('boom');
  c.log(`${nameOf(room, outId)} 被放逐（身份：${ROLE_NAME[roleOf(room, outId)] || '?'}）`);
  if (roleOf(room, outId) === 'hunter') c.say(outId, '你是猎人 —— 可以开枪带走一个人');
  const w = checkWin(room);
  if (w) finish(room, c, w);
}
