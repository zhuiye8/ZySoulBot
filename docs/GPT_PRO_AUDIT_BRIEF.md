# ZySoulBot 代码级红队审计简报（面向 GPT Pro · Stage 2）

> **用途**：本文件用于将已落地 v2.1 架构加固后的 `ZySoulBot` 代码库提交给 **GPT Pro** 进行 **代码级对抗性红队审计（Code Red-Team Audit）**。
> **前序阶段说明**：Stage 1（宏观架构对标、竞品差异化、论文机制选型）已由 Gemini Deep Research 完成，其提出的 5 项 P0 结构性修复 + 3 项 v2.1 核心升级已全部在当前提交中落地并通过 40/40 单测与 `dependency-cruiser` 边界检查。
> **本阶段唯一目标**：不再讨论“要不要换 Neo4j / 换多智能体”，而是**直接读真实代码，找隐蔽 Bug、状态机死锁、数值边界漏洞、缓存隐式失效、SQLite 一致性风险与安全沙箱绕过**，给出可复现反例与精确补丁。

---

## 一、直接复制给 GPT Pro 的开场提示词

> **使用方式**：把下面的提示词 + 仓库链接 `https://github.com/zhuiye8/ZySoulBot`（或直接上传下面列出的核心 13 个源码文件）一起发给 GPT Pro。

```markdown
请你扮演一位极其严苛的 **Principal Systems & AI Security Red-Team Engineer**，对开源项目 `ZySoulBot`（https://github.com/zhuiye8/ZySoulBot）进行**纯代码级对抗性红队审计**。

### 项目定位与约束（审计前提，请勿挑战）
- `ZySoulBot` 是一个单进程、Node.js 24 原生 TypeScript（`node:sqlite` + FTS5，无 Docker/Redis/Neo4j）的多 Bot 伴侣型智能体框架，通过 OneBot11 接入 QQ，并提供 Hono + React 管理后台。
- 宏观架构选型已由前置深度调研冻结；刚刚落地的 v2.1 加固包含：
  1. 债务封顶 + 重复衰减的关系修复模型 + `NSO` 情绪体制 + `disengagement` 退缩分 + 动态重伤软化期（消除道歉套利与 18 天死区）；
  2. 记忆双时间字段（`valid_from/valid_until/superseded_by`）与来源防火墙（`L0_external / L1_shared / L2_internal`）；
  3. 确定性排序的冻结 `tools` 工具带 + 执行期掩码（保护 LLM KV Prefix Cache）；
  4. CJK 2 字词并行 `LIKE` 合并检索（修复 FTS5 trigram 截断 2 字中文词）；
  5. 统一提取器 `pragmaticNote` 首字段反讽识别 + 选择性 `<inner>` 隐式独白剥离 + `guilty` / `source:'self'` 愧疚回路 + `L2` 每日情绪上限 ±0.05 + 3-gram Jaccard 去循环门控。

### 审计原则（严格遵守）
1. **禁止泛泛夸奖，禁止宏大重构建议**（不要建议“换成微服务/向量库/LangGraph/ORM”）。
2. **每一条发现都必须绑定到真实代码**：必须给出精确的文件路径、函数名/行号范围、触发条件（最好是精确输入序列或数值反例）、故障后果，以及可直接落地的最小修复补丁（diff 或伪代码）。
3. **重点红队攻破我们刚刚新写的 v2.1 代码**（新代码最容易藏边界 Bug 和逻辑回归）以及核心并发/持久化/安全边界。
4. 请按 `docs/GPT_PRO_AUDIT_BRIEF.md` 中的 **5 大红队攻击面** 逐项排查，并按文中要求的 **P0 / P1 / P2 严重度格式** 输出报告。
```

---

## 二、架构总览与 6 条不可违背的工程不变量

审计时，任何违背以下 6 条不变量的代码路径都视为 **P0/P1 缺陷**：

| # | 不变量 | 实际约束与对应模块 |
|---|---|---|
| **I1** | **Core Purity（内核纯净）** | `src/soul/**` 与 `src/shared/**` 绝不直接 import SQLite、HTTP/WebSocket、OneBot11、文件系统或第三方 SDK（由 `.dependency-cruiser.mjs` 强制校验，0 循环依赖）。 |
| **I2** | **Prefix Cache Determinism（前缀缓存确定性）** | 同一 Bot 在同一轮或连续多轮对话中，发往 LLM 的 `system` 静态块与 `tools` 定义 JSON 必须**逐字节完全一致**；动态事实只能放在消息尾部（dynamic tail），工具权限变化只能用执行期掩码而不能增删 `tools` 数组。 |
| **I3** | **Anti-Arbitrage & Non-Deadlock Affect（抗套利且不死锁的情绪/关系）** | 伤害（`insult/dismissive/broken_promise`）与修复（`repair`）不能存在“反复伤害+反复道歉刷好感”的套利路径；同时关系也不能陷入“永远无法恢复”或“永远重复触发同一次道歉/破冰”的死锁。 |
| **I4** | **Single-Bot Serialization & Crash Safety（单 Bot 串行与崩溃恢复）** | 每个 Bot 通过 `SerialQueue` 串行执行状态变更；进程异常重启后，SQLite 中的 `desires / approvals / pending_replies / works / schedule` 不得永久卡死在中间态。 |
| **I5** | **Provenance Firewall（记忆来源隔离）** | Bot 自己生成的内心独白/日记/愿望（`L2_internal`）不得永久晋升为 `core` 事实，不得在后台自触发中被反复强化成假记忆闭环，不得把 `<inner>` 泄露到 QQ 消息或对话历史表中。 |
| **I6** | **Secret & Sandbox Isolation（密钥与沙箱隔离）** | `credentials.json` 严格 `0600` 隔离，注入子进程的 `ZYSOUL_CREDENTIALS` 绝不回显到 LLM/日志/错误堆栈；`workspace` 沙箱不可越权读写或命令逃逸；`web_fetch` 不可被 SSRF 绕过；Admin API 具备认证 + CSRF 防护。 |

---

## 三、优先审计文件清单（按爆炸半径分为 4 梯队）

整个后端共 49 个 TS 模块，核心业务逻辑高度集中在以下 **14 个文件（约 5,400 行）**。建议 GPT Pro 按梯队顺序精读：

### Tier 1 — 情绪、关系、记忆与对话主链路（v2.1 新代码最密集）
1. `src/soul/relation/engine.ts`（487 行）— 信任非对称、债务封顶 + 重复衰减 `repair`、`NSO` 体制、`disengagement`、`source:'self'` 愧疚、动态软化期与取证渲染。
2. `src/soul/conversation/turn.ts`（510 行）— 静态/动态 Prompt 拼装、`pragmaticNote` 首字段统一提取、`selfMistake` 愧疚路由、选择性 `<inner>` 独白剥离与防泄露。
3. `src/soul/body/engine.ts`（382 行）— 昼夜节律、13 种情绪（含 `guilty`）、连续负向升级/防御撤退、`L2` 每日 `mood.p` 累积上限 `±0.05`。
4. `src/soul/memory/engine.ts`（250 行）— `L0/L1/L2` 防火墙、3-gram Jaccard 去重、有界情绪一致性召回（`1.25×`）与后台免 `touchMemories`。

### Tier 2 — 自主生命、编排、主循环与异步并发
5. `src/rhythm.ts`（721 行）— 定时心跳、自主行动推进、待回复/提醒、`Mureka` 异步唱歌轮询 `songTick`、崩溃后状态推进。
6. `src/app.ts`（634 行）— 多 Bot 启动/关闭、OneBot11 入站路由、冻结 `toolLayers` 装配、`SerialQueue` 调度与全局异常隔离。
7. `src/soul/desire/life.ts`（508 行）— 主动触达/破冰 `clear_air` / 补救 `make_amends` / `disengagement` 抑制 / 主动行动动机路由。
8. `src/soul/desire/engine.ts`（441 行）— 愿望种子去重（含 3-gram Jaccard）、双向 tick、作用域路由与生命周期流转。
9. `src/soul/agent/loop.ts`（225 行）— 原生 Tool Loop、工具结果折叠（fold）、最大步数与超时/错误收口。

### Tier 3 — 存储、SQLite FTS5 与缓存底层
10. `src/storage/sqlite-store.ts`（1,020 行）— `soul.db` schema、启动自动迁移、WAL 模式、FTS5 trigram + 2 字 CJK `LIKE` 并行合并、双时间过滤、`compactOldMessages` 区块压缩与 `wipe`。
11. `src/tools/registry.ts`（117 行）— `canonicalizeJson` 递归键排序、工具字母表确定性输出与执行分发。

### Tier 4 — 安全边界与外部 I/O
12. `src/tools/workspace.ts`（357 行）— 路径沙箱、命令白名单/黑名单、自验证 Skill 运行、`allowCreate` 执行期掩码与 `ZYSOUL_CREDENTIALS` 脱敏。
13. `src/tools/web.ts`（232 行）— SSRF 防护（IP/主机名拦截）、`web_fetch` 重定向/编码/大小限制与 MCP `web_search`。
14. `src/admin/auth.ts`（149 行）+ `src/admin/server.ts`（122 行）+ `src/soul/governance/credentials.ts`（208 行）— 登录口令校验、Session Cookie、CSRF/Origin 防护、密钥存储与路由鉴权。

---

## 四、5 大红队攻击面检查清单（请逐项尝试攻破）

### 攻击面 1：状态机卡死、崩溃恢复与异步竞态
请重点检查：
1. **重启后中间态卡死**：如果服务在以下时刻被 `SIGTERM` / OOM 杀死，重启后是否会永久卡死或重复触发？
   - `desires` 表中存在 `status = 'in_progress'` 的记录；
   - `works` 表中存在未完成的 Mureka 歌曲任务（`songTick` 是否会无限轮询失败/过期的 `taskId`？）；
   - `approvals` 表中存在未决审批，`pending_replies` 堆积超时；
   - `SerialQueue`（`src/shared/serial-queue.ts`）中某个任务抛出同步或异步异常后，后续队列是否还能继续推进？
2. **后台 tick 与实时对话并发冲突**：`rhythm.ts` 定时器（`lifeTick / songTick / reminderTick / decayTick`）与 QQ 实时消息入站是否全部经过同一把 `SerialQueue` 锁？是否存在“读状态 -> await LLM -> 写回状态”期间被另一路径覆盖（Lost Update）的窗口？
3. **OneBot11 重连与消息批处理**：`batcher.ts` / `adapter.ts` 在 WS 断线重连瞬间是否会丢失缓冲消息、重复注册事件监听器或泄漏定时器？

### 攻击面 2：v2.1 情绪 / 关系 / 记忆数值边界与逻辑漏洞
请专门拿“极端输入序列”去压测新加的 v2.1 机制：
1. **债务封顶 + 重复衰减修复（`relation/engine.ts`）**：
   - 构造攻击序列：连续交替发送 `minor` 冒犯与 `repair`，或故意用不同 `topicTag` 绕过同一 `tension` 的 `repeatCount`——是否存在新的刷分/绕过路径？
   - 反过来，当 `disengagement` 升高、`NSO` 体制激活、且 `repaidRatio` 封顶在 `0.75` 时，一个真正改过自新的用户是否有合理的长期正反馈恢复路径？还是会被永久锁死在 `NSO` / 高 `disengagement` 中？
   - 当 `tensions` 达到上限发生驱逐（`severity * recencyWeight`）时，`source: 'self'` 的愧疚张力和 `source: 'user'` 的用户伤害张力混排，会不会出现误删关键重伤或误删未解决愧疚？
2. **选择性 `<inner>` 隐式独白（`turn.ts`）**：
   - 如果 LLM 输出了**未闭合的 `<inner>...`**（例如被 `max_tokens` 截断）、多个 `<inner>` 块、大小写混写 `<INNER>`、或者**整条回复全部被包在 `<inner>` 里**（剥离后正文变成空字符串），`stripInnerMonologue()` 与后续发送/存库逻辑会怎么表现？会不会给 QQ 用户发一条空消息或把未闭合的内心戏直接发出去？
3. **`L2` 每日情绪上限（`body/engine.ts`）与 `make_amends` 回路（`life.ts` / `rhythm.ts`）**：
   - `L2` 每日 `±0.05` 上限的“跨天重置”逻辑是否严格对齐配置时区（`src/shared/time.ts`），以及重启进程后当天已消耗的额度是否持久化（还是重启清零）？
   - `song_failed` 或 `selfMistake` 写入 `source:'self'` 张力后，如果 `make_amends` 主动触达失败或被静默时段拦截，是否会陷入死循环或永远不结算？
   - 3-gram Jaccard `> 0.65` 去重对短中文文本（如 4~6 字愿望/记忆）或标点/空白差异是否过于敏感或完全失效？

### 攻击面 3：Prefix Cache 隐式失效与 Token 成本黑洞
请逐字节追踪 `src/soul/conversation/turn.ts`、`src/soul/agent/loop.ts`、`src/tools/registry.ts`、`src/app.ts`、`src/llm/openai-chat.ts`：
1. **静态前缀污染检查**：`system` prompt 中有没有混入任何会随时间/状态变化的字段（时间戳、当前情绪、活跃愿望、关系分、随机项）？
2. **`tools` 定义字节一致性**：`canonicalizeJson` 是否正确处理数组、嵌套对象、`undefined` 属性、`null`？`registerWorkspaceTools` 在冻结 `toolLayers` 后，不同 bot 或不同轮次的 `tools` 数组长度与顺序是否绝对稳定？
3. **`messages` 历史前缀破坏**：`compactOldMessages` 触发压缩时，是否在单次触发时一次性滑窗一大段（维持后续多轮稳定缓存），还是每轮都移动边界导致每轮缓存全失效？Tool Loop 多步调用中 `tool_call_id`、角色顺序、折叠摘要是否符合 OpenAI / DeepSeek / Claude 兼容接口规范，会不会触发 HTTP 400？

### 攻击面 4：SQLite WAL、FTS5 检索、双时间字段与数据一致性
请精读 `src/storage/sqlite-store.ts` 和 `src/soul/memory/engine.ts`：
1. **FTS5 语法注入与异常**：用户输入包含双引号 `"`、`*`、`NEAR`、`OR`、`NOT`、`^`、特殊 Unicode 控制符或纯标点时，`searchMemories` 构造的 FTS5 `MATCH` 查询会不会抛 SQLite syntax error？
2. **`LIKE` 通配符转义与性能**：P0-4 新增的 2 字 CJK `LIKE` 查询是否转义了 `%` / `_` / `\`？当 `memories` 表增长到 10,000+ 行时，并行 `LIKE` 的全表扫描延迟和索引使用情况如何？
3. **双时间字段与 FTS5 同步**：调用 `invalidateMemory`（设置 `valid_until` / `superseded_by`）后，已失效记忆是否仍会通过 `memories_fts` 触发器或 `JOIN` 泄漏进搜索结果，或占据 `LIMIT` 名额把有效记忆挤掉？
4. **事务原子性**：`compactOldMessages`、旧库启动 `ALTER TABLE` 迁移、`wipe` 重置、`touchMemories` 是否都在显式事务内执行，避免半写状态损坏数据库？

### 攻击面 5：安全红队（Sandbox / SSRF / Credentials / Admin API）
请把以下 4 个入口当作真实公网/半可信输入面来攻破：
1. **Workspace 沙箱（`src/tools/workspace.ts`）**：
   - **符号链接逃逸（Symlink Escape）**：路径检查是否仅依赖 `path.resolve` + `startsWith`？如果先在沙箱内通过脚本创建指向 `/etc/passwd` 或 `../credentials.json` 的 symlink，再用 `read_file`/`write_file` 访问，能否越界？
   - **命令执行绕过**：`run_cmd` / 自验证 skill 执行时，是否存在 shell 元字符拼接、环境变量泄露（例如 skill 脚本直接 `console.log(process.env.ZYSOUL_CREDENTIALS)`，脱敏逻辑能否拦截变形输出如 base64/分片/URL 编码？）、无界内存/CPU/磁盘炸弹或孤儿僵尸子进程？
2. **SSRF 防护（`src/tools/web.ts`）**：
   - **HTTP 301/302 重定向绕过**：`web_fetch` 校验完初始公网 URL 后，`fetch()` 默认 `redirect: 'follow'` 是否会跟着 302 跳转到 `http://127.0.0.1:8787` 或 `http://169.254.169.254/latest/meta-data/`？
   - **DNS 重绑定 / IPv6 映射地址 / 十进制与八进制 IP**：`::ffff:127.0.0.1`、`0.0.0.0`、`[::1]`、公网域名解析到内网 IP（A/AAAA 记录）是否被正确拦截？
   - **响应体 OOM**：超大响应流是否在读取前或流式读取中强制截断字节上限，而非先 `await res.text()` 撑爆内存？
3. **Admin API 安全（`src/admin/auth.ts`, `src/admin/server.ts`, `src/admin/routes/*.ts`）**：
   - 口令校验是否防时序侧信道（`timingSafeEqual`）、是否有登录爆破限流？
   - Cookie 属性（`HttpOnly`、`SameSite`、`Path`、`Secure`）及 CSRF 校验（`Origin` / `Referer` / 自定义头）是否存在绕过（如 `Origin: null` 或缺失 `Origin` 的跨站 POST）？
   - `routes/soul.ts` 编辑 Persona 文件或 `routes/works.ts` 读取/下载作品文件时，是否存在路径穿越（`../`）或 MIME/XSS（如上传/生成 HTML/SVG 在同源渲染）？
   - `routes/credentials.ts` 是否在任何错误分支或列表中意外回传明文 secret？

---

## 五、期望的输出格式（请严格遵循）

请按以下结构输出审计报告，便于我们直接转化为修复 PR 与回归单测：

1. **Executive Verdict（最多 10 行）**：总体稳定性与安全水位评估，列出最致命的 Top 3 风险。
2. **漏洞与缺陷清单（按 `P0 阻断/安全漏洞` -> `P1 逻辑/并发/数值缺陷` -> `P2 边界硬化` 排序）**：
   每一项必须严格包含 5 个字段：
   - **[ID + 严重度 + 类别] 标题**（如 `[P0-SEC-1] web_fetch 允许 302 重定向绕过 SSRF 检查`）
   - **代码定位**：精确文件路径 + 函数名 + 行号
   - **复现反例 / 攻击载荷**：具体输入步骤、边界数值或 curl/脚本片段
   - **真实影响**：在生产 QQ 机器人环境中具体会发生什么
   - **最小修复补丁**：直接可应用的 TypeScript 代码改动思路或 diff
3. **针对 6 条不变量的逐条核验表**：每条标注 `PASS / PARTIAL / FAIL` 及一句话证据。
4. **建议补充的 5~8 个高价值回归测试场景**（一行一条，直接对应上面发现的漏洞）。

---

*本文档对应 `ZySoulBot` v2.1 加固基线（40/40 单测通过，0 lint / 0 typecheck / 0 depcruise 违规）。*
