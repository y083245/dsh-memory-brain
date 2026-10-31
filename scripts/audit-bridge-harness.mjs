// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as mediaNormalize from '../src/media-normalize.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as stateAcl from '../src/state-acl.mjs';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';
// 本地新增模块（OWN_LIFE_PATCH / TTS_API_PATCH / LTM_PATCH）：bridge.js 的顶层 import 会被剥掉，必须在这里注入。
import { createOwnLife } from '../src/own-life.js';
// LIFE_LOOP_PATCH：生活回路（bridge.js 顶层 import，同样要注入）。
import { createLifeLoop } from '../src/life-loop.js';
import { createTtsApi, readJsonBody as readLargeJsonBody } from '../src/tts-api.js';
import { createLongMemory } from '../src/long-memory.js';
// RAG_PATCH：memory-rag 客户端 / 日期与关键词归一（bridge.js 顶层 import，同样要注入）。
import { createMemoryRagClient, normalizeDateRange, normalizeKeywords } from '../src/memory-rag-client.js';
// SUGGEST_PATCH：账本建议（bridge.js 顶层 import，同样要注入；坑 12）。
import { createLedgerSuggest } from '../src/ledger-suggest.js';
// PERSONA_PATCH：人格与情绪（bridge.js 顶层 import，同样要注入）。
import { createPersona } from '../src/persona.js';
// DECAY_PATCH：记忆代谢（遗忘曲线；bridge.js 顶层 import，同样要注入）。
import { createMemoryDecay } from '../src/memory-decay.js';
// REPORT_PATCH：每日报表（bridge.js 顶层 import，同样要注入；坑 12）。
// dayOf 也要注入：桥接用 W1 导出的 dayOf 判断「今天」，剥离 import 后必须由这里提供。
import { createDailyReport, isErrorLine, dayOf } from '../src/daily-report.js';
// APIHUB_PATCH：RAG 总开关与「API 管理」后端（bridge.js 顶层 import，同样要注入）。
// defaultRagExec 一定要换成下面的替身：真实现会调 `systemctl --user`，在这台机器上会停掉线上 RAG。
import { createRagControl } from '../src/rag-control.js';
import { createApiHub, readEmbeddingKind } from '../src/api-hub.js';
import * as dshCredentials from '../src/dsh-credentials.js';

// 硬性闸门：整个测试进程里禁止默认实现 spawn systemctl（rag-control 的第一行会检查它）。
process.env.QQB_NO_SYSTEMCTL = '1';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  // APIHUB_PATCH：凭据一律落在临时目录里 —— 测试**绝不能**读真的 ~/.dsh（那是用户的密钥文件）。
  // DSH_HOME 也是 D 的 dsh-credentials 与 web-search 的凭据兜底共同的口径。
  const dshHome = path.join(temp, 'dsh-home');
  fs.mkdirSync(dshHome, { recursive: true });
  const prevDshHome = process.env.DSH_HOME;
  const prevDeepseekKey = process.env.DEEPSEEK_API_KEY;
  process.env.DSH_HOME = dshHome;
  // 让「联网搜索实际用哪把」的判定不受开发机环境变量影响。
  delete process.env.DEEPSEEK_API_KEY;
  const testConfig = {
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  };
  // APIHUB_PATCH：以前所有夹具都只写 memoryRag.url（那时没有总开关）；新语义下缺省 = 关，
  // 这些用例会整批失效。harness 代表「已经配好并启用」的部署：memoryRag 存在但没写 enabled 时补 true。
  // 要测「关着」的用例显式传 memoryRag: { enabled: false }。
  if (testConfig.memoryRag && typeof testConfig.memoryRag === 'object' && testConfig.memoryRag.enabled === undefined) {
    testConfig.memoryRag = { ...testConfig.memoryRag, enabled: true };
  }
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify(testConfig));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外状态文件（用于测试"启动时读到损坏/旧版文件"这类路径）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], faces: [], http: [], ragExec: [] };
  // APIHUB_PATCH：rag-control 的默认 execFile 会调真的 systemctl；测试里只记录调用、一律回成功。
  // 默认按「装了 systemd 单元」处理（`systemctl --user cat` 退出码 0），要测 nohup / script 模式
  // 的用例可以改 globals.defaultRagExec 覆盖。
  const fakeRagExec = async (cmd, args = []) => {
    calls.ragExec.push([cmd, ...args]);
    return { code: 0, stdout: '', stderr: '' };
  };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    // fetch_custom_face_detail：同步收藏表情的 HTTP 兜底路径要拿到**数组**（WS 失败时用）。
    if (action === 'fetch_custom_face_detail') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: [{ emoji_id: 'http-fixture-sticker', resId: 'http-fixture-sticker', url: 'https://public.invalid/http-sticker', md5: 'AABBCCDDEEFF00112233445566778899', desc: 'HTTP 兜底表情' }]
        })
      };
    }
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    // settings.describe 的默认桩：没有 qq-mode 命名空间 ⇒ refreshMode() 回退到本地 mode.json。
    // 测试可覆盖它来验证「DSH 设置里的空 ownerQQ 不得覆盖 config.json」等契约。
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async fetchFaceEntity(id) { calls.faces.push(id); return null; }
    async request(action, params = {}) {
      // 群成员列表：v2 读工具 qq_get_group_members 会用到（含 WS 不可用时的 HTTP 兜底路径）。
      if (action === 'get_group_member_list') {
        return {
          status: 'ok', retcode: 0,
          data: [
            { user_id: 111, nickname: '小明', card: '小明', role: 'member' },
            { user_id: 222, nickname: '路人', card: '' },
            { user_id: 123, nickname: '管理员', card: '群主', role: 'owner' }
          ]
        };
      }
      return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] };
    }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2, socialV2,
    syncStickerLibrary, listStickersForV2, getStickerImageData,
    refreshMode, modeAllowed, trackTurnEvent, replayPendingWakeReasonsV2,
    collectors, setupSleepTimerV2,
    getInitialPrompt, setInitialPrompt, loadInitialPrompts, formatInitialPromptV2,
    initialPrompts, initialPromptMaxChars,
    extractMediaFromSegments, segmentsToText, fetchOneBotImage, fetchMediaData, resolveMediaList,
    emojiCdnCandidates, getImageDimensions, acceptImageBuffer, MAX_MEDIA_BYTES, bot,
    isConversationBusyV2, v2TurnStartAt, turnLeaseNoted, TURN_BUSY_LEASE_MS,
    settingFromDshNamespace, selfIdentityTextV2, buildWakeReminderPromptV2,
    getMode() { return currentMode; },
    // LIFE_LOOP_PATCH：测试要直接拿到实例，调 snapshot() / tick()（harness 的 setInterval 是桩，定时器不会跑）。
    getOwnLife() { return ownLife; },
    getLifeLoop() { return lifeLoop; },
    // DECAY_PATCH：测试要直接拿到遗忘模块实例（看 snapshot、或确认它有没有创建失败）。
    getDecay() { return decay; },
    // APIHUB_PATCH：RAG 开关与 API 管理实例（验证创建成功、或接口确实经过它们）。
    getRagControl() { return ragControl; },
    getApiHub() { return apiHub; },
    // REPORT_PATCH：测试要直接拿到报表实例（计数、快照），并验证创建失败时是 null。
    getDailyReport() { return dailyReport; },
    // SUGGEST_PATCH：账本建议实例（验证候选 / 计次 / 采用；创建失败时是 null）。
    getLedgerSuggest() { return ledgerSuggest; },
    setSelfIdentity(display, id) {
      selfDisplayName = String(display ?? '');
      selfUserId = String(id ?? '');
      selfNickname = selfDisplayName.toLowerCase() || 'deepseek';
    },
    flushQueue, retireSession,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    // APIHUB_PATCH：QQB_RUN_DIR 指到临时目录 —— rag-control 会读 embed.log 的最后一条提示，
    // 测试绝不能去读线上的 ~/.ai-companion-run。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: { QQB_RUN_DIR: path.join(temp, 'run') }, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    createOwnLife, createTtsApi, readLargeJsonBody, createLongMemory,
    createLifeLoop,
    createMemoryRagClient, normalizeDateRange, normalizeKeywords,
    createLedgerSuggest,
    createPersona,
    createMemoryDecay,
    createDailyReport, isErrorLine, dayOf,
    // APIHUB_PATCH：RAG 开关 / API 管理 / DSH 凭据（bridge.js 顶层 import；默认 execFile 换替身）。
    createRagControl, defaultRagExec: fakeRagExec, createApiHub, readEmbeddingKind, dshCredentials,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl, ...presetPrompt,
    // 桥接的出图出口会调归一化（体积/动图抽帧）：VM 里必须能拿到这几个函数。
    normalizeImageForModel: mediaNormalize.normalizeImageForModel,
    sniffImage: mediaNormalize.sniffImage,
    planNormalization: mediaNormalize.planNormalization,
    planAnimation: mediaNormalize.planAnimation,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData, describeAge }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    // APIHUB_PATCH：还原测试进程里被临时改过的环境变量。
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    if (prevDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevDeepseekKey;
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
