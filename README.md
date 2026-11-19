# 蓝汐 · 潮汐认知图谱（Lanxi Memory）

**简体中文** | [English](README.en.md)

> **Local-first, zero-dependency cognitive graph memory plugin for Antigravity — 5-layer Markdown vault + CJK FTS5 + Tidal forgetting curves + Optional AI semantic enhancement + Tidal Starfield UI.**

**蓝汐（Lanxi）** 是一款专为 **Google Antigravity** 打造的纯本地长期记忆与认知图谱插件。它把「人类可读的纯 Markdown 真源文档」与「幂律/指数潮汐遗忘曲线」融合在一起：重要约定永久锚定不衰减，日常情景随时间退潮、被频繁检索则涨潮强化，绝不静默丢弃任何记忆文件。

---

## ✨ 核心特性

- **零外部依赖 · 开箱即用**：仅依赖 Node.js（`>= 22.0.0`）内置的 `node:sqlite`（WAL + FTS5）与原生 `fetch`，无需安装 Python、Docker 或外置向量库。
- **五层认知结构 + 防误锁硬保护机制**：
  - `anchor`（永久锚点）、`self`（自我认知）、`goals`（长期目标）：定海锚点，永久保留（`retention = 1.0`），防意外降层。
  - `structural`（架构规律）、`knowledge`（通用知识）：`importance >= 0.7` 可开启硬保护，归档或降级需显式确认 `override: true`；支持可选 `writeGate`（防 AI 自评重要度未确认前擅自锁死）。
  - `episodic`（情景事件，**默认落层**）：未指定层级时默认进入情景层，避免草稿污染长期知识库；遵循潮汐遗忘曲线衰减，召回或强化后自动涨潮，并在维护台支持晋升与批量确认重要度。
  - `unresolved`（待解决问题）：持续追踪未决疑点。
- **磁盘即真源检测（`dataStale`）**：自动感知外部编辑器对 `vault/*.md` 的修改与文件增减，在概览与潮汐星海顶栏提示一键重建索引。
- **项目优先召回 & 降噪钩子**：按当前工作区自动标记与加权 `project` 记忆；`SessionStart`（开场锚点唤醒，默认开启）与 `PreInvocation`（每轮前置召回，默认关闭，改为按需主动检索）拥有独立 UI 开关，并提供 `strict / balanced / loose` 三档实词覆盖率防噪门槛，彻底杜绝无关旧记录刷屏与额外 Token 消耗。
- **原创「潮汐星海」工作台（Sidecar + 浏览器全屏双形态）**：
  - 同心轨道潮汐星图 Canvas（支持拖拽、缩放、悬停查看与点击建边）、潮汐水位分布条、记忆流、锚点目标页与维护台。
- **可选 AI 增强（默认关闭，完全自愿）**：
  - 接入任意 OpenAI 兼容接口后，额外解锁 **混合语义向量检索（FTS5 + Cosine）** 与 **AI 智能凝结（自动提炼多条零散情景为高密度知识节点）**。不配 API Key 照样 100% 离线完整运行。

---

## 🚀 快速安装（3 步）

> 前置要求：**Node.js >= 22.0.0**（内置 `node:sqlite`）。

1. 克隆仓库到 Antigravity 全局插件目录：
   ```bash
   # macOS / Linux
   git clone https://github.com/A16Nights/lanxi-memory.git ~/.gemini/config/plugins/lanxi-memory

   # Windows PowerShell
   git clone https://github.com/A16Nights/lanxi-memory.git "$env:USERPROFILE\.gemini\config\plugins\lanxi-memory"
   ```
2. **重启 Antigravity**（彻底退出托盘后重新打开）。
3. 在客户端 **Customizations** 页面确认 `蓝汐 · 潮汐认知图谱` 已启用，或在对话中直接点击 `[蓝汐 · 潮汐星海](sidecar://lanxi-memory/starfield/)` 打开工作台。

---

## 🧰 MCP 工具一览（12 个）

| 工具名 | 作用 |
| --- | --- |
| `cg_write` | 写入记忆节点（默认落 `episodic`，支持 `project`、`importanceSource`、`rejection_reason`） |
| `cg_recall` | 潮汐加权 + 项目优先召回（启用 Embedding 时自动执行 FTS5 + 语义混合排序） |
| `cg_read` | 按节点 ID 读取全文、保留度、出入边与磁盘同步状态 |
| `cg_update` | 更新节点内容、层级、别名或重要度（带硬保护与防降层拦截） |
| `cg_forget` | 显式归档到 `vault/archive/`（绝不静默删文件） |
| `cg_link` | 在节点之间建立有向语义边（同步写入 frontmatter） |
| `cg_graph` | 获取全局或局部子图数据 |
| `cg_goal` | 列出或创建/更新长期目标（`goals` 层） |
| `cg_reflect` | 记录元认知反思或未决问题（`self` / `unresolved`） |
| `cg_maintain` | 维护队列、晋升、强化、批量重要度确认（`set_importance`）、手动/AI 凝结、向量补全、索引重建 |
| `cg_stats` | 获取运行概览、潮汐水位分布、`dataStale` 新鲜度检测与脱敏配置 |
| `cg_import_vault` | 严格只读导入外部 Markdown / Obsidian Vault / DSH mdcg |

---

## ✨ 可选 AI 增强配置

所有 AI 能力均默认关闭。你可以直接在工作台的 **「⚙ 潮汐维护 → 可选 AI 增强接口」** 中填写，或通过环境变量注入：

- `LANXI_LLM_API_KEY`：用于 AI 智能凝结（OpenAI 兼容 `/chat/completions`）
- `LANXI_EMBEDDING_API_KEY`：用于语义向量混合检索（OpenAI 兼容 `/embeddings`）

> 密钥仅保存在本机 `~/.gemini/lanxi-memory/config.json`，接口和界面绝不会回显明文。

---

## 🔒 隐私与数据安全

- 100% 本地运行：真源 Markdown 存储在 `~/.gemini/lanxi-memory/vault/`，检索索引存储在 `~/.gemini/lanxi-memory/index.sqlite`。
- 除非你主动填写并开启可选 AI 接口，否则插件**不发起任何外网请求**。
- 自检命令：`npm test`（使用隔离临时目录与模拟服务端进行全链路测试）。

---

## 💡 灵感致谢

本项目为基于 Antigravity 插件协议独立设计与编写的原生实现，设计理念受以下优秀开源项目启发，特此致谢：
- [dsh-memory（灵枢）](https://github.com/FuRongJun-1999/dsh-memory) —— 五层 Markdown 认知图谱、硬保护防失忆与确定性规则理念
- [CortexGraph](https://github.com/prefrontal-systems/cortexgraph) —— 类人幂律遗忘曲线与访问强化机制

MIT License © 2026 A16Nights
