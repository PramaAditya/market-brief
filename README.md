# `market-brief`

Mobile-first day-trading market briefing & streaming **Gemini 4 Hydrogen** assistant for **Gold (`XAUUSD`)**, **USD/JPY (`USDJPY`)**, **GBP/USD (`GBPUSD`)**, and **US Oil (`USOIL`)** — built with **React + Vite + Node (`npm`)** for **Fly.io Sprites**.

- **Zero API keys in Sprite VM:** Auto-discovers **Twelve Data** (Spot `XAU/USD`, `USD/JPY`, `GBP/USD`), **Google Gemini** (`gemini-4-hydrogen` SSE streaming + Google Search grounding), and **Neon PostgreSQL** via Fly.io Sprites Connectors (`/v1/gateway/list`), with automatic Yahoo Finance (`CL=F`) and local SQLite (`data/market-brief.db`) fallbacks.

## Database Configuration (Optional)
- **Fly.io Sprite (Neon Connector):** Auto-discovers your Neon Sprites Connector and creates/reuses the `market-brief` project automatically — zero manual `DATABASE_URL` needed.
- **Neon / Local PostgreSQL:** Set `DATABASE_URL=postgresql://...` in `.env` (SSL is auto-enabled for non-localhost URLs). Tables (`threads`, `messages`) are created automatically on first request.
- **Zero-setup local dev:** Leave `DATABASE_URL` unset to store threads in `data/market-brief.db`.

## Local Run
```powershell
npm install
npm run build
npm start
# Open http://localhost:8080
```

## Deploy to Fly.io Sprite
```bash
tar --exclude=node_modules --exclude=dist --exclude=.env --exclude=.git -czf - \
  package.json tsconfig.json vite.config.ts index.html server.mjs server src setup.sh README.md | \
  sprite exec --stdin -- bash -c "mkdir -p /home/sprite/market-brief && tar xzf - -C /home/sprite/market-brief && bash /home/sprite/market-brief/setup.sh"
```
