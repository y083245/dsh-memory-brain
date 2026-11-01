// RAG 进程管理器接口 —— Linux 走 systemd / 脚本，Windows 走 PID 文件。
//
// rag-control.js 只关心「当前状态 / 启动 / 停止 / 重启 / 单元是否安装」，具体怎么起由
// 这里决定。这样 Linux 的 systemd 行为可以逐条保持不变，Windows 不需要假装有 systemd。
import path from 'node:path';
import {
  EMBEDDING_UNIT,
  MEMORY_RAG_UNIT,
  STEP
} from './rag-constants.js';
import { resolveOrchestratorPaths } from './runtime/paths.mjs';
import {
  EMBED_PID,
  RAG_PID,
  embeddingReady,
  startEmbeddingService,
  startMemoryRagService,
  stopRagService,
  stopRagServices,
  ragPidStatus
} from './runtime/rag-services.mjs';

const STOP_TIMEOUT_MS = 60000;
const SCRIPT_TIMEOUT_MS = 180000;

function pad2(n) { return String(n).padStart(2, '0'); }
function localStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/**
 * Linux：装了 systemd 用户服务就用 systemctl；没装就调 start-all.sh / stop-all.sh。
 * 这段逻辑从 rag-control.js 原样搬过来，命令序列、超时、`--no-block` 都不改。
 */
export function createLinuxRagManager({
  root,
  runDir,
  execFile,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = () => {}
} = {}) {
  let modeCache = null; // 'systemd' | 'script'
  let systemdRunCache = null;

  async function run(cmd, args = [], opts = {}) {
    try {
      const result = await execFile(cmd, args, opts);
      if (!result || typeof result !== 'object') return { code: 1, stdout: '', stderr: '' };
      return { code: Number(result.code) || 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    } catch {
      return { code: 1, stdout: '', stderr: '' };
    }
  }

  async function detectMode() {
    if (modeCache) return modeCache;
    const r = await run('systemctl', ['--user', 'cat', MEMORY_RAG_UNIT]);
    modeCache = r.code === 0 ? 'systemd' : 'script';
    return modeCache;
  }

  async function hasSystemdRun() {
    if (systemdRunCache !== null) return systemdRunCache;
    const r = await run('systemd-run', ['--version']);
    systemdRunCache = r.code === 0;
    return systemdRunCache;
  }

  /** 单元是否在跑；script 模式没有单元：memory-rag 看健康、embedding 看 :8091。 */
  async function status(unit, health, mode = null) {
    const resolvedMode = mode ?? await detectMode();
    if (resolvedMode === 'systemd') {
      const r = await run('systemctl', ['--user', 'is-active', unit]);
      const state = String(r.stdout ?? '').trim();
      return { active: r.code === 0, state };
    }
    if (unit === MEMORY_RAG_UNIT) return { active: !!health, state: health ? 'active' : '' };
    return { active: await embeddingReady({ fetchImpl }), state: '' };
  }

  async function installed(unit) {
    const name = unit === EMBEDDING_UNIT ? EMBEDDING_UNIT : MEMORY_RAG_UNIT;
    const r = await run('systemctl', ['--user', 'cat', name]);
    return r.code === 0;
  }

  async function runScript(name) {
    const script = path.join(root, name);
    const args = ['--rag'];
    if (await hasSystemdRun()) {
      // 套一层 scope：拉起的进程不落在桥接自己的 cgroup 里，桥接重启时不会被带走（坑 21）。
      const unit = `qqb-rag-${localStamp(now())}`;
      return run('systemd-run', ['--user', '--scope', '--collect', `--unit=${unit}`, script, ...args], { timeout: SCRIPT_TIMEOUT_MS });
    }
    return run(script, args, { timeout: SCRIPT_TIMEOUT_MS });
  }

  async function start({ managed, onStep = () => {} } = {}) {
    const mode = await detectMode();
    if (mode === 'script') {
      onStep(STEP.startRag);
      await runScript('start-all.sh');
      onStep(STEP.wait);
      return;
    }
    if (managed) {
      onStep(STEP.startEmbedding);
      await run('systemctl', ['--user', 'reset-failed', EMBEDDING_UNIT]);
      // ExecCondition 不满足时单元会自己回到 inactive（不报错），继续起 memory-rag，
      // 状态最终由 state() 判成 partial —— 这正是规格 §3.2 第 3 条。
      // `--no-block`：qq-embedding 的 ExecStartPost 要等模型加载完（最长约 150 秒）。
      await run('systemctl', ['--user', '--no-block', 'start', EMBEDDING_UNIT]);
    }
    onStep(STEP.startRag);
    await run('systemctl', ['--user', 'reset-failed', MEMORY_RAG_UNIT]);
    await run('systemctl', ['--user', '--no-block', 'start', MEMORY_RAG_UNIT]);
    onStep(STEP.wait);
  }

  async function stop({ managed, onStep = () => {} } = {}) {
    const mode = await detectMode();
    onStep(STEP.stop);
    if (mode === 'script') {
      await runScript('stop-all.sh');
      return;
    }
    // 停要阻塞（脚本退出后 state() 才能读到真实状态），所以只放宽超时，不加 --no-block。
    await run('systemctl', ['--user', 'stop', MEMORY_RAG_UNIT], { timeout: STOP_TIMEOUT_MS });
    // 「自己部署的本地服务」/ 云端模式不碰 qq-embedding（§3.2 关闭第 3 条）。
    if (managed) await run('systemctl', ['--user', 'stop', EMBEDDING_UNIT], { timeout: STOP_TIMEOUT_MS });
  }

  async function restart({ beforeManaged, afterManaged, onStep = () => {} } = {}) {
    const mode = await detectMode();
    if (mode === 'script') {
      onStep(STEP.stop);
      await runScript('stop-all.sh');
      onStep(STEP.startRag);
      await runScript('start-all.sh');
      onStep(STEP.wait);
      return;
    }
    if (afterManaged && !beforeManaged) {
      onStep(STEP.startEmbedding);
      await run('systemctl', ['--user', 'reset-failed', EMBEDDING_UNIT]);
      await run('systemctl', ['--user', '--no-block', 'start', EMBEDDING_UNIT]);
    } else if (!afterManaged && beforeManaged) {
      onStep(STEP.stop);
      await run('systemctl', ['--user', 'stop', EMBEDDING_UNIT], { timeout: STOP_TIMEOUT_MS });
    }
    onStep(STEP.startRag);
    await run('systemctl', ['--user', 'reset-failed', MEMORY_RAG_UNIT]);
    // restart 也加 `--no-block`，就绪由 rag-control 的 waitHealthy() 判断。
    await run('systemctl', ['--user', '--no-block', 'restart', MEMORY_RAG_UNIT]);
    onStep(STEP.wait);
  }

  return {
    platform: 'linux',
    mode: detectMode,
    detectMode,
    status,
    installed,
    start,
    stop,
    restart,
    runScript
  };
}

/**
 * Windows：没有 systemd。embedding / memory-rag 由 detached spawn 启动，PID 写进
 * runDir/*.pid；停止时按 PID 杀整棵子进程树。
 */
export function createWindowsRagManager({
  root,
  runDir,
  paths,
  platform = 'win32',
  log = () => {},
  deps = {}
} = {}) {
  const p = paths ?? resolveOrchestratorPaths({ root, platform: 'win32' });
  const spawnOpts = {
    runDir,
    embedBin: p.embedBin,
    embedModel: p.embedModel,
    ragDir: p.ragDir,
    python: p.ragPython,
    platform,
    log,
    deps
  };
  const asStep = (onStep) => (typeof onStep === 'function' ? onStep : () => {});

  async function detectMode() { return 'pid'; }

  async function status(unit, health) {
    const pids = ragPidStatus(runDir);
    if (unit === MEMORY_RAG_UNIT) {
      const active = !!health || pids.memoryRagAlive;
      return { active, state: active ? 'active' : '' };
    }
    const healthy = health?.embedding?.healthy === true;
    const active = healthy || pids.embeddingAlive;
    return { active, state: active ? 'active' : '' };
  }

  async function installed() { return false; }

  async function start({ managed, onStep = () => {} } = {}) {
    const step = asStep(onStep);
    if (managed) {
      step(STEP.startEmbedding);
      const result = await startEmbeddingService({ ...spawnOpts, managed: true, cwd: p.home });
      if (result.skipped && !['already-running', 'not-managed'].includes(result.skipped)) {
        log(`[rag] embedding 未启动：${result.skipped}${result.freeMiB ? `（空闲 ${result.freeMiB} MiB）` : ''}`);
      }
    }
    step(STEP.startRag);
    const result = await startMemoryRagService({ ...spawnOpts });
    if (result.skipped && result.skipped !== 'already-running') {
      log(`[rag] memory-rag 未启动：${result.skipped}`);
    }
    step(STEP.wait);
  }

  async function stop({ managed, onStep = () => {} } = {}) {
    asStep(onStep)(STEP.stop);
    await stopRagServices({ runDir, managed, platform, log, deps });
  }

  async function restart({ beforeManaged, afterManaged, onStep = () => {} } = {}) {
    const step = asStep(onStep);
    step(STEP.stop);
    await stopRagService({ runDir, name: 'memory-rag', patterns: ['python'], platform, log, deps });
    if (afterManaged && !beforeManaged) {
      step(STEP.startEmbedding);
      await startEmbeddingService({ ...spawnOpts, managed: true, cwd: p.home });
    } else if (!afterManaged && beforeManaged) {
      await stopRagService({ runDir, name: 'embedding', patterns: ['llama-server'], platform, log, deps });
    }
    step(STEP.startRag);
    await startMemoryRagService({ ...spawnOpts });
    step(STEP.wait);
  }

  return {
    platform: 'win32',
    mode: detectMode,
    detectMode,
    status,
    installed,
    start,
    stop,
    restart
  };
}

/** 按平台选实现；测试可以显式传 platform。 */
export function createProcessManager(options = {}) {
  const platform = options.platform ?? process.platform;
  return platform === 'win32' ? createWindowsRagManager(options) : createLinuxRagManager(options);
}

export { EMBED_PID, RAG_PID };
