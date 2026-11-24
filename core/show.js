'use strict';

/* 一晚节目单 —— 暖场 → 主游戏 → 惩罚 → 收尾。
 *
 * 现场最耗神的不是主持，是「接下来玩什么」。四五个游戏轮下来，
 * 主持人一边管流程一边想菜单，很容易连着两个重口味的游戏，
 * 或者一晚上都在玩需要全神贯注的那种。
 *
 * 节目单不是自动化：点「下一项」还是主持人自己点。它只是把
 * 「今晚的路线」摆在眼前，别在现场临时想。
 */

const TEMPLATES = [
  {
    id: 'free',
    name: '自由模式',
    note: '想玩哪个点哪个，不排单',
    items: [],
  },
  {
    id: 'standard',
    name: '标准一晚',
    note: '暖场 → 主游戏 → 惩罚 → 收尾',
    items: [
      { label: '暖场', gameId: 'numberbomb' },
      { label: '主游戏', gameId: 'undercover' },
      { label: '第二场', gameId: 'drawguess' },
      { label: '惩罚环节', kind: 'penalty' },
      { label: '收尾', kind: 'finale' },
    ],
  },
  {
    id: 'crowd',
    name: '人多的时候',
    note: '全员都能动手的排前面',
    items: [
      { label: '先热手', gameId: 'buzzdance' },
      { label: '听歌', gameId: 'songquiz' },
      { label: '一起跳', gameId: 'dancewolf' },
      { label: '惩罚环节', kind: 'penalty' },
      { label: '收尾', kind: 'finale' },
    ],
  },
  {
    // V1.7 的 6.1：照节目里的坡度排——体力肢体 → 信息差 → 社交推理，收尾最轻。
    // 「过渡」这一项不是游戏：轮到它时投屏清空，主持人在左栏随手整一个人。
    id: 'variety',
    name: '综艺同款',
    note: '体力 → 信息差 → 推理，收尾最轻',
    need: { min: 6, who: '这套' },
    items: [
      { label: '暖场', gameId: 'buzzdance' },
      { label: '主游戏一', gameId: 'dancewolf', need: { min: 5, headset: true, who: '舞蹈狼人杀' } },
      { label: '过渡 · 整一个人', kind: 'whisper', tip: '左栏点一个人 →「耳机里放」' },
      { label: '主游戏二', gameId: 'dumbkill', need: { min: 6, who: '笨蛋杀手' } },
      { label: '收尾', gameId: 'poll' },
    ],
  },
  {
    id: 'teams',
    name: '分队对抗',
    note: 'A / B 队计分，三局两胜',
    items: [
      { label: '第一轮', gameId: 'drawrelay' },
      { label: '第二轮', gameId: 'relay' },
      { label: '决胜局', gameId: 'poll' },
      { label: '收尾', kind: 'finale' },
    ],
  },
];

function template(id) {
  return TEMPLATES.find((t) => t.id === id) || TEMPLATES[0];
}

/* 人数够不够、耳机戴没戴 —— 选模板的这一刻就说清楚。
 * 静默失败是这个项目最忌讳的失败方式：等到开局才发现人不够，
 * 一屋子人已经坐好了，只能尴尬地换游戏。 */
function check(room, t) {
  const ps = (room && room.players) || [];
  const n = ps.length;
  const out = [];
  const need = t.need || {};
  if (need.min && n < need.min) out.push(`${need.who || '这套'}要 ${need.min} 人，现在 ${n} 人`);
  for (const it of t.items || []) {
    const nd = it.need;
    if (!nd) continue;
    const who = nd.who || it.label;
    if (nd.min && n < nd.min) out.push(`${who}要 ${nd.min} 人，现在 ${n} 人`);
    if (nd.headset) {
      const no = ps.filter((p) => !p.headset).map((p) => p.name);
      if (no.length) out.push(`${who} 要全员戴耳机，没戴的：${no.join('、')}`);
    }
  }
  return out;
}

function load(room, id) {
  const t = template(String(id || 'free'));
  const warn = check(room, t);
  room.show = {
    id: t.id,
    name: t.name,
    note: t.note,
    // 深拷贝：模板是共享的，直接塞引用的话，改一局就改了模板
    items: t.items.map((x) => Object.assign({}, x)),
    // 存下来：主持人在「今晚」面板里随时能看到，不用记住刚才那句 toast
    warn,
    index: -1,
  };
  return { ok: true, show: room.show, warn };
}

/* 下一项。返回 item 让 app 去选游戏 / 上惩罚屏。
 * 走到最后一项再点就停在最后一项，不会绕回开头 ——
 * 现场点多了两下不该突然又回到暖场。 */
function next(room) {
  const s = room.show;
  if (!s || !s.items || !s.items.length) return { error: '现在是自由模式，没有节目单' };
  const i = Math.min(s.items.length - 1, (s.index == null ? -1 : s.index) + 1);
  s.index = i;
  return { ok: true, item: s.items[i], index: i, total: s.items.length, done: i === s.items.length - 1 };
}

function state(room) {
  const s = room.show || { id: 'free', name: '自由模式', items: [], index: -1 };
  return {
    id: s.id,
    name: s.name,
    note: s.note || '',
    index: s.index == null ? -1 : s.index,
    total: (s.items || []).length,
    warn: s.warn || [],
    items: (s.items || []).map((x, i) => ({
      label: x.label,
      gameId: x.gameId || null,
      kind: x.kind || null,
      tip: x.tip || '',
      on: i === s.index,
      done: i < s.index,
    })),
  };
}

module.exports = { TEMPLATES, template, check, load, next, state };
