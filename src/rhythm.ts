// 自主节律编排器（非 soul 内部定时，由组合根装配）：
// - 粗 tick（默认 5 分钟，纯代码零 token；命中条件才调模型）：身心演化 → 活动收尾与回过神回复 → 凭证唤醒 → 欲望演化与成型 → 确定性授权/凭证提醒 → 日记/反思/自发联想 → 统一生活决策与推进念头
// - 细 tick（默认 1 分钟）：精确提醒履约
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
  onError?: (botId: string, phase: string, err: unknown) => void
}

const MAX_SONG_BYTES = 25 * 1024 * 1024

// P1-SEC-04：流式下载字节预算，避免大响应先 arrayBuffer() 撑爆内存
async function downloadBytesBounded(res: Response, maxBytes: number): Promise<Uint8Array> {
  const cl = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(cl) && cl > maxBytes) {
    throw new Error(`song content-length ${cl} exceeds ${maxBytes}`)
  }
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
      throw new Error(`invalid song size ${bytes.byteLength}`)
    }
    return bytes
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`song stream exceeded ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  if (total === 0) throw new Error('empty song response')
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return merged
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
  const inFlightDesires = new Set<string>()
  const desireCooldownUntil = new Map<string, number>()
  const desireExhaustedCount = new Map<string, number>()

  const reportError = (bot: RhythmBot | null, phase: string, err: unknown): void => {
    const msg = err instanceof Error ? err.message : String(err)
    if (bot) {
      try {
        bot.soul.store.logTrace({
          traceId: `${phase}_${randomUUID().slice(0, 6)}`,
          event: `${phase}_error`,
          level: 'error',
          data: { error: msg.slice(0, 200) },
        })
      } catch {
        // 避免日志异常二次抛错
      }
    }
    opts.onError?.(bot?.config.id ?? 'rhythm', phase, err)
  }

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

    // 若是造技能：先过代码硬安全门（注意：缺凭证允许进入；已获单次人工批准则放行；拒绝冷却期直接跳过）
    let needsCredentialHint = false
    if (desire.exitKind === 'build_skill') {
      const scope = checkBuildScope(desire, { autonomyEnabled: config.proactivity.autonomyBuildEnabled, now })
      if (!scope.allowed) {
        if (scope.hardBlocked) {
          desire.stage = 'abandoned'
          desire.progressNote = `触碰硬边界（${scope.reason}），放弃自己动手`
          desire.lastProgressAt = nowLocal(now)
          desire.updatedAt = nowLocal(now)
          soul.store.upsertDesire(desire)
          soul.store.logTrace({ traceId, event: 'desire_hard_blocked', level: 'info', data: { desireId: desire.id, reason: scope.reason } })
        } else if (scope.needsApproval) {
          desire.stage = 'waiting_approval'
          desire.blocker = { kind: 'approval', what: `我想自己动手做「${desire.want}」，需要你点个头允许` }
          desire.lastProgressAt = nowLocal(now)
          desire.updatedAt = nowLocal(now)
          soul.store.upsertDesire(desire)
          soul.store.logTrace({ traceId, event: 'desire_needs_approval', level: 'info', data: { desireId: desire.id, reason: scope.reason } })
        }
        return
      }
      needsCredentialHint = scope.requiresCredential
    }

    const prevLastProgressAt = desire.lastProgressAt
    desire.stage = 'in_progress'
    desire.updatedAt = nowLocal(now)
    soul.store.upsertDesire(desire)
    inFlightDesires.add(desire.id)
    bot.takeRequestedCredential() // 清空旧标记

    const specNote = desire.spec
      ? `\n工程参考：${JSON.stringify(desire.spec)}`
      : ''
    const prevNote = desire.progressNote
      ? `\n上次推进进度：${desire.progressNote}\n请直接基于已有进度续做或收尾，不要从头重复读取已经看过的文件。`
      : ''
    const credNote = needsCredentialHint
      ? '\n这件事需要外部服务密钥：先调研该服务所需字段，调用 request_credential 登记，登记完就暂停等他填好，不要硬猜密钥。'
      : ''
    const prompt = `（这是你自己心里冒出来想做的事，没人要求你）
你想做：${desire.want}
起因：${desire.why}${specNote}${prevNote}${credNote}
请直接用你的工具推进这件事：查资料、写脚本并调 register_skill 自检，或者把诗/笔记/设计方案用 save_work 存进作品集、把感想写进日记。做完用你自己的话简短总结结果；如果卡在缺凭证或没做成，如实说清楚。`

    try {
      const out = await soul.handleTurn({
        mode: 'solo',
        threadKey: `solo:desire:${desire.id}`,
        userId: admin || bot.config.id,
        userName: admin ? soul.relations.nameOf(admin) : soul.persona.name,
        text: prompt,
        toolLayers: ['explore', 'express', 'create'],
        reasoningEffort: desire.exitKind === 'build_skill' ? 'high' : 'low',
        maxSteps: desire.exitKind === 'build_skill' ? 14 : desire.exitKind === 'create_work' ? 10 : 6,
      })

      // P1-STATE-04：跨 await 回写前重新读取最新状态，若期间已被管理员放弃/变更则绝不覆盖为 fulfilled
      const latest = soul.store.getDesire(desire.id)
      if (!latest || latest.stage === 'abandoned' || latest.stage === 'faded') {
        soul.store.logTrace({ traceId, event: 'desire_cancelled_in_flight', level: 'info', data: { desireId: desire.id, stage: latest?.stage ?? 'missing' } })
        return
      }

      const requestedCred = bot.takeRequestedCredential()
      if (requestedCred && !bot.credentials.isReady(requestedCred)) {
        latest.stage = 'waiting_credential'
        latest.blocker = { kind: 'credential', what: `等后台填写凭证「${requestedCred}」`, payload: { credName: requestedCred } }
        latest.progressNote = `已登记需要「${requestedCred}」凭证，等填好再继续`
        latest.lastProgressAt = nowLocal(now)
        latest.updatedAt = nowLocal(now)
        soul.store.upsertDesire(latest)
        soul.store.logTrace({ traceId, event: 'desire_waiting_credential', level: 'info', data: { desireId: latest.id, credName: requestedCred } })
        return
      }

      // P1-LOOP-01：步数耗尽/失败/取消绝不误判 fulfilled；不刷新 lastProgressAt，加入 4h 冷却，连续 3 次未收口则自然淡去防烧预算
      if (out.stopReason !== 'completed') {
        const exhausted = (desireExhaustedCount.get(latest.id) ?? 0) + 1
        desireCooldownUntil.set(latest.id, now.getTime() + 4 * 3_600_000)
        if (exhausted >= 3) {
          latest.stage = 'faded'
          latest.progressNote = `连续 ${exhausted} 轮未完全收口，先放一放：${(out.reply || out.toolSummaries.join('；') || '稍后再说').slice(0, 120)}`
          desireExhaustedCount.delete(latest.id)
        } else {
          latest.stage = 'active'
          latest.progressNote = `本轮未完全收口（${out.stopReason}，第 ${exhausted} 次）：${(out.reply || out.toolSummaries.join('；') || '稍后继续').slice(0, 140)}`
          desireExhaustedCount.set(latest.id, exhausted)
        }
        latest.lastProgressAt = prevLastProgressAt
        latest.updatedAt = nowLocal(now)
        soul.store.upsertDesire(latest)
        soul.store.logTrace({ traceId, event: 'desire_incomplete', level: 'warn', data: { desireId: latest.id, stopReason: out.stopReason, steps: out.steps, exhausted } })
        return
      }

      desireExhaustedCount.delete(latest.id)
      desireCooldownUntil.delete(latest.id)
      latest.stage = 'fulfilled'
      latest.approvedPlanVersion = undefined
      latest.progressNote = (out.reply || out.toolSummaries.join('；') || '完成了').slice(0, 180)
      latest.lastProgressAt = nowLocal(now)
      latest.updatedAt = nowLocal(now)
      soul.store.upsertDesire(latest)

      // 真实情绪与记忆闭环：做完心里惦记的事会雀跃，也会进记忆
      soul.body.appraise({
        source: 'desire',
        affectKind: 'praised',
        intensity: 0.45,
        confidence: 0.85,
        text: `把心里想做的事推进完了：${latest.want}`,
        now,
      })
      soul.memory.remember({
        kind: 'experience',
        text: `我自己推进了「${latest.want}」：${latest.progressNote}`,
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
      if (latest.exitKind === 'build_skill' && admin && out.reply) {
        try {
          await sendPrivate(bot, admin, out.reply)
        } catch (sendErr) {
          reportError(bot, 'desire_notify', sendErr)
        }
      }
      soul.store.logTrace({ traceId, event: 'desire_pursued_done', level: 'info', data: { desireId: latest.id, exitKind: latest.exitKind, steps: out.steps } })
    } catch (e) {
      // 真实受挫：同样检查期间是否已被管理员放弃
      const latest = soul.store.getDesire(desire.id)
      if (latest && latest.stage !== 'abandoned' && latest.stage !== 'faded') {
        latest.stage = 'active'
        latest.progressNote = `刚才试了一下没顺：${(e as Error).message.slice(0, 120)}`
        latest.lastProgressAt = nowLocal(now)
        latest.updatedAt = nowLocal(now)
        soul.store.upsertDesire(latest)
      }
      soul.body.appraise({
        source: 'desire',
        affectKind: 'sadness',
        intensity: 0.25,
        confidence: 0.7,
        text: `想做「${desire.want}」但这次没弄成`,
        now,
      })
      soul.store.logTrace({ traceId, event: 'desire_pursue_error', level: 'warn', data: { desireId: desire.id, error: (e as Error).message.slice(0, 180) } })
    } finally {
      inFlightDesires.delete(desire.id)
    }
  }

  const runBotMaintenance = async (bot: RhythmBot, now: Date): Promise<void> => {
    const { soul, config, diary, credentials } = bot
    const traceId = `tick_${randomUUID().slice(0, 8)}`
    const model = soul.auxModel ?? soul.chatModel
    const priceTable = opts.priceTable

    // 1) 身心墙钟演化（0 token）
    soul.body.tick(now)

    // 2) 活动到点收尾：真实应用精力/PAD/驱力反馈 + 记见闻
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
    }

    // 2.5) P1-STATE-02：只要当前空闲（包括刚忙完或进程重启后无活动），逐条消费 pending_replies，仅在投递成功后 ACK 删除
    if (!soul.body.state(now).activity) {
      const pendingList = soul.store.listPendingReplies()
      for (const p of pendingList) {
        try {
          const target = targetOf(p.threadKey, p.userId)
          const notice = finished
            ? `你刚才忙完「${finished.label}」，回过神看到了他之前发来的话。`
            : '你现在空下来了，回过神看到了他之前发来的话。'
          const out = await soul.handleTurn({
            mode: 'chat',
            threadKey: p.threadKey,
            userId: p.userId,
            userName: p.userName,
            text: p.text,
            isGroup: p.threadKey.startsWith('qq:group:'),
            notice,
            onReply: async (reply) => { await bot.transport?.send(target, { type: 'text', text: reply }) },
          })
          if (out.delivered && out.reply) {
            soul.store.removePendingReply(p.id)
            soul.store.logTrace({ traceId, event: 'pending_reply_answered', level: 'info', data: { userId: p.userId, pendingId: p.id } })
          } else {
            soul.store.logTrace({ traceId, event: 'pending_reply_deferred', level: 'warn', data: { userId: p.userId, pendingId: p.id, delivered: out.delivered } })
          }
        } catch (e) {
          soul.store.logTrace({ traceId, event: 'pending_reply_error', level: 'warn', data: { userId: p.userId, pendingId: p.id, error: (e as Error).message.slice(0, 140) } })
        }
      }
    }

    // 3) P1-STATE-01：恢复上次崩溃遗留的 in_progress 任务 + 凭证填好自动唤醒 waiting_credential（0 token）
    const recovered = soul.desires.recoverInterrupted(now, inFlightDesires)
    if (recovered.length > 0) {
      soul.store.logTrace({ traceId, event: 'desires_recovered', level: 'info', data: { ids: recovered.map((d) => d.id) } })
    }
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
          now,
        },
      )
      if (text) {
        const full = `${text}${credentialFooter(bot, dueCred.label)}`
        // P0-RUN-01：先发送成功再 markAsked，发送失败时记录日志并保留未询问状态以便下次重试
        try {
          await sendPrivate(bot, admin, full)
        } catch (sendErr) {
          reportError(bot, 'credential_ask_send', sendErr)
          return
        }
        credentials.markAsked(dueCred.name, now)
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
            now,
          },
        )
        if (text) {
          try {
            await sendPrivate(bot, admin, text)
          } catch (sendErr) {
            reportError(bot, 'approval_ask_send', sendErr)
            return
          }
          soul.approvals.open({
            kind: blocked.blocker.kind,
            targetId: blocked.id,
            what: blocked.blocker.what,
            payload: blocked.blocker.payload ?? null,
            now,
          })
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

    // 9) 概率日记（P1-CACHE-01：发送冻结的完整 toolLayers 保前缀缓存，用 allowedLayers 在执行期屏蔽 express）& 每日晚间反思
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
        toolLayers: ['explore', 'express', 'create'],
        allowedLayers: ['explore', 'create'],
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
    const actionableDesires = activeDesires.filter(
      (d) => d.exitKind !== 'social' && (desireCooldownUntil.get(d.id) ?? 0) <= now.getTime(),
    )

    const people = allowlist.map((uid) => {
      const lastIso = soul.store.lastUserContactAt(uid)
      const recentMsgs = soul.store.recentMessages(`qq:private:${uid}`, 4)
      const latestMsg = recentMsgs[recentMsgs.length - 1]
      let unansweredCount = 0
      for (let i = recentMsgs.length - 1; i >= 0; i--) {
        if (recentMsgs[i]!.role === 'assistant') unansweredCount += 1
        else break
      }
      const lastMsgMs = latestMsg?.createdAt ? Date.parse(latestMsg.createdAt.replace(' ', 'T')) : undefined
      const lastAtMs = lastIso ? Date.parse(lastIso.replace(' ', 'T')) : undefined
      const rel = soul.relations.get(uid)
      return {
        userId: uid,
        name: soul.relations.nameOf(uid),
        lastAtMs: lastAtMs && Number.isFinite(lastAtMs) ? lastAtMs : undefined,
        lastText: latestMsg?.content,
        lastRole: latestMsg?.role,
        unansweredCount,
        lastMsgAtMs: lastMsgMs && Number.isFinite(lastMsgMs) ? lastMsgMs : undefined,
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
          now,
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
    // P0-RUN-01：每个 Bot 独立收口异常，单 Bot 临时网络故障绝不拖垮整个进程或其它 Bot
    await Promise.all(opts.bots.map((bot) =>
      opts.queue.enqueue(bot.config.id, async () => {
        try {
          await runBotMaintenance(bot, now)
        } catch (err) {
          reportError(bot, 'maintenance_tick', err)
        }
      }),
    ))
  }

  const pollBotSongs = async (bot: RhythmBot, now: Date): Promise<void> => {
    if (!bot.singing) return
    // P1-STATE-03：SQL 层先按状态筛选再 LIMIT，绝不被新生成的 ready 作品挤掉旧的 generating / ready_undelivered 任务
    const pending = bot.soul.store
      .listWorksByStatus(['generating', 'ready_undelivered'], 20)
      .filter((w) => w.kind === 'song')
    if (pending.length === 0) return
    const fetchImpl = bot.fetchImpl ?? globalThis.fetch
    const traceId = `song_${randomUUID().slice(0, 8)}`
    const model = bot.soul.auxModel ?? bot.soul.chatModel

    for (const work of pending) {
      try {
        let filePath = work.mediaPath
        let bytes: Uint8Array | null = null

        if (work.status === 'generating') {
          if (!work.externalTaskId) continue
          const res = await bot.singing.pollSong(work.externalTaskId)
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
          bytes = await downloadBytesBounded(audioRes, MAX_SONG_BYTES)

          const songsDir = bot.songsDir ?? join(bot.config.dataDir, 'media', 'songs')
          mkdirSync(songsDir, { recursive: true })
          filePath = join(songsDir, `${work.id}.mp3`)
          writeFileSync(filePath, bytes)

          // 生成与投递分离：有接收对象时先落盘为 ready_undelivered，投递成功后才转为 ready
          bot.soul.store.upsertWork({
            ...work,
            status: work.forUser && bot.transport ? 'ready_undelivered' : 'ready',
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
        }

        if (work.forUser && bot.transport && filePath) {
          if (!bytes) {
            if (!existsSync(filePath)) throw new Error('saved song file missing for retry')
            const st = statSync(filePath)
            if (st.size === 0 || st.size > MAX_SONG_BYTES) throw new Error(`invalid saved song size ${st.size}`)
            bytes = new Uint8Array(readFileSync(filePath))
          }
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
              now,
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
          bot.soul.store.upsertWork({
            ...work,
            status: 'ready',
            mediaPath: filePath,
          })
        }
        bot.soul.store.logTrace({ traceId, event: 'song_ready', level: 'info', data: { workId: work.id, title: work.title, bytes: bytes?.byteLength ?? 0 } })
      } catch (e) {
        bot.soul.store.logTrace({ traceId, event: 'song_poll_error', level: 'warn', data: { workId: work.id, error: (e as Error).message.slice(0, 160) } })
      }
    }
  }

  const songTick = async (): Promise<void> => {
    const now = clock.now()
    await Promise.all(opts.bots.map((bot) =>
      opts.queue.enqueue(bot.config.id, async () => {
        try {
          await pollBotSongs(bot, now)
        } catch (err) {
          reportError(bot, 'song_tick', err)
        }
      }),
    ))
  }

  const reminderTick = async (): Promise<void> => {
    const now = clock.now()
    await Promise.all(opts.bots.map((bot) => opts.queue.enqueue(bot.config.id, async () => {
      try {
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
                now,
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
      } catch (err) {
        reportError(bot, 'reminder_tick', err)
      }
    })))
  }

  return {
    start() {
      startedAt = clock.now().getTime()
      timer = setInterval(() => {
        void tickOnce().catch((err) => reportError(null, 'timer_tick', err))
      }, tickMs)
      timer.unref?.()
      reminderTimer = setInterval(() => {
        void reminderTick().catch((err) => reportError(null, 'timer_reminder', err))
      }, reminderTickMs)
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
