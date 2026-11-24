import fs from "node:fs";
import path from "node:path";
import {
  resolveAiCredentials,
  synthesizeConsolidation,
  auditKnowledgeCluster,
} from "./ai-client.mjs";

const HISTORY_FILE = "organize-history.json";
const MAX_HISTORY = 20;

const STOP_TOKENS = new Set([
  "的", "了", "是", "在", "和", "与", "或", "及", "为", "将", "把", "被", "对", "中", "上", "下",
  "一个", "这个", "那个", "可以", "需要", "已经", "使用", "通过", "进行", "相关", "问题", "功能",
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "have", "not", "can", "use",
]);

function safeJsonParse(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function getHistoryPath(dataDir) {
  return path.join(dataDir, HISTORY_FILE);
}

export function readOrganizeHistory(dataDir) {
  const fp = getHistoryPath(dataDir);
  if (!fs.existsSync(fp)) return [];
  const parsed = safeJsonParse(fs.readFileSync(fp, "utf8"), []);
  return Array.isArray(parsed) ? parsed : [];
}

export function appendOrganizeHistory(dataDir, record) {
  try {
    const list = readOrganizeHistory(dataDir);
    list.unshift(record);
    const trimmed = list.slice(0, MAX_HISTORY);
    fs.writeFileSync(getHistoryPath(dataDir), JSON.stringify(trimmed, null, 2), "utf8");
  } catch {
    // ignore history write failures
  }
}

export function markAuditCardAppliedInHistory(dataDir, cardId) {
  if (!cardId) return false;
  try {
    const list = readOrganizeHistory(dataDir);
    let changed = false;
    for (const rec of list) {
      if (!Array.isArray(rec?.results)) continue;
      for (const item of rec.results) {
        if (item && item.cardId === cardId) {
          item.applied = true;
          item.dryRun = false;
          changed = true;
        }
      }
    }
    if (changed) {
      fs.writeFileSync(getHistoryPath(dataDir), JSON.stringify(list, null, 2), "utf8");
    }
    return changed;
  } catch {
    return false;
  }
}

function extractNodeProject(row) {
  const extra = safeJsonParse(row.extra_json, {});
  if (extra?.project && String(extra.project).trim()) {
    return String(extra.project).trim();
  }
  const tags = safeJsonParse(row.tags_json, []);
  for (const t of tags) {
    const s = String(t || "");
    if (s.startsWith("项目:") && s.length > 3) return s.slice(3).trim();
  }
  return "";
}

function fmtDateBucket(sec) {
  const d = new Date(Number(sec || 0) * 1000);
  if (Number.isNaN(d.getTime())) return "未知日期";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function extractFeatureTokens(text, limit = 60) {
  const s = String(text || "").toLowerCase();
  const tokens = new Set();
  const re = /[a-z0-9_.-]{3,}|[\u4e00-\u9fff]{2,}/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const seg = m[0];
    if (/^[a-z0-9_.-]+$/.test(seg)) {
      if (!STOP_TOKENS.has(seg) && !/^\d+$/.test(seg)) tokens.add(seg);
    } else {
      for (let i = 0; i + 1 < seg.length; i++) {
        const bg = seg.slice(i, i + 2);
        if (!STOP_TOKENS.has(bg)) tokens.add(bg);
        if (tokens.size >= limit) break;
      }
    }
    if (tokens.size >= limit) break;
  }
  return tokens;
}

function detectMissingLocalPaths(text) {
  const s = String(text || "");
  const matches = s.match(/[A-Za-z]:\\[^\s"'`<>|*?)\]}，。；、]{3,160}/g) || [];
  const missing = [];
  const seen = new Set();
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:!?]+$/, "");
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    // Only check concrete local paths, skip obvious templates/placeholders
    if (/[<>{}]|\.\.\.|example|foo|bar|xxx/i.test(cleaned)) continue;
    try {
      if (!fs.existsSync(cleaned)) {
        missing.push(cleaned);
        if (missing.length >= 3) break;
      }
    } catch {}
  }
  return missing;
}

export function countPendingEpisodic(engine, { project = "" } = {}) {
  const rows = engine.db
    .prepare(
      "SELECT id, tags_json, extra_json FROM nodes WHERE layer = 'episodic' AND lifecycle_state = 'active' AND protected = 0"
    )
    .all();
  const projFilter = String(project || "").trim().toLowerCase();
  let count = 0;
  for (const r of rows) {
    const tags = safeJsonParse(r.tags_json, []);
    if (tags.includes("consolidated")) continue;
    if (projFilter) {
      const p = extractNodeProject(r).toLowerCase();
      if (p !== projFilter) continue;
    }
    count++;
  }
  return count;
}

export function countActiveKnowledge(engine) {
  const row = engine.db
    .prepare("SELECT COUNT(*) AS cnt FROM nodes WHERE layer IN ('knowledge', 'structural') AND lifecycle_state = 'active'")
    .get();
  return Number(row?.cnt || 0);
}

export function findRelatedKnowledge(engine, clusterNodes, { limit = 4, project = "" } = {}) {
  const combinedTitle = (clusterNodes || [])
    .map((n) => String(n.title || "").trim())
    .filter(Boolean)
    .join(" ");
  const query = combinedTitle.slice(0, 180);
  if (!query) return [];
  try {
    const hits = engine.recall({
      query,
      layers: ["knowledge", "structural"],
      project: project && project !== "通用情景" ? project : null,
      allowFallback: false,
      strictness: "balanced",
      limit: Math.max(2, Math.min(6, limit)),
      touch: false,
    });
    const out = [];
    for (const h of hits || []) {
      const full = engine.readMemory(h.id);
      if (full && full.lifecycle_state === "active") out.push(full);
    }
    return out;
  } catch {
    return [];
  }
}

export function planOrganizeClusters(
  engine,
  {
    maxNodes = 24,
    clusterSize = 6,
    project = "",
    order = "oldest",
    sourceIds = null,
  } = {}
) {
  const isAll = maxNodes === 0 || maxNodes === "0" || maxNodes === "all";
  const safeMax = isAll ? 2000 : Math.max(1, Math.min(2000, Number(maxNodes) || 24));
  const safeClusterSize = Math.max(2, Math.min(12, Number(clusterSize) || 6));
  const projFilter = String(project || "").trim().toLowerCase();

  let rows = [];
  if (Array.isArray(sourceIds) && sourceIds.length > 0) {
    const cleanIds = [...new Set(sourceIds.map((x) => String(x || "").trim()).filter(Boolean))].slice(0, safeMax);
    if (cleanIds.length > 0) {
      const placeholders = cleanIds.map(() => "?").join(",");
      rows = engine.db
        .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders}) AND lifecycle_state = 'active'`)
        .all(...cleanIds);
    }
  } else {
    const dir = order === "newest" ? "DESC" : "ASC";
    rows = engine.db
      .prepare(
        `SELECT * FROM nodes
         WHERE layer = 'episodic' AND lifecycle_state = 'active' AND protected = 0
         ORDER BY created_at ${dir}
         LIMIT 2000`
      )
      .all();
  }

  const eligible = [];
  for (const r of rows) {
    const tags = safeJsonParse(r.tags_json, []);
    if (!Array.isArray(sourceIds) && tags.includes("consolidated")) continue;
    const proj = extractNodeProject(r);
    if (projFilter && proj.toLowerCase() !== projFilter) continue;
    eligible.push({ row: r, project: proj || "通用情景", day: fmtDateBucket(r.created_at) });
  }

  const totalAvailable = eligible.length;
  const chosen = eligible.slice(0, safeMax);

  const byProject = new Map();
  for (const item of chosen) {
    if (!byProject.has(item.project)) byProject.set(item.project, []);
    byProject.get(item.project).push(item);
  }

  const clusters = [];
  for (const [projName, list] of byProject.entries()) {
    list.sort((a, b) => Number(a.row.created_at || 0) - Number(b.row.created_at || 0));
    let offset = 0;
    let part = 1;
    while (offset < list.length) {
      let end = Math.min(list.length, offset + safeClusterSize);
      if (list.length - end === 1 && end - offset < 12) {
        end = list.length;
      }
      const slice = list.slice(offset, end);
      const days = [...new Set(slice.map((x) => x.day))];
      const dayTag = days.length === 1 ? days[0] : `${days[0]}~${days[days.length - 1]}`;
      const nodes = slice
        .map((x) => engine.readMemory(x.row.id))
        .filter(Boolean);
      if (nodes.length > 0) {
        clusters.push({
          index: clusters.length + 1,
          project: projName,
          dayTag,
          label: `${projName}${list.length > safeClusterSize ? ` #${part}` : ""}（${dayTag}）`,
          nodeIds: nodes.map((n) => n.id),
          nodes,
        });
      }
      offset = end;
      part++;
    }
  }

  return {
    totalAvailable,
    selectedCount: chosen.length,
    clusters,
  };
}

export async function runOrganizeSession(
  engine,
  {
    mode = "manual",
    maxNodes = 24,
    clusterSize = 6,
    project = "",
    order = "oldest",
    archiveSources = true,
    checkExisting = true,
    dryRun = false,
    sourceIds = null,
    jobId = null,
  } = {},
  { onEvent = null, shouldStop = null } = {}
) {
  const id = jobId || `org_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();
  const logs = [];
  const results = [];
  const stats = {
    totalAvailable: 0,
    totalCandidates: 0,
    totalClusters: 0,
    completedClusters: 0,
    createdNodes: 0,
    updatedNodes: 0,
    supersededNodes: 0,
    archivedSources: 0,
    skippedClusters: 0,
    errors: 0,
  };

  const emit = (type, message, extra = {}) => {
    const entry = { ts: Date.now(), type, message, ...extra };
    logs.push(entry);
    if (logs.length > 300) logs.shift();
    if (typeof onEvent === "function") {
      try {
        onEvent({ jobId: id, entry, stats: { ...stats }, results: [...results] });
      } catch {}
    }
    return entry;
  };

  const cfg = engine.loadConfig();
  const creds = resolveAiCredentials(cfg.ai);
  if (!creds.llmEnabled || !creds.llmApiKey) {
    const errMsg = !creds.llmEnabled
      ? "聊天模型开关当前已关闭，请先在「可选 AI 增强」中开启聊天模型开关。"
      : "未配置聊天模型 API Key，请先在「可选 AI 增强」中一键从苍蓝协奏台导入或填写密钥。";
    emit("error", errMsg);
    const finished = {
      id,
      taskType: "episodic",
      mode,
      status: "error",
      dryRun: Boolean(dryRun),
      startedAt,
      endedAt: Date.now(),
      model: creds.llmModel,
      stats,
      results,
      logs,
      error: errMsg,
    };
    appendOrganizeHistory(engine.dataDir, finished);
    return finished;
  }

  emit(
    "scan",
    `开始扫描待整理情景记忆（模式：${mode === "auto" ? "后台自动" : "手动即时"}${dryRun ? " · 试跑预览" : ""}${checkExisting ? " · 含查旧合并/取代" : ""}，模型：${creds.llmModel}）...`
  );

  const plan = planOrganizeClusters(engine, { maxNodes, clusterSize, project, order, sourceIds });
  stats.totalAvailable = plan.totalAvailable;
  stats.totalCandidates = plan.selectedCount;
  stats.totalClusters = plan.clusters.length;

  if (plan.clusters.length === 0) {
    emit("done", "当前没有符合条件的待整理情景节点，记忆库已经很整洁啦。");
    const finished = {
      id,
      taskType: "episodic",
      mode,
      status: "done",
      dryRun: Boolean(dryRun),
      startedAt,
      endedAt: Date.now(),
      model: creds.llmModel,
      stats,
      results,
      logs,
    };
    appendOrganizeHistory(engine.dataDir, finished);
    return finished;
  }

  emit(
    "group",
    `扫描完成：共发现 ${plan.totalAvailable} 条待整理情景，本次纳入 ${plan.selectedCount} 条，按项目与时间切分为 ${plan.clusters.length} 组。`
  );

  let stopped = false;

  for (const cluster of plan.clusters) {
    if (typeof shouldStop === "function" && shouldStop()) {
      stopped = true;
      emit("warn", `已收到停止信号，跳过剩余 ${plan.clusters.length - stats.completedClusters} 组，已写入的结果均已保留。`);
      break;
    }

    const previewTitles = cluster.nodes.slice(0, 3).map((n) => `「${String(n.title || n.id).slice(0, 22)}」`).join("、");
    const existingKnowledge = checkExisting
      ? findRelatedKnowledge(engine, cluster.nodes, { limit: 4, project: cluster.project })
      : [];

    emit(
      "step",
      `[${cluster.index}/${plan.clusters.length}] 正在处理分组：${cluster.label}（${cluster.nodes.length} 条情景：${previewTitles}${cluster.nodes.length > 3 ? " 等" : ""}${existingKnowledge.length ? `；检索到 ${existingKnowledge.length} 条相关旧知识用于去重/取代对比` : ""}）`,
      { clusterIndex: cluster.index, totalClusters: plan.clusters.length, clusterLabel: cluster.label }
    );

    try {
      emit("ai", `[${cluster.index}/${plan.clusters.length}] 正在调用 ${creds.llmModel} 提炼知识并比对旧记录...`, {
        clusterIndex: cluster.index,
      });

      const t0 = Date.now();
      const draft = await synthesizeConsolidation(cluster.nodes, cfg.ai, {
        timeoutMs: 45000,
        existingKnowledge,
      });
      const latencyMs = Date.now() - t0;

      if (dryRun) {
        stats.completedClusters++;
        if (draft.action === "update") stats.updatedNodes++;
        else stats.createdNodes++;
        stats.supersededNodes += (draft.supersededIds || []).length;

        const previewItem = {
          id: draft.action === "update" ? draft.targetId : null,
          taskType: "episodic",
          action: draft.action,
          targetId: draft.targetId,
          supersededIds: draft.supersededIds || [],
          reason: draft.reason || "",
          dryRun: true,
          title: draft.title,
          layer: draft.targetLayer || "knowledge",
          tags: draft.tags || [],
          summary: draft.summary,
          sourceCount: cluster.nodes.length,
          sourceIds: cluster.nodeIds,
          clusterLabel: cluster.label,
          latencyMs,
        };
        results.push(previewItem);
        const actLabel = draft.action === "update"
          ? `合并更新旧知识 ${draft.targetId}`
          : (draft.action === "supersede" ? `新建并取代 ${draft.supersededIds.length} 条旧知识` : "新建知识");
        emit(
          "ok",
          `[${cluster.index}/${plan.clusters.length}] 试跑提炼完成（${(latencyMs / 1000).toFixed(1)}s，未落盘）：[${actLabel}] 《${draft.title}》${draft.reason ? ` — ${draft.reason}` : ""}`,
          { result: previewItem }
        );
      } else {
        const extraTags = [...new Set([...(draft.tags || []), "auto-organized"])];
        if (cluster.project && cluster.project !== "通用情景") {
          extraTags.push(`项目:${cluster.project}`);
        }

        let targetNode = null;
        let supersededCount = 0;

        if (draft.action === "update" && draft.targetId && engine.readMemory(draft.targetId)) {
          const prev = engine.readMemory(draft.targetId);
          const mergedTags = [...new Set([...(prev.tags || []), ...extraTags])];
          const mergedDerived = [...new Set([...(prev.derived_from || prev.extra?.derived_from || []), ...(cluster.nodeIds || [])])];
          const mergedEvidence = [...(prev.evidence_files || prev.extra?.evidence_files || [])];
          for (const sid of cluster.nodeIds || []) {
            const srcNode = engine.readMemory(sid);
            if (srcNode?.evidence_files?.length) mergedEvidence.push(...srcNode.evidence_files);
          }
          targetNode = engine.updateMemory(draft.targetId, {
            title: draft.title || prev.title,
            content: draft.summary,
            tags: mergedTags,
            derived_from: mergedDerived,
            ...(mergedEvidence.length > 0 ? { evidence_files: mergedEvidence } : {}),
            override: true,
          });
          for (const sid of cluster.nodeIds) {
            try { engine.linkMemories(targetNode.id, sid, "derived_from", 1.0); } catch {}
          }
          stats.updatedNodes++;
        } else {
          targetNode = engine.consolidateCluster({
            sourceIds: cluster.nodeIds,
            title: draft.title,
            summary: draft.summary,
            tags: extraTags,
            targetLayer: draft.targetLayer || "knowledge",
            archiveSources: false,
          });
          stats.createdNodes++;
        }

        for (const oldId of draft.supersededIds || []) {
          if (!oldId || oldId === targetNode.id) continue;
          try {
            engine.linkMemories(targetNode.id, oldId, "supersedes", 1.0);
            engine.forgetMemory(oldId, { reason: `superseded_by:${targetNode.id}`, override: true });
            supersededCount++;
          } catch {}
        }
        stats.supersededNodes += supersededCount;

        let archivedInGroup = 0;
        if (archiveSources) {
          for (const sid of cluster.nodeIds) {
            try {
              engine.forgetMemory(sid, { reason: `organized_into:${targetNode.id}`, override: false });
              archivedInGroup++;
            } catch {}
          }
        }

        stats.completedClusters++;
        stats.archivedSources += archivedInGroup;

        const resItem = {
          id: targetNode.id,
          taskType: "episodic",
          action: draft.action,
          targetId: draft.targetId,
          supersededIds: draft.supersededIds || [],
          supersededCount,
          reason: draft.reason || "",
          dryRun: false,
          title: targetNode.title,
          layer: targetNode.layer,
          tags: targetNode.tags || [],
          summary: String(targetNode.body || "").slice(0, 260),
          sourceCount: cluster.nodes.length,
          archivedCount: archivedInGroup,
          sourceIds: cluster.nodeIds,
          clusterLabel: cluster.label,
          latencyMs,
        };
        results.push(resItem);

        const actDesc = draft.action === "update"
          ? `已更新合并旧知识（已自动留 .bak 快照）`
          : (supersededCount > 0 ? `已新建并软归档 ${supersededCount} 条过时旧知识` : `已落盘新记忆`);
        emit(
          "ok",
          `[${cluster.index}/${plan.clusters.length}] ${actDesc}（${(latencyMs / 1000).toFixed(1)}s）：《${targetNode.title}》[${targetNode.layer}]${draft.reason ? ` — ${draft.reason}` : ""}`,
          { result: resItem }
        );
      }
    } catch (err) {
      stats.completedClusters++;
      stats.errors++;
      emit(
        "error",
        `[${cluster.index}/${plan.clusters.length}] 分组「${cluster.label}」提炼失败：${err?.message || String(err)}`
      );
    }
  }

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const status = stopped ? "stopped" : (stats.errors > 0 && stats.createdNodes + stats.updatedNodes === 0 ? "error" : "done");
  emit(
    stopped ? "warn" : "done",
    `${stopped ? "整理已手动停止" : "全部整理完成"}（耗时 ${durationSec}s）：共处理 ${stats.completedClusters}/${stats.totalClusters} 组，${dryRun ? "试跑预览" : "落盘"}新建 ${stats.createdNodes} 条、合并更新 ${stats.updatedNodes} 条、取代过时旧知识 ${stats.supersededNodes} 条，归档源情景 ${stats.archivedSources} 条${stats.errors ? `，失败 ${stats.errors} 组` : ""}。`
  );

  const finished = {
    id,
    taskType: "episodic",
    mode,
    status,
    dryRun: Boolean(dryRun),
    startedAt,
    endedAt: Date.now(),
    model: creds.llmModel,
    stats,
    results,
    logs,
  };
  if (typeof engine.checkpointWal === "function") engine.checkpointWal("PASSIVE");
  appendOrganizeHistory(engine.dataDir, finished);
  return finished;
}

// ============================================================
// Scheme 2: Knowledge Base Outdated & Deduplication Audit
// ============================================================

export function planKnowledgeAuditClusters(
  engine,
  { maxClusters = 12, project = "", minSimilarity = 0.26 } = {}
) {
  const isAll = maxClusters === 0 || maxClusters === "0" || maxClusters === "all";
  const safeMaxClusters = isAll ? 120 : Math.max(1, Math.min(120, Number(maxClusters) || 12));
  const projFilter = String(project || "").trim().toLowerCase();

  const rows = engine.db
    .prepare(
      `SELECT * FROM nodes
       WHERE layer IN ('knowledge', 'structural') AND lifecycle_state = 'active'
       ORDER BY created_at ASC`
    )
    .all();

  const items = [];
  for (const r of rows) {
    const proj = extractNodeProject(r);
    if (projFilter && proj.toLowerCase() !== projFilter) continue;
    const titleTokens = extractFeatureTokens(r.title, 28);
    const bodyTokens = extractFeatureTokens(`${r.title} ${safeJsonParse(r.tags_json, []).join(" ")} ${String(r.body || "").slice(0, 600)}`, 64);
    items.push({
      row: r,
      project: proj,
      titleTokens,
      bodyTokens,
    });
  }

  function pairScore(a, b) {
    if (a.bodyTokens.size === 0 || b.bodyTokens.size === 0) return 0;
    let bodyInter = 0;
    for (const t of a.bodyTokens) if (b.bodyTokens.has(t)) bodyInter++;
    if (bodyInter < 2) return 0;
    const bodyUnion = a.bodyTokens.size + b.bodyTokens.size - bodyInter;
    const jaccard = bodyInter / Math.max(1, bodyUnion);
    const overlap = bodyInter / Math.max(1, Math.min(a.bodyTokens.size, b.bodyTokens.size));

    let titleInter = 0;
    for (const t of a.titleTokens) if (b.titleTokens.has(t)) titleInter++;
    const titleOverlap = a.titleTokens.size && b.titleTokens.size
      ? titleInter / Math.max(1, Math.min(a.titleTokens.size, b.titleTokens.size))
      : 0;

    const sameProjBonus = a.project && b.project && a.project === b.project ? 0.03 : 0;
    return jaccard * 0.45 + overlap * 0.25 + titleOverlap * 0.35 + sameProjBonus;
  }

  // Greedy similarity clustering: only group genuinely overlapping knowledge nodes
  const used = new Set();
  const rawClusters = [];

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const seed = items[i];
    const neighbors = [];
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      const sc = pairScore(seed, items[j]);
      if (sc >= minSimilarity) {
        neighbors.push({ idx: j, score: sc });
      }
    }
    if (neighbors.length === 0) continue;
    neighbors.sort((a, b) => b.score - a.score);
    const groupIdx = [i, ...neighbors.slice(0, 5).map((x) => x.idx)];
    for (const gi of groupIdx) used.add(gi);
    const avgScore = neighbors.slice(0, 5).reduce((acc, x) => acc + x.score, 0) / Math.min(5, neighbors.length);

    const groupNodes = groupIdx
      .map((gi) => engine.readMemory(items[gi].row.id))
      .filter(Boolean)
      .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0))
      .map((n) => ({ ...n, missingPaths: detectMissingLocalPaths(n.body) }));

    if (groupNodes.length >= 2) {
      rawClusters.push({
        avgScore,
        project: seed.project || "跨项目主题",
        label: `「${String(groupNodes[groupNodes.length - 1].title || "").slice(0, 24)}」等 ${groupNodes.length} 条相似知识`,
        nodeIds: groupNodes.map((n) => n.id),
        nodes: groupNodes,
      });
    }
  }

  // Prioritize clusters with highest similarity (most likely duplicate / superseded)
  rawClusters.sort((a, b) => b.avgScore - a.avgScore);
  const selected = rawClusters.slice(0, safeMaxClusters).map((c, idx) => ({ ...c, index: idx + 1 }));

  return {
    totalScanned: items.length,
    totalSuspectClusters: rawClusters.length,
    clusters: selected,
  };
}

export function applyKnowledgeAuditDecision(engine, decision) {
  const { status, keepId, archiveIds = [], mergedTitle = "", mergedSummary = "", mergedTags = [], reason = "" } = decision || {};
  if (!status || status === "clean") {
    return { applied: false, reason: "无需修改" };
  }
  if (!keepId) throw new Error("缺少保留主节点 keepId");
  const keepNode = engine.readMemory(keepId);
  if (!keepNode || keepNode.lifecycle_state !== "active") {
    throw new Error(`主保留节点不存在或已归档: ${keepId}`);
  }

  let updatedKeep = keepNode;
  let backedUp = false;
  const activeArchiveNodes = [];
  for (const aid of archiveIds || []) {
    if (!aid || aid === keepId) continue;
    const oldNode = engine.readMemory(aid);
    if (oldNode && oldNode.lifecycle_state === "active") activeArchiveNodes.push(oldNode);
  }
  const mergedDerived = status === "merge"
    ? [...new Set([...(keepNode.derived_from || keepNode.extra?.derived_from || []), ...activeArchiveNodes.map((n) => n.id)])]
    : null;
  const mergedEvidence = status === "merge"
    ? [
        ...(keepNode.evidence_files || keepNode.extra?.evidence_files || []),
        ...activeArchiveNodes.flatMap((n) => n.evidence_files || n.extra?.evidence_files || []),
      ]
    : null;

  if ((mergedSummary && String(mergedSummary).trim()) || (status === "merge" && activeArchiveNodes.length > 0)) {
    const nextTags = [...new Set([...(keepNode.tags || []), ...(mergedTags || [])])];
    updatedKeep = engine.updateMemory(keepId, {
      ...(mergedSummary && String(mergedSummary).trim() ? { title: mergedTitle || keepNode.title, content: mergedSummary, tags: nextTags } : {}),
      ...(mergedDerived && mergedDerived.length > 0 ? { derived_from: mergedDerived } : {}),
      ...(mergedEvidence && mergedEvidence.length > 0 ? { evidence_files: mergedEvidence } : {}),
      override: true,
    });
    backedUp = true;
  }

  const archivedList = [];
  const relation = status === "merge" ? "merged_from" : "supersedes";
  const reasonPrefix = status === "merge" ? "merged_into" : "superseded_by";

  for (const oldNode of activeArchiveNodes) {
    const aid = oldNode.id;
    try {
      engine.linkMemories(keepId, aid, relation, 1.0);
    } catch {}
    engine.forgetMemory(aid, {
      reason: `${reasonPrefix}:${keepId}${reason ? ` (${reason.slice(0, 80)})` : ""}`,
      override: true,
    });
    archivedList.push(aid);
  }

  return {
    applied: true,
    status,
    keepId: updatedKeep.id,
    keepTitle: updatedKeep.title,
    backedUp,
    archivedIds: archivedList,
  };
}

export async function runKnowledgeAuditSession(
  engine,
  {
    mode = "manual",
    maxClusters = 12,
    project = "",
    dryRun = true,
    jobId = null,
  } = {},
  { onEvent = null, shouldStop = null } = {}
) {
  const id = jobId || `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();
  const logs = [];
  const results = [];
  const stats = {
    totalAvailable: 0,
    totalCandidates: 0,
    totalClusters: 0,
    completedClusters: 0,
    createdNodes: 0,
    updatedNodes: 0,
    supersededNodes: 0,
    archivedSources: 0,
    cleanClusters: 0,
    errors: 0,
  };

  const emit = (type, message, extra = {}) => {
    const entry = { ts: Date.now(), type, message, ...extra };
    logs.push(entry);
    if (logs.length > 300) logs.shift();
    if (typeof onEvent === "function") {
      try {
        onEvent({ jobId: id, entry, stats: { ...stats }, results: [...results] });
      } catch {}
    }
    return entry;
  };

  const cfg = engine.loadConfig();
  const creds = resolveAiCredentials(cfg.ai);
  if (!creds.llmEnabled || !creds.llmApiKey) {
    const errMsg = !creds.llmEnabled
      ? "聊天模型开关当前已关闭，请先在「可选 AI 增强」中开启聊天模型开关。"
      : "未配置聊天模型 API Key，请先在「可选 AI 增强」中导入或填写密钥。";
    emit("error", errMsg);
    const finished = {
      id,
      taskType: "audit",
      mode,
      status: "error",
      dryRun: Boolean(dryRun),
      startedAt,
      endedAt: Date.now(),
      model: creds.llmModel,
      stats,
      results,
      logs,
      error: errMsg,
    };
    appendOrganizeHistory(engine.dataDir, finished);
    return finished;
  }

  emit(
    "scan",
    `开始离线相似度预筛知识库（模式：${dryRun ? "仅生成体检建议 · 需确认采纳" : "自动合并并软归档过时知识"}，模型：${creds.llmModel}）...`
  );

  const plan = planKnowledgeAuditClusters(engine, { maxClusters, project });
  stats.totalAvailable = plan.totalScanned;
  stats.totalCandidates = plan.clusters.reduce((acc, c) => acc + c.nodes.length, 0);
  stats.totalClusters = plan.clusters.length;

  if (plan.clusters.length === 0) {
    emit("done", `已扫描全部 ${plan.totalScanned} 条活跃知识，未发现疑似重复或冲突的知识分组，知识库非常健康！`);
    const finished = {
      id,
      taskType: "audit",
      mode,
      status: "done",
      dryRun: Boolean(dryRun),
      startedAt,
      endedAt: Date.now(),
      model: creds.llmModel,
      stats,
      results,
      logs,
    };
    appendOrganizeHistory(engine.dataDir, finished);
    return finished;
  }

  emit(
    "group",
    `离线预筛完成：从 ${plan.totalScanned} 条活跃知识中筛选出 ${plan.totalSuspectClusters} 组疑似重复/新旧迭代主题（其余独立知识直接跳过省 Token），本次体检前 ${plan.clusters.length} 组（共 ${stats.totalCandidates} 条）。`
  );

  let stopped = false;

  for (const cluster of plan.clusters) {
    if (typeof shouldStop === "function" && shouldStop()) {
      stopped = true;
      emit("warn", `已收到停止信号，跳过剩余 ${plan.clusters.length - stats.completedClusters} 组体检。`);
      break;
    }

    emit(
      "step",
      `[${cluster.index}/${plan.clusters.length}] 正在体检相似组：${cluster.label}（相似度 ${(cluster.avgScore * 100).toFixed(0)}%）`
    );

    try {
      emit("ai", `[${cluster.index}/${plan.clusters.length}] 调用 ${creds.llmModel} 对比新旧时间线与内容冲突...`);
      const t0 = Date.now();
      const verdict = await auditKnowledgeCluster(cluster.nodes, cfg.ai, { timeoutMs: 45000 });
      const latencyMs = Date.now() - t0;

      if (verdict.status === "clean") {
        stats.completedClusters++;
        stats.cleanClusters++;
        emit(
          "ok",
          `[${cluster.index}/${plan.clusters.length}] 核验健康（${(latencyMs / 1000).toFixed(1)}s）：全部保留 — ${verdict.reason}`
        );
        continue;
      }

      const keepNode = cluster.nodes.find((n) => n.id === verdict.keepId) || cluster.nodes[cluster.nodes.length - 1];
      const archiveTitles = verdict.archiveIds.map((aid) => {
        const hit = cluster.nodes.find((n) => n.id === aid);
        return hit ? hit.title : aid;
      });

      let applied = false;
      if (!dryRun) {
        const exec = applyKnowledgeAuditDecision(engine, verdict);
        applied = Boolean(exec.applied);
        if (verdict.status === "merge" && verdict.mergedSummary) stats.updatedNodes++;
        stats.supersededNodes += exec.archivedIds.length;
        stats.archivedSources += exec.archivedIds.length;
      } else {
        if (verdict.status === "merge") stats.updatedNodes++;
        stats.supersededNodes += verdict.archiveIds.length;
      }
      stats.completedClusters++;

      const cardId = `aud_item_${cluster.index}_${Date.now().toString(36)}`;
      const resItem = {
        cardId,
        id: verdict.keepId,
        taskType: "audit",
        action: verdict.status,
        dryRun: Boolean(dryRun),
        applied,
        title: verdict.mergedTitle || keepNode?.title || verdict.keepId,
        layer: keepNode?.layer || "knowledge",
        summary: verdict.mergedSummary ? verdict.mergedSummary.slice(0, 260) : String(keepNode?.body || "").slice(0, 220),
        reason: verdict.reason,
        sourceCount: cluster.nodes.length,
        archiveIds: verdict.archiveIds,
        archiveTitles,
        verdict,
        latencyMs,
      };
      results.push(resItem);

      const actName = verdict.status === "merge" ? "建议合并重复" : "发现过时旧知识";
      emit(
        "ok",
        `[${cluster.index}/${plan.clusters.length}] ${applied ? "已自动处理" : actName}（${(latencyMs / 1000).toFixed(1)}s）：保留《${resItem.title}》，${applied ? "已软归档" : "待归档"} ${verdict.archiveIds.length} 条 — ${verdict.reason}`,
        { result: resItem }
      );
    } catch (err) {
      stats.completedClusters++;
      stats.errors++;
      emit("error", `[${cluster.index}/${plan.clusters.length}] 体检失败：${err?.message || String(err)}`);
    }
  }

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const status = stopped ? "stopped" : (stats.errors > 0 && results.length === 0 && stats.cleanClusters === 0 ? "error" : "done");
  emit(
    stopped ? "warn" : "done",
    `${stopped ? "知识体检已手动停止" : "知识库体检完成"}（耗时 ${durationSec}s）：体检 ${stats.completedClusters}/${stats.totalClusters} 组，健康无需改动 ${stats.cleanClusters} 组，检出可优化 ${results.length} 组（涉及过时/重复 ${stats.supersededNodes} 条${dryRun ? "，可在右侧逐条点「采纳」执行" : "，均已留快照并软归档"}）。`
  );

  const finished = {
    id,
    taskType: "audit",
    mode,
    status,
    dryRun: Boolean(dryRun),
    startedAt,
    endedAt: Date.now(),
    model: creds.llmModel,
    stats,
    results,
    logs,
  };
  if (typeof engine.checkpointWal === "function") engine.checkpointWal("PASSIVE");
  appendOrganizeHistory(engine.dataDir, finished);
  return finished;
}
