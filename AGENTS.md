# AGENTS.md — `market-brief`

> **Handoff & Project Context:** Read this file at the start of any new session to understand the architecture, UX decisions, Fly.io Sprites connectors, and deployment workflow.

## 1. Purpose & Real-World Context

`market-brief` is a **mobile-first intraday day-trading briefing dashboard** with a **floating streaming AI assistant** covering 4 liquid instruments:
- **Gold** (`XAUUSD`)
- **USD / Yen** (`USDJPY`)
- **GBP / USD** (`GBPUSD`)
- **US Oil (WTI)** (`USOIL`)

### Core UX Principles (Do Not Regress)
1. **Trend-First Visual Hierarchy:** The reader is often answering someone who is **already looking at the chart** and already knows the spot price. Therefore:
   - **Hero (top of card):** `15 menit`, `1 jam`, and `4 jam` directional trend pills with inline SVG arrows (`Naik`, `Turun`, `Datar`) and plain-language notes (`turun sebentar (pullback)`, `naik sebentar (bounce)`). Avoid bare `1H` / `4H` labels because Indonesian readers can misread `H` as *Hari* (day).
   - **Mid-card (dual-coded plain language + technical term):** `Momentum (RSI)`, `Kekuatan tren (ADX)`, `Support terdekat (S1)`, `Resistance terdekat (R1)` with enlarged `15px` bold values and muted labels.
   - **Footer (demoted):** `Harga sekarang` (`price` + `% change`) sits below the key levels.
   - **Expandable details (`Detail level lainnya`):** Clean 2-line label table with horizontal row dividers only (no vertical column borders) — top line = technical name (`ATR (1 jam)`, `Pivot`, `S2 / R2`, `High / Low`, `EMA 20 / 50`, `SMA 200`), bottom line = short Indonesian explanation.
2. **Minimalist, Zero-Slop UI:** No decorative eyebrows, emojis, fake active-tab styling on prompt chips, or `cursor: wait` on disabled buttons (`cursor: default`).
3. **Read-Out-Loud Day-Trader Assistant:**
   - Floating bottom-right CS-style widget built with `@assistant-ui/react` (`AssistantModalPrimitive` + `useLocalRuntime`).
   - Answers are tailored for **intraday day trading today** (session-aware: Asia / London / New York), **minimal jargon**, **bolded key numbers/phrases/conclusions** for 2-second scanning, and natural phrasing ready to be read out loud.
   - Includes **streaming Reasoning** (`Sedang berpikir...` shimmer while streaming → auto-collapses to `Proses berpikir`), **minimalist web-grounded Confidence Markers** (subtle emerald underline on Google Search–verified claims; click/tap reveals inline `Terverifikasi web` source card), and **persistent multi-thread history** (`<select>` thread switcher, `+ Baru`, `Hapus`).

---

## 2. Repository Layout

```text
market-brief/
├── AGENTS.md                           # Project & session handoff guide (this file)
├── README.md                           # Quick local & Sprite setup docs
├── setup.sh                            # Fly.io Sprite bootstrap (npm install, vite build, port 8080 service)
├── server.mjs                          # Node 22 HTTP server: static dist/, /api/snapshot, /api/threads*, /api/chat
├── server/
│   ├── indicators.mjs                  # Pure-math SMA, EMA, RSI, ATR, ADX, Classic Pivots, 15m->1H/4H resampling
│   ├── marketData.mjs                  # Dual-source fetcher: Twelve Data (3-min cache) + Yahoo Finance fallback/USOIL
│   ├── gemini.mjs                      # Gemini 4 Hydrogen SSE streaming, Google Search, reasoning, groundingSupports
│   └── db.mjs                          # Dual-mode store: DATABASE_URL -> Neon Sprite Connector -> local SQLite
├── src/
│   ├── main.tsx                        # React 19 entrypoint
│   ├── App.tsx                         # Mobile-first 4-asset trend-first cards + <AssistantWidget />
│   ├── components/AssistantWidget.tsx  # Floating @assistant-ui/react widget, threads, Reasoning, ConfidenceMarker
│   └── styles.css                      # Minimalist responsive CSS
├── .env                                # Gitignored local secrets (optional for local dev only)
└── data/                               # Gitignored local SQLite fallback (data/market-brief.db)
```

---

## 3. Infrastructure, Connectors & Fallbacks

### Production Deployment
- **GitHub Repo (Public):** `https://github.com/PramaAditya/market-brief` (branch `main`, Zone A identity `PramaAditya <prama13@gmail.com>`)
- **Fly.io Sprite:** `prod-market-brief` (org `prama-putra`)
- **Public HTTPS URL:** `https://prod-market-brief-bicns.sprites.app` (`Auth: public` so teammates can open directly on mobile without Sprites login)

### Zero-Key Fly.io Sprites Connectors (Auto-Discovered via `/v1/gateway/list`)
No `.env` or API keys are stored inside the Sprite VM. All 3 services auto-discover on boot/request:
1. **Twelve Data Custom API Connector (`provider: "custom_api"`, display name `Twelve Data`):**
   - Fetches Spot `XAU/USD`, `USD/JPY`, `GBP/USD` (`15min` + `1day` = **6 credits per full refresh**). `1H` and `4H` candles are resampled locally in `server/indicators.mjs`.
   - **Free-tier limits:** `8 credits/min`, `800 credits/day`. Protected by a **3-minute server-side cache** (`~133 full refreshes/day` capacity).
   - **US Oil (`USOIL`)** is not on Twelve Data's free tier, so it uses Yahoo Finance Futures (`CL=F`), which also acts as automatic fallback if Twelve Data rate-limits.
   - Local dev fallback: `TWELVEDATA_API_KEY` in `.env`.
2. **Google Gemini Connector (`provider: "gemini"`):**
   - Streams `gemini-4-hydrogen` via SSE with `tools: [{ google_search: {} }]`, `maxOutputTokens: 4096`, and `thinkingConfig: { includeThoughts: true }`.
   - Local dev fallback: `GEMINI_API_KEY` in `.env`.
3. **Neon PostgreSQL Connector (`provider: "neon"`):**
   - `server/db.mjs` auto-discovers the Neon connector, queries `/api/v2/users/me/organizations` for `org_id`, finds or creates Neon project `market-brief` (`NEON_PROJECT_NAME`), fetches `connection_uri`, and initializes `threads` and `messages` tables automatically.
   - Local dev fallback: `DATABASE_URL` in `.env` (PostgreSQL/Neon), or **Node 22 built-in `node:sqlite`** (`data/market-brief.db`) when unset.

---

## 4. Critical Engineering & Prompt Invariants

1. **Static `SYSTEM_PROMPT` + Hidden Per-Turn Context (`server/gemini.mjs`):**
   - `systemInstruction` stays 100% static for caching and clarity.
   - On every `POST /api/chat`, the server injects a `<hidden>...</hidden>` block **only into the latest user message sent to Gemini** (never shown in UI, never stored in Postgres/SQLite) containing:
     - Authoritative live clock (`WIB` & `UTC`, day/date/time)
     - Latest live technical JSON snapshot (`updatedWib` + `assets`)
2. **Never Send Empty `macroAlerts: []` to Gemini:**
   - Omit `macroAlerts` from the LLM snapshot when empty; otherwise Gemini assumes there are no news catalysts today and skips Google Search.
3. **Thinking + Grounding SSE Events (`server/gemini.mjs` ↔ `AssistantWidget.tsx`):**
   - `p.thought === true` → `{"reasoning": "..."}` (rendered in collapsible `ReasoningText`, NOT persisted to DB).
   - `p.thought !== true` → `{"delta": "..."}` (rendered in `MarkdownText`, persisted with sources footer to DB via `onComplete`).
   - `groundingMetadata.groundingSupports` → `{"claims": [...]}` (mapped to `groundingChunks` indices for minimalist inline `GroundedBlock` underlines).
   - Always keep `maxOutputTokens >= 4096` so thinking tokens never truncate the final answer.
4. **Thread Modal Stability:**
   - Keep `AssistantRuntimeProvider` inside `<ThreadSession key={...} />` *inside* `AssistantModalPrimitive.Content` so switching threads, creating `+ Baru`, or deleting a thread never closes the floating modal.
5. **Security & Repo Hygiene:**
   - Never commit `.env`, `data/`, or raw API keys. This is a **public** repository.

---

## 5. Quick Commands

```powershell
# Local development (PowerShell)
cd D:\Developer\market-brief
npx tsc --noEmit
npm run build
npm start
# Open http://localhost:8080

# Deploy latest pushed commit on GitHub to Fly.io Sprite (prod-market-brief)
sprite exec -s prod-market-brief --no-stdin -- bash -c "set -euo pipefail; cd /home/sprite/market-brief && git pull --ff-only && bash setup.sh"

# Check live health, Postgres persistence, and market snapshot on Sprite
curl.exe -sSI https://prod-market-brief-bicns.sprites.app
sprite exec -s prod-market-brief --no-stdin -- bash -c "curl -sS http://localhost:8080/api/threads"
```
