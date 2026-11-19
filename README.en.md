# Lanxi Memory (蓝汐 · 潮汐认知图谱)

**English** | [简体中文](README.md)

> **Local-first, zero-dependency cognitive graph memory plugin for Google Antigravity — 5-layer Markdown vault + CJK FTS5 + Tidal forgetting curves + Optional AI semantic enhancement + Tidal Starfield UI.**

**Lanxi Memory** is a local-first long-term memory and cognitive graph plugin built natively for **Google Antigravity**. It combines human-readable Markdown source-of-truth notes with power-law / exponential tidal forgetting curves: core decisions and anchors stay permanently protected, while episodic context gradually fades over time and rises again when recalled — without ever silently deleting your files.

---

## ✨ Key Features

- **Zero External Dependencies**: Powered purely by Node.js (`>= 22.0.0`) built-in `node:sqlite` (WAL + FTS5) and native `fetch` — no Python, Docker, or external vector database required.
- **5-Layer Cognitive Vault & Anti-Pollute Hard Protection**:
  - `anchor` (permanent anchors), `self` (self-reflection), `goals` (long-term goals): permanently protected (`retention = 1.0`) with layer-downgrade protection.
  - `structural` (architecture/rules) & `knowledge` (domain knowledge): writes with `importance >= 0.7` can be hard-protected; optional `writeGate` prevents unconfirmed AI `hint` scores from self-locking.
  - `episodic` (default landing layer): unlayered writes default to `episodic` instead of polluting `knowledge`; decays smoothly along the tidal curve and can be promoted, consolidated, or batch-confirmed via maintenance.
  - `unresolved`: open questions and pending investigations.
- **Disk-as-Truth Staleness Detection (`dataStale`)**: Detects out-of-band edits or new `.md` files in `vault/` and surfaces a sync banner in the UI & `cg_stats`.
- **Project-Aware Recall & Token-Saving Hooks**: Auto-tags workspace `project` context for boosted per-project recall; `SessionStart` (startup anchors, on by default) and `PreInvocation` (per-turn auto-recall, off by default in favor of on-demand `cg_recall`) have independent UI toggles plus a 3-tier term-coverage threshold (`strict` / `balanced` / `loose`) to prevent noisy false positives and context bloat.
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
| `cg_write` | Persist a memory node (defaults to `episodic`; supports `project`, `importanceSource`, `rejection_reason`) |
| `cg_recall` | Tidal + project-weighted recall (blends FTS5 + semantic vectors when Embedding API is enabled) |
| `cg_read` | Read full node Markdown, retention score, edges, and disk sync state |
| `cg_update` | Update content, layer, aliases, or importance (enforces protection & layer guard) |
| `cg_forget` | Explicitly archive a node to `vault/archive/` (never deletes silently) |
| `cg_link` | Create directed semantic relations between nodes (persisted in SQLite + frontmatter) |
| `cg_graph` | Fetch global or ego-centered subgraph nodes and edges |
| `cg_goal` | List or upsert long-term goals (`goals` layer) |
| `cg_reflect` | Record metacognitive reflections (`self`) or open questions (`unresolved`) |
| `cg_maintain` | Maintenance actions: `queue`, `promote`, `touch`, `set_importance`, `consolidate`, `ai_consolidate`, `backfill_embeddings`, `rebuild` |
| `cg_stats` | Get overview KPIs, tide breakdown, `dataStale` freshness, and masked config |
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
