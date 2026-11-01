// rag-control.js · RAG（向量记忆）总开关的状态、启停与持久化
//
// APIHUB_PATCH（docs/design/API_CONSOLE_SPEC.md §3、接口约定 §3.3 / §4.1）。
//
// 为什么单独成模块：控制台要「点一下开关就把 memory-rag（自带模式连同 qq-embedding）拉起来 /
// 停掉」，这件事既要知道 systemd 与 nohup 两种部署方式，又要能现算状态给页面轮询。
// 桥接里只留接线，规则全在这里。
//
// 安全纪律（非常重要）：
//   - 启停只走注入的 execFile / 进程管理器（固定参数、不经 shell、不拼用户输入），
//     单元名与脚本名都写死。
//   - `execFile` 是**注入**的：测试一律用假的；默认实现 `defaultRagExec` 在
//     `QQB_NO_SYSTEMCTL=1` 时直接返回失败，**一个子进程都不 spawn**——防止测试路径误停线上服务。
//   - 任何异常都不冒到桥接进程外面：后台任务的失败只记进 reason，状态由下一次 state() 现算。
//
// Windows 没有 systemd：createProcessManager 会选 PID 实现（detached spawn + ~/.ai-companion-run/*.pid，
// 停止时 taskkill /T）。Linux 仍走原来的 systemd / start-all.sh 两条路。
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createProcessManager } from './process-manager.mjs';
import { EMBEDDING_UNIT, MEMORY_RAG_UNIT, STEP } from './rag-constants.js';

export { EMBEDDING_UNIT, MEMORY_RAG_UNIT, STEP };

const DEFAULT_RAG_URL = 'http://127.0.0.1:8093';
const HEALTH_TIMEOUT_MS = 150000; // 与 embedding 单元的 TimeoutStartSec 一致（§3.2）
const HEALTH_POLL_MS = 2000; // 规格 §3.2：每 2 秒查一次
const HEALTH_REQUEST_TIMEOUT_MS = 3000;
const EMBED_LOG_TAIL_BYTES = 4096;

/**
 * 默认的 `execFile`：跑一条命令，把结果归一成 `{ code, stdout, stderr }`，**不抛**。
 * 硬性要求：`QQB_NO_SYSTEMCTL=1` 时直接返回失败、不 spawn —— 本模块的默认实现会调真的
 * `systemctl --user`，在这台机器上会直接停掉线上 RAG；测试环境必须靠这道闸门兜底。
 */
export function defaultRagExec(cmd, args = [], opts = {}) {
  if (process.env.QQB_NO_SYSTEMCTL === '1') {
    return Promise.resolve({ code: 127, stdout: '', stderr: 'QQB_NO_SYSTEMCTL' });
  }
  return new Promise((resolve) => {
    try {
      nodeExecFile(cmd, args, { timeout: 20000, maxBuffer: 1024 * 1024, ...opts }, (error, stdout, stderr) => {
        // error.code 是数字时就是退出码；ENOENT 这类是字符串，统一按 1（= 失败）处理。
        const code = error ? (Number.isInteger(error.code) ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
    } catch {
      resolve({ code: 1, stdout: '', stderr: 'spawn-failed' });
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 忙时抛的错（路由据 `.code === 'busy'` 回 409）。 */
function busyError() {
  const error = new Error('正在启停向量记忆，请稍候');
  error.code = 'busy';
  return error;
}

/**
 * @param {object} deps
 * @param {string} deps.root          仓库根（Linux script 模式找 start-all.sh / stop-all.sh）
 * @param {string} deps.stateDir      state/
 * @param {string} deps.runDir        ~/.ai-companion-run（读 embed.log / PID 文件）
 * @param {() => boolean} deps.readEnabled   启动时读一次 config.json 的 memoryRag.enabled
 * @param {(v:boolean) => void} deps.writeEnabled 写回；失败抛错
 * @param {(cmd:string,args:string[],opts?:object) => Promise<{code:number,stdout:string,stderr:string}>} deps.execFile
 * @param {(url:string,init?:object) => Promise<any>} deps.fetchImpl
 * @param {() => string} deps.embeddingKind  'bundled'|'local'|'cloud'|'legacy-local'|'legacy-api'
 * @param {string} [deps.ragUrl]      memory-rag 地址（桥接从 config.json 的 memoryRag.url 传）
 * @param {object} [deps.rag]         memory-rag 客户端（只用于 rebuild()）
 * @param {string} [deps.platform]    默认 process.platform；测试可显式传 'linux' / 'win32'
 * @param {object} [deps.manager]     测试可注入的进程管理器；默认按平台创建
 * @param {number} [deps.healthTimeoutMs] / [deps.healthPollMs]  测试用可控时钟
 */
export function createRagControl({
  root,
  stateDir,
  runDir,
  readEnabled = () => false,
  writeEnabled = () => {},
  execFile = defaultRagExec,
  fetchImpl = globalThis.fetch,
  embeddingKind = () => 'bundled',
  ragUrl = DEFAULT_RAG_URL,
  rag = null,
  log = () => {},
  now = Date.now,
  platform = process.platform,
  manager = null,
  paths = null,
  healthTimeoutMs = HEALTH_TIMEOUT_MS,
  healthPollMs = HEALTH_POLL_MS
} = {}) {
  void stateDir; // 设置文件的读取由 api-hub 负责（embeddingKind 由它提供）
  let enabledNow = false;
  try { enabledNow = readEnabled() === true; } catch { enabledNow = false; }

  // 同一时间只允许一个启停 / 保存操作（规格 §11「连点 / 并发」）。
  let locked = false;
  let busyOp = null; // null | 'start' | 'stop' | 'save-embedding'
  let step = null;

  let modeCache = null; // 'systemd' | 'script' | 'pid'，缓存到桥接重启

  const timeoutMs = clampInt(healthTimeoutMs, 1, 600000, HEALTH_TIMEOUT_MS);
  const pollMs = clampInt(healthPollMs, 1, 60000, HEALTH_POLL_MS);

  const processManager = manager ?? createProcessManager({
    platform,
    root,
    runDir,
    paths,
    execFile,
    fetchImpl,
    now,
    log
  });

  const managed = () => {
    const kind = kindOf();
    return kind === 'bundled' || kind === 'legacy-local';
  };

  function kindOf() {
    try { return String(embeddingKind() ?? ''); } catch { return ''; }
  }

  async function detectMode() {
    if (modeCache) return modeCache;
    try { modeCache = await processManager.detectMode(); } catch { modeCache = platform === 'win32' ? 'pid' : 'script'; }
    return modeCache;
  }

  function withTimeout(signalMs) {
    try { return AbortSignal.timeout(signalMs); } catch { return undefined; }
  }

  async function fetchHealth() {
    if (typeof fetchImpl !== 'function') return null;
    try {
      const response = await fetchImpl(`${String(ragUrl).replace(/\/+$/, '')}/health`, {
        method: 'GET',
        signal: withTimeout(HEALTH_REQUEST_TIMEOUT_MS)
      });
      if (!response || !response.ok) return null;
      const data = await response.json();
      return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  }

  /** embed.log 最后一条以 `[qqb]` 开头的文字（qqb-helper.sh embed-check 打的说明）。 */
  function embedLogLine() {
    try {
      const file = path.join(runDir, 'embed.log');
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - EMBED_LOG_TAIL_BYTES);
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => l.trim());
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i].trim();
          if (line.startsWith('[qqb]')) return line.replace(/^\[qqb\]\s*/, '') || null;
        }
        return null;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  /** 单元是否在跑（具体判断交给进程管理器：systemd / 健康 / PID 文件）。 */
  async function unitStatus(unit, health, mode) {
    try {
      return await processManager.status(unit, health, mode);
    } catch {
      return { active: false, state: '' };
    }
  }

  /** 现算状态（规格 §3.1 / 接口约定 §4.1 的判定顺序，第一条命中即定）。 */
  async function state() {
    const kind = kindOf();
    const isManaged = kind === 'bundled' || kind === 'legacy-local';
    const mode = await detectMode();
    const base = {
      enabled: enabledNow,
      phase: 'off',
      reason: null,
      busy: locked,
      op: busyOp,
      step: locked ? step : null,
      mode,
      embedding: { kind, managed: isManaged, active: false, healthy: null, error: null },
      memoryRag: { active: false, healthy: false, mismatch: null },
      job: null,
      checkedAt: now()
    };

    // 1. 启停中：不再去问服务（页面每 2 秒轮询，别把重启中的抖动当成结论）。
    if (locked) {
      base.phase = busyOp === 'stop' ? 'stopping' : 'starting';
      return base;
    }

    const health = await fetchHealth();
    const memory = await unitStatus(MEMORY_RAG_UNIT, health, mode);
    const embedStatus = isManaged ? await unitStatus(EMBEDDING_UNIT, health, mode) : { active: false, state: '' };

    base.memoryRag = {
      active: memory.active,
      healthy: !!health,
      mismatch: typeof health?.mismatch === 'string' && health.mismatch ? health.mismatch : null
    };
    base.embedding = {
      kind,
      managed: isManaged,
      active: embedStatus.active,
      healthy: isManaged ? health?.embedding?.healthy === true : (typeof health?.embedding?.healthy === 'boolean' ? health.embedding.healthy : null),
      error: typeof health?.embedding?.error === 'string' && health.embedding.error ? health.embedding.error : null
    };
    base.job = health?.job ?? null;

    // 2. 总开关关着。服务还在跑时说明是从终端起的，页面上要提示。
    if (!enabledNow) {
      base.phase = 'off';
      if (health) base.reason = '服务仍在运行（不是从控制台起的）';
      return base;
    }

    // 3. memory-rag 不可达。
    if (!health) {
      base.phase = 'failed';
      base.reason = memory.state === 'failed'
        ? 'memory-rag 启动失败，看 ~/.ai-companion-run/memory-rag.log'
        : 'memory-rag 没在运行';
      return base;
    }

    // 4. 重建进行中。
    const job = base.job;
    if (job && typeof job === 'object' && job.finished_at == null && job.finishedAt == null) {
      base.phase = 'rebuilding';
      return base;
    }

    // 5. 向量口径不一致。
    if (base.memoryRag.mismatch) {
      base.phase = 'mismatch';
      base.reason = base.memoryRag.mismatch;
      return base;
    }

    // 6. 一切正常。
    if (health.ok === true) {
      base.phase = 'running';
      return base;
    }

    // 7. memory-rag 起着，但向量路不可用（显存不足 / 配置有误 / 模型连不上）。
    base.phase = 'partial';
    if (base.embedding.error) base.reason = base.embedding.error;
    else if (isManaged && !base.embedding.active) base.reason = embedLogLine() || '向量模型连不上';
    return base;
  }

  /** 等 memory-rag 就绪：每 pollMs 查一次，最长 timeoutMs。返回是否就绪。 */
  async function waitHealthy() {
    const deadline = now() + timeoutMs;
    for (;;) {
      const health = await fetchHealth();
      if (health) return true;
      const left = deadline - now();
      if (left <= 0) return false;
      await sleep(Math.min(pollMs, left));
    }
  }

  async function doStart() {
    step = STEP.startRag;
    await processManager.start({ managed: managed(), onStep: (value) => { step = value; } });
    step = STEP.wait;
    await waitHealthy();
  }

  async function doStop() {
    step = STEP.stop;
    await processManager.stop({ managed: managed(), onStep: (value) => { step = value; } });
  }

  /**
   * 打开 / 关闭。
   * 先同步写 config.json（失败直接抛，内存值不变）→ 改内存值 → 后台启停 → 立即返回忙状态。
   */
  async function setEnabled(value) {
    if (typeof value !== 'boolean') throw new Error('enabled 必须是布尔值');
    if (locked) throw busyError();
    locked = true;
    busyOp = value ? 'start' : 'stop';
    step = value ? STEP.startRag : STEP.stop;
    try {
      writeEnabled(value);
      enabledNow = value;
    } catch (error) {
      locked = false;
      busyOp = null;
      step = null;
      throw error;
    }
    const task = value ? doStart() : doStop();
    task
      .catch((error) => log(`[rag-control] ${value ? '启动' : '停止'}失败：${error?.message ?? error}`))
      .finally(() => { locked = false; busyOp = null; step = null; });
    return state();
  }

  /** 串行执行一个操作（保存向量模型用）；忙时抛 busy。 */
  async function withLock(fn, op = 'save-embedding') {
    if (locked) throw busyError();
    locked = true;
    busyOp = op;
    step = null;
    try {
      return await fn();
    } finally {
      locked = false;
      busyOp = null;
      step = null;
    }
  }

  /**
   * 保存向量模型后重启 memory-rag（规格 §6 第 6 步）。
   * 调用方已经在 withLock 里，这里不再拿锁。
   */
  async function restartMemoryRag({ embeddingBefore, embeddingAfter } = {}) {
    const beforeManaged = embeddingBefore === 'bundled' || embeddingBefore === 'legacy-local';
    const afterManaged = embeddingAfter === 'bundled' || embeddingAfter === 'legacy-local';
    await processManager.restart({
      beforeManaged,
      afterManaged,
      onStep: (value) => { step = value; }
    });
    step = STEP.wait;
    await waitHealthy();
  }

  /** 触发 memory-rag 的全量重建（经客户端；没配就是 null）。 */
  function rebuild() {
    return rag ? rag.rebuild() : Promise.resolve(null);
  }

  /** 单元装没装（控制台显示 bundled 的「已安装」；Windows 的 PID 模式恒为 false）。 */
  async function unitInstalled(unit) {
    try {
      return await processManager.installed(unit);
    } catch {
      return false;
    }
  }

  return {
    enabled: () => enabledNow,
    state,
    setEnabled,
    withLock,
    restartMemoryRag,
    rebuild,
    unitInstalled,
    // 测试与控制台诊断用：当前部署方式（缓存）。
    mode: detectMode
  };
}
