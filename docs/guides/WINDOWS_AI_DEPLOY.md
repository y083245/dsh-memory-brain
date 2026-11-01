# Windows 原生部署 —— 给 AI 的操作手册

> 目标读者：**代替用户在 Windows 10/11 原生环境（不是 WSL）部署、验证、排错本项目的 AI**。
> 面向人的简版说明见 [README.windows.md](../../README.windows.md)。
>
> 本文基于 2026-11-01 在本机（Windows 11、Node 24.22、DSH 0.2.1-rc.5 桌面版、QQNT 9.9、SnowLuma 2.2.0 win-x64-lite）的真实全链路部署整理。

---

## 0. 先读：不可越过的约定

1. **不要在没有备份的情况下改用户真实的 `%USERPROFILE%\.dsh`**。`setup-dsh.mjs` 会改 `profiles/web`、插件链接和 MCP 配置。
2. **不要把 `.credentials.yaml`、SnowLuma accessToken、DSH 启动 token、控制台 token 打进日志或聊天记录**。
3. **不要把测试配置、真实 `config.json`、`state/`、`.venv` 提交进仓库**（都已在 `.gitignore`）。
4. Windows 的 GUI QQ 需要**可交互桌面会话**；无桌面（如 Session 0 / 无 explorer）时 QQ 会启动后退出，这不是脚本 bug。
5. `scripts/systemd/` 只适用于 Linux；Windows 用 `~/.ai-companion-run/*.pid` + `taskkill /T`。
6. 不要用 Git Bash 直接调 `tasklist /FI ...`：MSYS 会把 `/FI` 转成路径（`E:/Git/FI`）。用 Node 的 `findPidsByImage()` 或 PowerShell。

---

## 1. 前置检查

```bat
node -v
npm -v
where dsh
dsh --version
python --version
py -0p
nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader
```

期望：

- Node `>= 24`（项目 `engines` 要求 `>=22.13`，但实测用 24）。
- `dsh` 在 PATH 中。桌面版通常是：
  `%ProgramFiles%\DeepSeek Harness` 或类似目录下的 `resources\runtime\cli\bin\dsh.cmd`。
- Python 3.12 仅 RAG 需要；3.14 下部分依赖没有轮子，建议用 uv 拉 3.12。
- 本机 6 GB 显存时 embedding 会被跳过（阈值 10 GB），RAG 只走 BM25。

检查端口（用 Node，不要依赖 `ss`/netstat）：

```bat
node -e "const net=require('net');for(const p of [3080,3000,3001,5099,3100,8091,8093]){const s=net.connect({port:p,host:'127.0.0.1'});s.setTimeout(400);s.once('connect',()=>{console.log(p,'OPEN');s.destroy()});s.once('timeout',()=>{console.log(p,'free');s.destroy()});s.once('error',()=>console.log(p,'free'))}"
```

---

## 2. 备份 DSH 用户层

```bat
set BK=%USERPROFILE%\dsh-backup
mkdir "%BK%\profiles" "%BK%\plugins" 2>nul
xcopy "%USERPROFILE%\.dsh\profiles\web" "%BK%\profiles\web" /E /I /H /Y
copy "%USERPROFILE%\.dsh\.credentials.yaml" "%BK%\" >nul
xcopy "%USERPROFILE%\.dsh\plugins" "%BK%\plugins" /E /I /H /Y
```

> 真实的 `profiles/web` 通常很小；`profiles/desktop` 可能包含 Electron 运行时，不必整体备份。

---

## 3. 安装/更新本项目

```bat
git clone https://github.com/y083245/dsh-memory-brain.git
cd dsh-memory-brain
npm ci
copy config.example.json config.json
```

如果需要隔离测试 DSH，设置临时 `DSH_HOME`（不要用真实配置）：

```bat
set DSH_HOME=E:\temp\dsh-test-home
mkdir "%DSH_HOME%"
copy "%USERPROFILE%\.dsh\.credentials.yaml" "%DSH_HOME%\" >nul
```

---

## 4. DSH 端

### 4.1 运行 setup-dsh（真实部署）

```bat
set DSH_HOME=%USERPROFILE%\.dsh
node scripts\setup-dsh.mjs
```

它做三件事：

1. 从 `dsh/agent-presets/` 生成 `plugins/qq-agent-presets/presets/*.patch.yml`；
2. 把 `qq-mode-console` / `qq-agent-presets` 链接进 `profiles/web`；
3. 把 3 个 MCP server 写入 `profiles/web/cordis.patch.yml`，并尝试 `dsh plugin --profile web install`。

看到 `dsh plugin --profile web install: OK` 即成功。**装完必须重启 DSH**。

> **MCP 的 `command` 是一个长期有效的 node 绝对路径**（DSH 每次启动都按它拉进程）。
> setup 会自己避开临时/沙箱 node，并在选不干净时打印：
>
> ```text
> ⚠️ 当前 node 位于临时/便携目录，可能被宿主回收，届时 DSH 里所有 MCP 都会启动失败
> ```
>
> 看到这句就先装系统版 Node，或用 `QQ_BRIDGE_NODE_BIN` 指定后再重跑 setup。
> 同理，`dsh` CLI 不在 PATH 里时可用 `QQ_BRIDGE_DSH_BIN` 指向 `dsh.cmd`。

### 4.2 模型 provider（配错就完全收不到回复）

`config.json` 的 `dsh.provider` 必须在当前 DSH 的模型目录里，否则会得到：

```text
session/model-unavailable: Select an available model before sending a message.
```

**不要照抄文档里的 provider 名字**——它取决于 DSH 装了什么账号/provider。先查（DSH 起好之后）：

```bat
node -e "import('./src/dsh-client.js').then(async m=>{const a=new m.NodeApiClient('http://127.0.0.1:3080');const c=m.unwrap(await a.callUnary('session/modelCatalog',{}),'catalog');console.log(c.default,c.routableProviders)})"
```

本机（2026-11-01，DSH 0.2.1-rc.5 web profile）实测输出：

```text
{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } [ 'deepseek-official' ]
```

别的机器常见 `deepseek-account` / `deepseek-flash`。把查到的值写进 `config.json`：

```jsonc
"dsh": {
  "provider": "deepseek-official",
  "model": "deepseek-flash",
  "reasoningEffort": "max"
}
```

新版桥接会在 `ensureChatModel()` 里读 `session/modelCatalog`，不匹配时临时回退到目录默认值并打印：

```text
config.json 的 DSH 模型 xxx/yyy 不在当前 DSH 目录中；本次临时改用 <目录默认>/<默认模型>
```

### 4.3 启动 DSH

```bat
dsh web --no-open
```

或让 `start-all.bat` 启动。验证：

```bat
node -e "fetch('http://127.0.0.1:3080').then(r=>console.log(r.status)).catch(e=>console.log('ERR',e.message))"
```

> ⚠️ **不要用桌面版 GUI 代替 `dsh web`**：桌面版 GUI 的 API 绑定在**随机端口**上
> （实测 62662），不监听 3080；桥接只认 `config.json` 的 `dsh.baseUrl`（默认 3080）。
> 只开 GUI 的结果是控制台 `dshReady:false`、`连接 DSH 事件流…` 后立刻
> `DSH 事件流已结束（本次收到 0 帧）`。GUI 可以和 `dsh web` 同时开着，互不影响（不同 profile）。

> 桌面版 `dsh.cmd` 是 Electron 启动器（含 `ELECTRON_RUN_AS_NODE=1` 和 `DeepSeek Harness.exe`）。
> 桥接的 `commandSpec()` 已识别这类垫片并回退 `cmd.exe`；如果手工启动，直接调 `dsh.cmd` 即可。
> `dsh` 不在 PATH 时不需要手工配：`findDshCli()` 会按
> PATH → `%ProgramFiles%`/`%LOCALAPPDATA%\Programs` 下的 `DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`
> → 各盘 `deepseek-harness\...` 的顺序找；也可用 `QQ_BRIDGE_DSH_BIN` 显式指定。

---

## 5. QQ 与 SnowLuma

### 5.1 QQNT

- QQNT 必须运行在**可交互桌面会话**；扫码登录。
- 如果 QQ 使用自定义数据目录（例如 `E:\QQ_file`），用：

```bat
start "" "E:\qq-nt\QQ.exe" --user-data-dir="E:\QQ_file"
```

- 不要用 `tasklist` 判断是否在跑；用项目自带 Node 方法：

```bat
node -e "import('./src/runtime/process.mjs').then(async m=>console.log(await m.findPidsByImage('QQ.exe')))"
```

### 5.2 SnowLuma

1. 解压 `SnowLuma-v*-win-x64-lite.zip` 到例如 `C:\SnowLuma`。
2. 把已有的 `config` 目录一并放进去（需要保留 `onebot_<QQ号>.json`）。
3. **自动注入 QQ 只能靠环境变量 `SNOWLUMA_HOOK_AUTOLOAD`，不能改 `config\runtime.json`**：

```bat
set SNOWLUMA_HOOK_AUTOLOAD=1
node "C:\SnowLuma\index.mjs"
```

> 实测（2026-11-01，SnowLuma 2.3.3 win-x64-lite）：把 `runtime.json` 的 `hookAutoLoad` 改成
> `true`，SnowLuma 启动时会把它重写回 `false`，日志里也不会出现
> `hook auto-load enabled`，QQ 永远挂不上，OneBot 3000/3001 不起。
> 环境变量优先于 `runtime.json` 且不会被重写，是唯一可靠的启动器侧开关。
> `start-all.bat` / `scripts/start-all.mjs` 起 SnowLuma 时已经默认注入该变量（用户显式设置则尊重用户值）。

关键是这个开关**只影响启动那一刻之后发现的 QQ 进程**：QQ 先登录、SnowLuma 后启动，必须开着它，
否则 SnowLuma 不会回头去挂已经运行的 QQ。

4. 启动：

```bat
node "C:\SnowLuma\index.mjs"
```

或由 `start-all.bat` 启动。日志检查：

```text
[Hook] login detected: PID=... UIN=...
[OneBot.HTTP] listening 127.0.0.1:3000
[OneBot.WS-Server] listening 127.0.0.1:3001
```

> SnowLuma 是第三方组件，**不要自动下载/部署**；按 EULA 由用户自行安装。本项目只启动用户已经放好的目录。

---

## 6. 业务配置 `config.json`

最小可用：

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
  },
  "orchestrator": {
    "snowDir": "C:/SnowLuma",
    "qqBin": "C:/Tencent/QQNT/QQ.exe"
  },
  "memoryRag": {
    "enabled": false
  }
}
```

- `accessToken` 留空时，桥接会从 `homeDir/config/onebot_<uin>.json` 自动发现并写回 `config.json`。
- `allow` 为空时桥接**拒绝所有消息**（fail-closed）。
- `memoryRag.enabled` 想开 RAG 时设 `true`，或在控制台打开开关。
- 路径优先级：环境变量 > `orchestrator` 配置 > 平台默认值（自动探测）。
- 自动探测范围（`orchestrator.qqBin` / `snowDir` 留空时生效）：
  - QQ：`%ProgramFiles%\Tencent\QQNT`、`%LocalAppData%\Programs\Tencent\QQNT`，以及 **C:–H: 各盘根目录**下的 `QQ\QQ.exe`、`Tencent\QQNT\QQ.exe`、`Program Files\Tencent\QQNT\QQ.exe`（装在 `D:\QQ` 这类非系统盘也能找到，不需要手工配）。
  - SnowLuma：`%SNOWLUMA_HOME%`、`%USERPROFILE%\snowluma`、`%USERPROFILE%\SnowLuma`、home 所在盘根、以及 C:–H: 各盘根目录下的 `SnowLuma` / `snowluma`；再按版本号自然排序取最新。
- 只在 C:–H: 探测：A:/B: 是软驱位，I: 起更可能是移动盘或映射网络盘，`stat` 一个断开的网络盘会等 SMB 超时，把启动卡住几秒。

---

## 7. 启动全栈

```bat
start-all.bat
```

顺序：RAG（可选）→ DSH → QQ（已运行则跳过）→ SnowLuma → 等 OneBot 3000/3001 → qq-bridge。

成功后输出：

```text
全部就绪
  DSH              http://127.0.0.1:3080
  SnowLuma WebUI   http://127.0.0.1:5099
  桥接控制台       http://127.0.0.1:3100/
```

### 验证桥接

```bat
node -e "const fs=require('fs');const t=fs.readFileSync('state/console-token','utf8').trim();fetch('http://127.0.0.1:3100/api/status',{headers:{'x-console-token':t}}).then(r=>r.json()).then(j=>console.log(j.dshReady,j.snowluma))"
```

必须看到：

```text
true { connected: true, accountOnline: true, good: true }
```

### 验证真实业务

1. 用 `ownerQQ` 对应的账号给机器人小号发私聊「在吗」。
2. 观察桥接日志：

```bat
type "%USERPROFILE%\.ai-companion-run\bridge.log"
```

期望依次出现：

```text
会话 private:<owner> 已挂载 preset qq-chat-v2
已设置会话模型 ... -> deepseek-account/deepseek-flash
[reserved2] 工具统一发送 private:<owner>: 成功 1/1 条
```

3. 用户 QQ 应收到回复。若只有 `会话繁忙`，是在排队，等一下。

---

## 8. RAG（可选）

```bat
rem 没有 uv 时：python -m pip install uv
cd sidecars\memory-rag
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe -e .
cd ..\..
start-all.bat --rag
```

- `pyproject.toml` 已显式声明 `memory_rag` 包；`pip install -e .` 不应再报 flat-layout 错误。
- 本地 embedding 需要 ≥ 10 GB 空闲显存；不足时 `start-all --rag` 会跳过 embedding，memory-rag 仍然启动，检索走 BM25。
- memory-rag `/health` 在 embedding 未启动时可能要约 4 秒；代码健康请求超时已调到 10 秒。
- 停止：`stop-all.bat --rag`；控制台「API 管理」页的开关在 Windows 上走 PID 管理器（`mode: pid`）。

验证：

```bat
node -e "fetch('http://127.0.0.1:8093/health').then(r=>r.json()).then(j=>console.log(j.ok,j.embedding,j.store))"
```

---

## 9. 停止与清理

```bat
stop-all.bat            rem 停桥接 / RAG / SnowLuma / QQ，DSH 保留
stop-all.bat --all      rem 连 DSH 一起停
```

Windows 实现会：

- 先按 `%USERPROFILE%\.ai-companion-run\*.pid` 杀整棵子进程树（`taskkill /PID <pid> /T /F`）；
- 没有可信 PID 时，端口仍被占则提示“不是本脚本起的”，不误杀；
- 不要把 `start.bat` 当一键编排：它只是桥接守护。

---

## 10. 测试与 CI

```bat
npm test
```

- 跨平台 JS 单元测试；Windows 上会明确 SKIP 需要真实 DSH/QQ/浏览器/POSIX 权限的用例。
- Python：

```bat
cd sidecars\memory-rag
.venv\Scripts\python.exe -m pytest -q
```

- GitHub Actions（`.github/workflows/test.yml`）跑 4 个 job：Ubuntu/Windows 的 JS 单元测试 + memory-rag Python 测试。
- 需要真实 DSH/QQ/SnowLuma/浏览器的 e2e/probe 不在 CI 里。

---

## 11. 已知 Windows 坑（按出现频率）

| 坑 | 现象 | 处理 |
|---|---|---|
| DSH provider 不匹配 | `session/model-unavailable`，QQ 完全不回 | 按 §4.2 的 `session/modelCatalog` 查到 `default`，改 `dsh.provider` / `dsh.model`；新版桥接也会自动回退并提示 |
| MCP 全起不来 | DSH 日志只写「MCP 启动失败」 | 多半是 `cordis.patch.yml` 里的 `command` 指向了已被回收的临时/沙箱 node；重装系统 Node 后重跑 `node scripts\setup-dsh.mjs`（脚本会告警） |
| SnowLuma 不挂 QQ | OneBot 3000/3001 不起；日志只有 `awaiting login` 或什么都没有 | 用 `SNOWLUMA_HOOK_AUTOLOAD=1` 重启 SnowLuma（start-all 已默认注入）；改 `runtime.json` 会被重置，没用 |
| stop-all 后 start-all 卡在 OneBot | 同上，stop-all 杀了 QQ，新 QQ 没被挂上 | 已修：`start-all` 起 SnowLuma 时注入 `SNOWLUMA_HOOK_AUTOLOAD=1`；仍失败就扫码登录后重跑 start-all |
| Electron `.cmd` | 手工用 node 跑 `dsh.cmd` 的 JS 会缺 Electron 运行时 | 直接调 `dsh.cmd`；桥接已自动回退 `cmd.exe` |
| venv 路径 | “找不到 Python / memory-rag 虚拟环境” | 确认 `sidecars\memory-rag\.venv\Scripts\python.exe`；代码已修复传 `.venv` 目录 |
| 健康超时 | 服务已起但一直“未就绪” | Windows 上 /health 约 4s，代码超时已 10s；旧版本需升级 |
| 显存不足 | embedding 跳过 | 6～8 GB 显卡用云端 embedding；或接受 BM25 |
| Chroma 原始字节 | 已删摘要文本仍出现在 `data_level0.bin` 旧段 | 逻辑删除已由 API/ SQL 断言覆盖；Windows 测试跳过原始 Chroma 字节扫描 |
| 临时目录短路径 | CI 里 `RUNNER~1` vs `runneradmin` | 测试已用 realpath/normcase 比较 |
| 系统代理劫持本地请求 | 开了 Clash / v2ray，`HTTP_PROXY` 生效；本地 8091/8093 的请求被塞进代理，慢、报错，聊天原文出本机 | 新版 memory-rag 对**回环地址**一律 `trust_env=False`（远端 https 仍走代理）；桥接侧 Node fetch 默认不读代理变量 |
| 没有桌面会话 | QQ 启动后立即退出 | 在可交互桌面登录；扫码 |
| Git Bash 调 tasklist | `/FI` 被转成 `E:/Git/FI` | 用 Node `findPidsByImage()` 或 PowerShell |

---

## 12. 完成检查清单

- [ ] `node -v` ≥ 24
- [ ] `npm ci` 成功
- [ ] `node scripts\setup-dsh.mjs` 成功，并已重启 DSH
- [ ] `config.json` 的 `ownerQQ` / `allow.private` / `snowluma.homeDir` 正确
- [ ] SnowLuma 日志有 `login detected` 和 3000/3001 listening
- [ ] `start-all.bat` 输出「全部就绪」
- [ ] `/api/status` 返回 `dshReady=true`、`snowluma.connected=true`
- [ ] 真实私聊收到 AI 回复
- [ ] `stop-all.bat --all` 后端口全部释放
- [ ] 没有把 `config.json`、`state/`、`.venv`、token 提交进 git
