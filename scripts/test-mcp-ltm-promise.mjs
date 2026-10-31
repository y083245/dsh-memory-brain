// 测试 qq_ltm_remember / qq_ltm_update 的新参数（子项目 3 v1 · 规格 §4.7，任务 A）：
// schema 形状、工具描述里的新句子、调用时请求体透传、旧调用兼容。
//
// 做法与 test-mcp-history-search.mjs 一致：把 MCP server 的源文件**复制**到系统临时目录，
// 配一份只写 consolePort=<假服务端口> 的 config.json，从临时目录拉起真代码 ——
// 线上 3100 的桥接不受影响，也不碰仓库里的 config.json。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(label, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail ? ` | ${detail}` : ''}`);
  }
}

// ── 假桥接服务：记录收到的请求 ───────────────────────────────────────────
const seen = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(raw); } catch {}
    seen.push({ url: req.url, method: req.method, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, item: { id: 'a1b2c3d4' } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fakePort = server.address().port;

// ── 临时 ROOT：src/ + package.json + node_modules 软链 ───────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-mcp-ltm-'));
fs.mkdirSync(path.join(tmp, 'src'));
for (const file of ['mcp-snowluma-safe.js', 'sensitive.js', 'qq-model-view.js']) {
  fs.copyFileSync(path.join(ROOT, 'src', file), path.join(tmp, 'src', file));
}
// 没有 package.json 的话 .js 会被当成 CJS，import 语法直接报错。
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'mcp-ltm-probe', private: true, type: 'module' }));
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ consolePort: fakePort }));

const entry = path.join(tmp, 'src', 'mcp-snowluma-safe.js');
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'mcp-ltm-test', version: '0.1.0' });

try {
  await client.connect(transport);
  console.log(`✅ MCP 连接成功（假桥接 http://127.0.0.1:${fakePort}）`);

  const { tools } = await client.listTools();
  const remember = tools.find((t) => t.name === 'qq_ltm_remember');
  const update = tools.find((t) => t.name === 'qq_ltm_update');
  check('qq_ltm_remember 已注册', !!remember);
  check('qq_ltm_update 已注册', !!update);
  if (!remember || !update) throw new Error('工具未注册，后面的断言无法继续');

  // ── schema：qq_ltm_remember ────────────────────────────────────────────
  console.log('\n[schema · qq_ltm_remember]');
  const rProps = remember.inputSchema?.properties ?? {};
  const rDesc = remember.description ?? '';
  check('due 是可选字符串', rProps.due?.type === 'string', JSON.stringify(rProps.due));
  check('by 枚举 me / them', JSON.stringify(rProps.by?.enum) === JSON.stringify(['me', 'them']),
    JSON.stringify(rProps.by?.enum));
  check('core 是布尔', rProps.core?.type === 'boolean', JSON.stringify(rProps.core));
  for (const name of ['key', 'token', 'userId', 'name', 'category', 'content', 'scope']) {
    check(`旧参数 ${name} 保留`, name in rProps);
  }
  check('due 描述含换算提示与「到期当天你会被提醒」',
    /换算/.test(rProps.due?.description ?? '') && (rProps.due?.description ?? '').includes('到期当天你会被提醒'),
    rProps.due?.description);
  check('by 描述说明 me / them', (rProps.by?.description ?? '').includes('me=你答应的')
    && (rProps.by?.description ?? '').includes('them=对方答应的'), rProps.by?.description);
  check('core 描述含「最多 8 条」', (rProps.core?.description ?? '').includes('8 条'), rProps.core?.description);
  check('工具描述末尾追加「约定类记得填 due 和 by。」', rDesc.endsWith('约定类记得填 due 和 by。'),
    rDesc.slice(-40));

  // ── schema：qq_ltm_update ──────────────────────────────────────────────
  console.log('\n[schema · qq_ltm_update]');
  const uProps = update.inputSchema?.properties ?? {};
  const uDesc = update.description ?? '';
  check('due 是可选字符串', uProps.due?.type === 'string', JSON.stringify(uProps.due));
  // by 必须允许空串：描述里写了「传空字符串清除」，枚举里没有空串的话模型照做会被 zod 整个拒掉
  check('by 枚举 me / them / 空串（可清除）',
    JSON.stringify(uProps.by?.enum) === JSON.stringify(['me', 'them', '']),
    JSON.stringify(uProps.by?.enum));
  check('status 枚举 open/done/missed/cancelled',
    JSON.stringify(uProps.status?.enum) === JSON.stringify(['open', 'done', 'missed', 'cancelled']),
    JSON.stringify(uProps.status?.enum));
  check('core 是布尔', uProps.core?.type === 'boolean', JSON.stringify(uProps.core));
  check('archived 是布尔', uProps.archived?.type === 'boolean', JSON.stringify(uProps.archived));
  for (const name of ['key', 'token', 'userId', 'itemId', 'content', 'category', 'scope']) {
    check(`旧参数 ${name} 保留`, name in uProps);
  }
  check('due 描述加了「传空字符串清除」', (uProps.due?.description ?? '').includes('传空字符串清除'),
    uProps.due?.description);
  check('工具描述追加了约定结果说明',
    uDesc.includes('兑现了 status=done') && uDesc.includes('没兑现 status=missed')
      && uDesc.includes('不做了 status=cancelled') && uDesc.includes('没确认前别标'), uDesc.slice(-60));

  // ── 调用透传：qq_ltm_remember ──────────────────────────────────────────
  console.log('\n[调用透传 · qq_ltm_remember]');
  const rArgs = {
    key: 'private:100000001',
    token: 'probe-invalid',
    userId: '100000001',
    name: '主人',
    category: 'pending',
    content: '周末一起看电影',
    due: '周五',
    by: 'them',
    core: true
  };
  const rRes = await client.callTool({ name: 'qq_ltm_remember', arguments: rArgs });
  check('调用未返回错误', rRes.isError !== true, rRes.content?.[0]?.text?.slice(0, 120));
  const rReq = seen.at(-1);
  check('打到 /api/socialV2/ltm-remember', rReq?.url === '/api/socialV2/ltm-remember', rReq?.url);
  check('body.due / by / core 原样透传',
    rReq?.body?.due === '周五' && rReq?.body?.by === 'them' && rReq?.body?.core === true,
    JSON.stringify(rReq?.body));
  check('旧字段仍透传', rReq?.body?.category === 'pending' && rReq?.body?.content === '周末一起看电影');
  check('body.token / 请求头透传',
    rReq?.body?.token === 'probe-invalid' && rReq?.headers?.['x-agent-token'] === 'probe-invalid');

  const rLegacy = await client.callTool({
    name: 'qq_ltm_remember',
    arguments: { key: 'private:100000001', token: 'probe-invalid', category: 'fact', content: '他养了一只猫' }
  });
  const rLegacyReq = seen.at(-1);
  check('旧调用兼容', rLegacy.isError !== true && rLegacyReq?.body?.content === '他养了一只猫');
  check('旧调用不带新字段',
    rLegacyReq?.body?.due === undefined && rLegacyReq?.body?.by === undefined && rLegacyReq?.body?.core === undefined);

  // ── 调用透传：qq_ltm_update ────────────────────────────────────────────
  console.log('\n[调用透传 · qq_ltm_update]');
  const uArgs = {
    key: 'private:100000001',
    token: 'probe-invalid',
    userId: '100000001',
    itemId: 'a1b2c3d4',
    due: '2026-11-03',
    by: 'me',
    status: 'done',
    core: false,
    archived: true
  };
  const uRes = await client.callTool({ name: 'qq_ltm_update', arguments: uArgs });
  check('调用未返回错误', uRes.isError !== true, uRes.content?.[0]?.text?.slice(0, 120));
  const uReq = seen.at(-1);
  check('打到 /api/socialV2/ltm-update', uReq?.url === '/api/socialV2/ltm-update', uReq?.url);
  check('body 五个新字段原样透传',
    uReq?.body?.due === '2026-11-03' && uReq?.body?.by === 'me' && uReq?.body?.status === 'done'
      && uReq?.body?.core === false && uReq?.body?.archived === true,
    JSON.stringify(uReq?.body));
  check('itemId 仍透传', uReq?.body?.itemId === 'a1b2c3d4');

  const uLegacy = await client.callTool({
    name: 'qq_ltm_update',
    arguments: { key: 'private:100000001', token: 'probe-invalid', itemId: 'a1b2c3d4', content: '改了内容' }
  });
  const uLegacyReq = seen.at(-1);
  check('旧调用兼容', uLegacy.isError !== true && uLegacyReq?.body?.content === '改了内容');
  check('旧调用不带新字段',
    ['due', 'by', 'status', 'core', 'archived'].every((k) => uLegacyReq?.body?.[k] === undefined),
    JSON.stringify(uLegacyReq?.body));

  // ── 参数校验 ───────────────────────────────────────────────────────────
  console.log('\n[参数校验]');
  let rejected = false;
  try {
    const bad = await client.callTool({
      name: 'qq_ltm_update',
      arguments: { key: 'private:100000001', token: 'probe-invalid', itemId: 'a1b2c3d4', status: 'nope' }
    });
    rejected = bad.isError === true;
  } catch {
    rejected = true;
  }
  check('非法 status 被拒绝', rejected);

  let rejectedBy = false;
  try {
    const bad = await client.callTool({
      name: 'qq_ltm_remember',
      arguments: { key: 'private:100000001', token: 'probe-invalid', category: 'pending', content: 'x', by: 'other' }
    });
    rejectedBy = bad.isError === true;
  } catch {
    rejectedBy = true;
  }
  check('非法 by 被拒绝', rejectedBy);

  // by: '' 在 update 里是「清除」，必须能调通；在 remember 里没有意义，要被拒绝。
  console.log('\n[by 空串：update 清除 / remember 拒绝]');
  const clearRes = await client.callTool({
    name: 'qq_ltm_update',
    arguments: { key: 'private:100000001', token: 'probe-invalid', itemId: 'a1b2c3d4', by: '' }
  });
  const clearReq = seen.at(-1);
  check('update 传 by 空串能调通', clearRes.isError !== true, clearRes.content?.[0]?.text?.slice(0, 120));
  check("update 请求体 by === ''", clearReq?.body?.by === '', JSON.stringify(clearReq?.body));

  let rejectedEmpty = false;
  try {
    const bad = await client.callTool({
      name: 'qq_ltm_remember',
      arguments: { key: 'private:100000001', token: 'probe-invalid', category: 'pending', content: 'x', by: '' }
    });
    rejectedEmpty = bad.isError === true;
  } catch {
    rejectedEmpty = true;
  }
  check('remember 传 by 空串被拒绝', rejectedEmpty);
} catch (error) {
  fail += 1;
  console.error('❌ 测试失败:', error?.message ?? error);
} finally {
  try { await client.close(); } catch {}
  try { server.close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
