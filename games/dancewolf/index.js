'use strict';

/* 舞蹈狼人杀：只有狼王听不到音乐。
 *
 * 关键点是「音乐不走文件，也不走网络」——
 * 每个手机用 WebAudio 本地合成同一段节拍，唯独狼王的耳机里什么都没有。
 * 所以他不是「听到错拍」，而是「什么都听不到」，只能靠看别人的腿假装跟得上。
 *
 * 狼王有 N 次同化机会：对一个人做指定动作，对方悄悄换阵营。
 * 这一段游戏机管不了（是物理动作），由主持人在台子上点一下记账。 */

const ACTS = [
  '撩一下头发',
  '摸三下耳朵',
  '拍两下大腿',
  '双手插兜',
  '比个耶',
  '原地转一圈',
  '摸摸下巴',
  '整理一下衣领',
  '用手指敲两下桌子',
  '伸个懒腰',
];

function init() {
  return {
    phase: 'idle', // idle | ready | dance | talk | vote | done
    kingId: '',
    wolves: [], // 狼阵营（含狼王）
    converts: [], // [{ id, at }]
    convertLeft: 2,
    actWord: '',
    bpm: 118,
    danceSec: 60,
    musicAt: 0, // 所有人一起开始放歌的绝对时刻
    musicOffset: 0, // 从曲目的第几秒开始（主持人拖动进度条）
    // 曲目：默认手机本地合成的舞曲；换成曲库里的歌时，每台手机自己拉自己那份
    trackKind: 'synth',
    trackId: '',
    trackName: '内置舞曲',
    musicVol: 70, // 由主持人统一控制，手机端不再自己调
    votes: {}, // pid -> targetId
    tied: [],
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

function goodsCount(room) {
  const s = room.game.state;
  return live(room).length - s.wolves.length;
}

function stopBeat(room, c) {
  for (const p of room.players) c.send(p.id, { t: 'beat', on: false });
}

function clock(sec) {
  const x = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`;
}

// 一次广播决定所有人从哪一秒开始放。狼王那台也收到，只是 on=false。
// 曲目是「内置合成」时只发 bpm；是曲库里的歌时多带一个 src，手机自己拉。
function broadcastMusic(room, c) {
  const s = room.game.state;
  const track = musicTrack(s);
  for (const p of room.players) {
    c.send(p.id, {
      t: 'beat',
      show: true,
      on: p.id !== s.kingId,
      bpm: s.bpm,
      startAt: s.musicAt,
      offset: s.musicOffset,
      duration: s.danceSec,
      vol: s.musicVol,
      track,
    });
  }
}

function musicTrack(s) {
  if (s.trackKind === 'file' && s.trackId) {
    return {
      kind: 'file',
      id: s.trackId,
      name: s.trackName,
      src: '/media/' + encodeURIComponent(s.trackId),
    };
  }
  return { kind: 'synth', id: null, name: '内置舞曲', src: '' };
}

function clampVol(v) {
  const n = Number(v);
  if (!isFinite(n)) return 70;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function setTrack(s, id, c) {
  const list = (c && c.media) || [];
  const m = id && id !== 'synth' ? list.find((x) => x.id === id) : null;
  if (m) {
    s.trackKind = 'file';
    s.trackId = m.id;
    s.trackName = m.name;
  } else {
    s.trackKind = 'synth';
    s.trackId = '';
    s.trackName = '内置舞曲';
  }
}

function finish(room, c, winner) {
  const s = room.game.state;
  stopBeat(room, c);
  s.phase = 'done';
  s.winner = winner;
  room.game.timer = null;
  if (winner === 'good') {
    s.result = `狼王是「${nameOf(room, s.kingId)}」，被投出去了 —— 好人胜`;
    for (const p of live(room)) if (!s.wolves.includes(p.id)) p.score += 2;
  } else {
    s.result = `狼阵营已经过半 —— 狼人胜。狼王是「${nameOf(room, s.kingId)}」`;
    for (const id of s.wolves) {
      const p = room.players.find((x) => x.id === id);
      if (p) p.score += id === s.kingId ? 3 : 2;
    }
  }
  c.sfxAll(winner === 'good' ? 'win' : 'wolf');
}

function judge(room, c, outId) {
  const s = room.game.state;
  if (outId === s.kingId) {
    finish(room, c, 'good');
  } else {
    finish(room, c, 'wolf');
    s.result = `投出的是好人「${nameOf(room, outId)}」，真正的狼王是「${nameOf(
      room,
      s.kingId
    )}」—— 狼人胜`;
  }
  c.log(s.result);
}

module.exports = {
  id: 'dancewolf',
  name: '舞蹈狼人杀',
  desc: '只有狼王的耳机里没有音乐，他得假装踩在拍子上。狼王还能悄悄把人同化过去。',
  minPlayers: 4,
  slogan: '所有人都在跳，只有一个人听不见',
  // 开局前打上投屏的 3 条规则。大屏、玩家手机、主持台共用这一份，
  // 别在别处再抄一遍 —— 改了规则只改这里。
  rules: [
    '每人戴耳机，跟同一首舞曲跳 60 秒',
    '狼王耳机里没有声音，得假装踩在拍子上',
    '音乐停就讨论，投票投中狼王好人赢',
  ],

  init,

  setup(room, cfg, c) {
    const s = room.game.state;
    const list = live(room);
    if (list.length < 4) throw new Error('至少要 4 个人在线');

    s.kingId = pick(list.map((p) => p.id));
    s.wolves = [s.kingId];
    s.converts = [];
    s.votes = {};
    s.tied = [];
    s.winner = '';
    s.result = '';
    s.actWord = pick(ACTS);
    s.bpm = Math.min(160, Math.max(90, Number(cfg.bpm) || 118));
    s.danceSec = Math.min(300, Math.max(20, Number(cfg.danceSec) || 60));
    if (cfg.trackId !== undefined) setTrack(s, cfg.trackId, c);
    if (cfg.musicVol !== undefined) s.musicVol = clampVol(cfg.musicVol);

    // 人越少能同化的次数越少，否则一开局狼就过半了
    const cap = Math.max(1, Math.floor((list.length - 3) / 2));
    s.convertLeft = Math.min(cap, Number(cfg.convertLeft) >= 0 ? Number(cfg.convertLeft) : 2);

    s.phase = 'ready';

    // 只有狼王会收到这条 —— 别人的耳机里有音乐，他没有
    c.send(s.kingId, { t: 'sfx', name: 'wolf' });
    c.say(s.kingId, '你的耳机里不会有音乐。稳住，别露馅。');

    // 用曲库的歌：趁发身份的这会儿让大家先下好，别等开跳才转圈
    if (s.trackKind === 'file') {
      const track = musicTrack(s);
      for (const p of room.players) c.send(p.id, { t: 'beat', preload: true, track });
    }
    c.log(`身份已发 · 同化动作「${s.actWord}」`);
  },

  actions: {
    vote(room, c) {
      const s = room.game.state;
      if (s.phase !== 'vote') throw new Error('还没到投票');
      if (!room.players.some((p) => p.id === c.pid)) throw new Error('你不在这一局');
      const t = c.payload.targetId || (Array.isArray(c.payload.targets) ? c.payload.targets[0] : '');
      if (!t) throw new Error('选一个人');
      if (t === c.pid) throw new Error('不能投自己');
      if (!room.players.some((p) => p.id === t)) throw new Error('没有这个人');
      s.votes[c.pid] = t;
      c.sfx(c.pid, 'ding');
      return { ok: true };
    },

    // ---- 主持 ----
    host_start(room, c) {
      const s = room.game.state;
      if (s.phase === 'dance') throw new Error('已经在跳了');
      s.phase = 'dance';
      s.votes = {};
      // 音乐走耳机，每台手机自己合成同一首，服务器一个字节音频都不发。
      // 提前 700ms 报出「开始时刻」，所有人踩在同一拍上。
      s.musicOffset = 0;
      s.musicAt = Date.now() + 700;
      broadcastMusic(room, c);
      room.game.timer = {
        endsAt: s.musicAt + s.danceSec * 1000,
        label: '跳舞',
        total: s.danceSec,
      };
      c.log('音乐起 —— 跳');
    },

    // 主持人拖动进度条：全场一起跳到那一秒，不是各拖各的。
    // 各拖各的话，好人之间也踩不到一起，这个游戏就没有参照物了。
    host_seek(room, c) {
      const s = room.game.state;
      if (s.phase !== 'dance') throw new Error('音乐没在放，拖不了');
      const dur = s.danceSec;
      let sec = Number(c.payload.sec);
      if (!(sec >= 0)) sec = 0;
      sec = Math.min(Math.max(0, dur - 1), sec);

      s.musicOffset = Math.round(sec * 10) / 10;
      s.musicAt = Date.now() + 700; // 重新给一次开始时刻，所有人一起跳
      broadcastMusic(room, c);

      const left = Math.max(1, dur - s.musicOffset);
      room.game.timer = {
        endsAt: s.musicAt + left * 1000,
        label: '跳舞',
        total: left,
      };
      c.log(`音乐跳到 ${clock(s.musicOffset)}`);
    },

    host_stop(room, c) {
      const s = room.game.state;
      stopBeat(room, c);
      s.phase = 'talk';
      room.game.timer = null;
      c.sfxAll('ding');
      c.log('音乐停，开始讨论');
    },

    // 换成曲库里的歌（或者换回手机合成）。跳的中途换，从头重来。
    host_track(room, c) {
      const s = room.game.state;
      setTrack(s, c.payload.trackId, c);
      if (s.trackKind === 'file') {
        const track = musicTrack(s);
        for (const p of room.players) c.send(p.id, { t: 'beat', preload: true, track });
      }
      if (s.phase === 'dance') {
        s.musicOffset = 0;
        s.musicAt = Date.now() + 900; // 留点时间换歌
        broadcastMusic(room, c);
        room.game.timer = {
          endsAt: s.musicAt + s.danceSec * 1000,
          label: '跳舞',
          total: s.danceSec,
        };
      }
      c.log(`曲目：${s.trackName}`);
      return { ok: true, track: s.trackName };
    },

    // 音量只有主持人能调 —— 手机端不再有滑杆，谁都不能偷偷静音装听不见
    host_vol(room, c) {
      const s = room.game.state;
      s.musicVol = clampVol(c.payload.vol);
      return { ok: true, vol: s.musicVol };
    },

    host_convert(room, c) {
      const s = room.game.state;
      if (s.phase !== 'dance' && s.phase !== 'talk') throw new Error('现在不能同化');
      if (s.convertLeft <= 0) throw new Error('同化次数用完了');
      if (!c.targetId) throw new Error('先在左边点一个玩家');
      if (s.wolves.includes(c.targetId)) throw new Error('他已经在狼阵营了');
      s.wolves.push(c.targetId);
      s.converts.push({ id: c.targetId, at: Date.now() });
      s.convertLeft -= 1;
      c.sfx(c.targetId, 'wolf');
      c.say(c.targetId, '你被同化了 —— 现在你和狼王是一边的');
      c.log(`${c.target ? c.target.name : '?'} 被同化（剩 ${s.convertLeft} 次）`);

      if (s.wolves.length >= goodsCount(room)) {
        finish(room, c, 'wolf');
        c.log(s.result);
      }
    },

    host_vote(room, c) {
      const s = room.game.state;
      if (s.phase === 'done') throw new Error('这局已经结束了');
      stopBeat(room, c);
      s.phase = 'vote';
      s.votes = {};
      room.game.timer = null;
      c.sfxAll('siren');
      c.log('开始投票选狼王');
    },

    host_settle(room, c) {
      const s = room.game.state;
      if (s.phase !== 'vote') throw new Error('先开始投票');
      const tally = {};
      for (const t of Object.values(s.votes)) tally[t] = (tally[t] || 0) + 1;
      const list = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      if (!list.length) throw new Error('还没有人投票');
      if (list.length > 1 && list[0][1] === list[1][1]) {
        s.tied = list.filter((x) => x[1] === list[0][1]).map((x) => x[0]);
        throw new Error(
          `平票：${s.tied.map((id) => nameOf(room, id)).join('、')} —— 点「判这一位出局」定案`
        );
      }
      judge(room, c, list[0][0]);
    },

    host_pick(room, c) {
      const s = room.game.state;
      if (s.phase !== 'vote') throw new Error('先开始投票');
      if (!c.targetId) throw new Error('先在左边点一个玩家');
      judge(room, c, c.targetId);
    },

    host_next(room, c) {
      module.exports.setup(room, {}, c);
    },
  },

  hostView(room, c) {
    const s = room.game.state;
    const king = room.players.find((p) => p.id === s.kingId);
    const voted = Object.keys(s.votes).length;
    const media = (c && c.media) || [];
    return {
      info: [
        { label: '狼王', value: king ? king.name : '—', strong: true },
        { label: '同化动作', value: s.actWord || '—', strong: true },
        { label: '剩余同化', value: `${s.convertLeft} 次` },
        { label: '狼阵营', value: `${s.wolves.length} 人` },
        { label: '已投票', value: `${voted} / ${live(room).length}` },
        { label: '曲目', value: s.trackName || '内置舞曲' },
        { label: '音乐', value: s.phase === 'dance' ? `耳机中 · 音量 ${s.musicVol}%` : '停' },
      ],
      controls: [
        {
          kind: 'btn',
          action: 'host_start',
          label: s.phase === 'dance' ? '正在跳…' : '开始放歌 · 开跳',
          style: 'primary',
        },
        // 曲目进度条：只有音乐在放的时候才能拖
        {
          kind: 'seek',
          action: 'host_seek',
          label: '曲目进度',
          duration: s.danceSec,
          offset: s.musicOffset,
          startAt: s.musicAt,
          playing: s.phase === 'dance',
        },
        {
          kind: 'select',
          action: 'host_track',
          name: 'trackId',
          label: '曲目',
          value: s.trackKind === 'file' ? s.trackId : 'synth',
          options: [{ value: 'synth', label: '内置舞曲（手机合成）' }].concat(
            media.map((m) => ({ value: m.id, label: m.name }))
          ),
        },
        {
          kind: 'range',
          action: 'host_vol',
          name: 'vol',
          label: '耳机音量',
          min: 0,
          max: 100,
          step: 5,
          value: s.musicVol,
          suffix: '%',
        },
        { kind: 'btn', action: 'host_stop', label: '停音乐 · 讨论', style: 'plain' },
        { kind: 'btn', action: 'host_convert', label: '同化他', target: true, style: 'ok' },
        { kind: 'btn', action: 'host_vote', label: '开始投票', style: 'plain' },
        { kind: 'btn', action: 'host_settle', label: '统计票数', style: 'primary' },
        { kind: 'btn', action: 'host_pick', label: '判这一位出局', target: true, style: 'danger' },
        { kind: 'btn', action: 'host_next', label: '重开一局', style: 'plain' },
      ],
      table: {
        columns: ['玩家', '阵营', '同化', '投给了'],
        rows: room.players.map((p) => [
          p.name,
          s.wolves.includes(p.id) ? (p.id === s.kingId ? '狼王' : '狼崽') : '好人',
          s.converts.some((x) => x.id === p.id) ? '被同化' : '—',
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
      return { type: 'text', title: '舞蹈狼人杀', sub: '等主持人开局' };
    }

    if (s.phase === 'done') {
      return {
        type: 'text',
        title: s.winner === 'good' ? '好人胜' : '狼人胜',
        sub: s.result,
        tone: 'done',
      };
    }

    if (s.phase === 'vote') {
      const mine = s.votes[pid];
      return {
        type: 'choice',
        title: '谁是狼王',
        sub: mine ? '已投，等其他人' : '只有狼王听不到音乐，谁在装？',
        action: 'vote',
        options: room.players
          .filter((p) => p.id !== pid)
          .map((p) => ({ value: p.id, label: p.name })),
        selected: mine ? [mine] : [],
        footer: `已投 ${Object.keys(s.votes).length} / ${live(room).length}`,
      };
    }

    const isKing = pid === s.kingId;
    const isWolf = s.wolves.includes(pid);
    const dancing = s.phase === 'dance';

    let text = '你是好人';
    let tone = 'good';
    if (isKing) {
      text = '你是狼王';
      tone = 'wolf';
    } else if (isWolf) {
      text = '你被同化了';
      tone = 'wolf';
    }

    return {
      type: 'word',
      title: dancing ? '跳起来' : s.phase === 'talk' ? '讨论时间' : '身份已发',
      // 这句在遮罩外面 —— 所有人必须一字不差，否则旁边的人瞄一眼就知道了
      sub: dancing ? '耳机里的音乐在放，跟着跳' : '按住看你的身份，别给旁边的人看见',
      text,
      hold: true,
      tone,
      // 音乐只在耳机里；每台手机自己合成或自己放曲库里的歌，服务端不发音频。
      // 音量由主持台统一控制（vol），手机端不给自己调。
      beat: {
        show: dancing,
        on: dancing && !isKing,
        bpm: s.bpm,
        startAt: s.musicAt,
        offset: s.musicOffset,
        duration: s.danceSec,
        vol: s.musicVol,
        track: musicTrack(s),
      },
    };
  },

  screenView(room) {
    const s = room.game.state;
    if (s.phase === 'idle') {
      return { type: 'podium', title: '舞蹈狼人杀', big: '准备', sub: '戴好耳机再开始' };
    }
    if (s.phase === 'done') {
      return {
        type: 'podium',
        title: '舞蹈狼人杀',
        big: s.winner === 'good' ? '好人胜' : '狼人胜',
        sub: s.result,
      };
    }
    if (s.phase === 'dance') {
      return { type: 'podium', title: '舞蹈狼人杀', big: '♫', sub: '跟着音乐跳' };
    }
    if (s.phase === 'talk') {
      return { type: 'podium', title: '舞蹈狼人杀', big: '讨论', sub: '谁踩错拍子了？' };
    }
    if (s.phase === 'vote') {
      const n = Object.keys(s.votes).length;
      return { type: 'podium', title: '投票', big: `${n} / ${live(room).length}`, sub: '已投票' };
    }
    return { type: 'podium', title: '舞蹈狼人杀', big: '准备' };
  },

  // 跳舞时间到就自己收尾，主持人在忙别的也不会一直响
  tick(room, now) {
    const s = room.game.state;
    const t = room.game.timer;
    if (!t || !t.endsAt || now < t.endsAt) return false;
    if (s.phase === 'dance') {
      s.phase = 'talk';
      room.game.timer = null;
      return true;
    }
    return false;
  },
};
