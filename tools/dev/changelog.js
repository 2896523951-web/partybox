#!/usr/bin/env node
'use strict';

/* 从 git 提交记录重建 CHANGELOG 的 [Unreleased] 段。
 *
 * 三条设计取向：
 * 1. 只认提交前缀（feat / fix / docs / refactor / perf / test / chore…），
 *    不按关键词猜语义 —— 猜错比没有更糟。
 * 2. 每次「重建」而不是「追加」：amend、rebase、重排之后不会重复堆叠。
 * 3. [Unreleased] 里有一段「手动补充」，脚本永远不碰 —— 想写人话就写在那儿。
 *
 * 用法：
 *   node tools/dev/changelog.js            # 重建并写入
 *   node tools/dev/changelog.js --check    # 只比对，有差异就退出 1（CI / 钩子用）
 *   node tools/dev/changelog.js --dry      # 打到终端，不写文件
 *   node tools/dev/changelog.js --base v1.0.0
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FILE = path.join(ROOT, 'CHANGELOG.md');
const UNRELEASED = '## [Unreleased]';
const MANUAL_TITLE = '### 手动补充';

/* 前缀 → 分组。顺序就是输出顺序。 */
const GROUPS = [
  ['feat', '新增'],
  ['fix', '修复'],
  ['refactor', '变更'],
  ['perf', '变更'],
  ['docs', '文档'],
  ['test', '测试'],
  ['chore', '杂项'],
  ['build', '杂项'],
  ['ci', '杂项'],
  ['style', '杂项'],
];
const OTHER = '其他';

/* Windows 上 git 会把 LF 转成 CRLF，逐字符比较会误报「不一致」。
 * 比较和写入判断都先归一化，避免 check 永远失败。 */
const norm = (s) => String(s).replace(/\r\n/g, '\n');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function baseTag(explicit) {
  if (explicit) return explicit;
  try {
    const t = git(['describe', '--tags', '--abbrev=0', '--match', 'v*']);
    return t || '';
  } catch (e) {
    return '';
  }
}

function readCommits(base) {
  const range = base ? `${base}..HEAD` : 'HEAD';
  let out = '';
  try {
    out = git(['log', range, '--pretty=format:%h%x09%s']);
  } catch (e) {
    return [];
  }
  return out
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((x) => x.length === 2 && x[0])
    .map(([sha, subject]) => ({ sha, subject }))
    // 只改 CHANGELOG 自己的提交不进 Unreleased，否则每跑一次就自我繁殖一条
    .filter((c) => {
      try {
        const files = execFileSync('git', ['show', '--pretty=format:', '--name-only', c.sha], {
          cwd: ROOT,
          encoding: 'utf8',
        })
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean);
        return !(files.length === 1 && files[0] === 'CHANGELOG.md');
      } catch (e) {
        return true;
      }
    });
}

/* 严格按 `type(scope)?: 描述` 解析；解析不出来就进「其他」，不改写原文。 */
function parse(subject) {
  const m = /^([a-zA-Z]+)(\([^)]*\))?!?:\s*(.+)$/.exec(subject);
  if (!m) return { group: OTHER, text: subject };
  const type = m[1].toLowerCase();
  const hit = GROUPS.find(([t]) => t === type);
  if (!hit) return { group: OTHER, text: subject };
  return { group: hit[1], text: m[3].trim() };
}

function buildSection(commits, manual) {
  const order = [...new Set(GROUPS.map(([, g]) => g)), OTHER];
  const buckets = new Map(order.map((g) => [g, []]));
  for (const c of commits) {
    const { group, text } = parse(c.subject);
    buckets.get(group).push(`- ${text}（\`${c.sha}\`）`);
  }

  const lines = [UNRELEASED, ''];
  let any = false;
  for (const g of order) {
    const rows = buckets.get(g);
    if (!rows.length) continue;
    any = true;
    lines.push(`### ${g}`, '', ...rows, '');
  }
  if (!any) lines.push('（暂无改动）', '');

  lines.push(MANUAL_TITLE, '');
  if (manual && manual.trim()) lines.push(manual.trim(), '');
  else lines.push('（这里写给「新增/修复」表达不了的事，脚本不会覆盖）', '');
  return lines.join('\n');
}

function currentManual(text) {
  const i = text.indexOf(UNRELEASED);
  if (i < 0) return '';
  const rest = text.slice(i);
  const nextVersion = rest.indexOf('\n## [', UNRELEASED.length);
  const block = nextVersion >= 0 ? rest.slice(0, nextVersion) : rest;
  const mi = block.indexOf(MANUAL_TITLE);
  if (mi < 0) return '';
  return block.slice(mi + MANUAL_TITLE.length).replace(/^\s*\n/, '').trim();
}

function splice(text, section) {
  const i = text.indexOf(UNRELEASED);
  if (i < 0) {
    // 没有 Unreleased：插在第一个版本标题之前；一个版本都没有就接在文件末尾
    const v = text.search(/^## \[/m);
    const at = v >= 0 ? v : text.length;
    return `${text.slice(0, at).replace(/\s*$/, '')}\n\n${section}\n${text.slice(at)}`;
  }
  const nextVersion = text.indexOf('\n## [', i + UNRELEASED.length);
  const head = text.slice(0, i);
  const tail = nextVersion >= 0 ? text.slice(nextVersion) : '';
  return `${head}${section}${tail}`;
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const dry = args.includes('--dry');
  const bi = args.indexOf('--base');
  const base = baseTag(bi >= 0 ? args[bi + 1] : '');

  const text = fs.readFileSync(FILE, 'utf8');
  const commits = readCommits(base);
  const section = buildSection(commits, currentManual(text));
  const next = splice(text, section);

  if (dry) {
    process.stdout.write(section + '\n');
    return;
  }
  if (check) {
    if (norm(next) !== norm(text)) {
      console.error('CHANGELOG.md 的 [Unreleased] 和提交记录不一致，先跑：node tools/dev/changelog.js');
      process.exit(1);
    }
    console.log('CHANGELOG 的 [Unreleased] 是最新的');
    return;
  }
  if (norm(next) === norm(text)) {
    console.log('CHANGELOG 无变化');
    return;
  }
  fs.writeFileSync(FILE, next, 'utf8');
  const n = commits.length;
  console.log(`CHANGELOG 已更新：[Unreleased] 收录 ${n} 条（基线 ${base || '首个提交'}）`);
}

main();
