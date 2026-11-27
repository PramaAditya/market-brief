/**
 * Gemini 4 Hydrogen streaming client via Fly.io Sprites zero-key Gemini Connector
 * (with automatic local GEMINI_API_KEY fallback for dev workstation).
 */

import { readEnvKey } from "./marketData.mjs";

const SPRITE_GATEWAY_LIST = "https://api.sprites.dev/v1/gateway/list";
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-4-hydrogen";

const SYSTEM_PROMPT = [
  "Kamu adalah asisten analis teknikal day trading yang ringkas, objektif, dan jujur dalam Bahasa Indonesia.",
  "Kamu menerima snapshot data pasar live (harga, tren 15m/1H/4H, RSI, ADX, ATR, Pivot R1/S1, dan S/R intraday)",
  "untuk 4 aset: Gold (XAUUSD), USD/JPY (USDJPY), GBP/USD (GBPUSD), dan US Oil (USOIL).",
  "",
  "Aturan wajib:",
  "1. Untuk harga, tren, RSI, ADX, ATR, dan level Pivot/SR, gunakan HANYA angka dari snapshot JSON live yang diberikan.",
  "2. Kamu punya akses Google Search live: gunakan untuk mengecek katalis berita hari ini, jadwal rilis data makro AS/bank sentral, atau alasan pergerakan pasar saat relevan.",
  "3. Jawab ringkas, terstruktur (bullet points), dan langsung siap dibacakan saat ditanya.",
  "4. Jika ADX < 18 (sideways) atau 1H vs 4H bertabrakan, katakan jujur 'tunggu konfirmasi' tanpa memaksakan sinyal.",
].join("\n");

export async function discoverGeminiEndpoint() {
  try {
    const resp = await fetch(SPRITE_GATEWAY_LIST, { signal: AbortSignal.timeout(2500) });
    if (resp.ok) {
      const data = await resp.json();
      for (const c of data.connections || []) {
        if (String(c.provider || "").toLowerCase() === "gemini" && c.gateway_base_url) {
          return {
            baseUrl: `${String(c.gateway_base_url).replace(/\/$/, "")}/v1beta`,
            apiKey: "sprite-gateway",
            source: "sprites-connector",
          };
        }
      }
    }
  } catch {
    // Fallback to local env
  }

  const key = readEnvKey("GEMINI_API_KEY");
  if (key) {
    return {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: key,
      source: "local-env",
    };
  }
  throw new Error("Gemini Sprites Connector not found and GEMINI_API_KEY is not set.");
}

export async function streamGeminiChat({ messages, snapshot, res, threadId, onComplete }) {
  const { baseUrl, apiKey, source } = await discoverGeminiEndpoint();
  const url = `${baseUrl}/models/${encodeURIComponent(GEMINI_MODEL)}:streamGenerateContent?alt=sse`;

  // Authoritative live timestamp injected inside <hidden>...</hidden> for LLM only (never shown in UI)
  const now = new Date();
  const wibDate = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(now);
  const wibTime = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const utcDate = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const hiddenClock = `<hidden>Waktu saat ini: ${wibDate}, ${wibTime} WIB (${utcDate} UTC)</hidden>`;

  // Inject fresh live snapshot into the system instruction so every turn is grounded
  const groundedSystem = `${SYSTEM_PROMPT}\n\n${hiddenClock}\nSnapshot pasar live (${snapshot.updatedWib}):\n${JSON.stringify(snapshot)}`;

  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const contents = messages.map((m, idx) => {
    const baseText = String(m.content || "");
    const text = idx === lastUserIdx ? `${hiddenClock}\n${baseText}` : baseText;
    return {
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text }],
    };
  });

  const payload = {
    systemInstruction: { parts: [{ text: groundedSystem }] },
    contents,
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: 4096 },
  };

  const upstream = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
      "User-Agent": "market-brief/1.0",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    throw new Error(`Gemini HTTP ${upstream.status}: ${errText.slice(0, 260)}`);
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ meta: { model: GEMINI_MODEL, source, threadId } })}\n\n`);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  const seenUrls = new Set();
  const sources = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;
      try {
        const chunk = JSON.parse(jsonStr);
        const cand = chunk?.candidates?.[0];
        const parts = cand?.content?.parts || [];
        for (const p of parts) {
          if (p.text && !p.thought) {
            fullText += p.text;
            res.write(`data: ${JSON.stringify({ delta: p.text })}\n\n`);
          }
        }
        const gChunks = cand?.groundingMetadata?.groundingChunks || [];
        for (const g of gChunks) {
          const uri = g?.web?.uri;
          const title = g?.web?.title;
          if (uri && !seenUrls.has(uri)) {
            seenUrls.add(uri);
            sources.push({ title: title || uri, url: uri });
          }
        }
      } catch {
        // Ignore partial non-JSON lines
      }
    }
  }

  const topSources = sources.slice(0, 5);
  if (topSources.length > 0) {
    res.write(`data: ${JSON.stringify({ sources: topSources })}\n\n`);
  }

  const finalText =
    topSources.length > 0
      ? `${fullText}\n\n---\n${topSources.map((s) => `[${s.title} ↗](${s.url})`).join(" · ")}`
      : fullText;

  if (typeof onComplete === "function" && finalText.trim().length > 0) {
    try {
      await onComplete(finalText);
    } catch (err) {
      console.error("Failed to persist assistant message:", err?.message || err);
    }
  }

  res.write("data: [DONE]\n\n");
  res.end();
}
