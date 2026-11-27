import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, newId } from "./server/db.mjs";
import { streamGeminiChat } from "./server/gemini.mjs";
import { getMarketSnapshot } from "./server/marketData.mjs";

function deriveTitle(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "Percakapan baru";
  return clean.length > 48 ? `${clean.slice(0, 48).trim()}...` : clean;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "dist");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || "8080");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(res, reqPath) {
  const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(DIST_DIR, safePath === "/" ? "index.html" : safePath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, "index.html");
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Frontend not built yet. Run: npm run build");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Content-Length": data.length,
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable",
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "HEAD") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/snapshot") {
    try {
      const force = url.searchParams.get("refresh") === "1";
      const snap = await getMarketSnapshot(force);
      sendJson(res, 200, snap);
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/threads") {
    try {
      const db = await getDb();
      const threads = await db.listThreads();
      sendJson(res, 200, { dbKind: db.kind, threads });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/threads") {
    try {
      const db = await getDb();
      const body = await readJsonBody(req).catch(() => ({}));
      const title = deriveTitle(body.title);
      const thread = await db.createThread(newId("thr_"), title);
      sendJson(res, 201, thread);
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  const threadMsgsMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
  if (req.method === "GET" && threadMsgsMatch) {
    try {
      const db = await getDb();
      const threadId = decodeURIComponent(threadMsgsMatch[1]);
      const messages = await db.getMessages(threadId);
      sendJson(res, 200, { threadId, messages });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (req.method === "DELETE" && threadMatch) {
    try {
      const db = await getDb();
      const threadId = decodeURIComponent(threadMatch[1]);
      await db.deleteThread(threadId);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    try {
      const body = await readJsonBody(req);
      const messages = Array.isArray(body.messages)
        ? body.messages
        : body.question
          ? [{ role: "user", content: String(body.question) }]
          : [];
      if (messages.length === 0) {
        sendJson(res, 400, { error: "Messages cannot be empty" });
        return;
      }

      const db = await getDb();
      const threadId =
        typeof body.threadId === "string" && body.threadId.trim()
          ? body.threadId.trim()
          : newId("thr_");
      const latestUser = [...messages].reverse().find((m) => m.role === "user");
      const title = deriveTitle(latestUser?.content);

      if (latestUser && String(latestUser.content || "").trim()) {
        const existing = await db.getMessages(threadId);
        const lastSaved = existing[existing.length - 1];
        if (!(lastSaved && lastSaved.role === "user" && lastSaved.content === latestUser.content)) {
          await db.addMessage(threadId, "user", String(latestUser.content), title);
        }
      }

      const snapshot = await getMarketSnapshot(false);
      await streamGeminiChat({
        messages,
        snapshot,
        res,
        threadId,
        onComplete: async (finalText) => {
          await db.addMessage(threadId, "assistant", finalText, title);
        },
      });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err?.message || String(err) });
      } else {
        res.write(`data: ${JSON.stringify({ error: err?.message || String(err) })}\n\n`);
        res.end();
      }
    }
    return;
  }

  if (req.method === "GET") {
    serveStatic(res, url.pathname);
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
});

server.listen(PORT, HOST, () => {
  console.log(`market-brief listening on http://localhost:${PORT} (bound to ${HOST}:${PORT})`);
});
