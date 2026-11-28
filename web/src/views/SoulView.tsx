import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  FileEdit,
  Save,
  KeyRound,
  ShieldCheck,
  Wrench,
  CheckCircle2,
  XCircle,
  Trash2,
  Eye,
  EyeOff,
} from 'lucide-react'
import { api } from '../lib/api.ts'
import type { ApprovalRecord, CapabilityItem, PublicCredential } from '../lib/api.ts'
import {
  AlertDialog,
  Badge,
  Button,
  Disclosure,
  EmptyState,
  ErrorState,
  Switch,
  UnderlineTabs,
  useDelayedLoading,
} from '../components/ui.tsx'

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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [personaFiles, setPersonaFiles] = useState<Record<string, string>>({})
  const [activeFile, setActiveFile] = useState('identity.md')
  const [draft, setDraft] = useState('')
  const [promptChars, setPromptChars] = useState(0)
  const [saving, setSaving] = useState(false)
  const [pendingSwitchFile, setPendingSwitchFile] = useState<string | null>(null)

  const [capabilities, setCapabilities] = useState<CapabilityItem[]>([])
  const [credentials, setCredentials] = useState<PublicCredential[]>([])
  const [credDrafts, setCredDrafts] = useState<Record<string, Record<string, string>>>({})
  const [revealedFields, setRevealedFields] = useState<Record<string, boolean>>({})
  const [savingCred, setSavingCred] = useState<string | null>(null)
  const [deleteCredTarget, setDeleteCredTarget] = useState<PublicCredential | null>(null)
  const [deletingCred, setDeletingCred] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<ApprovalRecord | null>(null)
  const [approvalBusy, setApprovalBusy] = useState(false)

  const isDirty = (personaFiles[activeFile] ?? '') !== draft
  const showSkeleton = useDelayedLoading(loading && Object.keys(personaFiles).length === 0, 180)

  useEffect(() => {
    setTab(validTab)
  }, [validTab])

  useEffect(() => {
    if (!isDirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [isDirty])

  const switchTab = (next: SoulTab) => {
    setTab(next)
    onTabChange?.(next)
  }

  const loadAll = async () => {
    setLoading(true)
    setError('')
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
      const msg = (e as Error).message
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadAll()
  }, [botId])

  const selectFile = (name: string) => {
    if (name === activeFile) return
    if (isDirty) {
      setPendingSwitchFile(name)
      return
    }
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
    setSavingCred(cred.name)
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
    } finally {
      setSavingCred(null)
    }
  }

  const confirmRemoveCredential = async () => {
    if (!deleteCredTarget) return
    setDeletingCred(true)
    try {
      await api.deleteCredential(botId, deleteCredTarget.name)
      setCredentials((prev) => prev.filter((c) => c.name !== deleteCredTarget.name))
      setDeleteCredTarget(null)
      toast.success('已移除该外部凭证')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setDeletingCred(false)
    }
  }

  const handleApproval = async (op: 'approve' | 'reject') => {
    if (!pendingApproval) return
    setApprovalBusy(true)
    try {
      await api.approvalOp(botId, pendingApproval.id, op)
      toast.success(op === 'approve' ? '已同意该请求，她可以继续推进了' : '已告知暂不批准')
      setPendingApproval(null)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setApprovalBusy(false)
    }
  }

  const toggleCap = async (cap: CapabilityItem, enabled: boolean) => {
    const next = enabled ? 'active' : 'disabled'
    setCapabilities((prev) => prev.map((x) => (x.name === cap.name ? { ...x, status: next } : x)))
    try {
      await api.toggleCapability(botId, cap.name, next)
      toast.success(`技能 ${cap.name} 已${enabled ? '启用' : '停用'}`)
    } catch (e) {
      setCapabilities((prev) => prev.map((x) => (x.name === cap.name ? { ...x, status: cap.status } : x)))
      toast.error((e as Error).message)
    }
  }

  return (
    <div className="space-y-6">
      {/* 待审批请求横幅 */}
      {pendingApproval && (
        <section
          role="region"
          aria-label="待审批的自主请求"
          className="rounded-[12px] border p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
          style={{ backgroundColor: 'var(--warn-bg)', borderColor: 'var(--warn-border)' }}
        >
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--warn-fg)' }}>
              <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
              待你点头的自主请求
            </div>
            <p className="font-voice text-[15px] break-words" style={{ color: 'var(--gray-12)' }}>
              {pendingApproval.what}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="secondary"
              size="sm"
              disabled={approvalBusy}
              onClick={() => { void handleApproval('reject') }}
            >
              <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
              暂不批准
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={approvalBusy}
              onClick={() => { void handleApproval('approve') }}
            >
              <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
              同意执行
            </Button>
          </div>
        </section>
      )}

      <UnderlineTabs
        ariaLabel="灵魂与能力视图切换"
        value={tab}
        onChange={switchTab}
        items={[
          { id: 'persona', label: '人设工作台', icon: FileEdit, count: Object.keys(personaFiles).length },
          { id: 'credentials', label: '外部凭证', icon: KeyRound, count: credentials.length },
          { id: 'skills', label: '本领清单', icon: Wrench, count: capabilities.length },
        ]}
      />

      {error && <ErrorState title="无法加载灵魂配置" message={error} onRetry={() => { void loadAll() }} />}

      {showSkeleton && (
        <div className="ui-panel p-6 space-y-3">
          <div className="ui-skeleton h-5 w-44" />
          <div className="ui-skeleton h-64 w-full" />
        </div>
      )}

      {/* 1) 人设包在线工作台（左侧文件列表 + 右侧编辑器，支持 Ctrl/Cmd+S） */}
      {!showSkeleton && tab === 'persona' && (
        <section className="ui-panel overflow-hidden">
          <div className="grid grid-cols-1 md:grid-cols-12 min-h-[520px]">
            <aside
              className="md:col-span-3 border-b md:border-b-0 md:border-r p-3 space-y-1"
              style={{ backgroundColor: 'var(--surface-subtle)', borderColor: 'var(--gray-6)' }}
            >
              <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gray-11)' }}>
                人设包文件
              </div>
              {Object.keys(personaFiles).map((fname) => {
                const active = activeFile === fname
                return (
                  <button
                    key={fname}
                    type="button"
                    onClick={() => selectFile(fname)}
                    aria-current={active ? 'true' : undefined}
                    className="w-full text-left px-2.5 py-2 rounded-[8px] text-[13px] font-mono-num flex items-center justify-between gap-2 cursor-pointer transition-colors duration-150"
                    style={{
                      backgroundColor: active ? 'var(--accent-3)' : 'transparent',
                      color: active ? 'var(--accent-11)' : 'var(--gray-12)',
                      fontWeight: active ? 600 : 400,
                    }}
                    translate="no"
                  >
                    <span className="truncate">{fname}</span>
                    {active && isDirty && (
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: 'var(--warn-solid)' }} aria-label="有未保存修改" />
                    )}
                  </button>
                )
              })}
            </aside>

            <div className="md:col-span-9 p-5 flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b" style={{ borderColor: 'var(--gray-6)' }}>
                <div className="flex items-center gap-2 min-w-0">
                  <h2 className="text-[14px] font-semibold font-mono-num truncate" translate="no">{activeFile}</h2>
                  {isDirty && <Badge tone="warn">未保存</Badge>}
                </div>
                <span className="text-[12px] font-mono-num" style={{ color: 'var(--gray-11)' }}>
                  静态前缀 {promptChars}&nbsp;字
                </span>
              </div>

              <label htmlFor="persona-editor" className="sr-only">编辑 {activeFile}</label>
              <textarea
                id="persona-editor"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault()
                    void saveFile()
                  }
                }}
                rows={16}
                spellCheck={false}
                className="ui-input flex-1 font-mono-num text-[13px] leading-[1.65] resize-y"
              />

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <span className="text-[12px]" style={{ color: 'var(--gray-11)' }}>
                  保存后立即热重载至内存；按 <kbd className="font-mono-num px-1 py-0.5 rounded border text-[11px]" style={{ borderColor: 'var(--gray-6)' }}>Ctrl&nbsp;+&nbsp;S</kbd> 快捷保存。
                </span>
                <div className="flex items-center gap-2">
                  {isDirty && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setDraft(personaFiles[activeFile] ?? '')}
                    >
                      还原改动
                    </Button>
                  )}
                  <Button variant="primary" size="sm" loading={saving} onClick={() => { void saveFile() }}>
                    <Save className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{saving ? '保存中…' : `保存 ${activeFile}`}</span>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 2) 外部服务凭证（独立表单与密文隔离） */}
      {!showSkeleton && tab === 'credentials' && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-[15px] font-semibold">外部服务凭证</h2>
              <p className="text-[12px] mt-0.5" style={{ color: 'var(--gray-11)' }}>
                所有密钥以 0600 权限本地密文隔离，绝不经过聊天上下文或提示词。
              </p>
            </div>
            <span className="text-[12px] font-mono-num" style={{ color: 'var(--gray-11)' }}>
              {credentials.filter((c) => c.filled).length} / {credentials.length}&nbsp;已就绪
            </span>
          </div>

          {credentials.length === 0 ? (
            <div className="ui-panel">
              <EmptyState
                icon={KeyRound}
                title="没有待填写的外部凭证"
                description="当她在自主造技能时发现需要某项外部 API 密钥，会自动在这里登记表单并提醒你填写。"
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {credentials.map((cred) => (
                <form
                  key={cred.name}
                  onSubmit={(e) => {
                    e.preventDefault()
                    void submitCredential(cred)
                  }}
                  className="ui-panel p-5 flex flex-col justify-between gap-4"
                >
                  <div className="space-y-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="text-[15px] font-semibold truncate">{cred.label}</h3>
                        <div className="text-[12px] font-mono-num truncate" style={{ color: 'var(--gray-11)' }} translate="no">
                          {cred.name} · {cred.providerName || cred.provider}
                        </div>
                      </div>
                      <Badge tone={cred.filled ? 'ok' : 'warn'}>{cred.filled ? '已就绪' : '待填写'}</Badge>
                    </div>

                    {cred.why && (
                      <p className="font-voice text-[13px] leading-relaxed" style={{ color: 'var(--gray-11)' }}>
                        {cred.why}
                      </p>
                    )}

                    <div className="space-y-3 pt-2 border-t" style={{ borderColor: 'var(--gray-6)' }}>
                      {cred.fields.map((f) => {
                        const fieldId = `cred-${cred.name}-${f.key}`
                        const revealKey = `${cred.name}:${f.key}`
                        const revealed = Boolean(revealedFields[revealKey])
                        return (
                          <div key={f.key} className="space-y-1">
                            <label htmlFor={fieldId} className="flex items-center justify-between gap-2 text-[12px] font-medium" style={{ color: 'var(--gray-12)' }}>
                              <span>{f.label}{f.required ? ' *' : ''}</span>
                              {cred.maskedValues[f.key] && (
                                <span className="font-mono-num text-[11px]" style={{ color: 'var(--gray-11)' }}>
                                  当前：{cred.maskedValues[f.key]}
                                </span>
                              )}
                            </label>
                            <div className="ui-input-group">
                              <input
                                id={fieldId}
                                type={f.type === 'secret' && !revealed ? 'password' : 'text'}
                                placeholder={f.placeholder || `输入 ${f.key}…`}
                                spellCheck={false}
                                autoComplete="off"
                                value={credDrafts[cred.name]?.[f.key] ?? ''}
                                onChange={(e) =>
                                  setCredDrafts((prev) => ({
                                    ...prev,
                                    [cred.name]: { ...(prev[cred.name] ?? {}), [f.key]: e.target.value },
                                  }))
                                }
                                className="ui-input-bare font-mono-num"
                              />
                              {f.type === 'secret' && (
                                <button
                                  type="button"
                                  aria-label={revealed ? `隐藏 ${f.label}` : `显示 ${f.label}`}
                                  onClick={() => setRevealedFields((prev) => ({ ...prev, [revealKey]: !revealed }))}
                                  className="min-w-[28px] min-h-[28px] flex items-center justify-center rounded-[6px] cursor-pointer"
                                  style={{ color: 'var(--gray-11)' }}
                                >
                                  {revealed ? <EyeOff className="w-3.5 h-3.5" aria-hidden="true" /> : <Eye className="w-3.5 h-3.5" aria-hidden="true" />}
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t" style={{ borderColor: 'var(--gray-6)' }}>
                    <Button type="submit" variant="primary" size="sm" loading={savingCred === cred.name}>
                      {savingCred === cred.name ? '保存中…' : '保存并唤醒'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`移除凭证 ${cred.label}`}
                      onClick={() => setDeleteCredTarget(cred)}
                      style={{ color: 'var(--danger-fg)' }}
                    >
                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                    </Button>
                  </div>
                </form>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 3) 已学会的本领清单（无障碍 Disclosure + Switch） */}
      {!showSkeleton && tab === 'skills' && (
        <section className="ui-panel px-5 py-4">
          <div className="flex items-center justify-between pb-3 border-b" style={{ borderColor: 'var(--gray-6)' }}>
            <h2 className="text-[15px] font-semibold">她的本领清单</h2>
            <span className="font-mono-num text-[12px]" style={{ color: 'var(--gray-11)' }}>
              {capabilities.length}&nbsp;项技能
            </span>
          </div>

          {capabilities.length === 0 ? (
            <EmptyState
              icon={Wrench}
              title="还没有自造技能"
              description="当她为某个念头亲手编写脚本并通过自检登记后，技能说明与启停开关会出现在这里。"
            />
          ) : (
            <div>
              {capabilities.map((cap) => (
                <Disclosure
                  key={cap.name}
                  header={
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[14px] font-semibold font-mono-num truncate" translate="no">
                          {cap.name}
                        </span>
                        <Badge tone={cap.status === 'active' ? 'ok' : 'neutral'}>
                          {cap.status === 'active' ? '运行中' : '已停用'}
                        </Badge>
                      </div>
                      <div className="text-[12px] truncate mt-0.5" style={{ color: 'var(--gray-11)' }}>
                        {cap.summary}
                      </div>
                    </div>
                  }
                  trailing={
                    <Switch
                      checked={cap.status === 'active'}
                      onCheckedChange={(next) => { void toggleCap(cap, next) }}
                      ariaLabel={`启用技能 ${cap.name}`}
                    />
                  }
                >
                  {cap.doc ? (
                    <pre
                      className="p-3.5 rounded-[8px] text-[12px] font-mono-num whitespace-pre-wrap overflow-x-auto m-0"
                      style={{ backgroundColor: 'var(--surface-subtle)', color: 'var(--gray-11)' }}
                    >
                      {cap.doc}
                    </pre>
                  ) : (
                    <p className="text-[12px]" style={{ color: 'var(--gray-11)' }}>该技能没有附带 SKILL.md 说明文档。</p>
                  )}
                </Disclosure>
              ))}
            </div>
          )}
        </section>
      )}

      {/* 切换未保存人设文件确认 */}
      <AlertDialog
        open={Boolean(pendingSwitchFile)}
        title="放弃当前未保存的修改？"
        description={`文件 ${activeFile} 有尚未保存的改动，直接切换到 ${pendingSwitchFile ?? ''} 将丢失这些编辑内容。`}
        confirmLabel="放弃修改并切换"
        destructive
        onCancel={() => setPendingSwitchFile(null)}
        onConfirm={() => {
          if (pendingSwitchFile) {
            setActiveFile(pendingSwitchFile)
            setDraft(personaFiles[pendingSwitchFile] ?? '')
          }
          setPendingSwitchFile(null)
        }}
      />

      {/* 删除凭证确认 */}
      <AlertDialog
        open={Boolean(deleteCredTarget)}
        title="移除外部凭证？"
        description={
          deleteCredTarget ? (
            <span>
              移除「<strong style={{ color: 'var(--gray-12)' }}>{deleteCredTarget.label}</strong>」后，依赖它的技能或自主任务将暂停运行，直到重新填写。
            </span>
          ) : ''
        }
        confirmLabel="移除凭证"
        destructive
        loading={deletingCred}
        onCancel={() => setDeleteCredTarget(null)}
        onConfirm={() => { void confirmRemoveCredential() }}
      />
    </div>
  )
}
