import { useEffect, useId, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertTriangle,
  RotateCcw,
  Upload,
} from 'lucide-react'
import { buildRouteUrl, navigateTo } from '../lib/router.ts'
import type { AppRoute } from '../lib/router.ts'

// ── 1) Semantic AppLink (<a href> preserving Cmd/Ctrl/middle click) ─────────
export function AppLink({
  to,
  replace = false,
  onClick,
  children,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  to: AppRoute
  replace?: boolean
}) {
  const href = buildRouteUrl(to)
  return (
    <a
      href={href}
      onClick={(e) => {
        onClick?.(e)
        if (e.defaultPrevented) return
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
        e.preventDefault()
        navigateTo(to, replace)
      }}
      {...rest}
    >
      {children}
    </a>
  )
}

// ── 2) Button (4 semantic variants, tactile press, loading retains label) ───
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'destructiveSoft'
export type ButtonSize = 'sm' | 'md' | 'icon'

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'ui-btn-primary',
  secondary: 'ui-btn-secondary',
  ghost: 'ui-btn-ghost',
  destructive: 'ui-btn-destructive',
  destructiveSoft: 'ui-btn-destructive-soft',
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'min-h-[32px] px-3 py-1.5 text-[13px]',
  md: 'min-h-[36px] px-3.5 py-2 text-[13px]',
  icon: 'min-w-[32px] min-h-[32px] p-1.5',
}

export function Button({
  ref,
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: React.Ref<HTMLButtonElement>
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
}) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={`ui-btn ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`}
      {...rest}
    >
      {loading && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />}
      {children}
    </button>
  )
}

// ── 3) Badge (static, non-interactive, restrained semantic roles) ───────────
export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info'

const BADGE_STYLES: Record<BadgeTone, { bg: string; border: string; fg: string }> = {
  neutral: { bg: 'var(--gray-3)', border: 'var(--gray-6)', fg: 'var(--gray-11)' },
  accent: { bg: 'var(--accent-3)', border: 'var(--accent-6)', fg: 'var(--accent-11)' },
  ok: { bg: 'var(--ok-bg)', border: 'var(--ok-border)', fg: 'var(--ok-fg)' },
  warn: { bg: 'var(--warn-bg)', border: 'var(--warn-border)', fg: 'var(--warn-fg)' },
  danger: { bg: 'var(--danger-bg)', border: 'var(--danger-border)', fg: 'var(--danger-fg)' },
  info: { bg: 'var(--info-bg)', border: 'var(--info-border)', fg: 'var(--info-fg)' },
}

export function Badge({
  tone = 'neutral',
  className = '',
  children,
}: {
  tone?: BadgeTone
  className?: string
  children: ReactNode
}) {
  const s = BADGE_STYLES[tone]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] font-medium leading-tight ${className}`}
      style={{ backgroundColor: s.bg, borderColor: s.border, color: s.fg }}
    >
      {children}
    </span>
  )
}

// ── 4) FilterChip (<button aria-pressed> for toggles & facet filters) ───────
export function FilterChip({
  pressed,
  onClick,
  children,
  className = '',
}: {
  pressed: boolean
  onClick: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`ui-btn min-h-[30px] px-2.5 py-1 rounded-full text-[12px] font-medium border ${className}`}
      style={{
        backgroundColor: pressed ? 'var(--accent-3)' : 'var(--surface)',
        borderColor: pressed ? 'var(--accent-6)' : 'var(--gray-6)',
        color: pressed ? 'var(--accent-11)' : 'var(--gray-11)',
      }}
    >
      {pressed && <Check className="w-3 h-3 shrink-0" aria-hidden="true" />}
      {children}
    </button>
  )
}

// ── 5) Underline Tabs (WAI-ARIA tablist with Left/Right/Home/End nav) ───────
export interface TabItem<T extends string> {
  id: T
  label: string
  count?: number | null
  icon?: React.ComponentType<{ className?: string }>
}

export function UnderlineTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: Array<TabItem<T>>
  value: T
  onChange: (next: T) => void
  ariaLabel: string
}) {
  const listRef = useRef<HTMLDivElement | null>(null)

  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let nextIdx = -1
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % items.length
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + items.length) % items.length
    else if (e.key === 'Home') nextIdx = 0
    else if (e.key === 'End') nextIdx = items.length - 1
    if (nextIdx >= 0) {
      e.preventDefault()
      onChange(items[nextIdx]!.id)
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      buttons?.[nextIdx]?.focus()
    }
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      className="flex items-center gap-1 border-b overflow-x-auto"
      style={{ borderColor: 'var(--gray-6)' }}
    >
      {items.map((item, idx) => {
        const active = item.id === value
        const Icon = item.icon
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className="relative inline-flex items-center gap-1.5 px-3 py-2.5 text-[13px] font-medium whitespace-nowrap cursor-pointer touch-manipulation transition-colors duration-150"
            style={{ color: active ? 'var(--gray-12)' : 'var(--gray-11)' }}
          >
            {Icon && (
              <Icon
                className="w-3.5 h-3.5 shrink-0"
                aria-hidden="true"
              />
            )}
            <span>{item.label}</span>
            {item.count !== undefined && item.count !== null && (
              <span
                className="font-mono-num text-[11px] px-1.5 py-0.5 rounded-full"
                style={{
                  backgroundColor: active ? 'var(--accent-3)' : 'var(--gray-3)',
                  color: active ? 'var(--accent-11)' : 'var(--gray-11)',
                }}
              >
                {item.count}
              </span>
            )}
            {active && (
              <span
                aria-hidden="true"
                className="absolute left-2 right-2 bottom-0 h-[2px] rounded-full"
                style={{ backgroundColor: 'var(--accent-9)' }}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

// ── 6) Accessible Custom Select (Portal Listbox, keyboard & dark-mode safe) ─
export interface SelectOption {
  value: string
  label: string
  sublabel?: string
}

export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = '请选择…',
  className = '',
}: {
  value: string
  options: SelectOption[]
  onChange: (next: string) => void
  ariaLabel: string
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [hiIdx, setHiIdx] = useState(0)
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 200 })
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const listId = useId()

  const selected = options.find((o) => o.value === value)

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      setPos({
        top: Math.min(window.innerHeight - 220, rect.bottom + 6),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 200) - 8)),
        width: Math.max(rect.width, 180),
      })
    }
    const curIdx = Math.max(0, options.findIndex((o) => o.value === value))
    setHiIdx(curIdx)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (!triggerRef.current?.contains(target) && !listRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    const onResize = () => setOpen(false)
    document.addEventListener('mousedown', onOutside)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        openMenu()
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHiIdx((i) => (i + 1) % Math.max(1, options.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHiIdx((i) => (i - 1 + options.length) % Math.max(1, options.length))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setHiIdx(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setHiIdx(Math.max(0, options.length - 1))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const opt = options[hiIdx]
      if (opt) onChange(opt.value)
      setOpen(false)
      triggerRef.current?.focus()
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
        className={`ui-btn ui-btn-secondary w-full justify-between min-h-[34px] px-2.5 py-1.5 text-[13px] ${className}`}
      >
        <span className="truncate text-left">
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          className="w-3.5 h-3.5 shrink-0 transition-transform duration-150"
          style={{
            color: 'var(--gray-11)',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
          aria-hidden="true"
        />
      </button>

      {open && createPortal(
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="ui-popover fixed z-50 p-1 max-h-[240px] overflow-y-auto"
          style={{
            top: pos.top,
            left: pos.left,
            width: pos.width,
            transformOrigin: 'top center',
          }}
        >
          {options.map((opt, idx) => {
            const isSelected = opt.value === value
            const isHi = idx === hiIdx
            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setHiIdx(idx)}
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                  triggerRef.current?.focus()
                }}
                className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-[6px] text-[13px] cursor-pointer select-none"
                style={{
                  backgroundColor: isHi ? 'var(--gray-3)' : 'transparent',
                  color: isSelected ? 'var(--accent-11)' : 'var(--gray-12)',
                  fontWeight: isSelected ? 600 : 400,
                }}
              >
                <div className="min-w-0 truncate">
                  <span className="truncate">{opt.label}</span>
                  {opt.sublabel && (
                    <span className="ml-1.5 font-mono-num text-[11px]" style={{ color: 'var(--gray-11)' }}>
                      {opt.sublabel}
                    </span>
                  )}
                </div>
                {isSelected && <Check className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--accent-9)' }} aria-hidden="true" />}
              </li>
            )
          })}
        </ul>,
        document.body,
      )}
    </>
  )
}

// ── 7) Accessible Switch (role="switch", static label, smooth translateX) ───
export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  ariaLabel,
}: {
  checked: boolean
  onCheckedChange: (next: boolean) => void
  disabled?: boolean
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className="relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full border cursor-pointer touch-manipulation disabled:opacity-45 disabled:cursor-not-allowed transition-colors duration-150"
      style={{
        backgroundColor: checked ? 'var(--accent-9)' : 'var(--gray-4)',
        borderColor: checked ? 'transparent' : 'var(--gray-7)',
      }}
    >
      <span
        aria-hidden="true"
        className="inline-block h-4 w-4 rounded-full bg-white shadow-xs transition-transform duration-150"
        style={{
          transform: checked ? 'translateX(18px)' : 'translateX(2px)',
          transitionTimingFunction: 'var(--ease-out-quart)',
        }}
      />
    </button>
  )
}

// ── 8) AlertDialog (Portal, Focus Trap, Esc restore, Apple HIG safe focus) ──
export function AlertDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = '取消',
  destructive = true,
  loading = false,
  confirmTextRequired,
  confirmInputPlaceholder,
  onCancel,
  onConfirm,
}: {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel: string
  cancelLabel?: string
  destructive?: boolean
  loading?: boolean
  confirmTextRequired?: string
  confirmInputPlaceholder?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const titleId = useId()
  const descId = useId()
  const inputId = useId()
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const prevFocusRef = useRef<HTMLElement | null>(null)
  const [typed, setTyped] = useState('')
  const [inputErr, setInputErr] = useState('')

  useEffect(() => {
    if (!open) {
      setTyped('')
      setInputErr('')
      return
    }
    prevFocusRef.current = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Apple HIG: focus cancel button by default on destructive dialogs (or input if typed confirmation required)
    const timer = window.setTimeout(() => {
      if (confirmTextRequired) inputRef.current?.focus()
      else cancelRef.current?.focus()
    }, 10)

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) {
        e.preventDefault()
        onCancel()
        return
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )
        if (focusables.length === 0) return
        const first = focusables[0]!
        const last = focusables[focusables.length - 1]!
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
      prevFocusRef.current?.focus?.()
    }
  }, [open, loading, onCancel, confirmTextRequired])

  if (!open) return null

  const submitConfirm = () => {
    if (confirmTextRequired && typed.trim() !== confirmTextRequired) {
      setInputErr(`请输入“${confirmTextRequired}”以确认此操作`)
      inputRef.current?.focus()
      return
    }
    onConfirm()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
    >
      <div
        className="ui-backdrop fixed inset-0"
        onClick={() => { if (!loading && !destructive) onCancel() }}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="ui-dialog relative z-10 w-full max-w-[440px] p-6 space-y-4"
      >
        <div className="space-y-2">
          <h2 id={titleId} className="text-[17px] font-semibold tracking-tight">
            {title}
          </h2>
          <div id={descId} className="text-[13px] leading-relaxed" style={{ color: 'var(--gray-11)' }}>
            {description}
          </div>
        </div>

        {confirmTextRequired && (
          <div className="space-y-1.5">
            <label htmlFor={inputId} className="block text-[12px] font-medium" style={{ color: 'var(--gray-11)' }}>
              输入 <code className="font-mono-num px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--gray-3)', color: 'var(--gray-12)' }} translate="no">{confirmTextRequired}</code> 确认
            </label>
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value)
                if (inputErr) setInputErr('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitConfirm()
                }
              }}
              placeholder={confirmInputPlaceholder ?? `输入 ${confirmTextRequired}…`}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={Boolean(inputErr)}
              className="ui-input font-mono-num"
            />
            {inputErr && (
              <p role="alert" aria-live="polite" className="text-[12px]" style={{ color: 'var(--danger-fg)' }}>
                {inputErr}
              </p>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            loading={loading}
            onClick={submitConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── 9) Accessible Disclosure (<button aria-expanded> + hidden panel) ────────
export function Disclosure({
  header,
  trailing,
  defaultOpen = false,
  children,
}: {
  header: ReactNode
  trailing?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const panelId = useId()

  return (
    <div className="border-b last:border-b-0" style={{ borderColor: 'var(--gray-6)' }}>
      <div className="flex items-center justify-between gap-3 py-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2.5 min-w-0 flex-1 text-left cursor-pointer group"
        >
          <ChevronRight
            className="w-4 h-4 shrink-0 transition-transform duration-150"
            style={{
              color: 'var(--gray-11)',
              transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">{header}</div>
        </button>
        {trailing && <div className="shrink-0 flex items-center gap-2">{trailing}</div>}
      </div>
      <div id={panelId} hidden={!open} className="pb-3.5 pl-6.5">
        {children}
      </div>
    </div>
  )
}

// ── 10) Accessible File Dropzone (drag-over + keyboard Enter/Space) ─────────
export function Dropzone({
  accept,
  uploading = false,
  onFile,
  title,
  hint,
}: {
  accept: string
  uploading?: boolean
  onFile: (file: File) => void
  title: string
  hint: string
}) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const handleFiles = (files: FileList | null) => {
    const f = files?.[0]
    if (f && !uploading) onFile(f)
  }

  return (
    <div
      role="button"
      tabIndex={uploading ? -1 : 0}
      aria-disabled={uploading}
      aria-label={title}
      onClick={() => { if (!uploading) inputRef.current?.click() }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !uploading) {
          e.preventDefault()
          inputRef.current?.click()
        }
      }}
      onDragOver={(e) => {
        e.preventDefault()
        if (!uploading) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        handleFiles(e.dataTransfer.files)
      }}
      className="rounded-[12px] border border-dashed px-4 py-5 flex flex-col sm:flex-row items-center justify-between gap-3 cursor-pointer transition-colors duration-150"
      style={{
        backgroundColor: dragging ? 'var(--accent-2)' : 'var(--surface-subtle)',
        borderColor: dragging ? 'var(--accent-8)' : 'var(--gray-7)',
        opacity: uploading ? 0.65 : 1,
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="w-9 h-9 rounded-[8px] border flex items-center justify-center shrink-0"
          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--gray-6)', color: dragging ? 'var(--accent-11)' : 'var(--gray-11)' }}
        >
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Upload className="w-4 h-4" aria-hidden="true" />}
        </div>
        <div className="min-w-0 text-center sm:text-left">
          <div className="text-[13px] font-medium" style={{ color: 'var(--gray-12)' }}>
            {uploading ? '正在上传并自动识别情绪标签…' : dragging ? '松手即可上传' : title}
          </div>
          <div className="text-[12px] mt-0.5" style={{ color: 'var(--gray-11)' }}>{hint}</div>
        </div>
      </div>
      <span className="ui-btn ui-btn-secondary min-h-[32px] px-3 py-1.5 text-[12px] shrink-0 pointer-events-none">
        选择图片
      </span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        disabled={uploading}
        className="sr-only"
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

// ── 11) Meter (clean linear indicator with tabular-nums) ────────────────────
export function Meter({
  label,
  value,
  displayValue,
  min = 0,
  max = 1,
  tone = 'accent',
}: {
  label: string
  value: number
  displayValue?: string
  min?: number
  max?: number
  tone?: 'accent' | 'ok' | 'warn' | 'danger'
}) {
  const pct = Math.max(0, Math.min(100, Math.round(((value - min) / Math.max(0.0001, max - min)) * 100)))
  const barColor =
    tone === 'ok'
      ? 'var(--ok-solid)'
      : tone === 'warn'
        ? 'var(--warn-solid)'
        : tone === 'danger'
          ? 'var(--danger-solid)'
          : 'var(--accent-9)'

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[12px]">
        <span style={{ color: 'var(--gray-11)' }}>{label}</span>
        <span className="font-mono-num font-medium" style={{ color: 'var(--gray-12)' }}>
          {displayValue ?? value.toFixed(2)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(value * 100) / 100}
        aria-valuemin={min}
        aria-valuemax={max}
        className="h-1.5 rounded-full overflow-hidden"
        style={{ backgroundColor: 'var(--gray-3)' }}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            backgroundColor: barColor,
            transition: 'width 240ms var(--ease-out-quart)',
          }}
        />
      </div>
    </div>
  )
}

// ── 12) EmptyState & ErrorState & DelayedSkeleton ───────────────────────────
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="py-12 px-4 flex flex-col items-center justify-center text-center gap-2.5">
      <div
        className="w-10 h-10 rounded-[10px] border flex items-center justify-center"
        style={{ backgroundColor: 'var(--surface-subtle)', borderColor: 'var(--gray-6)', color: 'var(--gray-11)' }}
      >
        <Icon className="w-4 h-4" aria-hidden="true" />
      </div>
      <div className="space-y-1 max-w-[42ch]">
        <div className="text-[14px] font-medium" style={{ color: 'var(--gray-12)' }}>{title}</div>
        <p className="text-[13px]" style={{ color: 'var(--gray-11)' }}>{description}</p>
      </div>
      {action && <div className="pt-1.5">{action}</div>}
    </div>
  )
}

export function ErrorState({
  title = '数据加载失败',
  message,
  onRetry,
}: {
  title?: string
  message: string
  onRetry: () => void
}) {
  return (
    <div
      role="alert"
      className="ui-panel p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
      style={{ borderColor: 'var(--danger-border)', backgroundColor: 'var(--danger-bg)' }}
    >
      <div className="flex items-start gap-3 min-w-0">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--danger-fg)' }} aria-hidden="true" />
        <div className="min-w-0 space-y-0.5">
          <div className="text-[14px] font-semibold" style={{ color: 'var(--danger-fg)' }}>{title}</div>
          <p className="text-[13px] break-words" style={{ color: 'var(--danger-fg)' }}>
            {message}，请检查服务状态后重试。
          </p>
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={onRetry} className="shrink-0">
        <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
        重新加载
      </Button>
    </div>
  )
}

export function useDelayedLoading(loading: boolean, delayMs = 180): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!loading) {
      setVisible(false)
      return
    }
    const id = window.setTimeout(() => setVisible(true), delayMs)
    return () => window.clearTimeout(id)
  }, [loading, delayMs])
  return visible
}
