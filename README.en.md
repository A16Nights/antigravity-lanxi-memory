<div align="center">

<p>🌐 &nbsp; <a href="README.md">简体中文</a> &nbsp;·&nbsp; <strong>English</strong></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/hero-en-dark.svg">
  <img src="assets/readme/hero-en-light.svg" alt="Lanxi Memory — Cognitive Graph Memory" width="100%">
</picture>

<p>
  <a href="https://github.com/A16Nights/antigravity-lanxi-memory/releases"><img src="https://img.shields.io/github/v/release/A16Nights/antigravity-lanxi-memory?style=flat-square&label=Release&color=a855f7&labelColor=1e293b" alt="Release"></a>
  <a href="https://github.com/A16Nights/antigravity-lanxi-memory/stargazers"><img src="https://img.shields.io/github/stars/A16Nights/antigravity-lanxi-memory?style=flat-square&label=Stars&color=f59e0b&labelColor=1e293b" alt="Stars"></a>
  <img src="https://img.shields.io/badge/Google_Antigravity-Native_Plugin-a855f7?style=flat-square&labelColor=1e293b" alt="Antigravity">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.0.0-10b981?style=flat-square&labelColor=1e293b" alt="Node.js">
  <img src="https://img.shields.io/badge/Dependencies-Zero-06b6d4?style=flat-square&labelColor=1e293b" alt="Zero Deps">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-6366f1?style=flat-square&labelColor=1e293b" alt="License"></a>
</p>

<p>
  <strong>Lanxi Memory — Cognitive Graph Memory · Local-first 5-layer Markdown truth vault + CJK FTS5 + tidal forgetting curves + interactive Starfield UI with zero dependencies</strong>
</p>

<p>
  <a href="#features">✨ Features</a> &nbsp;·&nbsp; <a href="#architecture">🧩 Architecture</a> &nbsp;·&nbsp; <a href="#installation">🚀 Quick Start</a> &nbsp;·&nbsp; <a href="#mcp-tools">🧰 MCP Tools</a> &nbsp;·&nbsp; <a href="#storage">📂 Storage</a> &nbsp;·&nbsp; <a href="#azure-suite">🌌 Azure Suite</a>
</p>

</div>

**Lanxi Memory** is a local-first long-term memory and cognitive graph plugin for **Google Antigravity**. It blends a human-readable 5-layer Markdown vault with power-law / exponential tidal forgetting curves: core anchors and long-term goals never decay, episodic events ebb naturally unless reinforced by recall, and every archive keeps full Markdown files—**never silently deleting memories**.

<table>
<tr>
<td width="50%" valign="top">
<h4>🏛️ 5-Layer Graph & Hard Protection</h4>
Permanent anchors (<code>anchor</code>/<code>self</code>/<code>goals</code>) stay at <code>retention = 1.0</code>; high-importance nodes (<code>>= 0.7</code>) trigger hard protection against accidental archival or demotion.
</td>
<td width="50%" valign="top">
<h4>🌊 Markdown Truth & CJK FTS5</h4>
Built on <code>node:sqlite</code> WAL with CJK bigram FTS5. Edit <code>vault/*.md</code> directly in VS Code or Obsidian with live <code>dataStale</code> detection and one-click reindexing.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<h4>🌌 Interactive Tidal Starfield UI</h4>
Concentric orbital Canvas graph (anchors → knowledge → episodic) with pan/zoom, edge highlighting, visual linking, and a Tidal Maintenance console.
</td>
<td width="50%" valign="top">
<h4>✨ 100% Offline + Optional AI Boost</h4>
Works completely offline with zero API keys; optionally connect any OpenAI-compatible endpoint for hybrid FTS5 + cosine vector search and AI episodic distillation.
</td>
</tr>
</table>

<h2 id="features">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/sec-features-en-dark.svg">
  <img src="assets/readme/sec-features-en-light.svg" alt="Feature Overview" width="100%">
</picture>
</h2>

### 1. Five-Layer Cognitive Structure & Hard Protection
- **Permanent Anchor Layers (`retention = 1.0`)**:
  - `anchor`: Inviolable global boundaries and cross-project rules;
  - `self`: Long-term collaboration preferences and metacognitive reflections;
  - `goals`: Persistent multi-session milestones and objectives.
- **High-Value Knowledge Layers (`importance >= 0.7` Hard Protection)**:
  - `structural`: Architecture decisions, module boundaries, and engineering contracts;
  - `knowledge`: Reusable technical solutions, debugging findings, and configuration notes;
  - **Anti-Amnesia Hard Protection**: Archiving or demoting nodes with `importance >= 0.7` requires explicit confirmation (`override: true` or in-panel modal); optional `writeGate` prevents unconfirmed auto-locks.
- **Tidal Flow Layers**:
  - `episodic` (**default safe layer**): Follows tidal forgetting curves, rises on access reinforcement, and can be promoted to `knowledge` / `structural` in one click;
  - `unresolved`: Tracks open technical mysteries and pending follow-ups.

### 2. Disk-as-Truth (`dataStale`) & CJK FTS5 Engine
- **Native SQLite WAL + CJK FTS5**: Powered solely by Node.js (`>= 22.0.0`) built-in `node:sqlite` with CJK bigram tokenization, English stemming, and code identifier matching.
- **External Edit Awareness**: Edit `vault/*.md` freely in Obsidian or VS Code; the top bar automatically detects file changes and prompts a one-click index rebuild.

### 3. Smart Lifecycle Hooks & Persona Memory Gate
- **`SessionStart`**: Automatically wakes permanent anchors, active goals, and top project memories.
- **`PreInvocation`**: On-demand recall with `strict / balanced / loose` noise-suppression thresholds, periodic long-session archival reminders, and automatic synchronization with **[Soul.md](https://github.com/A16Nights/antigravity-soul-md)** per-persona memory toggles.

### 4. Tidal Starfield Visual Workbench (Sidecar + Web UI)
- **Balanced Two-Row Header**: Clean title, status badges, and Azure Suite toolbar on row 1; 5 centered workspace tabs on row 2.
- **🌌 Tidal Starfield**: Interactive concentric orbital Canvas graph with drag-pan, wheel-zoom, hover edge highlights, and visual linking.
- **📜 Memory Stream, 🎯 Anchors & Goals, ⚙ Tidal Maintenance**: Filter by layer/project/retention, promote or condense candidates, batch-confirm importance (`set_importance`), and import external Markdown / Obsidian vaults read-only.

### 5. Optional AI Semantic Enhancement (Off by Default)
- Runs 100% locally offline without any API key.
- Optionally configure any OpenAI-compatible endpoint in Maintenance to unlock **Hybrid Vector Search (FTS5 + Cosine Similarity)** and **AI Distillation** (condensing scattered `episodic` notes into dense `knowledge` nodes).

### 6. External Knowledge Sync, Project Briefing, Provenance Rollback & Cross-Tool MCP Share
- **📚 External Knowledge Directory Incremental Sync**: Bind local Markdown/text note directories read-only; incrementally chunks and indexes modified files into FTS5 by mtime & hash without touching source files, and surfaces matches automatically during recall.
- **🗺️ Project Briefing (Living Map)**: Aggregates per-project structural rules, active goals, open mysteries, and key lessons into a compact `SessionStart` briefing with live preview and one-click copy in the workbench.
- **🔗 Conversation Provenance & `.bak` Auto-Rollback**: Records `conversationId#stepIndex` on auto-ingested nodes (one-click session ID copy) and automatically saves up to 5 `vault/.backups/*.bak.md` snapshots before overwriting, with one-click rollback in UI or MCP.
- **🛡️ 2.35.1+ Resume Dedup & Single-Truth Deduplication**: Prevents duplicate auto-ingest on Antigravity 2.35.1+ session resume; automatically prunes cross-folder duplicate files into `vault/.backups/` during archive/layer transitions and index rebuilds so disk files always match SQLite counts.
- **🔌 One-Click Cross-Tool MCP Sharing**: Generates ready-to-paste `mcpServers` JSON and Claude Code CLI commands in the panel so Claude Code, Cursor, and Codex can share the exact same Lanxi Memory vault.

### 7. Unified Azure Suite UI
- **Neko Glass UI & Shared Theme Center**: Light/dark themes, custom glass dropdowns & modals, 6 official presets + custom dual pickers + 4 shared slots, sidebar toggle, fullscreen `Web UI`, and GitHub Release update checks.


### First-Run Interactive Onboarding (`? Guide`)
- **4-Step Walkthrough & Live UI Spotlighting**: Opens automatically on first launch to walk through key features, with one-click spotlight buttons that pulse-highlight the real controls on screen plus a floating return bar.
- **Persisted Across Restarts**: Completion state is stored in `~/.gemini/azure-onboarding.json` (survives sidecar port changes), and can be reopened anytime from the topbar **`? Guide`** button.

<h2 id="architecture">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/sec-arch-en-dark.svg">
  <img src="assets/readme/sec-arch-en-light.svg" alt="How It Works" width="100%">
</picture>
</h2>

```mermaid
flowchart TD
  V["Markdown Truth Vault<br/>vault/*.md (Obsidian-Ready)"] <-->|"Live dataStale Detection"| IDX["SQLite WAL + CJK FTS5<br/>(+ Optional Embeddings)"]
  IDX -->|"Tidal Retention Ranking"| REC["cg_recall / PreInvocation<br/>Noise Gate + Persona Toggle"]
  REC -->|"Access Reinforcement"| LAY["5-Layer Cognitive Graph<br/>anchor/self/goals · structural/knowledge · episodic/unresolved"]
  LAY -->|"importance >= 0.7 Guard"| UI["Tidal Starfield Canvas UI<br/>Graph / Stream / Maintenance"]
```

<h2 id="installation">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/sec-install-en-dark.svg">
  <img src="assets/readme/sec-install-en-light.svg" alt="Installation & Setup" width="100%">
</picture>
</h2>

> **Prerequisite**: **Node.js >= 22.0.0** (zero third-party npm dependencies, pure native ESM).

### Option 1 · Let Antigravity Install It for You (Recommended)

Copy and send the following prompt directly to Antigravity:

> Please clone `https://github.com/A16Nights/antigravity-lanxi-memory.git` into my Antigravity global plugins directory as `lanxi-memory`, verify the directory structure, and tell me once it is ready so I can press `Ctrl+R` to reload.

### Option 2 · Manual Git Clone

```powershell
# Windows (PowerShell)
git clone https://github.com/A16Nights/antigravity-lanxi-memory.git "$env:USERPROFILE\.gemini\config\plugins\lanxi-memory"

# macOS / Linux
git clone https://github.com/A16Nights/antigravity-lanxi-memory.git ~/.gemini/config/plugins/lanxi-memory
```

Restart or reload Antigravity (`Ctrl+R`), enable **Lanxi Memory** in **Plugins**, and open it from the left sidebar or right-hand panel.

<h2 id="mcp-tools">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/sec-tools-en-dark.svg">
  <img src="assets/readme/sec-tools-en-light.svg" alt="MCP Tools Reference" width="100%">
</picture>
</h2>

| Tool | Description |
| --- | --- |
| `cg_write` | Write a memory node (defaults to `episodic`; supports `layer`, `project`, `importance`, `tags`, `links`) |
| `cg_recall` | Tidal-weighted + project-prioritized recall (hybrid FTS5 + vector ranking when embeddings are enabled) |
| `cg_read` | Read full Markdown body, retention score, links, and disk sync state by node ID |
| `cg_update` | Update body, title, layer, tags, or importance (with hard-protection & demotion guards) |
| `cg_forget` | Explicitly archive a node into `vault/archive/` (preserves full files, never hard-deletes) |
| `cg_link` | Create a directed semantic link between two nodes (synced to Markdown frontmatter) |
| `cg_graph` | Fetch the full cognitive graph or a local subgraph around a focal node |
| `cg_goal` | Query, create, or update long-term `goals` milestones |
| `cg_reflect` | Record metacognitive reflections (`self`) or open mysteries (`unresolved`) |
| `cg_maintain` | Run tidal maintenance: candidate queues, promotion, reinforcement, `set_importance`, condense, embeddings, `briefing`, `rollback`, `sync_sources`, reindex |
| `cg_stats` | Inspect layer counts, retention distribution, `dataStale` status, and masked configuration |
| `cg_import_vault` | Strictly read-only import from external Markdown folders, or Obsidian Vaults |

<h2 id="storage">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/sec-storage-en-dark.svg">
  <img src="assets/readme/sec-storage-en-light.svg" alt="Data & Configuration" width="100%">
</picture>
</h2>

<details open>
<summary><strong>Click to inspect local data paths & shared Azure Suite configs</strong></summary>

<br>

- **Markdown Truth Vault**: `~/.gemini/lanxi-memory/vault/`
- **Local FTS5 & Vector Index**: `~/.gemini/lanxi-memory/index.sqlite`
- **Plugin & Optional AI Config**: `~/.gemini/lanxi-memory/config.json`
- **Shared Azure Suite Theme & Sidebar Config**: `~/.gemini/azure-theme.json`, `~/.gemini/azure-sidebar-nav.json`

</details>

<h2 id="azure-suite">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/sec-suite-en-dark.svg">
  <img src="assets/readme/sec-suite-en-light.svg" alt="Azure Suite Ecosystem" width="100%">
</picture>
</h2>

All **11 Azure Suite plugins** share a unified **Neko Glass UI**, synchronized **Azure Theme Center** (`~/.gemini/azure-theme.json`), and customizable **Sidebar Navigation Hub** (`~/.gemini/azure-sidebar-nav.json`):

| Plugin | Repository | Core Capability |
| --- | --- | --- |
| ✦ **External Orchestrator — Multi-Model Worker Router** | [antigravity-external-orchestrator](https://github.com/A16Nights/antigravity-external-orchestrator) | Multi-provider external worker routing, custom profiles, circuit breaker, live monitor & onboarding guide |
| 🪐 **Azure Orbit — Native Custom Model Mount** | [antigravity-azure-orbit](https://github.com/A16Nights/antigravity-azure-orbit) | Mount external LLM APIs directly into Antigravity's native bottom-left model selector |
| 🧭 **Azure Compass — Agent Presets & Context Monitor** | [antigravity-azure-compass](https://github.com/A16Nights/antigravity-azure-compass) | Agent mode presets, live context telemetry with auto /compact & Azure Suite sidebar hub |
| 🏛️ **Azure Corridor — Conversation & Workspace Manager** | [antigravity-azure-corridor](https://github.com/A16Nights/antigravity-azure-corridor) | Pure-native conversation & workspace sync, FTS5 search, custom quick tags, cross-workspace transfer & onboarding |
| 🌌 **Lanxi Memory — Cognitive Graph Memory** &nbsp;`✦ This Repo` | [antigravity-lanxi-memory](https://github.com/A16Nights/antigravity-lanxi-memory) | 5-layer Markdown cognitive graph, CJK FTS5, tidal forgetting curves & starfield UI |
| 💎 **Soul.md Studio — Persona Cards & Memory** | [antigravity-soul-md](https://github.com/A16Nights/antigravity-soul-md) | Hot-swappable persona cards, workspace binding, external-model anchor & layered memory |
| 💭 **Think-ZH — Chinese Reasoning Switcher** | [antigravity-think-zh](https://github.com/A16Nights/antigravity-think-zh) | Simplified Chinese / English reasoning switcher with dual-channel anti-drift hooks |
| 🔮 **Azure Prism — Chain-of-Thought Translator** | [antigravity-azure-prism](https://github.com/A16Nights/antigravity-azure-prism) | Native MCP App Chain-of-Thought viewer with keyless zero-token MT & LLM translation |
| 🪄 **Azure Wand — Windows Desktop & Web Automation** | [antigravity-azure-wand](https://github.com/A16Nights/antigravity-azure-wand) | Low-intrusion Windows desktop & web automation with 15-state independent AI cursor, pack gallery & importer |
| 🍃 **Azure Drop — Drag-Drop Files & Screenshot Helper** | [antigravity-azure-drop](https://github.com/A16Nights/antigravity-azure-drop) | Zero-`app.asar` drag/paste native mention pills, lossless PNG capture, image thumbnails/lightbox & breadcrumb context menu |
| 🔭 **Azure Lens — Multi-Account Gemini Sidekick** &nbsp;`Beta` | [antigravity-azure-lens](https://github.com/A16Nights/antigravity-azure-lens) | 1:1 native dual-state Gemini sidebar, dual-tab isolation, multi-account auto-detect, in-app modals & MCP research/review |

---

### 💡 Acknowledgements

Independently designed and built on the native Antigravity plugin protocol, inspired by:
- [dsh-memory](https://github.com/FuRongJun-1999/dsh-memory) — 5-layer Markdown cognitive vault, hard protection, and deterministic rules
- [CortexGraph](https://github.com/prefrontal-systems/cortexgraph) — Power-law forgetting curves and access reinforcement

---

<div align="center">

📄 Released under the <a href="./LICENSE"><strong>MIT License</strong></a> · Crafted for <strong>Google Antigravity</strong>

</div>
