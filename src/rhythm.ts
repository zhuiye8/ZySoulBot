// 自主节律编排器（非 soul 内部定时，由组合根装配）：
// - 粗 tick（默认 5 分钟，纯代码零 token；命中条件才调模型）：身心演化 → 活动收尾与回过神回复 → 凭证唤醒 → 欲望演化与成型 → 确定性授权/凭证提醒 → 日记/反思/自发联想 → 统一生活决策与推进念头
// - 细 tick（默认 1 分钟）：精确提醒履约
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BotConfig } from './shared/config.ts'
import type { DesireRecord, SendTarget, SingingPort, TransportPort } from './shared/ports.ts'
import type { SerialQueue } from './shared/serial-queue.ts'
import { nowLocal, systemClock, todayLocal } from './shared/time.ts'
import type { Clock } from './shared/time.ts'
import type { DiaryBook } from './storage/diary.ts'
import type { Soul } from './soul/index.ts'
import type { CredentialStore } from './soul/governance/credentials.ts'
import { checkAutonomousBudget, inQuietHours } from './soul/governance/budget.ts'
import { checkBuildScope } from './soul/desire/engine.ts'
import {
  activitiesForSlot,
  collectSocialMotives,
  composeActivityThinking,
  composeOutreach,
  decideLifeAction,
  lifeRoll,
  pickActivityDuration,
  reflectOnToday,
  shouldConsiderDiary,
} from './soul/desire/life.ts'
import type { PriceTable } from './soul/agent/loop.ts'

export interface RhythmBot {
  config: BotConfig
  soul: Soul
  diary: DiaryBook
  credentials: CredentialStore
  transport: TransportPort | null
  singing?: SingingPort | null
  songsDir?: string
  fetchImpl?: typeof fetch
  adminPublicUrl?: string
  /** 捕获独处回合里新登记的凭证名（由 workspace 工具回调写入） */
  takeRequestedCredential(): string | null
}

export interface RhythmOptions {
  bots: RhythmBot[]
  queue: SerialQueue
  priceTable?: PriceTable
  tickMs?: number
  reminderTickMs?: number
  startupGraceMs?: number
  wanderProbability?: number
  clock?: Clock
  random?: () => number
}

export interface RhythmHandle {
  start(): void
  stop(): void
  tickOnce(): Promise<void>
  reminderTick(): Promise<void>
  songTick(): Promise<void>
}

export function createRhythm(opts: RhythmOptions): RhythmHandle {
  const clock = opts.clock ?? systemClock
  const random = opts.random ?? Math.random
  const tickMs = opts.tickMs ?? 300_000
  const reminderTickMs = opts.reminderTickMs ?? 60_000
  const startupGraceMs = opts.startupGraceMs ?? 180_000
  const wanderProb = opts.wanderProbability ?? 0.08

  let timer: ReturnType<typeof setInterval> | null = null
  let reminderTimer: ReturnType<typeof setInterval> | null = null
  let startedAt = 0
  const lastActMs = new Map<string, number>()
  const reflectedOnDay = new Map<string, string>()

  const targetOf = (threadKey: string, userId: string): SendTarget => {
    if (threadKey.startsWith('qq:group:')) {
      return { messageType: 'group', groupId: threadKey.slice('qq:group:'.length) }
    }
    return { messageType: 'private', userId }
  }

  const sendPrivate = async (bot: RhythmBot, userId: string, text: string): Promise<void> => {
    if (!bot.transport || !text.trim()) return
    await bot.transport.send({ messageType: 'private', userId }, { type: 'text', text })
  }

  const credentialFooter = (bot: RhythmBot, label: string): string => {
    const base = (bot.adminPublicUrl ?? '').replace(/\/+$/, '')
    const link = base ? `${base}/#/b/${encodeURIComponent(bot.config.id)}/credentials` : ''
    return link
      ? `\n\n（系统提示：后台填「${label}」的凭证 ${link} ，填好她就能接着做）`
      : `\n\n（系统提示：后台「凭证」页填「${label}」，填好她就能接着做）`
  }

  const pursueDesire = async (bot: RhythmBot, desire: DesireRecord, now: Date, traceId: string): Promise<void> => {
    const { soul, config } = bot
    const admin = config.access.admins[0] ?? config.proactivity.allowlist[0] ?? ''

    // 若是造技能：先过代码硬安全门（注意：缺凭证允许进入，且显式提示她调 request_credential）
    let needsCredentialHint = false
    if (desire.exitKind === 'build_skill') {
      const scope = checkBuildScope(desire, { autonomyEnabled: config.proactivity.autonomyBuildEnabled })
      if (!scope.allowed) {
        if (scope.hardBlocked) {
          desire.stage = 'abandoned'
          desire.progressNote = `触碰硬边界（${scope.reason}），放弃自己动手`
          desire.updatedAt = nowLocal(now)
          soul.store.upsertDesire(desire)
          soul.store.logTrace({ traceId, event: 'desire_hard_blocked', level: 'info', data: { desireId: desire.id, reason: scope.reason } })
        } else if (scope.needsApproval) {
          desire.stage = 'waiting_approval'
          desire.blocker = { kind: 'approval', what: `我想自己动手做「${desire.want}」，需要你点个头允许` }
          desire.updatedAt = nowLocal(now)
          soul.store.upsertDesire(desire)
          soul.store.logTrace({ traceId, event: 'desire_needs_approval', level: 'info', data: { desireId: desire.id, reason: scope.reason } })
        }
        return
      }
      needsCredentialHint = scope.requiresCredential
    }

    desire.stage = 'in_progress'
    desire.updatedAt = nowLocal(now)
    soul.store.upsertDesire(desire)
    bot.takeRequestedCredential() // 清空旧标记

    const specNote = desire.spec
      ? `\n工程参考：${JSON.stringify(desire.spec)}`
      : ''
    const credNote = needsCredentialHint
      ? '\n这件事需要外部服务密钥：先调研该服务所需字段，调用 request_credential 登记，登记完就暂停等他填好，不要硬猜密钥。'
      : ''
    const prompt = `（这是你自己心里冒出来想做的事，没人要求你）
你想做：${desire.want}
起因：${desire.why}${specNote}${credNote}
请直接用你的工具推进这件事：查资料、写脚本并调 register_skill 自检，或者把感想/作品写下来。做完用你自己的话简短总结结果；如果卡在缺凭证或没做成，如实说清楚。`

    try {
      const out = await soul.handleTurn({
        mode: 'solo',
        threadKey: `solo:desire:${desire.id}`,
        userId: admin || bot.config.id,
        userName: admin ? soul.relations.nameOf(admin) : soul.persona.name,
        text: prompt,
        toolLayers: ['explore', 'create', 'express'],
        reasoningEffort: desire.exitKind === 'build_skill' ? 'high' : 'low',
        maxSteps: desire.exitKind === 'build_skill' ? 14 : 6,
      })

      const requestedCred = bot.takeRequestedCredential()
      if (requestedCred && !bot.credentials.isReady(requestedCred)) {
        desire.stage = 'waiting_credential'
        desire.blocker = { kind: 'credential', what: `等后台填写凭证「${requestedCred}」`, payload: { credName: requestedCred } }
        desire.progressNote = `已登记需要「${requestedCred}」凭证，等填好再继续`
        desire.updatedAt = nowLocal(now)
        soul.store.upsertDesire(desire)
        soul.store.logTrace({ traceId, event: 'desire_waiting_credential', level: 'info', data: { desireId: desire.id, credName: requestedCred } })
        return
      }

      desire.stage = 'fulfilled'
      desire.progressNote = (out.reply || out.toolSummaries.join('；') || '完成了').slice(0, 180)
      desire.updatedAt = nowLocal(now)
      soul.store.upsertDesire(desire)

      // 真实情绪与记忆闭环：做完心里惦记的事会雀跃，也会进记忆
      soul.body.appraise({
        source: 'desire',
        affectKind: 'praised',
        intensity: 0.45,
        confidence: 0.85,
        text: `把心里想做的事推进完了：${desire.want}`,
        now,
      })
      soul.memory.remember({
        kind: 'experience',
        text: `我自己推进了「${desire.want}」：${desire.progressNote}`,
        about: [],
        sensitivity: 'open',
        tier: 'season',
        disclosable: 'volunteer',
        consented: false,
        source: 'life',
        threadKey: 'life',
        affect: 'praised',
        createdAt: nowLocal(now),
      })

      // 造出新东西时，若配置了管理员且回复不为空，轻声告诉他一声
      if (desire.exitKind === 'build_skill' && admin && out.reply) {
        await sendPrivate(bot, admin, out.reply)
      }
      soul.store.logTrace({ traceId, event: 'desire_pursued_done', level: 'info', data: { desireId: desire.id, exitKind: desire.exitKind, steps: out.steps } })
    } catch (e) {
      // 真实受挫：不静默消失，记进展并轻微回流情绪
      desire.stage = 'active'
      desire.progressNote = `刚才试了一下没顺：${(e as Error).message.slice(0, 120)}`
      desire.updatedAt = nowLocal(now)
      soul.store.upsertDesire(desire)
      soul.body.appraise({
        source: 'desire',
        affectKind: 'sadness',
        intensity: 0.25,
        confidence: 0.7,
        text: `想做「${desire.want}」但这次没弄成`,
        now,
      })
      soul.store.logTrace({ traceId, event: 'desire_pursue_error', level: 'warn', data: { desireId: desire.id, error: (e as Error).message.slice(0, 180) } })
    }
  }

  const runBotMaintenance = async (bot: RhythmBot, now: Date): Promise<void> => {
    const { soul, config, diary, credentials } = bot
    const traceId = `tick_${randomUUID().slice(0, 8)}`
    const model = soul.auxModel ?? soul.chatModel
    const priceTable = opts.priceTable

    // 1) 身心墙钟演化（0 token）
    soul.body.tick(now)

    // 2) 活动到点收尾：真实应用精力/PAD/驱力反馈 + 记见闻 + 回过神处理 pending_replies
    const finished = soul.body.completeActivityIfDue(now)
    if (finished) {
      if (finished.yields === 'sight' && finished.thinking) {
        soul.memory.remember({
          kind: 'experience',
          text: `${finished.label}时想到：${finished.thinking}`,
          about: [],
          sensitivity: 'open',
          tier: 'season',
          disclosable: 'volunteer',
          consented: false,
          source: 'life',
          threadKey: 'life',
          affect: 'curiosity',
          createdAt: nowLocal(now),
        })
      }
      soul.store.logTrace({ traceId, event: 'activity_finished', level: 'info', data: { id: finished.id, label: finished.label } })

      // 回过神：依次回复忙的时候攒下的消息
      for (const p of soul.store.takePendingReplies()) {
        try {
          const target = targetOf(p.threadKey, p.userId)
          await soul.handleTurn({
            mode: 'chat',
            threadKey: p.threadKey,
            userId: p.userId,
            userName: p.userName,
            text: p.text,
            isGroup: p.threadKey.startsWith('qq:group:'),
            notice: `你刚才忙完「${finished.label}」，回过神看到了他之前发来的话。`,
            onReply: async (reply) => { await bot.transport?.send(target, { type: 'text', text: reply }) },
          })
          soul.store.logTrace({ traceId, event: 'pending_reply_answered', level: 'info', data: { userId: p.userId } })
        } catch (e) {
          soul.store.logTrace({ traceId, event: 'pending_reply_error', level: 'warn', data: { userId: p.userId, error: (e as Error).message.slice(0, 140) } })
        }
      }
    }

    // 3) 凭证填好自动唤醒 waiting_credential 的欲望（0 token）
    const resumed = soul.desires.resumeReadyCredentials((name) => credentials.isReady(name), now)
    if (resumed.length > 0) {
      soul.store.logTrace({ traceId, event: 'desires_resumed_by_credential', level: 'info', data: { ids: resumed.map((d) => d.id) } })
    }

    // 4) 欲望双向演化（0 token）
    soul.desires.tick(now)

    // 5) 自主开关 / 重启保护期 / 安静时段 / 每日自主 Token 预算守卫
    if (!config.proactivity.enabled) return
    if (startedAt > 0 && now.getTime() - startedAt < startupGraceMs) return
    if (inQuietHours(now, config.proactivity.quietHours)) return

    const budget = checkAutonomousBudget(soul.store, config.budget.dailyAutonomousTokens, now)
    if (!budget.allowed) {
      soul.store.logTrace({ traceId, event: 'autonomous_budget_reached', level: 'info', data: budget })
      return
    }

    // 6) 把新萌芽的 seed 欲望单步成型（合并了旧版 transmute + capability-plan）
    await soul.desires.shapeSeeds(
      { model, readyCredentials: credentials.readyLabels(), priceTable },
      { traceId, now },
    )

    const allowlist = config.proactivity.allowlist
    const admin = config.access.admins[0] ?? allowlist[0] ?? ''

    // 7) 确定性出口 A：已登记但未填的外部凭证 → 提醒管理员一次（不走审批，填了就是同意）
    const dueCred = admin ? credentials.dueAsk(now.getTime()) : null
    if (dueCred && admin) {
      const text = await composeOutreach(
        { model, store: soul.store, persona: soul.persona, priceTable },
        {
          traceId,
          purpose: `你需要他帮你配一样外部服务的密钥：${dueCred.providerName ? `${dueCred.providerName}的` : ''}${dueCred.label}${dueCred.why ? `（因为：${dueCred.why}）` : ''}。`,
          relationFacts: soul.relations.renderRelationFacts({ userId: admin, now, sharedStories: soul.memory.sharedStories(admin, 2) }),
          memoryFacts: '',
          bodyFacts: soul.body.renderBodyFacts(now),
        },
      )
      if (text) {
        credentials.markAsked(dueCred.name, now)
        const full = `${text}${credentialFooter(bot, dueCred.label)}`
        await sendPrivate(bot, admin, full)
        soul.store.appendMessage({
          threadKey: `qq:private:${admin}`,
          role: 'assistant',
          userId: config.id,
          userName: soul.persona.name,
          content: full,
          toolSummary: null,
          mediaJson: null,
          createdAt: nowLocal(now),
        })
        soul.store.logTrace({ traceId, event: 'credential_asked', level: 'info', data: { name: dueCred.name, admin } })
        return
      }
    }

    // 8) 确定性出口 B：卡在管理员授权的欲望（同时最多只悬 1 条待批）
    if (admin && !soul.approvals.pending(now)) {
      const blocked = soul.store.listDesires(['waiting_approval']).find((d) => d.blocker && d.blocker.kind !== 'credential')
      if (blocked?.blocker && (blocked.blocker.kind === 'approval' || blocked.blocker.kind === 'allow-person')) {
        const text = await composeOutreach(
          { model, store: soul.store, persona: soul.persona, priceTable },
          {
            traceId,
            purpose: `你想做这件事：${blocked.want}。挡着你的是：${blocked.blocker.what}，只有他点头才能办。`,
            relationFacts: soul.relations.renderRelationFacts({ userId: admin, now, sharedStories: soul.memory.sharedStories(admin, 2) }),
            memoryFacts: '',
            bodyFacts: soul.body.renderBodyFacts(now),
          },
        )
        if (text) {
          soul.approvals.open({
            kind: blocked.blocker.kind,
            targetId: blocked.id,
            what: blocked.blocker.what,
            payload: blocked.blocker.payload ?? null,
            now,
          })
          await sendPrivate(bot, admin, text)
          soul.store.appendMessage({
            threadKey: `qq:private:${admin}`,
            role: 'assistant',
            userId: config.id,
            userName: soul.persona.name,
            content: text,
            toolSummary: null,
            mediaJson: null,
            createdAt: nowLocal(now),
          })
          soul.store.logTrace({ traceId, event: 'approval_asked', level: 'info', data: { desireId: blocked.id, admin } })
          return
        }
      }
    }

    // 9) 概率日记（她的自主行为，走 solo 回合调 write_diary 工具）& 每日晚间反思
    const today = todayLocal(now)
    if (!diary.has(today) && shouldConsiderDiary(now, random)) {
      const todaysMemories = soul.store.recentMemories(30).filter((m) => m.createdAt.startsWith(today))
      const material = todaysMemories.length
        ? todaysMemories.map((m) => `- ${m.text}`).join('\n')
        : '（今天很安静，没什么特别记下的事）'
      await soul.handleTurn({
        mode: 'solo',
        threadKey: `solo:diary:${today}`,
        userId: config.id,
        userName: soul.persona.name,
        text: `（今天快过去了。下面是今天记下的一些事：\n${material}\n\n你手边有 write_diary 工具，想写就用自己的口吻写几句今天；今天不想写也没关系。）`,
        toolLayers: ['explore', 'create'],
        reasoningEffort: 'low',
        maxSteps: 3,
      })
      soul.store.logTrace({ traceId, event: 'diary_considered', level: 'info', data: { today, wrote: diary.has(today) } })
    }

    if (now.getHours() >= 21 && reflectedOnDay.get(config.id) !== today) {
      reflectedOnDay.set(config.id, today)
      await reflectOnToday({ model, store: soul.store, persona: soul.persona, priceTable }, { traceId, now })
    }

    // 10) 空闲自发联想（Mind Wandering）：无活动且有精力时低概率触发，让旧记忆自然浮现
    const bodyState = soul.body.state(now)
    if (!bodyState.activity && bodyState.energy >= 0.35 && random() < wanderProb) {
      await soul.desires.mindWander(
        { model, persona: soul.persona, body: soul.body, priceTable, random },
        { traceId, now },
      )
    }

    // 11) 唯一生活决策点：收集动机 → 状态连续骰子 → 一次抉择（什么都不做 / 活动 / 说话 / 推进念头）
    const activeDesires = soul.store.listDesires(['active'])
    const socialDesires = activeDesires.filter((d) => d.exitKind === 'social')
    const actionableDesires = activeDesires.filter((d) => d.exitKind !== 'social')

    const people = allowlist.map((uid) => {
      const lastIso = soul.store.lastUserContactAt(uid)
      const lastMsgs = soul.store.recentMessages(`qq:private:${uid}`, 1)
      const lastAtMs = lastIso ? Date.parse(lastIso.replace(' ', 'T')) : undefined
      const rel = soul.relations.get(uid)
      return {
        userId: uid,
        name: soul.relations.nameOf(uid),
        lastAtMs: lastAtMs && Number.isFinite(lastAtMs) ? lastAtMs : undefined,
        lastText: lastMsgs[0]?.content,
        stage: rel.stage,
        turns: rel.turns,
        disengagement: rel.disengagement,
        tensions: rel.tensions,
      }
    })
    const duePromises = soul.store.dueSchedules(now.toISOString(), 'promise').filter((p) => allowlist.includes(p.userId))
    const motives = collectSocialMotives({ now, promises: duePromises, people, socialDesires })

    const roll = lifeRoll({
      state: bodyState,
      motives,
      actionableDesireCount: actionableDesires.length,
      now,
      lastActMs: lastActMs.get(config.id),
      random,
    })
    soul.store.logTrace({ traceId, event: 'life_roll', level: 'info', data: { p: roll.p, hit: roll.hit, factors: roll.factors, motives: motives.length, desires: actionableDesires.length } })
    if (!roll.hit) return

    const candidateActivities = activitiesForSlot(soul.persona.activities, now).map((def) => ({
      id: def.id,
      label: def.label,
      place: def.place,
      minutes: pickActivityDuration(def, bodyState, random),
    }))
    const choice = await decideLifeAction(
      { model, store: soul.store, persona: soul.persona, priceTable },
      {
        traceId,
        now,
        bodyFacts: soul.body.renderBodyFacts(now),
        currentActivity: bodyState.activity,
        candidateActivities,
        motives,
        actionableDesires,
      },
    )
    soul.store.logTrace({ traceId, event: 'life_choice', level: 'info', data: { choice } })
    if (choice.kind === 'nothing' || choice.kind === 'stay') return

    // 若她决定离开手上正在做的事 → 先收尾旧活动（保留身心反馈）
    if (bodyState.activity) {
      soul.body.completeActivityIfDue(now, true)
    }

    lastActMs.set(config.id, now.getTime())

    if (choice.kind === 'activity') {
      const def = soul.persona.activities.find((a) => a.id === choice.activityId)
      if (!def) return
      const minutes = pickActivityDuration(def, bodyState, random)
      const thinking = await composeActivityThinking(
        { model, store: soul.store, persona: soul.persona, priceTable },
        { def, bodyFacts: soul.body.renderBodyFacts(now) },
      )
      soul.body.startActivity(def, thinking, minutes, now)
      soul.store.logTrace({ traceId, event: 'activity_started', level: 'info', data: { id: def.id, minutes } })
      return
    }

    if (choice.kind === 'pursue_desire') {
      const d = soul.store.getDesire(choice.desireId)
      if (!d) return
      await pursueDesire(bot, d, now, traceId)
      return
    }

    if (choice.kind === 'speak') {
      const uid = choice.userId
      const recalled = soul.memory.recallForTurn({
        listener: uid,
        tier: 'mid',
        isGroup: false,
        query: choice.motive.fact,
        now,
        limit: 4,
        isBackground: true,
        nameOf: (u) => soul.relations.nameOf(u),
      })
      const text = await composeOutreach(
        { model, store: soul.store, persona: soul.persona, priceTable },
        {
          traceId,
          purpose: choice.motive.fact,
          relationFacts: soul.relations.renderRelationFacts({
            userId: uid,
            now,
            sharedStories: soul.memory.sharedStories(uid, 3),
            lastContactIso: soul.store.lastUserContactAt(uid),
          }),
          memoryFacts: recalled.text,
          bodyFacts: soul.body.renderBodyFacts(now),
        },
      )
      if (!text) return
      await sendPrivate(bot, uid, text)
      soul.store.appendMessage({
        threadKey: `qq:private:${uid}`,
        role: 'assistant',
        userId: config.id,
        userName: soul.persona.name,
        content: text,
        toolSummary: null,
        mediaJson: null,
        createdAt: nowLocal(now),
      })
      if (choice.motive.kind === 'promise' && choice.motive.ref) {
        soul.store.updateScheduleStatus(choice.motive.ref, 'done')
      }
      if (choice.motive.kind === 'social_desire' && choice.motive.ref) {
        const d = soul.store.getDesire(choice.motive.ref)
        if (d) {
          d.stage = 'fulfilled'
          d.progressNote = '已经找对方聊起这件事了'
          d.updatedAt = nowLocal(now)
          soul.store.upsertDesire(d)
        }
      }
      if (choice.motive.kind === 'clear_air' && choice.motive.ref) {
        soul.relations.markClearAirAsked(uid, choice.motive.ref)
      }
      if (choice.motive.kind === 'make_amends' && choice.motive.ref) {
        soul.relations.resolveSelfTension(uid, choice.motive.ref)
      }
      soul.store.logTrace({ traceId, event: 'life_spoke', level: 'info', data: { userId: uid, kind: choice.motive.kind } })
    }
  }

  const tickOnce = async (): Promise<void> => {
    const now = clock.now()
    await Promise.all(opts.bots.map((bot) => opts.queue.enqueue(bot.config.id, () => runBotMaintenance(bot, now))))
  }

  const pollBotSongs = async (bot: RhythmBot, now: Date): Promise<void> => {
    if (!bot.singing) return
    const pending = bot.soul.store.listWorks('song', 10).filter((w) => w.status === 'generating' && w.externalTaskId)
    if (pending.length === 0) return
    const fetchImpl = bot.fetchImpl ?? globalThis.fetch
    const traceId = `song_${randomUUID().slice(0, 8)}`
    const model = bot.soul.auxModel ?? bot.soul.chatModel

    for (const work of pending) {
      try {
        const res = await bot.singing.pollSong(work.externalTaskId!)
        if (res.status === 'pending' || res.status === 'processing') continue

        if (res.status === 'failed' || !res.audioUrl) {
          bot.soul.store.upsertWork({
            ...work,
            status: 'failed',
            moodNote: [work.moodNote, `失败：${res.error ?? '未返回音频'}`].filter(Boolean).join(' | ').slice(0, 180),
          })
          bot.soul.body.appraise({
            source: 'life',
            affectKind: work.forUser ? 'guilty' : 'sadness',
            intensity: 0.35,
            confidence: 0.75,
            text: `答应的歌《${work.title}》没录成功`,
            now,
          })
          if (work.forUser) {
            bot.soul.relations.addSelfTension(work.forUser, `答应唱的《${work.title}》录制失败没交上`, 0.45, now)
          }
          bot.soul.store.logTrace({ traceId, event: 'song_failed', level: 'warn', data: { workId: work.id, error: res.error } })
          continue
        }

        const audioRes = await fetchImpl(res.audioUrl, { signal: AbortSignal.timeout(60_000) })
        if (!audioRes.ok) throw new Error(`download HTTP ${audioRes.status}`)
        const bytes = new Uint8Array(await audioRes.arrayBuffer())
        if (bytes.byteLength === 0 || bytes.byteLength > 25 * 1024 * 1024) {
          throw new Error(`invalid song size ${bytes.byteLength}`)
        }

        const songsDir = bot.songsDir ?? join(bot.config.dataDir, 'media', 'songs')
        mkdirSync(songsDir, { recursive: true })
        const filePath = join(songsDir, `${work.id}.mp3`)
        writeFileSync(filePath, bytes)

        bot.soul.store.upsertWork({
          ...work,
          status: 'ready',
          mediaPath: filePath,
        })
        bot.soul.body.appraise({
          source: 'life',
          affectKind: 'praised',
          intensity: 0.45,
          confidence: 0.85,
          text: `唱完了《${work.title}》`,
          now,
        })
        bot.soul.memory.remember({
          kind: 'experience',
          text: `我自己填词唱了一首歌《${work.title}》${work.forUser ? `送给${bot.soul.relations.nameOf(work.forUser)}` : ''}`,
          about: work.forUser ? [work.forUser] : [],
          sensitivity: 'open',
          tier: 'lasting',
          disclosable: 'volunteer',
          consented: false,
          source: 'life',
          provenance: 'L0_external',
          threadKey: 'life',
          affect: 'praised',
          createdAt: nowLocal(now),
        })

        if (work.forUser && bot.transport) {
          const isGroupNote = work.moodNote?.startsWith('qq:group:')
          const target: SendTarget = isGroupNote
            ? { messageType: 'group', groupId: work.moodNote!.slice('qq:group:'.length) }
            : { messageType: 'private', userId: work.forUser }
          const threadKey = isGroupNote ? work.moodNote! : `qq:private:${work.forUser}`
          const b64 = Buffer.from(bytes).toString('base64')
          await bot.transport.send(target, { type: 'record', url: `base64://${b64}` })

          const note = (await composeOutreach(
            { model, store: bot.soul.store, persona: bot.soul.persona, priceTable: opts.priceTable },
            {
              traceId,
              purpose: `你刚才为他录的歌《${work.title}》刚刚录好并发给他了，简短说一句自然的话。`,
              relationFacts: bot.soul.relations.renderRelationFacts({
                userId: work.forUser,
                now,
                sharedStories: bot.soul.memory.sharedStories(work.forUser, 2),
              }),
              memoryFacts: '',
              bodyFacts: bot.soul.body.renderBodyFacts(now),
            },
          )) || `《${work.title}》唱好啦，你听听看。`

          await bot.transport.send(target, { type: 'text', text: note })
          bot.soul.store.appendMessage({
            threadKey,
            role: 'assistant',
            userId: bot.config.id,
            userName: bot.soul.persona.name,
            content: `[唱了一首歌《${work.title}》]\n${note}`,
            toolSummary: `完成唱歌《${work.title}》`,
            mediaJson: JSON.stringify({ workId: work.id, mediaPath: filePath }),
            createdAt: nowLocal(now),
          })
        }
        bot.soul.store.logTrace({ traceId, event: 'song_ready', level: 'info', data: { workId: work.id, title: work.title, bytes: bytes.byteLength } })
      } catch (e) {
        bot.soul.store.logTrace({ traceId, event: 'song_poll_error', level: 'warn', data: { workId: work.id, error: (e as Error).message.slice(0, 160) } })
      }
    }
  }

  const songTick = async (): Promise<void> => {
    const now = clock.now()
    await Promise.all(opts.bots.map((bot) => opts.queue.enqueue(bot.config.id, () => pollBotSongs(bot, now))))
  }

  const reminderTick = async (): Promise<void> => {
    const now = clock.now()
    await Promise.all(opts.bots.map((bot) => opts.queue.enqueue(bot.config.id, async () => {
      await pollBotSongs(bot, now)
      const due = bot.soul.store.dueSchedules(now.toISOString(), 'reminder')
      if (due.length === 0) return
      const model = bot.soul.auxModel ?? bot.soul.chatModel
      const traceId = `rem_${randomUUID().slice(0, 8)}`
      for (const item of due) {
        try {
          const text = await composeOutreach(
            { model, store: bot.soul.store, persona: bot.soul.persona, priceTable: opts.priceTable },
            {
              traceId,
              purpose: `他之前托你到点喊他：「${item.text}」。现在时间到了，用你自己的方式自然喊他一声。`,
              relationFacts: bot.soul.relations.renderRelationFacts({
                userId: item.userId,
                now,
                sharedStories: bot.soul.memory.sharedStories(item.userId, 2),
              }),
              memoryFacts: '',
              bodyFacts: bot.soul.body.renderBodyFacts(now),
            },
          )
          if (text) {
            await bot.transport?.send(targetOf(item.threadKey, item.userId), { type: 'text', text })
            bot.soul.store.appendMessage({
              threadKey: item.threadKey,
              role: 'assistant',
              userId: bot.config.id,
              userName: bot.soul.persona.name,
              content: text,
              toolSummary: null,
              mediaJson: null,
              createdAt: nowLocal(now),
            })
            bot.soul.store.updateScheduleStatus(item.id, 'done')
            bot.soul.store.logTrace({ traceId, event: 'reminder_sent', level: 'info', data: { id: item.id, userId: item.userId } })
          }
        } catch (e) {
          bot.soul.store.logTrace({ traceId, event: 'reminder_error', level: 'warn', data: { id: item.id, error: (e as Error).message.slice(0, 140) } })
        }
      }
    })))
  }

  return {
    start() {
      startedAt = clock.now().getTime()
      timer = setInterval(() => { void tickOnce() }, tickMs)
      timer.unref?.()
      reminderTimer = setInterval(() => { void reminderTick() }, reminderTickMs)
      reminderTimer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
      if (reminderTimer) clearInterval(reminderTimer)
      reminderTimer = null
    },
    tickOnce,
    reminderTick,
    songTick,
  }
}
