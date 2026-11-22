---
name: lingshu-cortex
description: >-
  Unified long-term cognitive graph memory system combining Lingshu 5-layer
  Markdown vault (anchor/self/structural/knowledge/episodic/goals/unresolved)
  with CortexGraph power-law forgetting curves, access reinforcement, automatic
  lifecycle hooks, and the Cognitive Workbench sidecar. Use when storing,
  recalling, linking, reflecting, maintaining, or migrating long-term memories.
---

# 蓝汐 · 潮汐认知图谱（Lanxi）

- **可视化工作台**：`[蓝汐 · 潮汐星海](sidecar://lingshu-cortex/workbench/)`（也可通过工作台右上角在浏览器全屏查看）。
- **真源存储**：`~/.gemini/lingshu-cortex\vault\`（纯 Markdown，Obsidian 兼容），检索索引位于 `index.sqlite`（CJK 2-gram + FTS5 + 可选向量索引）。

## 五层认知与保护规则
- `anchor`（永久锚点）与 `self`（自我认知）、`goals`（长期目标）：定海锚点层，永久硬保护（`retention = 1.0`），不参与潮汐衰减；`cg_update` 降出需传 `override: true`。
- `structural`（架构/规律）、`knowledge`（通用知识）：长期知识层；写入时 `importance >= 0.7` 可开启硬保护（支持 `writeGate` 防 AI 自评误锁，需 `confirmedBy` 或 `cg_maintain(op="set_importance", confirm=true)` 确认）。
- `episodic`（情景事件，默认落层）：默认按幂律/指数潮汐遗忘曲线随时间衰减，被召回或 `touch` 会强化保留度；高频高价值节点可在维护队列晋升或通过 `ai_consolidate` 智能凝结为 `knowledge`。
- `unresolved`（待解决问题）：需要持续追踪的未决疑问。

## 12 个 MCP 工具
- `cg_write`（支持 `project`、`importanceSource`、`rejection_reason`） / `cg_recall`（支持 `project` 优先加权；启用 Embedding 时自动混合语义召回） / `cg_read` / `cg_update` / `cg_forget`
- `cg_link` / `cg_graph`
- `cg_goal` / `cg_reflect`
- `cg_maintain`（`queue` / `promote` / `touch` / `set_importance` / `consolidate` / `ai_consolidate` / `backfill_embeddings` / `rebuild`）
- `cg_stats`（含磁盘真源 `dataStale` 检测） / `cg_import_vault`（兼容旧别名 `cg_import_dsh`）
