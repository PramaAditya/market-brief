/**
 * Persistent multi-thread chat store.
 * - Uses PostgreSQL (`pg`) when `DATABASE_URL` is configured (Neon or local Postgres).
 * - Automatically falls back to local SQLite (`data/market-brief.db` via Node 22 `node:sqlite`)
 *   when `DATABASE_URL` is not set, so local dev & Fly.io Sprite work with zero DB setup.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvKey } from "./marketData.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SPRITE_GATEWAY_LIST = "https://api.sprites.dev/v1/gateway/list";
const NEON_PROJECT_NAME = process.env.NEON_PROJECT_NAME || "market-brief";

let backend = null;

async function discoverNeonDatabaseUrl() {
  try {
    const gwResp = await fetch(SPRITE_GATEWAY_LIST, { signal: AbortSignal.timeout(3000) });
    if (!gwResp.ok) return null;
    const gwData = await gwResp.json();
    const neonConn = (gwData.connections || []).find(
      (c) => String(c.provider || "").toLowerCase() === "neon" && c.gateway_base_url
    );
    if (!neonConn) return null;

    const base = String(neonConn.gateway_base_url).replace(/\/$/, "");
    let orgId = "";
    const orgResp = await fetch(`${base}/api/v2/users/me/organizations`, {
      signal: AbortSignal.timeout(8000),
    });
    if (orgResp.ok) {
      const orgData = await orgResp.json();
      orgId = orgData?.organizations?.[0]?.id || "";
    }

    const listUrl = orgId
      ? `${base}/api/v2/projects?org_id=${encodeURIComponent(orgId)}`
      : `${base}/api/v2/projects`;
    const listResp = await fetch(listUrl, { signal: AbortSignal.timeout(8000) });
    if (!listResp.ok) {
      console.warn(`Neon connector list projects failed: HTTP ${listResp.status}`);
      return null;
    }
    const listData = await listResp.json();
    let project = (listData.projects || []).find((p) => p.name === NEON_PROJECT_NAME);

    if (!project) {
      const createResp = await fetch(`${base}/api/v2/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: orgId ? { name: NEON_PROJECT_NAME, org_id: orgId } : { name: NEON_PROJECT_NAME },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!createResp.ok) {
        const errTxt = await createResp.text().catch(() => "");
        console.warn(`Neon connector create project failed: HTTP ${createResp.status} ${errTxt.slice(0, 160)}`);
        return null;
      }
      const created = await createResp.json();
      const directUri = created?.connection_uris?.[0]?.connection_uri;
      if (directUri) return directUri;
      project = created?.project;
    }

    if (!project?.id) return null;

    const uriResp = await fetch(
      `${base}/api/v2/projects/${encodeURIComponent(project.id)}/connection_uri?database_name=neondb&role_name=neondb_owner`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!uriResp.ok) {
      console.warn(`Neon connector connection_uri failed: HTTP ${uriResp.status}`);
      return null;
    }
    const uriData = await uriResp.json();
    return uriData?.uri || null;
  } catch (err) {
    console.warn("Neon Sprites Connector discovery skipped:", err?.message || err);
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix = "") {
  return `${prefix}${crypto.randomBytes(8).toString("hex")}`;
}

async function createPostgresBackend(connectionString) {
  const { Pool } = await import("pg");
  const isLocal = /localhost|127\.0\.0\.1/i.test(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 5,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at);
  `);

  return {
    kind: "postgres",
    async listThreads(limit = 30) {
      const { rows } = await pool.query(
        `SELECT t.id, t.title, t.created_at, t.updated_at, COUNT(m.id)::int AS message_count
         FROM threads t
         LEFT JOIN messages m ON m.thread_id = t.id
         GROUP BY t.id
         ORDER BY t.updated_at DESC
         LIMIT $1`,
        [limit]
      );
      return rows;
    },
    async createThread(id, title) {
      const ts = nowIso();
      await pool.query(
        `INSERT INTO threads (id, title, created_at, updated_at) VALUES ($1, $2, $3, $3)
         ON CONFLICT (id) DO NOTHING`,
        [id, title, ts]
      );
      return { id, title, created_at: ts, updated_at: ts, message_count: 0 };
    },
    async getMessages(threadId) {
      const { rows } = await pool.query(
        `SELECT id, thread_id, role, content, created_at
         FROM messages WHERE thread_id = $1 ORDER BY created_at ASC, id ASC`,
        [threadId]
      );
      return rows;
    },
    async addMessage(threadId, role, content, maybeTitle) {
      const id = newId("msg_");
      const ts = nowIso();
      await pool.query(
        `INSERT INTO threads (id, title, created_at, updated_at) VALUES ($1, $2, $3, $3)
         ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
        [threadId, maybeTitle || "Percakapan baru", ts]
      );
      await pool.query(
        `INSERT INTO messages (id, thread_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [id, threadId, role, content, ts]
      );
      return { id, thread_id: threadId, role, content, created_at: ts };
    },
    async deleteThread(threadId) {
      await pool.query(`DELETE FROM threads WHERE id = $1`, [threadId]);
    },
  };
}

async function createSqliteBackend() {
  const { DatabaseSync } = await import("node:sqlite");
  const dataDir = path.join(REPO_ROOT, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "market-brief.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at);
  `);

  return {
    kind: "sqlite",
    async listThreads(limit = 30) {
      return db
        .prepare(
          `SELECT t.id, t.title, t.created_at, t.updated_at, COUNT(m.id) AS message_count
           FROM threads t
           LEFT JOIN messages m ON m.thread_id = t.id
           GROUP BY t.id
           ORDER BY t.updated_at DESC
           LIMIT ?`
        )
        .all(limit);
    },
    async createThread(id, title) {
      const ts = nowIso();
      db.prepare(
        `INSERT OR IGNORE INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`
      ).run(id, title, ts, ts);
      return { id, title, created_at: ts, updated_at: ts, message_count: 0 };
    },
    async getMessages(threadId) {
      return db
        .prepare(
          `SELECT id, thread_id, role, content, created_at
           FROM messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`
        )
        .all(threadId);
    },
    async addMessage(threadId, role, content, maybeTitle) {
      const id = newId("msg_");
      const ts = nowIso();
      const existing = db.prepare(`SELECT id FROM threads WHERE id = ?`).get(threadId);
      if (!existing) {
        db.prepare(`INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
          threadId,
          maybeTitle || "Percakapan baru",
          ts,
          ts
        );
      } else {
        db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(ts, threadId);
      }
      db.prepare(
        `INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(id, threadId, role, content, ts);
      return { id, thread_id: threadId, role, content, created_at: ts };
    },
    async deleteThread(threadId) {
      db.prepare(`DELETE FROM threads WHERE id = ?`).run(threadId);
    },
  };
}

export async function getDb() {
  if (backend) return backend;
  const dbUrl = readEnvKey("DATABASE_URL") || (await discoverNeonDatabaseUrl());
  if (dbUrl) {
    try {
      backend = await createPostgresBackend(dbUrl);
      console.log(
        readEnvKey("DATABASE_URL")
          ? "market-brief db: PostgreSQL (DATABASE_URL)"
          : `market-brief db: Neon PostgreSQL (Sprites Connector, project=${NEON_PROJECT_NAME})`
      );
      return backend;
    } catch (err) {
      console.warn("PostgreSQL init failed, falling back to SQLite:", err?.message || err);
    }
  }
  backend = await createSqliteBackend();
  console.log("market-brief db: local SQLite (data/market-brief.db)");
  return backend;
}
