# memory-rag

qq-bridge 的向量记忆索引服务。方案见 [`docs/design/RAG_MEMORY_PLAN.md`](../../docs/design/RAG_MEMORY_PLAN.md)（v3），这里是 P0：
聊天存档 → 时间分段 + 话题切块 → Chroma（块向量）+ SQLite FTS5（jieba / BM25）双写 → 两路 RRF 检索。

只读 `state/long-memory/archive/`，派生数据都在 `state/long-memory/rag/`（目录 700、文件 600），随时可删可重建。

## 依赖

- embedding 服务：`llama-server` 跑 Qwen3-Embedding-8B（约占 9 GB 显存）

  ```bash
  ~/llama.cpp/build/bin/llama-server -m /path/to/Qwen3-Embedding-8B-Q8_0.gguf \
    --embedding --pooling last --host 127.0.0.1 --port 8091 -ngl 99 -c 8192 -ub 8192
  ```

- Python 3.12 venv（`uv`）。如果直连 PyPI 很慢或超时（例如开着 Clash 的 fake-ip 模式），装依赖时加上你的代理地址：

  ```bash
  cd ~/qq-bridge/sidecars/memory-rag
  uv venv --python 3.12 .venv
  uv pip install --python .venv/bin/python -e . pytest
  # 需要代理时：HTTPS_PROXY=http://127.0.0.1:<代理端口> uv pip install --python .venv/bin/python -e . pytest
  ```

  Windows 原生（不是 WSL）用 `.venv\Scripts\python.exe`：

  ```bat
  cd /d %USERPROFILE%\qq-bridge\sidecars\memory-rag
  uv venv --python 3.12 .venv
  uv pip install --python .venv\Scripts\python.exe -e . pytest
  ```

  `start-all.bat` / 控制台 RAG 开关会自动解析这个路径；没有 venv 时依次回退 `py`、`python`、`python3`。
  本地 llama-server 在 Windows 上是 `llama-server.exe`，路径用 `EMBED_BIN` / `EMBED_MODEL` 或 `config.json` 的 `orchestrator` 段指定。

## embedding 用本地还是 API

`config.yml` 的 `embedding.provider` 决定向量从哪来，**缺省 `local`**（本机 `llama-server`），
不改配置就是本地模式。

- `provider: local`：原有那几项（`base_url / model / dim / instruct / append_eos / batch / timeout_s`）照旧；
  需要本机 `llama-server`（`qq-embedding`）跑着。
- `provider: api`：走任意 OpenAI 兼容的 `/embeddings` 接口（OpenAI、硅基流动、阿里百炼等），
  读 `embedding.api` 子段（模板见 `config.yml` 里注释掉的那一段）。

切换只改一行配置，密钥文件放好就能起：

```yaml
embedding:
  provider: api
  api:
    base_url: https://api.example.com/v1   # 请求 {base_url}/embeddings
    model: your-embedding-model
    dim: 1024
    key_file: long-memory/rag/embedding-api.json   # 相对 state_dir
```

```bash
# state/long-memory/rag/embedding-api.json，内容只有一行密钥；权限设 600
mkdir -p ../../state/long-memory/rag
printf '{"apiKey": "…"}' > ../../state/long-memory/rag/embedding-api.json
chmod 600 ../../state/long-memory/rag/embedding-api.json
```

密钥**只从这个文件读**（相对 `state_dir`），不读环境变量、不进日志 / 异常 / `/health`。改了文件内容不用重启，
按文件 mtime 自动生效。`base_url` 必须是 `https://`（只有本机回环地址允许 `http://`）——聊天原文不能明文发出去。
`send_dimensions: true` 只对支持 `dimensions` 参数的模型有用；`instruct` 是查询前缀，Qwen3 系列可以填和本地一样的指令，
其它模型留空；`append_eos` 一般关掉。

**切换 provider（本地 ↔ API）或换模型 / 改 `dim` 之后，必须全量重建**：两种模式的「向量口径」字符串不同
（API 模式带 `api:` 前缀），服务启动时发现库里的口径和当前配置对不上会直接进入 `mismatch`（503，提示全量重建），
不会把两种向量混在一个库里。重建用 `POST /rebuild`、`python -m memory_rag.cli rebuild` 或控制台「全量重建」，
会把所有块和摘要重新算一遍向量——**API 模式下这一步要花钱**，切片多的话先估一下调用量。

- **API 模式下可以不启动本地 `qq-embedding`**（`start-all.sh` 的 `--rag` 会按显存条件拉起它；
  用 API 时可以只起 memory-rag）。
- **隐私**：API 模式下，每个话题块的原文、每块提炼出的摘要、以及检索时的查询语句都会发给第三方服务商。
  存档和账本仍然只在本地。

## 接哪些 embedding 服务（兼容性）

三种部署方式（本项目自带 / 自己部署 / 云端）走的是同一个接口：**OpenAI 兼容 `POST {baseUrl}/embeddings`**，
请求 `{"model": ..., "input": [...], "encoding_format": "float"}`（支持截短的模型可加 `dimensions`），
返回 `data[].embedding`。地址与模型在控制台「API 管理 → RAG → 向量模型」里填；下面是能接的范围。

### 本项目自带

llama.cpp 的 `llama-server`，固定 `127.0.0.1:8091`，启动参数 `--embedding --pooling last`
（Qwen3-Embedding 必须带 `--pooling last`）。归 `qq-embedding` 服务管，随 RAG 开关启停。

### 自己部署（只能填本机回环地址）

控制台里只填 **`127.0.0.1:<端口>`**（`localhost` 也行），地址会自动补成 `http://127.0.0.1:<端口>/v1`；
模型名必须填服务里真实存在的名字（Ollama 要先 `ollama pull`）。明文 http 只允许回环地址，
免得聊天原文在网络上裸奔。

| 服务 | 默认地址 | 说明 |
| --- | --- | --- |
| Ollama | `127.0.0.1:11434` | `/v1/embeddings` 必须带 `model`；有 `/v1/models`；没有 `/health` |
| LM Studio | `127.0.0.1:1234` | 启动本地服务器后填模型名 |
| vLLM | `127.0.0.1:8000` | 用 OpenAI 兼容的 embedding 模型起服务 |
| llama.cpp `llama-server` | 自定端口 | 加 `--embedding`；Qwen3-Embedding 再加 `--pooling last` |

### 云端（必须 https）

| 服务 | 地址 | 模型与限制 |
| --- | --- | --- |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `BAAI/bge-m3`（1024 维）；`Qwen/Qwen3-Embedding-8B` / `4B` / `0.6B`；只有 Qwen3 系列支持 `dimensions` |
| 阿里百炼（兼容模式） | `https://<业务空间ID>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | `text-embedding-v4` 每批最多 **10** 条；`qwen3.7-text-embedding` 每批最多 **20** 条——「高级 → 每批条数」要改小 |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `embedding-3`，默认 2048 维（可选 256 / 512 / 1024 / 2048），每批最多 **64** 条 |
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` / `-large`，支持 `dimensions` 改小 |

以服务商文档为准（2026-10-31 核对）。

**接不了**：只有自家原生接口的服务（如 Gemini、Cohere 原生）；DeepSeek 没有 embedding 模型。

### 换模型与重建

- 维度只能在支持截短的模型上改小（Qwen3-Embedding、OpenAI text-embedding-3、百炼 text-embedding-v4 等）；
  `bge-m3` 这类必须用原生 1024。
- 换部署方式 / 模型 / 维度 / 查询指令前缀 → 向量口径变了，必须**全量重建**（控制台保存时会提示并自动重建）。
- 选云端 = 每个话题块的原文、摘要和检索查询都会发给该服务商；存档与账本仍只在本地。

### 设置文件

一般由控制台写，不用手改：

- `state/long-memory/rag/embedding-settings.json`（600，不含密钥）：部署方式与参数；
  文件不存在时按 `config.yml` 的 `embedding.provider` 走旧行为。
- `state/long-memory/rag/embedding-api.json`（600）：`{"apiKey": "<云端>", "localApiKey": "<本地可选>"}`。
- 设置文件坏了（不是合法 JSON、字段非法、本地地址不是回环等）时服务照常启动，向量路降级为 BM25，
  `/health` 的 `embedding.error` 写原因类别，不会删改向量库。

## 用法

```bash
.venv/bin/python -m memory_rag.cli index                 # 增量索引一次
.venv/bin/python -m memory_rag.cli rebuild               # 删库重建（换模型、改维度、改切块参数后）
.venv/bin/python -m memory_rag.cli search private:100000001 "他之前说想吃什么" -k 火锅 想吃
.venv/bin/python -m memory_rag.cli health
.venv/bin/python -m memory_rag.app                        # HTTP 服务，127.0.0.1:8093，每 60 秒增量索引
.venv/bin/python -m pytest -q                             # 单测（假 embedding，不需要 GPU）
.venv/bin/python eval/run.py                              # 评估集跑分（用例在 state/long-memory/rag/eval/cases.jsonl）
```

Windows 把 `.venv/bin/python` 换成 `.venv\Scripts\python.exe` 即可，例如：

```bat
.venv\Scripts\python.exe -m memory_rag.app
.venv\Scripts\python.exe -m pytest -q
```

## HTTP 接口

| 接口 | 说明 |
| --- | --- |
| `GET /health` | embedding 状态、向量口径、块数、各会话未入库条数、上次索引结果；P2 起还有 `job`（最近一次重建任务，没跑过是 `null`）与 `forget_requests`（还没处理的遗忘请求的会话 key） |
| `POST /index/run` | 立即增量索引（口径不一致 503） |
| `POST /search` | `{key, query, keywords?, from?, to?, speaker?, k?, expand?}`；`key` 必填，否则 400；该会话有遗忘请求又拿不到索引锁时 503 |
| `POST /forget` | `{key}` → `{ok, key, removed_chunks}`；key 不合法 400、口径不一致 503、等锁超时 409「索引正忙，稍后重试」 |
| `POST /rebuild` | 后台全量重建，202 `{ok, job}`；已有任务在跑时 409「已有重建任务在进行」。口径不一致时也能调（这正是它的用途） |

## 遗忘与重建（P2）

### 墓碑（存档删除的写法）

桥接删一条消息不是真的删行，而是把那一行**原地改写成等长墓碑**：内容是 `{"deleted": true}`，
后面用 ASCII 空格补齐，使这一行的字节数与原来完全相同（行尾 `\n` 保留）。

```
{"t": "2026-10-01T20:00:00+08:00", "dir": "in", "userId": "111", "name": "平安", "text": "…", "msgId": null}
{"deleted": true}{"…补齐到与原来等长的空格…"}
```

这样行号、后续各行的字节偏移、以及本服务按字节记的水位都不会错位。所有读存档的地方都跳过
`deleted === true` 的行（`archive.read_rows`），但仍计行号，所以 `file/line` 与 `cat -n` 对得上。
注意墓碑**不改变文件大小**，所以检索缓存（`RowCache`）的签名带上了 `st_mtime_ns`，
遗忘时还会显式 `invalidate(key)`——只看大小会把已删内容继续扩进检索结果。

### 遗忘请求文件

桥接删完存档后写 `state/long-memory/forget-requests/<group_号|private_号>.json`（原子替换，文件 600、目录 700）：

```json
{"key": "private:123", "at": 1730000000000}
```

同一个会话再删一次就覆盖（`at` 变新）。本服务对每个请求做「遗忘」：删掉该会话的全部块与向量、
删掉它的水位、清掉检索缓存；之后照常增量索引会从存档开头重建这个会话（墓碑被跳过）。

- 消费时机：每 60 秒的定时循环每轮先处理请求再增量索引；`POST /search` 发现该 key 有待处理请求时
  就地处理（拿不到索引锁则 503，桥接降级为关键词检索）；`POST /forget` 处理对应请求。
- **处理完只在文件里的 `at` 没变时才删文件**：处理期间桥接又写了新请求，就留到下一轮。
- 本服务没在运行时文件就留着，服务起来后自动处理——删存档不会因为索引服务停着而漏掉向量库。
- 坏文件、文件名与 `key` 不符的请求跳过（不删，stderr 打一行说明）。

### 重建任务

`POST /rebuild` 在后台线程里跑：记下当前所有遗忘请求的 `at` 快照 → `rebuild()`（删派生数据）→
`indexer.run(blocking=True)` 全量重建 → 把 `at` 没变的请求文件删掉（全量重建已覆盖它们）。
任务状态写在 `/health` 的 `job` 里：

```json
{"kind": "rebuild", "started_at": 1730000000000, "finished_at": null, "chunks": null, "error": null}
```

`error` 是异常 `repr`，没出错是 `null`；从没跑过时 `job` 为 `null`。

### 派生库里不留已删原文

墓碑只管住了存档这一层，派生数据也得一并清干净，否则 `/forget` 之后原文还躺在磁盘上：

- **Chroma 只存向量和 `key / t_start / t_end`**（`store.VectorStore.upsert` 不再传 `documents`，
  metadata 也只留过滤要用的三个字段）。原因：Chroma 的预写日志（`embeddings_queue` 表）会长期保留
  每次 upsert 的完整载荷，删块只追加一条删除记录，旧载荷里的块原文、说话人这些照样能用 SQL 读出来。
  检索时 Chroma 本来就只用来按向量找 `chunk_id`，原文和元数据都从 `rag.sqlite3` 读。
- **`rag.sqlite3` 开了 `PRAGMA secure_delete=ON`**：删除时把释放的页和单元清零，不留在空闲页里。
- **遗忘后整理 FTS 并截断 WAL**（`fts.ChunkDB._purge`）：`optimize` 把 FTS5 的段合并成一个，
  被删文档的词条随之消失；`PRAGMA wal_checkpoint(TRUNCATE)` 把 WAL 写回主库并截断成 0 字节，
  删掉旧页面副本。`clear()`（全量重建）还会再 `VACUUM` 一次，彻底重写主库文件。

**升级注意**：P2 早期版本建出来的 Chroma 里存过块原文，光升级代码不会把它清掉。升级后要停掉
memory-rag，删掉 `state/long-memory/rag/` 下的 `chroma/`、`rag.sqlite3`、`rag.sqlite3-wal`、
`rag.sqlite3-shm` 和 `watermarks.json`（**不要删 `eval/`**，里面是评估用例），再启动服务让它从存档重建。

## 模块

| 文件 | 作用 |
| --- | --- |
| `memory_rag/archive.py` | 读存档（只读）、固定称呼 |
| `memory_rag/embeddings.py` | llama.cpp 客户端：查询加指令前缀、补 EOS、截断后重新归一化 |
| `memory_rag/segmenter.py` | 30 分钟分段 + 话题低谷切块，每块 3～15 条 |
| `memory_rag/fts.py` | 块表 + FTS5（jieba 分词、OR 查询、bm25） |
| `memory_rag/store.py` | Chroma 块向量；向量口径写进集合 metadata，不一致拒绝服务 |
| `memory_rag/indexer.py` | 字节偏移水位的增量索引，写成功才推进水位 |
| `memory_rag/search.py` | 块向量 + 块 BM25 + 进行中消息临时打分 → RRF → 扩展上下文 |
| `eval/run.py` | 评估：旧关键词基线 vs 新检索各配置的 recall@k / MRR / 延迟 / 隔离 |

## 提炼层（P3）

话题块一结束，提炼线程就用 DeepSeek 写一句摘要、抽出一段里真实出现的人 / 地方 / 东西 / 话题，
以及它们之间的关系。检索与联想（P2）都在这层之上，这里只负责「写进去」。

### 数据表（`rag.sqlite3`，与 `chunks` 同库、同一把锁）

| 表 | 内容 |
| --- | --- |
| `summaries` | 每块一条：标题、摘要、重要性、情绪色彩、模型名、`vec_state`；摘要挂「块编号 + 块原文哈希」 |
| `summaries_fts` | 摘要的全文索引（jieba 分词），给 `bm25_summaries` 用 |
| `entities` | 实体：`qq:<号>` / `self` / `<type>:<规范名>`，类型 person / place / thing / topic |
| `summary_entities` | 哪条摘要提到了哪个实体，**每行带会话 key**（从群里的点只能走到群里的摘要） |
| `relations` | 摘要里实体之间的关系（两端都是实体编号） |
| `distill_state` | 每块的提炼进度：失败次数、下次重试时间、错误类别（不改 `chunks` 表结构） |

块自身的状态在 `chunks.distilled`：`pending` / `done` / `failed`（试满 3 次）/ `skipped`（块太短）。
`chunks.title` 由提炼回填，并重写这一块的 `chunks_fts`——标题里的词也能找回这块。

### 提炼流程（`memory_rag/distill.py`）

每 60 秒的定时循环在「消费遗忘请求 → 增量索引」之后跑一次 `Distiller.run_once()`：

1. **对账**：块被重写过（`ChunkDB.upsert` 会把状态重置成 `pending`）时，若同块、同原文哈希的摘要
   还在，直接把状态改回 `done`、回填标题，**不调模型**；原文变了就删掉旧摘要（及其向量），重新提炼。
2. **补摘要向量**：`vec_state='pending'` 的摘要重新算向量（embedding 不可用就跳过，下一轮再补）。
3. **读密钥**：见下。没有密钥本轮就到此为止。
4. **挑块**：`distilled='pending'` 且到了重试时间的块，按 `t_end` 从早到晚，一轮最多 `per_round` 块。
   少于 2 条消息、或去掉表情标点后正文不足 `min_chars` 字的块标 `skipped`，不调模型。
5. **调模型**：一次一块，`POST {baseUrl}/chat/completions`，固定 system 提示词（逐字不变，命中前缀缓存）、
   `response_format={"type":"json_object"}`、`temperature=0.3`、`max_tokens=600`。
   调模型期间**不持索引锁**（否则会挡住遗忘）；写库前再核对块还在、原文没变，不满足就丢弃这次结果。
6. **校验**（规格 §4.4）：`title` 2～16 字、`summary` 6～120 字且不含换行，任一不合格整条失败；
   实体名必须在块原文或在场称呼里真的出现过（防编造），关系两端必须是留下来的实体。
7. **实体解析**：她 → `self`；在场的人 → `qq:<号>`（同一个人换群名片还是同一个点）；其它 → `<type>:<规范名>`。

失败按 1 次 10 分钟、2 次 1 小时、3 次标 `failed` 退避；`POST /distill/retry`（P2 加）可手动重试。
每日上限 `distill.daily_limit`，按本地日期计，**跨重启累加**（从 `distill-usage.json` 读回当天计数）。

### 密钥从哪读

**只读** `state/persona/config.json`（相对 `state_dir`，即 `distill.key_file`）里的 `apiKey`——
复用人格判读那把，本服务只读不写、不读环境变量、不读 `~/.dsh`。`baseUrl` / `model` 也取自该文件的
`settings.appraisal`（缺省 `https://api.deepseek.com`、`deepseek-flash`），`config.yml` 的 `distill.model`
优先。密钥不进任何日志、异常、`/health`。

### 配置项（`config.yml`）

```yaml
distill:   { enabled: true, key_file: persona/config.json, self_names: [], model: null,
             daily_limit: 300, per_round: 20, timeout_s: 30, min_chars: 10,
             price: { cache_hit: 0.02, cache_miss: 1, output: 4 } }
recall:    { tau: 0.55, exclude_recent_hours: 12, min_chars: 4, stopwords: [...] }
associate: { min_age_days: 2 }
```

`self_names` 是她在聊天里可能被叫的别的名字（昵称、角色名），模型给出这些名字时也归到 `self`。
`price` 是元 / 百万 token，记账用。

### 怎么看状态

`GET /health` 的 `distill` 字段（只有数字与错误类别，不含原文与密钥）：

```json
{"enabled": true, "key": true, "model": "deepseek-flash", "summaries": 0, "pending": 0,
 "failed": 0, "skipped": 0, "vec_pending": 0, "entities": 0, "relations": 0,
 "today": {"calls": 0, "ok": 0, "failed": 0, "cost": 0.0}, "daily_limit": 300, "last_error": null}
```

用量另存 `state/long-memory/rag/distill-usage.json`（600，只追加按天的 `calls / ok / failed /
cacheHit / cacheMiss / output / cost`，保留 60 天）。删派生库时它是唯一的例外之一（另一个是 `eval/`）：
删了就等于把日上限和花费记录清零。

### 遗忘、重建与向量库

- **遗忘**（`ChunkDB.delete_key`）：同一事务删该会话的块与 L2 全部行（摘要、FTS、实体关联、关系、
  提炼进度），再删孤儿实体（实体名本身可能就是隐私），最后两张 FTS 都 `optimize`、WAL 截断；
  `VectorStore.delete_key` 两个集合都按 key 删。派生库里不留已删原文。
- **全量重建**（`Indexer.reset`）：只清 L1（块、块向量、水位），L2 与摘要向量保留，靠第 1 步对账挂回；
  重建跑完后 `prune_orphans()` 清掉挂不回去的摘要与孤儿实体。
- **摘要向量集合 `summaries`**：只放向量和 `key / t_start / t_end`，**不存 documents**（摘要文字只在
  SQLite）。口径不一致或集合被删时，启动时把摘要全部标成 `vec_state='pending'`，从 SQLite 重算向量，
  不调模型、不花钱。

## 检索四路与自动想起

RAG_PATCH（P3）第二层：检索在 ① 块向量、② 块 BM25、进行中消息之外多了 ③ 摘要向量、④ 关系图，
五路一起做 RRF（`routes` 缺省全开，`debug` 里能看到每一路召回多少条）；`/recall`、`/associate`、
`/summaries` 是给桥接（唤醒时自动想起 / 联想链）与控制台用的三个新接口。返回给调用方的摘要文字
一律按会话 `key` 过滤，没有「不带 key 查 L2」的路径。

### 检索的两条新路（`memory_rag/search.py`）

- **③ `summary`**：用 ① 已经算好的查询向量查摘要集合（`where key`、同样的时间过滤），取前 20 条
  摘要按名次换成各自的 `chunk_id`；embedding 不可用时这一路为空（`semantic="unavailable"`）。
- **④ `graph`**：先看 ①②③ 与进行中消息合并后的前 5 块提到谁，并上 `query` / `keywords` 里直接出现的
  实体名，去掉**枢纽点**；再在同一会话里找挂在种子上的摘要（不含种子块自己），得分
  `Σ ln(1 + N / df)`（`N`、`df` 都只数本会话），按得分、再按新近取前 20 → `chunk_id`。只走 1 跳。
- **枢纽点**（`l2.hubs_for_key`）：`self`（所有会话共有），私聊再加对方本人 `qq:<号>`——私聊里每一块都
  提到他，连着一切、区分不了话题。群会话只去掉 `self`，群里的每个人只出现在部分话题里，是有信息量的。

### 新接口（都只监听 127.0.0.1，`key` 必须是 `group:<号>` 或 `private:<号>`）

| 接口 | 说明 |
| --- | --- |
| `POST /recall` | `{key, texts[], k?, now?}` → `{key, skipped, tau, candidates[], inject[]}`。唤醒时自动想起：拿最近 1～3 条来信找旧事摘要 |
| `POST /associate` | `{key, text?, t?, people?, exclude?, min_age_days?, k?, now?}` → `{key, items[]}`。联想链：顺着种子实体再走一步 |
| `POST /summaries` | `{key, ids[]}` → `{key, items[]}`，控制台按编号取摘要文字；不属于该 key 的不返回 |
| `POST /notes` | `{key, since_ms?, limit?}` → `{key, items[]}`；本会话的账本建议候选（桥接下发给她的提示词用），按 `created_at` 降序、`limit` 夹到 1～200 |
| `POST /notes/backfill` | `{hours?, dry_run?}` → `{queued, dry_run}`；把最近 `hours`（1～168，缺省 72）小时内、还没抽过候选的摘要标成排队，真正回补在提炼循环里跑 |
| `POST /distill/retry` | `{}` → `{ok, retried}`；把提炼失败的块改回待提炼，不需要 key |

- 三个按会话查的接口与 `/search` 一样：`key` 非法 400、向量口径不一致 503、该会话有待处理的遗忘请求
  就先处理（拿不到索引锁 503，桥接降级），之后才读 L2；`svc.l2` / `svc.distiller` 为 `None` 时 503。
- 参数裁剪在 app 层做：`texts` 只留最后 3 条、每条 500 字；`text` 500 字；`people` 至多 5 个纯数字 QQ 号；
  `exclude` 至多 200 个；`ids` 至多 100 个；`k` 夹到 1～5（`/recall` 缺省 2、`/associate` 缺省 3）。

### `/recall` 的门槛（`memory_rag/recall.py`）

- **短句不查**：每条来信去掉 emoji、标点、空白后少于 `recall.min_chars`（4）个字，或整句在
  `recall.stopwords` 里（在吗、嗯、哈哈、晚安、早、早安、好的、收到、ok、行……可配置）→ 丢掉；
  全丢掉返回 `skipped: "trivial"`。本会话还没有摘要是 `skipped: "no_summaries"`。
- 查询 = 剩下的来信拼起来；**排除 `t_end` 在 `recall.exclude_recent_hours`（12 小时）内的摘要**——
  那些还在 DSH 的上下文里，不用再提醒。
- 三路信号：摘要向量余弦（前 20）、摘要 BM25（`summaries_fts`，前 20）、关系图（来信里直接出现的实体，
  去掉枢纽点，得分同 ④）。三路做 RRF（k=60）取前 5 条候选。
- **通过门槛**：`cosine ≥ recall.tau`（初值 0.55）**且**三路里至少两路命中；`inject` 是按顺序前 `k` 个
  通过的摘要编号。影子 / 开由桥接的配置决定，本服务只负责算。

### `/associate` 的口径

- 种子 = `text` 里直接出现的实体 ∪ `qq:<people>` ∪（给了 `t` 时）覆盖 `t` 的那条摘要所挂的实体，
  再减掉枢纽点；没有种子就返回空列表（不是错误）。
- 候选排除：`exclude` 里的、覆盖 `t` 的那条、`t_end` 在 `min_age_days`（缺省取 `config.yml`）内的；
  得分同 ④，`score ≤ 0` 不返回；按（得分降序、`t_end` 降序）取前 `k` 条，`via` 是共享实体的显示名
  （至多 3 个，给提示词用）。
- 联想链不调用记忆代谢的复习接口、不占生活回路每天的回忆次数（规格 A4-a）。
