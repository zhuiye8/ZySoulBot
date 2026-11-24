# ZySoulBot

> **灵魂是资产，模型与平台都是可插拔引擎。**
> 一套面向 QQ 陪伴场景、从零重构的多角色“活人感”数字灵魂中枢：灵魂原生轻量 Agent Loop（手脑合一）+ `node:sqlite`（WAL + FTS5）单文件记忆账本 + 昼夜身心/负面心结/修复关系引擎 + 异步 Mureka 唱歌 + 高审美二次元管理后台。

---

## 核心特性

1. **灵魂原生轻量 Agent Loop（手脑合一 + 极省 Token）**
   - 直接在 OpenAI 兼容 Chat Completions 上运行原生 `tool_calls` 循环，无多进程双重记忆割裂。
   - 严格 **静前动后** 三明治消息结构（静态人设前缀 + 按块滑动的历史窗口 + 末尾动态事实块），实测 Prefix Cache 命中率可达 **91%–93%**。
   - **回合级脏工具折叠**：网页正文/脚本输出只在当轮推理可见，落库只留极简一行摘要。
   - **极短寒暄跳过抽取** + **单次 Zod 校验五合一后处理** + 完整 SQLite `token_ledger` 账本。

2. **真实“活人感”灵魂架构**
   - **身心节律（BodyEngine）**：昼夜节律、生理精力与睡眠债、PAD/Mood 双层衰减、持久化情绪来由、双向活动体验反馈。
   - **三道门记忆（MemoryEngine）**：FTS5 中文检索 + 遗忘曲线与复习效应 + 隐私分级模糊披露 + 共同故事提取。
   - **正交关系演化（RelationEngine）**：信任 / 亲密 / 好感三轴双向演化与阶段升降。
   - **欲望与自主生活（DesireEngine + Rhythm）**：念头去重与双向成长/衰减、空闲自发联想（Mind Wandering）、统一生活决策（含 `energyFactor`）、自检造技能（`register_skill`）、秘钥隔离凭证（`0600`）与单一审批闭环。

3. **统一多模态表达层 & Mureka 异步唱歌**
   - 原生工具层按实际配置诚实注册：`send_voice`（火山豆包 ICL 2.0 SSE / OpenAI / 本地 HTTP）、`send_sticker`（情绪图库 + VLM 自动打标 + 陌生人负面收敛）、`react_message` / `poke_user`、`sing_song`。
   - **异步唱歌闭环**：她填词后调用 `sing_song` 立刻返回不阻塞聊天；`rhythm.ts` 后台轮询 Mureka，录完自动下载保存进 `works` 表并把语音条送给对方。

4. **高审美二次元管理后台（Hono + React 19 + Tailwind v4）**
   - 四套实时弹簧切换主题：**须弥薄荷 / 晴空天蓝 / 樱花桃粉 / 星夜深色**，系统数据用清晰无衬线与等宽数字，**她的日记、心事、歌词与发言用霞鹜文楷**。
   - 六大视图：今日概览 / 内心与生活 / 记忆与关系 / 声音与作品 / 灵魂与能力 / 账本与诊断。
   - scrypt 密码哈希 + HMAC HttpOnly Cookie + CSRF 防护 + 单进程静态托管 `web/dist`。

---

## 目录结构

```text
zySoulbot/
├─ personas/nahida/          # 纳西妲人设包（含 activities.json）
├─ src/
│  ├─ shared/                # 公开端口契约、错误分类、Zod 配置、时钟与串行队列
│  ├─ storage/               # node:sqlite (WAL + FTS5 13张表) 与日记本
│  ├─ soul/                  # 纯领域核心（严禁依赖外部框架/适配器）
│  │  ├─ persona/            # 人设包与世界书按需加载
│  │  ├─ body/               # 昼夜节律、精力、PAD 与情绪来由
│  │  ├─ memory/             # 三道门记忆、共同故事与按块窗口
│  │  ├─ relation/           # 三轴关系演化
│  │  ├─ agent/              # 灵魂原生轻量 Agent Loop 与 Token 计费
│  │  ├─ conversation/       # 统一回合管线、打断注意力与群聊在场感
│  │  ├─ desire/             # 欲望演化、自发联想与统一生活决策
│  │  ├─ expression/         # 表情包领域库
│  │  └─ governance/         # 凭证(0600)、单一审批与自主预算
│  ├─ llm/                   # OpenAI Chat、ASR、TTS（火山/OpenAI/本地）、Mureka、VLM 打标
│  ├─ tools/                 # 探索、联网(MCP+SSRF防护)、生活、沙箱工作区、多模态表达
│  ├─ transport/onebot11/    # NapCat WS、合泡、拆泡与媒体下载
│  ├─ admin/                 # 模块化 Hono REST API 与静态 SPA 托管
│  ├─ rhythm.ts              # 自主节律 + 提醒 + 异步唱歌轮询
│  ├─ app.ts                 # 唯一组合根
│  └─ start.ts               # 启动入口
├─ web/                      # 二次元 React 19 + Vite 管理后台前端
├─ scripts/                  # 真实网关冒烟与旧数据迁移脚本
├─ test/                     # 全链路离线单测与集成测试
└─ docs/                     # ARCHITECTURE.md & DESIGN.md
```

---

## 快速开始

需要 **Node.js >= 24**（内置原生 `.ts` 运行与 `node:sqlite`）和 **pnpm**。

```bash
# 1. 安装依赖
pnpm install
pnpm --dir web install

# 2. 构建管理后台前端静态包
pnpm run build:web

# 3. 准备配置文件
cp zysoul.config.example.json zysoul.config.json
# 编辑 zysoul.config.json 填入模型 apiKey、NapCat 地址、管理员 QQ 等
# （可选）配置 tts / mureka 启用语音与唱歌能力

# 4. 启动
pnpm start
# 首次启动会在 data/admin-auth.json 自动生成管理后台口令（也可通过环境变量 ZYSOUL_ADMIN_PASSWORD 指定）
```

### 质量门禁检查

```bash
pnpm check      # ESLint + TypeScript(strict) + dependency-cruiser(零循环依赖) + node --test
pnpm build:web  # 前端 TypeScript 校验 + Vite 生产构建
```

### 从旧 `zhuiyebot` 一次性迁移记忆（只读源目录）

```bash
# 先预演查看统计，不落盘
node scripts/migrate-from-zhuiyebot.ts --from ../zhuiyebot/data/bots/nahida --to ./data/bots/nahida --dry-run

# 确认无误后正式导入
node scripts/migrate-from-zhuiyebot.ts --from ../zhuiyebot/data/bots/nahida --to ./data/bots/nahida
```
