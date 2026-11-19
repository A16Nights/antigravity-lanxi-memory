# Lanxi Memory (蓝汐 · 潮汐认知图谱)

**English** | [简体中文](README.md)

> **Local-first, zero-dependency cognitive graph memory plugin for Google Antigravity — 5-layer Markdown vault + CJK FTS5 + Tidal forgetting curves + Optional AI semantic enhancement + Tidal Starfield UI.**

**Lanxi Memory** is a local-first long-term memory and cognitive graph plugin built natively for **Google Antigravity**. It combines human-readable Markdown source-of-truth notes with power-law / exponential tidal forgetting curves: core decisions and anchors stay permanently protected, while episodic context gradually fades over time and rises again when recalled — without ever silently deleting your files.

---

## ✨ Key Features

- **Zero External Dependencies**: Powered purely by Node.js (`>= 22.0.0`) built-in `node:sqlite` (WAL + FTS5) and native `fetch` — no Python, Docker, or external vector database required.
- **5-Layer Cognitive Vault & Hard Protection**:
  - `anchor` (permanent anchors), `self` (self-reflection), `goals` (long-term goals): permanently protected (`retention = 1.0`), immune to decay.
  - `structural` (architecture/rules) & `knowledge` (domain knowledge): writes with `importance >= 0.7` are auto-protected; downgrading or archiving requires explicit `override: true`.
  - `episodic` (session context): decays smoothly along the tidal curve and gets reinforced on recall or `touch`; high-value clusters can be promoted or synthesized into `knowledge`.
  - `unresolved`: open questions and pending investigations.
- **CJK + ASCII FTS5 Search**: Custom CJK 2-gram + ASCII tokenizer indexed into SQLite FTS5 for millisecond recall across Chinese and English queries.
- **Noise-Filtered Lifecycle Hooks**:
  - `SessionStart`: injects identity anchors and active goals.
  - `PreInvocation`: strips conversational filler words to prevent noisy false-positive recalls on short casual chats, plus a customizable 10-turn archival reminder.
  - `Stop`: redacts common secrets/tokens before recording concise episodic summaries; always fails open (`{"decision": "allow"}`).
- **Original "Tidal Starfield" Sidecar UI**:
  - Concentric orbital starfield canvas (drag, zoom, hover tooltips, click-to-inspect & link), Tidal Horizon distribution bar, hybrid memory stream, anchors/goals manager, and maintenance workbench (available both in the Antigravity side pane and full-screen in any browser).
- **Optional AI Enhancement (Off by Default)**:
  - Bring your own OpenAI-compatible API key to unlock **Hybrid Semantic Search (FTS5 + Cosine Similarity)** and **AI Smart Consolidation** (draft & review synthesis of multiple episodic notes into one knowledge node). Runs 100% offline if unconfigured.

---

## 🚀 Installation

> Prerequisite: **Node.js >= 22.0.0** (with built-in `node:sqlite`).

### Option A: Git Clone (Recommended)
```bash
# macOS / Linux
git clone https://github.com/A16Nights/lanxi-memory.git ~/.gemini/config/plugins/lanxi-memory

# Windows PowerShell
git clone https://github.com/A16Nights/lanxi-memory.git "$env:USERPROFILE\.gemini\config\plugins\lanxi-memory"
```

### Option B: Download Release Zip
1. Download the latest `lanxi-memory-v*.zip` from [GitHub Releases](https://github.com/A16Nights/lanxi-memory/releases/latest).
2. Extract it into your Antigravity plugins folder (`~/.gemini/config/plugins/` on macOS/Linux or `%USERPROFILE%\.gemini\config\plugins\` on Windows).

### Activate
Restart **Google Antigravity** completely, verify **Lanxi Memory** is enabled under **Customizations**, or click `[蓝汐 · 潮汐星海](sidecar://lanxi-memory/starfield/)` to open the Starfield Workbench.

---

## 🧰 MCP Tools (12 Tools)

| Tool | Description |
| --- | --- |
| `cg_write` | Persist a memory node to Markdown + FTS5 (deduplicates and auto-protects `importance >= 0.7`) |
| `cg_recall` | Tidal-weighted recall (automatically blends FTS5 + semantic vectors when Embedding API is enabled) |
| `cg_read` | Read full node Markdown, retention score, incoming/outgoing edges, and disk file path |
| `cg_update` | Update node content, layer, or importance (enforces protection guard) |
| `cg_forget` | Explicitly archive a node to `vault/archive/` (never deletes silently) |
| `cg_link` | Create directed semantic relations between nodes (persisted in SQLite + frontmatter) |
| `cg_graph` | Fetch global or ego-centered subgraph nodes and edges |
| `cg_goal` | List or upsert long-term goals (`goals` layer) |
| `cg_reflect` | Record metacognitive reflections (`self`) or open questions (`unresolved`) |
| `cg_maintain` | Maintenance actions: `queue`, `promote`, `touch`, `consolidate`, `ai_consolidate`, `backfill_embeddings`, `rebuild` |
| `cg_stats` | Get overview KPIs, tide breakdown, layer counts, and masked config |
| `cg_import_vault` | Strictly read-only import from external Markdown folders, Obsidian Vaults (`[[wiki-links]]`), or DSH `mdcg` |

---

## ✨ Optional AI Configuration

All external AI features are disabled by default. Configure them in **Maintenance → Optional AI Enhancement**, or via environment variables:

- `LANXI_LLM_API_KEY`: OpenAI-compatible `/chat/completions` key for AI Smart Consolidation
- `LANXI_EMBEDDING_API_KEY`: OpenAI-compatible `/embeddings` key for hybrid semantic search

> Keys are stored locally in `~/.gemini/lanxi-memory/config.json` and are always masked in API responses and UI fields.

---

## 🔒 Privacy & Testing

- 100% local-first: Markdown source files live in `~/.gemini/lanxi-memory/vault/` and indexes in `~/.gemini/lanxi-memory/index.sqlite`.
- Zero network requests unless you explicitly enable and configure an AI endpoint.
- Run automated tests: `npm test` (uses isolated temporary directories and an in-process mock OpenAI server).

---

## 💡 Inspiration & Credits

This plugin is an independent native implementation for Google Antigravity, inspired by:
- [dsh-memory](https://github.com/FuRongJun-1999/dsh-memory) — 5-layer Markdown cognitive graph, hard protection guardrails, and deterministic rule philosophy
- [CortexGraph](https://github.com/prefrontal-systems/cortexgraph) — human-like power-law forgetting curves and access reinforcement

MIT License © 2026 A16Nights
