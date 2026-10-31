// qq-persona-context：把桥接算好的「性格 / 此刻情绪 / 和他的关系」交给 DSH（PERSONA_PATCH）。
//
// 桥接（src/persona.js）把快照写到 state/persona/live.json：
//   { core: "【你现在的性格】…", sessions: { <DSH 会话 ID>: "private:123" }, byKey: { "private:123": "【你此刻】…\n【你和…】…" } }
// 这里注册两样东西（DSH 的 systemPrompt 服务，见 ~/deepseek-harness/packages/core/system-prompt/src/index.ts）：
//   section  qq-persona:core —— 进 system prompt 正文。只在每晚结算后变，前缀缓存每天最多失效一次；
//   context  qq-persona:now  —— 每次组装时求值，作为 user 角色快照追加进历史，不动已缓存的前缀，
//                               所以情绪能每一步都实时更新（DeepSeek 缓存命中 0.02 vs 未命中 1）。
// 当前会话：组装上下文里的 agent.id 就是 DSH 会话 ID（packages/core/agent/src/types.ts）。
// 读不到文件、找不到会话 → 返回空串，什么都不注入；聊天照常。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'qq-persona-context'
export const inject = ['systemPrompt']

const DEFAULT_LIVE_FILE = fileURLToPath(new URL('../../state/persona/live.json', import.meta.url))
const DIAG_FILE = fileURLToPath(new URL('../../state/persona/plugin.log', import.meta.url))

export function createLiveReader(file = DEFAULT_LIVE_FILE) {
  let cache = { mtimeMs: -1, size: -1, data: null }
  return function read() {
    try {
      const st = fs.statSync(file)
      if (st.mtimeMs !== cache.mtimeMs || st.size !== cache.size) {
        cache = { mtimeMs: st.mtimeMs, size: st.size, data: JSON.parse(fs.readFileSync(file, 'utf8')) }
      }
      return cache.data
    } catch {
      return null
    }
  }
}

export function coreText(live) {
  return typeof live?.core === 'string' ? live.core : ''
}

export function contextText(live, sessionId) {
  if (!live || typeof sessionId !== 'string' || !sessionId) return ''
  const key = live.sessions?.[sessionId]
  if (!key) return ''
  return typeof live.byKey?.[key] === 'string' ? live.byKey[key] : ''
}

// 诊断：组装上下文里拿不到 agent.id 时记一笔（每小时最多一次），方便实施时核对。
let lastDiagAt = 0
function diag(file, message) {
  const now = Date.now()
  if (now - lastDiagAt < 3600000) return
  lastDiagAt = now
  try { fs.appendFileSync(file, `${new Date(now).toISOString()} ${message}\n`, { mode: 0o600 }) } catch {}
}

export function apply(ctx, config = {}) {
  const read = createLiveReader(config.liveFile || DEFAULT_LIVE_FILE)
  const diagFile = config.diagFile || DIAG_FILE
  ctx.systemPrompt.section({
    name: 'qq-persona:core',
    order: 100000,
    interpolate: false,
    text: () => coreText(read())
  })
  ctx.systemPrompt.context({
    name: 'qq-persona:now',
    order: 100000,
    interpolate: false,
    text: (assembly) => {
      const sessionId = assembly?.agent?.id
      if (!sessionId) diag(diagFile, 'assembly.agent.id 为空，无法确定当前 QQ 会话')
      return contextText(read(), sessionId)
    }
  })
}
