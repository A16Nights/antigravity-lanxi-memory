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
import {
  initExternalSourceTables,
  syncExternalSources as syncExtSourcesImpl,
  deleteExternalSourceData,
  searchExternalChunks,
} from "./external-sources.mjs";

const HOME = process.env.USERPROFILE || os.homedir();
export const DEFAULT_DATA_DIR = process.env.LANXI_DATA_DIR || path.join(HOME, ".gemini", "lingshu-cortex");

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
export const VALID_WRITE_GATES = ["off", "confirm_protect", "strict"];
export const VALID_RECALL_STRICTNESS = ["strict", "balanced", "loose"];
const EXTRA_META_KEYS = [
  "importance_source",
  "importance_confirmed_by",
  "project",
  "source_ref",
  "rejection_reason",
  "status",
  "priority",
  "progress",
  "deadline",
  "archive_reason",
  "archived_at",
  "imported_from",
];

export const DEFAULT_CONFIG = {
  brainName: "蓝汐",
  autoSessionStart: true,
  projectBriefing: true,
  autoRecall: false,
  recallStrictness: "strict",
  autoIngest: true,
  autoOrganize: false,
  autoOrganizeThreshold: 15,
  autoOrganizeArchiveSources: true,
  turnReminderInterval: 10,
  recallWindow: 6,
  recallMaxChars: 1600,
  autoRecallMinScore: 0.55,
  autoRecallMaxChars: 1400,
  memoryDisabledPersonas: [],
  externalSources: [],
  decayModel: "power_law",
  halfLifeDays: 7.0,
  autoProtectImportance: 0.7,
  writeGate: "off",
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

const QUERY_STOPWORDS_RE = /(?:不需要的|不需要|有没有|做一做|看一看|试一试|先试试|主要是|主要|发现|稍微|调查|一下吧|一下|哪些|可能|原因|导致|导致的|试试|先试|然后|或者|以及|如果|因为|所以|但是|不过|其实|已经|现在|刚才|目前|之前|之后|可以|怎么|什么|这个|那个|这些|那些|我们|你们|他们|它们|咱们|自己|这里|那里|需要|认为|觉得|应该|是不是|能不能|要不要|好不好|没有|还是|就是|不是|帮我|给我|看看|好呀|好的|谢谢|只保留|保留|关掉|打开|开启|关闭|设置|独立|按钮|时候|地方|问题|情况|内容|方式|方法|[把被让给在从向往对跟和与或但而且只都也还又再先后就才那这也没不])/g;

export function extractQueryTerms(query, { filterStopwords = false } = {}) {
  let raw = String(query || "").trim();
  if (!raw) return [];
  if (filterStopwords) {
    raw = raw.replace(QUERY_STOPWORDS_RE, " ");
  }
  const terms = [];
  const seen = new Set();
  const wordRe = /[A-Za-z0-9_]+|[\u4e00-\u9fff\u3400-\u4dbf]+/g;
  let m;
  while ((m = wordRe.exec(raw)) !== null) {
    const seg = m[0];
    if (/^[A-Za-z0-9_]+$/.test(seg)) {
      const lower = seg.toLowerCase();
      if (filterStopwords && lower.length < 2) continue;
      if (!seen.has(lower)) {
        seen.add(lower);
        terms.push(lower);
      }
    } else {
      const chars = Array.from(seg);
      if (chars.length === 1) {
        if (filterStopwords) continue;
        if (!seen.has(chars[0])) {
          seen.add(chars[0]);
          terms.push(chars[0]);
        }
      } else {
        for (let i = 0; i + 1 < chars.length; i++) {
          const bg = chars[i] + chars[i + 1];
          if (!seen.has(bg)) {
            seen.add(bg);
            terms.push(bg);
          }
        }
      }
    }
    if (terms.length >= 24) break;
  }
  return terms;
}

function buildFtsQuery(query, options = {}) {
  const terms = extractQueryTerms(query, options);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t}"`).join(" OR ");
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

function parseNodeExtra(node) {
  if (node?.extra && typeof node.extra === "object") return node.extra;
  return safeJsonParse(node?.extra_json, {});
}

export function isHintUnconfirmed(extra) {
  return extra?.importance_source === "hint" && !extra?.importance_confirmed_by;
}

export function isNodeProtected(node, config = DEFAULT_CONFIG) {
  if (!node) return false;
  if (Boolean(node.protected) || PROTECTED_LAYERS.has(node.layer)) {
    return true;
  }
  const extra = parseNodeExtra(node);
  if (isHintUnconfirmed(extra)) {
    return false;
  }
  return Number(node.importance) >= Number(config?.autoProtectImportance ?? 0.7);
}

function isProjectMatch(item, project) {
  const p = String(project || "").trim();
  if (!p) return false;
  const extra = parseNodeExtra(item);
  if (extra?.project && String(extra.project).trim() === p) return true;
  const tags = Array.isArray(item?.tags) ? item.tags : safeJsonParse(item?.tags_json, []);
  return tags.includes(`项目:${p}`) || tags.includes(p);
}

export function computeRetention(node, config, currentTs = nowSec()) {
  if (isNodeProtected(node, config)) {
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
    this._freshnessCache = null;
    this._freshnessCacheAt = 0;
    this.db = new DatabaseSync(this.dbPath);
    this.initDb();
  }

  ensureDirs() {
    ensureDir(this.dataDir);
    ensureDir(this.vaultDir);
    for (const sub of [...VALID_LAYERS, "archive", ".backups"]) {
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
    if (typeof patch.autoSessionStart === "boolean") cfg.autoSessionStart = patch.autoSessionStart;
    if (typeof patch.projectBriefing === "boolean") cfg.projectBriefing = patch.projectBriefing;
    if (typeof patch.autoRecall === "boolean") cfg.autoRecall = patch.autoRecall;
    if (VALID_RECALL_STRICTNESS.includes(patch.recallStrictness)) cfg.recallStrictness = patch.recallStrictness;
    if (typeof patch.autoIngest === "boolean") cfg.autoIngest = patch.autoIngest;
    if (typeof patch.autoOrganize === "boolean") cfg.autoOrganize = patch.autoOrganize;
    if (typeof patch.autoOrganizeThreshold === "number" && Number.isFinite(patch.autoOrganizeThreshold)) {
      cfg.autoOrganizeThreshold = Math.floor(Math.min(100, Math.max(4, patch.autoOrganizeThreshold)));
    }
    if (typeof patch.autoOrganizeArchiveSources === "boolean") {
      cfg.autoOrganizeArchiveSources = patch.autoOrganizeArchiveSources;
    }
    if (typeof patch.turnReminderInterval === "number" && patch.turnReminderInterval >= 0) {
      cfg.turnReminderInterval = Math.floor(patch.turnReminderInterval);
    }
    if (typeof patch.recallWindow === "number" && patch.recallWindow >= 1 && patch.recallWindow <= 30) {
      cfg.recallWindow = Math.floor(patch.recallWindow);
    }
    if (typeof patch.recallMaxChars === "number" && patch.recallMaxChars >= 400 && patch.recallMaxChars <= 16000) {
      cfg.recallMaxChars = Math.floor(patch.recallMaxChars);
    }
    if (typeof patch.autoRecallMinScore === "number" && Number.isFinite(patch.autoRecallMinScore)) {
      cfg.autoRecallMinScore = Math.min(1, Math.max(0, patch.autoRecallMinScore));
    }
    if (typeof patch.autoRecallMaxChars === "number" && Number.isFinite(patch.autoRecallMaxChars)) {
      cfg.autoRecallMaxChars = Math.floor(Math.min(8000, Math.max(200, patch.autoRecallMaxChars)));
    }
    if (Array.isArray(patch.memoryDisabledPersonas)) {
      const seen = new Set();
      const list = [];
      for (const raw of patch.memoryDisabledPersonas) {
        if (typeof raw !== "string") continue;
        const name = raw.trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(name);
      }
      cfg.memoryDisabledPersonas = list;
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
    if (VALID_WRITE_GATES.includes(patch.writeGate)) {
      cfg.writeGate = patch.writeGate;
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

      CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    initExternalSourceTables(this.db);

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

  markIndexFresh(tsMs = Date.now()) {
    try {
      this.db
        .prepare("INSERT INTO index_meta (key, value) VALUES ('last_indexed_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(tsMs));
    } catch {}
    this._freshnessCache = null;
    this._freshnessCacheAt = 0;
  }

  checkDiskFreshness({ force = false } = {}) {
    const nowMs = Date.now();
    if (!force && this._freshnessCache && nowMs - this._freshnessCacheAt < 3000) {
      return this._freshnessCache;
    }

    let metaRow = null;
    try {
      metaRow = this.db.prepare("SELECT value FROM index_meta WHERE key = 'last_indexed_at'").get();
    } catch {}
    let baselineMs = metaRow ? Number(metaRow.value) : 0;
    if (!baselineMs || Number.isNaN(baselineMs)) {
      const maxRow = this.db.prepare("SELECT MAX(updated_at) AS max_u FROM nodes").get();
      const maxDbMs = maxRow?.max_u ? Number(maxRow.max_u) * 1000 : 0;
      let dbMtimeMs = 0;
      try {
        if (fs.existsSync(this.dbPath)) dbMtimeMs = fs.statSync(this.dbPath).mtimeMs;
      } catch {}
      baselineMs = Math.max(maxDbMs, dbMtimeMs, nowMs);
      this.markIndexFresh(baselineMs);
    }

    let diskFileCount = 0;
    let staleFilesCount = 0;
    let maxDiskMtimeMs = 0;
    for (const dirName of [...VALID_LAYERS, "archive"]) {
      const fullDir = path.join(this.vaultDir, dirName);
      if (!fs.existsSync(fullDir)) continue;
      let entries;
      try {
        entries = fs.readdirSync(fullDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
        diskFileCount++;
        try {
          const st = fs.statSync(path.join(fullDir, ent.name));
          if (st.mtimeMs > maxDiskMtimeMs) maxDiskMtimeMs = st.mtimeMs;
          if (st.mtimeMs > baselineMs + 2000) {
            staleFilesCount++;
          }
        } catch {}
      }
    }

    const dbNodeCount = Number(this.db.prepare("SELECT COUNT(*) AS cnt FROM nodes").get()?.cnt || 0);
    let reason = "fresh";
    if (staleFilesCount > 0 && diskFileCount !== dbNodeCount) reason = "files_modified_and_count_mismatch";
    else if (staleFilesCount > 0) reason = "files_modified_on_disk";
    else if (diskFileCount !== dbNodeCount) reason = "file_count_mismatch";

    const res = {
      dataStale: staleFilesCount > 0 || diskFileCount !== dbNodeCount,
      staleFilesCount,
      diskFileCount,
      dbNodeCount,
      lastIndexedAt: Math.round(baselineMs),
      maxDiskMtimeMs: Math.round(maxDiskMtimeMs),
      reason,
    };
    this._freshnessCache = res;
    this._freshnessCacheAt = nowMs;
    return res;
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
    const extra = safeJsonParse(row.extra_json, {});
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
      project: extra.project || null,
      rejectionReason: extra.rejection_reason || null,
      extra,
    };
  }

  writeMemory(opts = {}) {
    const layer = VALID_LAYERS.includes(opts.layer) ? opts.layer : "episodic";
    const body = String(opts.content ?? opts.body ?? "").trim();
    if (!body) throw new Error("记忆正文不能为空");

    const confirmedByRaw = opts.confirmedBy || opts.importanceConfirmedBy;
    const confirmedBy = typeof confirmedByRaw === "string" ? confirmedByRaw.trim() : "";
    const rawImpSource = opts.importanceSource ?? opts.importance_source;
    const importanceSource = confirmedBy
      ? "confirmed"
      : rawImpSource === "hint" || rawImpSource === "confirmed"
        ? rawImpSource
        : this.config.writeGate !== "off"
          ? "hint"
          : undefined;

    if (
      this.config.writeGate === "strict" &&
      ["anchor", "self", "structural"].includes(layer) &&
      importanceSource !== "confirmed"
    ) {
      throw new Error(`strict 写入闸门已开启：写入 ${layer} 层需提供 importanceSource="confirmed" 或 confirmedBy`);
    }

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
    const unconfirmedHint = importanceSource === "hint" && !confirmedBy;
    const layerLocked = PROTECTED_LAYERS.has(layer);
    const wantsProtect = Boolean(opts.protected) || importance >= Number(this.config.autoProtectImportance ?? 0.7);
    const protectionPendingConfirm = Boolean(!layerLocked && unconfirmedHint && wantsProtect);
    const isProtected = layerLocked || (!unconfirmedHint && wantsProtect);

    const tags = Array.isArray(opts.tags) ? opts.tags.map(String) : [];
    const projectName = typeof opts.project === "string" ? opts.project.trim().slice(0, 80) : "";
    if (projectName) {
      const projTag = `项目:${projectName}`;
      if (!tags.includes(projTag)) tags.push(projTag);
    }

    const aliases = Array.isArray(opts.aliases) ? opts.aliases.map(String) : [];
    const title = extractTitle({ title: opts.title }, body, id);
    const extra = opts.extra && typeof opts.extra === "object" ? { ...opts.extra } : {};
    if (projectName) extra.project = projectName;
    if (typeof opts.source_ref === "string" && opts.source_ref.trim()) {
      extra.source_ref = opts.source_ref.trim().slice(0, 140);
    }
    if (typeof opts.rejection_reason === "string" && opts.rejection_reason.trim()) {
      extra.rejection_reason = opts.rejection_reason.trim();
    }
    if (importanceSource) extra.importance_source = importanceSource;
    if (confirmedBy) extra.importance_confirmed_by = confirmedBy;

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
    this.markIndexFresh(Math.max(Date.now(), Math.ceil(ts * 1000)));
    this.logAudit("write", node.id, { layer: node.layer, importance: node.importance, protected: isProtected });

    return {
      committed: true,
      deduplicated: false,
      id: node.id,
      layer: node.layer,
      title: node.title,
      importance: node.importance,
      protected: isProtected,
      protectionPendingConfirm,
      filePath: node.file_path,
    };
  }

  recall({ query = "", layers = null, project = null, strictProject = false, allowFallback = true, strictness = "balanced", limit = 8, includeExpired = false, touch = true } = {}) {
    const ts = nowSec();
    const maxLimit = Math.max(1, Math.min(50, Number(limit) || 8));
    const layerList = Array.isArray(layers) && layers.length > 0
      ? layers.filter((l) => VALID_LAYERS.includes(l))
      : null;
    const projectName = typeof project === "string" ? project.trim() : "";
    const mode = VALID_RECALL_STRICTNESS.includes(strictness) ? strictness : "balanced";

    const coreTerms = extractQueryTerms(query, { filterStopwords: true });
    const queryTerms = mode === "strict"
      ? coreTerms
      : (coreTerms.length > 0 ? coreTerms : extractQueryTerms(query, { filterStopwords: false }));

    if (mode === "strict" && queryTerms.length < 2) {
      return [];
    }

    const ftsQuery = queryTerms.length > 0 ? queryTerms.map((t) => `"${t}"`).join(" OR ") : "";
    if (!ftsQuery && !allowFallback) {
      return [];
    }
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
      args.push(maxLimit * (projectName ? 8 : 6));
      try {
        candidates = this.db.prepare(sql).all(...args);
      } catch {
        candidates = [];
      }
    }

    if (candidates.length === 0 && allowFallback && mode !== "strict") {
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
        sql += " AND (n.title LIKE ? OR n.body LIKE ? OR n.tags_json LIKE ? OR n.aliases_json LIKE ?)";
        args.push(likePattern, likePattern, likePattern, likePattern);
      }
      sql += " ORDER BY n.importance DESC, n.created_at DESC LIMIT ?";
      args.push(maxLimit * (projectName ? 6 : 4));
      candidates = this.db.prepare(sql).all(...args);
    }

    if (strictProject && projectName) {
      candidates = candidates.filter((row) => isProjectMatch(row, projectName));
    }

    const scored = [];
    for (const row of candidates) {
      let hitCount = 0;
      let titleOrTagHits = 0;
      let coverage = 1.0;

      if (queryTerms.length > 0) {
        const titleTagHay = `${row.title || ""}\n${row.tags_json || ""}\n${row.aliases_json || ""}`.toLowerCase();
        const fullHay = `${titleTagHay}\n${row.body || ""}`.toLowerCase();
        for (const t of queryTerms) {
          if (fullHay.includes(t)) hitCount++;
          if (titleTagHay.includes(t)) titleOrTagHits++;
        }
        coverage = hitCount / queryTerms.length;

        if (mode === "strict") {
          const passesStrict =
            (hitCount >= 3 && coverage >= 0.35) ||
            (hitCount >= 2 && coverage >= 0.45) ||
            (titleOrTagHits >= 2 && coverage >= 0.3);
          if (!passesStrict) continue;
        } else if (mode === "balanced" && !allowFallback) {
          const passesBalancedHook =
            hitCount >= 2 ||
            (queryTerms.length === 1 && hitCount === 1 && titleOrTagHits >= 1);
          if (!passesBalancedHook || coverage < 0.25) continue;
        }
      }

      const ftsNorm = Math.max(0.1, Number(row.fts_score || 1));
      const retention = computeRetention(row, this.config, ts);
      const reinforcement = computeReinforcement(row);
      const impWeight = 0.4 + 0.6 * Number(row.importance || 0.5);
      const projMatch = projectName ? isProjectMatch(row, projectName) : false;
      const projWeight = !strictProject && projMatch ? 1.25 : 1.0;
      const covWeight = queryTerms.length > 0 ? (0.4 + 0.6 * coverage) : 1.0;
      const score = ftsNorm * impWeight * retention * reinforcement * projWeight * covWeight;
      scored.push({
        ...this.formatNodeSummary(row, ts),
        body: row.body,
        projectMatch: projMatch,
        termCoverage: Number(coverage.toFixed(3)),
        score: Number(score.toFixed(4)),
      });
    }

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

  async recallHybrid({ query = "", layers = null, project = null, strictProject = false, limit = 8, includeExpired = false, touch = true } = {}) {
    const maxLimit = Math.max(1, Math.min(50, Number(limit) || 8));
    const projectName = typeof project === "string" ? project.trim() : "";
    const ftsResults = this.recall({ query, layers, project: projectName, strictProject, limit: maxLimit * 2, includeExpired, touch: false });

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
        return this.recall({ query, layers, project: projectName, strictProject, limit: maxLimit, includeExpired, touch });
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
        if (strictProject && projectName && !isProjectMatch(row, projectName)) continue;
        const vec = bufferToFloat32(row.vec_blob);
        const sim = Math.max(0, cosineSimilarity(qVec, vec));
        if (sim < 0.25 && !candidateMap.has(row.id)) continue;

        const existing = candidateMap.get(row.id);
        if (existing) {
          existing.semSim = sim;
        } else {
          candidateMap.set(row.id, {
            item: { ...this.formatNodeSummary(row, ts), body: row.body, projectMatch: projectName ? isProjectMatch(row, projectName) : false, score: 0 },
            ftsNorm: 0,
            semSim: sim,
          });
        }
      }

      const fused = [];
      for (const entry of candidateMap.values()) {
        const ret = entry.item.retention;
        const impW = 0.5 + 0.5 * Number(entry.item.importance || 0.5);
        const projWeight = !strictProject && projectName && isProjectMatch(entry.item, projectName) ? 1.25 : 1.0;
        const hybridScore = (0.45 * entry.ftsNorm + 0.55 * entry.semSim) * impW * (0.5 + 0.5 * ret) * projWeight;
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
      return this.recall({ query, layers, project: projectName, strictProject, limit: maxLimit, includeExpired, touch });
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
    let diskSync = { exists: false, stale: false };
    if (row.file_path && fs.existsSync(row.file_path)) {
      try {
        const st = fs.statSync(row.file_path);
        diskSync = {
          exists: true,
          stale: st.mtimeMs > Number(row.updated_at || 0) * 1000 + 2000,
        };
      } catch {}
    }
    const summary = this.formatNodeSummary(row);
    return {
      ...summary,
      body: row.body,
      file_path: row.file_path,
      source_ref: summary.extra?.source_ref || row.session_id || "",
      backups: this.listBackups(row.id),
      diskSync,
      outgoing,
      incoming,
    };
  }

  updateMemory(id, patch = {}) {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(String(id || ""));
    if (!row) throw new Error(`未找到记忆节点: ${id}`);

    const override = Boolean(patch.override);
    const wasProtected = isNodeProtected(row, this.config);
    const nextLayer = patch.layer && VALID_LAYERS.includes(patch.layer) ? patch.layer : row.layer;
    if (wasProtected && !override && PROTECTED_LAYERS.has(row.layer) && nextLayer !== row.layer && !PROTECTED_LAYERS.has(nextLayer)) {
      throw new Error(`节点 ${row.id} 处于受保护层 ${row.layer}，降级到 ${nextLayer} 需要 override=true`);
    }

    const existingExtra = safeJsonParse(row.extra_json, {});
    const nextExtraObj =
      patch.extra && typeof patch.extra === "object" ? { ...existingExtra, ...patch.extra } : { ...existingExtra };

    const patchConfirmedByRaw = patch.confirmedBy || patch.importanceConfirmedBy;
    const patchConfirmedBy = typeof patchConfirmedByRaw === "string" ? patchConfirmedByRaw.trim() : "";
    if (patchConfirmedBy) {
      nextExtraObj.importance_source = "confirmed";
      nextExtraObj.importance_confirmed_by = patchConfirmedBy;
    } else if (patch.importanceSource === "confirmed") {
      nextExtraObj.importance_source = "confirmed";
      nextExtraObj.importance_confirmed_by = nextExtraObj.importance_confirmed_by || "user";
    } else if (patch.importanceSource === "hint") {
      nextExtraObj.importance_source = "hint";
      delete nextExtraObj.importance_confirmed_by;
    }

    const baseTags = Array.isArray(patch.tags) ? patch.tags.map(String) : safeJsonParse(row.tags_json, []);
    if (typeof patch.project === "string") {
      const proj = patch.project.trim().slice(0, 80);
      if (proj) {
        nextExtraObj.project = proj;
        const projTag = `项目:${proj}`;
        if (!baseTags.includes(projTag)) baseTags.push(projTag);
      } else {
        delete nextExtraObj.project;
      }
    }
    if (typeof patch.rejection_reason === "string") {
      if (patch.rejection_reason.trim()) nextExtraObj.rejection_reason = patch.rejection_reason.trim();
      else delete nextExtraObj.rejection_reason;
    }

    const threshold = Number(this.config.autoProtectImportance ?? 0.7);
    const nextImportance = patch.importance !== undefined ? clampNum(patch.importance, 0, 1) : Number(row.importance);
    const unconfirmedHint = isHintUnconfirmed(nextExtraObj);
    let nextProtected = patch.protected !== undefined ? Boolean(patch.protected) : Boolean(row.protected);

    if (!unconfirmedHint && (nextImportance >= threshold || PROTECTED_LAYERS.has(nextLayer)) && patch.protected !== false) {
      nextProtected = true;
    }
    if (wasProtected && !override) {
      if (patch.protected === false || nextImportance < threshold) {
        throw new Error("该记忆受硬保护（importance >= 0.7 或 protected=true），降级/解除保护需要 override=true");
      }
    }

    const nextBody = patch.content !== undefined ? String(patch.content).trim() : (patch.body !== undefined ? String(patch.body).trim() : row.body);
    const nextTitle = patch.title !== undefined ? String(patch.title).trim() : extractTitle({ title: patch.title }, nextBody, row.id);
    const nextTags = JSON.stringify(baseTags);
    const nextAliases = Array.isArray(patch.aliases) ? JSON.stringify(patch.aliases.map(String)) : row.aliases_json;
    const nextValidUntil = patch.valid_until !== undefined ? patch.valid_until : row.valid_until;
    const nextVerificationState =
      nextExtraObj.importance_source === "confirmed" || nextProtected ? "verified" : row.verification_state;

    const ts = nowSec();
    const updated = {
      ...row,
      layer: nextLayer,
      title: nextTitle,
      body: nextBody,
      tags_json: nextTags,
      aliases_json: nextAliases,
      importance: nextImportance,
      protected: nextProtected ? 1 : 0,
      verification_state: nextVerificationState,
      valid_until: nextValidUntil,
      updated_at: ts,
      content_hash: sha256Short(`${nextLayer}\n${nextBody}`),
      extra_json: JSON.stringify(nextExtraObj),
    };

    this.createNodeBackup(row);

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
    this.markIndexFresh(Math.max(Date.now(), Math.ceil(ts * 1000)));
    this.logAudit("update", updated.id, { layer: updated.layer, importance: updated.importance });
    return this.readMemory(updated.id);
  }

  forgetMemory(id, { reason = "", override = false } = {}) {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(String(id || ""));
    if (!row) throw new Error(`未找到记忆节点: ${id}`);

    if (isNodeProtected(row, this.config) && !override) {
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
    this.markIndexFresh(Math.max(Date.now(), Math.ceil(ts * 1000)));
    this.logAudit("forget", row.id, { reason, override });

    return { archived: true, id: row.id, archivePath: updated.file_path };
  }

  restoreMemory(id) {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(String(id || ""));
    if (!row) throw new Error(`未找到记忆节点: ${id}`);
    if (row.lifecycle_state !== "archived") {
      return { restored: true, id: row.id, alreadyActive: true };
    }

    const ts = nowSec();
    const extra = { ...safeJsonParse(row.extra_json, {}) };
    delete extra.archive_reason;
    delete extra.archived_at;
    extra.restored_at = ts;

    const updated = {
      ...row,
      lifecycle_state: "active",
      updated_at: ts,
      last_access: ts,
      extra_json: JSON.stringify(extra),
    };

    if (row.file_path && fs.existsSync(row.file_path)) {
      try { fs.unlinkSync(row.file_path); } catch {}
    }

    const edges = this.db.prepare("SELECT target_id AS target, relation, weight FROM edges WHERE source_id = ?").all(row.id);
    updated.file_path = this.persistNodeToDisk(updated, edges);

    this.db
      .prepare("UPDATE nodes SET lifecycle_state = 'active', updated_at = ?, last_access = ?, file_path = ?, extra_json = ? WHERE id = ?")
      .run(ts, ts, updated.file_path, updated.extra_json, row.id);
    this.upsertFtsForNode(updated);
    this.markIndexFresh(Math.max(Date.now(), Math.ceil(ts * 1000)));
    this.logAudit("restore", row.id, { layer: row.layer });

    return { restored: true, id: row.id, filePath: updated.file_path };
  }

  deleteMemory(id, { override = false } = {}) {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(String(id || ""));
    if (!row) throw new Error(`未找到记忆节点: ${id}`);

    if (row.lifecycle_state !== "archived" && isNodeProtected(row, this.config) && !override) {
      throw new Error(`节点 ${id} 受硬保护且尚未归档，必须先归档或传 override=true 才能永久删除`);
    }

    const ts = nowSec();
    if (row.file_path && fs.existsSync(row.file_path)) {
      try { fs.unlinkSync(row.file_path); } catch {}
    }
    // Clean up associated .bak snapshots
    try {
      const bakDir = path.join(this.vaultDir, ".backups");
      if (fs.existsSync(bakDir)) {
        const prefix = `${sanitizeId(row.id)}.`;
        for (const f of fs.readdirSync(bakDir)) {
          if (f.startsWith(prefix) && f.endsWith(".bak.md")) {
            try { fs.unlinkSync(path.join(bakDir, f)); } catch {}
          }
        }
      }
    } catch {}

    this.stmtDeleteFts.run(row.id);
    this.db.prepare("DELETE FROM node_embeddings WHERE id = ?").run(row.id);
    this.db.prepare("DELETE FROM edges WHERE source_id = ? OR target_id = ?").run(row.id, row.id);
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(row.id);
    this.markIndexFresh(Math.max(Date.now(), Math.ceil(ts * 1000)));
    this.logAudit("delete", row.id, { layer: row.layer, title: row.title, fromState: row.lifecycle_state });

    return { deleted: true, id: row.id };
  }

  checkpointWal(mode = "PASSIVE") {
    const safeMode = ["PASSIVE", "FULL", "RESTART", "TRUNCATE"].includes(String(mode || "").toUpperCase())
      ? String(mode).toUpperCase()
      : "PASSIVE";
    try {
      this.db.exec(`PRAGMA wal_checkpoint(${safeMode})`);
      return { ok: true, mode: safeMode };
    } catch {
      return { ok: false, mode: safeMode };
    }
  }

  purgeArchived({ ids = null } = {}) {
    let targetIds = [];
    if (Array.isArray(ids) && ids.length > 0) {
      const clean = [...new Set(ids.map((x) => String(x || "").trim()).filter(Boolean))];
      if (clean.length > 0) {
        const placeholders = clean.map(() => "?").join(",");
        targetIds = this.db
          .prepare(`SELECT id FROM nodes WHERE lifecycle_state = 'archived' AND id IN (${placeholders})`)
          .all(...clean)
          .map((r) => r.id);
      }
    } else {
      targetIds = this.db
        .prepare("SELECT id FROM nodes WHERE lifecycle_state = 'archived'")
        .all()
        .map((r) => r.id);
    }

    let deleted = 0;
    for (const id of targetIds) {
      try {
        this.deleteMemory(id, { override: true });
        deleted++;
      } catch {}
    }
    this.checkpointWal("TRUNCATE");
    return { purged: true, deleted, requested: targetIds.length };
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
    this.markIndexFresh(Math.max(Date.now(), Math.ceil(ts * 1000)));
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
      if (layerList) {
        const sql = `
          SELECT n.*,
            (SELECT COUNT(*) FROM edges e WHERE e.source_id = n.id OR e.target_id = n.id) AS deg
          FROM nodes n
          WHERE n.lifecycle_state = 'active'
            AND n.layer IN (${layerList.map(() => "?").join(",")})
          ORDER BY deg DESC, n.importance DESC, n.created_at DESC LIMIT ?
        `;
        nodes = this.db.prepare(sql).all(...layerList, maxNodes);
      } else {
        // Balanced stratified sampling across orbital rings (core / mid / outer)
        const pool = this.db
          .prepare(`
            SELECT n.*,
              (SELECT COUNT(*) FROM edges e WHERE e.source_id = n.id OR e.target_id = n.id) AS deg
            FROM nodes n
            WHERE n.lifecycle_state = 'active'
            ORDER BY deg DESC, n.importance DESC, n.last_access DESC, n.created_at DESC
            LIMIT 800
          `)
          .all();

        const picked = new Map();
        const addNode = (r) => {
          if (picked.size < maxNodes && !picked.has(r.id)) picked.set(r.id, r);
        };

        // 1. Prioritize nodes with semantic edges so graph links stay visible
        const edgeQuota = Math.min(24, Math.floor(maxNodes * 0.28));
        for (const r of pool) {
          if (picked.size >= edgeQuota) break;
          if (Number(r.deg || 0) > 0) addNode(r);
        }

        // 2. Partition remaining candidates into core / mid / outer buckets
        const corePool = [];
        const midPool = [];
        const outerPool = [];
        for (const r of pool) {
          if (picked.has(r.id)) continue;
          const isCore = Boolean(r.protected) || r.layer === "anchor" || r.layer === "self" || r.layer === "goals";
          if (isCore) {
            corePool.push(r);
          } else if (r.layer === "episodic") {
            outerPool.push(r);
          } else {
            midPool.push(r);
          }
        }

        const rem = Math.max(0, maxNodes - picked.size);
        const qCore = Math.round(rem * 0.32);
        const qMid = Math.round(rem * 0.36);
        const qOuter = Math.max(0, rem - qCore - qMid);

        for (const r of corePool.slice(0, qCore)) addNode(r);
        for (const r of midPool.slice(0, qMid)) addNode(r);
        for (const r of outerPool.slice(0, qOuter)) addNode(r);

        // 3. Fill any unused quota cleanly
        if (picked.size < maxNodes) {
          for (const r of [...midPool.slice(qMid), ...outerPool.slice(qOuter), ...corePool.slice(qCore)]) {
            if (picked.size >= maxNodes) break;
            addNode(r);
          }
        }
        nodes = [...picked.values()];
      }

      const idSet = new Set(nodes.map((n) => n.id));
      if (idSet.size > 0) {
        const allEdges = this.db.prepare("SELECT * FROM edges LIMIT 2000").all();
        edges = allEdges.filter((e) => idSet.has(e.source_id) && idSet.has(e.target_id));
      }
    }

    const degMap = new Map();
    for (const e of edges) {
      degMap.set(e.source_id, (degMap.get(e.source_id) || 0) + 1);
      degMap.set(e.target_id, (degMap.get(e.target_id) || 0) + 1);
    }

    return {
      nodes: nodes.map((n) => ({ ...this.formatNodeSummary(n), deg: degMap.get(n.id) || Number(n.deg || 0) })),
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
          importanceSource: "confirmed",
          confirmedBy: "goal",
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
      importanceSource: "confirmed",
      confirmedBy: "goal",
      tags: ["goal", status],
      extra: { status, priority, progress: clampNum(progress, 0, 100), deadline },
    });
    return this.readMemory(res.id);
  }

  reflect({ title, content, layer = "self", basedOnIds = [], importance = 0.75, tags = [], project, importanceSource, confirmedBy } = {}) {
    const targetLayer = layer === "unresolved" ? "unresolved" : "self";
    const res = this.writeMemory({
      layer: targetLayer,
      title,
      content,
      importance,
      project,
      importanceSource,
      confirmedBy,
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
    const recentEpisodic = [];
    let pendingEpisodicCount = 0;
    for (const r of episodicRows) {
      const retention = computeRetention(r, this.config, ts);
      const tags = safeJsonParse(r.tags_json, []);
      if (!r.protected && !tags.includes("consolidated")) {
        pendingEpisodicCount++;
        if (recentEpisodic.length < 40) {
          recentEpisodic.push({ ...this.formatNodeSummary(r, ts), retention: Number(retention.toFixed(4)) });
        }
      }
      if (Number(r.access_count) >= 2 || (Number(r.importance) >= 0.55 && !r.protected)) {
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
      recentEpisodic,
      pendingEpisodicCount,
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
      importanceSource: "confirmed",
      confirmedBy: "maintain",
      override: true,
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

  setImportanceBatch({ ids = [], id = null, importance, confirm = false, confirmedBy = "user", override = false } = {}) {
    const rawList = [...(Array.isArray(ids) ? ids : []), ...(id ? [id] : [])]
      .map((x) => String(x || "").trim())
      .filter(Boolean);
    const targetIds = [...new Set(rawList)];
    if (targetIds.length === 0) {
      throw new Error("请提供至少一个目标节点 id 或 ids");
    }

    const hasImp = importance !== undefined && importance !== null && importance !== "";
    const updated = [];
    const skipped = [];
    const unknownIds = [];

    for (const nid of targetIds) {
      const exists = this.db.prepare("SELECT id FROM nodes WHERE id = ?").get(nid);
      if (!exists) {
        unknownIds.push(nid);
        continue;
      }
      const patch = { override: Boolean(override) };
      if (hasImp) patch.importance = clampNum(importance, 0, 1);
      if (confirm) {
        patch.importanceSource = "confirmed";
        patch.confirmedBy = String(confirmedBy || "user").trim() || "user";
      }
      try {
        const res = this.updateMemory(nid, patch);
        updated.push({
          id: res.id,
          importance: res.importance,
          protected: res.protected,
          verification_state: res.verification_state,
        });
      } catch (err) {
        skipped.push({ id: nid, reason: err.message || String(err) });
      }
    }

    return { updated, skipped, unknownIds };
  }

  consolidateCluster({ sourceIds = [], title, summary, tags = [], targetLayer = "knowledge", archiveSources = false } = {}) {
    if (!summary || !String(summary).trim()) throw new Error("凝结摘要不能为空");
    const created = this.writeMemory({
      layer: VALID_LAYERS.includes(targetLayer) ? targetLayer : "knowledge",
      title: title || summary.slice(0, 60),
      content: summary,
      importance: 0.75,
      protected: true,
      importanceSource: "confirmed",
      confirmedBy: "maintain",
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

  listMemories({ layer = null, query = "", project = null, lifecycle = "active", sort = "recent", limit = 50, offset = 0 } = {}) {
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const projectName = typeof project === "string" ? project.trim() : "";

    if (query && query.trim()) {
      const layers = layer && VALID_LAYERS.includes(layer) ? [layer] : null;
      const items = this.recall({ query: query.trim(), layers, project: projectName, limit: lim, touch: false });
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

    if (projectName) {
      const allRows = this.db.prepare(`SELECT * FROM nodes ${where} ${orderSql}`).all(...args);
      const matched = allRows.filter((r) => isProjectMatch(r, projectName));
      let items = matched.slice(off, off + lim).map((r) => this.formatNodeSummary(r));
      if (sort === "retention_asc") {
        items = matched.map((r) => this.formatNodeSummary(r)).sort((a, b) => a.retention - b.retention).slice(off, off + lim);
      }
      return { total: matched.length, items };
    }

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
    const freshness = this.checkDiskFreshness({ force: true });

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
      dataStale: freshness.dataStale,
      freshness,
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
    let maxMtimeMs = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const dirName of [...VALID_LAYERS, "archive"]) {
        const fullDir = path.join(this.vaultDir, dirName);
        if (!fs.existsSync(fullDir)) continue;
        for (const f of fs.readdirSync(fullDir).filter((x) => x.endsWith(".md"))) {
          const filePath = path.join(fullDir, f);
          try {
            const st = fs.statSync(filePath);
            if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
          } catch {}
          const raw = fs.readFileSync(filePath, "utf8");
          const { meta, body } = parseFrontmatter(raw);
          const id = meta.id ? sanitizeId(meta.id) : sanitizeId(f.slice(0, -3));
          const layer = dirName === "archive" ? (VALID_LAYERS.includes(meta.layer) ? meta.layer : "episodic") : dirName;
          const lifecycle = dirName === "archive" ? "archived" : (meta.lifecycle_state || "active");
          const title = extractTitle(meta, body, id);
          const ts = nowSec();
          const extraObj = {};
          for (const k of EXTRA_META_KEYS) {
            if (meta[k] !== undefined) extraObj[k] = meta[k];
          }
          const importance = clampNum(meta.importance ?? 0.5, 0, 1);
          const isProtected = isNodeProtected({ ...meta, layer, importance, extra: extraObj }, this.config);

          const node = {
            id, layer, title, body,
            tags_json: JSON.stringify(Array.isArray(meta.tags) ? meta.tags : []),
            aliases_json: JSON.stringify(Array.isArray(meta.aliases) ? meta.aliases : []),
            importance,
            protected: isProtected ? 1 : 0,
            confidence: clampNum(meta.confidence ?? 0.6, 0, 1),
            lifecycle_state: lifecycle,
            verification_state: String(meta.verification_state || (isProtected ? "verified" : "unverified")),
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
            extra_json: JSON.stringify(extraObj),
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

    this.markIndexFresh(Math.max(Date.now(), maxMtimeMs));
    this.checkpointWal("TRUNCATE");
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

    this.markIndexFresh();
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

  importFromDsh(sourceDir) {
    return this.importFromVault(sourceDir || path.join(HOME, ".dsh", ".dsh-memory", "data", "mdcg"));
  }

  // ===== .bak Auto Snapshot & Rollback =====
  get backupsDir() {
    return path.join(this.vaultDir, ".backups");
  }

  createNodeBackup(row) {
    try {
      if (!row?.id || !row.file_path || !fs.existsSync(row.file_path)) return null;
      ensureDir(this.backupsDir);
      const safeId = sanitizeId(row.id);
      const stamp = Date.now();
      const bakName = `${safeId}.${stamp}.bak.md`;
      const bakPath = path.join(this.backupsDir, bakName);
      fs.copyFileSync(row.file_path, bakPath);

      // Retain only latest 5 backups per node
      const prefix = `${safeId}.`;
      const all = fs
        .readdirSync(this.backupsDir)
        .filter((f) => f.startsWith(prefix) && f.endsWith(".bak.md"))
        .sort();
      while (all.length > 5) {
        const oldest = all.shift();
        try { fs.unlinkSync(path.join(this.backupsDir, oldest)); } catch {}
      }
      return bakName;
    } catch {
      return null;
    }
  }

  listBackups(id) {
    try {
      if (!id || !fs.existsSync(this.backupsDir)) return [];
      const safeId = sanitizeId(id);
      const prefix = `${safeId}.`;
      return fs
        .readdirSync(this.backupsDir)
        .filter((f) => f.startsWith(prefix) && f.endsWith(".bak.md"))
        .sort()
        .reverse()
        .map((file) => {
          const full = path.join(this.backupsDir, file);
          let size = 0;
          let mtimeMs = 0;
          try {
            const st = fs.statSync(full);
            size = st.size;
            mtimeMs = st.mtimeMs;
          } catch {}
          return { file, size, mtimeMs };
        });
    } catch {
      return [];
    }
  }

  rollbackMemory(id, backupFile = null) {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(String(id || ""));
    if (!row) throw new Error(`未找到记忆节点: ${id}`);
    const backups = this.listBackups(row.id);
    if (backups.length === 0) throw new Error(`节点 ${row.id} 暂无可回滚的 .bak 快照`);
    const target = backupFile
      ? backups.find((b) => b.file === path.basename(String(backupFile)))
      : backups[0];
    if (!target) throw new Error(`未找到指定快照: ${backupFile}`);

    const bakPath = path.join(this.backupsDir, target.file);
    const raw = fs.readFileSync(bakPath, "utf8");
    const parsed = parseFrontmatter(raw);
    const restoredBody = String(parsed.body || "").trim();
    if (!restoredBody) throw new Error("快照正文为空，无法回滚");

    const restoredLayer = VALID_LAYERS.includes(parsed.meta?.layer) ? parsed.meta.layer : row.layer;
    const restoredTitle = String(parsed.meta?.title || row.title || row.id).trim();
    const restoredTags = Array.isArray(parsed.meta?.tags) ? parsed.meta.tags.map(String) : safeJsonParse(row.tags_json, []);
    const restoredImp =
      parsed.meta?.importance !== undefined ? clampNum(parsed.meta.importance, 0, 1) : Number(row.importance);

    // Save current version as a backup before rolling back
    this.createNodeBackup(row);

    const ts = nowSec();
    const updated = {
      ...row,
      layer: restoredLayer,
      title: restoredTitle,
      body: restoredBody,
      tags_json: JSON.stringify(restoredTags),
      importance: restoredImp,
      updated_at: ts,
      content_hash: sha256Short(`${restoredLayer}\n${restoredBody}`),
    };

    if (restoredLayer !== row.layer && row.file_path && fs.existsSync(row.file_path)) {
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
    this.markIndexFresh(Math.max(Date.now(), Math.ceil(ts * 1000)));
    this.logAudit("rollback", updated.id, { restoredFrom: target.file });
    return { restoredFrom: target.file, node: this.readMemory(updated.id) };
  }

  // ===== Project Knowledge Briefing (Project Living Map) =====
  listProjects() {
    const rows = this.db.prepare("SELECT extra_json FROM nodes WHERE lifecycle_state = 'active'").all();
    const counts = new Map();
    for (const r of rows) {
      const proj = String(safeJsonParse(r.extra_json, {})?.project || "").trim();
      if (proj) counts.set(proj, (counts.get(proj) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([project, count]) => ({ project, count }));
  }

  buildProjectBriefing(project, { maxChars = 900 } = {}) {
    const projName = String(project || "").trim();
    if (!projName) {
      return { project: "", nodeCount: 0, text: "", sections: {} };
    }
    const all = this.db
      .prepare("SELECT * FROM nodes WHERE lifecycle_state = 'active' ORDER BY importance DESC, updated_at DESC")
      .all();

    const projLower = projName.toLowerCase();
    const matched = all.filter((r) => {
      const extra = safeJsonParse(r.extra_json, {});
      if (String(extra?.project || "").trim().toLowerCase() === projLower) return true;
      const tags = safeJsonParse(r.tags_json, []);
      return tags.some((t) => String(t).toLowerCase() === `项目:${projLower}`);
    });

    if (matched.length === 0) {
      return { project: projName, nodeCount: 0, text: "", sections: {} };
    }

    const pick = (layer, limit) =>
      matched
        .filter((r) => r.layer === layer)
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          title: r.title,
          snippet: String(r.body || "").replace(/\s+/g, " ").trim().slice(0, 120),
          extra: safeJsonParse(r.extra_json, {}),
        }));

    const structural = pick("structural", 3);
    const goals = pick("goals", 3).filter((g) => (g.extra?.status || "active") === "active");
    const unresolved = pick("unresolved", 2);
    const knowledge = pick("knowledge", 3);

    const lines = [`【项目活地图：${projName}】（共关联 ${matched.length} 条记忆）`];
    if (structural.length) {
      lines.push("▪ 架构与规范：");
      structural.forEach((n) => lines.push(`  - [${n.id}] ${n.title}: ${n.snippet}`));
    }
    if (goals.length) {
      lines.push("▪ 进行中目标：");
      goals.forEach((g) => lines.push(`  - ${g.title}（进度 ${g.extra?.progress ?? 0}%）`));
    }
    if (unresolved.length) {
      lines.push("▪ 待解决疑点：");
      unresolved.forEach((n) => lines.push(`  - [${n.id}] ${n.title}: ${n.snippet}`));
    }
    if (knowledge.length) {
      lines.push("▪ 核心知识与避坑：");
      knowledge.forEach((n) => lines.push(`  - [${n.id}] ${n.title}: ${n.snippet}`));
    }

    let text = lines.join("\n");
    if (text.length > maxChars) {
      text = text.slice(0, maxChars - 1) + "…";
    }
    return {
      project: projName,
      nodeCount: matched.length,
      text,
      sections: { structural, goals, unresolved, knowledge },
    };
  }

  // ===== External Knowledge Sources (Incremental FTS5 Sync) =====
  listExternalSources() {
    const cfg = this.loadConfig();
    const list = Array.isArray(cfg.externalSources) ? cfg.externalSources : [];
    return list.map((s) => {
      const docCount = this.db.prepare("SELECT COUNT(*) AS c FROM external_docs WHERE source_id = ?").get(s.id)?.c || 0;
      const chunkCount = this.db.prepare("SELECT COUNT(*) AS c FROM external_chunks WHERE source_id = ?").get(s.id)?.c || 0;
      return {
        ...s,
        exists: Boolean(s.path && fs.existsSync(s.path)),
        fileCount: Number(docCount),
        chunkCount: Number(chunkCount),
      };
    });
  }

  addExternalSource({ dirPath, path: rawPath, label = "", project = "" } = {}) {
    const targetPath = path.resolve(String(dirPath || rawPath || "").trim());
    if (!targetPath || !fs.existsSync(targetPath)) {
      throw new Error(`外部知识目录不存在: ${targetPath}`);
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      throw new Error(`指定路径不是文件夹: ${targetPath}`);
    }
    const cfg = this.loadConfig();
    const list = Array.isArray(cfg.externalSources) ? [...cfg.externalSources] : [];
    const norm = targetPath.toLowerCase();
    const existing = list.find((s) => path.resolve(String(s.path || "")).toLowerCase() === norm);
    if (existing) {
      existing.label = String(label || existing.label || path.basename(targetPath)).trim();
      existing.project = String(project ?? existing.project ?? "").trim();
      existing.enabled = true;
      cfg.externalSources = list;
      this.saveConfig(cfg);
      const sync = this.syncExternalSources({ sourceId: existing.id });
      return { source: existing, sync };
    }

    const src = {
      id: `ext_${sha256Short(targetPath)}`,
      path: targetPath,
      label: String(label || path.basename(targetPath) || "外部知识库").trim(),
      project: String(project || "").trim(),
      enabled: true,
      lastSyncedAt: 0,
      fileCount: 0,
      chunkCount: 0,
    };
    list.push(src);
    cfg.externalSources = list;
    this.saveConfig(cfg);
    const sync = this.syncExternalSources({ sourceId: src.id });
    this.logAudit("add_external_source", src.id, { path: targetPath, label: src.label });
    return { source: src, sync };
  }

  toggleExternalSource(sourceId, enabled) {
    const cfg = this.loadConfig();
    const list = Array.isArray(cfg.externalSources) ? [...cfg.externalSources] : [];
    const target = list.find((s) => s.id === sourceId);
    if (!target) throw new Error(`未找到外部知识源: ${sourceId}`);
    target.enabled = Boolean(enabled);
    cfg.externalSources = list;
    this.saveConfig(cfg);
    if (!target.enabled) {
      deleteExternalSourceData(this.db, sourceId);
    } else {
      this.syncExternalSources({ sourceId });
    }
    return this.listExternalSources();
  }

  removeExternalSource(sourceId) {
    const cfg = this.loadConfig();
    const list = Array.isArray(cfg.externalSources) ? cfg.externalSources.filter((s) => s.id !== sourceId) : [];
    cfg.externalSources = list;
    this.saveConfig(cfg);
    deleteExternalSourceData(this.db, sourceId);
    this.logAudit("remove_external_source", sourceId, {});
    return this.listExternalSources();
  }

  syncExternalSources({ sourceId = null, force = false } = {}) {
    return syncExtSourcesImpl(this, { sourceId, force, tokenizeForFts });
  }

  searchExternalKnowledge(query, { project = "", limit = 4 } = {}) {
    return searchExternalChunks(this.db, query, { project, limit, extractQueryTerms });
  }
}

export { LanxiEngine as LingshuCortexEngine };

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
