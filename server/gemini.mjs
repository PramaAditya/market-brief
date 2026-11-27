/**
 * Gemini 4 Hydrogen streaming client via Fly.io Sprites zero-key Gemini Connector
 * (with automatic local GEMINI_API_KEY fallback for dev workstation).
 */

import { readEnvKey } from "./marketData.mjs";

const SPRITE_GATEWAY_LIST = "https://api.sprites.dev/v1/gateway/list";
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-4-hydrogen";

const SYSTEM_PROMPT = [
  "Kamu adalah asisten analis pasar day trading yang ringkas, objektif, dan jujur dalam Bahasa Indonesia.",
  "Pada pesan user terakhir, kamu akan menerima blok <hidden>...</hidden> berisi waktu saat ini (WIB & UTC) serta snapshot JSON pasar live (harga, tren 15m/1H/4H, RSI, ADX, ATR, Pivot R1/S1, dan S/R intraday)",
  "untuk 4 aset: Gold (XAUUSD), USD/JPY (USDJPY), GBP/USD (GBPUSD), dan US Oil (USOIL).",
  "",
  "Aturan wajib:",
  "1. Untuk harga, tren, RSI, ADX, ATR, dan level Support/Resistance saat ini, gunakan HANYA angka dari snapshot JSON live terbaru di blok <hidden> (jangan terpaku pada angka lama dari balasan sebelumnya bila harga sudah berubah).",
  "2. Kamu punya akses Google Search live: WAJIB gunakan Google Search setiap kali user menanyakan berita, katalis hari ini, jadwal data ekonomi/bank sentral, alasan harga bergerak, atau analisis kondisi aset tertentu. Jangan pernah menyimpulkan 'tidak ada berita/katalis hari ini' hanya dari isi snapshot JSON karena snapshot hanya berisi data harga/indikator teknikal, bukan berita.",
  "3. Gaya bahasa minimal jargon: hindari singkatan atau istilah teknikal yang berat tanpa penjelasan. Pakai bahasa sehari-hari yang luwes (misalnya 'tren naik tapi lagi turun sebentar / pullback', 'sudah agak jenuh beli', 'batas bawah terdekat di ...'). Kalau menyebut istilah teknikal, buat sesingkat dan sealami mungkin.",
  "4. Mudah di-scan sekaligus enak dibacakan langsung secara lisan (read out loud): mulai dari kesimpulan inti 1 kalimat, lalu susun dalam bullet points pendek (maksimal 1-2 kalimat per poin) dengan kalimat natural yang mengalir saat dibacakan, tanpa paragraf panjang atau tabel rumit. Wajib gunakan **tebal (bold)** pada **angka kunci** (harga, level support/resistance, momentum), **frasa penting** (misal **naik kuat**, **agak jenuh beli**, **rawan koreksi ringan**, **tunggu konfirmasi**), dan **kesimpulan/rekomendasi utama**—bukan cuma judul bullet-nya—supaya langsung terbaca dalam sekali lirik. Jangan pernah menyebut atau mengutip tag <hidden>.",
  "5. Jika ADX < 18 (pasar datar/sideways) atau tren 1 jam dan 4 jam bertabrakan, sampaikan jujur bahwa kondisinya belum searah dan lebih aman menunggu konfirmasi, tanpa memaksakan sinyal.",
  "6. Perspektif khusus day trader (intraday hari ini): fokus pada pergerakan hitungan menit hingga jam untuk hari ini saja (bukan target mingguan/bulanan). Gunakan jam WIB/UTC di <hidden> untuk mempertimbangkan sesi pasar yang sedang aktif (Asia, London, atau New York / overlap), dan prioritaskan level terdekat yang realistis ditempuh hari ini (mengacu pada Pivot, High/Low hari ini, batas 1 jam, serta rentang gerak per jam / ATR).",
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
  const llmSnapshot = {
    updatedWib: snapshot.updatedWib,
    assets: snapshot.assets,
    ...(Array.isArray(snapshot.macroAlerts) && snapshot.macroAlerts.length > 0
      ? { macroAlerts: snapshot.macroAlerts }
      : {}),
  };

  const hiddenContext = [
    "<hidden>",
    `Waktu saat ini: ${wibDate}, ${wibTime} WIB (${utcDate} UTC)`,
    `Snapshot teknikal pasar live (${snapshot.updatedWib}):`,
    JSON.stringify(llmSnapshot),
    "</hidden>",
  ].join("\n");

  const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
  const contents = messages.map((m, idx) => {
    const baseText = String(m.content || "");
    const text = idx === lastUserIdx ? `${hiddenContext}\n${baseText}` : baseText;
    return {
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text }],
    };
  });

  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    tools: [{ google_search: {} }],
    generationConfig: {
      maxOutputTokens: 4096,
      thinkingConfig: { includeThoughts: true },
    },
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
  const indexedChunks = [];
  const rawSupports = [];

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
          if (p.text && p.thought) {
            res.write(`data: ${JSON.stringify({ reasoning: p.text })}\n\n`);
          } else if (p.text && !p.thought) {
            fullText += p.text;
            res.write(`data: ${JSON.stringify({ delta: p.text })}\n\n`);
          }
        }
        const gMeta = cand?.groundingMetadata;
        const gChunks = gMeta?.groundingChunks || [];
        if (gChunks.length > 0) {
          gChunks.forEach((g, idx) => {
            const uri = g?.web?.uri;
            const title = g?.web?.title;
            if (uri) {
              indexedChunks[idx] = { title: title || uri, url: uri };
              if (!seenUrls.has(uri)) {
                seenUrls.add(uri);
                sources.push({ title: title || uri, url: uri });
              }
            }
          });
        }
        if (Array.isArray(gMeta?.groundingSupports) && gMeta.groundingSupports.length > 0) {
          rawSupports.push(...gMeta.groundingSupports);
        }
      } catch {
        // Ignore partial non-JSON lines
      }
    }
  }

  // Build deduplicated minimalist grounded claims from Gemini groundingSupports
  const textBuf = Buffer.from(fullText, "utf8");
  const seenClaimTexts = new Set();
  const claims = [];
  for (const sup of rawSupports) {
    const seg = sup?.segment || {};
    let segText = typeof seg.text === "string" ? seg.text.trim() : "";
    if (!segText && typeof seg.startIndex === "number" && typeof seg.endIndex === "number") {
      segText = textBuf.subarray(seg.startIndex, seg.endIndex).toString("utf8").trim();
    }
    // Strip markdown bold/italic markers for clean text matching
    const plain = segText.replace(/\*\*|__|[*_`]/g, "").trim();
    if (plain.length < 12 || seenClaimTexts.has(plain)) continue;

    const indices = Array.isArray(sup?.groundingChunkIndices) ? sup.groundingChunkIndices : [];
    const matchedSources = indices
      .map((i) => indexedChunks[i])
      .filter(Boolean)
      .slice(0, 3);
    if (matchedSources.length === 0) continue;

    const scores = Array.isArray(sup?.confidenceScores)
      ? sup.confidenceScores.filter((n) => typeof n === "number")
      : [];
    const confidence = scores.length > 0 ? Math.max(...scores) : null;

    seenClaimTexts.add(plain);
    claims.push({
      text: plain,
      confidence: confidence != null ? Math.round(confidence * 100) : null,
      sources: matchedSources,
    });
  }

  const topSources = sources.slice(0, 5);
  if (claims.length > 0) {
    res.write(`data: ${JSON.stringify({ claims: claims.slice(0, 12) })}\n\n`);
  }
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
