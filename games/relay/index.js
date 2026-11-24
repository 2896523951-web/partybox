'use strict';

const packs = require('../../core/packs');
const T = require('../../core/text');
const sfxlib = require('../../core/sfxlib');

/* 传声筒：第 1 棒看词，中间人只负责往下传，最后一棒猜。
 * 手机上只出现一个人该看的东西，别人屏幕是空的。
 *
 * 棒次让玩家自己挑：现场总有人想当最后一棒、有人死活不想画。
 * 先到先得，挑满了自动开始；谁都不挑，主持人点「开始」就随机排。 */

const PACKS = () => packs.usable('word');
const PICK_SEC = 90;

const KIND_NAME = { draw: '画', say: '描述', guess: '猜' };

/* 灌杂音以前有 9 个内置合成音（白噪音 / 领导讲话 / 怪笑 / 警报…），R4 全删了。
 * 现在只能灌「音频库」里的真文件：私密音效（file:）+ 曲库（media:）。 */
const PICK_HINT = '还没有能灌的音效 —— 到右边「音频库」的第二个上传口传一个，或者往曲库里放首歌';

function optsOf(c) {
  return sfxlib.list(c && c.sfxFiles, c && c.media);
}

/* 老存档里 disturb 可能是 'noise' 之类的旧名字，也可能指向已经删掉的文件。
 * 传文件、删文件都发生在运行期，没有「加载完成」那一刻，只能每次对一遍。 */
function normalize(s, c) {
  const opts = optsOf(c);
  const v = sfxlib.resolve(s.disturb, opts);
  if (v !== s.disturb) s.disturb = v;
  return opts;
}

/* 把灌进去的杂音停掉。
 * 以前是按「当前目标是谁」去停，换个人灌之后上一个人就没人管了，
 * 那阵噪音会一直响到他手动刷新页面。 */
function stopDisturb(s, c) {
  const list = Array.isArray(s.disturbOn) ? s.disturbOn : [];
  if (c && c.sfxStop) {
    for (const id of list) if (id) c.sfxStop(id);
    if (s.disturbTo && !list.includes(s.disturbTo)) c.sfxStop(s.disturbTo);
  }
  s.disturbOn = [];
  s.disturbTo = null;
  s.disturbUntil = 0;
}

function init() {
  return {
    packId: (PACKS()[0] || {}).id || 'idiom',
    mode: 'relay',
    durationSec: 90,
    phase: 'idle', // idle | pick | run | guess | done
    order: [], // 按棒次存 pid，空位是 ''
    idx: 0,
    word: '',
    hint: '',
    used: [],
    results: [],
    lastResult: '',
    pickedAt: {}, // pid -> 时间戳，用来显示谁还没挑
    disturb: '', // 灌杂音用哪个音效（空 = 还没选，面板里会自动落到第一个能用的）
    disturbTo: null, // 上一次灌的是谁，用来显示 / 停
    disturbOn: [], // 耳机里正在响杂音的人（换人时要先停掉这些人）
    disturbUntil: 0, // 到点自动收，忘了点「停杂音」也不至于一直响
  };
}

// 第 1 棒看词画/说，最后一棒猜
function kindAt(i, total) {
  if (i === 0) return 'draw';
  if (i === total - 1) return 'guess';
  return 'say';
}

function freeSlots(s) {
  const out = [];
  for (let i = 0; i < s.order.length; i += 1) if (!s.order[i]) out.push(i);
  return out;
}

function nameOf(room, id) {
  const p = room.players.find((x) => x.id === id);
  return p ? p.name : '';
}

/* 主持脚本（H1）：传声筒讲的是「别写字、别说话」，脚本主要是压节奏。 */
const SCRIPT = [
  { at: 0, cue: '发题', say: '第一棒看词，只能画，不能写字也不能说话。' },
  { at: 20, cue: '传棒', say: '画完往下传，下一个人看一眼，再接着画。' },
  { at: 40, cue: '最后一棒', say: '最后一棒只看画，猜出词，说不出就喊。' },
  { at: 60, cue: '判分', say: '主持人判对错，对了加分，错了不加。', fx: 'reveal' },
  { at: 80, cue: '换题', say: '换一道题，棒次重排，谁先谁后自己定。' },
];

module.exports = {
  script: SCRIPT,

  id: 'relay',
  name: '传声筒',
  desc: '看词 → 动作描述 → 一路传下去 → 最后一个人猜。手机只发一个人该看的东西。',
  minPlayers: 2,
  // 自动推进：主持台那颗「开自动」到点会替主持人点这个动作。
  // 只挑「点了不会毁局」的那个 —— 狼人杀那种一步错满盘皆输的流程不配。
  pacing: { action: 'host_next', label: '下一棒', sec: 45 },
  // P2：这几个动作交上去就算「完成」，玩家端会显示「还差几人」
  submitActions: ['pick', 'guess'],
  slogan: '一句话，传到最后一棒就变了味',
  // 开局前打上投屏的 3 条规则。大屏、玩家手机、主持台共用这一份，
  // 别在别处再抄一遍 —— 改了规则只改这里。
  rules: [
    '第 1 棒按住看词，只能用动作和描述往下传',
    '不能说出词里的任何一个字，传完点「我传完了」',
    '最后一棒写答案，猜对 +3，首棒 +1',
  ],

  init,

  setup(room, cfg, c) {
    const s = room.game.state;
    // 上一局灌进某个耳机的杂音，开局前先收掉
    stopDisturb(s, c);
    const live = room.players.filter((p) => p.online);
    if (cfg.packId) s.packId = cfg.packId;
    if (cfg.mode) s.mode = cfg.mode;
    if (cfg.durationSec) s.durationSec = Number(cfg.durationSec) || 90;

    const item = packs.pick(s.packId, new Set(s.used));
    // 2：如果在选游戏阶段就挑过棒次，开局沿用，不把人挑好的位置冲掉
    if (!(s.phase === 'pick' && s.order.length === live.length)) {
      s.order = new Array(live.length).fill('');
      s.pickedAt = {};
    }
    s.idx = 0;
    s.word = item ? item.w : '打草惊蛇';
    s.hint = item ? item.hint || '' : '';
    s.used = [...s.used, s.word].slice(-40);
    s.phase = 'pick';
    s.lastResult = '';
    room.game.startedAt = Date.now();
    room.game.timer = {
      endsAt: Date.now() + PICK_SEC * 1000,
      label: '挑棒次',
      total: PICK_SEC,
    };
    return { ok: true };
  },

  actions: {
    // 自己挑棒次。先到先得，挑满了自动开始。
    pick(room, c) {
      const s = room.game.state;
      // 2：还没开局也能先占位（这时候词还没发，不存在偷看）
      if (s.phase === 'idle') {
        const live = room.players.filter((p) => p.online);
        s.order = new Array(live.length).fill('');
        s.pickedAt = {};
        s.phase = 'pick';
        room.game.timer = { endsAt: Date.now() + PICK_SEC * 1000, label: '挑棒次', total: PICK_SEC };
      }
      if (s.phase !== 'pick') throw new Error('已经开始了');
      const slot = Number(c.payload.targetId) - 1; // 选项是 1 起的棒次
      if (!(slot >= 0 && slot < s.order.length)) throw new Error('没这个棒次');
      if (s.order[slot] && s.order[slot] !== c.pid) throw new Error('这一棒被抢了');
      const old = s.order.indexOf(c.pid);
      if (old >= 0) s.order[old] = '';
      s.order[slot] = c.pid;
      s.pickedAt[c.pid] = Date.now();
      c.sfx(c.pid, 'ding');
      if (!freeSlots(s).length) beginRun(room, c);
      return { ok: true, slot: slot + 1 };
    },

    handover(room, c) {
      const s = room.game.state;
      if (s.phase !== 'run') throw new Error('现在不能交接');
      if (s.order[s.idx] !== c.pid) throw new Error('还没轮到你');
      if (s.idx >= s.order.length - 1) throw new Error('你是最后一棒');
      s.idx += 1;
      const p = room.players.find((x) => x.id === s.order[s.idx]);
      c.log(`${p ? p.name : '?'} 接棒`);
      if (s.idx === s.order.length - 1) {
        s.phase = 'guess';
        c.sfxAll('ding');
      }
      return { ok: true, idx: s.idx };
    },

    guess(room, c) {
      const s = room.game.state;
      if (s.phase !== 'guess') throw new Error('还没传到你');
      if (s.order[s.order.length - 1] !== c.pid) throw new Error('不是你猜');
      const text = String(c.payload.text || '').trim();
      if (!text) throw new Error('写点什么');
      const ok = T.match(text, s.word);
      if (!ok) return { ok: true, correct: false };
      finish(room, c, true);
      return { ok: true, correct: true };
    },

    // ---- 主持 ----
    host_next(room, c) {
      for (const pl of room.players) pl.submitRound = 0; // 新一轮，完成态清零
      const s = room.game.state;
      // 还在挑棒次：直接开始，没挑的人随机补位
      if (s.phase === 'pick') {
        beginRun(room, c);
        return { ok: true };
      }
      nextRound(room, c);
      return { ok: true };
    },

    /* C3：传声筒不再靠手机点「我传完了」，改由主持人点「下一棒」。 */
    host_step(room, c) {
      const s = room.game.state;
      if (s.phase !== 'run') throw new Error('现在不能推进');
      if (s.idx >= s.order.length - 1) throw new Error('已经是最后一棒');
      s.idx += 1;
      const p = room.players.find((x) => x.id === s.order[s.idx]);
      c.log(`${p ? p.name : '?'} 接棒`);
      if (s.idx === s.order.length - 1) {
        s.phase = 'guess';
        c.sfxAll('ding');
      }
      return { ok: true, idx: s.idx };
    },

    host_judge(room, c) {
      const ok = c.payload.ok !== false && c.payload.ok !== 'false';
      finish(room, c, ok);
      return { ok: true };
    },

    host_disturb(room, c) {
      const s = room.game.state;
      if (!c.targetId) throw new Error('先在右边点一个玩家');
      const opts = normalize(s, c);
      const sound = sfxlib.resolve(String(c.payload.sound || s.disturb), opts);
      // 没有音效就别发空指令：那台手机一声不响，现场看着像耳机坏了
      if (!sound) throw new Error(PICK_HINT);
      // 先停上一个人的，再放新的 —— 顺序不能反，
      // 否则 disturbTo 一改，上一个人就永远等不到停止指令了
      stopDisturb(s, c);
      s.disturb = sound;
      s.disturbTo = c.targetId;
      s.disturbOn = [c.targetId];
      s.disturbUntil = Date.now() + 12000;
      c.sfx(c.targetId, sound);
      c.say(c.targetId, '耳机里进杂音了 —— 稳住');
      c.log(`给 ${c.target ? c.target.name : '?'} 灌了「${sfxlib.label(sound, opts)}」`);
      return { ok: true };
    },

    // 灌的时候顺手换成另一种，不用重新点人
    host_disturbSound(room, c) {
      const s = room.game.state;
      const want = String(c.payload.sound || '');
      if (!want) return { ok: true };
      const opts = normalize(s, c);
      s.disturb = sfxlib.resolve(want, opts);
      return { ok: true };
    },

    host_disturbStop(room, c) {
      const s = room.game.state;
      stopDisturb(s, c);
      // 兜一道：主持台上现在选中的那个人也停一下，防止有残留
      if (c.targetId) c.sfxStop(c.targetId);
      return { ok: true };
    },

    host_pack(room, c) {
      const s = room.game.state;
      if (c.payload.packId) s.packId = c.payload.packId;
      return { ok: true };
    },

    host_mode(room, c) {
      const s = room.game.state;
      if (c.payload.mode) s.mode = c.payload.mode;
      return { ok: true };
    },
  },

  hostView(room, c) {
    const s = room.game.state;
    const opts = normalize(s, c);
    const first = room.players.find((p) => p.id === s.order[0]);
    const last = room.players.find((p) => p.id === s.order[s.order.length - 1]);
    const picking = s.phase === 'pick';
    const pickedN = s.order.filter(Boolean).length;
    return {
      info: [
        { label: '本轮词', value: s.word || '—', strong: true },
        { label: '提示', value: s.hint || '—' },
        { label: '第 1 棒', value: first ? first.name : '待选' },
        { label: '最后一棒', value: last ? last.name : '待选' },
        {
          label: picking ? '挑棒次' : '进度',
          value: picking ? `${pickedN} / ${s.order.length} 已挑` : s.phase === 'idle' ? '未开始' : `${s.idx + 1} / ${s.order.length}`,
        },
        { label: '时长', value: `${s.durationSec} 秒` },
      ],
      controls: [
        {
          kind: 'btn',
          action: 'host_next',
          label: picking ? '开始（没挑的随机排）' : s.phase === 'idle' ? '开始第一题' : '换一题',
          style: 'primary',
        },
        { kind: 'btn', action: 'host_step', label: '下一棒 →', style: 'ok', disabled: s.phase !== 'run' || s.idx >= s.order.length - 1 },
        { kind: 'btn', action: 'host_judge', label: '判对 ✓', style: 'ok', payload: { ok: true } },
        { kind: 'btn', action: 'host_judge', label: '判错 ✗', style: 'danger', payload: { ok: false } },
        { kind: 'btn', action: 'host_disturb', label: '灌杂音', target: true, style: 'plain', disabled: !opts.length, why: PICK_HINT },
        { kind: 'btn', action: 'host_disturbStop', label: '停杂音', style: 'plain' },
        {
          kind: 'select',
          action: 'host_pack',
          name: 'packId',
          label: '词库',
          value: s.packId,
          options: PACKS().map((p) => ({ value: p.id, label: `${p.name}（${p.items.length}）` })),
        },
        {
          kind: 'sfxPick',
          action: 'host_disturbSound',
          name: 'sound',
          value: s.disturb,
          title: '灌杂音用哪一段',
          builtin: [],
          custom: opts,
          empty: PICK_HINT,
        },
      ],
      table: {
        columns: ['棒次', '玩家', '干什么', '状态'],
        rows: s.order.map((pid, i) => {
          const p = room.players.find((x) => x.id === pid);
          const isLast = i === s.order.length - 1;
          let st = '等待';
          if (picking) st = pid ? '已挑' : '空着';
          else if (i < s.idx) st = '已传完';
          else if (i === s.idx) st = isLast ? '在猜' : '正在传';
          else if (isLast) st = '等答案';
          return [
            i === 0 ? '1（看词）' : isLast ? `${i + 1}（猜）` : String(i + 1),
            p ? p.name : '待选',
            KIND_NAME[kindAt(i, s.order.length)],
            st,
          ];
        }),
      },
    };
  },

  playerView(room, pid) {
    const s = room.game.state;
    if (s.phase === 'idle' || !s.order.length) {
      return { type: 'text', title: '传声筒', sub: '主持人还没发题' };
    }

    // 挑棒次：第 1 棒看词，最后一棒猜，先到先得
    if (s.phase === 'pick') {
      const n = s.order.length;
      const mine = s.order.indexOf(pid);
      if (mine < 0 && !room.players.some((p) => p.id === pid)) {
        return { type: 'text', title: '围观席', sub: '这一题你不上场' };
      }
      const opts = freeSlots(s).map((i) => ({
        value: String(i + 1),
        label: `第 ${i + 1} 棒 · ${KIND_NAME[kindAt(i, n)]}`,
      }));
      if (mine >= 0) opts.unshift({ value: String(mine + 1), label: `第 ${mine + 1} 棒 · ${KIND_NAME[kindAt(mine, n)]}（你的）` });
      const left = freeSlots(s).length;
      return {
        type: 'choice',
        title: mine >= 0 ? `你挑了第 ${mine + 1} 棒` : '挑你的棒次',
        sub: mine >= 0 ? '位置还能换，等一下其他人' : '第 1 棒看词，最后一棒猜。先到先得。',
        action: 'pick',
        options: opts,
        selected: mine >= 0 ? [String(mine + 1)] : [],
        footer: left ? `还剩 ${left} 个空位` : '人齐了，马上开始',
      };
    }

    const i = s.order.indexOf(pid);
    if (i < 0) return { type: 'text', title: '围观席', sub: '这一题你不上场，负责笑' };
    if (s.phase === 'done') {
      return {
        type: 'text',
        title: s.lastResult ? '本轮结果' : '本轮结束',
        sub: s.lastResult || '换下一题',
        tone: 'done',
        reveal: s.word,
      };
    }

    const last = s.order.length - 1;

    if (i === 0) {
      return {
        type: 'word',
        title: '你是第 1 棒',
        sub: '看词，用动作和描述往下传。不能说出词里的任何一个字。',
        text: s.word,
        hint: s.hint,
        len: T.len(s.word),
        hold: true,
        footer: `1 / ${s.order.length}　说完等主持人点「下一棒」`,
      };
    }

    if (i === last) {
      return {
        type: 'text',
        title: '你是最后一棒',
        sub: s.phase === 'guess' ? '说出来，或者写在纸上，交给主持人判' : '等前面把话传到你这里',
        hint: `共 ${T.len(s.word)} 个字`,
        tone: s.phase === 'guess' ? 'active' : 'idle',
        footer: `${i + 1} / ${s.order.length}`,
      };
    }

    const now = i === s.idx;
    return {
      type: 'text',
      title: `你是第 ${i + 1} 棒`,
      sub: now ? '听完，直接往下一位说' : '还没到你，别偷看别人的手机',
      tone: now ? 'active' : 'idle',
      footer: `${i + 1} / ${s.order.length}`,
    };
  },

  screenView(room) {
    const s = room.game.state;
    const cur = room.players.find((p) => p.id === s.order[s.idx]);
    if (s.phase === 'pick') {
      return {
        type: 'relay',
        title: '传声筒',
        big: `${s.order.filter(Boolean).length} / ${s.order.length}`,
        sub: '各自挑棒次',
        hint: '第 1 棒看词，最后一棒猜',
      };
    }
    return {
      type: 'relay',
      title: '传声筒',
      big: s.phase === 'idle' ? '准备' : `${Math.min(s.idx + 1, s.order.length)} / ${s.order.length}`,
      sub: s.phase === 'idle' ? '等人齐' : cur ? `正在传：${cur.name}` : '',
      hint: s.phase === 'idle' ? '' : `${T.len(s.word)} 个字`,
    };
  },

  tick(room, now, c) {
    const s = room.game.state;
    let dirty = false;

    // 杂音到点自己收：以前只能手动点「停杂音」，忘了就一直在耳机里响
    if (s.disturbUntil && now >= s.disturbUntil) {
      stopDisturb(s, c);
      dirty = true;
    }

    const t = room.game.timer;
    if (!t || !t.endsAt) return dirty;
    if (now < t.endsAt) return dirty;
    if (s.phase === 'pick') {
      // 挑棒次的时间到了：没挑的人随机补，直接开
      beginRun(room, null);
      return true;
    }
    if (s.phase === 'run' || s.phase === 'guess') {
      s.phase = 'done';
      s.lastResult = '时间到 —— 没猜出来';
      room.game.timer = null;
      return true;
    }
    return dirty;
  },
};

function nextRound(room, c) {
  const s = room.game.state;
  const live = room.players.filter((p) => p.online);
  if (live.length < 2) throw new Error('至少两个人');
  // 换题了，上一题的杂音别继续缠着人
  stopDisturb(s, c);
  const item = packs.pick(s.packId, new Set(s.used));
  s.order = new Array(live.length).fill('');
  s.idx = 0;
  s.word = item ? item.w : '打草惊蛇';
  s.hint = item ? item.hint || '' : '';
  s.used = [...s.used, s.word].slice(-40);
  s.phase = 'pick';
  s.pickedAt = {};
  s.lastResult = '';
  room.game.round += 1;
  room.game.timer = {
    endsAt: Date.now() + PICK_SEC * 1000,
    label: '挑棒次',
    total: PICK_SEC,
  };
  c.log(`传声筒第 ${room.game.round} 题 · 挑棒次`);
}

/* 开始这一轮：没挑的人随机补空位 */
function beginRun(room, c) {
  const s = room.game.state;
  const taken = new Set(s.order.filter(Boolean));
  const rest = packs.shuffle(room.players.filter((p) => p.online && !taken.has(p.id)).map((p) => p.id));
  for (let i = 0; i < s.order.length; i += 1) {
    if (!s.order[i]) s.order[i] = rest.shift() || '';
  }
  s.order = s.order.filter(Boolean);
  s.idx = 0;
  s.phase = s.order.length > 1 ? 'run' : 'done';
  room.game.timer =
    s.phase === 'run'
      ? {
          endsAt: Date.now() + s.durationSec * 1000,
          label: `第 ${room.game.round} 题`,
          total: s.durationSec,
        }
      : null;
  if (c) c.log(`第 ${room.game.round} 题开始 · 第 1 棒 ${nameOf(room, s.order[0]) || '—'}`);
}

function finish(room, c, ok) {
  const s = room.game.state;
  const lastId = s.order[s.order.length - 1];
  const firstId = s.order[0];
  s.phase = 'done';
  s.lastResult = ok ? `猜对了：${s.word}` : `没猜对，答案是「${s.word}」`;
  s.results.push({ word: s.word, ok });
  room.game.timer = null;
  if (ok) {
    const gp = room.players.find((p) => p.id === lastId);
    const fp = room.players.find((p) => p.id === firstId);
    if (gp) {
      gp.score += 3;
      room.teams[gp.team] && (room.teams[gp.team].score += 3);
    }
    if (fp && fp.id !== lastId) fp.score += 1;
  }
  c.log(ok ? `猜对了：${s.word}` : `没猜对：${s.word}`);
}
