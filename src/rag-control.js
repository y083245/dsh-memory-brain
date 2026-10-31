// rag-control.js · RAG（向量记忆）总开关的状态、启停与持久化
//
// APIHUB_PATCH（docs/design/API_CONSOLE_SPEC.md §3、接口约定 §3.3 / §4.1）。
//
// 为什么单独成模块：控制台要「点一下开关就把 memory-rag（自带模式连同 qq-embedding）拉起来 /
// 停掉」，这件事既要知道 systemd 与 nohup 两种部署方式，又要能现算状态给页面轮询。
// 桥接里只留接线，规则全在这里。
//
// 安全纪律（非常重要）：
//   - 启停只走 `execFile`（固定参数、不经 shell、不拼用户输入），单元名与脚本名都写死。
//   - `execFile` 是**注入**的：测试一律用假的；默认实现 `defaultRagExec` 在
//     `QQB_NO_SYSTEMCTL=1` 时直接返回失败，**一个子进程都不 spawn**——防止测试路径误停线上服务。
//   - 任何异常都不冒到桥接进程外面：后台任务的失败只记进 reason，状态由下一次 state() 现算。
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 单元名写死：绝不接受外部传入的单元名（§3.4）。
export const MEMORY_RAG_UNIT = 'qq-memory-rag';
export const EMBEDDING_UNIT = 'qq-embedding';

const DEFAULT_RAG_URL = 'http://127.0.0.1:8093';
const DEFAULT_EMBEDDING_URL = 'http://127.0.0.1:8091';
const HEALTH_TIMEOUT_MS = 150000; // 与 embedding 单元的 TimeoutStartSec 一致（§3.2）
const HEALTH_POLL_MS = 2000; // 规格 §3.2：每 2 秒查一次
const HEALTH_REQUEST_TIMEOUT_MS = 3000;
const EMBED_LOG_TAIL_BYTES = 4096;
// APIHUB_PATCH：`systemctl stop` 要等单元把进程收干净（llama-server 卸模型可能要几十秒），
// 20 秒的默认超时会被打断，给到 60 秒。
const STOP_TIMEOUT_MS = 60000;
// APIHUB_PATCH：script 模式要跑完整个 start-all.sh / stop-all.sh --rag（里面还会等健康），
// 180 秒内没结束才当作失败。
const SCRIPT_TIMEOUT_MS = 180000;

export const STEP = Object.freeze({
  startEmbedding: '正在启动向量模型（qq-embedding）…',
  startRag: '正在启动 memory-rag…',
  wait: '正在等待服务就绪…',
  stop: '正在停止…'
});

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

function pad2(n) { return String(n).padStart(2, '0'); }

/** systemd-run 的 unit 名用本地时间戳（规格 §3.4：qqb-rag-YYYYmmddHHMMSS）。 */
function localStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 忙时抛的错（路由据 `.code === 'busy'` 回 409）。 */
function busyError() {
  const error = new Error('正在启停向量记忆，请稍候');
  error.code = 'busy';
  return error;
}

/**
 * @param {object} deps
 * @param {string} deps.root          仓库根（找 start-all.sh / stop-all.sh）
 * @param {string} deps.stateDir      state/
 * @param {string} deps.runDir        ~/.ai-companion-run（读 embed.log）
 * @param {() => boolean} deps.readEnabled   启动时读一次 config.json 的 memoryRag.enabled
 * @param {(v:boolean) => void} deps.writeEnabled 写回；失败抛错
 * @param {(cmd:string,args:string[],opts?:object) => Promise<{code:number,stdout:string,stderr:string}>} deps.execFile
 * @param {(url:string,init?:object) => Promise<any>} deps.fetchImpl
 * @param {() => string} deps.embeddingKind  'bundled'|'local'|'cloud'|'legacy-local'|'legacy-api'
 * @param {string} [deps.ragUrl]      memory-rag 地址（桥接从 config.json 的 memoryRag.url 传）
 * @param {object} [deps.rag]         memory-rag 客户端（只用于 rebuild()）
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

  let modeCache = null; // 'systemd' | 'script'，缓存到桥接重启
  let systemdRunCache = null;

  const timeoutMs = clampInt(healthTimeoutMs, 1, 600000, HEALTH_TIMEOUT_MS);
  const pollMs = clampInt(healthPollMs, 1, 60000, HEALTH_POLL_MS);

  // APIHUB_PATCH：opts 透传给注入的 execFile（defaultRagExec 里 `{ timeout: 20000, ...opts }`
  // 允许按命令覆盖超时）；start / restart 走 `--no-block`，不等单元真正就绪。
  async function run(cmd, args = [], opts = {}) {
    try {
      const result = await execFile(cmd, args, opts);
      if (!result || typeof result !== 'object') return { code: 1, stdout: '', stderr: '' };
      return { code: Number(result.code) || 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
    } catch {
      return { code: 1, stdout: '', stderr: '' };
    }
  }

  const managed = () => {
    const kind = kindOf();
    return kind === 'bundled' || kind === 'legacy-local';
  };

  function kindOf() {
    try { return String(embeddingKind() ?? ''); } catch { return ''; }
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

  /** 自带模式在 script 部署里没有单元可问，只能看 :8091 的健康（llama-server 自带 /health）。 */
  async function embeddingReachable() {
    if (typeof fetchImpl !== 'function') return false;
    try {
      const response = await fetchImpl(`${DEFAULT_EMBEDDING_URL}/health`, {
        method: 'GET',
        signal: withTimeout(2000)
      });
      return !!response && !!response.ok;
    } catch {
      return false;
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

  /** 单元是否在跑（script 模式没有单元：memory-rag 看健康、embedding 看 :8091）。 */
  async function unitStatus(unit, health, mode) {
    if (mode === 'systemd') {
      const r = await run('systemctl', ['--user', 'is-active', unit]);
      const state = String(r.stdout ?? '').trim();
      return { active: r.code === 0, state };
    }
    if (unit === MEMORY_RAG_UNIT) return { active: !!health, state: health ? 'active' : '' };
    return { active: await embeddingReachable(), state: '' };
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

  async function doStart() {
    const mode = await detectMode();
    if (mode === 'script') {
      step = STEP.startRag;
      await runScript('start-all.sh');
      step = STEP.wait;
      await waitHealthy();
      return;
    }
    if (managed()) {
      step = STEP.startEmbedding;
      await run('systemctl', ['--user', 'reset-failed', EMBEDDING_UNIT]);
      // ExecCondition 不满足时单元会自己回到 inactive（不报错），继续起 memory-rag，
      // 状态最终由 state() 判成 partial —— 这正是规格 §3.2 第 3 条。
      // APIHUB_PATCH：`--no-block` —— qq-embedding 的 ExecStartPost 要等模型加载完（最长约 150 秒），
      // 阻塞式 start 会被 20 秒超时打断，结果码是假的失败，后面的命令也跟着卡。就绪与否全靠 waitHealthy()。
      await run('systemctl', ['--user', '--no-block', 'start', EMBEDDING_UNIT]);
    }
    step = STEP.startRag;
    await run('systemctl', ['--user', 'reset-failed', MEMORY_RAG_UNIT]);
    await run('systemctl', ['--user', '--no-block', 'start', MEMORY_RAG_UNIT]);
    step = STEP.wait;
    await waitHealthy();
  }

  async function doStop() {
    const mode = await detectMode();
    step = STEP.stop;
    if (mode === 'script') {
      await runScript('stop-all.sh');
      return;
    }
    // 停要阻塞（脚本退出后 state() 才能读到真实状态），所以只放宽超时，不加 --no-block。
    await run('systemctl', ['--user', 'stop', MEMORY_RAG_UNIT], { timeout: STOP_TIMEOUT_MS });
    // 「自己部署的本地服务」/ 云端模式不碰 qq-embedding（§3.2 关闭第 3 条）。
    if (managed()) await run('systemctl', ['--user', 'stop', EMBEDDING_UNIT], { timeout: STOP_TIMEOUT_MS });
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
    const mode = await detectMode();
    const beforeManaged = embeddingBefore === 'bundled' || embeddingBefore === 'legacy-local';
    const afterManaged = embeddingAfter === 'bundled' || embeddingAfter === 'legacy-local';
    if (mode === 'script') {
      step = STEP.stop;
      await runScript('stop-all.sh');
      step = STEP.startRag;
      await runScript('start-all.sh');
      step = STEP.wait;
      await waitHealthy();
      return;
    }
    if (afterManaged && !beforeManaged) {
      step = STEP.startEmbedding;
      await run('systemctl', ['--user', 'reset-failed', EMBEDDING_UNIT]);
      // APIHUB_PATCH：同上 —— 起 embedding 不等就绪，`--no-block`。
      await run('systemctl', ['--user', '--no-block', 'start', EMBEDDING_UNIT]);
    } else if (!afterManaged && beforeManaged) {
      step = STEP.stop;
      await run('systemctl', ['--user', 'stop', EMBEDDING_UNIT], { timeout: STOP_TIMEOUT_MS });
    }
    step = STEP.startRag;
    await run('systemctl', ['--user', 'reset-failed', MEMORY_RAG_UNIT]);
    // APIHUB_PATCH：restart 也加 `--no-block`，就绪由后面的 waitHealthy() 判断。
    await run('systemctl', ['--user', '--no-block', 'restart', MEMORY_RAG_UNIT]);
    step = STEP.wait;
    await waitHealthy();
  }

  /** 触发 memory-rag 的全量重建（经客户端；没配就是 null）。 */
  function rebuild() {
    return rag ? rag.rebuild() : Promise.resolve(null);
  }

  /** 单元装没装（控制台显示 bundled 的「已安装」）。 */
  async function unitInstalled(unit) {
    const name = unit === EMBEDDING_UNIT ? EMBEDDING_UNIT : MEMORY_RAG_UNIT;
    const r = await run('systemctl', ['--user', 'cat', name]);
    return r.code === 0;
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
