#!/usr/bin/env node
import { getSidebarToolDefinition, getSidebarResourceDefinition, getSidebarResourceUri, handleSidebarToolCall, buildSidebarResourceReadResult } from "./lib/sidebar-nav.mjs";
import readline from "node:readline";
import { LanxiEngine, VALID_LAYERS } from "./lib/engine.mjs";
import { runOrganizeSession, runKnowledgeAuditSession } from "./lib/organizer.mjs";

const engine = new LanxiEngine();

const TOOLS = [
  {
    name: "cg_write",
    description: "写入长期记忆节点到 Markdown 认知图（默认落 episodic 情景层；重要长期结论请显式指定 knowledge/structural；importance >= 0.7 或 anchor/self 层可开启硬保护）。",
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string", description: "记忆正文，支持 Markdown 与 [[目标ID]] 双向链接" },
        title: { type: "string", description: "可选标题（不填则自动从正文首行提取）" },
        layer: {
          type: "string",
          enum: VALID_LAYERS,
          description: "分层：anchor（永久锚点）、self（自我认知）、structural（架构/规律）、knowledge（通用知识）、episodic（情景事件，默认）、goals（目标）、unresolved（待解决问题）"
        },
        importance: { type: "number", description: "重要度 0~1，默认 0.5；>= 0.7 可开启硬保护" },
        importanceSource: { type: "string", enum: ["hint", "confirmed"], description: "重要度来源：'hint'（AI 自评，未确认不自动硬锁）或 'confirmed'（已确认）" },
        confirmedBy: { type: "string", description: "确认人（如 'user'），传入后自动视为 confirmed" },
        project: { type: "string", description: "所属项目或工作区名（自动追加 项目:<name> 标签并提升同项目召回权重）" },
        rejection_reason: { type: "string", description: "可选：被否决/弃用方案的原因说明" },
        tags: { type: "array", items: { type: "string" }, description: "标签数组" },
        aliases: { type: "array", items: { type: "string" }, description: "别名数组" },
        evidence_files: { type: "array", items: { type: "string" }, description: "可选：关联的本地证据文件路径数组（自动记录当前 mtime/size，后续文件变更或删除时召回自动预警）" },
        derived_from: { type: "array", items: { type: "string" }, description: "可选：来源/前身记忆节点 ID 数组" },
        verification_state: { type: "string", enum: ["verified", "unverified", "doubted"], description: "可选：验证状态（doubted 会在召回时触发核实提醒）" },
        valid_until: { type: "number", description: "可选过期 Unix 秒时间戳" },
        protected: { type: "boolean", description: "是否强制启用防衰减硬保护" }
      }
    }
  },
  {
    name: "cg_recall",
    description: "按关键词、分层、项目与潮汐加权检索记忆（若已配置 Embedding API 则自动执行 FTS5 + 向量语义混合召回），并强化命中节点。",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "中文或英文检索关键词" },
        layers: { type: "array", items: { type: "string", enum: VALID_LAYERS }, description: "可选：限定检索层级" },
        project: { type: "string", description: "可选：项目名称，优先加权匹配该项目记忆（不漏出跨项目记忆）" },
        strictProject: { type: "boolean", description: "为 true 时严格只返回匹配 project 的记忆，默认 false" },
        limit: { type: "integer", description: "返回条数，默认 8" },
        includeExpired: { type: "boolean", description: "是否包含已过期记忆，默认 false" }
      }
    }
  },
  {
    name: "cg_read",
    description: "按节点 ID 读取完整记忆详情、潮汐保留度、出入边关系与磁盘文件路径。",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "记忆节点 ID" }
      }
    }
  },
  {
    name: "cg_update",
    description: "更新记忆节点内容、层级、标签、别名或重要度（若节点受硬保护，降低重要度、从受保护层迁出或解除保护需传 override: true）。",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "记忆节点 ID" },
        title: { type: "string" },
        content: { type: "string" },
        layer: { type: "string", enum: VALID_LAYERS },
        importance: { type: "number" },
        importanceSource: { type: "string", enum: ["hint", "confirmed"] },
        confirmedBy: { type: "string" },
        project: { type: "string" },
        rejection_reason: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        aliases: { type: "array", items: { type: "string" } },
        evidence_files: { type: "array", items: { type: "string" }, description: "关联的本地证据文件路径数组（传空数组清除）" },
        derived_from: { type: "array", items: { type: "string" }, description: "来源/前身记忆节点 ID 数组（传空数组清除）" },
        verification_state: { type: "string", enum: ["verified", "unverified", "doubted"], description: "显式更新验证状态（如标为 doubted 或 verified）" },
        protected: { type: "boolean" },
        override: { type: "boolean", description: "解除/降低硬保护或降级受保护层时必须为 true" }
      }
    }
  },
  {
    name: "cg_forget",
    description: "显式遗忘/归档记忆节点（绝不静默物理删除，仅移入 vault/archive/；硬保护节点需传 override: true）。",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "记忆节点 ID" },
        reason: { type: "string", description: "归档原因" },
        override: { type: "boolean", description: "对硬保护节点生效需为 true" }
      }
    }
  },
  {
    name: "cg_link",
    description: "在两个记忆节点之间建立有向语义关系（同时写入 SQLite 边表与源文件 frontmatter）。",
    inputSchema: {
      type: "object",
      required: ["sourceId", "targetId"],
      properties: {
        sourceId: { type: "string", description: "源节点 ID" },
        targetId: { type: "string", description: "目标节点 ID" },
        relation: { type: "string", description: "关系类型，如 related_to、supports、derived_from、depends_on、contradicts（冲突标注，召回时预警）、supersedes（新记忆取代旧记忆）" },
        weight: { type: "number", description: "边权重，默认 1.0" }
      }
    }
  },
  {
    name: "cg_graph",
    description: "获取记忆关系子图（以某节点为中心或按层级返回关联度最高的节点和边）。",
    inputSchema: {
      type: "object",
      properties: {
        centerId: { type: "string", description: "可选中心节点 ID" },
        layers: { type: "array", items: { type: "string", enum: VALID_LAYERS } },
        limit: { type: "integer", description: "最大节点数，默认 50" }
      }
    }
  },
  {
    name: "cg_goal",
    description: "列出或创建/更新长期目标与待办（存储在 goals 层，默认硬保护）。",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["list", "upsert"], description: "操作：list（默认）或 upsert" },
        id: { type: "string", description: "upsert 更新已有目标时传入" },
        title: { type: "string", description: "目标标题" },
        content: { type: "string", description: "目标详情" },
        status: { type: "string", enum: ["active", "paused", "done"], description: "状态" },
        priority: { type: "string", enum: ["high", "medium", "low"], description: "优先级" },
        progress: { type: "number", description: "进度 0~100" }
      }
    }
  },
  {
    name: "cg_reflect",
    description: "记录元认知反思或待解决问题（写入 self 或 unresolved 层，并关联 derived_from 依据节点）。",
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: {
        title: { type: "string" },
        content: { type: "string", description: "反思结论或待解决疑问" },
        layer: { type: "string", enum: ["self", "unresolved"], description: "默认 self" },
        basedOnIds: { type: "array", items: { type: "string" }, description: "关联依据节点 ID 列表" },
        importance: { type: "number", description: "默认 0.75" },
        tags: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "cg_maintain",
    description: "潮汐维护：查看维护队列（queue），晋升情景（promote），强化访问（touch），恢复归档（restore），永久删除（delete），清空已归档（purge_archived），批量修改/确认重要度（set_importance），手动或 AI 智能凝结（consolidate / ai_consolidate），批量智能整理情景（organize），知识库过时与去重体检（audit_knowledge），补全向量（backfill_embeddings），生成项目活地图（briefing），回滚节点快照（rollback），增量同步外部知识目录（sync_sources），或重建索引（rebuild）。",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["queue", "promote", "touch", "restore", "delete", "purge_archived", "set_importance", "consolidate", "ai_consolidate", "organize", "audit_knowledge", "backfill_embeddings", "briefing", "rollback", "sync_sources", "rebuild"],
          description: "默认 queue"
        },
        id: { type: "string", description: "promote/touch/restore/delete/set_importance/rollback 时的目标节点 ID" },
        backupFile: { type: "string", description: "rollback 时可选指定 .bak.md 快照文件名，默认回滚最新一份" },
        project: { type: "string", description: "briefing/organize/audit_knowledge 时可选指定的项目名" },
        sourceId: { type: "string", description: "sync_sources 时可选指定单个外部源 ID" },
        force: { type: "boolean", description: "sync_sources 时是否强制全量重切" },
        ids: { type: "array", items: { type: "string" }, description: "set_importance 或 purge_archived 的批量目标节点 ID 列表" },
        importance: { type: "number", description: "set_importance 要设置的重要度 0~1" },
        confirm: { type: "boolean", description: "set_importance 时是否同时确认保护（将 hint 转为 confirmed）" },
        confirmedBy: { type: "string", description: "确认来源标识，默认 'user'" },
        override: { type: "boolean", description: "set_importance 降低受保护节点重要度或 delete 硬保护活跃节点时传 true" },
        targetLayer: { type: "string", enum: ["knowledge", "structural", "self", "anchor"], description: "promote/consolidate 目标层" },
        sourceIds: { type: "array", items: { type: "string" }, description: "consolidate / ai_consolidate 的源节点 ID 列表" },
        title: { type: "string", description: "consolidate 新节点标题" },
        summary: { type: "string", description: "consolidate 提炼后的摘要正文" },
        commit: { type: "boolean", description: "ai_consolidate 时是否直接写入落盘，默认 false 仅预览草稿" },
        archiveSources: { type: "boolean", description: "凝结/整理后是否归档源情景节点，默认 true" },
        dryRun: { type: "boolean", description: "organize 或 audit_knowledge 时是否仅预览不写入，audit_knowledge 默认 true" },
        maxNodes: { type: "integer", description: "organize 每次最大处理条数，默认 24，0 表示全部" },
        maxClusters: { type: "integer", description: "audit_knowledge 最大体检相似组数，默认 12" },
        limit: { type: "integer", description: "backfill_embeddings 批量上限，默认 50" }
      }
    }
  },
  {
    name: "cg_stats",
    description: "获取蓝汐（Lanxi）认知图谱运行概览、潮汐水位分布、各层节点统计、磁盘真源新鲜度检测（dataStale）与配置（密钥已脱敏）。",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "cg_import_vault",
    description: "以严格只读方式从外部 Markdown 目录（兼容标准 Frontmatter 与 Obsidian Vault）导入历史笔记到蓝汐认知图谱。",
    inputSchema: {
      type: "object",
      required: ["sourceDir"],
      properties: {
        sourceDir: { type: "string", description: "待导入目录的绝对路径" }
      }
    }
  }
];

async function dispatchTool(name, args = {}) {
  engine.config = engine.loadConfig();
  switch (name) {
    case "cg_write":
      return engine.writeMemory(args);
    case "cg_recall": {
      const memories = await engine.recallHybrid({
        query: args.query,
        layers: args.layers,
        project: args.project,
        strictProject: Boolean(args.strictProject),
        limit: args.limit ?? 8,
        includeExpired: Boolean(args.includeExpired),
        touch: true,
      });
      const externalHits = args.query
        ? engine.searchExternalKnowledge(args.query, { project: args.project || "", limit: 3 })
        : [];
      if (externalHits.length > 0) {
        return { memories, externalHits };
      }
      return memories;
    }
    case "cg_read": {
      const node = engine.readMemory(args.id);
      if (!node) throw new Error(`未找到记忆节点: ${args.id}`);
      return node;
    }
    case "cg_update":
      return engine.updateMemory(args.id, args);
    case "cg_forget":
      return engine.forgetMemory(args.id, { reason: args.reason || "", override: Boolean(args.override) });
    case "cg_link":
      return engine.linkMemories(args.sourceId, args.targetId, args.relation || "related_to", args.weight ?? 1.0);
    case "cg_graph":
      return engine.getGraph({ centerId: args.centerId, limit: args.limit ?? 50, layers: args.layers });
    case "cg_goal":
      if (args.op === "upsert" || args.title || args.content) {
        return engine.upsertGoal(args);
      }
      return engine.listGoals();
    case "cg_reflect":
      return engine.reflect(args);
    case "cg_maintain": {
      const op = args.op || "queue";
      if (op === "queue") return engine.getMaintenanceQueue();
      if (op === "promote") return engine.promoteMemory(args.id, args.targetLayer || "knowledge");
      if (op === "touch") return engine.touchMemory(args.id);
      if (op === "restore") return engine.restoreMemory(args.id);
      if (op === "delete") return engine.deleteMemory(args.id, { override: Boolean(args.override) });
      if (op === "purge_archived") return engine.purgeArchived({ ids: Array.isArray(args.ids) ? args.ids : null });
      if (op === "set_importance") return engine.setImportanceBatch(args);
      if (op === "consolidate") return engine.consolidateCluster(args);
      if (op === "ai_consolidate") return await engine.aiConsolidateCluster(args);
      if (op === "organize") {
        return await runOrganizeSession(engine, {
          mode: "manual",
          maxNodes: args.maxNodes ?? 24,
          project: args.project || "",
          archiveSources: args.archiveSources !== false,
          dryRun: Boolean(args.dryRun),
          sourceIds: Array.isArray(args.sourceIds) ? args.sourceIds : null,
        });
      }
      if (op === "audit_knowledge") {
        return await runKnowledgeAuditSession(engine, {
          mode: "manual",
          maxClusters: args.maxClusters ?? 12,
          project: args.project || "",
          dryRun: args.dryRun !== false,
        });
      }
      if (op === "backfill_embeddings") return await engine.backfillEmbeddings(args.limit ?? 50);
      if (op === "briefing") return engine.buildProjectBriefing(args.project || "", { maxChars: args.maxChars || 900 });
      if (op === "rollback") return engine.rollbackMemory(args.id, args.backupFile || null);
      if (op === "sync_sources") return engine.syncExternalSources({ sourceId: args.sourceId || null, force: Boolean(args.force) });
      if (op === "rebuild") return engine.rebuildIndex();
      throw new Error(`未知维护操作: ${op}`);
    }
    case "cg_stats":
      return engine.getOverview();
    case "cg_import_vault":
      return engine.importFromVault(args.sourceDir);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResponse(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let requestQueue = Promise.resolve();

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (id === undefined || id === null) return;

  try {
    switch (method) {
      case "initialize":
        sendResponse(id, {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "lanxi-memory", version: "1.5.2" },
        });
        break;
      case "ping":
        sendResponse(id, {});
        break;
      case "tools/list": {
        const sbTool = getSidebarToolDefinition("lanxi-memory");
        sendResponse(id, { tools: sbTool ? [...TOOLS, sbTool] : TOOLS });
        break;
      }
      case "resources/list": {
        const sbRes = getSidebarResourceDefinition("lanxi-memory");
        sendResponse(id, { resources: sbRes ? [sbRes] : [] });
        break;
      }
      case "resources/read": {
        const uri = params?.uri;
        if (uri === getSidebarResourceUri("lanxi-memory")) {
          sendResponse(id, buildSidebarResourceReadResult("lanxi-memory"));
        } else {
          sendError(id, -32602, `Unknown resource: ${uri}`);
        }
        break;
      }
      case "tools/call": {
        const toolName = params?.name;
        if (toolName === "open_lanxi_memory_ui") {
          sendResponse(id, handleSidebarToolCall("lanxi-memory"));
          break;
        }
        const toolArgs = params?.arguments || {};
        try {
          const result = await dispatchTool(toolName, toolArgs);
          sendResponse(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: false,
          });
        } catch (err) {
          sendResponse(id, {
            content: [{ type: "text", text: `Error (${toolName}): ${err.message || String(err)}` }],
            isError: true,
          });
        }
        break;
      }
      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    sendError(id, -32603, "Internal error", String(err));
  }
}

rl.on("line", (line) => {
  requestQueue = requestQueue.then(() => handleLine(line)).catch(() => {});
});

process.on("SIGINT", () => {
  engine.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  engine.close();
  process.exit(0);
});
