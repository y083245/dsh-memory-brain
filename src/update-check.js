// UPGRADE_PATCH：版本检查（docs/design/UPGRADE_SPEC.md U2、接口约定 §6）。
//
// 只读、只提示：控制台显示当前版本号；GitHub 上有新标签时提示版本号、CHANGELOG 摘要和升级命令。
// 升级本身只走 scripts/update.sh，这里绝不执行 git、不改任何文件。
//
// 安全取舍：
// - 仓库地址读 .git/config 的 [remote "origin"]（不 spawn git），只认 github.com。
// - 只允许 api.github.com / raw.githubusercontent.com 两个写死的主机、https、redirect:'error'、
//   10 秒超时、响应大小上限。**不用 safe-fetch.js**：Clash fake-ip 下 github 会解析到 198.18.x.x，
//   被它当内网拦掉；目标主机是写死的，不需要那套 SSRF 防护。
// - fetch 由调用方注入；QQB_NO_UPDATE_CHECK=1（测试 harness 设置）时恒为 off、零请求、不建定时器。
// - 失败静默：state='error'，error 只放简短原因；结果只在内存里。
import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com']);
const USER_AGENT = 'qq-bridge-update-check';
const FIRST_DELAY_MS = 60 * 1000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const MANUAL_MIN_GAP_MS = 60 * 1000;
const TAGS_MAX_BYTES = 512 * 1024;
const CHANGELOG_MAX_BYTES = 256 * 1024;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** `.git/config` 文本 → `{ owner, repo }` 或 null（只认 github.com 的 https 与 git@github.com: 两种写法）。 */
export function parseGitConfigOrigin(text) {
  let inOrigin = false;
  let url = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = line.match(/^\[\s*([^\s\]"]+)(?:\s+"([^"]*)")?\s*\]$/);
    if (section) { inOrigin = section[1].toLowerCase() === 'remote' && section[2] === 'origin'; continue; }
    if (!inOrigin) continue;
    const kv = line.match(/^url\s*=\s*(.+)$/i);
    if (kv) { url = kv[1].trim().replace(/^"(.*)"$/, '$1'); break; }
  }
  return parseGithubUrl(url);
}

export function parseGithubUrl(url) {
  const u = String(url ?? '').trim();
  const m = u.match(/^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
    || u.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

/** `v1.2.3` / `v1.2.3-rc.1` → 可比较的对象；不是 v* 语义版本返回 null。也接受不带 v 的（package.json）。 */
export function parseSemver(tag) {
  const m = String(tag ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

export function compareSemver(a, b) {
  const x = typeof a === 'string' ? parseSemver(a) : a;
  const y = typeof b === 'string' ? parseSemver(b) : b;
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  // 没有预发布后缀的比有后缀的大（1.0.0 > 1.0.0-rc.1）
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : (x.pre.length ? -1 : 1);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i]; const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p); const qn = /^\d+$/.test(q);
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1; continue; }
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** tags 接口的响应 → 最大的 `v*` 语义版本标签名（没有返回 null）。 */
export function pickLatestTag(tags) {
  let best = null;
  for (const t of Array.isArray(tags) ? tags : []) {
    const name = typeof t?.name === 'string' ? t.name : '';
    if (!name.startsWith('v') || !parseSemver(name)) continue;
    if (!best || compareSemver(name, best) > 0) best = name;
  }
  return best;
}

/** 一节 CHANGELOG 正文 → 一行摘要（去掉 upgrade 代码块和 markdown 列表符号）。 */
export function summarizeBody(body, max = 200) {
  const text = String(body ?? '').replace(/```upgrade[\s\S]*?```/g, '');
  const lines = text.split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').replace(/^#+\s*/, '').trim())
    .filter((l) => l && !l.startsWith('```'));
  const joined = lines.join('；');
  return joined.length > max ? joined.slice(0, max - 1) + '…' : joined;
}

class CheckError extends Error {}

export function createUpdateCheck({
  root,
  stateDir = path.join(root, 'state'),
  readConfig = () => ({}),
  fetch: fetchImpl = null,
  now = Date.now,
  log = () => {},
  env = process.env,
  setTimeout: setTimer = setTimeout,
  setInterval: setRepeat = setInterval,
  timeoutMs = 10_000,
  // 测试可注入 `{ parseChangelog, collectNotes }`；缺省按需加载 scripts/lib/upgrade-notes.mjs（worker U）。
  notesLib = null,
} = {}) {
  // 两处都看：bridge 传进来的 env（harness 里是 VM 的 process 桩）和本进程真的环境变量。
  const disabledByEnv = () => String(env?.QQB_NO_UPDATE_CHECK ?? '') === '1' || process.env.QQB_NO_UPDATE_CHECK === '1';
  const disabledByConfig = () => {
    try { return readConfig()?.update?.check === false; } catch { return false; }
  };

  const result = { state: 'pending', latest: null, newer: false, notes: [], upgrade: null, checkedAt: null, error: null };
  let inflight = null;
  let lastAttemptAt = 0;
  let started = false;

  function currentVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      return typeof pkg?.version === 'string' ? pkg.version : null;
    } catch {
      return null;
    }
  }

  function remote() {
    try {
      return parseGitConfigOrigin(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8'));
    } catch {
      return null;
    }
  }

  function lastUpgrade() {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(stateDir, 'upgrade.json'), 'utf8'));
      const h = Array.isArray(doc?.history) ? doc.history : [];
      const last = h[h.length - 1];
      if (!last || typeof last !== 'object') return null;
      const pick = (k) => (typeof last[k] === 'string' ? last[k] : null);
      // 不回传备份路径（本机绝对路径，没必要进控制台页面）。
      return { at: pick('at'), from: pick('from'), to: pick('to'), result: pick('result') };
    } catch {
      return null;
    }
  }

  async function loadNotesLib() {
    if (notesLib) return notesLib;
    try {
      notesLib = await import('../scripts/lib/upgrade-notes.mjs');
    } catch {
      notesLib = { parseChangelog: () => [], collectNotes: () => ({ entries: [], upgrade: null }) };
    }
    return notesLib;
  }

  /** 只允许白名单主机 + https；超时、非 200、超过 maxBytes 都抛 CheckError。 */
  async function get(url, maxBytes) {
    let u;
    try { u = new URL(url); } catch { throw new CheckError('地址无效'); }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname) || u.port || u.username || u.password) {
      throw new CheckError('目标主机不在白名单');
    }
    if (typeof fetchImpl !== 'function') throw new CheckError('没有可用的 fetch');
    const controller = new AbortController();
    let timer = null;
    const timeout = new Promise((_, reject) => {
      // 不 unref：请求结束时 finally 里一定会清掉；unref 了反而可能在请求挂住时让进程提前退出。
      timer = setTimeout(() => { controller.abort(); reject(new CheckError('超时')); }, timeoutMs);
    });
    try {
      const res = await Promise.race([
        fetchImpl(u.href, {
          method: 'GET',
          redirect: 'error',
          signal: controller.signal,
          headers: { 'User-Agent': USER_AGENT, Accept: u.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'text/plain' },
        }),
        timeout,
      ]);
      if (!res || res.status !== 200) throw new CheckError(`HTTP ${res?.status ?? '?'}`);
      const declared = Number(res.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new CheckError('响应过大');
      const text = await Promise.race([readCapped(res, maxBytes), timeout]);
      return text;
    } catch (error) {
      if (error instanceof CheckError) throw error;
      throw new CheckError(error?.name === 'AbortError' ? '超时' : '网络错误');
    } finally {
      clearTimeout(timer);
    }
  }

  async function readCapped(res, maxBytes) {
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
    if (!reader) {
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new CheckError('响应过大');
      return text;
    }
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { try { await reader.cancel(); } catch {} throw new CheckError('响应过大'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function runCheck() {
    if (disabledByEnv() || disabledByConfig()) { result.state = 'off'; return; }
    const r = remote();
    if (!r) { Object.assign(result, { state: 'unknown-remote', latest: null, newer: false, notes: [], upgrade: null, error: null, checkedAt: new Date(now()).toISOString() }); return; }
    try {
      const tagsText = await get(`https://api.github.com/repos/${r.owner}/${r.repo}/tags?per_page=30`, TAGS_MAX_BYTES);
      let tags;
      try { tags = JSON.parse(tagsText); } catch { throw new CheckError('tags 响应不是 JSON'); }
      const latest = pickLatestTag(tags);
      const version = currentVersion();
      const newer = !!(latest && version && parseSemver(version) && compareSemver(latest, version) > 0);
      let notes = [];
      let upgrade = null;
      if (newer) {
        const changelog = await get(`https://raw.githubusercontent.com/${r.owner}/${r.repo}/${encodeURIComponent(latest)}/CHANGELOG.md`, CHANGELOG_MAX_BYTES);
        const lib = await loadNotesLib();
        const collected = lib.collectNotes(lib.parseChangelog(changelog), `v${version}`, latest) ?? {};
        const entries = Array.isArray(collected.entries) ? collected.entries : [];
        notes = entries.slice(0, 20).map((e) => ({
          version: String(e?.version ?? ''),
          date: e?.date ? String(e.date) : null,
          summary: summarizeBody(e?.body),
        }));
        upgrade = collected.upgrade ?? null;
      }
      Object.assign(result, { state: 'ok', latest, newer, notes, upgrade, error: null, checkedAt: new Date(now()).toISOString() });
    } catch (error) {
      const reason = error instanceof CheckError ? error.message : '检查失败';
      Object.assign(result, { state: 'error', error: reason, checkedAt: new Date(now()).toISOString() });
      try { log(`版本检查失败（不影响运行）：${reason}`); } catch {}
    }
  }

  /** 立即查一次；60 秒内重复调用不再发请求（返回 false）。 */
  async function checkNow() {
    if (disabledByEnv() || disabledByConfig()) { result.state = 'off'; return false; }
    if (inflight) { await inflight; return false; }
    const t = now();
    if (lastAttemptAt && t - lastAttemptAt < MANUAL_MIN_GAP_MS) return false;
    lastAttemptAt = t;
    inflight = runCheck().catch(() => {}).finally(() => { inflight = null; });
    await inflight;
    return true;
  }

  function start() {
    if (started) return;
    started = true;
    if (disabledByEnv()) { result.state = 'off'; return; }
    const tick = () => { checkNow().catch(() => {}); };
    const t1 = setTimer(tick, FIRST_DELAY_MS);
    t1?.unref?.();
    const t2 = setRepeat(tick, INTERVAL_MS);
    t2?.unref?.();
  }

  function status() {
    const off = disabledByEnv() || disabledByConfig();
    return {
      version: currentVersion(),
      state: off ? 'off' : result.state,
      latest: off ? null : result.latest,
      newer: off ? false : result.newer,
      notes: off ? [] : result.notes,
      upgrade: off ? null : result.upgrade,
      command: 'bash scripts/update.sh',
      checkedAt: off ? null : result.checkedAt,
      ...(result.error && !off && result.state === 'error' ? { error: result.error } : {}),
      lastUpgrade: lastUpgrade(),
    };
  }

  return { start, checkNow, status };
}
