#!/usr/bin/env node
// BRAIN_PATCH：实时脑图页面的静态检查 + 演示服务器接口检查（+ 可选的无头浏览器检查）。
//
// 只碰本仓库的 public/brain.html、public/console.html 和自己起的演示服务器（127.0.0.1:18000～18999），
// 不连任何线上端口、不读 state/。截图放 /tmp/worker-C/。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAIN = fs.readFileSync(path.join(ROOT, 'public', 'brain.html'), 'utf8');
const CONSOLE = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
const SHOT_DIR = '/tmp/worker-C';

let bad = 0, skipped = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
  else { bad++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const skip = (name, why) => { skipped++; console.log(`  SKIP ${name} — ${why}`); };

// ------------------------------------------------------------ 1. 语法
console.log('## 内联脚本语法（vm.Script）');
function scriptsOf(html) { return [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => ({ attrs: m[1] || '', code: m[2] })); }
for (const [name, html] of [['brain.html', BRAIN], ['console.html', CONSOLE]]) {
  const list = scriptsOf(html).filter((s) => !/\bsrc=/.test(s.attrs));
  ok(list.length > 0, `${name} 有内联脚本`, `${list.length} 段`);
  list.forEach((s, i) => {
    try { new vm.Script(s.code, { filename: `${name}#${i}` }); ok(true, `${name} 第 ${i + 1} 段可编译`, `${s.code.length} 字符`); }
    catch (e) { ok(false, `${name} 第 ${i + 1} 段可编译`, e.message); }
  });
}

// ------------------------------------------------------------ 2. 安全：外部资源、eval、innerHTML
console.log('## brain.html 安全约束');
const EXT = [
  [/<link\b[^>]*href\s*=\s*["']?\s*(https?:)?\/\//i, '<link href> 外部地址'],
  [/<script\b[^>]*\bsrc\s*=/i, '<script src>'],
  [/@import/i, '@import'],
  [/url\(\s*["']?\s*(https?:)?\/\//i, 'url(外部)'],
  [/<(img|iframe|audio|video|source|object|embed)\b[^>]*\bsrc\s*=\s*["']?\s*(https?:)?\/\//i, '外部媒体'],
];
for (const [re, what] of EXT) ok(!re.test(BRAIN), `没有 ${what}`);
ok(!/https?:\/\//i.test(BRAIN), '整页不出现 http:// / https://（连字符串都没有）');
ok(!/fonts\.googleapis|fonts\.gstatic/i.test(BRAIN), '不引 Google Fonts');
ok(!/\beval\s*\(/.test(BRAIN), '没有 eval(');
ok(!/new\s+Function\b/.test(BRAIN), '没有 new Function');
ok(!/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write/.test(BRAIN), '不用 innerHTML / outerHTML / insertAdjacentHTML / document.write');
ok(/setTimeout\(\s*['"`]/.test(BRAIN) === false, 'setTimeout 不传字符串');
ok(/<meta name="viewport"/.test(BRAIN), '有 viewport（手机宽度）');

console.log('## brain.html 接口契约（约定 §4、§5.3）');
for (const p of ['/api/brain/snapshot', '/api/brain/events', '/api/brain/chunk', '/api/brain/probe', '/api/brain/replay', '/api/brain/decay-curve', '/api/brain/control']) ok(BRAIN.includes(p), `调用 ${p}`);
ok(/'x-console-token'/.test(BRAIN), 'fetch 带 x-console-token 头');
ok(/history\.replaceState/.test(BRAIN) && /qs\.delete\('token'\)/.test(BRAIN), '加载后从地址栏去掉 token');
ok(/new EventSource\(/.test(BRAIN), '用 EventSource');
for (const evn of ['hello', 'brain', 'drop']) ok(new RegExp(`addEventListener\\('${evn}'`).test(BRAIN), `处理 SSE 事件 ${evn}`);
ok(/令牌无效，请从控制台打开/.test(BRAIN), '401/403 整页提示');
ok(/实时脑图已关闭，可在控制台「API 管理」页打开/.test(BRAIN), '404 整页提示');
ok(/已断开，重连中/.test(BRAIN), '断线提示');
ok(/太快了，2 秒后再试/.test(BRAIN), 'probe 429 提示');
ok(/语义检索不可用，已用关键词/.test(BRAIN), 'probe 关键词降级提示');
ok(/已删除或不可用/.test(BRAIN), 'chunk 404 提示');
ok(/另有 \$\{tr\} 条未显示/.test(BRAIN), 'truncated 提示');
ok(/MAX_ANIM_PER_SEC = 10/.test(BRAIN), '动画限速每秒 10 个');
ok(/MAX_ROWS = 500/.test(BRAIN), '面板最多 500 行');
const regionIds = ['input', 'vision', 'audio', 'working', 'hippo', 'graph', 'ltm', 'core', 'decay', 'limbic', 'life', 'output', 'introspect'];
const regs = [...BRAIN.matchAll(/^\{id:'([a-z]+)',name:/gm)].map((m) => m[1]);
ok(JSON.stringify(regs) === JSON.stringify(regionIds), '13 个脑区编号与约定 §3 一致', regs.join(','));
const types = ['msg.in', 'msg.out', 'wake', 'inject', 'search', 'recall', 'remember', 'update', 'forget', 'decay.review', 'recall.auto', 'life.ownLife', 'life.recall', 'life.assoc', 'life.promiseDue', 'suggest.shown', 'suggest.adopted', 'persona.appraisal', 'persona.nightly', 'rag.index', 'rag.distill', 'tool'];
const missingType = types.filter((t) => !BRAIN.includes(`'${t}':`) || !BRAIN.includes(`case '${t}'`));
ok(missingType.length === 0, '约定 §4.2 的每种事件都有中文名和处理分支', missingType.join(',') || `${types.length} 种`);

console.log('## console.html 入口与开关');
ok(/id="navBrainBtn"/.test(CONSOLE) && !/id="navBrainBtn"[^>]*data-view/.test(CONSOLE), '导航有「实时脑图」入口（不带 data-view，不影响视图切换）');
ok(/window\.open\('\/brain'/.test(CONSOLE) && /localStorage\.getItem\('consoleToken'\)/.test(CONSOLE), '入口用当前控制台令牌开新标签页');
ok(/<section id="section-api-brain" data-page="api"/.test(CONSOLE), '「API 管理」页有实时脑图卡片');
ok(/api\('\/api\/brain\/control'\)/.test(CONSOLE) && /apiHubPost\('\/api\/brain\/control'/.test(CONSOLE), '卡片 GET / POST /api/brain/control');
ok(/页面会显示真实聊天原文，只在本机访问/.test(CONSOLE), '卡片说明文字');
const ids = [...CONSOLE.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
ok(dups.length === 0, 'console.html ID 唯一', dups.join(',') || `${ids.length} 个`);
const bids = [...BRAIN.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const bdups = [...new Set(bids.filter((v, i) => bids.indexOf(v) !== i))];
ok(bdups.length === 0, 'brain.html ID 唯一', bdups.join(',') || `${bids.length} 个`);

// ------------------------------------------------------------ 3. 演示服务器
console.log('## 演示服务器（scripts/brain-demo-server.mjs）');
async function freePort() {
  for (let i = 0; i < 40; i++) {
    const p = 18000 + Math.floor(Math.random() * 1000);
    const free = await new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(p, '127.0.0.1', () => s.close(() => resolve(true))); });
    if (free) return p;
  }
  throw new Error('18000～18999 找不到空闲端口');
}
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const TOK = 'demo-token';
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'brain-demo-server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
let childErr = '';
child.stderr.on('data', (d) => { childErr += d; });
const killChild = () => { try { child.kill('SIGTERM'); } catch {} };
process.on('exit', killChild);
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('演示服务器 5 秒内没起来：' + childErr)), 5000);
  child.stdout.on('data', (d) => { if (String(d).includes('brain demo')) { clearTimeout(t); resolve(); } });
  child.on('exit', (c) => { clearTimeout(t); reject(new Error('演示服务器退出 ' + c + '：' + childErr)); });
});
const H = { 'x-console-token': TOK };
const get = (p, h = H) => fetch(BASE + p, { headers: h });
const post = (p, body, h = H) => fetch(BASE + p, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify(body) });

try {
  let r = await get('/brain');
  const html = await r.text();
  ok(r.status === 200 && /text\/html/.test(r.headers.get('content-type') || '') && html.includes('实时脑图'), 'GET /brain 200');
  ok(/default-src 'self'/.test(r.headers.get('content-security-policy') || ''), '/brain 带控制台同款 CSP');
  r = await get('/brain?token=' + TOK, {});
  ok(r.status === 200, '?token= 也能鉴权');
  r = await get('/brain', { 'x-console-token': 'nope' });
  ok(r.status === 401, '错令牌 401');
  r = await get('/api/brain/snapshot', {});
  ok(r.status === 401, '不带令牌 401');

  r = await get('/api/brain/snapshot');
  const s = await r.json();
  ok(r.status === 200 && s.ok === true && typeof s.at === 'number', '快照 ok / at');
  ok(['ok', 'off', 'unavailable'].includes(s.rag), '快照 rag 取值');
  ok(Array.isArray(s.keys) && s.keys.length === 3 && s.keys.every((k) => /^(private|group):\d{1,15}$/.test(k.key) && ['private', 'group'].includes(k.kind) && typeof k.label === 'string'), '快照 keys 形状', `${s.keys?.length}`);
  ok(Array.isArray(s.nodes) && s.nodes.every((n) => /^(ltm|chunk|sum|ent|note|diary|msg|persona):[A-Za-z0-9:_.\-]{1,80}$/.test(n.id) && typeof n.kind === 'string' && 'key' in n && typeof n.at === 'number' && typeof n.label === 'string' && n.label.length <= 40), '快照 nodes：编号正则 / kind / key / at / label≤40');
  const byKind = {}; for (const n of s.nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
  ok(byKind.ltm >= 25 && byKind.chunk === 60 && byKind.sum === 55 && byKind.ent === 40 && byKind.note === 8 && byKind.diary === 5 && byKind.persona >= 1, '合成数据规模', JSON.stringify(byKind));
  const ltm = s.nodes.filter((n) => n.kind === 'ltm');
  ok(['trait', 'fact', 'event', 'pending', 'note'].every((c) => ltm.some((n) => n.cat === c)), '账本 5 类都有');
  ok(ltm.some((n) => n.core) && ltm.some((n) => n.outdatedAt) && ltm.some((n) => n.decay && n.decay.frozen), '有核心 / 已过时 / 已冻结的条目');
  ok(ltm.every((n) => ['text', 'cat', 'userId', 'name', 'scope', 'core', 'due', 'status', 'archivedAt', 'outdatedAt', 'decay'].every((k) => k in n)), 'ltm 字段齐全（约定 §5.4）');
  ok(s.nodes.filter((n) => n.kind === 'chunk').every((n) => !('text' in n) && Array.isArray(n.speakers) && 'n_msgs' in n), 'chunk 不带原文');
  ok(s.nodes.filter((n) => n.kind === 'sum').every((n) => /^chunk:/.test(n.chunk) && 'summary' in n && 'importance' in n && 'valence' in n), 'sum 字段');
  ok(s.nodes.filter((n) => n.kind === 'note').every((n) => ['pending', 'shown', 'adopted', 'dismissed', 'expired'].includes(n.state) && 'whoName' in n), 'note 字段');
  ok(Array.isArray(s.links) && s.links.every((l) => typeof l.src === 'string' && typeof l.dst === 'string' && ['sum-chunk', 'sum-ent', 'rel', 'note-sum'].includes(l.kind)), 'links 形状');
  ok(s.links.filter((l) => l.kind === 'rel').length >= 40 && s.links.filter((l) => l.kind === 'rel').every((l) => typeof l.relation === 'string'), '关系约 50 条且带 relation');
  ok(s.regions && regionIds.every((id) => typeof s.regions[id] === 'number'), 'regions 13 个计数');
  ok(s.truncated && ['chunk', 'sum', 'ent', 'note', 'ltm', 'diary'].every((k) => typeof s.truncated[k] === 'number'), 'truncated 形状');
  ok(s.freezeBelow === 0.5, 'freezeBelow');
  r = await get('/api/brain/snapshot?key=private:100000001');
  const s1 = await r.json();
  ok(s1.ok && s1.nodes.every((n) => n.key === null || n.key === 'private:100000001'), '?key= 只给这个会话（和 key:null 的）');

  // SSE
  const ac = new AbortController();
  r = await fetch(BASE + '/api/brain/events?token=' + TOK, { signal: ac.signal });
  ok(r.status === 200 && /text\/event-stream/.test(r.headers.get('content-type') || ''), 'SSE 200 text/event-stream');
  ok(/no-cache/.test(r.headers.get('cache-control') || '') && r.headers.get('x-accel-buffering') === 'no', 'SSE 响应头');
  const reader = r.body.getReader();
  let buf = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !/event: brain\n/.test(buf)) { const { value, done } = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res({ value: null }), 4000))]); if (done) break; if (value) buf += new TextDecoder().decode(value); }
  ok(buf.startsWith('retry: 3000\n\n'), 'SSE 先写 retry: 3000');
  ok(/event: hello\ndata: \{"enabled":true,"lastId":\d+\}\n\n/.test(buf), 'SSE hello');
  const m = buf.match(/id: (\d+)\nevent: brain\ndata: (.*)\n\n/);
  let ev = null; try { ev = m && JSON.parse(m[2]); } catch {}
  ok(ev && ev.id === Number(m[1]) && typeof ev.at === 'number' && typeof ev.type === 'string' && ['ai', 'bridge', 'console'].includes(ev.origin) && typeof ev.region === 'string' && Array.isArray(ev.nodes) && ev.data && typeof ev.data === 'object', 'SSE brain 事件形状', ev ? ev.type : '没收到');
  ac.abort();

  // probe 限流
  r = await post('/api/brain/probe', { key: 'private:100000001', query: '看海' });
  const pr = await r.json();
  ok(r.status === 200 && pr.ok && ['rag', 'keyword'].includes(pr.source) && Array.isArray(pr.items) && Array.isArray(pr.ranked) && typeof pr.routes === 'object', 'probe 形状');
  r = await post('/api/brain/probe', { key: 'private:100000001', query: '看海' });
  ok(r.status === 429, 'probe 2 秒内第二次 429');

  // chunk
  r = await post('/api/brain/chunk', { node: 'chunk:c0000', key: 'private:100000001' });
  const ch = await r.json();
  ok(r.status === 200 && ch.ok && typeof ch.text === 'string' && ch.node === 'chunk:c0000', 'chunk 200 带原文');
  r = await post('/api/brain/chunk', { node: 'chunk:c0013', key: 'private:100000002' });
  ok(r.status === 404, 'chunk 固定编号 404');

  // replay
  const pad = (n) => String(n).padStart(2, '0');
  const dstr = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const today = new Date(); today.setHours(12, 0, 0, 0);
  r = await get('/api/brain/replay?day=' + dstr(today.getTime()));
  const rp = await r.json();
  ok(r.status === 200 && rp.ok && rp.events.length >= 100 && rp.events.every((e, i) => e.id === `r${i + 1}` && e.replay === true && typeof e.at === 'number') && rp.events.every((e, i, a) => !i || a[i - 1].at <= e.at), 'replay 今天：约 150 条、编号 r<n>、按时间升序', `${rp.events?.length}`);
  ok(rp.events.some((e) => e.data && e.data.deleted === true), 'replay 里有 data.deleted');
  r = await get('/api/brain/replay?day=' + dstr(today.getTime() - 2 * 86400000));
  const rp2 = await r.json();
  ok(rp2.partial === true && rp2.notes.length > 0, 'replay 固定日期 partial + notes');
  r = await get('/api/brain/replay?day=' + dstr(today.getTime() - 7 * 86400000));
  ok(r.status === 400, 'replay 超出 7 天 400');

  // decay-curve
  r = await get('/api/brain/decay-curve?unit=' + encodeURIComponent(ltm[1].id));
  const dc = await r.json();
  ok(r.status === 200 && dc.ok && dc.points.length === 366 && dc.points[365].day === 365 && 'frozenAtDay' in dc && typeof dc.freezeBelow === 'number', 'decay-curve 366 个点');

  // 开关
  r = await post('/api/brain/control', { enabled: false });
  ok((await r.json()).enabled === false, '关开关');
  ok((await get('/brain')).status === 404, '关了之后 /brain 404');
  ok((await get('/api/brain/snapshot')).status === 404, '关了之后 snapshot 404');
  const ctl = await get('/api/brain/control');
  ok(ctl.status === 200 && (await ctl.json()).enabled === false, '关了之后 control 仍可读');
  r = await post('/api/brain/control', { enabled: true });
  ok((await r.json()).enabled === true && (await get('/brain')).status === 200, '再打开');
} catch (e) {
  ok(false, '演示服务器接口检查', e.stack || e.message);
}

// ------------------------------------------------------------ 4. 可选：无头浏览器
console.log('## 无头浏览器（可选）');
// 本机装了全局 playwright 时用 PLAYWRIGHT_DIR 指过去（如 ~/.npm-global/lib/node_modules/playwright）；不设就跳过。
const PW = process.env.PLAYWRIGHT_DIR || '';
if (!PW || !fs.existsSync(PW)) skip('Playwright', PW ? `${PW} 不存在` : '没设 PLAYWRIGHT_DIR');
else {
  let browser = null;
  try {
    const { chromium } = createRequire(import.meta.url)(PW);
    browser = await chromium.launch({ headless: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    for (const [w, h] of [[1280, 800], [375, 812]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      // 检索演示故意连点两次测 429，浏览器会在控制台记一行资源错误，那条是预期的
      page.on('console', (m) => { if (m.type() === 'error' && !/status of 429/.test(m.text())) errors.push(m.text()); });
      page.on('request', (q) => { if (!q.url().startsWith(BASE)) errors.push('外部请求 ' + q.url()); });
      await page.goto(`${BASE}/brain?token=${TOK}`);
      await page.waitForFunction(() => document.querySelectorAll('#evlist li').length > 0, null, { timeout: 12000 });
      ok(!(await page.evaluate(() => location.search.includes('token'))), `${w}px 地址栏里的 token 已去掉`);
      const rows = await page.evaluate(() => document.querySelectorAll('#evlist li').length);
      ok(rows > 0, `${w}px 收到事件后「实时」有行`, `${rows} 行`);
      const scroll = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: innerWidth }));
      ok(scroll.sw <= scroll.iw && scroll.bw <= scroll.iw, `${w}px 无横向滚动`, JSON.stringify(scroll));
      ok(await page.evaluate(() => /光点 \d+/.test(document.getElementById('stats').textContent)), `${w}px 快照已画出`);
      await page.screenshot({ path: `${SHOT_DIR}/brain-${w}.png` });
      if (w === 1280) {
        // 大量事件：让演示服务器一次推 200 条，页面不报错、帧还在走、行数封顶 500 内
        const ac2 = new AbortController();
        fetch(`${BASE}/api/brain/events?token=${TOK}&burst=1`, { signal: ac2.signal }).catch(() => {});
        await page.waitForTimeout(2500);
        ac2.abort();
        const after = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res({ fps: n, rows: document.querySelectorAll('#evlist li').length }); }; requestAnimationFrame(f); }));
        ok(after.rows >= 150 && after.rows <= 500, '突发 200 条：面板收下且封顶 500', `${after.rows} 行`);
        ok(after.fps >= 10, '突发后动画仍在走', `${after.fps} 帧/秒`);
        // 点一行：定位光点并展开
        await page.click('#evlist li:first-child .evrow');
        ok(await page.evaluate(() => !!document.querySelector('#evlist .full')), '点一行展开完整内容');
        // 检索演示
        await page.click('#tab-btn-recall');
        await page.fill('#pq', '看海');
        await page.waitForTimeout(2100);
        await page.click('#prun');
        await page.waitForFunction(() => document.querySelectorAll('#presult .hit').length > 0 || /太快了/.test(document.getElementById('presult').textContent), null, { timeout: 5000 });
        ok(await page.evaluate(() => document.querySelectorAll('#presult .hit').length > 0), '检索演示出结果');
        await page.click('#prun');
        await page.waitForFunction(() => /太快了/.test(document.getElementById('presult').textContent), null, { timeout: 4000 }).catch(() => {});
        ok(await page.evaluate(() => /太快了，2 秒后再试/.test(document.getElementById('presult').textContent)), '检索演示 429 提示');
        await page.screenshot({ path: `${SHOT_DIR}/brain-1280-probe.png` });
        // 回放
        await page.click('#tab-btn-live');
        await page.click('#replayBtn');
        await page.click('#replayLoad');
        await page.waitForFunction(() => !document.getElementById('timeline').hidden, null, { timeout: 5000 });
        ok(await page.evaluate(() => /回放中 · \d\d-\d\d/.test(document.getElementById('modePill').textContent)), '回放：顶部标「回放中 · 日期」');
        await page.click('#tlNext'); await page.click('#tlNext');
        ok(await page.evaluate(() => document.querySelectorAll('#evlist li').length === 2), '回放：「下一条」逐条放');
        await page.selectOption('#tlSpeed', '60'); await page.click('#tlPlay'); await page.waitForTimeout(1500);
        await page.screenshot({ path: `${SHOT_DIR}/brain-1280-replay.png` });
        const partDay = await page.evaluate(() => { const t = new Date(); t.setHours(12, 0, 0, 0); const d = new Date(t.getTime() - 2 * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
        await page.selectOption('#replayDay', partDay); await page.click('#replayLoad');
        await page.waitForFunction(() => !document.getElementById('partPill').hidden, null, { timeout: 5000 }).catch(() => {});
        ok(await page.evaluate(() => !document.getElementById('partPill').hidden && document.querySelectorAll('#replayNotes li').length > 0), '回放：partial 标「部分」并列出 notes');
        await page.click('#tlExit');
        ok(await page.evaluate(() => document.getElementById('timeline').hidden && document.querySelectorAll('#evlist li').length > 0), '退出回放：时间轴收起、实时行补回');
        // 详情 + 时间推演：选一条账本
        const picked = await page.evaluate(() => { const b = [...document.querySelectorAll('#evlist .evrow')].find((x) => /记下|翻账本|想起|改账本|忽然想起/.test(x.textContent)); if (b) b.click(); return !!b; });
        if (picked) {
          await page.click('#tab-btn-time');
          await page.waitForFunction(() => !!document.getElementById('curve') || /删除|失败|点一条/.test(document.getElementById('timeBody').textContent), null, { timeout: 4000 }).catch(() => {});
          const tb = await page.evaluate(() => document.getElementById('timeBody').textContent);
          ok(/第 \d+ 天|不会淡忘|一年内不会|点一条/.test(tb), '时间推演出结果', tb.slice(0, 40));
          await page.screenshot({ path: `${SHOT_DIR}/brain-1280-time.png` });
        } else skip('时间推演', '列表里暂时没有账本事件');
      } else {
        await page.click('#foldBtn');
        const sc2 = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
        ok(sc2, '375px 折叠面板后仍无横向滚动');
        await page.screenshot({ path: `${SHOT_DIR}/brain-375-folded.png` });
      }
      ok(errors.length === 0, `${w}px 没有 JS 报错 / 外部请求`, errors.slice(0, 3).join(' | '));
      await page.close();
    }
    // 错令牌 / 关开关的整页提示
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${BASE}/brain?token=${TOK}`);
    await page.waitForFunction(() => /光点 \d+/.test(document.getElementById('stats').textContent), null, { timeout: 8000 });
    await post('/api/brain/control', { enabled: false });
    await page.waitForFunction(() => !document.getElementById('fatal').hidden, null, { timeout: 12000 }).catch(() => {});
    ok(await page.evaluate(() => /实时脑图已关闭/.test(document.getElementById('fatal').textContent) && !document.getElementById('fatal').hidden), '开关关掉后已打开的页面整页提示「已关闭」');
    await post('/api/brain/control', { enabled: true });
    // 接口回 401（控制台令牌被换掉）：拦下快照请求模拟，应整页提示「令牌无效」
    const p2 = await browser.newPage();
    await p2.route('**/api/brain/snapshot*', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false}' }));
    await p2.goto(`${BASE}/brain?token=${TOK}`);
    await p2.waitForFunction(() => !document.getElementById('fatal').hidden, null, { timeout: 6000 }).catch(() => {});
    ok(await p2.evaluate(() => /令牌无效，请从控制台打开/.test(document.getElementById('fatal').textContent) && !document.getElementById('fatal').hidden), '接口 401 时整页提示「令牌无效」');
    await p2.close(); await page.close();
  } catch (e) {
    ok(false, '无头浏览器检查', e.stack || e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

killChild();
console.log(bad === 0 ? `\n全部通过${skipped ? `（跳过 ${skipped} 项）` : ''}` : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
