import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { FileEdit, Save, KeyRound, ShieldCheck, Wrench, CheckCircle2, XCircle, Trash2 } from 'lucide-react'
import { api } from '../lib/api.ts'
import type { ApprovalRecord, CapabilityItem, PublicCredential } from '../lib/api.ts'

export type SoulTab = 'persona' | 'credentials' | 'skills'

export function SoulView({
  botId,
  initialTab,
  onTabChange,
}: {
  botId: string
  initialTab?: string
  onTabChange?: (tab: SoulTab) => void
}) {
  const validTab: SoulTab = initialTab === 'credentials' || initialTab === 'skills' ? initialTab : 'persona'
  const [tab, setTab] = useState<SoulTab>(validTab)
  const [personaFiles, setPersonaFiles] = useState<Record<string, string>>({})
  const [activeFile, setActiveFile] = useState('identity.md')
  const [draft, setDraft] = useState('')
  const [promptChars, setPromptChars] = useState(0)
  const [saving, setSaving] = useState(false)

  const [capabilities, setCapabilities] = useState<CapabilityItem[]>([])
  const [credentials, setCredentials] = useState<PublicCredential[]>([])
  const [credDrafts, setCredDrafts] = useState<Record<string, Record<string, string>>>({})
  const [pendingApproval, setPendingApproval] = useState<ApprovalRecord | null>(null)

  useEffect(() => {
    setTab(validTab)
  }, [validTab])

  const switchTab = (next: SoulTab) => {
    setTab(next)
    onTabChange?.(next)
  }

  const loadAll = async () => {
    try {
      const [p, cap, cred, app] = await Promise.all([
        api.persona(botId),
        api.capabilities(botId),
        api.credentials(botId),
        api.approvals(botId),
      ])
      setPersonaFiles(p.files)
      setPromptChars(p.staticPromptChars)
      const firstFile = p.files[activeFile] !== undefined ? activeFile : Object.keys(p.files)[0] ?? 'identity.md'
      setActiveFile(firstFile)
      setDraft(p.files[firstFile] ?? '')
      setCapabilities(cap.capabilities)
      setCredentials(cred.credentials)
      setPendingApproval(app.pending)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [botId])

  const selectFile = (name: string) => {
    setActiveFile(name)
    setDraft(personaFiles[name] ?? '')
  }

  const saveFile = async () => {
    setSaving(true)
    try {
      const res = await api.savePersonaFile(botId, activeFile, draft)
      setPersonaFiles((prev) => ({ ...prev, [activeFile]: draft }))
      setPromptChars(res.staticPromptChars)
      toast.success(`已保存 ${activeFile} 并即时热重载`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const submitCredential = async (cred: PublicCredential) => {
    const vals = credDrafts[cred.name] ?? {}
    try {
      const res = await api.fillCredential(botId, cred.name, vals)
      toast.success(
        res.resumedDesireIds.length > 0
          ? `凭证已保存，并唤醒了 ${res.resumedDesireIds.length} 条等待中的心事`
          : '凭证已安全保存（0600 密文隔离）',
      )
      setCredDrafts((prev) => ({ ...prev, [cred.name]: {} }))
      const c = await api.credentials(botId)
      setCredentials(c.credentials)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const removeCredential = async (name: string) => {
    try {
      await api.deleteCredential(botId, name)
      setCredentials((prev) => prev.filter((c) => c.name !== name))
      toast.success('已移除凭证')
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const handleApproval = async (op: 'approve' | 'reject') => {
    if (!pendingApproval) return
    try {
      await api.approvalOp(botId, pendingApproval.id, op)
      toast.success(op === 'approve' ? '已点头同意，她可以继续推进了' : '已告知暂不批准')
      setPendingApproval(null)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const toggleCap = async (cap: CapabilityItem) => {
    const next = cap.status === 'active' ? 'disabled' : 'active'
    try {
      await api.toggleCapability(botId, cap.name, next)
      setCapabilities((prev) => prev.map((x) => (x.name === cap.name ? { ...x, status: next } : x)))
      toast.success(`技能 ${cap.name} 已${next === 'active' ? '启用' : '停用'}`)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="space-y-6">
      {/* 1) 待审批提醒 */}
      {pendingApproval && (
        <section className="acg-card p-5 space-y-3" style={{ borderColor: 'var(--warn)' }}>
          <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--warn)' }}>
            <ShieldCheck className="w-4 h-4" />
            待你点头的自主请求
          </div>
          <p className="font-voice text-[15px]">{pendingApproval.what}</p>
          <div className="flex items-center gap-2.5">
            <button type="button" onClick={() => { void handleApproval('approve') }} className="acg-btn acg-btn-primary text-xs">
              <CheckCircle2 className="w-4 h-4" />
              同意她动手
            </button>
            <button
              type="button"
              onClick={() => { void handleApproval('reject') }}
              className="acg-btn acg-btn-soft text-xs"
              style={{ color: 'var(--danger)' }}
            >
              <XCircle className="w-4 h-4" />
              这次先不了
            </button>
          </div>
        </section>
      )}

      {/* 子页签：人设 / 外部凭证 / 本领清单 */}
      <div className="flex flex-wrap gap-2">
        {[
          { id: 'persona' as const, label: '人设工作台', icon: FileEdit, count: Object.keys(personaFiles).length },
          { id: 'credentials' as const, label: '外部凭证', icon: KeyRound, count: credentials.length },
          { id: 'skills' as const, label: '本领清单', icon: Wrench, count: capabilities.length },
        ].map((t) => {
          const Icon = t.icon
          const active = tab === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => switchTab(t.id)}
              className={`acg-btn ${active ? 'acg-btn-primary' : 'acg-btn-soft'}`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
              <span className="text-xs opacity-80 font-mono-num">({t.count})</span>
            </button>
          )
        })}
      </div>

      {/* 2) 外部凭证动态表单 */}
      {tab === 'credentials' && (
      <section className="acg-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-[15px] font-semibold flex items-center gap-2">
            <KeyRound className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            外部服务凭证（密钥绝不经过聊天）
          </h3>
          <span className="text-xs font-mono-num" style={{ color: 'var(--text-2)' }}>
            {credentials.filter((c) => c.filled).length} / {credentials.length} 已填好
          </span>
        </div>

        {credentials.length === 0 ? (
          <p className="text-sm font-voice py-6 text-center" style={{ color: 'var(--text-2)' }}>
            她目前没有向你申请任何外部服务密钥。
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {credentials.map((cred) => (
              <div
                key={cred.name}
                className="p-4 rounded-xl border space-y-3"
                style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border)' }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold">{cred.label}</div>
                    <div className="text-[11px] font-mono-num" style={{ color: 'var(--text-2)' }}>
                      {cred.name} · {cred.providerName || cred.provider}
                    </div>
                  </div>
                  <span className="acg-pill text-[11px]" style={{ color: cred.filled ? 'var(--ok)' : 'var(--warn)' }}>
                    {cred.filled ? '已就绪' : '待填写'}
                  </span>
                </div>
                {cred.why && <p className="text-xs font-voice">{cred.why}</p>}
                <div className="space-y-2">
                  {cred.fields.map((f) => (
                    <div key={f.key} className="space-y-1">
                      <label className="text-[11px] font-medium block" style={{ color: 'var(--text-2)' }}>
                        {f.label} {f.required ? '*' : ''}
                        {cred.maskedValues[f.key] && (
                          <span className="ml-2 font-mono-num">当前：{cred.maskedValues[f.key]}</span>
                        )}
                      </label>
                      <input
                        type={f.type === 'secret' ? 'password' : 'text'}
                        placeholder={f.placeholder || `输入 ${f.key}`}
                        value={credDrafts[cred.name]?.[f.key] ?? ''}
                        onChange={(e) =>
                          setCredDrafts((prev) => ({
                            ...prev,
                            [cred.name]: { ...(prev[cred.name] ?? {}), [f.key]: e.target.value },
                          }))
                        }
                        className="acg-input w-full text-xs"
                      />
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between pt-1">
                  <button type="button" onClick={() => { void submitCredential(cred) }} className="acg-btn acg-btn-primary text-xs py-1.5">
                    保存并唤醒
                  </button>
                  <button
                    type="button"
                    aria-label="移除凭证"
                    onClick={() => { void removeCredential(cred.name) }}
                    className="acg-btn acg-btn-soft p-1.5"
                    style={{ color: 'var(--danger)' }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      )}

      {/* 3) 人设包在线工作台 */}
      {tab === 'persona' && (
      <section className="acg-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold flex items-center gap-2">
            <FileEdit className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            人设包工作台（保存即热重载）
          </h3>
          <span className="text-xs font-mono-num" style={{ color: 'var(--text-2)' }}>
            静态前缀体积：{promptChars} 字
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {Object.keys(personaFiles).map((fname) => (
            <button
              key={fname}
              type="button"
              onClick={() => selectFile(fname)}
              className={`acg-btn text-xs py-1.5 px-3 ${activeFile === fname ? 'acg-btn-primary' : 'acg-btn-soft'}`}
            >
              {fname}
            </button>
          ))}
        </div>

        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={12}
          className="acg-input w-full font-mono-num text-[13px] leading-relaxed"
        />

        <div className="flex justify-end">
          <button type="button" disabled={saving} onClick={() => { void saveFile() }} className="acg-btn acg-btn-primary">
            <Save className="w-4 h-4" />
            {saving ? '保存中...' : `保存 ${activeFile}`}
          </button>
        </div>
      </section>
      )}

      {/* 4) 已学会的本领 / Skill */}
      {tab === 'skills' && (
      <section className="acg-card p-5 space-y-4">
        <h3 className="text-[15px] font-semibold flex items-center gap-2">
          <Wrench className="w-4 h-4" style={{ color: 'var(--accent)' }} />
          她的本领清单（{capabilities.length}）
        </h3>
        {capabilities.length === 0 ? (
          <p className="text-sm font-voice py-6 text-center" style={{ color: 'var(--text-2)' }}>
            她还没有亲手造出新技能。
          </p>
        ) : (
          <div className="space-y-3">
            {capabilities.map((cap) => (
              <details
                key={cap.name}
                className="p-3.5 rounded-xl border"
                style={{ backgroundColor: 'var(--surface-2)', borderColor: 'var(--border)' }}
              >
                <summary className="flex items-center justify-between gap-2 cursor-pointer list-none">
                  <div>
                    <span className="font-semibold text-sm">{cap.name}</span>
                    <span className="ml-2 text-xs" style={{ color: 'var(--text-2)' }}>{cap.summary}</span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault()
                      void toggleCap(cap)
                    }}
                    className="acg-pill text-[11px] cursor-pointer"
                    style={{ color: cap.status === 'active' ? 'var(--ok)' : 'var(--text-2)' }}
                  >
                    {cap.status === 'active' ? '已启用（点此停用）' : '已停用（点此启用）'}
                  </button>
                </summary>
                {cap.doc && (
                  <pre className="mt-3 pt-3 border-t text-xs font-mono-num whitespace-pre-wrap overflow-x-auto" style={{ borderColor: 'var(--border)', color: 'var(--text-2)' }}>
                    {cap.doc}
                  </pre>
                )}
              </details>
            ))}
          </div>
        )}
      </section>
      )}
    </div>
  )
}
