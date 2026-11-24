'use strict';

/* 笨蛋杀手：老板和杀手「互相不知道对方是谁」。
 *
 * 这跟普通狼人杀最大的区别就在这里 ——
 * 不是「狼人睁眼互相认识」，而是两个卧底要靠一个公开的接头动作去找对方，
 * 所以中间人随手做一下这个动作，两个人就都能认错队友。
 *
 * 游戏机负责：抽身份、把目标只发给老板、判定杀手喊得对不对、数子弹。
 * 唯一不做的是「老板怎么暗示」—— 那必须是眼神和手，别让手机接手。 */

const ACTS = [
  /* 6：由系统抽一个具体动作，玩家不再自己发明。
   * 同一局两个卧底拿到的是同一个动作，认亲靠它，不靠猜。 */
  '摸一下左耳',
  '推一下眼镜',
  '挠一下后颈',
  '整理一下袖口',
  '拍两下桌面',
  '把杯子挪一下',
  '摸下巴三秒',
  '点三下头',
  '转一下手里的笔',
  '扶一下椅背',
  '碰一下鼻尖',
  '双手叉腰两秒',
];

function init() {
  return {
    phase: 'idle', // idle | run | vote | done
    bossId: '',
    killerId: '',
    targetId: '',
    bullets: 4,
    kills: 0,
    killGoal: 3,
    killLog: [], // [{ shooter, targetId, ok, at }]
    out: [], // 被击杀出局的 pid
    taskProgress: 0,
    taskGoal: 100,
    actWord: '',
    votes: {},
    winner: '',
    result: '',
  };
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function live(room) {
  return room.players.filter((p) => p.online);
}

function nameOf(room, id) {
  const p = room.players.find((x) => x.id === id);
  return p ? p.name : '？';
}

function newTarget(room) {
  const s = room.game.state;
  const pool = live(room).filter(
    (p) => p.id !== s.bossId && p.id !== s.killerId && !s.out.includes(p.id)
  );
  return pool.length ? pick(pool).id : '';
}

function finish(room, c, winner) {
  const s = room.game.state;
  s.phase = 'done';
  s.winner = winner;
  if (winner === 'wolf') {
    s.result = `卧底赢了。老板是「${nameOf(room, s.bossId)}」，杀手是「${nameOf(
      room,
      s.killerId
    )}」`;
    const b = room.players.find((p) => p.id === s.bossId);
    const k = room.players.find((p) => p.id === s.killerId);
    if (b) b.score += 3;
    if (k) k.score += 3;
  } else {
    s.result = `好人赢了。老板是「${nameOf(room, s.bossId)}」，杀手是「${nameOf(
      room,
      s.killerId
    )}」`;
    for (const p of live(room)) {
      if (p.id !== s.bossId && p.id !== s.killerId) p.score += 2;
    }
  }
  c.sfxAll(winner === 'good' ? 'win' : 'wolf');
  c.log(s.result);
}

module.exports = {
  id: 'dumbkill',
  name: '笨蛋杀手',
  desc: '老板和杀手互不认识，只能靠一个公开动作接头。老板悄悄递目标，杀手当众喊「走你」。',
  minPlayers: 4,
  slogan: '老板和杀手互不认识，只能靠动作接头',
  // 开局前打上投屏的 3 条规则。大屏、玩家手机、主持台共用这一份，
  // 别在别处再抄一遍 —— 改了规则只改这里。
  rules: [
    '老板和杀手各看一句提示，怎么比划自己定',
    '老板悄悄把目标只告诉杀手，别让第三个人看见',
    '杀手当众喊「XXX 走你」，好人一边做任务',
  ],

  init,

  setup(room, cfg, c) {
    const s = room.game.state;
    const list = live(room);
    if (list.length < 4) throw new Error('至少要 4 个人在线');

    const ids = list.map((p) => p.id);
    const shuffled = ids.slice();
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = t;
    }
    s.bossId = shuffled[0];
    s.killerId = shuffled[1];
    s.bullets = Math.min(6, Math.max(2, Number(cfg.bullets) || 4));
    s.kills = 0;
    // 节目原版是击杀 3 次，人少时按剩余好人收，不然还没杀够人就没了
    const goods = list.length - 2;
    s.killGoal = Math.max(1, Math.min(3, Number(cfg.killGoal) || goods - 1));
    s.killLog = [];
    s.out = [];
    s.votes = {};
    s.winner = '';
    s.result = '';
    s.taskProgress = 0;
    s.taskGoal = Math.min(20, Math.max(3, Number(cfg.taskGoal) || 10));
    s.actWord = pick(ACTS);
    s.phase = 'run';

    s.targetId = newTarget(room);

    for (const p of room.players) p.alive = true;

    c.send(s.bossId, { t: 'sfx', name: 'wolf' });
    c.say(s.bossId, '你是老板。目标已经发到你手机上，别让任何人看见。');
    c.send(s.killerId, { t: 'sfx', name: 'wolf' });
    c.say(s.killerId, '你是杀手。先找到老板，别乱开枪。');
    c.log(`接头提示「${s.actWord}」· ${s.bullets} 发子弹 · 任务 ${s.taskGoal} 步`);
  },

  actions: {
    // 杀手当众喊人：选谁就是喊谁，喊错一样扣子弹
    shoot(room, c) {
      const s = room.game.state;
      if (s.phase !== 'run') throw new Error('现在不能开枪');
      if (c.pid !== s.killerId) throw new Error('你不是杀手');
      const t = c.payload.targetId || (Array.isArray(c.payload.targets) ? c.payload.targets[0] : '');
      if (!t) throw new Error('先选一个人');
      if (t === c.pid) throw new Error('不能喊自己');
      if (s.out.includes(t)) throw new Error('他已经出局了');
      if (s.bullets <= 0) throw new Error('没子弹了');

      const ok = t === s.targetId;
      s.bullets -= 1;
      s.killLog.push({ shooter: c.pid, targetId: t, ok, at: Date.now() });

      if (ok) {
        s.kills += 1;
        s.out.push(t);
        const p = room.players.find((x) => x.id === t);
        if (p) p.alive = false;
        c.sfxAll('boom');
        c.log(`「${nameOf(room, t)} 走你」—— 击杀成功（${s.kills}/${s.killGoal}）`);
        s.targetId = newTarget(room);
        if (s.kills >= s.killGoal) {
          finish(room, c, 'wolf');
          return { ok: true, hit: true };
        }
      } else {
        c.sfxAll('buzzErr');
        c.log(`「${nameOf(room, t)} 走你」—— 打偏了（剩 ${s.bullets} 发）`);
        if (s.bullets <= 0) {
          finish(room, c, 'good');
          s.result = `子弹打光了 —— 好人胜。老板是「${nameOf(room, s.bossId)}」`;
          return { ok: true, hit: false };
        }
      }
      return { ok: true, hit: ok };
    },

    vote(room, c) {
      const s = room.game.state;
      if (s.phase !== 'vote') throw new Error('还没到投票');
      if (s.out.includes(c.pid)) throw new Error('你已经出局了');
      const t = c.payload.targetId || (Array.isArray(c.payload.targets) ? c.payload.targets[0] : '');
      if (!t) throw new Error('选一个人');
      if (t === c.pid) throw new Error('不能投自己');
      s.votes[c.pid] = t;
      c.sfx(c.pid, 'ding');
      return { ok: true };
    },

    // ---- 主持 ----
    /* 6：主持人可以重抽一个接头动作（比如上一局用过了） */
    host_act(room, c) {
      const s = room.game.state;
      s.actWord = pick(ACTS.filter((a) => a !== s.actWord));
      c.log(`接头动作换成：${s.actWord}`);
      return { ok: true, actWord: s.actWord };
    },

    host_task(room, c) {
      const s = room.game.state;
      if (s.phase !== 'run') throw new Error('不在游戏中');
      s.taskProgress += Number(c.payload.step) || 1;
      c.log(`任务进度 ${s.taskProgress}/${s.taskGoal}`);
      if (s.taskProgress >= s.taskGoal) {
        finish(room, c, 'good');
        s.result = `任务做完了 —— 好人胜。老板是「${nameOf(room, s.bossId)}」`;
        c.log(s.result);
      }
    },

    host_vote(room, c) {
      const s = room.game.state;
      if (s.phase === 'done') throw new Error('这局已经结束');
      if (!s.kills) throw new Error('还没人出局，先别投票');
      s.phase = 'vote';
      s.votes = {};
      c.sfxAll('siren');
      c.log('开始投票抓老板');
    },

    host_settle(room, c) {
      const s = room.game.state;
      if (s.phase !== 'vote') throw new Error('先开始投票');
      const tally = {};
      for (const t of Object.values(s.votes)) tally[t] = (tally[t] || 0) + 1;
      const list = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      if (!list.length) throw new Error('还没有人投票');
      const top = list[0][0];
      finish(room, c, top === s.bossId ? 'good' : 'wolf');
    },

    host_kill(room, c) {
      // 主持人手动判一次「走你」，给不拿手机的场合用
      if (!c.targetId) throw new Error('先在左边点一个玩家');
      const fake = { ...c, pid: room.game.state.killerId, payload: { targetId: c.targetId } };
      return module.exports.actions.shoot(room, fake);
    },

    host_next(room, c) {
      module.exports.setup(room, {}, c);
    },
  },

  hostView(room) {
    const s = room.game.state;
    const boss = room.players.find((p) => p.id === s.bossId);
    const killer = room.players.find((p) => p.id === s.killerId);
    return {
      info: [
        { label: '老板', value: boss ? boss.name : '—', strong: true },
        { label: '杀手', value: killer ? killer.name : '—', strong: true },
        { label: '接头提示', value: s.actWord || '—', strong: true },
        { label: '当前目标', value: s.targetId ? nameOf(room, s.targetId) : '—', strong: true },
        { label: '子弹', value: `${s.bullets} 发` },
        { label: '击杀', value: `${s.kills} / ${s.killGoal}` },
        { label: '任务', value: `${s.taskProgress} / ${s.taskGoal}` },
      ],
      controls: [
        { kind: 'btn', action: 'host_act', label: '重抽接头动作', style: 'plain' },
        {
          kind: 'btn',
          action: 'host_task',
          label: '任务 +1',
          style: 'ok',
          payload: { step: 1 },
        },
        {
          kind: 'btn',
          action: 'host_task',
          label: '+5',
          style: 'plain',
          payload: { step: 5 },
        },
        { kind: 'btn', action: 'host_vote', label: '开始投票', style: 'primary' },
        { kind: 'btn', action: 'host_settle', label: '统计票数', style: 'primary' },
        { kind: 'btn', action: 'host_kill', label: '判他被打中', target: true, style: 'danger' },
        { kind: 'btn', action: 'host_next', label: '重开一局', style: 'plain' },
      ],
      table: {
        columns: ['玩家', '身份', '状态', '投给了'],
        rows: room.players.map((p) => [
          p.name,
          p.id === s.bossId ? '老板' : p.id === s.killerId ? '杀手' : '好人',
          s.out.includes(p.id) ? '已出局' : '在场',
          s.votes[p.id] ? nameOf(room, s.votes[p.id]) : '—',
        ]),
      },
    };
  },

  playerView(room, pid) {
    const s = room.game.state;
    if (!room.players.some((p) => p.id === pid)) {
      return { type: 'text', title: '围观席', sub: '这一局你不上场' };
    }
    if (s.phase === 'idle') {
      return { type: 'text', title: '笨蛋杀手', sub: '等主持人开局' };
    }
    if (s.phase === 'done') {
      return {
        type: 'text',
        title: s.winner === 'good' ? '好人胜' : '卧底胜',
        sub: s.result,
        tone: 'done',
      };
    }

    const isBoss = pid === s.bossId;
    const isKiller = pid === s.killerId;
    const dead = s.out.includes(pid);

    if (s.phase === 'vote') {
      if (dead) return { type: 'text', title: '你已经出局', sub: '闭嘴看戏，别提示' };
      const mine = s.votes[pid];
      return {
        type: 'choice',
        title: '谁是老板',
        sub: mine ? '已投，等其他人' : '老板一定在找机会暗示杀手',
        action: 'vote',
        options: room.players
          .filter((p) => p.id !== pid && !s.out.includes(p.id))
          .map((p) => ({ value: p.id, label: p.name })),
        selected: mine ? [mine] : [],
        footer: `已投 ${Object.keys(s.votes).length} 人`,
      };
    }

    /* 杀手要喊人，名单本身就写着「我是杀手」。
     * 所以整块压在遮罩下：按住才露名单，滑到名字上松手＝喊他。
     * 遮罩外的三行必须和老板、好人一字不差。 */
    if (isKiller && !dead) {
      return {
        type: 'choice',
        hold: true,
        title: '你的身份',
        sub: '按住查看，别给旁边的人看见',
        note: `接头提示：${s.actWord} · 剩 ${s.bullets} 发`,
        // 这行也在遮罩里：遮罩上只写「按住查看」，跟好人的卡一字不差
        holdFoot: '按住，滑到名字上松手就喊他',
        action: 'shoot',
        options: room.players
          .filter((p) => p.id !== pid && !s.out.includes(p.id))
          .map((p) => ({ value: p.id, label: `「${p.name} 走你」` })),
        footer: `任务 ${s.taskProgress} / ${s.taskGoal}`,
      };
    }

    /* 身份卡分两层：
     * 遮罩里面（text）才是秘密 —— 老板是谁、目标是谁、接头动作是什么；
     * 遮罩外面（title / sub / footer）必须对所有人一字不差。
     * 之前 sub 写「按住看你的目标」、footer 写「接头动作：摸一下左耳」，
     * 老板和好人一眼可分，这个游戏当场就废了。 */
    const secret = isBoss
      ? `目标：${s.targetId ? nameOf(room, s.targetId) : '没目标了'} · 接头提示：${s.actWord}`
      : isKiller
      ? `杀手 · 接头提示：${s.actWord}`
      : '好人';

    return {
      type: 'word',
      title: '你的身份',
      sub: '按住查看，别给旁边的人看见',
      text: dead ? `你已出局 · ${secret}` : secret,
      hold: true,
      tone: isBoss || isKiller ? 'wolf' : 'good',
      footer: `任务 ${s.taskProgress} / ${s.taskGoal}`,
    };
  },

  screenView(room) {
    const s = room.game.state;
    if (s.phase === 'idle') {
      return { type: 'podium', title: '笨蛋杀手', big: '准备', sub: '六好人里藏着一个老板' };
    }
    if (s.phase === 'done') {
      return {
        type: 'podium',
        title: '笨蛋杀手',
        big: s.winner === 'good' ? '好人胜' : '卧底胜',
        sub: s.result,
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
      title: '笨蛋杀手',
      big: `${s.kills} / ${s.killGoal}`,
      sub: `任务 ${s.taskProgress} / ${s.taskGoal}`,
      // 接头动作绝不能上大屏 —— 一公布，所有人都能做这个动作，杀手就永远认不出老板了
      note: '找到老板的人，才有目标',
    };
  },
};
