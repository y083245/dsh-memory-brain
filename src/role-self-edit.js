// role-self-edit.js · 让 AI 自己改自己的角色卡（PERSONA_SELF_EDIT）
//
// 为什么单独一个文件：
//   角色卡是**逐条消息注入**的提示词，改它等于改她自己的长期行为。这类写入必须有
//   一道与业务代码解耦、能被离线回归直接测的护栏（scripts/test-role-self-edit.mjs），
//   而不是散在 bridge.js 的请求处理里——那样只能靠起服务手测。
//
// 分层：
//   本文件 = 纯函数 + 极少的 fs（备份/审计）→ 可测、无副作用耦合；
//   bridge.js 的 /api/socialV2/role-card = 鉴权、读文件、调这里、落盘、记日志；
//   mcp-snowluma-safe.js 的 qq_role_card_edit = 模型真正调用的工具（只是转发）。
//
// 边界（管理员在 config.json 的 role.selfEdit 里可调）：
//   · 每天最多 perDay 次改动（按本地自然日，从审计日志数，不走内存计数——重启不重置）；
//   · 单次净增 ≤ maxNetGrowth 字，单次净删 ≤ maxNetShrink 字（防一次删掉半张卡）；
//   · 改完总长 ≤ maxInjectChars - reserveChars（给注入上限留余量）；
//   · 改完总长 ≥ minTotalChars（防把她改空：空卡等于没有人格，且不会有任何报错）；
//   · 必须有 reason（写进审计，管理员回看时知道她当时为什么这么改）。
// 意图上不限制"能改哪一节"：增、删、整节替换、整卡重写都允许——但每一次都留备份。
import fs from 'node:fs';
import path from 'node:path';

export const SELF_EDIT_DEFAULTS = Object.freeze({
  enabled: true,
  perDay: 3,
  maxNetGrowth: 300,
  maxNetShrink: 1500,
  minTotalChars: 1200,
  reserveChars: 100,
  backupKeep: 20,
  reasonMinChars: 2
});

export const SELF_EDIT_ACTIONS = Object.freeze([
  'read',
  'append',
  'set_section',
  'patch',
  'delete_section',
  'replace'
]);

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 合并配置：缺字段用默认值，越界值夹紧（控制台/配置文件写错也不至于放开护栏）。 */
export function normalizeSelfEditConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: r.enabled !== false,
    perDay: clampInt(r.perDay, SELF_EDIT_DEFAULTS.perDay, 0, 20),
    maxNetGrowth: clampInt(r.maxNetGrowth, SELF_EDIT_DEFAULTS.maxNetGrowth, 0, 4000),
    maxNetShrink: clampInt(r.maxNetShrink, SELF_EDIT_DEFAULTS.maxNetShrink, 0, 20000),
    minTotalChars: clampInt(r.minTotalChars, SELF_EDIT_DEFAULTS.minTotalChars, 200, 10000),
    reserveChars: clampInt(r.reserveChars, SELF_EDIT_DEFAULTS.reserveChars, 0, 2000),
    backupKeep: clampInt(r.backupKeep, SELF_EDIT_DEFAULTS.backupKeep, 1, 200),
    reasonMinChars: clampInt(r.reasonMinChars, SELF_EDIT_DEFAULTS.reasonMinChars, 1, 40)
  };
}

/** 本地自然日 YYYY-MM-DD（审计日志按天计数，跨时区重启也不会把额度算错）。 */
export function dayKey(at = Date.now()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 今天这个角色已经改了几次：从审计日志数，不依赖内存计数器。 */
export function countEditsToday(entries, roleName, at = Date.now()) {
  const day = dayKey(at);
  let n = 0;
  for (const e of entries ?? []) {
    if (!e || e.role !== roleName || e.action === 'read') continue;
    if (String(e.at ?? '').slice(0, 10) === day) n += 1;
  }
  return n;
}

// ── 小节定位（按行切，不重排版未改动的部分） ────────────────────────────────
// 为什么不用 role-card.js 的 parseRoleSections：那个函数会把行重新 join、去掉模式标记，
// 用它来写文件等于「每次自改都把整张卡重排一遍」，diff 会变成全文件重写，备份也没法看。
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

function headingTitle(line) {
  const m = HEADING_RE.exec(String(line ?? ''));
  if (!m) return null;
  // 去掉标题里的模式标记（〔二代〕/【二代】/[v2] 等），让模型可以用干净标题定位。
  return m[2]
    .replace(/[\[〔（(【]\s*(?:二代|2\s*代|v2|reserved2|一代|1\s*代|v1|reserved)\s*[\]〕）)】]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 定位小节：返回所有匹配的小节范围（0/1/多）。
 * 匹配规则 = 标题完全相同，或标题包含给定片段（模型常说「说话铁律」而不带「二、」）。
 * 多个匹配时不猜：交给调用方报错要求写更完整的标题——猜错就等于改错人设段落。
 */
function findSectionRange(lines, heading) {
  const want = String(heading ?? '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
  if (!want) return [];
  const heads = [];
  for (let i = 0; i < lines.length; i += 1) {
    const title = headingTitle(lines[i]);
    if (title === null) continue;
    heads.push({ index: i, title });
  }
  const hits = heads.filter((h) => h.title === want || h.title.includes(want));
  return hits.map((h) => {
    const pos = heads.indexOf(h);
    const end = pos + 1 < heads.length ? heads[pos + 1].index - 1 : lines.length - 1;
    return { start: h.index, end, title: h.title };
  });
}

function splitLines(text) {
  // 保留 \r：Windows 上手工编辑过的卡是 CRLF，重写时不能悄悄把换行改掉（会让 git diff 全红）。
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function cleanBody(text) {
  const lines = splitLines(text);
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

/**
 * 算出一次改动后的新文本。**不校验额度**（额度由 checkEdit 负责），只负责改对。
 * @returns {{ok: true, next: string, kind: string} | {ok: false, error: string}}
 */
export function planEdit(text, action, payload = {}) {
  const source = String(text ?? '');
  const lines = splitLines(source);

  if (action === 'replace') {
    const next = String(payload.text ?? '');
    if (!next.trim()) return { ok: false, error: 'replace 需要非空的 text' };
    return { ok: true, next, kind: 'replace_card' };
  }

  if (action === 'append') {
    const title = String(payload.title ?? '').replace(/^#+\s*/, '').trim();
    const body = cleanBody(payload.text);
    if (!title) return { ok: false, error: 'append 需要 title' };
    if (!body.length) return { ok: false, error: 'append 需要非空的 text' };
    const tail = lines.length && lines[lines.length - 1].trim() === '' ? lines.slice(0, -1) : lines.slice();
    const next = [...tail, '', `## ${title}`, ...body, ''].join('\n');
    return { ok: true, next, kind: `append:${title}` };
  }

  if (action === 'patch') {
    const find = String(payload.find ?? '');
    const replacement = String(payload.replace ?? '');
    if (!find) return { ok: false, error: 'patch 需要 find' };
    const count = source.split(find).length - 1;
    if (count === 0) return { ok: false, error: 'find 在角色卡里没有出现，改用 set_section 或先 read 确认原文' };
    if (count > 1) return { ok: false, error: `find 在角色卡里出现 ${count} 次，请给更长的原文片段唯一定位` };
    return { ok: true, next: source.replace(find, replacement), kind: 'patch' };
  }

  const matches = findSectionRange(lines, payload.heading ?? payload.title);
  if (!matches.length) return { ok: false, error: `找不到小节「${payload.heading ?? payload.title ?? ''}」，先 read 看现有标题` };
  if (matches.length > 1) {
    return { ok: false, error: `「${payload.heading ?? payload.title ?? ''}」匹配到 ${matches.length} 个小节（${matches.map((m) => m.title).join(' / ')}），请写更完整的标题` };
  }
  const range = matches[0];

  if (action === 'set_section') {
    const body = cleanBody(payload.text);
    if (!body.length) return { ok: false, error: 'set_section 需要非空的 text；要删除这一节请用 delete_section' };
    // 小节之间永远留一个空行：range 末尾的空行会被一起替换掉，不补回来就会变成
    // 「## 三、梗」紧贴上一行正文，视觉和 Markdown 语义都变了。
    const next = [...lines.slice(0, range.start + 1), ...body, '', ...lines.slice(range.end + 1)].join('\n');
    return { ok: true, next, kind: `set_section:${range.title}` };
  }

  if (action === 'delete_section') {
    const next = [...lines.slice(0, range.start), ...lines.slice(range.end + 1)].join('\n');
    return { ok: true, next, kind: `delete_section:${range.title}` };
  }

  return { ok: false, error: `不支持的动作：${action}` };
}

/**
 * 额度 / 体量校验。任何一条不过就不写盘，并把原因原样回给模型（它能读懂并改写）。
 * @returns {{ok: true, delta: number} | {ok: false, error: string}}
 */
export function checkEdit({ before, after, config, usedToday }) {
  const c = normalizeSelfEditConfig(config);
  const beforeLen = String(before ?? '').length;
  const afterLen = String(after ?? '').length;
  const delta = afterLen - beforeLen;

  if (!c.enabled) return { ok: false, error: '角色卡自改已关闭（config.json 的 role.selfEdit.enabled=false），需要管理员开启' };
  if (delta === 0) return { ok: false, error: '这次改动没有产生任何变化' };
  if (usedToday >= c.perDay) return { ok: false, error: `今天已经改过 ${usedToday} 次，达到上限（每天 ${c.perDay} 次），明天再说` };
  if (afterLen < c.minTotalChars) {
    return { ok: false, error: `改完只剩 ${afterLen} 字符，低于下限 ${c.minTotalChars}：角色卡不能改得这么空，请保留人设主体` };
  }
  if (delta > c.maxNetGrowth) {
    return { ok: false, error: `这次要加 ${delta} 字，超过单次上限 ${c.maxNetGrowth} 字；拆成几次，或先压缩掉旧的重复内容` };
  }
  if (-delta > c.maxNetShrink) {
    return { ok: false, error: `这次要删 ${-delta} 字，超过单次上限 ${c.maxNetShrink} 字；分几次删，别一次砍掉半张卡` };
  }
  return { ok: true, delta };
}

/** 加上注入上限的校验（上限来自 config.json 的 role.maxInjectChars，由 bridge 传入）。 */
export function checkInjectRoom({ after, maxInjectChars, config }) {
  const c = normalizeSelfEditConfig(config);
  const limit = Number(maxInjectChars) || 0;
  if (!limit) return { ok: true };
  const room = limit - c.reserveChars;
  if (String(after ?? '').length > room) {
    return { ok: false, error: `改完 ${String(after).length} 字符，超过注入预算（上限 ${limit}，留 ${c.reserveChars} 余量）；想加就得先删，或让管理员调大 role.maxInjectChars` };
  }
  return { ok: true };
}

// ── 落盘：备份 + 审计 ───────────────────────────────────────────────────────
export function backupRole(file, text, { dir, role, at = Date.now(), keep = SELF_EDIT_DEFAULTS.backupKeep } = {}) {
  const target = dir || path.join(path.dirname(file), '..', 'state', 'role-backups', role);
  fs.mkdirSync(target, { recursive: true });
  const stamp = new Date(at).toISOString().replace(/[:.]/g, '-');
  const bak = path.join(target, `${stamp}.md`);
  fs.writeFileSync(bak, text, { mode: 0o600 });
  try {
    const files = fs.readdirSync(target).filter((n) => n.endsWith('.md')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - keep))) {
      try { fs.rmSync(path.join(target, old)); } catch {}
    }
  } catch {}
  return bak;
}

export function readAudit(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function appendAudit(file, entry, { keep = 200 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = `${JSON.stringify(entry)}\n`;
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch {}
  lines.push(line.trim());
  fs.writeFileSync(file, `${lines.slice(-keep).join('\n')}\n`, { mode: 0o600 });
  return entry;
}
