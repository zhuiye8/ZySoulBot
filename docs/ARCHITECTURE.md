# zySoulbot 架构与灵魂设计文档

> 版本：v2.0（干净重写版） · 2026-11-24
> 目录：`c:\Files\work\qq-bot\zySoulbot`
> 定位：灵魂优先、手脑合一、低 Token 损耗的 QQ 陪伴存在中枢。

---

## 0. 核心哲学与工程铁律

1. **不是聊天机器人，是在造一个“活着的人”**：代码是她的身体、记忆和感官，判断标准是“她像不像一个有自己生活、脾气与好奇心的存在”。
2. **给事实，不教她做事**：上下文里陈述客观事实（场合、时间、身体感受、共同经历、刚发生的事），尽量不写“你要…/不要…”式规矩，也不用代码强行改写她的回复语气。
3. **灵魂是资产，模型是引擎**：人设、记忆、情绪、关系、欲望、作品和对话历史 100% 归中枢独占（`data/bots/<id>/`）；底层 LLM / 语音 / 唱歌 / 平台均可替换，**绝不出现双重记忆**。
4. **手脑合一（灵魂原生轻量 Agent Loop）**：不把她割裂成“只会聊天的嘴”和“被外部裁判切出来的手”。她在日常聊天和独处生活里随时拥有合适的工具腰带，自己决定要不要搜一下、翻一下日记、写个小脚本、或者唱一首歌。
5. **Token 经济是一等架构约束**：静前动后保前缀缓存、按块滑窗、工具脏输出回合后折叠、极短寒暄免抽取、后处理合并、全量 Token 账本与每日软预算。
6. **开发期质量铁律**：
   - 零死代码、零兼容层、零两套并行逻辑；
   - 禁用 `as never` 绕过类型检查，外部输入与模型输出全部走 `zod` 校验；
   - 杜绝空 `catch {}` 静默吞错：所有降级必须落结构化 `trace`。

---

## 1. 技术栈与目录拓扑

### 1.1 技术栈
- **后端**：Node.js ≥ 24 + TypeScript（纯 ESM，原生跑 `.ts` 零构建）
- **存储**：Node 24 内置 `node:sqlite`（每 bot 单库 `soul.db`，WAL + FTS5）+ Markdown 资产（人设包、日记、技能 `SKILL.md`）
- **精简运行时依赖**：`zod`（契约与模型输出校验）、`hono` + `@hono/node-server`（后台 HTTP 与静态托管）、`ws`（OneBot11 正向 WS）
- **后台前端**：Vite + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui（Radix）+ Motion + Sonner + Recharts（二次元高审美风格，详见 [DESIGN.md](./DESIGN.md)）
- **质量墙**：`eslint` + `tsc --noEmit` + `dependency-cruiser`（0 错、0 循环依赖）+ `node --test`

### 1.2 目录结构与依赖方向

```
zySoulbot/
├─ docs/
│  ├─ ARCHITECTURE.md          # 本文：灵魂与系统架构
│  └─ DESIGN.md                # 管理后台二次元视觉与交互规范
├─ personas/
│  └─ nahida/                  # 种子人设包（含活动池 activities.json）
├─ src/
│  ├─ shared/                  # 纯契约、Zod schema、错误分类、串行队列、时间工具
│  ├─ storage/                 # node:sqlite(soul.db) 仓储层 + Markdown 资产读写
│  ├─ soul/                    # ★ 灵魂核心（严禁 import llm/tools/transport/admin）
│  │  ├─ persona/              # 人设包加载、按需世界观/世界书、活动池定义
│  │  ├─ body/                 # 昼夜节律、精力/睡眠债、PAD/Mood、持久化来由、活动反馈
│  │  ├─ memory/               # 三道门记忆、模糊衰减与复习、FTS5 检索、日记、反思、爬楼梗概
│  │  ├─ relation/             # 故事化三轴关系（trust/closeness/valence）+ 时间温度 + 信号
│  │  ├─ desire/               # 心事与欲望生命周期（多源萌芽/自发联想/四类出口/安全门）
│  │  ├─ agent/                # 原生轻量 Agent Loop、缓存友好消息拼装、工具结果折叠
│  │  ├─ conversation/         # 入站回合管线（注意力/打断 → 思考 → 统一表达 → 后处理）
│  │  └─ governance/           # 唯一审批闭环、能力台账、外部凭证、访问控制、Token 账本
│  ├─ llm/                     # 外部能力适配器（纯实现 shared 端口）
│  │  ├─ openai-chat.ts        # OpenAI 兼容 Chat + Tools + Reasoning + Cache Usage
│  │  ├─ judge.ts              # 快判模型（可选；未配置时优雅回落轻模型）
│  │  ├─ tts.ts                # 语音合成（火山复刻2.0 等）
│  │  ├─ asr.ts                # 语音识别（MiniMax 等）
│  │  └─ mureka.ts             # 唱歌异步端口（Mureka vocal-clone + song/generate）
│  ├─ tools/                   # 内置工具实现（实现 ToolRegistry 端口）
│  │  ├─ web.ts                # 联网搜索 / 网页抓取 / 极简 Streamable-HTTP MCP Client
│  │  ├─ self.ts               # 翻记忆、读/写日记、翻世界观、记闹钟、登记凭证
│  │  ├─ express.ts            # 发语音、发表情包、贴表情/戳一戳、唱歌
│  │  └─ workspace.ts          # 隔离工作区读写、受控脚本执行、Skill 登记与自检
│  ├─ transport/
│  │  └─ onebot11/             # NapCat 正向 WS、路由、合批、动态等待、拆泡、多模态收发
│  ├─ admin/                   # Hono REST API（按资源分文件）+ 鉴权 + 静态托管 web/dist
│  ├─ rhythm.ts                # 自主节律编排（5 分钟零 token 粗 tick + 1 分钟提醒细 tick）
│  ├─ app.ts                   # 唯一组合根（装配 soul + storage + llm + tools + transport + admin）
│  └─ start.ts                 # 进程入口
├─ web/                        # 二次元风格管理后台（Vite + React + Tailwind v4）
├─ scripts/                    # 网关冒烟验证、数据迁移等独立工具脚本
└─ test/                       # 与 src 同构的离线单元测试与集成测试
```

**架构不变量（`dependency-cruiser` 强制）**：
- `src/soul/` 与 `src/shared/` **禁止** import `llm/`、`tools/`、`transport/`、`admin/`、`app.ts`；
- 全项目 **0 循环依赖**（`admin` 只认 `shared/` 定义的 `AdminContext` 接口，绝不反向 import `app.ts`）；
- 单 bot 写操作严格走 `SerialQueue(botId)` 单写者模型，杜绝竞态。

---

## 2. 灵魂原生轻量 Agent Loop 与 Token 经济规范

### 2.1 手脑合一执行循环（`src/soul/agent/`）

每一轮对话或独处行动，都走同一套原生 `tool_calls` 循环：

```
入站事实 / 独处契机
  ↓
拼装三明治消息（静态 System + 稳定 History + 紧凑动态尾注）
  ↓
┌──▶ ChatModel.complete({ messages, tools, reasoningEffort, signal })
│        │
│        ├─ 返回 tool_calls（未超步数上限）
│        │    → 并行/串行执行工具（经安全门 + 截断上限）
│        │    → 将 tool result 追加到【本轮临时工作上下文】
│        └────┘
│
└─ 返回最终正文（或已由表达工具完成）
  ↓
【关键省钱步骤】工具过程折叠：
  - 中间几千字的搜索正文/脚本调试日志全部丢弃，不进长期历史
  - 只将「最终回复 + 1 行工具行动摘要（如：[搜了今天北京天气：晴 12℃]）」写入 soul.db messages 表
```

**分层工具腰带（按场景按需挂载，不塞无用 Schema）**：
| 层级 | 包含工具 | 开放时机 | 步数 / 档位预算 |
|---|---|---|---|
| **日常探索层** | `web_search`、`web_fetch`、`recall_memory`、`read_diary`、`read_worldview`、`set_reminder`、`note_thought` | 全部对话（私聊/群聊） | ≤ 3 步 / `low` 档 |
| **表达动作层** | `send_voice`、`send_sticker`、`react_message`、`sing_song` | 对应通道已配置时开放 | 计入当轮，同 `low` 档 |
| **动手创造层** | `workspace_read`、`workspace_write`、`workspace_run`、`register_skill`、`request_credential`、`write_diary` | 授权私聊任务 / 自主造能力 / 写日记回合 | ≤ 15 步 / `high`~`max` 档 |

> **自造技能极简闭环**：她写的新技能直接落盘 `data/bots/<id>/workspace/skills/<name>/SKILL.md` + 脚本。调用 `register_skill` 自检运行通过后立刻进入 `capabilities` 表，下一轮对话就能通过 `workspace_run` 直接使用——**零重启、零 DSH 多目录拷贝**。

### 2.2 四条 Token 节流铁律

1. **严格“静前动后”三明治结构（最大化 Prefix Cache）**
   - **Layer 0 — 纯静态 System（字节锁定不变）**：`identity` + `origin` + `examples` + `discipline` + `scenario` + 静态工具说明。**严禁在 System 中放日期、时间、对话轮数、活动剩余分钟或任何动态字段**。
   - **Layer 1 — 按块滑动的对话历史**：攒够 `30` 条消息时一次性淘汰最老 `10` 条（顺手压入梗概），而不是每轮前移 1 条——确保连续 10 轮历史前缀 100% 稳定命中缓存。群聊直接在历史消息文本里带 `[说话人]`，不额外重抄最近 8 句。
   - **Layer 2 — 紧贴本轮消息的紧凑动态尾注（硬上限 ~1,200 字）**：当前时间、精力与心情来由、当前活动、与眼前人的关系及 2–3 条共同故事、高相关记忆线索 Top 5–8 条（更细的回忆由她自己调 `recall_memory` / `read_diary` 翻阅）。
2. **工具输出当轮截断 + 回合折叠**
   - 单次网页抓取/命令输出硬截断（默认 ≤ 2,500 字符）；
   - 回合结束立即折叠为单行摘要，绝不把过期的搜索结果拖进未来几十轮计费。
3. **后处理门控 + 多合一**
   - **极短无信息回合跳过抽取**：如纯寒暄/单字应和（“嗯”“哈哈”“好的”“在吗”）且无实质信息时，直接 0 次后处理 LLM 调用（结合历史真实消息分布，直接省掉约 40% 后处理开销）；
   - **一次结构化调用替代 5 次零散调用**：需要抽取时，单次 `low` 档 JSON 调用同时输出 `{ facts(含 tier/disclosable/sensitivity/call), affect, happened, signals, welfare, newDesireHint }`，彻底消灭重复抽情绪和逐条判敏感度。
4. **全量 Token 账本与每日软预算**
   - 所有模型调用（对话、工具循环、后处理、自发联想、生活决策、造能力）全部记录 `scene / model / input_tokens / cached_tokens / output_tokens / reasoning_tokens / est_cost` 到 `token_ledger` 表；
   - 支持配置自主行为（生活/联想/造能力）的每日 token 软上限：超限后自动降频休眠，不影响正常陪聊。

---

## 3. 生动度升级：身心、欲望、记忆、关系的完整设计

### 3.1 身心闭环（`src/soul/body/`）
- **生理节律与睡眠债**：
  - 精力 `energy ∈ [0, 1]` 与睡眠债 `sleepDebt ∈ [0, 1]` 随真实墙钟演化：白天活跃缓降、深夜（23:00–07:00）未休息时加速累积睡眠债；
  - 持续高频聊天或执行重型创造任务会真实消耗精力；独处/休息活动（如小憩、听雨、散步）会真实回血；
  - **影响机制（进参数，不只进 prompt）**：精力低时降低自主行动骰子概率 `p`、偏向简短回复倾向、并在高疲惫时允许她自己表达“有点困/先歇会儿”。
- **活动池归属人设包 + 双向反馈**：
  - 活动池从核心代码迁至 `personas/<id>/activities.json`（不同角色有自己的世界和日常）；
  - 每项活动声明 `{ id, label, place, times, durationMin, effects: { energy, pad, drives }, yields }`：活动结束时**真实回写她的精力、PAD 与驱力**，并可能产生见闻记忆或新念头。
- **情绪与心境持久化**：
  - 短期情绪 `PAD`（半衰期 ~3h）+ 长期心境 `Mood`（半衰期 ~5d）+ 持久化情绪来由 `emotion_causes`（最多留最近 20 条，重启不丢）；
  - 不只是聊天——**她自己过日子的事**（活动见闻、造技能成败、等回复超时、唱完一首歌）同样写入 `appraise()`，产生真实心情起伏。

### 3.2 立体心事与欲望系统（`src/soul/desire/`）
废除旧版“2 小时硬挤日记 + `transmute` 与 `capability-plan` 重复做两遍”的割裂流程，收束成统一状态机：

1. **三种萌芽源**：
   - **对话触发**：后处理抽到她在意但没做成/想进一步了解的事，直接记下轻量种子；
   - **空闲自发联想（Mind Wandering）**：日常 5 分钟零 token tick 掷骰命中时，有一定几率从记忆池里随机浮现一条旧记忆 + 当下时段/心境，问她“这让你突然想到了什么”——可能生出找某人聊两句的冲动、一条心事，或一首想唱的词；
   - **日记与反思沉淀**：一天沉淀后真正放不下的愿望才升格为持久欲望。
2. **四类明确出口（一次判清，不再二次翻译）**：
   - `experience`：她自己就能体验/探索的事（上网查清楚、做某项活动）；
   - `create_work`：创作型表达（写段文字、**写词唱歌**、画张图），作品存进 `works` 表，可自己留着也可挑时机送人；
   - `social`：想找具体某人分享/倾诉/询问；
   - `build_skill`：确实缺一项可复用本领 → 过代码硬安全门（禁删系统/付款/骚扰）+ 目的范围判定 → 直接走原生 Agent Loop 造技能；**需要外部 API 密钥时，她直接在循环中调 `request_credential` 登记需求，并由凭证通道提醒管理员去后台填，不再被安全门误杀**。
3. **支持阶段推进与真实受挫**：
   - 欲望记录 `stage`（`seed → active → waiting_credential / waiting_approval → in_progress → fulfilled / faded / abandoned`）与 `progressNote`；
   - 造砸了或被拒绝会回流为记忆与小幅情绪波动，她知道自己试过。

### 3.3 故事化关系与三道门模糊记忆（`src/soul/relation/` & `src/soul/memory/`）
- **关系叙事化**：
  - 三轴正交（`trust` / `closeness` / `valence`）只由她对信号的判断驱动，严格双向可升可降；
  - 注入动态尾注时，除基础称呼与熟悉度外，从 `memories` 中自动捞取 **2–3 条与眼前人的高留存共同经历** + **距上次联系的真实时间跨度**（如“你们 5 分钟前刚说完” vs “隔了 4 天没聊”）。
- **记忆三道门 + 模糊曲线 + 复习效应**：
  - `store`（留存档位 `fleeting / season / lasting / permanent` + 敏感度 + 愿不愿提 `volunteer / when-asked / secretive`）；
  - `recall`（FTS5 关键词 + 留存衰减 + 相关性；每次被召回提升 `recall_count` 与 `last_recalled_at`，延缓遗忘）；
  - `disclose`（分级披露 + 模糊化：经历类记忆随强度衰减到低档时，注入标注“过去有阵子了，印象有点模糊”，客观事实/称呼/约定则保持准确）。
- **真正属于她的注意力与打断决策**：
  - 她正忙着做活动时收到消息（私聊或群 @），打断判断**必须带上她的人设一句话核 + 当前活动与思绪 + 真实精力状态 + 与来人的关系**，决定 `now` / `later`（持久化进 `pending_replies`，重启不丢）/ `ignore`。

### 3.4 统一表达层与回复节奏（`src/soul/conversation/`）
- 打破 AI 均匀 40 字段落感：保留自然短示例 + 结合当前精力/情绪/群聊场合提供轻柔的“当下说话节奏倾向”（不强行截断正文）；
- 文字（拆泡）、语音（TTS）、表情包（按情绪+场合）、轻动作（贴表情/戳一戳）、**唱歌（Mureka）** 统一收口到表达管线。

---

## 4. 唱歌端口设计（Mureka 异步创作）

已核实 Mureka API 能力（`https://api.mureka.cn`）：
- `POST /v1/song/vocal-clone`：上传 15–30s 干声（mp3/m4a）注册专属歌声音色 `vocal_id`；
- `POST /v1/song/generate`：传入歌词 `lyrics` + 风格 `prompt` + `vocal_id` 发起异步作曲演唱；
- `GET /v1/song/query/{task_id}`：轮询状态并获取成品音频 URL（mp3/wav/flac）。

**架构接入方式**：
1. `shared/ports.ts` 定义厂商无关的 `SingingPort`（`createSong({ title, lyrics, style, vocalId }) → { taskId }`、`pollSong(taskId) → { status, audioUrl?, durationSec?, error? }`），`src/llm/mureka.ts` 实现它；
2. **完全异步、不阻塞聊天**：
   - 她调用 `sing_song` 工具（不论是用户点唱还是她自己写词想唱）→ 写入 `works` 表（状态 `generating`）→ 当轮立刻轻声应一句（如“我试着哼一下，等我一小会儿”）；
   - `rhythm` 后台轮询进度（~30–90 秒），完成后下载音频到本地 `data/bots/<id>/media/songs/`，更新 `works` 状态，入 `SerialQueue` 投递给目标 QQ（语音/音频消息）并附一句她自己的感受，同时沉淀为记忆与作品记录；
   - 后台可视化「作品与歌单」页可直接在线播放她唱过的每首歌、看她写的词和当时的心情。

---

## 5. SQLite 单库结构（`data/bots/<id>/soul.db`）

每个 bot 独占一个 `soul.db`（WAL 模式 + FTS5）+ 可读文件夹（`persona/`、`diary/`、`workspace/`、`media/`）：

| 表名 | 用途 | 关键字段 |
|---|---|---|
| `messages` | 唯一权威对话历史（含工具折叠摘要） | `id, thread_key, role, user_id, user_name, content, tool_summary, media_json, created_at` |
| `memories` + `memories_fts` | 统一记忆池 + FTS5 全文索引 | `id, kind, text, about_json, sensitivity, tier, disclosable, source, thread_key, recall_count, last_recalled_at, embedding_blob, created_at` |
| `relations` | 三轴关系 + 称呼 + 等待学习窗口 | `user_id, call_name, custom_call, stage, type, trust, closeness, valence, turns, first_seen, last_seen, streaks_json, windows_json` |
| `body_state` | 身心快照（单行） | `pad_json, mood_json, drives_json, energy, sleep_debt, activity_json, last_tick_at` |
| `emotion_causes` | 持久化情绪来由 | `id, source, who, text, affect_kind, delta_json, created_at` |
| `desires` | 心事与欲望生命周期 | `id, source, motive, want, why, exit_kind, stage, spec_json, blocker_json, strength, thought_count, progress_note, about_user, parent_id, created_at, updated_at` |
| `approvals` | **唯一**待审批表（同时只允许 1 条 pending） | `id, kind, target_id, what, payload_json, status, asked_at, expires_at, resolved_at` |
| `schedule` | 精确提醒 + 承诺约定 | `id, kind, user_id, thread_key, text, due_at, status, created_at` |
| `pending_replies` | 忙时暂存待回消息（重启不丢） | `id, user_id, user_name, thread_key, text, created_at` |
| `capabilities` | 她学会的技能台账 | `name, kind, summary, skill_dir, status, created_at` |
| `works` | 她的作品库（歌曲/歌词/画作等） | `id, kind, title, content, media_path, status, external_task_id, for_user, mood_note, created_at` |
| `token_ledger` | 全量 Token 与缓存账本 | `id, scene, model, input_tokens, cached_tokens, output_tokens, reasoning_tokens, est_cost_cny, created_at` |
| `traces` | 结构化可观测日志（含所有降级错误） | `id, trace_id, event, level, data_json, created_at` |

> 外部服务密钥表 `data/credentials.json`（权限 `0600`）与后台登录凭据 `data/admin-auth.json`（权限 `0600`）单独落盘，不混入单 bot 资产包，方便安全分享/备份 bot。

---

## 6. 分阶段实施计划与验收闸门

| 阶段 | 内容 | 验收闸门 |
|---|---|---|
| **G0（动工前实测）** | 隔离脚本实测当前模型网关 `/chat/completions` 的 `tools` + `reasoning_effort` + `cached_tokens` | 实测通过才进入 P0（不靠猜） |
| **P0：新骨架 + 灵魂内核** | `shared` / `storage(soul.db)` / `soul(persona, body, memory, relation, agent, conversation)` + 迁入纳西妲人设包（含 `activities.json`） | `pnpm check` 0 错 0 警；离线模拟多轮对话 + 真实网关对话验证“静前动后缓存命中”与工具循环 |
| **P1：传话与多模态感知** | OneBot11（NapCat）私聊/群聊、合批与动态等待、拆泡、识图、ASR、带人设的注意力打断决策、联网搜索工具 | 隔离配置跑通私聊/群聊完整对话与主动查天气/网页 |
| **P2：生活、欲望与自主创造** | `rhythm` 节律、自发联想、统一欲望状态机、隔离工作区脚本与 Skill 自检、凭证与唯一审批闭环、日记与反思 | 模拟多日生活节律 + 端到端跑通“萌芽 → 探索/登记凭证/造技能 → 回流情绪记忆” |
| **P3：统一表达 + Mureka 唱歌** | TTS 语音、表情包库与打标、贴表情/戳一戳、`SingingPort` + Mureka 异步唱歌适配器（点唱 + 自发写词唱歌） | 音频/语音/表情包与异步唱歌全通路可用 |
| **P4：二次元管理后台 + 迁移** | Hono API + React 二次元后台（概览/聊天/记忆/关系/生活欲望/歌单作品/Token 账本/凭证/Trace）+ 老数据一次性迁移脚本 | 后台完整验收，确认满意后再择机停旧切新 |
