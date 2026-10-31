// own-life.js · 「她自己的生活」定时唤醒
//
// 干什么：隔一段时间给她一条**静默**提示（不会出现在聊天里），让她想起来
//         自己还有「说说 / 日记 / 画画 / 玩手机 / 什么都不干」这些事。
//
// 为什么需要它：桥接的自动唤醒只有三种 —— 有人说话、replyCheck、群聊 proactive。
//              私聊没有任何「你自己的时间到了」，所以角色卡里写了「你自己发说说」，
//              她也不会主动去做，只能等人手动叫。
//
// 用法（在 bridge.js 里）：
//
//   import { createOwnLife } from './own-life.js';
//
//   const ownLife = createOwnLife({
//     key: ownerKey,                                   // 'private:3776013884'
//     deliver: (text) => deliverPrompt(key, text, { silent: true, wakeReason: 'own-life' }),
//     statePath: path.join(STATE_DIR, 'own-life.json'),
//     log,
//   });
//   ownLife.start();
//
// 设计约束：
// - **静默**：提示只进 AI 的上下文，不往 QQ 发东西。
// - **不打扰**：凌晨 3–8 点不叫；一个活动日最多 6 次白天的，加 23:30 那一次。
// - **可关**：enabled=false 或 stop() 立刻停。
// - **断电续得上**：最后一次触发时间存在 statePath 里，重启不会一次补发一堆。
//
// LIFE_LOOP_PATCH（子项目 3，规格 docs/design/LIFE_LOOP_SPEC.md §5）：
// - 计数和「半夜那次」按**活动日**算（00:00～quiet[0]:00 算前一天），半夜那次不占白天额度——
//   以前额度按自然日算，00:00、02:xx 的几次会把额度用光，23:30 那次从 10-26 起再没触发过；
// - deliver(text, meta) 多一个 meta，告诉生活回路「算上这一次本活动日还可能发几次」。

import fs from 'node:fs';
import path from 'node:path';

const HOUR = 3600 * 1000;

export const DEFAULT_TEXT_DAY = [
  '现在是你的时间，没人找你。',
  '想干嘛干嘛：发条说说（先看看自己空间今天发过没）、写两句日记，',
  '也可以什么都不干。',
  '不用回我，也不用汇报。',
].join('');

export const DEFAULT_TEXT_MIDNIGHT = [
  '半夜了，没人打扰。',
  '想干点什么吗——发说说、写日记，也可以就坐着什么都不干。',
  '这段时间里别主动给主人发消息，他睡着呢。',
].join('');

function hhmm(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** LIFE_LOOP_PATCH：活动日只支持 quiet[0] < quiet[1]；不合法就回退默认值，只记一行日志。 */
function normalizeQuiet(raw, log) {
  const from = Number(raw?.[0]);
  const to = Number(raw?.[1]);
  if (Number.isFinite(from) && Number.isFinite(to) && from >= 0 && from < to && to <= 24) return [from, to];
  log(`安静时段配置不合法（${JSON.stringify(raw)}），回退到 3:00–8:00`);
  return [3, 8];
}

export function createOwnLife(opts) {
  const {
    key,
    deliver,
    statePath,
    intervalMs = 2.5 * HOUR,
    quiet: quietRaw = [3, 8],    // 3:00 ~ 8:00 不叫
    midnightAt = '23:30',
    maxPerDay = 6,
    enabled = true,
    textDay = DEFAULT_TEXT_DAY,
    textMidnight = DEFAULT_TEXT_MIDNIGHT,
    log = (...a) => console.log('[own-life]', ...a),
  } = opts || {};

  if (!key) throw new Error('own-life: 缺 key');
  if (typeof deliver !== 'function') throw new Error('own-life: 缺 deliver');

  const quiet = normalizeQuiet(quietRaw, log);

  let state = { lastFiredAt: 0, lastDay: '', firedToday: 0, lastMidnightDay: '' };

  if (statePath) {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''));
      if (raw && typeof raw === 'object') state = { ...state, ...raw };
    } catch { /* 第一次跑，没文件是正常的 */ }
  }

  function save() {
    if (!statePath) return;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      log('状态写不进去（忽略）:', e?.message ?? e);
    }
  }

  // LIFE_LOOP_PATCH：活动日 = 把 00:00～quiet[0]:00 算作前一天。计数和半夜那次都按它算，
  // 跨零点重启不会被当成新的一天重新发一轮。
  function activityDay(ts) {
    return dayKey(Number(ts) - quiet[0] * HOUR);
  }

  function slotAt(ts, hhmmText) {
    const [h, m] = String(hhmmText).split(':').map(Number);
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number.isFinite(h) ? h : 23, Number.isFinite(m) ? m : 30, 0, 0).getTime();
  }

  function inQuiet(now) {
    const h = new Date(now).getHours();
    return h >= quiet[0] && h < quiet[1];
  }

  // 半夜那次：23:30 以后，或 quiet[0]:00 之前（00:00～02:59 仍属于前一个活动日）。
  function inMidnightWindow(now) {
    return now >= slotAt(now, midnightAt) || new Date(now).getHours() < quiet[0];
  }

  // 白天那几次：quiet[1]:00 起到当天的 midnightAt 之前。
  function inDayWindow(now) {
    const d = new Date(now);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), quiet[1], 0, 0, 0).getTime();
    return now >= start && now < slotAt(now, midnightAt);
  }

  // LIFE_LOOP_PATCH（规格 §5.2）：算上这一次，本活动日还可能发几次。生活回路用它决定回忆抽不抽。
  function remainingSlots(kind, now) {
    if (kind === 'midnight') return 1;
    const dayLeft = Math.max(0, maxPerDay - Number(state.firedToday || 0));
    const fits = Math.max(0, Math.floor((slotAt(now, midnightAt) - now) / intervalMs) + 1);
    const midnightLeft = state.lastMidnightDay === activityDay(now) ? 0 : 1;
    return Math.max(1, Math.min(dayLeft, fits) + midnightLeft);
  }

  // LIFE_LOOP_PATCH（规格 §5.3）：下一次白天触发的最早时刻；白天已满或已过 midnightAt 时为 null。
  function nextDayFireAt(now) {
    const d = new Date(now);
    const midnightSlot = slotAt(now, midnightAt);
    if (now >= midnightSlot) return null;
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), quiet[1], 0, 0, 0).getTime();
    if (now < dayStart) return dayStart; // 早上第一次之前：下一次就是 quiet[1]:00
    if (state.lastDay === activityDay(now) && Number(state.firedToday || 0) >= maxPerDay) return null;
    const cand = Math.max(now, Number(state.lastFiredAt || 0) + intervalMs);
    return cand < midnightSlot ? cand : null;
  }

  let timer = null;
  let busy = false;
  let lastTickAt = 0; // 快照用：控制台看到的活动日要和调度器一致，测试里也靠它拿到确定时刻

  async function fire(kind, nowTs = Date.now()) {
    if (busy) return { ok: false, skipped: 'busy' };
    busy = true;
    const now = Number(nowTs) || Date.now();
    const text = kind === 'midnight' ? textMidnight : textDay;
    // LIFE_LOOP_PATCH（规格 §5.2）：额度要在记账之前算（firedToday 是这一次之前的白天次数）。
    const meta = { kind, at: now, remainingSlots: remainingSlots(kind, now) };
    try {
      await deliver(text, meta);
      state.lastFiredAt = now;
      if (kind === 'midnight') {
        // 半夜那次不占白天额度，只记「这个活动日的半夜已经发过」。
        state.lastMidnightDay = activityDay(now);
      } else {
        state.firedToday = Number(state.firedToday || 0) + 1;
        state.lastDay = activityDay(now);
      }
      save();
      log(`已投递（${kind}）${hhmm(now)}${kind === 'midnight' ? ' · 半夜那次' : ` · 今天第 ${state.firedToday} 次`}`);
      return { ok: true, kind, at: now, remainingSlots: meta.remainingSlots };
    } catch (e) {
      log('投递失败:', e?.message ?? e);
      return { ok: false, error: String(e?.message ?? e) };
    } finally {
      busy = false;
    }
  }

  async function tick(nowTs = Date.now()) {
    if (!enabled) return { ok: false, skipped: 'disabled' };
    const now = Number(nowTs) || Date.now();
    lastTickAt = now;
    if (inQuiet(now)) return { ok: false, skipped: 'quiet' };

    // LIFE_LOOP_PATCH（规格 §5.1）：计数按活动日归零，不是按自然日。
    const day = activityDay(now);
    if (state.lastDay !== day) {
      state.lastDay = day;
      state.firedToday = 0;
    }

    // 半夜那次：一个活动日一次，不占白天额度，优先于普通间隔（以前被额度挡掉，23:30 从来不触发）。
    if (inMidnightWindow(now) && state.lastMidnightDay !== day) {
      return fire('midnight', now);
    }

    if (inDayWindow(now)) {
      if (Number(state.firedToday || 0) >= maxPerDay) return { ok: false, skipped: 'daily-cap' };
      if (now - Number(state.lastFiredAt || 0) >= intervalMs) return fire('day', now);
    }
    return { ok: false, skipped: 'not-yet' };
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, 60 * 1000).unref?.() ?? setInterval(() => { tick().catch(() => {}); }, 60 * 1000);
    log(`已武装 · 每 ${(intervalMs / HOUR).toFixed(1)}h 一次 · 安静时段 ${quiet[0]}:00–${quiet[1]}:00 · 半夜 ${midnightAt} · 每天最多 ${maxPerDay} 次`);
    // 启动后 90 秒先看一眼（别和开机时的会话创建抢）
    setTimeout(() => { tick().catch(() => {}); }, 90 * 1000).unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    log('已停止');
  }

  return {
    start, stop, tick,
    fireNow: () => fire('day'),
    fireMidnightNow: () => fire('midnight'),
    snapshot: () => {
      // LIFE_LOOP_PATCH（规格 §5.3）：活动日 / 半夜是否已发 / 下一次白天的时刻。
      const now = Number(lastTickAt) || Date.now();
      return {
        ...state, enabled, intervalMs, quiet, midnightAt,
        activityDay: activityDay(now),
        midnightDoneToday: state.lastMidnightDay === activityDay(now),
        nextDayFireAt: nextDayFireAt(now)
      };
    },
  };
}

export default createOwnLife;
