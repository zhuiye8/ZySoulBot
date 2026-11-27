// QQ 气泡拆分：清 Markdown、列表原子整块、合并悬挂冒号与碎片、尾随问句独立成泡、长文单泡防刷屏。
export interface SplitOptions {
  maxChars?: number
  maxBubbles?: number
}

const LONG_TEXT = 600
const TINY = 6
const BACKCHANNEL = /^(唔+|嗯+|啊+|哦+|哎+|欸+|哈+|嘿+|唔嗯|嗯？|啊？|哦？)[？?。.…~～]*$/

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, '').replace(/```/g, ''))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}

const isListLine = (line: string): boolean => /^\s*(?:[-*•]|\d+[.、)]|[一二三四五六七八九十]+[、.])\s+/.test(line)

function splitLong(unit: string, maxChars: number): string[] {
  const sentences = unit.split(/(?<=[。！？!?~…\n])/).map((s) => s.trim()).filter(Boolean)
  const out: string[] = []
  let cur = ''
  const flush = (): void => { if (cur.trim()) { out.push(cur.trim()); cur = '' } }
  for (const s of sentences) {
    if (s.length > maxChars) {
      flush()
      for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars))
      continue
    }
    if ((cur + s).length > maxChars) flush()
    cur += s
  }
  flush()
  return out
}

// QQ 气泡口语自然化：柔化普通短气泡里的书面句号 `。`（句中改为空格换气，句尾省略），保留 `？`/`！`/`…`/`~`、引号内、列表和长文不动。
function softenBubbleTail(bubble: string): string {
  const firstLine = bubble.split('\n')[0] ?? ''
  if (isListLine(firstLine) || bubble.length > 160) return bubble
  let out = bubble
  if (!out.includes('\n') && out.length <= 100 && !/[「」『』"“”]/.test(out)) {
    out = out.replace(/。+(?=[^\s])/gu, ' ')
  }
  return out.replace(/。+$/u, '').trim()
}

export function splitReply(text: string, opts: SplitOptions = {}): string[] {
  const maxChars = opts.maxChars ?? 80
  const maxBubbles = opts.maxBubbles ?? 4
  const clean = stripMarkdown(text).trim()
  if (!clean) return []
  if (clean.length > LONG_TEXT) return [clean]

  const units: string[] = []
  for (const para of clean.split(/\n{2,}/)) {
    const lines = para.split('\n').map((l) => l.trim()).filter(Boolean)
    let listBuf: string[] = []
    const flushList = (): void => { if (listBuf.length) { units.push(listBuf.join('\n')); listBuf = [] } }
    for (const line of lines) {
      if (isListLine(line)) { listBuf.push(line); continue }
      flushList()
      units.push(line)
    }
    flushList()
  }

  const bubbles: string[] = []
  for (const u of units) {
    if (isListLine(u.split('\n')[0] ?? '') || u.length <= maxChars) bubbles.push(u)
    else bubbles.push(...splitLong(u, maxChars))
  }

  const merged: string[] = []
  for (const b of bubbles) {
    const prev = merged[merged.length - 1]
    if (prev && /[：，,]$/.test(prev)) merged[merged.length - 1] = `${prev}\n${b}`
    else merged.push(b)
  }

  const tidy: string[] = []
  for (const b of merged) {
    const prev = tidy[tidy.length - 1]
    if (b.length < TINY && !BACKCHANNEL.test(b) && prev) tidy[tidy.length - 1] = `${prev}\n${b}`
    else tidy.push(b)
  }

  const withTail: string[] = []
  for (const b of tidy) {
    const m = /^([\s\S]{20,}?[。！？~…])\s*([^。！？\n]*[？?])\s*$/.exec(b)
    if (m?.[1] && m[2]) withTail.push(m[1].trim(), m[2].trim())
    else withTail.push(b)
  }

  if (withTail.length > maxBubbles) {
    const head = withTail.slice(0, maxBubbles - 1)
    const tail = withTail.slice(maxBubbles - 1).join('\n\n')
    return [...head, tail].map(softenBubbleTail).filter(Boolean)
  }
  return withTail.map(softenBubbleTail).filter(Boolean)
}
