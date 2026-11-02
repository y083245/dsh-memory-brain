// topic-scan.js · 话题巡检（按话题唤醒，而不是按规则唤醒）
//
// 为什么要有它：二代唤醒是「规则驱动」——@ / 叫名字 / 关键词 / 拍一拍 / 直接的提问 /
// 5% 骰子。群里正常闲聊一句都不命中，于是她一整晚只在骰子掉下来时冒一次泡，
// 观感就是「说一句就潜水」。这里补一层「话题驱动」：
//   潜水期把没触发她的消息攒成一批 → 攒够条数 + 冷却到期 + 配额够 → 发一个
//   「话题巡检」回合，把这一批原话摆给她，她自己判断这个话题有没有兴趣：
//   有兴趣就插一句，没兴趣直接收尾（不用回任何人）。
//
// 判定交给她自己，而不是外接一个小模型：本机没有可用的 DeepSeek API key
// （/root/.dsh/.credentials.yaml 里 hasKey=false），订阅制的账号只对 DSH 会话开放。
// 好处是「兴趣」天然跟人设一致；代价是每次巡检算一个回合，所以下面全是闸门。
//
// 纯函数都在这里，方便 scripts/test-topic-scan.mjs 单测；桥接只负责接线。

export const TOPIC_SCAN_REASON = 'topicScan';

export const INTEREST_DEFAULTS = Object.freeze({
  enabled: false,          // 默认关：开了就会多花回合，让操作者显式打开
  minMessages: 6,          // 至少攒够几条群友消息才值得巡检
  minChars: 24,            // 总字数下限：滤掉「哈哈哈」「？？？」这种没内容的一批
  windowMs: 90_000,        // 从第一条进入缓冲起，攒这么久就巡一次
  cooldownMs: 240_000,     // 两次巡检之间至少隔这么久（4 分钟）
  maxScansPerHour: 6,      // 每小时巡检上限（成本闸）
  maxBatchMessages: 12,    // 一次最多摆给她多少条
  maxBatchChars: 1200,     // 一次最多摆多少字
  maxLineChars: 160,       // 单条消息截断长度
});

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 把 config.json 里的 socialV2.interest 规范化成稳定形状（坏的/缺的都回落到默认值）。 */
export function normalizeInterestConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const d = INTEREST_DEFAULTS;
  return {
    enabled: src.enabled === true,
    minMessages: clampInt(src.minMessages, d.minMessages, 2, 40),
    minChars: clampInt(src.minChars, d.minChars, 0, 4000),
    windowMs: clampInt(src.windowMs, d.windowMs, 5_000, 1_800_000),
    cooldownMs: clampInt(src.cooldownMs, d.cooldownMs, 0, 7_200_000),
    maxScansPerHour: clampInt(src.maxScansPerHour, d.maxScansPerHour, 0, 120),
    maxBatchMessages: clampInt(src.maxBatchMessages, d.maxBatchMessages, 2, 40),
    maxBatchChars: clampInt(src.maxBatchChars, d.maxBatchChars, 100, 8000),
    maxLineChars: clampInt(src.maxLineChars, d.maxLineChars, 20, 2000),
  };
}

/** 新的会话台账（进程内，重启清零；不写 state 文件，避免频繁落盘）。 */
export function createLedger() {
  return { lastScanAt: 0, scans: [] };
}

/**
 * 该不该巡检。
 * @returns {{scan: boolean, why: string, pending: number}}
 *   why: disabled | empty | wait-more | too-shallow | cooldown | hourly-budget | ok
 */
export function shouldScan({ buffer, now, ledger, cfg }) {
  const pending = Array.isArray(buffer) ? buffer.length : 0;
  if (!cfg?.enabled) return { scan: false, why: 'disabled', pending };
  if (!pending) return { scan: false, why: 'empty', pending };
  if (pending < cfg.minMessages) return { scan: false, why: 'wait-more', pending };

  const chars = (Array.isArray(buffer) ? buffer : []).reduce((n, m) => n + String(m?.text ?? '').trim().length, 0);
  if (chars < cfg.minChars) return { scan: false, why: 'too-shallow', pending };

  const lastScanAt = Number(ledger?.lastScanAt) || 0;
  if (cfg.cooldownMs > 0 && lastScanAt > 0 && now - lastScanAt < cfg.cooldownMs) {
    return { scan: false, why: 'cooldown', pending };
  }
  const hourAgo = now - 3_600_000;
  const recent = (Array.isArray(ledger?.scans) ? ledger.scans : []).filter((t) => Number(t) > hourAgo);
  if (cfg.maxScansPerHour > 0 && recent.length >= cfg.maxScansPerHour) {
    return { scan: false, why: 'hourly-budget', pending };
  }
  return { scan: true, why: 'ok', pending };
}

/** 记一次巡检（不改 buffer，调用方自己在真正发出后清空）。 */
export function applyScan(ledger, now, cfg) {
  const next = ledger && typeof ledger === 'object' ? ledger : createLedger();
  next.lastScanAt = now;
  const hourAgo = now - 3_600_000;
  next.scans = [...(Array.isArray(next.scans) ? next.scans : []).filter((t) => Number(t) > hourAgo), now].slice(-500);
  return next;
}

/** 从缓冲里挑出要摆给她的那批：只留最新的 maxBatchMessages 条，单条截断，总量截断。 */
export function pickTopicBatch(buffer, cfg) {
  const list = (Array.isArray(buffer) ? buffer : [])
    .map((m) => ({
      sender: String(m?.sender ?? '').slice(0, 24) || '某人',
      text: String(m?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, cfg.maxLineChars),
      at: Number(m?.at) || 0,
    }))
    .filter((m) => m.text);
  const tail = list.slice(-cfg.maxBatchMessages);
  const out = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const line = `${tail[i].sender}：${tail[i].text}`;
    if (used + line.length > cfg.maxBatchChars && out.length) break;
    used += line.length;
    out.unshift(line);
  }
  return out;
}

/**
 * 唤醒提示里的「话题巡检」正文：把这一批原话摆出来，并说清这是什么事、可以不接。
 * 注意：**不催她发言**。巡检的价值一半在于「她判断不感兴趣就安静收尾」。
 */
export function buildTopicScanBlock({ buffer, cfg }) {
  const lines = pickTopicBatch(buffer, cfg);
  if (!lines.length) return '';
  const quoted = lines.map((l) => `· ${l}`).join('\n');
  return [
    '最近群里在聊这些（没人叫你，这是攒下来的一批新消息）：',
    quoted,
    '',
    '这是「话题巡检」，不是有人找你。你要做的只有一件事：判断这里有没有你**真的感兴趣、而且能自然接上**的话题。',
    '· 有 —— 就像群友一样插一句（qq_send_message / qq_reply），说人话、别像客服接单；接完按流程收尾。',
    '· 没有 —— 直接 qq_mark_read 收尾，一句话都不用发；不要为了聊天而聊天，也不要逐条点评、不要总结。',
    '宁可少说，也别硬接一个你不感兴趣的话题。',
  ].join('\n');
}

/** 判断一批消息是否「明显不值得巡检」：全是极短语气词时直接丢掉，省一个回合。 */
export function isTrivialBatch(buffer, cfg) {
  const list = Array.isArray(buffer) ? buffer : [];
  if (!list.length) return true;
  const chars = list.reduce((n, m) => n + String(m?.text ?? '').trim().length, 0);
  if (chars < Math.max(1, Math.floor(cfg.minChars / 2))) return true;
  const meaningful = list.filter((m) => String(m?.text ?? '').trim().length >= 4).length;
  return meaningful === 0;
}
