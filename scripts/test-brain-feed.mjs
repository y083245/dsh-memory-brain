// 实时脑图（BRAIN_PATCH）：事件总线 brain-feed.js 的单元测试。
//
// 不起桥接、不联网、不碰真实 state/：轨迹写到 /tmp 下的临时目录（或干脆不给 stateDir），
// SSE 用假的 req / res（EventEmitter + 记录 write）。
//
// 覆盖：emit 不抛（含 data 函数抛错）；没连接时 data 函数不被调用；环形缓冲上限与 Last-Event-ID 补发；
// 第 5 个连接 429；?key= 过滤；drop 删缓冲；关开关断开连接；包装器对返回值 / 异常 / this / 调用次数透明。
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrainFeed, toolRegion, cleanNodes } from '../src/brain-feed.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-brain-feed-'));
const newStateDir = () => fs.mkdtempSync(path.join(tmpRoot, 's-'));

/** 假的 SSE 连接：记录写出去的内容，能触发 close。 */
function fakeConn() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.status = null;
  res.headers = null;
  res.chunks = [];
  res.ended = false;
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.write = (text) => { res.chunks.push(String(text)); return true; };
  res.end = (text) => { if (text) res.chunks.push(String(text)); res.ended = true; };
  res.text = () => res.chunks.join('');
  /** 解析出所有 event: brain 的 data。 */
  res.events = () => res.text().split('\n\n')
    .filter((b) => b.includes('event: brain'))
    .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
  res.drops = () => res.text().split('\n\n')
    .filter((b) => b.includes('event: drop'))
    .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
  return { req, res };
}

await test('emit 不抛：data 函数抛错 / 奇怪参数 / isEnabled 抛错都只返回', async () => {
  const logs = [];
  const feed = createBrainFeed({ log: (m) => logs.push(m) });
  const { req, res } = fakeConn();
  feed.handleEvents(req, res);
  assert.doesNotThrow(() => feed.emit('search', { key: 'private:1', data: () => { throw new Error('boom'); } }));
  assert.doesNotThrow(() => feed.emit('search', null));
  assert.doesNotThrow(() => feed.emit('nope', {}));
  assert.doesNotThrow(() => feed.emit());
  const ev = res.events();
  assert.equal(ev.length, 2, '两条合法类型的事件都发出去了');
  assert.deepEqual(ev[0].data, {}, 'data 函数抛错 → 空对象');
  assert.ok(logs.some((l) => l.includes('组装 search 载荷')), '告警一次');
  feed.closeAll();
  const bad = createBrainFeed({ isEnabled: () => { throw new Error('x'); } });
  assert.equal(bad.emit('search', {}), null, 'isEnabled 抛错按关处理');
});

await test('没有页面连着：data 函数一次都不调用，只有编号（轨迹）', async () => {
  const stateDir = newStateDir();
  const feed = createBrainFeed({ stateDir });
  let called = 0;
  const id = feed.emit('remember', { key: 'private:1', nodes: ['ltm:a1'], data: () => { called++; return { text: '原文' }; } });
  assert.ok(Number.isInteger(id) && id >= 1);
  assert.equal(called, 0);
  assert.equal(feed.active(), false);
  assert.equal(feed.bufferedEvents().length, 0, '没页面时不进环形缓冲');
  const files = fs.readdirSync(path.join(stateDir, 'brain', 'trace'));
  assert.equal(files.length, 1);
  assert.ok(!fs.readFileSync(path.join(stateDir, 'brain', 'trace', files[0]), 'utf8').includes('原文'));
});

await test('hello / retry / 事件格式与 id 单调递增', async () => {
  const feed = createBrainFeed();
  const { req, res } = fakeConn();
  feed.emit('wake', { key: 'private:1' }); // 连上之前发的：不补发（没带 Last-Event-ID）
  feed.handleEvents(req, res, { headers: { 'X-Frame-Options': 'DENY' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.equal(res.headers['Cache-Control'], 'no-cache, no-transform');
  assert.equal(res.headers['X-Accel-Buffering'], 'no');
  assert.equal(res.headers['X-Frame-Options'], 'DENY', '带上控制台安全头');
  assert.ok(res.text().startsWith('retry: 3000\n\n'));
  assert.ok(res.text().includes('event: hello\ndata: {"enabled":true,"lastId":1}\n\n'));
  feed.emit('search', { key: 'private:1', origin: 'ai', nodes: ['chunk:c1', 'bad id!'], data: { query: '查一下' } });
  feed.emit('tool', { key: 'private:1', origin: 'ai', tool: 'qq_get_message_images', data: { name: 'qq_get_message_images', ok: true } });
  const ev = res.events();
  assert.equal(ev.length, 2);
  assert.equal(ev[0].id, 2);
  assert.equal(ev[1].id, 3);
  assert.equal(ev[0].region, 'core');
  assert.equal(ev[1].region, 'vision');
  assert.deepEqual(ev[0].nodes, ['chunk:c1'], '非法编号被丢');
  assert.equal(ev[0].origin, 'ai');
  assert.equal(typeof ev[0].at, 'number');
  assert.ok(res.text().includes('id: 2\nevent: brain\ndata: '));
  feed.closeAll();
});

await test('原文截到 300 字、已知令牌被 redact 掉', async () => {
  const feed = createBrainFeed({ redact: (s) => s.replaceAll('SECRET-TOKEN', '[令牌]') });
  const { req, res } = fakeConn();
  feed.handleEvents(req, res);
  feed.emit('msg.in', { key: 'private:1', data: { text: 'x'.repeat(500), name: '带 SECRET-TOKEN 的' } });
  const [ev] = res.events();
  assert.equal([...ev.data.text].length, 300);
  assert.equal(ev.data.name, '带 [令牌] 的');
  feed.closeAll();
});

await test('环形缓冲上限 + Last-Event-ID 补发（只补更新的、按 key 过滤）', async () => {
  const feed = createBrainFeed({ bufferSize: 5 });
  const first = fakeConn();
  feed.handleEvents(first.req, first.res);
  for (let i = 0; i < 8; i += 1) feed.emit('recall', { key: i % 2 ? 'private:1' : 'private:2', data: { query: `q${i}` } });
  const buf = feed.bufferedEvents();
  assert.equal(buf.length, 5, '缓冲最多 bufferSize 条');
  assert.deepEqual(buf.map((e) => e.id), [4, 5, 6, 7, 8]);
  const second = fakeConn();
  feed.handleEvents(second.req, second.res, { lastEventId: '5' });
  assert.deepEqual(second.res.events().map((e) => e.id), [6, 7, 8]);
  const third = fakeConn();
  feed.handleEvents(third.req, third.res, { lastEventId: '0', key: 'private:1' });
  assert.deepEqual(third.res.events().map((e) => e.id), [4, 6, 8], '?key= 只补这个会话');
  feed.closeAll();
});

await test('同时最多 4 个连接，第 5 个回 429；关掉一个后又能连', async () => {
  const feed = createBrainFeed({ maxClients: 4 });
  const conns = [];
  for (let i = 0; i < 4; i += 1) { const c = fakeConn(); feed.handleEvents(c.req, c.res); conns.push(c); }
  const fifth = fakeConn();
  feed.handleEvents(fifth.req, fifth.res);
  assert.equal(fifth.res.status, 429);
  assert.equal(fifth.res.ended, true);
  assert.equal(feed.clients(), 4);
  conns[0].req.emit('close');
  assert.equal(feed.clients(), 3, '连接关闭后清理客户端表');
  const sixth = fakeConn();
  feed.handleEvents(sixth.req, sixth.res);
  assert.equal(sixth.res.status, 200);
  feed.closeAll();
  assert.equal(feed.clients(), 0);
});

await test('?key= 过滤：只推这个会话，key:null 的事件照推', async () => {
  const feed = createBrainFeed();
  const c = fakeConn();
  feed.handleEvents(c.req, c.res, { key: 'group:456' });
  feed.emit('msg.in', { key: 'group:456', data: { text: 'a' } });
  feed.emit('msg.in', { key: 'private:1', data: { text: 'b' } });
  feed.emit('persona.nightly', { key: null, data: { changes: {} } });
  assert.deepEqual(c.res.events().map((e) => e.type), ['msg.in', 'persona.nightly']);
  assert.equal(c.res.events()[0].data.text, 'a');
  feed.closeAll();
});

await test('drop：从缓冲删含编号的事件；reload 时删该会话的 msg.* / search / persona.appraisal，并通知页面', async () => {
  const feed = createBrainFeed();
  const c = fakeConn();
  feed.handleEvents(c.req, c.res);
  feed.emit('remember', { key: 'private:1', nodes: ['ltm:x1'], data: { text: '要删的' } });
  feed.emit('remember', { key: 'private:1', nodes: ['ltm:x2'], data: { text: '留着的' } });
  feed.emit('msg.in', { key: 'private:1', nodes: ['msg:9'], data: { text: '会话 1' } });
  feed.emit('search', { key: 'private:1', data: {} });
  feed.emit('msg.in', { key: 'private:2', nodes: ['msg:10'], data: { text: '会话 2' } });
  feed.emit('wake', { key: 'private:1', data: {} });
  feed.drop({ nodes: ['ltm:x1'] });
  assert.ok(!feed.bufferedEvents().some((e) => e.nodes.includes('ltm:x1')));
  assert.equal(feed.bufferedEvents().length, 5);
  feed.drop({ nodes: [], key: 'private:1', reload: true });
  assert.deepEqual(feed.bufferedEvents().map((e) => `${e.type}@${e.key}`), ['remember@private:1', 'msg.in@private:2', 'wake@private:1']);
  const drops = c.res.drops();
  assert.deepEqual(drops[0], { nodes: ['ltm:x1'], key: null, reload: false });
  assert.deepEqual(drops[1], { nodes: [], key: 'private:1', reload: true });
  // 新连接带 Last-Event-ID=0 也补不出被删的原文
  const late = fakeConn();
  feed.handleEvents(late.req, late.res, { lastEventId: '0' });
  assert.ok(!late.res.text().includes('要删的'));
  assert.ok(!late.res.text().includes('会话 1'));
  feed.closeAll();
});

await test('关开关：心跳发现关了就断开；closeAll 立刻断开；关着时 emit 什么都不做', async () => {
  let on = true;
  const stateDir = newStateDir();
  const feed = createBrainFeed({ isEnabled: () => on, pingMs: 20, stateDir });
  const c = fakeConn();
  feed.handleEvents(c.req, c.res);
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(c.res.text().includes(': ping\n\n'), '心跳');
  on = false;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(c.res.ended, true, '开关关掉后断开');
  assert.equal(feed.clients(), 0);
  assert.equal(feed.emit('search', { key: 'private:1', nodes: ['chunk:c'] }), null);
  assert.equal(fs.existsSync(path.join(stateDir, 'brain', 'trace')), false, '关着时不写轨迹');
  on = true;
  const d = fakeConn();
  feed.handleEvents(d.req, d.res);
  feed.closeAll();
  assert.equal(d.res.ended, true);
});

// ── 包装器透明性 ───────────────────────────────────────────────────────────
function makeFakeLtm() {
  const calls = [];
  const self = {
    tag: 'fake-ltm',
    archive(key, row) { calls.push(['archive', this.tag]); return undefined; },
    remember(args) {
      calls.push(['remember', this.tag]);
      if (args.cat === 'bad') throw new Error('类别只能是：trait / fact');
      return { item: { id: 'n1', cat: args.cat, text: args.text }, duplicate: false, replaced: null };
    },
    update(args) { calls.push(['update', this.tag]); if (!args.itemId) throw new TypeError('找不到'); return { id: args.itemId, cat: 'fact', text: '改过的' }; },
    forget(args) { calls.push(['forget', this.tag]); return { id: args.itemId, cat: 'fact', text: '删掉的' }; },
    deleteArchiveRows(key, opts) { calls.push(['deleteArchiveRows', this.tag]); return { matched: 2, deleted: opts?.dryRun ? 0 : 2, skipped: 0 }; },
    similarItems() { return [{ id: 'old1' }]; },
    personView() { return { name: '小明' }; }
  };
  return { self, calls };
}

await test('tapLtm：返回值 / 异常 / this / 调用次数与改动前完全一样', async () => {
  const plain = makeFakeLtm();
  const tapped = makeFakeLtm();
  const feed = createBrainFeed();
  const c = fakeConn();
  feed.handleEvents(c.req, c.res);
  const same = feed.tapLtm(tapped.self);
  assert.equal(same, tapped.self, '返回同一个对象');
  feed.tapLtm(tapped.self); // 包两次不会叠两层

  const run = (o) => {
    const out = [];
    out.push(o.archive('private:1', { dir: 'in', text: '你好', msgId: 7 }));
    out.push(o.remember({ userId: '1', cat: 'fact', text: '喜欢猫', sourceKey: 'private:1', replaces: undefined }));
    try { o.remember({ userId: '1', cat: 'bad', text: 'x' }); } catch (e) { out.push(['threw', e.constructor.name, e.message]); }
    out.push(o.update({ userId: '1', itemId: 'n1', viewerKey: 'private:1', outdated: true }));
    try { o.update({ userId: '1' }); } catch (e) { out.push(['threw', e.constructor.name, e.message]); }
    out.push(o.forget({ userId: '1', itemId: 'n1', viewerKey: 'private:1' }));
    out.push(o.deleteArchiveRows('private:1', { dryRun: true }));
    out.push(o.deleteArchiveRows('private:1', { rows: [] }));
    return out;
  };
  assert.deepEqual(run(tapped.self), run(plain.self));
  assert.deepEqual(tapped.calls, plain.calls, '每个方法调用次数一样、this 一样');
  // 产生的事件
  const ev = c.res.events();
  assert.deepEqual(ev.map((e) => e.type), ['msg.in', 'remember', 'update', 'forget']);
  assert.deepEqual(ev[0].nodes, ['msg:7']);
  assert.equal(ev[1].origin, 'ai', '带 replaces 参数 = AI 通道');
  assert.deepEqual(ev[1].data.similar, ['ltm:old1']);
  assert.equal(ev[1].data.name, '小明');
  assert.equal(ev[2].data.outdated, true);
  assert.equal(ev[3].data.node, 'ltm:n1');
  const drops = c.res.drops();
  assert.deepEqual(drops[0], { nodes: ['ltm:n1'], key: null, reload: false }, 'forget 先删缓冲里的旧事件');
  assert.deepEqual(drops[1], { nodes: [], key: 'private:1', reload: true }, '真删存档 → reload；dryRun 不发');
  assert.equal(drops.length, 2);
  feed.closeAll();
});

await test('tapLtm：挂点自己出错（personView 抛）不影响返回值', async () => {
  const t = makeFakeLtm();
  t.self.personView = () => { throw new Error('坏了'); };
  t.self.similarItems = () => { throw new Error('坏了'); };
  const feed = createBrainFeed();
  const c = fakeConn();
  feed.handleEvents(c.req, c.res);
  feed.tapLtm(t.self);
  const r = t.self.remember({ userId: '1', cat: 'fact', text: '喜欢猫', sourceKey: 'private:1' });
  assert.equal(r.item.id, 'n1');
  assert.equal(c.res.events()[0].origin, 'console', '不带 replaces 参数 = 控制台');
  feed.closeAll();
});

await test('tapDecay：review / drop 返回值与异常透明；记下 before / after', async () => {
  const mk = () => {
    const calls = [];
    return {
      calls,
      self: {
        freezeBelow: 0.5,
        state(id) { calls.push('state'); return { R: 0.7, S: 3 }; },
        review(id, meta, rating) {
          calls.push('review');
          if (rating === 'boom') throw new RangeError('评分不对');
          if (rating === 'hard') return false;
          return { R: 1, S: 9 };
        },
        drop(id) { calls.push('drop'); return id === 'ltm:a'; }
      }
    };
  };
  const plain = mk();
  const tapped = mk();
  const feed = createBrainFeed();
  const c = fakeConn();
  feed.handleEvents(c.req, c.res);
  assert.equal(feed.tapDecay(tapped.self), tapped.self);
  const run = (o) => {
    const out = [o.review('ltm:a', {}, 'good'), o.review('ltm:a', {}, 'hard')];
    try { o.review('ltm:a', {}, 'boom'); } catch (e) { out.push(['threw', e.constructor.name, e.message]); }
    out.push(o.drop('ltm:a'), o.drop('ltm:b'));
    return out;
  };
  assert.deepEqual(run(tapped.self), run(plain.self));
  assert.equal(tapped.calls.filter((x) => x === 'review').length, plain.calls.filter((x) => x === 'review').length);
  assert.equal(tapped.calls.filter((x) => x === 'drop').length, 2);
  const ev = c.res.events();
  assert.equal(ev.length, 1, '只有真的复习成功才发');
  assert.deepEqual(ev[0].data, { unit: 'ltm:a', rating: 'good', before: { R: 0.7, S: 3 }, after: { R: 1, S: 9 } });
  feed.closeAll();
});

await test('toolRegion / cleanNodes', async () => {
  assert.equal(toolRegion('qq_get_message_images'), 'vision');
  assert.equal(toolRegion('qq_send_sticker'), 'vision');
  assert.equal(toolRegion('qq_tts_voice'), 'audio');
  assert.equal(toolRegion('send_voice'), 'audio');
  assert.equal(toolRegion('qq_memory_add'), 'working');
  assert.equal(toolRegion('qq_send_message'), 'output');
  const many = Array.from({ length: 80 }, (_, i) => `ltm:i${i}`);
  assert.equal(cleanNodes(many).length, 50);
  assert.deepEqual(cleanNodes(['ltm:a', 'ltm:a', 'xx:b', 'ltm:含中文', 5]), ['ltm:a']);
});

await test('decayCurve：366 个点、R 单调不增；没有复习记录 R0=1；豁免的不冻结', async () => {
  const feed = createBrainFeed();
  const item = { id: 'a1', cat: 'note', text: 'x', at: new Date().toISOString() };
  const r = feed.decayCurve({ unit: 'ltm:a1', findLtm: () => ({ item, userId: '1' }) });
  assert.equal(r.points.length, 366);
  assert.equal(r.R0, 1);
  assert.equal(r.points[0].R, 1);
  for (let i = 1; i < r.points.length; i += 1) assert.ok(r.points[i].R <= r.points[i - 1].R);
  assert.ok(Number.isInteger(r.frozenAtDay) && r.frozenAtDay > 0);
  const core = feed.decayCurve({ unit: 'ltm:a1', findLtm: () => ({ item: { ...item, core: true }, userId: '1' }) });
  assert.equal(core.exempt, true);
  assert.equal(core.frozenAtDay, null);
  assert.equal(feed.decayCurve({ unit: 'ltm:zz', findLtm: () => null }), null);
  assert.equal(feed.decayCurve({ unit: 'bogus' }), null);
  assert.equal(feed.decayCurve({ unit: 'diary:1762070400000' }).points.length, 366);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部通过');
