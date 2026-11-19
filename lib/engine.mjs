import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  maskKey,
  isMaskedPlaceholder,
  resolveAiCredentials,
  cosineSimilarity,
  embedTexts,
  synthesizeConsolidation,
} from "./ai-client.mjs";

const HOME = process.env.USERPROFILE || os.homedir();
export const DEFAULT_DATA_DIR = process.env.LANXI_DATA_DIR || path.join(HOME, ".gemini", "lanxi-memory");

export const VALID_LAYERS = [
  "anchor",
  "self",
  "structural",
  "knowledge",
  "episodic",
  "goals",
  "unresolved",
];
export const PROTECTED_LAYERS = new Set(["anchor", "self", "goals"]);

export const DEFAULT_CONFIG = {
  brainName: "蓝汐",
  autoRecall: true,
  autoIngest: true,
  turnReminderInterval: 10,
  recallWindow: 6,
  recallMaxChars: 1600,
  decayModel: "power_law",
  halfLifeDays: 7.0,
  autoProtectImportance: 0.7,
  ai: {
    llmEnabled: false,
    llmBaseUrl: "https://api.openai.com/v1",
    llmModel: "gpt-4o-mini",
    llmApiKey: "",
    embeddingEnabled: false,
    embeddingBaseUrl: "https://api.openai.com/v1",
    embeddingModel: "text-embedding-3-small",
    embeddingApiKey: "",
  },
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function sanitizeId(raw) {
  const s = String(raw || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\.+$/g, "");
  if (!s || s === "." || s === "..") {
    throw new Error("无效的节点 ID");
  }
  return s.slice(0, 140);
}

export function nowSec() {
  return Date.now() / 1000;
}

export function sha256Short(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex").slice(0, 16);
}

export function tokenizeForFts(text, maxChars = 2000) {
  const input = String(text || "").slice(0, maxChars);
  const tokens = [];
  const wordRe = /[A-Za-z0-9_]+|[\u4e00-\u9fff\u3400-\u4dbf]+/g;
  let m;
  while ((m = wordRe.exec(input)) !== null) {
    const seg = m[0];
    if (/^[A-Za-z0-9_]+$/.test(seg)) {
      tokens.push(seg.toLowerCase());
    } else {
      const chars = Array.from(seg);
      for (let i = 0; i < chars.length; i++) {
        tokens.push(chars[i]);
        if (i + 1 < chars.length) {
          tokens.push(chars[i] + chars[i + 1]);
        }
      }
    }
    if (tokens.length > 1500) break;
  }
  return tokens.join(" ");
}

function buildFtsQuery(query) {
  const raw = String(query || "").trim();
  if (!raw) return "";
  const terms = [];
  const wordRe = /[A-Za-z0-9_]+|[\u4e00-\u9fff\u3400-\u4dbf]+/g;
  let m;
  while ((m = wordRe.exec(raw)) !== null) {
    const seg = m[0];
    if (/^[A-Za-z0-9_]+$/.test(seg)) {
      terms.push(`"${seg.toLowerCase()}"`);
    } else {
      const chars = Array.from(seg);
      if (chars.length === 1) {
        terms.push(`"${chars[0]}"`);
      } else {
        for (let i = 0; i + 1 < chars.length; i++) {
          terms.push(`"${chars[i] + chars[i + 1]}"`);
        }
      }
    }
    if (terms.length >= 24) break;
  }
  return terms.join(" OR ");
}

export function parseFrontmatter(raw) {
  const text = String(raw || "");
  if (!text.startsWith("---")) {
    return { meta: {}, body: text.trim() };
  }
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: text.trim() };
  }
  const fmBlock = match[1];
  const body = match[2].trim();
  const meta = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let valStr = trimmed.slice(colonIdx + 1).trim();
    if (!key) continue;
    if (valStr === "") {
      meta[key] = "";
      continue;
    }
    if (valStr === "null" || valStr === "~") {
      meta[key] = null;
      continue;
    }
    try {
      meta[key] = JSON.parse(valStr);
    } catch {
      if ((valStr.startsWith("'") && valStr.endsWith("'")) || (valStr.startsWith('"') && valStr.endsWith('"'))) {
        valStr = valStr.slice(1, -1);
      }
      meta[key] = valStr;
    }
  }
  return { meta, body };
}

function serializeFrontmatter(meta, body) {
  const orderedKeys = Object.keys(meta).filter((k) => meta[k] !== undefined);
  const lines = ["---"];
  for (const k of orderedKeys) {
    lines.push(`${k}: ${JSON.stringify(meta[k])}`);
  }
  lines.push("---", "", String(body || "").trim(), "");
  return lines.join("\n");
}

function extractTitle(meta, body, fallbackId) {
  if (meta.title && String(meta.title).trim()) return String(meta.title).trim().slice(0, 120);
  for (const l of String(body || "").split(/\r?\n/)) {
    const t = l.trim();
    if (!t) continue;
    if (t.startsWith("#")) return t.replace(/^#+\s*/, "").trim().slice(0, 120);
    return t.slice(0, 100);
  }
  return fallbackId;
}

function extractWikiLinks(body) {
  const links = [];
  const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(String(body || ""))) !== null) {
    const target = m[1].trim();
    if (target) links.push(target);
  }
  return [...new Set(links)];
}

export function computeRetention(node, config, currentTs = nowSec()) {
  if (
    node.protected ||
    Number(node.importance) >= Number(config.autoProtectImportance ?? 0.7) ||
    PROTECTED_LAYERS.has(node.layer)
  ) {
    return 1.0;
  }
  const refTs = Number(node.last_access) > 0 ? Number(node.last_access) : Number(node.created_at) || currentTs;
  const ageDays = Math.max(0, (currentTs - refTs) / 86400);
  const halfLife = Math.max(0.5, Number(config.halfLifeDays || 7.0));
  if (config.decayModel === "exponential") {
    return Math.pow(0.5, ageDays / halfLife);
  }
  return 1 / Math.pow(1 + ageDays / halfLife, 0.5);
}

export function computeReinforcement(node) {
  return 1 + 0.15 * Math.log1p(Math.max(0, Number(node.access_count || 0)));
}

function float32ToBuffer(vec) {
  const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function bufferToFloat32(buf) {
  const copy = new Uint8Array(buf).buffer;
  return new Float32Array(copy);
}

export class LanxiEngine {
  constructor(dataDir = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
    this.vaultDir = path.join(this.dataDir, "vault");
    this.configPath = path.join(this.dataDir, "config.json");
    this.dbPath = path.join(this.dataDir, "index.sqlite");
    this.ensureDirs();
    this.config = this.loadConfig();
    this.db = new DatabaseSync(this.dbPath);
    this.initDb();
  }

  ensureDirs() {
    ensureDir(this.dataDir);
    ensureDir(this.vaultDir);
    for (const sub of [...VALID_LAYERS, "archive"]) {
      ensureDir(path.join(this.vaultDir, sub));
    }
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
        return {
          ...DEFAULT_CONFIG,
          ...raw,
          ai: { ...DEFAULT_CONFIG.ai, ...(raw.ai || {}) },
        };
      }
    } catch {}
    const cfg = structuredClone(DEFAULT_CONFIG);
    this.saveConfig(cfg);
    return cfg;
  }

  getPublicConfig() {
    const cfg = this.loadConfig();
    const creds = resolveAiCredentials(cfg.ai);
    return {
      ...cfg,
      ai: {
        ...cfg.ai,
        llmApiKey: maskKey(cfg.ai?.llmApiKey),
        embeddingApiKey: maskKey(cfg.ai?.embeddingApiKey),
        hasLlmKey: Boolean(creds.llmApiKey),
        hasEmbeddingKey: Boolean(creds.embeddingApiKey),
      },
    };
  }

  saveConfig(cfg) {
    ensureDir(this.dataDir);
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    this.config = cfg;
    return cfg;
  }

  updateSettings(patch = {}) {
    const cfg = this.loadConfig();
    if (typeof patch.brainName === "string" && patch.brainName.trim()) cfg.brainName = patch.brainName.trim();
    if (typeof patch.autoRecall === "boolean") cfg.autoRecall = patch.autoRecall;
    if (typeof patch.autoIngest === "boolean") cfg.autoIngest = patch.autoIngest;
    if (typeof patch.turnReminderInterval === "number" && patch.turnReminderInterval >= 0) {
      cfg.turnReminderInterval = Math.floor(patch.turnReminderInterval);
    }
    if (typeof patch.recallWindow === "number" && patch.recallWindow >= 1 && patch.recallWindow <= 30) {
      cfg.recallWindow = Math.floor(patch.recallWindow);
    }
    if (typeof patch.recallMaxChars === "number" && patch.recallMaxChars >= 400 && patch.recallMaxChars <= 16000) {
      cfg.recallMaxChars = Math.floor(patch.recallMaxChars);
    }
    if (patch.decayModel === "power_law" || patch.decayModel === "exponential") {
      cfg.decayModel = patch.decayModel;
    }
    if (typeof patch.halfLifeDays === "number" && patch.halfLifeDays >= 0.5) {
      cfg.halfLifeDays = patch.halfLifeDays;
    }
    if (typeof patch.autoProtectImportance === "number" && patch.autoProtectImportance >= 0.1 && patch.autoProtectImportance <= 1.0) {
      cfg.autoProtectImportance = patch.autoProtectImportance;
    }
    if (patch.ai && typeof patch.ai === "object") {
      const nextAi = { ...DEFAULT_CONFIG.ai, ...(cfg.ai || {}) };
      if (typeof patch.ai.llmEnabled === "boolean") nextAi.llmEnabled = patch.ai.llmEnabled;
      if (typeof patch.ai.llmBaseUrl === "string" && patch.ai.llmBaseUrl.trim()) {
        nextAi.llmBaseUrl = patch.ai.llmBaseUrl.trim();
      }
      if (typeof patch.ai.llmModel === "string" && patch.ai.llmModel.trim()) {
        nextAi.llmModel = patch.ai.llmModel.trim();
      }
      if (patch.ai.clearLlmKey) {
        nextAi.llmApiKey = "";
      } else if (typeof patch.ai.llmApiKey === "string" && patch.ai.llmApiKey.trim() && !isMaskedPlaceholder(patch.ai.llmApiKey)) {
        nextAi.llmApiKey = patch.ai.llmApiKey.trim();
      }

      if (typeof patch.ai.embeddingEnabled === "boolean") nextAi.embeddingEnabled = patch.ai.embeddingEnabled;
      if (typeof patch.ai.embeddingBaseUrl === "string" && patch.ai.embeddingBaseUrl.trim()) {
        nextAi.embeddingBaseUrl = patch.ai.embeddingBaseUrl.trim();
      }
      if (typeof patch.ai.embeddingModel === "string" && patch.ai.embeddingModel.trim()) {
        nextAi.embeddingModel = patch.ai.embeddingModel.trim();
      }
      if (patch.ai.clearEmbeddingKey) {
        nextAi.embeddingApiKey = "";
      } else if (
        typeof patch.ai.embeddingApiKey === "string" &&
        patch.ai.embeddingApiKey.trim() &&
        !isMaskedPlaceholder(patch.ai.embeddingApiKey)
      ) {
        nextAi.embeddingApiKey = patch.ai.embeddingApiKey.trim();
      }
      cfg.ai = nextAi;
    }
    this.saveConfig(cfg);
    return this.getPublicConfig();
  }

  initDb() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        layer TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        aliases_json TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.5,
        protected INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 0.6,
        lifecycle_state TEXT NOT NULL DEFAULT 'active',
        verification_state TEXT NOT NULL DEFAULT 'unverified',
        access_count INTEGER NOT NULL DEFAULT 0,
        last_access REAL NOT NULL DEFAULT 0,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        valid_from REAL,
        valid_until REAL,
        session_id TEXT,
        role TEXT,
        source TEXT,
        file_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        extra_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_layer_state ON nodes(layer, lifecycle_state);
      CREATE INDEX IF NOT EXISTS idx_nodes_created ON nodes(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_nodes_hash ON nodes(content_hash);

      CREATE TABLE IF NOT EXISTS edges (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'related_to',
        weight REAL NOT NULL DEFAULT 1.0,
        created_at REAL NOT NULL,
        PRIMARY KEY (source_id, target_id, relation)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        id UNINDEXED,
        search_text
      );

      CREATE TABLE IF NOT EXISTS node_embeddings (
        id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vec_blob BLOB NOT NULL,
        updated_at REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts REAL NOT NULL,
        action TEXT NOT NULL,
        target_id TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS session_turns (
        conversation_id TEXT PRIMARY KEY,
        turn_count INTEGER NOT NULL DEFAULT 0,
        last_user_hash TEXT,
        last_ingested_hash TEXT,
        updated_at REAL NOT NULL
      );
    `);

    this.stmtUpsertNode = this.db.prepare(`
      INSERT INTO nodes (
        id, layer, title, body, tags_json, aliases_json, importance, protected, confidence,
        lifecycle_state, verification_state, access_count, last_access, created_at, updated_at,
        valid_from, valid_until, session_id, role, source, file_path, content_hash, extra_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        layer = excluded.layer,
        title = excluded.title,
        body = excluded.body,
        tags_json = excluded.tags_json,
        aliases_json = excluded.aliases_json,
        importance = excluded.importance,
        protected = excluded.protected,
        confidence = excluded.confidence,
        lifecycle_state = excluded.lifecycle_state,
        verification_state = excluded.verification_state,
        access_count = excluded.access_count,
        last_access = excluded.last_access,
        updated_at = excluded.updated_at,
        valid_from = excluded.valid_from,
        valid_until = excluded.valid_until,
        session_id = excluded.session_id,
        role = excluded.role,
        source = excluded.source,
        file_path = excluded.file_path,
        content_hash = excluded.content_hash,
        extra_json = excluded.extra_json
    `);

    this.stmtDeleteFts = this.db.prepare("DELETE FROM nodes_fts WHERE id = ?");
    this.stmtInsertFts = this.db.prepare("INSERT INTO nodes_fts (id, search_text) VALUES (?, ?)");
    this.stmtUpsertEdge = this.db.prepare(`
      INSERT INTO edges (source_id, target_id, relation, weight, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id, target_id, relation) DO UPDATE SET weight = excluded.weight
    `);
    this.stmtUpsertEmbedding = this.db.prepare(`
      INSERT INTO node_embeddings (id, model, dims, vec_blob, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        model = excluded.model,
        dims = excluded.dims,
        vec_blob = excluded.vec_blob,
        updated_at = excluded.updated_at
    `);
    this.stmtAudit = this.db.prepare("INSERT INTO audit_log (ts, action, target_id, detail_json) VALUES (?, ?, ?, ?)");
  }

  close() {
    try {
      this.db?.close();
    } catch {}
  }

  logAudit(action, targetId, detail = {}) {
    this.stmtAudit.run(nowSec(), action, targetId || null, JSON.stringify(detail));
  }

  upsertFtsForNode(node) {
    const tags = safeJsonParse(node.tags_json, []).join(" ");
    const aliases = safeJsonParse(node.aliases_json, []).join(" ");
    const rawText = `${node.title}\n${tags}\n${aliases}\n${node.body}`;
    const tokenized = tokenizeForFts(rawText);
    this.stmtDeleteFts.run(node.id);
    if (tokenized) {
      this.stmtInsertFts.run(node.id, tokenized);
    }
  }

  nodeFilePath(layer, id) {
    const safeLayer = layer === "archive" || VALID_LAYERS.includes(layer) ? layer : "knowledge";
    return path.join(this.vaultDir, safeLayer, `${sanitizeId(id)}.md`);
  }

  persistNodeToDisk(node, extraEdges = []) {
    const targetDir = node.lifecycle_state === "archived" ? "archive" : node.layer;
    const filePath = this.nodeFilePath(targetDir, node.id);
    ensureDir(path.dirname(filePath));
    const extra = safeJsonParse(node.extra_json, {});
    const meta = {
      id: node.id,
      layer: node.layer,
      title: node.title,
      tags: safeJsonParse(node.tags_json, []),
      aliases: safeJsonParse(node.aliases_json, []),
      importance: Number(node.importance),
      protected: Boolean(node.protected),
      confidence: Number(node.confidence),
      lifecycle_state: node.lifecycle_state,
      verification_state: node.verification_state,
      access_count: Number(node.access_count),
      last_access: Number(node.last_access),
      created_at: Number(node.created_at),
      updated_at: Number(node.updated_at),
      valid_from: node.valid_from ?? null,
      valid_until: node.valid_until ?? null,
      session: node.session_id || null,
      role: node.role || "assistant",
      source: node.source || "lanxi-memory",
      edges: extraEdges,
      ...extra,
    };
    fs.writeFileSync(filePath, serializeFrontmatter(meta, node.body), "utf8");
    return filePath;
  }

  formatNodeSummary(row, currentTs = nowSec()) {
    const retention = computeRetention(row, this.config, currentTs);
    return {
      id: row.id,
      layer: row.layer,
      title: row.title,
      preview: String(row.body || "").replace(/\s+/g, " ").trim().slice(0, 180),
      tags: safeJsonParse(row.tags_json, []),
      aliases: safeJsonParse(row.aliases_json, []),
      importance: Number(row.importance),
      protected: Boolean(row.protected),
      confidence: Number(row.confidence),
      lifecycle_state: row.lifecycle_state,
      verification_state: row.verification_state,
      access_count: Number(row.access_count),
      last_access: Number(row.last_access),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      valid_from: row.valid_from,
      valid_until: row.valid_until,
      session_id: row.session_id,
      role: row.role,
      source: row.source,
      retention: Number(retention.toFixed(4)),
      extra: safeJsonParse(row.extra_json, {}),
    };
  }

  writeMemory(opts = {}) {
    const layer = VALID_LAYERS.includes(opts.layer) ? opts.layer : "knowledge";
    const body = String(opts.content ?? opts.body ?? "").trim();
    if (!body) throw new Error("记忆正文不能为空");

    const ts = nowSec();
    const contentHash = sha256Short(`${layer}\n${body}`);

    const existing = this.db
      .prepare("SELECT * FROM nodes WHERE layer = ? AND content_hash = ? AND lifecycle_state = 'active' LIMIT 1")
      .get(layer, contentHash);
    if (existing) {
      this.db.prepare("UPDATE nodes SET access_count = access_count + 1, last_access = ? WHERE id = ?").run(ts, existing.id);
      return {
        committed: true,
        deduplicated: true,
        id: existing.id,
        layer: existing.layer,
        protected: Boolean(existing.protected),
        filePath: existing.file_path,
      };
    }

    const prefix = layer === "goals" ? "goal" : layer === "unresolved" ? "unr" : "mem";
    const rawId = opts.id ? sanitizeId(opts.id) : `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    let id = rawId;
    if (this.db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(id)) {
      id = `${rawId}_${crypto.randomBytes(2).toString("hex")}`;
    }

    const importance = clampNum(opts.importance ?? (PROTECTED_LAYERS.has(layer) ? 0.85 : 0.5), 0, 1);
    const isProtected =
      Boolean(opts.protected) ||
      importance >= Number(this.config.autoProtectImportance ?? 0.7) ||
      PROTECTED_LAYERS.has(layer);

    const tags = Array.isArray(opts.tags) ? opts.tags.map(String) : [];
    const aliases = Array.isArray(opts.aliases) ? opts.aliases.map(String) : [];
    const title = extractTitle({ title: opts.title }, body, id);
    const extra = opts.extra && typeof opts.extra === "object" ? opts.extra : {};

    const node = {
      id,
      layer,
      title,
      body,
      tags_json: JSON.stringify(tags),
      aliases_json: JSON.stringify(aliases),
      importance,
      protected: isProtected ? 1 : 0,
      confidence: clampNum(opts.confidence ?? 0.75, 0, 1),
      lifecycle_state: "active",
      verification_state: opts.verification_state || (isProtected ? "verified" : "unverified"),
      access_count: 0,
      last_access: ts,
      created_at: Number(opts.created_at) || ts,
      updated_at: ts,
      valid_from: opts.valid_from ?? null,
      valid_until: opts.valid_until ?? null,
      session_id: opts.session_id || null,
      role: opts.role || "assistant",
      source: opts.source || "lanxi-memory",
      file_path: "",
      content_hash: contentHash,
      extra_json: JSON.stringify(extra),
    };

    const edgeObjs = [];
    for (const wl of extractWikiLinks(body)) {
      edgeObjs.push({ target: wl, relation: "wiki_link", weight: 0.9 });
    }
    if (Array.isArray(opts.edges)) {
      for (const e of opts.edges) {
        if (e && e.target) edgeObjs.push({ target: String(e.target), relation: e.relation || "related_to", weight: e.weight ?? 1.0 });
      }
    }

    node.file_path = this.persistNodeToDisk(node, edgeObjs);
    this.stmtUpsertNode.run(
      node.id, node.layer, node.title, node.body, node.tags_json, node.aliases_json,
      node.importance, node.protected, node.confidence, node.lifecycle_state,
      node.verification_state, node.access_count, node.last_access,
      node.created_at, node.updated_at, node.valid_from, node.valid_until,
      node.session_id, node.role, node.source, node.file_path, node.content_hash, node.extra_json
    );
    this.upsertFtsForNode(node);

    for (const e of edgeObjs) {
      this.stmtUpsertEdge.run(node.id, e.target, e.relation, e.weight ?? 1.0, ts);
    }
    this.logAudit("write", node.id, { layer: node.layer, importance: node.importance, protected: isProtected });

    return {
      committed: true,
      deduplicated: false,
      id: node.id,
      layer: node.layer,
      title: node.title,
      protected: isProtected,
      filePath: node.file_path,
    };
  }

  recall({ query = "", layers = null, limit = 8, includeExpired = false, touch = true } = {}) {
    const ts = nowSec();
    const maxLimit = Math.max(1, Math.min(50, Number(limit) || 8));
    const layerList = Array.isArray(layers) && layers.length > 0
      ? layers.filter((l) => VALID_LAYERS.includes(l))
      : null;

    const ftsQuery = buildFtsQuery(query);
    let candidates = [];

    if (ftsQuery) {
      let sql = `
        SELECT n.*, (-bm25(nodes_fts)) AS fts_score
        FROM nodes_fts f
        JOIN nodes n ON n.id = f.id
        WHERE nodes_fts MATCH ?
          AND n.lifecycle_state = 'active'
      `;
      const args = [ftsQuery];
      if (!includeExpired) {
        sql += " AND (n.valid_until IS NULL OR n.valid_until > ?)";
        args.push(ts);
      }
      if (layerList) {
        sql += ` AND n.layer IN (${layerList.map(() => "?").join(",")})`;
        args.push(...layerList);
      }
      sql += " LIMIT ?";
      args.push(maxLimit * 6);
      try {
        candidates = this.db.prepare(sql).all(...args);
      } catch {
        candidates = [];
      }
    }

    if (candidates.length === 0) {
      let sql = `
        SELECT n.*, 1.0 AS fts_score
        FROM nodes n
        WHERE n.lifecycle_state = 'active'
      `;
      const args = [];
      if (!includeExpired) {
        sql += " AND (n.valid_until IS NULL OR n.valid_until > ?)";
        args.push(ts);
      }
      if (layerList) {
        sql += ` AND n.layer IN (${layerList.map(() => "?").join(",")})`;
        args.push(...layerList);
      }
      if (query && String(query).trim()) {
        const likePattern = `%${String(query).trim()}%`;
        sql += " AND (n.title LIKE ? OR n.body LIKE ? OR n.tags_json LIKE ?)";
        args.push(likePattern, likePattern, likePattern);
      }
      sql += " ORDER BY n.importance DESC, n.created_at DESC LIMIT ?";
      args.push(maxLimit * 4);
      candidates = this.db.prepare(sql).all(...args);
    }

    const scored = candidates.map((row) => {
      const ftsNorm = Math.max(0.1, Number(row.fts_score || 1));
      const retention = computeRetention(row, this.config, ts);
      const reinforcement = computeReinforcement(row);
      const impWeight = 0.4 + 0.6 * Number(row.importance || 0.5);
      const score = ftsNorm * impWeight * retention * reinforcement;
      return {
        ...this.formatNodeSummary(row, ts),
        body: row.body,
        score: Number(score.toFixed(4)),
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, maxLimit);

    if (touch && results.length > 0) {
      const stmtTouch = this.db.prepare(
        "UPDATE nodes SET access_count = access_count + 1, last_access = ? WHERE id = ?"
      );
      for (const item of results) stmtTouch.run(ts, item.id);
    }
    return results;
  }

  async recallHybrid({ query = "", layers = null, limit = 8, includeExpired = false, touch = true } = {}) {
    const maxLimit = Math.max(1, Math.min(50, Number(limit) || 8));
    const ftsResults = this.recall({ query, layers, limit: maxLimit * 2, includeExpired, touch: false });

    const cfg = this.loadConfig();
    const creds = resolveAiCredentials(cfg.ai);
    const q = String(query || "").trim();
    if (!creds.embeddingEnabled || !creds.embeddingApiKey || !q) {
      const finalOut = ftsResults.slice(0, maxLimit);
      if (touch && finalOut.length > 0) {
        const ts = nowSec();
        const stmtTouch = this.db.prepare("UPDATE nodes SET access_count = access_count + 1, last_access = ? WHERE id = ?");
        for (const item of finalOut) stmtTouch.run(ts, item.id);
      }
      return finalOut;
    }

    try {
      const embRows = this.db
        .prepare(`
          SELECT e.id, e.vec_blob, n.*
          FROM node_embeddings e
          JOIN nodes n ON n.id = e.id
          WHERE e.model = ? AND n.lifecycle_state = 'active'
        `)
        .all(creds.embeddingModel);

      if (embRows.length === 0) {
        return this.recall({ query, layers, limit: maxLimit, includeExpired, touch });
      }

      const [qVec] = await embedTexts([q], cfg.ai, { timeoutMs: 8000 });
      const ts = nowSec();
      const layerSet = Array.isArray(layers) && layers.length > 0 ? new Set(layers) : null;
      const candidateMap = new Map();

      const maxFts = ftsResults.reduce((acc, r) => Math.max(acc, r.score || 0), 0.001);
      for (const r of ftsResults) {
        candidateMap.set(r.id, {
          item: r,
          ftsNorm: (r.score || 0) / maxFts,
          semSim: 0,
        });
      }

      for (const row of embRows) {
        if (layerSet && !layerSet.has(row.layer)) continue;
        if (!includeExpired && row.valid_until && row.valid_until <= ts) continue;
        const vec = bufferToFloat32(row.vec_blob);
        const sim = Math.max(0, cosineSimilarity(qVec, vec));
        if (sim < 0.25 && !candidateMap.has(row.id)) continue;

        const existing = candidateMap.get(row.id);
        if (existing) {
          existing.semSim = sim;
        } else {
          candidateMap.set(row.id, {
            item: { ...this.formatNodeSummary(row, ts), body: row.body, score: 0 },
            ftsNorm: 0,
            semSim: sim,
          });
        }
      }

      const fused = [];
      for (const entry of candidateMap.values()) {
        const ret = entry.item.retention;
        const impW = 0.5 + 0.5 * Number(entry.item.importance || 0.5);
        const hybridScore = (0.45 * entry.ftsNorm + 0.55 * entry.semSim) * impW * (0.5 + 0.5 * ret);
        fused.push({
          ...entry.item,
          semanticScore: Number(entry.semSim.toFixed(4)),
          score: Number(hybridScore.toFixed(4)),
        });
      }
      fused.sort((a, b) => b.score - a.score);
      const finalOut = fused.slice(0, maxLimit);

      if (touch && finalOut.length > 0) {
        const stmtTouch = this.db.prepare("UPDATE nodes SET access_count = access_count + 1, last_access = ? WHERE id = ?");
        for (const item of finalOut) stmtTouch.run(ts, item.id);
      }
      return finalOut;
    } catch {
      return this.recall({ query, layers, limit: maxLimit, includeExpired, touch });
    }
  }

  async backfillEmbeddings(limit = 50) {
    const cfg = this.loadConfig();
    const creds = resolveAiCredentials(cfg.ai);
    if (!creds.embeddingApiKey) {
      throw new Error("未配置 Embedding API Key，无法生成向量索引");
    }
    const maxNodes = Math.max(1, Math.min(200, Number(limit) || 50));
    const missing = this.db
      .prepare(`
        SELECT n.id, n.title, n.body, n.tags_json
        FROM nodes n
        LEFT JOIN node_embeddings e ON e.id = n.id AND e.model = ?
        WHERE n.lifecycle_state = 'active' AND e.id IS NULL
        ORDER BY n.importance DESC, n.created_at DESC
        LIMIT ?
      `)
      .all(creds.embeddingModel, maxNodes);

    let embedded = 0;
    const batchSize = 16;
    const ts = nowSec();

    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize);
      const texts = batch.map((n) => `${n.title}\n${safeJsonParse(n.tags_json, []).join(" ")}\n${n.body}`);
      const vecs = await embedTexts(texts, cfg.ai, { timeoutMs: 15000 });
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (let j = 0; j < batch.length; j++) {
          const v = vecs[j];
          if (!v || v.length === 0) continue;
          this.stmtUpsertEmbedding.run(batch[j].id, creds.embeddingModel, v.length, float32ToBuffer(v), ts);
          embedded++;
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }

    const totalRemaining = Number(
      this.db
        .prepare(`
          SELECT COUNT(*) AS cnt FROM nodes n
          LEFT JOIN node_embeddings e ON e.id = n.id AND e.model = ?
          WHERE n.lifecycle_state = 'active' AND e.id IS NULL
        `)
        .get(creds.embeddingModel)?.cnt || 0
    );

    return { embedded, remaining: totalRemaining, model: creds.embeddingModel };
  }

  async aiConsolidateCluster({ sourceIds = [], commit = false, targetLayer = null, archiveSources = false } = {}) {
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
      throw new Error("请提供至少一个待凝结节点 ID");
    }
    const nodes = [];
    for (const sid of sourceIds.slice(0, 20)) {
      const n = this.readMemory(sid);
      if (n) nodes.push(n);
    }
    if (nodes.length === 0) {
      throw new Error("未找到有效的源记忆节点");
    }
    const cfg = this.loadConfig();
    const draft = await synthesizeConsolidation(nodes, cfg.ai);
    const chosenLayer = targetLayer || draft.targetLayer;

    if (!commit) {
      return { committed: false, preview: { ...draft, targetLayer: chosenLayer, sourceIds: nodes.map((n) => n.id) } };
    }

    const created = this.consolidateCluster({
      sourceIds: nodes.map((n) => n.id),
      title: draft.title,
      summary: draft.summary,
      tags: draft.tags,
      targetLayer: chosenLayer,
      archiveSources,
    });
    return { committed: true, node: created, preview: draft };
  }

  readMemory(id) {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(String(id || ""));
    if (!row) return null;
    const outgoing = this.db.prepare("SELECT target_id, relation, weight, created_at FROM edges WHERE source_id = ?").all(row.id);
    const incoming = this.db.prepare("SELECT source_id, relation, weight, created_at FROM edges WHERE target_id = ?").all(row.id);
    return {
      ...this.formatNodeSummary(row),
      body: row.body,
      file_path: row.file_path,
      outgoing,
      incoming,
    };
  }

  updateMemory(id, patch = {}) {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(String(id || ""));
    if (!row) throw new Error(`未找到记忆节点: ${id}`);

    const override = Boolean(patch.override);
    const wasProtected = Boolean(row.protected);
    const nextImportance = patch.importance !== undefined ? clampNum(patch.importance, 0, 1) : Number(row.importance);
    let nextProtected = patch.protected !== undefined ? Boolean(patch.protected) : wasProtected;

    if (nextImportance >= Number(this.config.autoProtectImportance ?? 0.7) && patch.protected !== false) {
      nextProtected = true;
    }
    if (wasProtected && !override) {
      if (patch.protected === false || nextImportance < Number(this.config.autoProtectImportance ?? 0.7)) {
        throw new Error("该记忆受硬保护（importance >= 0.7 或 protected=true），降级/解除保护需要 override=true");
      }
    }

    const nextLayer = patch.layer && VALID_LAYERS.includes(patch.layer) ? patch.layer : row.layer;
    const nextBody = patch.content !== undefined ? String(patch.content).trim() : (patch.body !== undefined ? String(patch.body).trim() : row.body);
    const nextTitle = patch.title !== undefined ? String(patch.title).trim() : extractTitle({ title: patch.title }, nextBody, row.id);
    const nextTags = Array.isArray(patch.tags) ? JSON.stringify(patch.tags.map(String)) : row.tags_json;
    const nextValidUntil = patch.valid_until !== undefined ? patch.valid_until : row.valid_until;
    const nextExtra = patch.extra && typeof patch.extra === "object"
      ? JSON.stringify({ ...safeJsonParse(row.extra_json, {}), ...patch.extra })
      : row.extra_json;

    const ts = nowSec();
    const updated = {
      ...row,
      layer: nextLayer,
      title: nextTitle,
      body: nextBody,
      tags_json: nextTags,
      importance: nextImportance,
      protected: nextProtected ? 1 : 0,
      valid_until: nextValidUntil,
      updated_at: ts,
      content_hash: sha256Short(`${nextLayer}\n${nextBody}`),
      extra_json: nextExtra,
    };

    if (nextLayer !== row.layer && row.file_path && fs.existsSync(row.file_path)) {
      try { fs.unlinkSync(row.file_path); } catch {}
    }

    const edges = this.db.prepare("SELECT target_id AS target, relation, weight FROM edges WHERE source_id = ?").all(row.id);
    updated.file_path = this.persistNodeToDisk(updated, edges);

    this.stmtUpsertNode.run(
      updated.id, updated.layer, updated.title, updated.body, updated.tags_json, updated.aliases_json,
      updated.importance, updated.protected, updated.confidence, updated.lifecycle_state,
      updated.verification_state, updated.access_count, updated.last_access,
      updated.created_at, updated.updated_at, updated.valid_from, updated.valid_until,
      updated.session_id, updated.role, updated.source, updated.file_path, updated.content_hash, updated.extra_json
    );
    this.upsertFtsForNode(updated);
    this.logAudit("update", updated.id, { layer: updated.layer, importance: updated.importance });
    return this.readMemory(updated.id);
  }

  forgetMemory(id, { reason = "", override = false } = {}) {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(String(id || ""));
    if (!row) throw new Error(`未找到记忆节点: ${id}`);

    if (
      (Boolean(row.protected) || Number(row.importance) >= Number(this.config.autoProtectImportance ?? 0.7)) &&
      !override
    ) {
      throw new Error(`节点 ${id} 受硬保护（importance=${row.importance}），必须传 override=true 才能归档/遗忘`);
    }

    const ts = nowSec();
    const updated = {
      ...row,
      lifecycle_state: "archived",
      updated_at: ts,
      extra_json: JSON.stringify({ ...safeJsonParse(row.extra_json, {}), archive_reason: reason, archived_at: ts }),
    };

    if (row.file_path && fs.existsSync(row.file_path)) {
      try { fs.unlinkSync(row.file_path); } catch {}
    }

    const edges = this.db.prepare("SELECT target_id AS target, relation, weight FROM edges WHERE source_id = ?").all(row.id);
    updated.file_path = this.persistNodeToDisk(updated, edges);

    this.db
      .prepare("UPDATE nodes SET lifecycle_state = 'archived', updated_at = ?, file_path = ?, extra_json = ? WHERE id = ?")
      .run(ts, updated.file_path, updated.extra_json, row.id);
    this.stmtDeleteFts.run(row.id);
    this.logAudit("forget", row.id, { reason, override });

    return { archived: true, id: row.id, archivePath: updated.file_path };
  }

  linkMemories(sourceId, targetId, relation = "related_to", weight = 1.0) {
    const src = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(String(sourceId || ""));
    if (!src) throw new Error(`源节点不存在: ${sourceId}`);
    const dst = this.db.prepare("SELECT id FROM nodes WHERE id = ?").get(String(targetId || ""));
    if (!dst) throw new Error(`目标节点不存在: ${targetId}`);

    const ts = nowSec();
    this.stmtUpsertEdge.run(src.id, dst.id, String(relation || "related_to"), clampNum(weight, 0, 10), ts);
    const edges = this.db.prepare("SELECT target_id AS target, relation, weight FROM edges WHERE source_id = ?").all(src.id);
    this.persistNodeToDisk(src, edges);
    this.logAudit("link", src.id, { targetId: dst.id, relation });
    return { linked: true, sourceId: src.id, targetId: dst.id, relation };
  }

  getGraph({ centerId = null, limit = 80, layers = null } = {}) {
    const maxNodes = Math.max(10, Math.min(200, Number(limit) || 80));
    let nodes = [];
    let edges = [];

    if (centerId) {
      const center = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(String(centerId));
      if (center) {
        const directEdges = this.db
          .prepare("SELECT * FROM edges WHERE source_id = ? OR target_id = ? LIMIT 150")
          .all(center.id, center.id);
        const ids = new Set([center.id]);
        for (const e of directEdges) {
          ids.add(e.source_id);
          ids.add(e.target_id);
        }
        const idArr = [...ids].slice(0, maxNodes);
        const placeholders = idArr.map(() => "?").join(",");
        nodes = this.db.prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`).all(...idArr);
        edges = directEdges.filter((e) => ids.has(e.source_id) && ids.has(e.target_id));
      }
    }

    if (nodes.length === 0) {
      const layerList = Array.isArray(layers) && layers.length > 0 ? layers.filter((l) => VALID_LAYERS.includes(l)) : null;
      let sql = `
        SELECT n.*,
          (SELECT COUNT(*) FROM edges e WHERE e.source_id = n.id OR e.target_id = n.id) AS deg
        FROM nodes n
        WHERE n.lifecycle_state = 'active'
      `;
      const args = [];
      if (layerList) {
        sql += ` AND n.layer IN (${layerList.map(() => "?").join(",")})`;
        args.push(...layerList);
      }
      sql += " ORDER BY deg DESC, n.importance DESC, n.created_at DESC LIMIT ?";
      args.push(maxNodes);
      nodes = this.db.prepare(sql).all(...args);

      const idSet = new Set(nodes.map((n) => n.id));
      if (idSet.size > 0) {
        const allEdges = this.db.prepare("SELECT * FROM edges LIMIT 2000").all();
        edges = allEdges.filter((e) => idSet.has(e.source_id) && idSet.has(e.target_id));
      }
    }

    return {
      nodes: nodes.map((n) => this.formatNodeSummary(n)),
      edges,
    };
  }

  listGoals() {
    const rows = this.db
      .prepare("SELECT * FROM nodes WHERE layer = 'goals' AND lifecycle_state = 'active' ORDER BY importance DESC, created_at DESC")
      .all();
    return rows.map((r) => this.formatNodeSummary(r));
  }

  upsertGoal({ id = null, title, content = "", status = "active", priority = "medium", progress = 0, deadline = null } = {}) {
    if (id) {
      const existing = this.db.prepare("SELECT * FROM nodes WHERE id = ? AND layer = 'goals'").get(id);
      if (existing) {
        return this.updateMemory(id, {
          title: title ?? existing.title,
          content: content || existing.body,
          extra: { status, priority, progress: clampNum(progress, 0, 100), deadline },
        });
      }
    }
    if (!title && !content) throw new Error("目标标题或内容不能为空");
    const imp = priority === "high" ? 0.9 : priority === "low" ? 0.7 : 0.8;
    const res = this.writeMemory({
      id,
      layer: "goals",
      title: title || content.slice(0, 60),
      content: content || title,
      importance: imp,
      protected: true,
      tags: ["goal", status],
      extra: { status, priority, progress: clampNum(progress, 0, 100), deadline },
    });
    return this.readMemory(res.id);
  }

  reflect({ title, content, layer = "self", basedOnIds = [], importance = 0.75, tags = [] } = {}) {
    const targetLayer = layer === "unresolved" ? "unresolved" : "self";
    const res = this.writeMemory({
      layer: targetLayer,
      title,
      content,
      importance,
      tags: [...new Set(["reflection", ...tags])],
      edges: (basedOnIds || []).map((bid) => ({ target: bid, relation: "derived_from", weight: 1.0 })),
    });
    for (const bid of basedOnIds || []) {
      if (this.db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(bid)) {
        this.stmtUpsertEdge.run(res.id, bid, "derived_from", 1.0, nowSec());
      }
    }
    return this.readMemory(res.id);
  }

  getMaintenanceQueue() {
    const ts = nowSec();
    const episodicRows = this.db
      .prepare("SELECT * FROM nodes WHERE layer = 'episodic' AND lifecycle_state = 'active' ORDER BY created_at DESC LIMIT 600")
      .all();

    const toPromote = [];
    const decaying = [];
    for (const r of episodicRows) {
      const retention = computeRetention(r, this.config, ts);
      if (Number(r.access_count) >= 3 || (Number(r.importance) >= 0.55 && !r.protected)) {
        if (toPromote.length < 30) {
          toPromote.push({ ...this.formatNodeSummary(r, ts), retention: Number(retention.toFixed(4)) });
        }
      } else if (!r.protected && retention < 0.55) {
        if (decaying.length < 30) {
          decaying.push({ ...this.formatNodeSummary(r, ts), retention: Number(retention.toFixed(4)) });
        }
      }
    }

    const unresolvedRows = this.db
      .prepare("SELECT * FROM nodes WHERE layer = 'unresolved' AND lifecycle_state = 'active' ORDER BY created_at DESC LIMIT 50")
      .all();
    const unresolved = unresolvedRows.map((r) => this.formatNodeSummary(r, ts));

    return {
      toPromote,
      decaying,
      unresolved,
      totalCount: toPromote.length + decaying.length + unresolved.length,
    };
  }

  promoteMemory(id, targetLayer = "knowledge") {
    const safeTarget = ["knowledge", "structural", "self", "anchor"].includes(targetLayer) ? targetLayer : "knowledge";
    const current = this.readMemory(id);
    if (!current) throw new Error(`未找到节点: ${id}`);
    const updated = this.updateMemory(id, {
      layer: safeTarget,
      importance: Math.max(0.7, Number(current.importance || 0.7)),
      protected: true,
    });
    this.logAudit("promote", id, { targetLayer: safeTarget });
    return updated;
  }

  touchMemory(id) {
    const ts = nowSec();
    const info = this.db.prepare("UPDATE nodes SET access_count = access_count + 1, last_access = ? WHERE id = ?").run(ts, id);
    if (info.changes === 0) throw new Error(`节点不存在: ${id}`);
    return this.readMemory(id);
  }

  consolidateCluster({ sourceIds = [], title, summary, tags = [], targetLayer = "knowledge", archiveSources = false } = {}) {
    if (!summary || !String(summary).trim()) throw new Error("凝结摘要不能为空");
    const created = this.writeMemory({
      layer: VALID_LAYERS.includes(targetLayer) ? targetLayer : "knowledge",
      title: title || summary.slice(0, 60),
      content: summary,
      importance: 0.75,
      protected: true,
      tags: [...new Set(["consolidated", ...(tags || [])])],
      edges: (sourceIds || []).map((sid) => ({ target: sid, relation: "derived_from", weight: 1.0 })),
    });

    if (archiveSources) {
      for (const sid of sourceIds || []) {
        try {
          this.forgetMemory(sid, { reason: `consolidated_into:${created.id}`, override: false });
        } catch {}
      }
    }
    return this.readMemory(created.id);
  }

  listMemories({ layer = null, query = "", lifecycle = "active", sort = "recent", limit = 50, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);

    if (query && query.trim()) {
      const layers = layer && VALID_LAYERS.includes(layer) ? [layer] : null;
      const items = this.recall({ query: query.trim(), layers, limit: lim, touch: false });
      return { total: items.length, items };
    }

    let where = "WHERE lifecycle_state = ?";
    const args = [lifecycle];
    if (layer && VALID_LAYERS.includes(layer)) {
      where += " AND layer = ?";
      args.push(layer);
    }

    const orderMap = {
      recent: "ORDER BY created_at DESC",
      access: "ORDER BY access_count DESC, created_at DESC",
      importance: "ORDER BY importance DESC, created_at DESC",
    };
    const orderSql = orderMap[sort] || orderMap.recent;

    const countRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM nodes ${where}`).get(...args);
    const rows = this.db
      .prepare(`SELECT * FROM nodes ${where} ${orderSql} LIMIT ? OFFSET ?`)
      .all(...args, lim, off);
    let items = rows.map((r) => this.formatNodeSummary(r));
    if (sort === "retention_asc") {
      items.sort((a, b) => a.retention - b.retention);
    }
    return { total: Number(countRow?.cnt || 0), items };
  }

  getOverview() {
    const layerRows = this.db
      .prepare("SELECT layer, COUNT(*) AS cnt FROM nodes WHERE lifecycle_state = 'active' GROUP BY layer")
      .all();
    const byLayer = {};
    let totalNodes = 0;
    for (const r of layerRows) {
      byLayer[r.layer] = Number(r.cnt);
      totalNodes += Number(r.cnt);
    }
    const protectedCount = Number(
      this.db.prepare("SELECT COUNT(*) AS cnt FROM nodes WHERE lifecycle_state = 'active' AND protected = 1").get()?.cnt || 0
    );
    const edgesCount = Number(this.db.prepare("SELECT COUNT(*) AS cnt FROM edges").get()?.cnt || 0);
    const embeddedCount = Number(this.db.prepare("SELECT COUNT(*) AS cnt FROM node_embeddings").get()?.cnt || 0);

    const anchorCount = (byLayer.anchor || 0) + (byLayer.self || 0) + (byLayer.goals || 0);
    const unresolvedCount = byLayer.unresolved || 0;
    const maint = this.getMaintenanceQueue();
    const fadingCount = maint.decaying.length;
    const risingCount = Math.max(0, totalNodes - anchorCount - unresolvedCount - fadingCount);

    const recentRows = this.db
      .prepare("SELECT * FROM nodes WHERE lifecycle_state = 'active' ORDER BY created_at DESC LIMIT 8")
      .all();

    return {
      totalNodes,
      activeGoals: Number(byLayer.goals || 0),
      episodicCount: Number(byLayer.episodic || 0),
      maintenanceCount: maint.totalCount,
      protectedCount,
      edgesCount,
      embeddedCount,
      tideBreakdown: {
        anchor: anchorCount,
        rising: risingCount,
        fading: fadingCount,
        unresolved: unresolvedCount,
      },
      byLayer,
      recentMemories: recentRows.map((r) => this.formatNodeSummary(r)),
      config: this.getPublicConfig(),
      vaultPath: this.vaultDir,
      dataDir: this.dataDir,
    };
  }

  rebuildIndex() {
    const start = Date.now();
    this.db.exec("DELETE FROM nodes; DELETE FROM edges; DELETE FROM nodes_fts;");

    let indexed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const dirName of [...VALID_LAYERS, "archive"]) {
        const fullDir = path.join(this.vaultDir, dirName);
        if (!fs.existsSync(fullDir)) continue;
        for (const f of fs.readdirSync(fullDir).filter((x) => x.endsWith(".md"))) {
          const filePath = path.join(fullDir, f);
          const raw = fs.readFileSync(filePath, "utf8");
          const { meta, body } = parseFrontmatter(raw);
          const id = meta.id ? sanitizeId(meta.id) : sanitizeId(f.slice(0, -3));
          const layer = dirName === "archive" ? (VALID_LAYERS.includes(meta.layer) ? meta.layer : "episodic") : dirName;
          const lifecycle = dirName === "archive" ? "archived" : (meta.lifecycle_state || "active");
          const title = extractTitle(meta, body, id);
          const ts = nowSec();
          const importance = clampNum(meta.importance ?? 0.5, 0, 1);
          const isProtected = Boolean(meta.protected) || importance >= Number(this.config.autoProtectImportance ?? 0.7) || PROTECTED_LAYERS.has(layer);

          const node = {
            id, layer, title, body,
            tags_json: JSON.stringify(Array.isArray(meta.tags) ? meta.tags : []),
            aliases_json: JSON.stringify(Array.isArray(meta.aliases) ? meta.aliases : []),
            importance,
            protected: isProtected ? 1 : 0,
            confidence: clampNum(meta.confidence ?? 0.6, 0, 1),
            lifecycle_state: lifecycle,
            verification_state: String(meta.verification_state || "unverified"),
            access_count: Number(meta.access_count || 0),
            last_access: Number(meta.last_access || 0),
            created_at: Number(meta.created_at) || ts,
            updated_at: Number(meta.updated_at) || Number(meta.created_at) || ts,
            valid_from: meta.valid_from ?? null,
            valid_until: meta.valid_until ?? null,
            session_id: meta.session || null,
            role: meta.role || "assistant",
            source: meta.source || "lanxi-memory",
            file_path: filePath,
            content_hash: sha256Short(`${layer}\n${body}`),
            extra_json: "{}",
          };

          this.stmtUpsertNode.run(
            node.id, node.layer, node.title, node.body, node.tags_json, node.aliases_json,
            node.importance, node.protected, node.confidence, node.lifecycle_state,
            node.verification_state, node.access_count, node.last_access,
            node.created_at, node.updated_at, node.valid_from, node.valid_until,
            node.session_id, node.role, node.source, node.file_path, node.content_hash, node.extra_json
          );
          if (lifecycle === "active") this.upsertFtsForNode(node);
          if (Array.isArray(meta.edges)) {
            for (const e of meta.edges) {
              const target = typeof e === "string" ? e : e?.target;
              if (target) this.stmtUpsertEdge.run(node.id, String(target), e?.relation || "related_to", e?.weight ?? 1.0, node.created_at);
            }
          }
          indexed++;
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return { indexed, elapsedMs: Date.now() - start };
  }

  // Strictly READ-ONLY universal importer for Markdown / Obsidian / DSH mdcg vaults
  importFromVault(sourceDir) {
    const start = Date.now();
    const src = String(sourceDir || "").trim();
    if (!src || !fs.existsSync(src)) {
      throw new Error(`未找到待导入的目录: ${src}`);
    }

    let indexNodes = {};
    const indexPath = path.join(src, "_index.json");
    if (fs.existsSync(indexPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8"));
        if (parsed?.nodes && typeof parsed.nodes === "object") indexNodes = parsed.nodes;
      } catch {}
    }

    const skipDirs = new Set(["trash", "rejected", ".obsidian", ".git", "node_modules", "_protected_history", "_node_locks", "_evolution", "_index_log"]);
    const layerAliases = {
      anchor: "anchor",
      self: "self",
      structural: "structural",
      knowledge: "knowledge",
      episodic: "episodic",
      contextual: "episodic",
      goals: "goals",
      unresolved: "unresolved",
    };

    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!skipDirs.has(entry.name) && !entry.name.startsWith("_")) walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(full);
        }
      }
    };
    walk(src);

    const existingIds = new Set(this.db.prepare("SELECT id FROM nodes").all().map((r) => r.id));
    let imported = 0;
    let skipped = 0;
    let errors = 0;
    const byLayer = {};
    const pendingEdges = [];

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const fullPath of files) {
        try {
          const rel = path.relative(src, fullPath);
          const topSeg = rel.split(/[\\/]/)[0]?.toLowerCase() || "";
          const raw = fs.readFileSync(fullPath, "utf8");
          const { meta, body } = parseFrontmatter(raw);
          if (!body && Object.keys(meta).length === 0) {
            skipped++;
            continue;
          }

          const baseName = path.basename(fullPath, ".md");
          const rawId = meta.id ? String(meta.id) : baseName;
          const id = sanitizeId(rawId);
          if (existingIds.has(id)) {
            skipped++;
            continue;
          }

          const idxMeta = indexNodes[rawId] || indexNodes[id] || {};
          const merged = { ...idxMeta, ...meta };
          const rawLayer = String(merged.layer || topSeg || "knowledge").toLowerCase();
          const dstLayer = layerAliases[rawLayer] || "knowledge";

          const ts = nowSec();
          const createdAt = Number(merged.created_at) || ts;
          const lastAccess = Number(merged.last_access) || 0;
          const importance = clampNum(merged.importance ?? (PROTECTED_LAYERS.has(dstLayer) ? 0.85 : 0.5), 0, 1);
          const isProtected =
            Boolean(merged.protected) ||
            importance >= Number(this.config.autoProtectImportance ?? 0.7) ||
            PROTECTED_LAYERS.has(dstLayer);
          const tags = Array.isArray(merged.tags) ? merged.tags.map(String) : [];
          const aliases = Array.isArray(merged.aliases) ? merged.aliases.map(String) : [];
          const title = extractTitle(merged, body, id);

          const edgeObjs = [];
          for (const wl of extractWikiLinks(body)) {
            edgeObjs.push({ target: wl, relation: "wiki_link", weight: 0.9 });
            pendingEdges.push([id, wl, "wiki_link", 0.9, createdAt]);
          }
          if (Array.isArray(merged.edges)) {
            for (const e of merged.edges) {
              const target = typeof e === "string" ? e : (e?.target || e?.to || e?.id);
              if (target) {
                const relType = typeof e === "object" && e?.relation ? String(e.relation) : "related_to";
                const weight = Number(e?.weight ?? 1.0);
                edgeObjs.push({ target: String(target), relation: relType, weight });
                pendingEdges.push([id, String(target), relType, weight, createdAt]);
              }
            }
          }

          const node = {
            id,
            layer: dstLayer,
            title,
            body: body || title,
            tags_json: JSON.stringify(tags),
            aliases_json: JSON.stringify(aliases),
            importance,
            protected: isProtected ? 1 : 0,
            confidence: clampNum(merged.confidence ?? 0.65, 0, 1),
            lifecycle_state: merged.lifecycle_state === "archived" ? "archived" : "active",
            verification_state: String(merged.verification_state || "unverified"),
            access_count: Number(merged.access_count || 0),
            last_access: lastAccess,
            created_at: createdAt,
            updated_at: ts,
            valid_from: merged.valid_from ?? null,
            valid_until: merged.valid_until ?? null,
            session_id: merged.session ? String(merged.session) : null,
            role: merged.role ? String(merged.role) : "user",
            source: "vault-import",
            file_path: "",
            content_hash: sha256Short(`${dstLayer}\n${body || title}`),
            extra_json: JSON.stringify({ imported_from: rel }),
          };

          node.file_path = this.persistNodeToDisk(node, edgeObjs);
          this.stmtUpsertNode.run(
            node.id, node.layer, node.title, node.body, node.tags_json, node.aliases_json,
            node.importance, node.protected, node.confidence, node.lifecycle_state,
            node.verification_state, node.access_count, node.last_access,
            node.created_at, node.updated_at, node.valid_from, node.valid_until,
            node.session_id, node.role, node.source, node.file_path, node.content_hash, node.extra_json
          );
          if (node.lifecycle_state === "active") this.upsertFtsForNode(node);
          existingIds.add(id);
          imported++;
          byLayer[dstLayer] = (byLayer[dstLayer] || 0) + 1;
        } catch {
          errors++;
        }
      }

      for (const [srcId, dstId, relType, weight, ts] of pendingEdges) {
        this.stmtUpsertEdge.run(srcId, dstId, relType, weight, ts);
      }
      this.logAudit("import_vault", null, { imported, skipped, errors, byLayer });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return { imported, skipped, errors, byLayer, elapsedMs: Date.now() - start };
  }

  recordTurnAndCheck(conversationId, userText) {
    const cid = String(conversationId || "default");
    const hash = sha256Short(String(userText || "").trim());
    const row = this.db.prepare("SELECT * FROM session_turns WHERE conversation_id = ?").get(cid);
    const ts = nowSec();
    if (!row) {
      this.db
        .prepare("INSERT INTO session_turns (conversation_id, turn_count, last_user_hash, last_ingested_hash, updated_at) VALUES (?, 1, ?, NULL, ?)")
        .run(cid, hash, ts);
      return { isNewUserTurn: true, turnCount: 1, userHash: hash };
    }
    if (row.last_user_hash === hash) {
      return { isNewUserTurn: false, turnCount: row.turn_count, userHash: hash };
    }
    const nextTurn = Number(row.turn_count || 0) + 1;
    this.db
      .prepare("UPDATE session_turns SET turn_count = ?, last_user_hash = ?, updated_at = ? WHERE conversation_id = ?")
      .run(nextTurn, hash, ts, cid);
    return { isNewUserTurn: true, turnCount: nextTurn, userHash: hash };
  }

  shouldIngestAndMark(conversationId, userText) {
    const cid = String(conversationId || "default");
    const hash = sha256Short(String(userText || "").trim());
    const row = this.db.prepare("SELECT last_ingested_hash FROM session_turns WHERE conversation_id = ?").get(cid);
    if (row && row.last_ingested_hash === hash) {
      return { shouldIngest: false, userHash: hash };
    }
    const ts = nowSec();
    if (!row) {
      this.db
        .prepare("INSERT INTO session_turns (conversation_id, turn_count, last_user_hash, last_ingested_hash, updated_at) VALUES (?, 1, ?, ?, ?)")
        .run(cid, hash, hash, ts);
    } else {
      this.db
        .prepare("UPDATE session_turns SET last_ingested_hash = ?, updated_at = ? WHERE conversation_id = ?")
        .run(hash, ts, cid);
    }
    return { shouldIngest: true, userHash: hash };
  }
}

function safeJsonParse(str, fallback) {
  try {
    return str ? JSON.parse(str) : fallback;
  } catch {
    return fallback;
  }
}

function clampNum(v, min, max) {
  const n = Number(v);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}
