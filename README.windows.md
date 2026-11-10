# 🪟 Windows 原生安装与部署（简版）

> 适用于 **Windows 10/11**，**不使用 WSL**。
> Linux（systemd）部署请看主 [README.md](README.md)。

> 🤖 **让 AI 帮你部署**：把 [docs/guides/WINDOWS_AI_DEPLOY.md](docs/guides/WINDOWS_AI_DEPLOY.md) 发给 AI，里面写了完整命令、验证方法和排错。
>
> 🧰 **想自己一步步手动起每个服务**（每个服务一个窗口，方便看日志）：看 [docs/guides/WINDOWS_MANUAL_DEPLOY.md](docs/guides/WINDOWS_MANUAL_DEPLOY.md)。

一句话流程：**装好 DSH → 用 SnowLuma 注入 QQ 并开好 OneBot → 双击 `start-all.bat`**。
`start-all.bat` 会自己装依赖、生成配置、把 QQ 预设 / MCP 装进 DSH、连上 DSH（网页版或桌面版都行）、
找到 SnowLuma 的 token，最后拉起桥接并确认两头都连通。

---

## 一、准备这些东西

| 需要 | 说明 |
|---|---|
| Node.js 22.13+（建议 24） | <https://nodejs.org/>，装完 `node -v` 能看到版本号；自带 npm |
| DeepSeek Harness（DSH） | **桌面版**或**网页版**二选一，见下 |
| QQNT + QQ 小号 | **不要用大号**，第三方工具存在风控风险 |
| SnowLuma | 自己到 [SnowLuma Releases](https://github.com/SnowLuma/SnowLuma/releases) 下载 Windows 包（`SnowLuma-v*-win-x64.zip`），解压到任意目录 |
| Git | 用来 clone 本项目（也可以直接下载 zip） |
| 可选：Python 3.12 + uv | 只有要开向量记忆 memory-rag 时才需要 |

### DSH 用哪个版本？都可以

| | 桌面版（DeepSeek Harness 安装包） | 网页版（`dsh web`） |
|---|---|---|
| 怎么装 | 下载[官方安装包](https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe) | `npm install -g @deepseek-ai/dsh@latest` |
| API 地址 | 每次启动**随机端口**，桥接按进程自动找到 | 固定 <http://127.0.0.1:3080> |
| 模型 | 在桌面版里登录 DeepSeek 账号（或填 API Key） | 浏览器打开 3080 →「设置 → 模型」登录账号 / 填 API Key |
| `start-all.bat` 怎么用它 | 桌面版**开着**就直接用桌面版 | 桌面版没开时，自动起 `dsh web`（装了桌面版也能用它自带的 dsh） |

- 默认是自动挑：**桌面版开着就用桌面版，否则用 / 启动 `dsh web`**。想固定一个：`start-all.bat --desktop` 或 `start-all.bat --web`
  （或在 `config.json` 里写 `"dsh": { "target": "desktop" }` / `"web"`）。
- 两个版本各用各的 profile（`profiles\desktop` / `profiles\web`），`start-all.bat` 会**两个都装好** QQ 预设和 MCP，随时换版本都不用重装。
- 桥接运行中途切换 / 重启 DSH（端口变了）也没关系，桥接会自动重新发现并重连。

---

## 二、用 SnowLuma 注入 QQ（自己操作）

1. 安装 QQNT，用小号登录，保持 QQ 开着。
2. 打开 SnowLuma（双击 `launcher.bat` 或 `SnowLuma.exe`），浏览器进 SnowLuma WebUI（一般是 <http://127.0.0.1:5099>），按引导同意条款、改密码、**注入 QQ**。
3. 在 SnowLuma 的 OneBot 网络配置里确认这两个服务**都已启用**（SnowLuma 默认会为每个账号建好）：
   - **HTTP 服务端**：`127.0.0.1:3000`（桥接发消息、MCP 工具都走它）
   - **WebSocket 服务端**：`127.0.0.1:3001`（桥接收消息走它）
4. SnowLuma 窗口保持开着。

> token 不用手抄：`start-all.bat` 会从 SnowLuma 的 `config\onebot_<QQ号>.json` 里找到能用的 HTTP / WebSocket token
> 并写回 `config.json`。它会通过「正在监听 3001 的进程」自动找到 SnowLuma 目录；找不到时会在窗口里问你目录。
> 端口不是 3000 / 3001 时，把 `config.json` 的 `snowluma.httpUrl` / `snowluma.wsUrl` 改成实际地址。

---

## 三、安装本项目并一键启动

```bat
git clone https://github.com/y083245/dsh-memory-brain.git
cd dsh-memory-brain
start-all.bat
```

第一次运行时 `start-all.bat` 会：

1. 自动 `npm ci` 安装依赖；
2. 没有 `config.json` 就从示例生成，并在窗口里**问你的 QQ 号**（作为管理员，并加进私聊白名单）；
3. 把 QQ 预设 / MCP 装进 DSH 的 `web` 和 `desktop` 两个 profile；
   如果桌面版 / `dsh web` 当时正开着，会问你是否让它**自动重启一次** DSH（不重启加载不到新预设）；
4. 连上 DSH（见上面的「用哪个版本」），并检查 DSH 里有没有可用的模型——没有会直接告诉你去哪里登录 / 填 Key；
5. 等 SnowLuma 的 OneBot（WebSocket 3001 / HTTP 3000）就绪——**还没注入好也没关系，它会等你最多 5 分钟**；
6. 拉起 qq-bridge，确认「SnowLuma 已连接」和「DSH 已就绪」都出现。

看到 `全部就绪` 后，用你自己的 QQ 给机器人小号发一条私聊，例如「在吗」，收到回复就成功了。
桥接控制台在 <http://127.0.0.1:3100/>，令牌在 `state\console-token`；控制台里的其它功能自行探索。

日志和 PID 文件都在：

```text
%USERPROFILE%\.ai-companion-run\
```

> 白名单为空时机器人**谁都不理**，这是故意的安全默认值。之后加人：编辑 `config.json` 的 `allow.private` / `allow.groups`，或在控制台里填。

---

## 四、停止 / 重启 / 更新

```bat
stop-all.bat            rem 停桥接（和向量记忆）；QQ、SnowLuma、DSH 都保留
stop-all.bat --all      rem 连本脚本起的 dsh web 一起停（桌面版是你自己开的，不会被关）
start-all.bat           rem 重新启动（已经在跑的环节会自动跳过）
```

QQ 和 SnowLuma 由你自己管理，`stop-all.bat` 不会关它们。

更新代码后：

```bat
git pull
start-all.bat
```

`start-all.bat` 每次都会重新同步 DSH 里的预设 / MCP，有改动会提示重启 DSH。

> `start.bat` 是旧版的「桥接守护」，只负责 `src/bridge.js` 崩溃自动重启；完整一键编排请用 `start-all.bat`。

---

## 五、可选：开启向量记忆 memory-rag

Windows 首次开启 RAG 时会检查 Python 3.12+ 和项目依赖。环境缺失时，启动器会使用 PATH 中已安装的 `uv` 准备项目虚拟环境。首次下载可能需要几分钟。也可以手动安装：

```bat
cd sidecars\memory-rag
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe -e .
cd ..\..
start-all.bat --rag
```

也可以在控制台「API 管理」页打开 RAG 开关。本地 embedding 需要 **≥ 10 GB 空闲显存**，不够时检索会退回关键词（BM25）。「云端 API」只替代本地向量模型，本机仍运行 Python RAG 服务。启动失败时先查看控制台原因，Python 进程日志默认在 `%USERPROFILE%\.ai-companion-run\memory-rag.log`。停止服务用 `stop-all.bat --rag`。

---

## 六、常见问题

| 现象 | 处理 |
|---|---|
| `start-all` 一直「等待 SnowLuma 的 OneBot 服务」 | SnowLuma 还没注入 QQ，或 OneBot 的 HTTP / WebSocket 服务没启用。按第二节检查；端口不是 3000/3001 就改 `config.json` 的 `snowluma.httpUrl` / `wsUrl` |
| 提示「OneBot HTTP 鉴权失败」/「WebSocket 拒绝了所有候选 token」 | 没找到 SnowLuma 目录。在 `config.json` 的 `snowluma.homeDir` 填 SnowLuma 解压目录；或把 SnowLuma 网络配置里的 token 分别填进 `snowluma.accessToken`（HTTP）和 `snowluma.wsAccessToken`（WebSocket） |
| 提示「DSH 里还没有可用的模型」 | 桌面版：在桌面版里登录 DeepSeek 账号或在「设置 → 模型」填 API Key；网页版：浏览器打开 <http://127.0.0.1:3080> 同样操作。填完不用重启 |
| QQ 回复「agent 处理出错」 | 先看上一条（多半是没有模型）；再看 `%USERPROFILE%\.ai-companion-run\bridge.log` |
| 提示「正在运行的 DSH 要重启一次才会加载」 | 第一次装或更新后正常。选 Y 让脚本自动重启；选 N 就自己完全退出 DSH（桌面版要在托盘里退出）再打开，然后重跑 `start-all.bat` |
| 想固定用桌面版 / 网页版 | `start-all.bat --desktop` / `start-all.bat --web`，或 `config.json` 里 `dsh.target` 写 `desktop` / `web`（默认 `auto`） |
| 找不到 DSH | 桌面版装在非常规位置时设 `QQ_BRIDGE_DSH_BIN` 指向它的 `resources\runtime\cli\bin\dsh.cmd`；或者先手动打开桌面版再跑 `start-all.bat` |
| 机器人不回某个人 | 他不在白名单：`config.json` 的 `allow.private` / `allow.groups`，或控制台「访问与安全」页 |
| 开着 Clash 等系统代理 | 桥接对 127.0.0.1 的请求一律不走代理，无需设置 |

更多排查见 [完整说明](docs/guides/FULL_GUIDE.md) 与 [AI 部署手册](docs/guides/WINDOWS_AI_DEPLOY.md)。

---

## 双击 `start-all.bat` 窗口一闪就没了？

新版的窗口不会自己关（报错后会停在「按任意键继续」）。如果还是一闪而过：

1. 确认是**解压后**运行的，不是在压缩包里直接双击；
2. 打开 `cmd`，`cd` 到项目目录，手动运行 `start-all.bat`，把输出发出来；
3. 看 `%USERPROFILE%\.ai-companion-run\start-all.log`，这份日志每次运行都会写。

老的 `windows-native` 分支已经合进 `main` 并删除。之前从那个分支 clone 的，运行一次：

```bat
git fetch origin
git switch -C main origin/main
start-all.bat
```
