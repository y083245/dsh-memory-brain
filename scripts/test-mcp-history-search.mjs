// 测试 qq_history_search 的新参数（keywords / mode）与工具描述：schema 形状 + 调用透传。
//
// 怎么把调用导向假服务：
//   `agentApiBase()` 读的是 config.json 的 consolePort（没有环境变量覆盖），而线上 3100
//   正被真实桥接占着，不能拿来断言请求体。所以这里把 MCP server 的三个源文件**复制**到
//   系统临时目录，配一份只写了 consolePort=<假服务端口> 的 config.json，再从临时目录拉起
//   server —— 跑的还是仓库里的真实代码，只是 ROOT 换了。不改 config.json、不起/不停线上服务。
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
    res.end(JSON.stringify({ ok: true, semantic: 'ok', count: 0, items: [], hint: '假服务' }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fakePort = server.address().port;

// ── 临时 ROOT：src/ + package.json + node_modules 软链 ───────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bridge-mcp-history-'));
fs.mkdirSync(path.join(tmp, 'src'));
for (const file of ['mcp-snowluma-safe.js', 'sensitive.js', 'qq-model-view.js']) {
  fs.copyFileSync(path.join(ROOT, 'src', file), path.join(tmp, 'src', file));
}
// 没有 package.json 的话 .js 会被当成 CJS，import 语法直接报错。
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'mcp-history-probe', private: true, type: 'module' }));
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ consolePort: fakePort }));

const entry = path.join(tmp, 'src', 'mcp-snowluma-safe.js');
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'mcp-history-test', version: '0.1.0' });

try {
  await client.connect(transport);
  console.log(`✅ MCP 连接成功（假桥接 http://127.0.0.1:${fakePort}）`);

  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === 'qq_history_search');
  console.log('\n[schema]');
  check('qq_history_search 已注册', !!tool);
  if (!tool) throw new Error('工具未注册，后面的断言无法继续');

  const schema = tool.inputSchema ?? {};
  const props = schema.properties ?? {};
  const desc = tool.description ?? '';

  check('keywords 是字符串数组', props.keywords?.type === 'array' && props.keywords?.items?.type === 'string',
    JSON.stringify(props.keywords));
  check('keywords 上限 12', props.keywords?.maxItems === 12, `maxItems=${props.keywords?.maxItems}`);
  check('mode 枚举 auto/keyword/semantic',
    JSON.stringify(props.mode?.enum) === JSON.stringify(['auto', 'keyword', 'semantic']),
    JSON.stringify(props.mode?.enum));
  for (const name of ['key', 'token', 'query', 'from', 'to', 'speaker', 'limit', 'context']) {
    check(`旧参数 ${name} 保留`, name in props);
  }
  check('query 描述是一句完整的话', /句子|自然语言/.test(props.query?.description ?? ''),
    props.query?.description);

  check('描述提到相对时间换算', desc.includes('换算'), desc.slice(0, 80));
  check('描述提到不编造', /不编造|别编/.test(desc));
  check('描述提到日期', desc.includes('日期'));
  check('描述提到 keywords', desc.includes('keywords'));
  check('描述说明只能查当前会话', desc.includes('当前会话'));
  // 相对日期不再要求模型自己算：提到时间必须填 from，可以直接写 今天/昨天/上周 等。
  check('描述要求提到时间必须填 from', /必须/.test(desc) && desc.includes('from'));
  check('描述允许直接写相对说法',
    ['今天', '昨天', '前天', '上周', '上个月'].every((w) => desc.includes(w)) && desc.includes('自动换算'));
  check('from 描述允许相对说法', /今天|昨天|前天|上周|上个月/.test(props.from?.description ?? '')
    && (props.from?.description ?? '').includes('换算'));
  check('to 描述允许相对说法', /今天|昨天|前天|上周|上个月/.test(props.to?.description ?? '')
    && (props.to?.description ?? '').includes('换算'));

  // ── 调用透传：keywords / mode / 日期 / 令牌头 ──────────────────────────
  console.log('\n[调用透传]');
  const args = {
    key: 'private:100000001',
    token: 'probe-invalid',
    query: '他上次说过要怎么帮我记住以前的事',
    keywords: ['记忆', '记住', '忘', '长期记忆'],
    from: '2026-10-20',
    to: '2026-10-26',
    mode: 'keyword'
  };
  const result = await client.callTool({ name: 'qq_history_search', arguments: args });
  check('调用未返回错误', result.isError !== true, result.content?.[0]?.text?.slice(0, 120));

  const req = seen.at(-1);
  check('打到 /api/socialV2/history-search', req?.url === '/api/socialV2/history-search', req?.url);
  check('body.keywords 原样透传', JSON.stringify(req?.body?.keywords) === JSON.stringify(args.keywords));
  check('body.mode 原样透传', req?.body?.mode === 'keyword', String(req?.body?.mode));
  check('body.query / from / to 透传',
    req?.body?.query === args.query && req?.body?.from === '2026-10-20' && req?.body?.to === '2026-10-26');
  check('body.token 透传', req?.body?.token === 'probe-invalid');
  check('请求头带 x-agent-token', req?.headers?.['x-agent-token'] === 'probe-invalid',
    String(req?.headers?.['x-agent-token']));
  check('请求头带 x-agent-call', req?.headers?.['x-agent-call'] === '1');

  // 旧调用（只给 query）仍要能用：不传 keywords/mode 时 body 里就是 undefined。
  const legacy = await client.callTool({
    name: 'qq_history_search',
    arguments: { key: 'private:100000001', token: 'probe-invalid', query: '旧调用' }
  });
  const legacyReq = seen.at(-1);
  check('旧调用兼容', legacy.isError !== true && legacyReq?.body?.query === '旧调用');
  check('旧调用不带 keywords/mode',
    legacyReq?.body?.keywords === undefined && legacyReq?.body?.mode === undefined);

  // 参数校验：13 个关键词应被 zod 拒绝（客户端可能直接抛 McpError，两种都算通过）。
  let rejected = false;
  try {
    const over = await client.callTool({
      name: 'qq_history_search',
      arguments: { key: 'private:100000001', token: 'probe-invalid', keywords: Array.from({ length: 13 }, (_, i) => `k${i}`) }
    });
    rejected = over.isError === true;
  } catch {
    rejected = true;
  }
  check('超过 12 个关键词被拒绝', rejected);
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
