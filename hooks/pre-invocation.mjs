import path from "node:path";
import { LanxiEngine } from "../lib/engine.mjs";
import {
  cleanRecallQuery,
  shouldRunAutoRecall,
  filterRecallResults,
  isPersonaMemoryDisabled,
} from "../lib/recall-filter.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function extractProjectName(input) {
  const raw = (Array.isArray(input?.workspacePaths) && input.workspacePaths[0]) || input?.cwd || "";
  const trimmed = String(raw || "").trim().replace(/[\\/]+$/, "");
  if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) return "";
  const base = path.basename(trimmed);
  return base.length >= 2 ? base : "";
}

function buildAutoRecallBlock(engine, cfg, userText, project) {
  const gate = shouldRunAutoRecall(userText);
  if (!gate.allow) return null;

  const cleanedQuery = gate.cleaned || cleanRecallQuery(userText);
  const strictness = cfg.recallStrictness || "strict";
  const window = cfg.recallWindow || 6;

  const hits = engine.recall({
    query: cleanedQuery,
    layers: ["structural", "knowledge", "episodic", "goals", "unresolved"],
    project,
    allowFallback: false,
    strictness,
    limit: window,
    touch: false,
  });

  const idHits = engine
    .recall({
      query: cleanedQuery,
      layers: ["anchor", "self"],
      project,
      allowFallback: false,
      strictness,
      limit: 2,
      touch: false,
    })
    .filter((h) => {
      const qLower = cleanedQuery.toLowerCase();
      return (
        String(h.title || "").toLowerCase().includes(qLower) ||
        (h.tags || []).some((t) => qLower.includes(String(t).toLowerCase()))
      );
    });

  const merged = [...idHits, ...(Array.isArray(hits) ? hits : [])].slice(0, window);
  const kept = filterRecallResults(merged, {
    minScore: typeof cfg.autoRecallMinScore === "number" ? cfg.autoRecallMinScore : 0.55,
    maxChars: cfg.autoRecallMaxChars || cfg.recallMaxChars || 1400,
  });

  // Also search incremental-synced external knowledge sources (if configured)
  const extHits = engine.searchExternalKnowledge(cleanedQuery, { project, limit: 2 });

  if (kept.length === 0 && extHits.length === 0) return null;

  const lines = ["【蓝汐自动召回（参考记忆，仅标题+摘要；需要全文请按 id 调用 cg_read）】"];
  for (const item of kept) {
    const alertTag = Array.isArray(item.alerts) && item.alerts.length > 0 ? ` [⚠️ ${item.alerts[0]}]` : "";
    lines.push(`- [${item.layer}|id:${item.id}] ${item.title}: ${item.preview}${alertTag}`);
  }
  for (const ext of extHits) {
    lines.push(`- [ext:${ext.source_label}|${ext.rel_path}] ${ext.title}: ${ext.preview}`);
  }
  return lines.join("\n");
}

function main(input) {
  const engine = new LanxiEngine();
  try {
    const cfg = engine.loadConfig();
    const convId = input.conversationId || "default";
    const userText = String(input.lastUserInput || "").trim();

    const turnState = engine.recordTurnAndCheck(convId, userText);
    if (!turnState.isNewUserTurn) {
      return {};
    }

    const parts = [];

    try {
      const personaState = isPersonaMemoryDisabled(input, cfg.memoryDisabledPersonas);
      if (personaState.disabled) {
        return {};
      }
      if (cfg.autoRecall) {
        const block = buildAutoRecallBlock(engine, cfg, userText, extractProjectName(input));
        if (block) parts.push(block);
      }
    } catch {
      // fail-open：召回链任何异常都不影响主流程
    }

    const interval = Number(cfg.turnReminderInterval ?? 10);
    if (interval > 0 && turnState.turnCount > 0 && turnState.turnCount % interval === 0) {
      parts.push(
        `【蓝汐长会话归档提醒（第 ${turnState.turnCount} 轮）】如有新的用户偏好、项目决策或关键结论尚未入库，请适时调用 cg_write / cg_reflect 归档。`
      );
    }

    if (parts.length === 0) return {};

    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: parts.join("\n\n"),
          },
        },
      ],
    };
  } finally {
    engine.close();
  }
}

try {
  const raw = await readStdin();
  const input = raw ? JSON.parse(raw) : {};
  const out = main(input);
  process.stdout.write(JSON.stringify(out) + "\n");
} catch {
  process.stdout.write("{}\n");
}
