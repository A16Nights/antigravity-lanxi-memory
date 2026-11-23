import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const EXT_ALLOW = new Set([".md", ".mdx", ".txt"]);
const SKIP_DIRS = new Set([".git", "node_modules", ".obsidian", ".trash", ".backups"]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_CHUNK_CHARS = 1100;

export function initExternalSourceTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_docs (
      doc_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      title TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      content_hash TEXT NOT NULL,
      chunk_count INTEGER DEFAULT 0,
      updated_at REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ext_docs_source ON external_docs(source_id);

    CREATE TABLE IF NOT EXISTS external_chunks (
      chunk_id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_label TEXT NOT NULL,
      file_path TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      title TEXT NOT NULL,
      heading TEXT NOT NULL,
      body TEXT NOT NULL,
      project TEXT DEFAULT '',
      updated_at REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ext_chunks_doc ON external_chunks(doc_id);
    CREATE INDEX IF NOT EXISTS idx_ext_chunks_source ON external_chunks(source_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS external_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      search_text
    );
  `);
}

function shaShort(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex").slice(0, 16);
}

function walkReadableFiles(rootDir, baseDir = rootDir, out = [], depth = 0) {
  if (depth > 8 || !fs.existsSync(rootDir)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".") || SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(rootDir, ent.name);
    if (ent.isDirectory()) {
      walkReadableFiles(full, baseDir, out, depth + 1);
    } else if (ent.isFile() && EXT_ALLOW.has(path.extname(ent.name).toLowerCase())) {
      try {
        const st = fs.statSync(full);
        if (st.size > 0 && st.size <= MAX_FILE_BYTES) {
          out.push({
            filePath: full,
            relPath: path.relative(baseDir, full).replace(/\\/g, "/"),
            mtimeMs: st.mtimeMs,
          });
        }
      } catch {}
    }
  }
  return out;
}

export function chunkMarkdownDocument(rawText, fallbackTitle) {
  const clean = String(rawText || "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];

  // Strip YAML frontmatter if present
  const body = clean.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const h1Match = body.match(/^#\s+(.+)$/m);
  const docTitle = (h1Match ? h1Match[1].trim() : fallbackTitle).slice(0, 100);

  const lines = body.split("\n");
  const sections = [];
  let curHeading = docTitle;
  let curLines = [];

  for (const line of lines) {
    const m = line.match(/^#{1,3}\s+(.+)$/);
    if (m) {
      if (curLines.join("\n").trim()) {
        sections.push({ heading: curHeading, text: curLines.join("\n").trim() });
      }
      curHeading = m[1].trim().slice(0, 100);
      curLines = [];
    } else {
      curLines.push(line);
    }
  }
  if (curLines.join("\n").trim()) {
    sections.push({ heading: curHeading, text: curLines.join("\n").trim() });
  }
  if (sections.length === 0) {
    sections.push({ heading: docTitle, text: body });
  }

  const chunks = [];
  const seenHashes = new Set();

  for (const sec of sections) {
    const text = sec.text;
    if (text.length <= MAX_CHUNK_CHARS) {
      const h = shaShort(`${sec.heading}\n${text}`);
      if (!seenHashes.has(h)) {
        seenHashes.add(h);
        chunks.push({ title: docTitle, heading: sec.heading, body: text });
      }
      continue;
    }
    // Split oversized section by paragraphs
    const paras = text.split(/\n{2,}/);
    let buf = "";
    let part = 1;
    for (const p of paras) {
      if (buf && buf.length + p.length + 2 > MAX_CHUNK_CHARS) {
        const h = shaShort(`${sec.heading}\n${buf}`);
        if (!seenHashes.has(h)) {
          seenHashes.add(h);
          chunks.push({ title: docTitle, heading: `${sec.heading} (${part})`, body: buf.trim() });
          part++;
        }
        buf = p.slice(0, MAX_CHUNK_CHARS);
      } else {
        buf = buf ? `${buf}\n\n${p}` : p.slice(0, MAX_CHUNK_CHARS);
      }
    }
    if (buf.trim()) {
      const h = shaShort(`${sec.heading}\n${buf}`);
      if (!seenHashes.has(h)) {
        seenHashes.add(h);
        chunks.push({ title: docTitle, heading: part > 1 ? `${sec.heading} (${part})` : sec.heading, body: buf.trim() });
      }
    }
  }

  return chunks;
}

export function syncExternalSources(engine, { sourceId = null, force = false, tokenizeForFts } = {}) {
  const cfg = engine.loadConfig();
  const sources = Array.isArray(cfg.externalSources) ? cfg.externalSources : [];
  const targets = sourceId ? sources.filter((s) => s.id === sourceId) : sources.filter((s) => s.enabled !== false);

  const db = engine.db;
  const now = Date.now() / 1000;
  const summary = {
    syncedSources: 0,
    filesScanned: 0,
    filesUpdated: 0,
    filesSkipped: 0,
    filesRemoved: 0,
    chunksIndexed: 0,
    errors: [],
  };

  const stmtGetDoc = db.prepare("SELECT * FROM external_docs WHERE doc_id = ?");
  const stmtUpsertDoc = db.prepare(`
    INSERT INTO external_docs (doc_id, source_id, file_path, rel_path, title, mtime_ms, content_hash, chunk_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_id) DO UPDATE SET
      file_path = excluded.file_path,
      rel_path = excluded.rel_path,
      title = excluded.title,
      mtime_ms = excluded.mtime_ms,
      content_hash = excluded.content_hash,
      chunk_count = excluded.chunk_count,
      updated_at = excluded.updated_at
  `);
  const stmtDelChunksByDoc = db.prepare("DELETE FROM external_chunks WHERE doc_id = ?");
  const stmtGetChunkIdsByDoc = db.prepare("SELECT chunk_id FROM external_chunks WHERE doc_id = ?");
  const stmtDelFts = db.prepare("DELETE FROM external_chunks_fts WHERE chunk_id = ?");
  const stmtInsertChunk = db.prepare(`
    INSERT INTO external_chunks (chunk_id, doc_id, source_id, source_label, file_path, rel_path, title, heading, body, project, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtInsertFts = db.prepare("INSERT INTO external_chunks_fts (chunk_id, search_text) VALUES (?, ?)");
  const stmtDelDoc = db.prepare("DELETE FROM external_docs WHERE doc_id = ?");

  for (const src of targets) {
    const dir = String(src.path || "").trim();
    if (!dir || !fs.existsSync(dir)) {
      summary.errors.push({ sourceId: src.id, path: dir, error: "目录不存在或不可访问" });
      continue;
    }

    const files = walkReadableFiles(dir);
    summary.syncedSources++;
    summary.filesScanned += files.length;

    const activeDocIds = new Set();
    let srcChunkTotal = 0;

    for (const f of files) {
      const docId = `extdoc_${shaShort(`${src.id}:${f.relPath}`)}`;
      activeDocIds.add(docId);

      const prev = stmtGetDoc.get(docId);
      if (!force && prev && Math.abs(Number(prev.mtime_ms) - f.mtimeMs) < 5) {
        summary.filesSkipped++;
        srcChunkTotal += Number(prev.chunk_count || 0);
        continue;
      }

      let raw = "";
      try {
        raw = fs.readFileSync(f.filePath, "utf8");
      } catch (err) {
        summary.errors.push({ sourceId: src.id, file: f.relPath, error: err.message });
        continue;
      }

      const contentHash = shaShort(raw);
      if (!force && prev && prev.content_hash === contentHash) {
        stmtUpsertDoc.run(docId, src.id, f.filePath, f.relPath, prev.title, f.mtimeMs, contentHash, prev.chunk_count, now);
        summary.filesSkipped++;
        srcChunkTotal += Number(prev.chunk_count || 0);
        continue;
      }

      // Remove old chunks & FTS
      const oldChunks = stmtGetChunkIdsByDoc.all(docId);
      for (const oc of oldChunks) stmtDelFts.run(oc.chunk_id);
      stmtDelChunksByDoc.run(docId);

      const fallbackTitle = path.basename(f.relPath, path.extname(f.relPath));
      const chunks = chunkMarkdownDocument(raw, fallbackTitle);
      const docTitle = chunks[0]?.title || fallbackTitle;
      const srcLabel = src.label || path.basename(dir) || src.id;
      const proj = String(src.project || "").trim();

      chunks.forEach((ch, idx) => {
        const chunkId = `${docId}_c${idx}`;
        stmtInsertChunk.run(
          chunkId,
          docId,
          src.id,
          srcLabel,
          f.filePath,
          f.relPath,
          ch.title,
          ch.heading,
          ch.body,
          proj,
          now
        );
        const ftsText = tokenizeForFts(`${ch.title} ${ch.heading} ${f.relPath} ${ch.body}`);
        stmtInsertFts.run(chunkId, ftsText);
      });

      stmtUpsertDoc.run(docId, src.id, f.filePath, f.relPath, docTitle, f.mtimeMs, contentHash, chunks.length, now);
      summary.filesUpdated++;
      summary.chunksIndexed += chunks.length;
      srcChunkTotal += chunks.length;
    }

    // Remove deleted files
    const existingDocs = db.prepare("SELECT doc_id FROM external_docs WHERE source_id = ?").all(src.id);
    for (const d of existingDocs) {
      if (!activeDocIds.has(d.doc_id)) {
        const oldChunks = stmtGetChunkIdsByDoc.all(d.doc_id);
        for (const oc of oldChunks) stmtDelFts.run(oc.chunk_id);
        stmtDelChunksByDoc.run(d.doc_id);
        stmtDelDoc.run(d.doc_id);
        summary.filesRemoved++;
      }
    }

    src.lastSyncedAt = now;
    src.fileCount = files.length;
    src.chunkCount = srcChunkTotal;
  }

  engine.saveConfig(cfg);
  return summary;
}

export function deleteExternalSourceData(db, sourceId) {
  const chunks = db.prepare("SELECT chunk_id FROM external_chunks WHERE source_id = ?").all(sourceId);
  const stmtDelFts = db.prepare("DELETE FROM external_chunks_fts WHERE chunk_id = ?");
  for (const c of chunks) stmtDelFts.run(c.chunk_id);
  db.prepare("DELETE FROM external_chunks WHERE source_id = ?").run(sourceId);
  db.prepare("DELETE FROM external_docs WHERE source_id = ?").run(sourceId);
}

export function searchExternalChunks(db, query, { project = "", limit = 4, extractQueryTerms } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];

  const terms = extractQueryTerms(q, { filterStopwords: true });
  if (!terms.length) return [];

  const ftsQuery = terms
    .slice(0, 8)
    .map((t) => `"${t.replace(/"/g, "")}"`)
    .join(" OR ");

  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT c.*, bm25(external_chunks_fts) AS rank
         FROM external_chunks_fts f
         JOIN external_chunks c ON c.chunk_id = f.chunk_id
         WHERE external_chunks_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(ftsQuery, Math.max(limit * 3, 12));
  } catch {
    return [];
  }

  const projLower = String(project || "").trim().toLowerCase();
  const scored = rows.map((r) => {
    const hay = `${r.title} ${r.heading} ${r.rel_path} ${r.body}`.toLowerCase();
    let matched = 0;
    for (const t of terms) {
      if (hay.includes(t.toLowerCase())) matched++;
    }
    const coverage = matched / terms.length;
    let score = Math.min(1, coverage * 0.85 + Math.max(0, 1 / (1 + Math.abs(Number(r.rank || 0)))) * 0.15);
    if (projLower && String(r.project || "").toLowerCase() === projLower) {
      score = Math.min(1, score + 0.12);
    }
    return {
      id: r.chunk_id,
      layer: "external",
      source_id: r.source_id,
      source_label: r.source_label,
      file_path: r.file_path,
      rel_path: r.rel_path,
      title: `${r.title} · ${r.heading}`,
      preview: String(r.body || "").replace(/\s+/g, " ").trim().slice(0, 220),
      body: r.body,
      project: r.project || "",
      score: Number(score.toFixed(3)),
    };
  });

  return scored
    .filter((s) => s.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
