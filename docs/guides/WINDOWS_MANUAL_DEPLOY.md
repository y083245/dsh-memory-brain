# Windows 手动部署（逐窗口手动模式）

> 本文**不使用** `start-all.bat` / `stop-all.bat`，每个服务你亲自开一个窗口起，
> 方便当场看到日志。整套流程在 Windows 11 + Node 24 + DSH 0.2.1-rc.5 桌面版 +
> QQNT 9.9 + SnowLuma 2.3.3 win-x64-lite 上逐条跑通。

---

## 路径约定（先读）

全文用 `%USERPROFILE%` 表示你的用户目录（C:\Users\你的用户名）：

| 东西 | 本文假设的位置 | 替换说明 |
|---|---|---|
| 本项目 | `%USERPROFILE%\qq_bridge\repo` | 装到别的盘就整篇替换，例如 `D:\qq_bridge\repo` |
| SnowLuma | `%USERPROFILE%\snowluma` | 解压到哪就写哪，**全篇一致** |
| QQNT | `%ProgramFiles%\Tencent\QQNT\QQ.exe` | 便携版自行换成实际路径 |
| DSH 桌面版 CLI | `%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` | 同上；`dsh` 在 PATH 里就不用管 |

- 上面的写法只在 **cmd 命令里**有效；PowerShell 里 `~` 等于 `%USERPROFILE%`。
- **`config.json` 里不能写 `%USERPROFILE%`**——那是给 shell 展开的，桥接不会展开。
  配置文件里一律写**真实的绝对路径**，例如 `C:/Users/你的用户名/snowluma`。

---

## 0. 先搞清链路

```text
QQ 客户端 ← SnowLuma(注入)   OneBot HTTP 3000 / WS 3001
                                   ↕
                          qq-bridge  src\bridge.js   控制台 3100
                                   ↕
                          DSH  dsh web               3080
                          ↓
                          AI 模型 → 回复 → QQ
```

桥接只认 **3080** 上的 DSH。**DSH 桌面版 GUI 不是这个**——它的 API 端口每次启动都随机，
只开 GUI 会出现控制台 `dshReady: false`、日志「DSH 事件流已结束（本次收到 0 帧）」。

> 机器上已经有一套服务在跑（比如之前用过 `start-all.bat`）时，先收掉：
>
> ```bat
> cd %USERPROFILE%\qq_bridge\repo
> stop-all.bat --all
> ```
>
> 然后从第 5 步开始。QQ 是唯一没法脚本替你登录的环节（可能要扫码）。

---

## 1. 前置检查

```bat
node -v
npm -v
where dsh
python --version
```

| 需要 | 期望 | 说明 |
|---|---|---|
| Node.js | `v24.x`（项目最低 22.13） | 必须是**系统安装版**，不要便携/沙箱 node |
| npm | 随 Node 一起 | |
| DSH | 桌面版或 `npm i -g @deepseek-ai/dsh` | `where dsh` 找不到**没关系**，脚本会自己找桌面版安装目录 |
| QQNT | 9.9 左右，小号 | 不要用大号 |
| SnowLuma | `SnowLuma-v*-win-x64-lite` 解压好 | 例如 `%USERPROFILE%\snowluma` |
| Python | 3.12（可选） | 只有开向量记忆 memory-rag 才需要 |

---

## 2. 装项目

```bat
git clone https://github.com/y083245/dsh-memory-brain.git %USERPROFILE%\qq_bridge\repo
cd %USERPROFILE%\qq_bridge\repo
npm ci
copy config.example.json config.json
```

`npm ci` 报错就先 `npm install`；`package-lock.json` 损坏就删掉重来。

---

## 3. 写 `config.json`

用记事本打开 `config.json`，至少这几项（`//` 注释不能写进真文件）：

```jsonc
{
  "ownerQQ": 你的QQ号,
  "allow": {
    "private": [你的QQ号],
    "groups": []
  },
  "dsh": {
    "baseUrl": "http://127.0.0.1:3080",
    "provider": "deepseek-official",
    "model": "deepseek-flash"
  },
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "",
    "homeDir": "C:/Users/你的用户名/snowluma"
  },
  "orchestrator": {
    "snowDir": "C:/Users/你的用户名/snowluma",
    "qqBin": "C:/Program Files/Tencent/QQNT/QQ.exe"
  }
}
```

要点：

- **路径必须写真实绝对路径**（`%USERPROFILE%` 在这里不生效），用 `/` 或 `\\`，
  不要写 `C:snowluma` 这种（会被当成相对路径）。
- `allow.private` 留空 = **谁都不理**（故意的 fail-closed）。这里填你自己的 QQ（主人号）。
- `accessToken` 留空，桥接会从 `homeDir\config\onebot_<机器人QQ>.json` 自动读出来并写回。
- `orchestrator` 不填也行，会自动探测，但手动模式建议写死。

**provider 别照抄，以你机器上 DSH 的目录为准**（DSH 起好后查，见第 5 步）：

```bat
node -e "import('./src/dsh-client.js').then(async m=>{const a=new m.NodeApiClient('http://127.0.0.1:3080');const c=m.unwrap(await a.callUnary('session/modelCatalog',{}),'catalog');console.log(c.default,c.routableProviders)})"
```

输出什么就把 `provider` / `model` 写成什么。某台机器上的实测输出长这样：

```text
{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } [ 'deepseek-official' ]
```

别的机器常见 `deepseek-account`。写错了的症状是 `session/model-unavailable: Select an available model`，
新版桥接会临时回退到目录默认值并在日志里提示，不会完全不回。

---

## 4. 把 preset / MCP 装进 DSH

```bat
node scripts\setup-dsh.mjs
```

做三件事：生成 preset → 链接进 DSH 的 `web` profile → 写 MCP 配置并执行
`dsh plugin --profile web install`。

期望看到：

```text
dsh plugin --profile web install: OK
```

**装完必须重启 DSH**（后面窗口 A 起的就是重启后的）。

可能出现的两种告警：

| 告警 | 含义 | 处理 |
|---|---|---|
| `当前 node 位于临时/便携目录` | MCP 的 `command` 写死了这个 node，被回收后 MCP 全挂 | 装系统版 Node，或 `set QQ_BRIDGE_NODE_BIN=%ProgramFiles%\nodejs\node.exe` 后重跑 |
| `dsh plugin ... 返回退出码 1` | 插件没装进 DSH | 看它打印的日志路径；修好后重跑本命令 |

`dsh` 不在 PATH 时不用管：脚本会按 PATH → `%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`
→ 各盘 `deepseek-harness\...` 自动找。找不到再显式指定：

```bat
set QQ_BRIDGE_DSH_BIN=%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd
node scripts\setup-dsh.mjs
```

---

## 5. 窗口 A：起 DSH

```bat
cd %USERPROFILE%\qq_bridge\repo
dsh web --no-open
```

`dsh` 不在 PATH 时用完整路径：

```bat
"%ProgramFiles%\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" web --no-open
```

第一次要浏览器打开 <http://127.0.0.1:3080> 填 DeepSeek API 密钥。**这个窗口别关。**

验证（另开一个窗口）：

```bat
node -e "fetch('http://127.0.0.1:3080').then(r=>console.log('DSH',r.status)).catch(e=>console.log('DSH ERR',e.message))"
```

看到 `DSH 200` / `DSH 302` 即可。

---

## 6. 登录 QQ

双击 QQ 图标（或用 `start "" "%ProgramFiles%\Tencent\QQNT\QQ.exe"`），用小号扫码登录，保持在线。

> 顺序无所谓：SnowLuma 可以先起再登录 QQ。下面窗口 B 里的
> `SNOWLUMA_HOOK_AUTOLOAD=1` 就是让它在 QQ 登录后自动挂上去。

---

## 7. 窗口 B：起 SnowLuma

```bat
set SNOWLUMA_HOOK_AUTOLOAD=1
cd /d %USERPROFILE%\snowluma
node index.mjs
```

> **这一行环境变量不能省。** SnowLuma 只挂「启动那一刻已经存在」的 QQ；
> 手动改 `config\runtime.json` 的 `hookAutoLoad` 会被它启动时重置回 `false`（实测），
> 唯一可靠的是这个环境变量。

期望日志（顺序大致如下）：

```text
[App] SnowLuma starting
hook auto-load enabled: every discovered QQ process will be injected
[WebUI] listening http://127.0.0.1:5099
[Hook] login detected: PID=... UIN=你的机器人QQ号
[OneBot.HTTP] listening 127.0.0.1:3000
[OneBot.WS-Server] listening 127.0.0.1:3001
```

如果先看到 `[Hook] awaiting login: PID=...`，就是已经挂上了、在等 QQ 登录完成，登录后会自动继续。

验证端口：

```bat
node -e "const net=require('net');for(const p of [3000,3001]){const s=net.connect({port:p,host:'127.0.0.1'});s.setTimeout(800);s.once('connect',()=>{console.log(p,'OPEN');s.destroy()});s.once('timeout',()=>{console.log(p,'free');s.destroy()});s.once('error',()=>console.log(p,'free'))}"
```

必须两个都是 `OPEN`。

---

## 8. 窗口 C：起桥接

```bat
cd %USERPROFILE%\qq_bridge\repo
node src\bridge.js
```

期望日志：

```text
[bridge] 桥接已启动。按 Ctrl+C 退出。
[bridge] 本地控制台已启动：http://127.0.0.1:3100
[bridge] SnowLuma 已连接：ws://127.0.0.1:3001
[bridge] 机器人昵称: ...
[bridge] DSH 已就绪（模式: reserved2）
```

首次运行可能出现一次自愈，属于正常：

```text
[bridge] SnowLuma 连接断开（code=1006），重连中…
[bridge] 🔧 SnowLuma WS 连接已更新：ws://127.0.0.1:3001（**…）
[bridge]    自愈完成：账号 你的机器人QQ（error {}）
[bridge] SnowLuma 已连接：ws://127.0.0.1:3001
```

`[qq-tool-restrict] restrict 失败 78/82` 这类日志是预期噪音（全局层只有几个工具），不影响收发。

---

## 9. 验证整条链路

```bat
cd %USERPROFILE%\qq_bridge\repo
node -e "const fs=require('fs');const t=fs.readFileSync('state/console-token','utf8').trim();fetch('http://127.0.0.1:3100/api/status',{headers:{'x-console-token':t}}).then(r=>r.json()).then(j=>console.log(JSON.stringify({dshReady:j.dshReady,connected:j.snowluma?.connected,accountOnline:j.snowluma?.accountOnline,good:j.snowluma?.good})))"
```

必须看到：

```json
{"dshReady":true,"connected":true,"accountOnline":true,"good":true}
```

然后：**用 `allow.private` 里的 QQ 给机器人小号发一条私聊**（比如「在吗」）。

窗口 C 应出现：

```text
[bridge] 会话 private:你的QQ 已挂载 preset qq-chat-v2
[bridge] 已设置会话模型 ... -> <provider>/<model>
[bridge] [reserved2] 工具统一发送 private:你的QQ: 成功 1/1 条
```

QQ 里收到回复即成功。运行记录在 `state/long-memory/archive/private_<你的QQ>/`。

---

## 10. 手动停止（按启动的逆序）

1. 窗口 C：`Ctrl+C`（桥接）
2. 窗口 B：`Ctrl+C`（SnowLuma）
3. QQ 右下角退出（或任务管理器结束 QQ.exe）
4. 窗口 A：`Ctrl+C`（DSH）

顺序反了也不会坏，只是日志里会多几条断连重试。

> 有残留进程时用 `stop-all.bat --all` 收拾（它按 `%USERPROFILE%\.ai-companion-run\*.pid` 杀进程树）。

---

## 11. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 控制台 `dshReady:false`，3080 端口没监听 | 只开了 DSH **桌面版 GUI**，它 API 在随机端口 | 改用 `dsh web --no-open`；GUI 可以和它同时开 |
| `session/model-unavailable` | `config.json` 的 provider 不在当前 DSH 模型目录 | 用第 3 步的命令查 `default`，把 `provider` / `model` 改成查到的值 |
| SnowLuma 日志没有 `login detected`，OneBot 3000/3001 不起 | 没开 `SNOWLUMA_HOOK_AUTOLOAD=1`，QQ 比 SnowLuma 晚起 | 关掉 SnowLuma，重设环境变量再起 |
| 桥接 `code=1006` 一直重连 | WS token 与 `config.json` 不一致 | 新版会自愈并写回；不行就检查 `homeDir` 是否指向真的 SnowLuma 目录 |
| 启动直接说「缺少配置文件」 | 没 `copy config.example.json config.json` | 复制并填 `ownerQQ` / `allow.private` |
| `setup-dsh` 之后 MCP 全起不来 | `cordis.patch.yml` 里的 node 是临时目录里的 | 用系统 node 重跑 `node scripts\setup-dsh.mjs`，然后重启 DSH |
| 开了代理后 web 工具报 fake-ip 拦截 | TUN + fake-ip 返回 `198.18.x.x` | 把目标域名加进代理软件的 `fake-ip-filter`；桥接已内置 DoH 回退 |
| 向量记忆起不来 | 缺 `sidecars\memory-rag\.venv\Scripts\python.exe` | 手动模式不需要；要开见 README 的 RAG 部分 |
| QQ 启动后立即退出 | 没有可交互桌面会话 | 在正常登录的桌面里跑 |

---

## 12. 完成检查清单

- [ ] `node -v` ≥ 22.13（推荐 24）
- [ ] `npm ci` 成功，`config.json` 存在且 `ownerQQ` / `allow.private` 正确
- [ ] `node scripts\setup-dsh.mjs` 输出 `plugin ... install: OK`，之后重启过 DSH
- [ ] 3080 上的 `dsh web` 在跑（不是桌面 GUI）
- [ ] SnowLuma 日志有 `hook auto-load enabled` + `login detected` + 3000/3001 listening
- [ ] 桥接日志有 `SnowLuma 已连接` + `DSH 已就绪`
- [ ] `/api/status` 四项全 true
- [ ] 真实私聊收到 AI 回复
- [ ] `config.json`、`state/`、`.venv` 没有提交进 git
