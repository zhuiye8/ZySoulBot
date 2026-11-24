// 灵魂门面（薄组合层，绝不做上帝类）：将 persona / body / memory / relation / conversation 干净装配起来。
import type {
  ChatModel,
  PAD,
  SoulStore,
  ToolRegistry,
  Traits,
} from '../shared/ports.ts'
import { systemClock } from '../shared/time.ts'
import type { Clock } from '../shared/time.ts'
import type { PersonaPack } from './persona/pack.ts'
import { BodyEngine } from './body/engine.ts'
import { MemoryEngine } from './memory/engine.ts'
import { RelationEngine } from './relation/engine.ts'
import { DesireEngine } from './desire/engine.ts'
import { ApprovalManager } from './governance/approval.ts'
import type { PriceTable } from './agent/loop.ts'
import { runConversationTurn } from './conversation/turn.ts'
import type { TurnInput, TurnOutput } from './conversation/turn.ts'

export interface SoulOptions {
  botId: string
  persona: PersonaPack
  store: SoulStore
  chatModel: ChatModel
  auxModel?: ChatModel | null
  tools: ToolRegistry
  traits?: Traits
  baselinePad?: PAD
  relationDefaultType?: string
  identityCall?: string
  clock?: Clock
  priceTable?: PriceTable
}

export class Soul {
  readonly botId: string
  persona: PersonaPack
  readonly store: SoulStore
  readonly body: BodyEngine
  readonly memory: MemoryEngine
  readonly relations: RelationEngine
  readonly desires: DesireEngine
  readonly approvals: ApprovalManager
  readonly tools: ToolRegistry
  chatModel: ChatModel
  auxModel: ChatModel | null
  private clock: Clock
  private priceTable?: PriceTable

  constructor(opts: SoulOptions) {
    this.botId = opts.botId
    this.persona = opts.persona
    this.store = opts.store
    this.chatModel = opts.chatModel
    this.auxModel = opts.auxModel ?? null
    this.tools = opts.tools
    this.clock = opts.clock ?? systemClock
    this.priceTable = opts.priceTable
    this.body = new BodyEngine(opts.store, opts.traits, opts.baselinePad)
    this.memory = new MemoryEngine(opts.store)
    this.relations = new RelationEngine(opts.store, {
      defaultType: opts.relationDefaultType,
      identityCall: opts.identityCall,
    })
    this.desires = new DesireEngine(opts.store)
    this.approvals = new ApprovalManager(opts.store)
    this.body.tick(this.clock.now())
  }

  handleTurn(input: Omit<TurnInput, 'botId'>): Promise<TurnOutput> {
    return runConversationTurn(
      {
        persona: this.persona,
        store: this.store,
        body: this.body,
        memory: this.memory,
        relations: this.relations,
        chatModel: this.chatModel,
        auxModel: this.auxModel,
        tools: this.tools,
        clock: this.clock,
        priceTable: this.priceTable,
      },
      { ...input, botId: this.botId },
    )
  }
}
