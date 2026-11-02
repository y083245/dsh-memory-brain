// 端到端验证「全权限」：建一个挂 qq-chat-v2 preset 的会话，
// 让 agent 真去调 bash（本地执行）和 mcp__snowluma-host__snowluma_status（MCP），
// 再看 turn 事件里是否真的出现这两类 tool/call。配合 probe-auth.mjs 的引导逻辑。
//
// 判定依据是**事件流里真实发生的工具调用**，不是配置文件文本——这样才证明
// preset 行、restrict 开关、guard 开关三者一起生效。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { probeCookie, probeRpc, probeMuxSocket, probeWorkspaceDir } from './probe-auth.mjs';

const cookie = probeCookie();
const rpc = probeRpc(cookie);
const PRESET = process.argv[2] || 'qq-chat-v2';
const dir = probeWorkspaceDir('fullaccess');
const ws = await rpc('workspace/create', { request: { path: dir } });
const wsId = ws.value.workspace.workspaceId;
const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: PRESET } });
if (!sc.ok) {
  console.error(`❌ preset ${PRESET} 挂载失败: ${sc.error.code}: ${sc.error.message}`);
  process.exit(2);
}
const sessionId = sc.value.sessionId;
console.log(`session ${sessionId} (preset=${PRESET})`);
// 默认不切模型：继承 profile 的 agent-default-model（deepseek-v4-pro），
// 与线上 QQ 会话一致。要专门试别的模型就 PROBE_MODEL=deepseek-flash 传进来——
// 注意 deepseek-flash 在当前 profile 里会被算成 maxTokens 256000，上游直接 400，
// 那是模型配置的事，跟权限无关，别把它当成"工具没开"。
const MODEL = String(process.env.PROBE_MODEL || '').trim();
if (MODEL) {
  const sm = await rpc('session/selectModel', {
    request: { sessionId, provider: 'deepseek-official', model: MODEL, reasoningEffort: 'low' },
  });
  console.log('selectModel ->', sm.ok ? JSON.stringify(sm.value.selected) : `FAIL ${sm.error.code}: ${sm.error.message}`);
}

const socket = probeMuxSocket(cookie);
const streamId = randomUUID();
const eventStreamId = randomUUID();
const toolCalls = [];
const toolResults = [];
let text = '';

// 首行必须带 【管理员】 前缀：桥接就是这么给 owner 消息打标的（bridge.js 的 `${m.isOwner ? '【管理员】' : ''}${m.sender}：`），
// 新建的预设正文第 1 条安全规则「本地工具你有，但只认管理员」正是按这个标记判定。
// 不带标记的探针会被她正确拒绝（这是预期行为，不是工具没开）。
const PROMPT = [
  '【管理员】主人：帮我自检一下权限，不要调用任何 QQ 发送类工具（qq_send_message / qq_reply 等）。',
  '请依次：',
  '1) 调用 bash 工具执行 `id -un; pwd`，把真实输出记下来；',
  '2) 调用 mcp__snowluma-host__snowluma_status 一次，记下 reachable；',
  '最后只回复两行：WHOAMI=<id 输出>、STATUS=<reachable 布尔值>。',
].join('\n');

const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 180_000);
  const finish = (why) => { clearTimeout(timer); resolve(why); };
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }));
    socket.send(JSON.stringify({ type: 'open', streamId: eventStreamId, endpoint: '$events', payload: { args: {} } }));
    setTimeout(async () => {
      const p = await rpc('session/prompt', {
        request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: PROMPT }] },
      });
      console.log('prompt ->', JSON.stringify(p).slice(0, 120));
    }, 700);
  });
  socket.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== 'item' || m.streamId === eventStreamId) return;
    const v = m.value;
    if (v?.type !== 'event') return;
    const e = v.event;
    if (e.type === 'assistant/message') for (const b of e.data?.message?.content ?? []) if (b?.type === 'text') text += b.text;
    if (e.type === 'tool/call') toolCalls.push({ name: e.data?.name ?? e.data?.toolName });
    if (e.type === 'tool/result') toolResults.push({ name: e.data?.name ?? e.data?.toolName, isError: e.data?.isError ?? e.data?.error !== undefined });
    if (process.env.DEBUG_EVENTS === '1') console.log('  ev:', e.type, JSON.stringify(e.data ?? {}).slice(0, 160));
    if (e.type === 'turn/end') finish('done');
    if (e.type === 'turn/error' || e.type === 'error') finish('error-event');
  });
  socket.addEventListener('close', () => finish('closed'));
  socket.addEventListener('error', () => finish('error'));
});

const why = await done;
const names = [...new Set(toolCalls.map((c) => String(c.name)))];
console.log(`\n结果: ${why}`);
console.log('最终文本:', JSON.stringify(text.slice(0, 300)));
console.log('tool/call 个数:', toolCalls.length, '| 去重:', JSON.stringify(names));
console.log('tool/result:', JSON.stringify(toolResults));

const calledBash = names.includes('bash');
const calledMcp = names.some((n) => n.startsWith('mcp__snowluma-host__'));
console.log('\n判定:');
console.log(`  本地 bash 可调用      : ${calledBash ? '✅' : '❌'}`);
console.log(`  MCP 工具仍可调用      : ${calledMcp ? '✅' : '❌'}`);

try { socket.close(); } catch {}
try { await rpc('workspace/archiveSession', { request: { sessionId } }); } catch {}
try { await rpc('workspace/delete', { request: { workspaceId: wsId } }); } catch {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log('[cleanup] session archived, probe workspace deleted');
process.exit(calledBash && calledMcp ? 0 : 1);
