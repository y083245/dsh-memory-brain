# 更新日志

每个版本一节。节末的 ```` ```upgrade ```` 代码块是给 `scripts/update.sh` 读的升级须知（要重启什么、要不要装依赖等），升级时会自动显示。

## 第一次升级（还没有 `scripts/update.sh` 的老版本，比如 v0.3.0 及更早）

在项目目录里执行这两条命令：

```bash
git fetch origin && git checkout origin/main -- scripts/update.sh
bash scripts/update.sh
```

以后升级只要 `bash scripts/update.sh`。

## v0.4.0 — 2026-11-03

实时脑图：打开一个页面，就能看着她「想事情」。

- **新页面 `/brain`**（控制台导航里点「实时脑图」，会在新标签页打开）：每个光点是一条真实的记忆，包括账本条目、话题块、摘要、实体、账本建议、日记、人格。她每用到一个记忆模块（收发消息、检索、翻账本、记下、遗忘、想起、情绪判读、生活回路……），对应的脑区和光点就实时亮起来，右边列出那次用到的内容。
- **回放**：过去 7 天里任意一天，可以按时间轴重放（1× / 10× / 60×）。为此新增只记编号和数字的轨迹文件 `state/brain/trace/`，**不存任何聊天原文**，保留 7 天；回放时按编号现取原文，删掉的显示「已删除」。
- **检索演示**：自己输入一句话，看五路检索（向量 / BM25 / 约定 / 摘要 / 图谱）各自的名次和融合结果。**不会记复习**，不影响她的遗忘曲线。
- **时间推演**：点一条账本条目，看它按 FSRS 遗忘曲线未来一年的「记得多少」，以及哪天会淡忘。
- **会话筛选**：全部 / 某个私聊 / 某个群；手机宽度也能用。
- 总开关在控制台「API 管理」页（`config.json` 的 `brain.enabled`，缺省开），切换不用重启。
- **隐私**：页面会显示真实聊天原文，只在本机 3100 端口、要控制台令牌才能打开；远程查看请用 SSH 隧道，不要把 3100 端口暴露到公网。
- memory-rag 新增两个只读接口 `/graph`、`/chunk`，`/search` 支持 `debug`；不改表结构。
- 想先用假数据看看效果：`npm run brain:demo`，然后打开 `http://127.0.0.1:18731/brain?token=demo-token`。

```upgrade
restart: bridge, memory-rag
deps: 无
setup-dsh: false
systemd: false
cost: 无
```

## v0.3.1 — 2026-11-03

升级与兼容：以后一条命令就能升级，升级不会冲掉你改过的东西。

- **一条命令升级 / 回滚**：`bash scripts/update.sh`（先 `--check` 看看有什么新版本、要重启什么；`--dry-run` 只演练）。升级前自动备份 `state/` 和 `config.json`，失败时会打印回滚命令（`bash scripts/rollback.sh`）。永远不会重启 QQ 和 SnowLuma。
- **你的修改挪进 `state/`**：角色卡、仿真提示词、memory-rag 参数，控制台保存时只写 `state/` 下的覆盖层，出厂文件保持原样，`git pull` 再也不会冲突。第一次升级时脚本会找出你以前直接改过的这几类文件，问一次，然后搬进覆盖层。
- **memory-rag 参数覆盖**：在 `state/long-memory/rag/config.local.yml` 里写要改的项，会深合并到 `config.yml` 上。
- **向量库版本号**：memory-rag 启动时自动给库打版本号（迁移前备份 `rag.sqlite3.bak-v0`，7 天后或第一次删存档后自动删）；代码比库旧时自动只读，不会写坏。
- **版本检查**：控制台页头显示版本号，有新版本时显示提示条（每天问一次 GitHub，只读）。不想要就在 `config.json` 加 `"update": { "check": false }`。
- 控制台：角色卡显示「出厂 / 已修改 / 自建」，可以「恢复出厂」；仿真提示词也可以恢复出厂。
- 修复：控制台保存仿真提示词后会重新生成 `plugins/qq-agent-presets/presets/*.patch.yml`（DSH 读的是它，以前保存了不生效）。

```upgrade
restart: bridge, memory-rag
deps: 无
setup-dsh: false
systemd: false
migrate: rag-db v1
cost: 无
```
