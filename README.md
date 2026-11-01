# 🐟 BigFatFish · 有长期记忆的 QQ 陪伴 AI

**Brain with External Multi-Layer Memory** —— 让 AI 像一个真实的朋友一样待在你的 QQ 里：记得你说过的事、会慢慢忘、有自己的脾气，还会主动来找你。

基于 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT）改造，大脑用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，QQ 收发靠 [SnowLuma](https://github.com/SnowLuma/SnowLuma)。

**中文** | [English](README.en.md)

---

## ✨ 项目特点

| | 能力 | 一句话说明 |
| --- | --- | --- |
| 💬 | **像真人一样聊天** | 不是有问必答的客服：她自己看消息、决定接不接话、什么时候潜水，会发表情、拍一拍、发语音 |
| 📒 | **记得住** | 每个人一本「账本」（喜好、经历、约定），聊天记录永久存档；隔了几周问「上次说想去哪来着」也能翻出来 |
| 🔎 | **语义检索** | 向量 + 关键词混合检索，换个说法也能找到；每段聊天自动提炼成一句话摘要和人物关系 |
| 🌫️ | **会遗忘** | 按「遗忘曲线」算每件事记得多牢，久不提的会淡，再被提起又想起来，像人一样 |
| 🎭 | **有性格和情绪** | 被夸会高兴、被损会嘴硬，对每个人的亲近程度不一样，性格随相处慢慢变化（可先「只观察不生效」） |
| ⏰ | **会主动** | 有「自己的时间」，会忽然想起一件旧事；答应过的约定到期了会主动来提醒 |
| 🧩 | **会联想 & 帮她记事** | 想起一件事时顺着人和事带出相关的另一件；聊完自动整理出「值得记住的事」，由她自己决定记不记 |
| 🖥️ | **可视化控制台** | 浏览器里看她记得什么、心情如何、花了多少钱，开关每个功能；**用到的 API 在「API 管理」一页填完**（含记忆服务的总开关）；还有每日报表 |
| 🔒 | **安全、数据在本地** | 白名单才响应、工具白名单、敏感信息拦截；聊天记录和记忆只存在你自己的电脑上 |

新增功能的详细说明见 👉 **[docs/FORK_FEATURES.md](docs/FORK_FEATURES.md)**

---

## 🧭 它是怎么跑起来的

```
你的 QQ 好友 / 群
      │  消息
      ▼
 Linux QQ（一个 QQ 小号）
      │  SnowLuma 把 QQ 消息转成程序能读的格式（OneBot）
      ▼
 qq-bridge（本项目，:3100 控制台）──── 记忆服务 memory-rag（可选，:8093）
      │                                     └─ embedding：本地显卡 或 云端 API
      ▼
 DeepSeek Harness（DSH，:3080）──── DeepSeek API（她的「大脑」）
```

一共要装 4 样东西：**DSH**（AI 本体）、**QQ + SnowLuma**（收发 QQ）、**本项目**（把两边连起来，加上记忆和人格），以及可选的**记忆服务**。下面一步一步来。

---

## 🚀 部署教程（Linux，第一次大约 1 小时）

> 本教程按作者实际在跑的环境写（Ubuntu + Linux QQ）。[windows教程](https://github.com/y083245/dsh-memory-brain/tree/windows-native)，见 [完整说明](docs/guides/FULL_GUIDE.md)；记忆服务和一键脚本只在 Linux 上测过。
>
> 下面所有命令都在**终端**里输入（Ubuntu 按 `Ctrl + Alt + T` 打开）。`#` 开头的是说明，不用输入。

### 第 0 步：准备清单

- [ ] 一台能长期开机的 **Linux 电脑**（推荐 Ubuntu 22.04 及以上，有桌面，因为 QQ 要扫码登录）
- [ ] 一个**专门给 AI 用的 QQ 小号**（⚠️ 不要用大号，第三方客户端有被风控的风险）
- [ ] 一个 **DeepSeek API 密钥**：到 [platform.deepseek.com](https://platform.deepseek.com) 注册、充值几块钱、创建 API Key（形如 `sk-...`，只显示一次，先存好）
- [ ] （可选）一张 **10 GB 显存以上的 NVIDIA 显卡**，用来在本地跑记忆服务的 embedding；没有也没关系，可以用云端 API 或者先不开记忆服务

### 第 1 步：安装 Node.js 24

```bash
# 安装 nvm（Node 版本管理器），装完关掉终端重新打开一个
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

# 安装 Node.js 24 并检查版本
nvm install 24
node -v        # 显示 v24.x.x 就对了
```

### 第 2 步：安装并启动 DSH（AI 本体）

```bash
# 装指定版本（本项目在 0.2.1-rc.3 上测过；装更新的版本可能不兼容）
npm install -g @deepseek-ai/dsh@0.2.1-rc.3

# 启动（这个终端窗口保持开着）
dsh web --no-open
```

用浏览器打开 <http://127.0.0.1:3080>，按提示点「**添加 API Key**」（或者打开「**设置 → 模型**」），在「API 密钥」里填入第 0 步的 DeepSeek 密钥并保存。能在网页里和它正常聊天，这一步就成功了。

### 第 3 步：安装 QQ 和 SnowLuma（让程序能收发 QQ 消息）

**3.1 安装 Linux QQ 3.2.32**

> ⚠️ **必须是 3.2.32**。更新的 3.2.34 会让 SnowLuma 2.2.0 注入失败。官网只提供最新版，旧版可以在 [Rodert/qq-versions](https://github.com/Rodert/qq-versions) 这类存档里找到 `QQ_3.2.32_…_amd64_01.deb`（第三方存档，下载后请自行核对来源和校验值）。

```bash
sudo apt install ./QQ_3.2.32_*_amd64_01.deb

# 防止 QQ 自动升级到不兼容的版本
echo "127.0.0.1 qqpatch.gtimg.cn" | sudo tee -a /etc/hosts
```

打开 QQ，用**小号**扫码登录，保持 QQ 开着。

**3.2 安装并启动 SnowLuma**

1. 到 [SnowLuma Releases](https://github.com/SnowLuma/SnowLuma/releases) 下载 Linux 版（`SnowLuma-v2.2.0-linux-x64-lite` 这类名字的压缩包），解压到比如 `~/snowluma/`。
2. 给 Node 一个「读取其它程序」的权限（SnowLuma 要靠它接入 QQ，只需做一次；**以后升级或重装 Node 后要重新做**）：

   ```bash
   sudo setcap cap_sys_ptrace=ep "$(readlink -f "$(which node)")"
   ```

3. 启动 SnowLuma（这个终端窗口保持开着）：

   ```bash
   cd ~/snowluma/SnowLuma-v2.2.0-linux-x64-lite
   node ./index.mjs
   ```

4. 用浏览器打开日志里给出的 WebUI 地址（一般是 <http://127.0.0.1:5099>），用日志里的**初始密码**登录，按提示：同意条款 → 改密码 → 接入已登录的 QQ。
5. 在 WebUI 的 OneBot 设置里打开两项，并记下端口和令牌（accessToken）：
   - **WebSocket 服务端**（默认端口 `3001`）
   - **HTTP API**（默认端口 `3000`）

> SnowLuma 是独立的第三方项目，请阅读它的 EULA；按其条款，本项目**不会**替你下载、安装或启动 SnowLuma，这一步需要你自己完成。

### 第 4 步：安装本项目

```bash
git clone https://github.com/y083245/dsh-memory-brain.git
cd dsh-memory-brain
npm install
cp config.example.json config.json
```

用文本编辑器打开 `config.json`（例如 `nano config.json`），改这几处：

```jsonc
{
  "ownerQQ": 10001,                     // 你自己（主人）的 QQ 号
  "allow": {
    "private": [10001],                 // 允许和她私聊的 QQ 号（至少填上你自己）
    "groups": [20001]                   // 允许她说话的群号（不想进群就留空 []）
  },
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",     // 第 3.2 步的 WebSocket 端口
    "httpUrl": "http://127.0.0.1:3000", // 第 3.2 步的 HTTP API 端口
    "accessToken": "HTTP API 的令牌"     // 没设令牌就留空 ""
  }
}
```

> 白名单留空时她**谁都不理**（这是故意的安全默认值），所以一定要至少填上你自己的 QQ 号。
> WebSocket 和 HTTP API 的令牌可能不一样，`accessToken` 填 HTTP API 的那个即可，WebSocket 的令牌桥接会自己发现。

把本项目的聊天模式和工具装进 DSH，**然后重启 DSH**（回到第 2 步那个终端，按 `Ctrl + C`，再执行一次 `dsh web --no-open`）：

```bash
node scripts/setup-dsh.mjs
```

> 漏了这一步或没重启 DSH，QQ 上会**完全没反应**——这是最常见的坑。

### 第 5 步：启动并测试 🎉

```bash
# 先测试本项目和 DSH 能不能连通（会建一个临时测试会话，跑完自动清理）
npm run self-test

# 正式启动（这个终端窗口保持开着）
npm start
```

日志里看到 `SnowLuma 已连接` 和 `DSH 已就绪` 就成功了。现在用你自己的 QQ 给小号发一句「在吗」，等她回复。

打开**控制台**（新开一个终端执行，复制输出的网址到浏览器）：

```bash
echo "http://127.0.0.1:3100/?token=$(cat state/console-token)"
```

> 如果 Linux 电脑在别的地方（远程服务器），在你自己的电脑上先执行 `ssh -L 3100:127.0.0.1:3100 用户名@服务器地址`，再用同样的网址打开。

到这里，基础的「QQ 里的 AI 朋友」已经跑起来了。下面都是**可选**的增强功能。

---

### 第 6 步（可选）：开启人格与情绪

1. 打开控制台 →「**API 管理**」页 →「人格判读」卡片，填入 DeepSeek 密钥（可以和 DSH 用同一个），保存。
2. 回到「**人格与情绪**」页，按页面提示**确认出厂性格**，然后打开「启用」。
3. 先让它跑两三天「**影子模式**」（只观察、不影响她说话），在页面上看判读得准不准。
4. 觉得没问题，再勾选「**注入给她**」，她的情绪和性格就会开始影响说话了。

### 第 7 步（可选）：开启记忆服务 memory-rag

开了之后她能「换个说法也想得起来」，还会自动整理聊天摘要、联想、给她提「值得记住的事」。

<details>
<summary><b>点这里展开安装步骤</b></summary>

**7.1 安装 Python 环境**（用 [uv](https://docs.astral.sh/uv/)）

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh     # 装完重新打开终端
cd sidecars/memory-rag
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e .
```

**7.2 选一种 embedding（把文字变成向量的模型）**

三种方式走的都是 **OpenAI 兼容的 `POST /v1/embeddings` 接口**，在控制台「**API 管理**」页 → RAG 卡片里选（**先打开 RAG 开关才能填**）：

- **本项目自带 llama.cpp（有 NVIDIA 显卡、≥ 10 GB 显存）**：装好 [llama.cpp](https://github.com/ggml-org/llama.cpp)，从 [Qwen/Qwen3-Embedding-8B-GGUF](https://huggingface.co/Qwen/Qwen3-Embedding-8B-GGUF) 下载 `Qwen3-Embedding-8B-Q8_0.gguf`，然后启动（保持开着）：

  ```bash
  llama-server -m /path/to/Qwen3-Embedding-8B-Q8_0.gguf \
    --embedding --pooling last --host 127.0.0.1 --port 8091 -ngl 99 -c 8192 -ub 8192
  ```

  控制台里选「本项目自带 llama.cpp」即可（这也是缺省，`config.yml` 不用改）。装了第 8 步的 systemd 服务后，RAG 开关会连它一起启停。

- **自己部署的本地服务（Ollama / LM Studio / vLLM / 你自己的 llama.cpp）**：例如 Ollama 先 `ollama pull bge-m3`，控制台里选「我自己部署的本地服务」，地址填 `127.0.0.1:11434`、模型填 `bge-m3`，点「测试连接」（会自动填好维度）再保存。**只能填本机地址**（`127.0.0.1` / `localhost` + 端口）；RAG 开关不会去启停你自己的服务。

- **没有显卡 → 云端 API**（硅基流动、阿里百炼、智谱、OpenAI 等提供 OpenAI 兼容 embedding 的服务）：选「云端 API」，填 https 地址（例如 `https://api.siliconflow.cn/v1`）、模型和密钥，测试连接后保存。⚠️ 这样聊天内容会发给该服务商。

  各家的地址、维度、每批条数上限见控制台「API 管理」页顶部的「兼容性说明」或 [memory-rag 的说明](sidecars/memory-rag/README.md)。注意：阿里百炼 `text-embedding-v4` 一次最多 10 条，要在「高级 → 每批条数」改成 10。换模型需要全量重建向量库，页面会先提示再自动做。

**7.3 启动并打开 RAG 开关**

记忆服务有一个**总开关**（`config.json` 的 `memoryRag.enabled`，**缺省是关**）：关着时桥接根本不去连它，检索用普通的关键词。

- **装了第 8 步的 systemd 服务**：控制台「API 管理」页打开 RAG 开关就行，它会把记忆服务（和自带的 embedding）拉起来，页面上能看到「启动中 → 运行中」；关掉会停服务、释放显存（数据都留着）。
- **没装**：`./start-all.sh --rag` 起服务并打开开关；或者自己在 `sidecars/memory-rag` 目录下运行 `.venv/bin/python -m memory_rag.app`（保持开着），再去控制台打开开关。

聊天摘要和「值得记住的事」默认用第 6 步「人格判读」那把 DeepSeek 密钥来提炼（每天几毛钱）；想换一家或单独计费，在「API 管理」→「话题提炼」里取消「和人格判读用同一个 API」再填。

</details>

### 第 8 步（可选）：一键启动、崩溃自动重启

<details>
<summary><b>点这里展开</b></summary>

- `./start-all.sh`：按顺序启动 DSH → QQ → SnowLuma → 本项目；RAG 开关开着时连记忆服务一起起（`--rag` = 只起记忆服务并打开开关；`./stop-all.sh --rag` = 停掉并关上开关）。脚本开头的程序路径是作者本机的，请按你的安装位置改，或用 `DSH_DIR`、`SNOW_DIR`、`QQ_BIN` 等环境变量覆盖。
- `scripts/systemd/install.sh`：把本项目和记忆服务装成 systemd 用户服务，崩溃自动拉起；加 `--enable` 开机自启（QQ 仍需人工扫码登录）。

</details>

---

## ❓ 常见问题

| 现象 | 原因和解决 |
| --- | --- |
| QQ 上发消息她完全没反应 | ① 没跑 `node scripts/setup-dsh.mjs` 或跑完没重启 DSH；② 白名单里没有你的 QQ 号；③ 看 `npm start` 那个窗口的日志有没有报错 |
| 她回「agent 处理出错」 | DSH 没配好 DeepSeek 密钥或余额不足，回第 2 步检查「模型」页 |
| SnowLuma 接入 QQ 失败 | 多半是 QQ 版本不是 3.2.32，或者 Node 没有第 3.2 步的权限（升级 Node 后要重新 `setcap`） |
| 日志出现 `SnowLuma 错误：{}` / `1006` | 正常现象：首次连接时桥接在自动修正 WebSocket 令牌，随后会显示「已连接」 |
| 报 HTTP 426 | `httpUrl` 填成了 WebSocket 的端口，改成 HTTP API 的端口 |
| 「API 管理」页 RAG 显示「部分可用」 | 记忆服务在跑，但 embedding 没起来：看状态后面的原因（显存不足、没装 llama.cpp / 模型、地址或模型名填错）；修好前检索自动只用关键词 |
| 开了代理（Clash 等 fake-ip 模式）后她看不到图片 | 在代理的 `fake-ip-filter` 里加上 `+.qq.com`、`+.qq.com.cn`、`+.qpic.cn`、`+.gtimg.cn` |

更多「已知行为」和排查方法见 [完整说明](docs/guides/FULL_GUIDE.md)。

---

## 📚 更多文档

| 想了解 | 去看 |
| --- | --- |
| 新增功能的详细说明（记忆、人格、遗忘、主动、联想、报表…） | [docs/FORK_FEATURES.md](docs/FORK_FEATURES.md) |
| 配置项全表、运行模式、控制台功能、运维、已知行为 | [docs/guides/FULL_GUIDE.md](docs/guides/FULL_GUIDE.md) |
| 记忆服务 memory-rag（接口、遗忘与重建、embedding 选择） | [sidecars/memory-rag/README.md](sidecars/memory-rag/README.md) |
| DSH 端安装细节（preset 与 MCP 怎么挂上去） | [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md) |
| 控制台「令牌与花费」看板 | [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md) |
| 安全承诺 / 安全基线 / 隐私 | [RULES.md](RULES.md) · [SECURITY_BASELINE](docs/guides/SECURITY_BASELINE.md) · [PRIVACY](docs/guides/PRIVACY.md) |
| 仓库目录结构 | [docs/FOLDER_MAP.md](docs/FOLDER_MAP.md) |

---

## 🙏 致谢与许可

- 上游项目 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT），本仓库保留其全部提交历史与版权声明
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[SnowLuma](https://github.com/SnowLuma/SnowLuma)、[Chroma](https://github.com/chroma-core/chroma)、[llama.cpp](https://github.com/ggml-org/llama.cpp)、[Qwen3-Embedding](https://huggingface.co/Qwen)
- 许可证：[MIT](LICENSE)

> **合规提醒**：SnowLuma 是独立第三方项目，与腾讯 / QQ 无隶属关系。本项目仅供学习与技术研究，使用前请阅读 SnowLuma 的 EULA 与《QQ 用户协议》，风险自负。
