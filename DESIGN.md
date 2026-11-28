# ZySoulBot Admin Console — Design System (`DESIGN.md`)

## 1. Product Mode & Aesthetic Direction
- **Modes**: **Operate** (observatory, metrics, configuration, diagnostics) + **Read** (companion inner voice, diaries, memories, works).
- **Character**: Calm, precise, botanical-editorial software console. Operational chrome stays crisp and neutral so the companion's living voice (diaries, memories, inner thoughts) stands out naturally without decorative noise.
- **Explicit Bans**:
  - No nested cards inside cards (Cardocalypse); group content with spacing, typography weight, and 1px hairline dividers.
  - No blurred decorative orbs, rotating geometric rings, shimmering CTA streaks, dot-grid backgrounds, or floating ambient particles.
  - No bare native `<select>` or blocking `alert()` / `confirm()` / `prompt()`.
  - No pulsing status dots on static states; no status-chip soup.
  - No `transition: all`; animate only `transform` and `opacity` (`< 300ms`, strong `ease-out`).

## 2. Color System (Radix 12-Step Sage Neutral + Jade Brand Accent)
Both Light and Dark modes follow identical 12-step semantic slots with `color-scheme` and `<meta name="theme-color">` kept in sync:
- **Step 1**: App canvas (`#FAFBF9` light / `#0C0F0E` dark)
- **Step 2 / Surface**: Panels & sidebar (`#FFFFFF` light / `#131816` dark)
- **Step 3–5**: Interactive control rest / hover / active surfaces
- **Step 6–8**: Non-interactive hairlines (`6`) → interactive borders (`7`) → hover/focus borders (`8`)
- **Step 9–10**: Brand solid CTA (`#1E875F` with `#FFFFFF` text in light; `#34B883` with `#071A12` text in dark)
- **Step 11–12**: Secondary (`≥ 4.5:1` / APCA Lc 60+) & Primary (`≥ 14:1` / APCA Lc 90+) ink
- **Semantic Roles**: `ok` (jade/emerald), `warn` (amber), `danger` (crimson), `info` (cobalt) — each paired with tinted low-alpha surface and readable high-contrast foreground.

## 3. Typography Scale & Reading Craft
- **UI Sans**: `"Plus Jakarta Sans", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`
- **Companion Voice / Diary**: `"LXGW WenKai Screen", "Noto Serif SC", Georgia, serif` (used strictly for her authentic quotes, diaries, memories, and works)
- **Monospace / Numerals**: `"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace` with `font-variant-numeric: tabular-nums`
- **Modular Scale**: `12px` (`--text-xs`), `14px` (`--text-sm`), `16px` (`--text-base`), `18px` (`--text-lg`), `20px` (`--text-xl`), `24px` (`--text-2xl`), `30px` (`--text-3xl`).
- **Reading Rules**: Headings `line-height: 1.25` + `text-wrap: balance`; prose `line-height: 1.65–1.85` + `max-width: 65ch` + `text-wrap: pretty`; mobile inputs `≥ 16px`.

## 4. Radii, Elevation & Motion
- **Concentric Radii**: Controls `8px`, Panels `12px`, Dialogs `16px`, Pills `9999px`.
- **Elevation**: Single top-light multi-layered sage-tinted soft shadows in Light mode; surface luminance stepping + 1px translucent hairline + top highlight in Dark mode.
- **Motion**: `--ease-out-quart: cubic-bezier(0.23, 1, 0.32, 1)`, buttons `:active { transform: scale(0.97) }`, popovers/dialogs enter from `scale(0.96)` in `160–200ms`, full `prefers-reduced-motion: reduce` fallback.
