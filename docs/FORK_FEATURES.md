# 本分支新增功能（相对上游）

本仓库基于 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT）分支而来。
上游负责「把 QQ 消息接进 DeepSeek Harness」；本分支在此之上，围绕**长期陪伴型角色**加了一层
记忆、人格与主动行为。所有新模块都可关闭或缺省降级：不配置时，桥接仍能像上游一样收发消息。

## 长期记忆（人物账本 + 聊天存档）

- `src/long-memory.js`：每个会话的收发消息按天追加到 `state/long-memory/archive/<group_X|private_X>/<YYYY-MM>.jsonl`，永久保存，作为检索与回忆的原始资料。
- 人物账本按 QQ 号保存长期事实（喜好、约定、经历等），唤醒时注入她的提示词；支持核心条目、约定到期/兑现状态、归档与去重提示。
- 提供 `qq_history_search`、`qq_ltm_*` 等工具，让她按关键词、日期、说话人翻旧账，也能自己记账本。
- 写盘前会剔除已知的会话令牌；存档与账本都在 `state/` 下，不进仓库。

## 向量记忆 sidecar（`sidecars/memory-rag`）

- 独立的 Python 服务：只读上面那份聊天存档，按时间间隔与话题变化切块，写进 Chroma（块向量）与 SQLite FTS5（jieba / BM25）。
- 检索走「语义 + 关键词」两路 RRF 合并，返回原文片段和日期；`qq_history_search` 可以同时给语义 query 与关键词变体。
- 提炼层用一次模型调用为每个话题块生成摘要、实体与关系，摘要始终指回原文；删除存档后可重建，原文没变的块按哈希复用旧摘要。
- embedding 可选：本地 `llama-server`（Qwen3-Embedding）或任意 OpenAI 兼容 `/embeddings` API，只改 `sidecars/memory-rag/config.yml` 的 `embedding.provider`；细节见该目录 README。
- 服务连不上或超时时，桥接自动退回关键词检索，不影响正常收发。

## 人格与情绪（影子模式 / 注入、DSH 插件）

- `src/persona*.js` 从对话里判读情绪、关系变化与行为倾向，维护每个角色的人格状态（大五、后天性格、好恶与关系），模型只判断「发生了什么」，变多少由代码决定。
- 先以**影子模式**只记录判读结果、不改回复；确认稳定后，可把人格与关系状态注入唤醒提示（配置/控制台开关）。
- `dsh/agent-presets/qq-chat-v2` 与 `plugins/qq-agent-presets` 是 DSH 侧的 preset / Cordis 插件，负责把角色卡、人格状态与记忆片段拼进提示词。
- 判读状态放在 `state/persona/`，日志不写聊天原文。

## 记忆代谢（FSRS 遗忘曲线）

- `src/memory-decay.js` 给账本条目、显著的聊天消息与日记算一个「牢固度」，采用 FSRS-5 的 S / D / R 模型。
- 越久不被想起越淡；低于 `decay.freezeBelow`（缺省 0.5）就冻结：不再自动想起、注入时不带，但工具永远查得到，查到一次即解冻。
- 被顺利想起（忽然想起、更新条目）或费劲想起（工具查到）都会提高牢固度；`reviewCooldownMs` 内重复想起只算一次。
- 只存数字状态（`state/memory-decay.json`），不存原文；核心条目与未了结的约定不参与冻结。

## 主动想起与生活回路

- `src/life-loop.js` 每分钟检查账本里到期的约定，到点主动去私聊提醒她（每人每天 1 次，全局每天上限可配）。
- own-life 的静默唤醒会补上她最近写的日记和一条「忽然想起」的旧事；素材只取主人私聊、公开的账本条目和她自己的日记，不碰群聊存档。
- 每次唤醒最多 1 条、每个活动日 2 条、同一条 7 天内不重复；安静时段（`lifeLoop.quiet`）不投递。

## 联想

- 在向量记忆的摘要与实体关系之上再加两路检索：按摘要找、顺着人和事走一步（`/recall`、`/associate`）。
- 唤醒时按当前来信悄悄算出「本来会想起哪件旧事」：`memoryRag.recall.mode=shadow` 只记录分数，`on` 才注入。
- own-life 里「忽然想起」可顺着实体关系再带出一件相关旧事；只走主人私聊的记忆，被带出的一条有冷却且不占每日额度。

## 账本建议

- 提炼器在写摘要的同一次调用里顺带抽「关于在场某人、值得长期记的事」，作为候选存进 memory-rag。
- 这个会话下次唤醒时，桥接去掉已有、过期、出现太多次的候选，按重要性挑几条给她看；记不记由她用 `qq_ltm_remember` 自己定。
- 参数：`memoryRag.suggest.mode / perWake / maxShows / ttlHours / timeoutMs`；控制台可看候选状态与采用率。

## 每日报表

- `src/daily-report.js` 与控制台「每日报表」页：按天列出收发、被唤醒次数、工具调用、记忆与花费、服务状态和说话习惯。
- 今天的数字现算，以前的读每天凌晨存下的「只有数字」的快照；全部从现有文件统计，不调模型、不花钱。

## systemd 用户服务

- `scripts/systemd/` 可把桥接、memory-rag、embedding 装成 systemd 用户服务（`install.sh`），崩溃自动拉起、登录后自启。
- `start-all.sh` / `stop-all.sh` 检测到对应 unit 时用 `systemctl --user` 操作；没装时退回原来的 nohup 方式，行为不变。

## 远程 TTS

- `src/tts-api.js` 与控制台支持 OpenAI 风格 / MiMo 等远程 TTS 的预置音色、文字描述音色、语音克隆与自定义模板。
- 请求头/请求体模板按原文发送，不做二次序列化；克隆样本与试听缓存放在 `state/tts-api/`。
- 独立语音工具在仓库上一级的 `../voice-tool/`；`voice-config.example.json` 是本仓库的配置样例，复制成 `voice-config.json` 后填入自己的参考音频（后者已被 `.gitignore` 排除）。

## 怎么跑起来

- **Node**：`package.json` 要求 `>= 22.13`，推荐使用 Node 24。
- **配置**：复制 `config.example.json` 为 `config.json`，至少填 `snowluma`、`dsh`、`ownerQQ`、`allow`。本分支新增的可选项在 `memoryRag`、`decay`、`lifeLoop` 三段，均带缺省值与 `_comment` 说明；不写也能启动。
- **向量记忆**：Python 3.12 + `uv`，在 `sidecars/memory-rag` 下建 `.venv` 并 `pip install -e . pytest`；embedding 用 `llama.cpp` 的 `llama-server` 跑 Qwen3-Embedding（缺省端口 8091），memory-rag 自身监听 8093。也可以把 `embedding.provider` 改成 `api`，走 OpenAI 兼容接口。`START_RAG=1 ./start-all.sh` 会连向量记忆一起起，`./start-all.sh --rag` 只起这两个服务。
- **运行时数据**：全部在 `state/`（聊天存档、账本、人格、记忆代谢、报表快照、令牌等），已在 `.gitignore` 中排除，**绝不提交**。
- **测试**：`npm run test:suggest`、`test:assoc`、`test:report`、`test:r2-audit`、`test:decay`、`test:persona`、`test:life-loop`、`test:ltm-forget`、`test:rag-bridge`、`test:ltm-search`、`test:mcp-history-search`、`test:regressions`、`test:issues`、`test:hardening`、`test:mcp-servers`、`test:role-card`、`test:token`；sidecar 测试用 `sidecars/memory-rag/.venv/bin/python -m pytest -q`。
