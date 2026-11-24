/* 视图协议渲染器。服务端下发声明式视图，前端只认这几种控件。
 * 加新游戏基本不需要改这里 —— 这是「插件化」能成立的前提。 */
(function (g) {
  let cleanups = [];
  let rafs = [];

  function clearAll() {
    for (const fn of cleanups) {
      try { fn(); } catch (e) {}
    }
    for (const id of rafs) cancelAnimationFrame(id);
    cleanups = [];
    rafs = [];
  }

  function h(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function timer(ms, fn) {
    const id = setTimeout(fn, ms);
    cleanups.push(() => clearTimeout(id));
    return id;
  }

  function interval(ms, fn) {
    const id = setInterval(fn, ms);
    cleanups.push(() => clearInterval(id));
    return id;
  }

  /* ------------------------------------------------------- 数字滚动
   * 分数从 40 跳到 43 直接替换，现场没人注意到。
   * 让它滚一下，眼睛就会跟过去 —— 这是「像节目」和「像表格」的分界。
   * 上一次的值按 key 记在模块里，所以整屏重绘也接得上。 */
  let lastNums = {};

  function tweenNum(el, from, to) {
    const t0 = performance.now();
    const dur = 520;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = String(Math.round(from + (to - from) * e));
      if (k < 1) rafs.push(requestAnimationFrame(step));
    };
    rafs.push(requestAnimationFrame(step));
  }

  function numEl(cls, val, key) {
    const e = h('span', cls, String(val));
    const from = lastNums[key];
    if (from != null && from !== val) tweenNum(e, from, val);
    lastNums[key] = val;
    return e;
  }

  function resetNums() {
    lastNums = {};
  }

  /* --------------------------------------------------------- 主渲染 */

  function render(root, view, opts) {
    clearAll();
    root.innerHTML = '';
    if (!view) view = { type: 'text', title: '等待中' };
    const act = (a, p) => opts && opts.onAction && opts.onAction(a, p || {});
    const t = view.type || 'text';

    const wrap = h('div', 'vw vw-' + t);

    // P2：交了就盖一个对勾，别让他反复点；P1 的指令行随后说明还差几个人
    if (view.done) wrap.appendChild(h('div', 'vw-done', '✓ 已提交'));
    // P1：一句话指令在最上面，进度在副标题下面 —— 抬眼就知道现在该干嘛、进行到哪
    if (view.lead) wrap.appendChild(h('div', 'vw-lead', view.lead));
    if (view.title) wrap.appendChild(h('div', 'vw-title', view.title));
    if (view.sub) wrap.appendChild(h('div', 'vw-sub', view.sub));
    if (view.prog) wrap.appendChild(h('div', 'vw-prog', view.prog));
    if (view.big) wrap.appendChild(h('div', 'vw-big', view.big));

    if (t === 'word') {
      wrap.appendChild(wordBlock(view, opts));
    } else if (t === 'choice') {
      // hold 的选项整块压在遮罩下：名单本身就是秘密，按住才露
      wrap.appendChild(view.hold ? holdChoiceBlock(view, act) : choiceBlock(view, act));
    } else if (t === 'answer') {
      wrap.appendChild(answerBlock(view, act));
    } else if (t === 'buzz') {
      wrap.appendChild(buzzBlock(view, act, opts));
    } else if (t === 'list') {
      wrap.appendChild(listBlock(view));
    } else if (t === 'rules') {
      wrap.appendChild(rulesBlock(view));
    } else if (t === 'bet') {
      wrap.appendChild(betBlock(view, act));
    } else if (t === 'settle') {
      wrap.appendChild(settleBlock(view));
    }

    // 词卡上叠一个投票/选项：卧底局就是「看着自己的词投票」
    if (view.choice) wrap.appendChild(choiceBlock(view.choice, act));

    if (view.hint && t !== 'word') wrap.appendChild(h('div', 'vw-hint', view.hint));
    if (view.reveal) wrap.appendChild(h('div', 'vw-reveal', '答案：' + view.reveal));

    if (view.button) {
      const b = h('button', 'btn primary wide vw-btn', view.button.label);
      b.onclick = () => act(view.button.action, view.button.payload);
      wrap.appendChild(b);
    }

    // 空档互动：等下一局的时候手机上有事可做，投屏才会飘东西
    if (view.mood) wrap.appendChild(moodBlock(act));

    if (view.footer) wrap.appendChild(h('div', 'vw-footer', view.footer));

    root.appendChild(wrap);
  }

  /* --------------------------------------------------------- 词卡 */

  function wordBlock(view, opts) {
    const box = h('div', 'wordbox' + (view.hold ? ' hold' : '') + (view.until ? ' timed' : ''));
    if (view.tone) box.classList.add('tone-' + view.tone);
    if (view.choice) box.classList.add('compact');

    const mask = h('div', 'wordmask');
    mask.appendChild(h('div', 'wordmask-icon', '👁'));
    mask.appendChild(h('div', 'wordmask-text', '按住查看'));

    const text = h('div', 'wordtext', view.text || '');
    box.appendChild(mask);
    box.appendChild(text);

    /* 遮罩下面那行小字（双卧底的「同伙：XXX」）。
       必须和词一起藏在遮罩里，不能走 hint —— hint 在遮罩外面，
       有 hint 的那台手机一眼就比别人的多一行，等于把身份写脸上。 */
    if (view.note) box.appendChild(h('div', 'wordnote', view.note));

    if (view.hint) box.appendChild(h('div', 'wordhint', '提示：' + view.hint));
    if (view.len) box.appendChild(h('div', 'wordlen', `共 ${view.len} 个字`));

    if (view.hold) {
      const show = (e) => {
        e && e.preventDefault && e.preventDefault();
        box.classList.add('show');
      };
      const hide = () => box.classList.remove('show');
      box.addEventListener('pointerdown', show);
      box.addEventListener('pointerup', hide);
      box.addEventListener('pointercancel', hide);
      box.addEventListener('pointerleave', hide);
      cleanups.push(() => {
        box.removeEventListener('pointerdown', show);
        box.removeEventListener('pointerup', hide);
        box.removeEventListener('pointercancel', hide);
        box.removeEventListener('pointerleave', hide);
      });
    } else {
      box.classList.add('show');
    }

    if (view.until) {
      const now = g.NET ? g.NET.serverNow() : Date.now();
      const left = view.until - now;
      if (left <= 0) {
        box.classList.remove('show');
        box.classList.add('expired');
      } else {
        timer(left, () => {
          box.classList.remove('show');
          box.classList.add('expired');
          box.querySelector('.wordmask-text').textContent = '已隐藏';
        });
      }
    }
    return box;
  }

  /* --------------------------------------------------------- 选项 */

  function choiceBlock(view, act) {
    const box = h('div', 'choices');
    const limit = view.multi ? view.limit || 99 : 1;
    let picked = Array.isArray(view.selected) ? view.selected.slice() : [];

    for (const o of view.options || []) {
      const b = h('button', 'choice' + (picked.includes(o.value) ? ' on' : '') + (o.disabled ? ' off' : ''));
      b.dataset.value = o.value;
      b.textContent = o.label;
      if (o.disabled) {
        b.disabled = true;
        box.appendChild(b);
        continue;
      }
      b.onclick = () => {
        if (view.multi) {
          const i = picked.indexOf(o.value);
          if (i >= 0) picked.splice(i, 1);
          else {
            if (picked.length >= limit) picked.shift();
            picked.push(o.value);
          }
          box.querySelectorAll('.choice').forEach((el) => {
            el.classList.toggle('on', picked.includes(el.dataset.value));
          });
        } else {
          picked = [o.value];
          box.querySelectorAll('.choice').forEach((el) => {
            el.classList.toggle('on', el.dataset.value === o.value);
          });
          submit();
        }
      };
      box.appendChild(b);
    }

    const submit = () => {
      if (!picked.length) {
        if (g.toast) g.toast('先选一个');
        return;
      }
      const payload = view.multi ? { targets: picked } : { targetId: picked[0] };
      act(view.action || 'vote', payload);
    };

    if (view.multi || view.submitLabel) {
      const s = h('button', 'btn primary wide', view.submitLabel || '提交');
      s.onclick = submit;
      box.appendChild(s);
    }
    return box;
  }

  /* --------------------------------------------- 按住才看的选项
   * 笨蛋杀手的杀手手机：屏幕上一列「张三 走你」「李四 走你」，
   * 旁边的人瞄一眼就知道他是杀手。所以整块（说明 + 名单）压在遮罩下，
   * 按住才露出来；手指滑到某个名字上松手，就等于喊了他。
   * 只按一下不滑动 = 只是看看，不会误发。 */

  function holdChoiceBlock(view, act) {
    const wrap = h('div', 'holdpick');
    const body = h('div', 'holdpick-body');
    const list = h('div', 'choices');

    if (view.note) body.appendChild(h('div', 'holdpick-note', view.note));
    for (const o of view.options || []) {
      const b = h('button', 'choice');
      b.type = 'button';
      b.dataset.value = o.value;
      b.textContent = o.label;
      list.appendChild(b);
    }
    // 人一多，一列排下来会顶出屏幕；按住之后又没法滚动（滑动是选择），
    // 所以超过 6 个就排两列，保证一屏看得完
    if ((view.options || []).length > 6) list.classList.add('many');
    body.appendChild(list);
    if (view.holdFoot) body.appendChild(h('div', 'holdpick-note', view.holdFoot));

    // 遮罩上只写和普通身份卡一模一样的两行。
    // 多写一句「滑到名字上松手」就等于告诉旁边的人：这人手里有名单。
    const mask = h('div', 'holdpick-mask');
    mask.appendChild(h('div', 'holdpick-icon', '👁'));
    mask.appendChild(h('div', 'holdpick-text', '按住查看'));

    wrap.appendChild(body);
    wrap.appendChild(mask);

    let hot = null;
    const mark = (b) => {
      if (hot === b) return;
      if (hot) hot.classList.remove('hot');
      hot = b;
      if (hot) hot.classList.add('hot');
    };

    // 遮罩露出来之后就 pointer-events:none 了，所以靠坐标找手指下面是哪个名字
    const onMove = (ev) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const b = el && el.closest ? el.closest('.choice') : null;
      mark(b && list.contains(b) ? b : null);
    };
    const onEnd = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      const b = hot;
      mark(null);
      wrap.classList.remove('show');
      if (b && b.dataset.value) act(view.action || 'guess', { targetId: b.dataset.value });
    };
    const onDown = (ev) => {
      ev.preventDefault();
      wrap.classList.add('show');
      mark(null);
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onEnd);
      document.addEventListener('pointercancel', onEnd);
    };

    mask.addEventListener('pointerdown', onDown);
    cleanups.push(() => {
      mask.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
    });

    return wrap;
  }

  /* --------------------------------------------------------- 输入 */

  function answerBlock(view, act) {
    const box = h('div', 'answer');
    const input = h('input', 'input');
    input.type = view.numeric ? 'tel' : 'text';
    if (view.numeric) input.inputMode = 'numeric';
    input.placeholder = view.placeholder || '';
    input.maxLength = 24;
    input.autocomplete = 'off';
    if (view.disabled) input.disabled = true;

    const btn = h('button', 'btn primary wide', (view.button && view.button.label) || '提交');
    btn.disabled = !!view.disabled;

    const send = () => {
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      const payload = { text, n: Number(text) };
      act(view.action || 'guess', payload);
      input.value = '';
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
    });
    btn.onclick = send;

    box.appendChild(input);
    box.appendChild(btn);
    if (view.footer) box.appendChild(h('div', 'vw-footer', view.footer));
    return box;
  }

  /* --------------------------------------------------------- 抢答
   * 到点之前按钮是死的 —— 抢跑在物理上就按不下去，所以也不用罚分。
   * 服务端还是会兜一道：两边时钟差个几十毫秒的时候，它只回「还没到」。 */

  function buzzBlock(view, act, opts) {
    const box = h('div', 'buzzwrap');
    const btn = h('button', 'buzzbtn');
    const label = h('div', 'buzzlabel', view.title || '抢答');
    const sub = h('div', 'buzzsub', '');
    btn.appendChild(label);
    btn.appendChild(sub);

    let hit = false;
    const now = () => (g.NET ? g.NET.serverNow() : Date.now());
    const openAt = Number(view.openAt) || 0;

    const paint = () => {
      if (view.disabled) {
        btn.disabled = true;
        btn.classList.remove('on');
        label.textContent = '本轮禁答';
        sub.textContent = '';
        return;
      }
      if (hit) return;
      const left = openAt ? openAt - now() : -1;
      if (left > 0) {
        btn.disabled = true;
        btn.classList.remove('on');
        label.textContent = '准备…';
        // 最后一秒给个数字，比干等有节奏
        sub.textContent = left < 1500 ? (left / 1000).toFixed(1) : '';
      } else {
        btn.disabled = false;
        if (!btn.classList.contains('on')) {
          btn.classList.add('on');
          label.textContent = '按！';
          sub.textContent = '按一下';
          if (g.Sfx && opts && opts.onArmed) opts.onArmed();
        }
      }
    };
    paint();
    interval(50, paint);

    btn.onclick = () => {
      if (view.disabled || hit) return;
      hit = true;
      btn.classList.add('hit');
      btn.disabled = true;
      label.textContent = '已抢';
      sub.textContent = '等主持人判';
      act('buzz', { clientTs: now() });
    };

    box.appendChild(btn);
    return box;
  }

  function listBlock(view) {
    const box = h('div', 'vlist');
    for (const row of view.rows || []) {
      const r = h('div', 'vrow');
      /* 两种写法：
       *   数组 [名次, 名字, 分数]        —— 老游戏的榜
       *   对象 { rank, name, num, tag } —— 收工榜，名字下面还要带称号
       * 统一成「左边名次 / 中间名字 / 右边数字」，手机上才不会挤成一行。 */
      if (!Array.isArray(row) && row && typeof row === 'object') {
        if (row.rank != null) r.appendChild(h('span', 'vcell lead', String(row.rank)));
        const mid = h('div', 'vmid');
        mid.appendChild(h('span', 'vname', String(row.name == null ? '' : row.name)));
        if (row.tag) mid.appendChild(h('span', 'vtag', String(row.tag)));
        r.appendChild(mid);
        if (row.num != null) r.appendChild(h('span', 'vnum', String(row.num)));
        box.appendChild(r);
        continue;
      }
      (Array.isArray(row) ? row : [row]).forEach((c, i) => {
        r.appendChild(h('span', i === 0 ? 'vcell lead' : 'vcell', String(c)));
      });
      box.appendChild(r);
    }
    return box;
  }

  /* --------------------------------------------------------- 规则卡
   * 还没开局时手机上不摆「等主持人」这种空话 —— 把 3 条规则给他，
   * 手机上有的看，就不用凑到别人屏幕前，也不会一直问「怎么玩」。 */

  function rulesBlock(view) {
    const box = h('div', 'rulerows');
    (view.rules || []).forEach((t, i) => {
      const row = h('div', 'rulerow');
      row.appendChild(h('span', 'rulenum', String(i + 1)));
      row.appendChild(h('span', 'ruletxt', t));
      box.appendChild(row);
    });
    if (!(view.rules || []).length) box.appendChild(h('div', 'ruletxt', '等主持人讲规则'));
    return box;
  }

  /* ------------------------------------------------------ 围观下注
   * 只给「没在局里」的人看。选了就发，没有提交按钮 ——
   * 空档只有几十秒，多一步就没人做。 */

  function betBlock(view, act) {
    const box = h('div', 'betwrap');

    if (view.done) {
      if (view.big) box.appendChild(h('div', 'betbig', view.big));
      box.appendChild(h('div', 'betnote', view.sub || ''));
      return box;
    }

    const grid = h('div', 'choices betpick');
    const opts = view.options || [];
    if (opts.length > 6) grid.classList.add('many');
    let cur = view.pick == null ? '' : String(view.pick);

    for (const o of opts) {
      const b = h('button', 'choice' + (cur === String(o.value) ? ' on' : ''));
      b.dataset.value = o.value;
      b.textContent = o.label;
      b.onclick = () => {
        cur = String(o.value);
        grid.querySelectorAll('.choice').forEach((el) => {
          el.classList.toggle('on', el.dataset.value === cur);
        });
        act('_bet', { targetId: o.value });
      };
      grid.appendChild(b);
    }
    box.appendChild(grid);
    box.appendChild(h('div', 'betnote', '结算前可以改，算最后一次'));
    return box;
  }

  /* -------------------------------------------------------- 结算页 */

  function settleBlock(view) {
    const box = h('div', 'settlebox');
    if (view.big) box.appendChild(h('div', 'settlebig', view.big));
    box.appendChild(listBlock(view));
    if (view.note) box.appendChild(h('div', 'vw-hint', view.note));
    return box;
  }

  /* ------------------------------------------------- 空档表情互动
   * 6 个，点一下就走。不给打字 —— 能给打字就会有人开始骂人，
   * 那时候主持人还得下场当管理员。 */
  const MOODS = ['😂', '😱', '👏', '🤔', '😭', '🔥'];

  function moodBlock(act) {
    const box = h('div', 'moodrow');
    for (const e of MOODS) {
      const b = h('button', 'moodbtn', e);
      b.type = 'button';
      b.onclick = () => act('_mood', { emoji: e });
      box.appendChild(b);
    }
    return box;
  }

  /* ------------------------------------------------------- 大屏渲染 */

  /* 规则卡。字要大、条数要少 —— 现场是站在三米外看的，
   * 一行超过 20 个字就没人念得下来。二维码留在右下角：
   * 选完游戏还会有人陆续进来，这时候把扫码页换掉又不给码，
   * 后到的人就卡在门口了。 */
  function rulesScreen(view) {
    const box = h('div', 'sc-rules');

    const head = h('div', 'sc-rules-head');
    head.appendChild(h('div', 'sc-kicker', '接下来玩'));
    head.appendChild(h('div', 'sc-rtitle', view.gameName || ''));
    if (view.slogan) head.appendChild(h('div', 'sc-slogan', view.slogan));
    if (view.need) {
      const enough = !view.online || view.online >= view.need;
      head.appendChild(h('div', 'sc-need', `需要 ${view.need} 人起 · 现在 ${view.online || 0} 人在线${enough ? '' : '（还差 ' + (view.need - view.online) + ' 人）'}`));
    }
    box.appendChild(head);

    const steps = h('div', 'sc-steps');
    (view.rules || []).forEach((t, i) => {
      const row = h('div', 'sc-step');
      row.appendChild(h('span', 'sc-step-n', String(i + 1)));
      row.appendChild(h('span', 'sc-step-t', t));
      steps.appendChild(row);
    });
    box.appendChild(steps);

    const foot = h('div', 'sc-rules-foot');
    const qr = h('div', 'sc-qr');
    qr.id = 'scQr';
    foot.appendChild(qr);
    const join = h('div', 'sc-join');
    join.appendChild(h('div', 'sc-join-n', `${view.online || 0} / ${view.count || 0} 人在场`));
    join.appendChild(h('div', 'sc-join-t', '手机扫码进房间'));
    // Wi-Fi 名字由 screen.html 填（要问系统，比渲染晚到一步）；空着就不占高度
    const wifi = h('div', 'sc-join-w');
    wifi.id = 'scWifi';
    join.appendChild(wifi);
    foot.appendChild(join);
    box.appendChild(foot);

    return box;
  }

  /* 本局结算：投屏上只留名次、名字、分数。
   * 三米外看得清的字号，一条一行，最多 8 行。 */
  function settleScreen(view) {
    const box = h('div', 'sc-settle');
    if (view.kicker) box.appendChild(h('div', 'sc-kicker', view.kicker));
    box.appendChild(h('div', 'sc-stitle', view.title || '本局结束'));

    const rows = view.rows || [];
    const variety = view.mode === 'variety';
    /* 综艺模式：先把「名场面」摆出来，分数不摆 ——
     * 这一晚被记住的是那几句话，不是谁多两分。 */
    if (variety && (view.moments || []).length) {
      const mb = h('div', 'sc-moments');
      mb.appendChild(h('div', 'sc-kicker', '名场面'));
      for (const t of view.moments) mb.appendChild(h('div', 'sc-moment-line', '「' + t + '」'));
      box.appendChild(mb);
    }
    if (variety) {
      const strip = h('div', 'sc-vnames');
      for (const r of rows.slice(0, 8)) strip.appendChild(h('span', 'sc-vname', r.name));
      box.appendChild(strip);
    } else {
      for (const r of rows.slice(0, 8)) {
        const row = h('div', 'sc-srow' + (r.rank === 1 ? ' top' : ''));
        row.appendChild(numEl('sc-srank', r.rank, 'sr:' + r.name));
        row.appendChild(h('span', 'sc-sname', r.name));
        row.appendChild(numEl('sc-snum', r.score, 'ss:' + (view.title || '') + ':' + r.name));
        box.appendChild(row);
      }
    }
    if (!rows.length) box.appendChild(h('div', 'sc-hint', '这局没有分数'));
    if (view.note) box.appendChild(h('div', 'sc-hint', view.note));
    return box;
  }

  /* 收工总榜：名次 + 名字 + 称号 + 总分。
   * 称号比分数更容易被记住，所以摆在名字正下面。 */
  function boardScreen(view) {
    const box = h('div', 'sc-board');
    box.appendChild(h('div', 'sc-kicker', '今晚收工'));
    box.appendChild(h('div', 'sc-stitle', view.title || '总榜'));
    if (view.sub) box.appendChild(h('div', 'sc-slogan', view.sub));

    const rows = view.rows || [];
    for (const r of rows.slice(0, 10)) {
      const row = h('div', 'sc-brow' + (r.rank === 1 ? ' top' : ''));
      row.appendChild(numEl('sc-brank', r.rank, 'br:' + r.name));
      const mid = h('div', 'sc-bmid');
      mid.appendChild(h('span', 'sc-bname', r.name));
      mid.appendChild(h('span', 'sc-bgot', r.title || ''));
      row.appendChild(mid);
      const right = h('div', 'sc-bright');
      right.appendChild(numEl('sc-bnum', r.total, 'bt:' + r.name));
      right.appendChild(h('span', 'sc-bsub', `正赛 ${r.score} · 押注 ${r.bet}`));
      row.appendChild(right);
      box.appendChild(row);
    }
    if (!rows.length) box.appendChild(h('div', 'sc-hint', '还没人进来'));
    return box;
  }

  /* 下注条：只报人数和结果，不报谁押了谁 ——
   * 写出来就没意思了，还会被拿来当线索。 */
  function betStrip(b) {
    const box = h('div', 'sc-bet');
    if (b.open) {
      box.appendChild(h('span', 'sc-bet-t', `围观下注 · ${b.n} 人押了`));
      box.appendChild(h('span', 'sc-bet-s', '猜这局谁赢'));
    } else {
      box.appendChild(h('span', 'sc-bet-t', `${b.winnerName || '?'} 赢了`));
      box.appendChild(h('span', 'sc-bet-s', b.hits && b.hits.length ? `${b.hits.length} 人押中 +2` : '没人押中'));
    }
    return box;
  }

  function renderScreen(root, view) {
    clearAll();
    root.innerHTML = '';
    if (!view) return;
    const t = view.type || 'podium';

    if (t === 'rules') {
      root.appendChild(rulesScreen(view));
    } else if (t === 'settle') {
      root.appendChild(settleScreen(view));
    } else if (t === 'board') {
      root.appendChild(boardScreen(view));
    } else if (view.type === 'bars') {
      const box = h('div', 'sc-bars');
      /* 11：投票类游戏的「题目」原来只存在 title 里，bars 渲染器不画标题，
       * 所以大屏只剩一排柱状图。补一行抬头，题目和进度都看得见。 */
      if (view.title || view.sub) {
        const head = h('div', 'sc-bars-head');
        if (view.title) head.appendChild(h('div', 'sc-bars-title', view.title));
        if (view.sub) head.appendChild(h('div', 'sc-bars-sub', view.sub));
        box.appendChild(head);
      }
      const bars = (view.bars || []).slice(0, 8);
      const max = Math.max(1, ...bars.map((b) => b.value));
      for (const b of bars) {
        const row = h('div', 'sc-bar');
        row.appendChild(h('span', 'sc-bar-label', b.label));
        const track = h('div', 'sc-bar-track');
        const fill = h('i');
        // 先从 0 开始，下一帧再长到目标宽度 —— 直接设成目标值的话
        // transition 不会触发，条形是一下子蹦出来的
        fill.style.width = '0%';
        track.appendChild(fill);
        const pct = Math.round((b.value / max) * 100) + '%';
        rafs.push(requestAnimationFrame(() => { fill.style.width = pct; }));
        row.appendChild(track);
        row.appendChild(numEl('sc-bar-num', b.value, 'bar:' + b.label));
        box.appendChild(row);
      }
      root.appendChild(box);
      if (!bars.length) root.appendChild(h('div', 'sc-empty', '还没有结果'));
    } else if (t === 'reveal') {
      // S2 逐条揭晓：一行一行往下排，最新那条高亮；条数不多，不做滚动
      const box = h('div', 'sc-reveal');
      if (view.title) box.appendChild(h('div', 'sc-reveal-t', view.title));
      if (view.big) box.appendChild(h('div', 'sc-big small', view.big));
      const list = h('div', 'sc-reveal-list');
      (view.lines || []).forEach((line, i) => {
        const last = i === (view.lines || []).length - 1;
        const row = h('div', 'sc-reveal-row' + (last ? ' now' : ''), line);
        row.style.animationDelay = Math.min(i, 8) * 40 + 'ms';
        list.appendChild(row);
      });
      box.appendChild(list);
      if (view.sub) box.appendChild(h('div', 'sc-sub', view.sub));
      if (view.note) box.appendChild(h('div', 'sc-hint', view.note));
      root.appendChild(box);
    } else if (t === 'relay') {
      const box = h('div', 'sc-podium');
      if (view.big) box.appendChild(h('div', 'sc-big', view.big));
      if (view.sub) box.appendChild(h('div', 'sc-sub', view.sub));
      if (view.hint) box.appendChild(h('div', 'sc-hint', view.hint));
      root.appendChild(box);
    } else if (t === 'range') {
      const box = h('div', 'sc-podium');
      box.appendChild(h('div', 'sc-big small', view.big || ''));
      if (view.sub) box.appendChild(h('div', 'sc-sub', view.sub));
      if (view.note) box.appendChild(h('div', 'sc-hint', view.note));
      root.appendChild(box);
    } else {
      const box = h('div', 'sc-podium');
      if (view.big) box.appendChild(h('div', 'sc-big', view.big));
      if (view.sub) box.appendChild(h('div', 'sc-sub', view.sub));
      if (view.note) box.appendChild(h('div', 'sc-hint', view.note));
      root.appendChild(box);
    }

    if (view.bet && (view.bet.open || view.bet.settled)) {
      root.appendChild(betStrip(view.bet));
    }
  }

  g.View = { render, renderScreen, clear: clearAll, resetNums };
})(window);
