// 唯一组合根：装配 Storage(soul.db) + Persona + Soul + Native Tools + Governance + Rhythm + OneBot11。
// 不含复杂领域逻辑；所有依赖均可注入，支持全链路离线集成测试。
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BotConfig, ZysoulConfig } from './shared/config.ts'
import type {
  AsrPort,
  ChatModel,
  ImagePart,
  IncomingMessage,
  SendTarget,
  SingingPort,
  TransportPort,
  TtsPort,
} from './shared/ports.ts'
import { SerialQueue } from './shared/serial-queue.ts'
import { nowLocal, resolveEnvValue, systemClock } from './shared/time.ts'
import type { Clock } from './shared/time.ts'
import { SqliteSoulStore } from './storage/sqlite-store.ts'
import { DiaryBook } from './storage/diary.ts'
import { loadPersonaPack } from './storage/persona-loader.ts'
import { StickerLibrary } from './storage/sticker-store.ts'
import { CredentialStore } from './storage/credentials-store.ts'
import { Soul } from './soul/index.ts'
import { decideAttention } from './soul/conversation/attention.ts'
import { decideGroupChime, decideShouldWait, GroupPresence } from './soul/conversation/group.ts'
import { isApprovalGranted, isApprovalRejected } from './soul/governance/approval.ts'
import { createOpenAIChatModel } from './llm/openai-chat.ts'
import { createAsrAdapter } from './llm/asr.ts'
import { createTtsAdapter } from './llm/tts.ts'
import { createMurekaAdapter } from './llm/mureka.ts'
import { InMemoryToolRegistry, registerSelfExplorationTools } from './tools/registry.ts'
import { registerWebTools } from './tools/web.ts'
import { registerSelfLifeTools } from './tools/self.ts'
import { registerWorkspaceTools } from './tools/workspace.ts'
import { registerExpressionTools } from './tools/express.ts'
import { createOneBot11Transport } from './transport/onebot11/adapter.ts'
import type { WsLike } from './transport/onebot11/adapter.ts'
import { MessageBatcher } from './transport/onebot11/batcher.ts'
import { fetchInboundImages } from './transport/onebot11/media.ts'
import { createRhythm } from './rhythm.ts'
import type { RhythmHandle } from './rhythm.ts'
import { createAdminApp, startAdminServer } from './admin/server.ts'
import type { AdminAppBundle, AdminServerHandle } from './admin/server.ts'

export function accessAllowed(
  cfg: BotConfig['access'],
  target: { userId: string; groupId?: string | null },
): boolean {
  if (target.groupId) {
    return cfg.groups.length === 0 || cfg.groups.includes(String(target.groupId))
  }
  return cfg.users.length === 0 || cfg.users.includes(String(target.userId))
}

export interface BotRuntime {
  config: BotConfig
  botDir: string
  personaDir: string
  soul: Soul
  store: SqliteSoulStore
  diary: DiaryBook
  credentials: CredentialStore
  groupPresence: GroupPresence
  stickers: StickerLibrary | null
  tts: TtsPort | null
  singing: SingingPort | null
  transport: TransportPort | null
}

export interface AppDeps {
  fetchImpl?: typeof fetch
  wsFactory?: (url: string, headers: Record<string, string>) => WsLike
  chatModelOverride?: ChatModel
  auxModelOverride?: ChatModel
  ttsOverride?: TtsPort
  singingOverride?: SingingPort
  clock?: Clock
  random?: () => number
  inMemoryDb?: boolean
  rhythmStartupGraceMs?: number
  adminAuthFilePath?: string
  adminInitialPassword?: string
  adminWebDistDir?: string
  listenAdmin?: boolean
}

export interface AppHandle {
  bots: BotRuntime[]
  queue: SerialQueue
  rhythm: RhythmHandle
  admin: AdminAppBundle | null
  start(): Promise<void>
  dispose(): Promise<void>
}

export function createApp(config: ZysoulConfig, deps: AppDeps = {}): AppHandle {
  const clock = deps.clock ?? systemClock
  const chatModel = deps.chatModelOverride ?? createOpenAIChatModel({
    id: 'chat',
    baseUrl: config.chatLlm.baseUrl,
    apiKey: config.chatLlm.apiKey,
    model: config.chatLlm.model,
    timeoutMs: config.chatLlm.timeoutMs,
    fetchImpl: deps.fetchImpl,
  })
  const auxModel = deps.auxModelOverride ?? (config.auxLlm
    ? createOpenAIChatModel({
      id: 'aux',
      baseUrl: config.auxLlm.baseUrl,
      apiKey: config.auxLlm.apiKey,
      model: config.auxLlm.model,
      timeoutMs: config.auxLlm.timeoutMs,
      fetchImpl: deps.fetchImpl,
    })
    : chatModel)

  const priceTable = {
    inputPerMillionCny: config.chatLlm.pricePerMillionInputCny ?? 1.0,
    cachedPerMillionCny: config.chatLlm.pricePerMillionCachedCny ?? 0.2,
    outputPerMillionCny: config.chatLlm.pricePerMillionOutputCny ?? 2.0,
  }

  const queue = new SerialQueue()
  const batchers: Array<MessageBatcher<IncomingMessage>> = []
  const bots: BotRuntime[] = []
  const rhythmBots: Parameters<typeof createRhythm>[0]['bots'] = []

  const adminPublicUrl = config.admin?.publicUrl
    ?? (config.admin ? `http://${config.admin.host === '0.0.0.0' ? '127.0.0.1' : config.admin.host}:${config.admin.port}` : undefined)

  for (const botCfg of config.bots) {
    const botDir = resolve(botCfg.dataDir)
    const personaDir = resolve(botCfg.personaDir ?? join(botDir, 'persona-pack'))
    const persona = loadPersonaPack(personaDir)
    const store = new SqliteSoulStore(deps.inMemoryDb ? ':memory:' : join(botDir, 'soul.db'))
    const diary = new DiaryBook(botDir)
    const credentials = new CredentialStore(resolve(botCfg.proactivity.credentialsPath ?? join(botDir, 'credentials.json')))
    const groupPresence = new GroupPresence({
      enabled: botCfg.group.enabled,
      judgeGapMs: botCfg.group.judgeGapMs,
      minSinceBotSpoke: botCfg.group.minSinceBotSpoke,
      minChars: botCfg.group.minChars,
      chimeMin: botCfg.group.chimeMin,
    })

    let lastRequestedCred: string | null = null

    // 装配完整工具腰带：探索 + 生活 + 联网 + 隔离工作区/自造技能/凭证
    const tools = new InMemoryToolRegistry()
    registerSelfExplorationTools(tools, { store, persona })
    registerSelfLifeTools(tools, { store, diary })
    registerWorkspaceTools(tools, {
      workspaceDir: join(botDir, 'workspace'),
      store,
      credentials,
      allowCreate: (ctx) => ctx.solo || (!ctx.isGroup && botCfg.access.admins.includes(ctx.userId)),
      allowUnsafeLocalExec: botCfg.proactivity.allowUnsafeLocalExec,
      onCredentialRequested: (name) => { lastRequestedCred = name },
    })
    if (botCfg.webSearch?.enabled !== false) {
      registerWebTools(tools, {
        mcp: botCfg.webSearch?.mcpUrl
          ? { url: botCfg.webSearch.mcpUrl, apiKey: botCfg.webSearch.mcpApiKey, toolName: botCfg.webSearch.mcpToolName }
          : undefined,
        responses: botCfg.webSearch?.useResponsesFallback !== false
          ? { baseUrl: config.chatLlm.baseUrl, apiKey: config.chatLlm.apiKey, model: config.chatLlm.model }
          : undefined,
        fetchImpl: deps.fetchImpl,
      })
    }

    const soul = new Soul({
      botId: botCfg.id,
      persona,
      store,
      chatModel,
      auxModel,
      tools,
      traits: botCfg.traits,
      baselinePad: botCfg.baselinePad,
      relationDefaultType: botCfg.relations.defaultType,
      identityCall: botCfg.relations.identityCall,
      clock,
      priceTable,
    })

    const ttsReady = botCfg.tts
      ? (botCfg.tts.provider === 'local' || Boolean(resolveEnvValue(botCfg.tts.apiKey)))
      : false
    const tts: TtsPort | null = deps.ttsOverride ?? (botCfg.tts && ttsReady
      ? createTtsAdapter(botCfg.tts, { fetchImpl: deps.fetchImpl })
      : null)
    const singing: SingingPort | null = deps.singingOverride ?? (botCfg.mureka && resolveEnvValue(botCfg.mureka.apiKey)
      ? createMurekaAdapter({ ...botCfg.mureka, fetchImpl: deps.fetchImpl })
      : null)
    const stickers: StickerLibrary | null = botCfg.stickers?.enabled === false
      ? null
      : new StickerLibrary(resolve(botCfg.stickers?.dir ?? join(botDir, 'stickers')), {
        cooldownTurns: botCfg.stickers?.cooldownTurns,
        cooldownMs: botCfg.stickers?.cooldownMs,
        recentK: botCfg.stickers?.recentK,
        strangerThreshold: botCfg.stickers?.strangerThreshold,
        random: deps.random,
      })

    const asr: AsrPort | null = botCfg.asr && resolveEnvValue(botCfg.asr.apiKey)
      ? createAsrAdapter({ ...botCfg.asr, fetchImpl: deps.fetchImpl })
      : null

    const inboxDir = join(botDir, 'media', 'inbox')
    let transport: TransportPort | null = null

    registerExpressionTools(tools, {
      store,
      relations: soul.relations,
      getTransport: () => transport,
      tts,
      singing,
      stickers,
      defaultVocalId: botCfg.mureka?.vocalId,
    })

    const transcribeVoice = async (msg: IncomingMessage, baseText: string): Promise<string> => {
      if (!asr || !msg.attachments?.length) return baseText
      const records = msg.attachments.filter((a) => a.kind === 'record' && a.url).slice(0, 2)
      if (records.length === 0) return baseText
      const parts: string[] = []
      const fetchImpl = deps.fetchImpl ?? globalThis.fetch
      for (const r of records) {
        try {
          const res = await fetchImpl(r.url!, { signal: AbortSignal.timeout(20_000) })
          if (!res.ok) continue
          const bytes = new Uint8Array(await res.arrayBuffer())
          if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) continue
          const text = await asr.transcribe({ audio: bytes, filename: 'voice.mp3', mimeType: 'audio/mpeg' })
          if (text) parts.push(text)
        } catch (e) {
          store.logTrace({ traceId: `asr_${randomUUID().slice(0, 8)}`, event: 'asr_fail', level: 'warn', data: { error: (e as Error).message.slice(0, 140) } })
        }
      }
      if (parts.length === 0) return baseText
      return [baseText.replace(/\[语音\]/g, '').trim(), parts.join(' ')].filter(Boolean).join(' ').trim()
    }

    // 唯一审批闭环：管理员私聊回复时，判定是否在批悬着的那一条请求；返回事实通知交给本轮。
    const checkAdminApproval = async (userId: string, text: string, now: Date, traceId: string): Promise<string | undefined> => {
      const isAdmin = botCfg.access.admins.includes(userId) || botCfg.proactivity.allowlist[0] === userId
      if (!isAdmin) return undefined
      const pending = soul.approvals.pending(now)
      if (!pending) return undefined
      const verdict = await soul.approvals.judgeReply(
        { model: auxModel, priceTable },
        { traceId, what: pending.what, reply: text },
      )
      store.logTrace({ traceId, event: 'approval_judged', level: 'info', data: { id: pending.id, verdict: verdict.verdict, conf: verdict.confidence } })
      if (isApprovalGranted(verdict)) {
        soul.approvals.resolve(pending, 'approved', now)
        const d = store.getDesire(pending.targetId)
        if (d) {
          const stamp = nowLocal(now)
          d.stage = 'active'
          d.blocker = null
          d.approvedPlanVersion = (d.approvedPlanVersion ?? 0) + 1
          d.rejectedUntil = undefined
          d.progressNote = '管理员已经点头同意了'
          d.lastProgressAt = stamp
          d.updatedAt = stamp
          store.upsertDesire(d)
        }
        return `刚才你提的请求「${pending.what}」，他答应了。`
      }
      if (isApprovalRejected(verdict)) {
        soul.approvals.resolve(pending, 'rejected', now)
        const d = store.getDesire(pending.targetId)
        if (d) {
          const stamp = nowLocal(now)
          d.stage = 'active'
          d.blocker = null
          d.rejectedUntil = nowLocal(new Date(now.getTime() + 24 * 3_600_000))
          d.progressNote = '这次他没答应，先搁置一段时间'
          d.lastProgressAt = stamp
          d.updatedAt = stamp
          store.upsertDesire(d)
        }
        return `刚才你提的请求「${pending.what}」，他这次没答应。`
      }
      return undefined
    }

    const runTurn = (
      msg: IncomingMessage,
      mergedText: string,
      opts: { mentionUserId?: string | null; chimeApproved?: boolean; images?: ImagePart[]; unreadCount?: number } = {},
    ): void => {
      void queue.enqueue(botCfg.id, async () => {
        const traceId = `tr_${randomUUID().slice(0, 10)}`
        const now = clock.now()
        try {
          const heard = await transcribeVoice(msg, mergedText)
          const isGroup = msg.messageType === 'group'

          // 正在做事时的注意力/打断决策
          const activeAct = soul.body.state(now).activity
          if (activeAct && !opts.chimeApproved) {
            const relFacts = soul.relations.renderRelationFacts({
              userId: msg.userId,
              displayName: msg.userName,
              now,
              sharedStories: soul.memory.sharedStories(msg.userId, 2),
              lastContactIso: store.lastUserContactAt(msg.userId),
            })
            const verdict = await decideAttention(
              { model: auxModel, store, priceTable },
              {
                traceId,
                personaName: persona.name,
                personaSummary: persona.summary || persona.identity.slice(0, 140),
                activity: activeAct,
                bodyFacts: soul.body.renderBodyFacts(now),
                relationFacts: relFacts,
                relationStage: soul.relations.get(msg.userId).stage,
                message: heard,
                unreadCount: opts.unreadCount ?? 1,
                isGroup,
                isAtMe: Boolean(msg.atMe),
                now,
              },
            )
            store.logTrace({ traceId, event: 'attention_decision', level: 'info', data: { decision: verdict.decision, activity: activeAct.id, reason: verdict.reason } })
            if (verdict.decision !== 'now') {
              store.appendMessage({
                threadKey: msg.threadKey,
                role: 'user',
                userId: msg.userId,
                userName: soul.relations.nameOf(msg.userId, msg.userName),
                content: heard || '[图片]',
                toolSummary: null,
                mediaJson: null,
                createdAt: nowLocal(now),
              })
              if (verdict.decision === 'later') {
                store.addPendingReply({
                  userId: msg.userId,
                  userName: soul.relations.nameOf(msg.userId, msg.userName),
                  threadKey: msg.threadKey,
                  text: heard || '[图片]',
                  createdAt: nowLocal(now),
                })
              }
              return
            }
          }

          // 私聊时先检查管理员是否在批悬着的那一条请求
          const approvalNotice = !isGroup && heard
            ? await checkAdminApproval(msg.userId, heard, now, traceId)
            : undefined

          const target: SendTarget = isGroup
            ? { messageType: 'group', groupId: msg.groupId ?? undefined }
            : { messageType: 'private', userId: msg.userId }

          // P0-3：冻结会话内 tools 数组（统一 ['explore','express','create']），细粒度权限由执行层门控拦截，绝不动态删工具破 Prefix Cache
          stickers?.tickRoute(msg.threadKey)
          await soul.handleTurn({
            mode: 'chat',
            threadKey: msg.threadKey,
            userId: msg.userId,
            userName: msg.userName,
            groupId: msg.groupId,
            messageId: msg.messageId,
            text: heard,
            images: opts.images,
            isGroup,
            notice: approvalNotice,
            toolLayers: ['explore', 'express', 'create'],
            maxHistoryMessages: botCfg.budget.maxHistoryMessages,
            compactDropCount: botCfg.budget.compactDropCount,
            onReply: async (reply) => {
              if (!transport) return
              await transport.send(target, {
                type: 'text',
                text: reply,
                mentionUserId: isGroup ? (opts.mentionUserId ?? null) : null,
              })
              if (isGroup) groupPresence.noteBotSpoke(msg.threadKey, msg.userId, clock.now().getTime())
            },
          })
        } catch (e) {
          store.logTrace({
            traceId,
            event: 'turn_error',
            level: 'error',
            data: { userId: msg.userId, error: (e as Error).message.slice(0, 200) },
          })
        }
      })
    }

    const observeGroup = (msg: IncomingMessage, mergedText: string): void => {
      void queue.enqueue(botCfg.id, async () => {
        const traceId = `grp_${randomUUID().slice(0, 8)}`
        const now = clock.now()
        try {
          const gate = groupPresence.checkCheapGate(msg.threadKey, mergedText, { atMe: msg.atMe, nowMs: now.getTime() })
          if (!gate.worthJudging) return
          const recent = store.recentMessages(msg.threadKey, 10)
            .map((m) => `${m.userName}: ${m.content}`)
            .join('\n')
          const speakerRel = soul.relations.get(msg.userId)
          const verdict = await decideGroupChime(
            { model: auxModel, store, priceTable },
            {
              traceId,
              botName: persona.name,
              recentText: recent,
              currentText: mergedText,
              speakerName: soul.relations.nameOf(msg.userId, msg.userName),
              speakerId: msg.userId,
              speakerStage: speakerRel.stage,
              speakerStrained: soul.relations.isStrained(msg.userId),
              sinceBotSpoke: gate.sinceBotSpoke,
              activity: soul.body.state(now).activity,
            },
          )
          if (!verdict || verdict.speak < botCfg.group.chimeMin) {
            store.logTrace({ traceId, event: 'group_chime_skip', level: 'info', data: { speak: verdict?.speak ?? null, kind: verdict?.kind ?? null } })
            return
          }
          store.logTrace({ traceId, event: 'group_chime', level: 'info', data: { speak: verdict.speak, kind: verdict.kind } })
          const urls = groupPresence.takeRecentImages(msg.threadKey, now.getTime())
          const imgs = urls.length ? await fetchInboundImages(urls, { inboxDir, fetchImpl: deps.fetchImpl }) : []
          runTurn(msg, mergedText, { mentionUserId: verdict.mentionUserId, chimeApproved: true, images: imgs })
        } catch (e) {
          store.logTrace({ traceId, event: 'group_observe_error', level: 'warn', data: { error: (e as Error).message.slice(0, 160) } })
        }
      })
    }

    const privateBatcher = new MessageBatcher<IncomingMessage>({
      quietMs: botCfg.batch.privateQuietMs,
      maxWaitMs: botCfg.batch.privateMaxWaitMs,
      onFlush: (_key, items) => {
        const last = items[items.length - 1]!
        const urls = [...new Set(items.flatMap((i) => i.images ?? []))]
        const text = items.map((i) => i.text).filter(Boolean).join('\n')
        void (urls.length ? fetchInboundImages(urls, { inboxDir, fetchImpl: deps.fetchImpl }) : Promise.resolve([]))
          .then((imgs) => runTurn(last, text, { images: imgs, unreadCount: items.length }))
      },
    })

    const groupBatcher = new MessageBatcher<IncomingMessage>({
      quietMs: botCfg.batch.groupQuietMs,
      maxWaitMs: botCfg.batch.groupMaxWaitMs,
      extendMs: botCfg.batch.groupExtendMs,
      maxExtensions: botCfg.batch.groupMaxExtensions,
      shouldWait: async (key, items) => {
        if (items.some((i) => i.atMe)) return false
        const recent = store.recentMessages(key, 6).map((m) => `${m.userName}: ${m.content}`).join('\n')
        const pending = items.map((i) => `${i.userName || i.userId}: ${i.text}`).join('\n')
        return decideShouldWait({ model: auxModel, store, priceTable }, { recent, pending })
      },
      onFlush: (key, items) => {
        const last = items[items.length - 1]!
        const atMe = items.some((i) => i.atMe)
        const inFollow = items.some((i) => groupPresence.inFollowUp(key, i.userId, clock.now().getTime()))
        const batchUrls = [...new Set([...items.flatMap((i) => i.images ?? []), ...groupPresence.takeRecentImages(key, clock.now().getTime())])]

        if (atMe || inFollow || botCfg.group.ambient) {
          for (const it of items.slice(0, -1)) {
            store.appendMessage({
              threadKey: key,
              role: 'user',
              userId: it.userId,
              userName: soul.relations.nameOf(it.userId, it.userName),
              content: it.text || '[图片]',
              toolSummary: null,
              mediaJson: null,
              createdAt: nowLocal(clock.now()),
            })
          }
          const withSpeaker = items.filter((i) => i.text).map((i) => `${soul.relations.nameOf(i.userId, i.userName)}: ${i.text}`).join('\n')
          void (batchUrls.length ? fetchInboundImages(batchUrls, { inboxDir, fetchImpl: deps.fetchImpl }) : Promise.resolve([]))
            .then((imgs) => runTurn(last, withSpeaker, { images: imgs, unreadCount: items.length }))
        } else {
          for (const it of items) {
            if (it.images?.length) groupPresence.noteGroupImages(key, it.images, clock.now().getTime())
            store.appendMessage({
              threadKey: key,
              role: 'user',
              userId: it.userId,
              userName: soul.relations.nameOf(it.userId, it.userName),
              content: it.text || '[图片]',
              toolSummary: null,
              mediaJson: null,
              createdAt: nowLocal(clock.now()),
            })
          }
          const merged = items.map((i) => i.text).filter(Boolean).join('\n')
          if (merged) observeGroup(last, merged)
        }
      },
    })

    batchers.push(privateBatcher, groupBatcher)

    if (botCfg.napcatWs) {
      transport = createOneBot11Transport({
        botId: botCfg.id,
        url: botCfg.napcatWs,
        token: botCfg.napcatToken,
        selfId: botCfg.selfId,
        wsFactory: deps.wsFactory,
        onLog: (level, msg) => {
          store.logTrace({ traceId: 'transport', event: 'onebot_log', level, data: { msg } })
        },
        onMessage: (msg) => {
          if (!accessAllowed(botCfg.access, { userId: msg.userId, groupId: msg.groupId })) {
            store.logTrace({ traceId: 'access', event: 'access_denied', level: 'info', data: { userId: msg.userId, groupId: msg.groupId } })
            return
          }
          if (msg.messageType === 'private') privateBatcher.push(msg.threadKey, msg)
          else groupBatcher.push(msg.threadKey, msg)
        },
      })
    }

    const runtime: BotRuntime = {
      config: botCfg,
      botDir,
      personaDir,
      soul,
      store,
      diary,
      credentials,
      groupPresence,
      stickers,
      tts,
      singing,
      transport,
    }
    bots.push(runtime)
    rhythmBots.push({
      config: botCfg,
      soul,
      diary,
      credentials,
      transport,
      singing,
      songsDir: join(botDir, 'media', 'songs'),
      fetchImpl: deps.fetchImpl,
      adminPublicUrl,
      takeRequestedCredential: () => {
        const v = lastRequestedCred
        lastRequestedCred = null
        return v
      },
    })
  }

  const rhythm = createRhythm({
    bots: rhythmBots,
    queue,
    priceTable,
    clock,
    random: deps.random,
    startupGraceMs: deps.rhythmStartupGraceMs,
  })

  const adminAuthPath = deps.adminAuthFilePath
    ?? resolve(bots[0]?.botDir ? join(bots[0].botDir, '..', 'admin-auth.json') : join(process.cwd(), 'data', 'admin-auth.json'))

  const toAdminBot = (b: BotRuntime) => ({
    config: b.config,
    botDir: b.botDir,
    personaDir: b.personaDir,
    soul: b.soul,
    diary: b.diary,
    credentials: b.credentials,
    stickers: b.stickers,
    tts: b.tts,
    singing: b.singing,
    transport: b.transport,
    reloadPersona: () => {
      b.soul.persona = loadPersonaPack(b.personaDir)
    },
    runSerialized: <T>(fn: () => Promise<T> | T): Promise<T> => queue.enqueue(b.config.id, async () => fn()),
  })

  const admin: AdminAppBundle | null = config.admin
    ? createAdminApp({
      bots: bots.map(toAdminBot),
      authFilePath: adminAuthPath,
      webDistDir: deps.adminWebDistDir,
      initialPassword: deps.adminInitialPassword ?? process.env.ZYSOUL_ADMIN_PASSWORD,
      trustProxy: config.admin.trustProxy,
      clock,
      getBot: (id) => {
        const b = bots.find((x) => x.config.id === id)
        return b ? toAdminBot(b) : undefined
      },
    })
    : null

  let adminServer: AdminServerHandle | null = null

  return {
    bots,
    queue,
    rhythm,
    admin,
    async start(): Promise<void> {
      for (const b of bots) {
        await b.transport?.start()
      }
      if (admin && config.admin && deps.listenAdmin !== false) {
        adminServer = startAdminServer(admin, { host: config.admin.host, port: config.admin.port })
        if (admin.auth.generatedPassword && admin.auth.initialPasswordFilePath) {
          console.log(`[ZySoulBot] 首次随机管理员口令已写入受限文件（0600）：${admin.auth.initialPasswordFilePath}（登录改密后将自动销毁）`)
        }
      }
      rhythm.start()
    },
    async dispose(): Promise<void> {
      rhythm.stop()
      if (adminServer) {
        await adminServer.close()
        adminServer = null
      }
      for (const batcher of batchers) batcher.dispose()
      for (const b of bots) await b.transport?.dispose()
      const deadline = Date.now() + 5000
      while (bots.some((b) => queue.busy(b.config.id)) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30))
      }
      for (const b of bots) b.store.close()
    },
  }
}
