# 🪟 Windows 原生安装与部署（简版）

> 适用于 **Windows 10/11**，**不使用 WSL**。
> Linux（systemd）部署请看主 [README.md](README.md)。

> 🤖 **让 AI 帮你部署**：把 [docs/guides/WINDOWS_AI_DEPLOY.md](docs/guides/WINDOWS_AI_DEPLOY.md) 这份文档发给 AI，里面写了完整命令、验证方法和部署注意事项。

---

## 一、准备这些东西

| 需要 | 说明 |
|---|---|
| Node.js 24 | 到 <https://nodejs.org/> 安装，`node -v` 应显示 `v24.x` |
| DSH | 桌面版 DeepSeek Harness，或 `npm install -g @deepseek-ai/dsh@0.2.1-rc.3` |
| QQNT + QQ 小号 | 建议 3.2.32；**不要用大号**，第三方工具存在风控风险 |
| SnowLuma Windows 包 | 到 [SnowLuma Releases](https://github.com/SnowLuma/SnowLuma/releases) 下载 `SnowLuma-v*-win-x64.zip`，解压到例如 `C:\SnowLuma` |
| 可选：Python 3.12 + uv | 只有要开向量记忆 memory-rag 时才需要 |
| 可选：NVIDIA 显卡 ≥ 10 GB 显存 | 本地 embedding 需要；显存不够可以在控制台改用云端 API |

---

## 二、按顺序安装

### 1. 打开 DSH

桌面版直接打开 DeepSeek Harness；或者用命令行：

```bat
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
dsh web --no-open
```

浏览器打开 <http://127.0.0.1:3080>，在「设置 → 模型」里填 DeepSeek API 密钥。这个窗口保持开着。

### 2. 登录 QQ 和 SnowLuma

1. 安装 QQNT，用小号扫码登录，保持 QQ 开着。
2. 解压 SnowLuma 到 `C:\SnowLuma`，双击 `launcher.bat` 或 `SnowLuma.exe`。
3. 浏览器打开 SnowLuma WebUI（一般是 <http://127.0.0.1:5099>），按引导同意条款、改密码、接入 QQ。
4. 在 OneBot 设置里开启 **WebSocket 服务端（3001）** 和 **HTTP API（3000）**。

> ⚠️ 如果 **QQ 先登录、SnowLuma 后启动**，请把 `C:\SnowLuma\config\runtime.json` 里的 `hookAutoLoad` 改成 `true`，否则 SnowLuma 不会挂载已经运行的 QQ。

### 3. 安装本项目

```bat
git clone https://github.com/y083245/dsh-memory-brain.git
cd dsh-memory-brain
npm ci
copy config.example.json config.json
```

用记事本打开 `config.json`，至少改这三处：

```jsonc
{
  "ownerQQ": 你的QQ号,
  "allow": {
    "private": [你的QQ号],
    "groups": []
  },
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "",
    "homeDir": "C:\\SnowLuma"
  }
}
```

- `allow.private` 留空时她**谁都不理**，这是故意的安全默认值。
- `accessToken` 可以先留空，桥接会从 `homeDir` 下的 OneBot 配置里自动发现。
- SnowLuma 装在别处时，`homeDir` 改成实际目录。

### 4. 把 preset / MCP 装进 DSH，然后重启 DSH

```bat
node scripts\setup-dsh.mjs
```

装完必须重启 DSH（关掉 DSH 窗口再打开，或 `dsh web --no-open` 重新起）。

### 5. 一键启动

```bat
start-all.bat
```

它会按顺序启动 DSH → QQ → SnowLuma → 等 OneBot → qq-bridge。已经在跑的环节会自动跳过。

看到控制台地址后打开：

```text
http://127.0.0.1:3100/
```

用你自己的 QQ 给机器人小号发一条私聊，比如「在吗」，收到回复就成功了。

日志和 PID 文件都在：

```text
%USERPROFILE%\.ai-companion-run\
```

---

## 三、可选：开启向量记忆 memory-rag

```bat
cd sidecars\memory-rag
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe -e .
cd ..\..
start-all.bat --rag
```

或者在控制台「API 管理」页打开 RAG 开关。

- 本地 embedding 需要 **≥ 10 GB 空闲显存**；不够时会自动跳过，检索退回关键词（BM25）。
- 没有显卡：在控制台选「云端 API」，填一个 OpenAI 兼容的 embedding 服务即可。
- 停止向量记忆：`stop-all.bat --rag`。

---

## 四、停止 / 重启 / 更新

```bat
stop-all.bat            rem 停桥接、向量记忆、SnowLuma、QQ（DSH 保留）
stop-all.bat --all      rem 连 DSH 一起停
start-all.bat           rem 重新启动
```

更新代码后：

```bat
git pull
npm ci
node scripts\setup-dsh.mjs
```

然后重启 DSH。

> `start.bat` 是旧版的「桥接守护」，只负责 `src/bridge.js` 崩溃自动重启；完整一键编排请用 `start-all.bat`。

---

## 五、常见问题

| 现象 | 处理 |
|---|---|
| 日志出现 `session/model-unavailable` | 桌面版 DSH 的 provider 通常是 `deepseek-account`，把 `config.json` 的 `dsh.provider` 改成它；新版桥接会自动临时回退并提示 |
| QQ 已登录，但 OneBot 3000/3001 不起 | SnowLuma 的 `hookAutoLoad` 改为 `true` 后重启 SnowLuma，或先启动 SnowLuma 再登录 QQ |
| `start-all.bat` 报找不到 QQ | 设置 `QQ_BIN`，例如 `set QQ_BIN=C:\Program Files\Tencent\QQNT\QQ.exe`，或写进 `config.json` 的 `orchestrator.qqBin` |
| 控制台 RAG 开关不生效 | 看 `%USERPROFILE%\.ai-companion-run\memory-rag.log`；确认 `.venv\Scripts\python.exe` 存在 |
| 显存不足、embedding 不起 | 6～8 GB 显卡跑不动 8B embedding；用云端 embedding，或只走关键词检索 |

更多排查见 [完整说明](docs/guides/FULL_GUIDE.md)。

---

## 六、给 AI 看的部署文档

如果你想让 AI 直接替你部署、排错和验证，请把这份文档发给它：

👉 **[docs/guides/WINDOWS_AI_DEPLOY.md](docs/guides/WINDOWS_AI_DEPLOY.md)**

里面有：前置检查、每一步的精确命令、DSH provider 探测、SnowLuma 挂载、RAG 安装、验证清单、已知 Windows 坑和清理/回滚方法。
