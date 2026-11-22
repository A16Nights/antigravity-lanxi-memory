# 蓝汐 · 潮汐认知图谱（Lanxi Memory · `antigravity-lanxi-memory`）

**简体中文** | [English](README.en.md)

> **Local-first, zero-dependency cognitive graph memory plugin for Google Antigravity — 5-layer Markdown vault + CJK FTS5 + Tidal forgetting curves + Persona memory gate + Optional AI semantic enhancement + Tidal Starfield UI.**

**蓝汐（Lanxi）** 是一款专为 **Google Antigravity** 打造的纯本地长期记忆与认知图谱插件。它将「人类可读的五层纯 Markdown 真源文档（Vault）」与「幂律 / 指数潮汐遗忘曲线」深度融合：核心架构约定与长期目标永久锚定不衰减，日常情景随时间自然退潮、被频繁检索或强化则涨潮晋升，所有归档均保留完整原文件，**绝不静默丢弃任何记忆**。

---

## ✨ 功能全景

### 1. 五层认知结构与防误锁硬保护机制
- **定海锚点层（永久保留 `retention = 1.0`）**：
  - `anchor`（核心锚点）：不可违背的全局底线与跨项目铁律；
  - `self`（自我与偏好认知）：长期协作风格、交互偏好与元认知沉淀；
  - `goals`（长期目标）：跨会话持续追踪的里程碑与待办目标。
- **高价值知识层（支持 `importance >= 0.7` 硬保护）**：
  - `structural`（架构与工程规律）：项目架构决策、模块边界与核心规范；
  - `knowledge`（通用知识与排错经验）：可复用的技术方案、踩坑结论与配置经验；
  - **硬保护防失忆**：重要度 `>= 0.7` 的节点自动触发硬保护，归档或降级必须经面板内毛玻璃确认弹窗（或显式传入 `override: true`）二次确认；支持可选 `writeGate` 写入门控，防止模型自评高重要度未确认前擅自锁死。
- **潮汐流动层**：
  - `episodic`（情景事件，**默认安全落层**）：随手记录或未声明层级的记忆默认进入情景层，遵循潮汐遗忘曲线自然衰减，召回或强化后自动涨潮，并可在维护台一键晋升至 `knowledge` / `structural`；
  - `unresolved`（待解决疑点）：持续追踪尚未闭环的技术疑点与遗留问题。

### 2. 磁盘即真源（`dataStale` 实时感知）与 CJK FTS5 检索引擎
- **纯本地 SQLite WAL + CJK 分词 FTS5**：仅依赖 Node.js（`>= 22.0.0`）内置 `node:sqlite`，对中文双字切词、英文词干与代码标识符进行高速全文索引。
- **外部编辑实时感知**：你可以随时使用 VS Code、Obsidian 或任意文本编辑器直接修改 `vault/*.md`，插件会自动检测磁盘文件增删改并在顶栏提示一键重建索引。

### 3. 智能生命周期钩子与人设记忆联动
- **`SessionStart`（新会话锚点唤醒，默认开启）**：开场自动加载定海锚点、活跃长期目标与当前项目高权重记忆。
- **`PreInvocation`（每轮前置按需召回 + 长会话归档提醒）**：
  - 支持 `strict / balanced / loose` 三档实词覆盖率防噪门槛，彻底杜绝无关旧记录刷屏；
  - 支持长会话周期性归档提醒，防止重要决策随会话结束遗失；
  - **联动苍蓝魂匣（`soul-md`）人设记忆开关**：当当前生效人设卡关闭记忆功能时，自动静默跳过记忆注入与沉淀。

### 4. 原创「潮汐星海」可视化工作台（Sidecar + 独立 Web UI）
- **两行居中对齐顶栏**：第一行集成标题、状态徽标与苍蓝套件标准工具栏，第二行居中排布五大功能标签页，视觉平衡清爽。
- **🌌 潮汐星海（交互式 Canvas 星图）**：
  - 同心轨道潮汐星图（内圈永久锚点 → 中圈结构/知识 → 外圈情景/待决），支持鼠标拖拽平移、滚轮缩放、悬停高亮关联边、点击查看节点详情与可视化建边。
- **📜 记忆流 & 🎯 锚点与目标**：
  - 支持按层级、项目（Project）、关键词与保留度筛选，面板内直接新建、编辑、强化、晋升、建边或归档记忆节点。
- **⚙ 潮汐维护台**：
  - 潮汐水位分布条、待晋升/待归档候选队列、批量重要度确认（`set_importance`）、手动合并凝结、索引重建及外部 Markdown / Obsidian Vault 只读导入。

### 5. 可选 AI 语义增强（默认关闭，100% 离线可用）
- 不配置任何 API Key 即可 100% 本地离线完整运行；
- 在「潮汐维护 → 可选 AI 增强接口」中接入任意 OpenAI 兼容接口后，可额外解锁：
  - **混合语义向量检索（FTS5 + Cosine Similarity）**；
  - **AI 智能凝结（自动将多条零散 `episodic` 情景提炼合成为高密度 `knowledge` 节点）**。

### 6. 苍蓝统一视觉与交互体系
- **Neko Glass 毛玻璃界面 & 苍蓝主题色调中心**：深色/浅色切换、自定义毛玻璃下拉框（`AzureSelect`）与确认弹窗、6 套官方配色预设 + 自定义双色 + 4 个自定义栏位跨插件同步、左侧栏快捷入口开关、独立浏览器全屏 `Web UI` 与 GitHub Release 在线更新检查。

---

## 🚀 快速安装

> 前置要求：**Node.js >= 22.0.0**（使用内置 `node:sqlite`，零第三方 npm 依赖）。

将本仓库克隆到 Antigravity 全局插件目录：

```powershell
# Windows (PowerShell)
git clone https://github.com/A16Nights/antigravity-lanxi-memory.git "$env:USERPROFILE\.gemini\config\plugins\lanxi-memory"

# macOS / Linux
git clone https://github.com/A16Nights/antigravity-lanxi-memory.git ~/.gemini/config/plugins/lanxi-memory
```

重启或重载 Antigravity（`Ctrl+R`），在 **Plugins** 页面确认 **蓝汐 · 潮汐认知图谱** 已启用即可从左侧栏或右侧辅助面板打开。

---

## 🧰 MCP 工具一览（12 个）

| 工具名 | 作用 |
| --- | --- |
| `cg_write` | 写入记忆节点（默认落 `episodic`，支持 `layer`、`project`、`importance`、`tags`、`links`） |
| `cg_recall` | 潮汐保留度加权 + 当前项目优先召回（启用 Embedding 时自动执行 FTS5 + 语义向量混合排序） |
| `cg_read` | 按节点 ID 读取完整 Markdown 正文、潮汐保留度、出入边关系与磁盘同步状态 |
| `cg_update` | 更新节点正文、标题、层级、标签或重要度（带硬保护与防误降层拦截） |
| `cg_forget` | 显式将节点归档移入 `vault/archive/`（保留完整文件，绝不静默物理删除） |
| `cg_link` | 在两个记忆节点之间建立有向语义关联边（自动同步写入 Markdown frontmatter） |
| `cg_graph` | 获取全局认知图谱或指定中心节点的局部关联子图 |
| `cg_goal` | 查询、创建或更新 `goals` 层长期目标与里程碑进度 |
| `cg_reflect` | 记录元认知反思（`self`）或登记待解决疑点（`unresolved`） |
| `cg_maintain` | 执行潮汐维护：候选队列查询、节点晋升、访问强化、批量重要度确认、手动/AI 凝结、向量补全、索引重建 |
| `cg_stats` | 获取各层级节点统计、潮汐水位分布、`dataStale` 磁盘新鲜度检测与脱敏配置 |
| `cg_import_vault` | 严格只读扫描并导入外部 Markdown 目录 / Obsidian Vault / DSH 记忆库 |

---

## 📂 数据与配置存储

- **Markdown 记忆真源库**：`~/.gemini/lanxi-memory/vault/`（或兼容目录 `~/.gemini/lingshu-cortex/vault/`）
- **本地全文与向量索引库**：`~/.gemini/lanxi-memory/index.sqlite`
- **插件与可选 AI 接口配置**：`~/.gemini/lanxi-memory/config.json`
- **苍蓝套件共享主题 / 左侧栏配置**：`~/.gemini/azure-theme.json`、`~/.gemini/azure-sidebar-nav.json`

---

## 💡 灵感致谢

本项目为基于 Antigravity 插件协议独立设计与编写的原生实现，设计理念受以下优秀开源项目启发，特此致谢：
- [dsh-memory（灵枢）](https://github.com/FuRongJun-1999/dsh-memory) —— 五层 Markdown 认知图谱、硬保护防失忆与确定性规则理念
- [CortexGraph](https://github.com/prefrontal-systems/cortexgraph) —— 类人幂律遗忘曲线与访问强化机制

## 📄 License

[MIT](./LICENSE)
