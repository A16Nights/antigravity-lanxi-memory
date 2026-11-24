import path from "node:path";
import { LanxiEngine } from "../lib/engine.mjs";

function extractProjectName(input) {
  const raw = (Array.isArray(input?.workspacePaths) && input.workspacePaths[0]) || input?.cwd || "";
  const trimmed = String(raw || "").trim().replace(/[\\/]+$/, "");
  if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) return "";
  const base = path.basename(trimmed);
  return base.length >= 2 ? base : "";
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function main(input = {}) {
  const engine = new LanxiEngine();
  try {
    const cfg = engine.loadConfig();
    if (cfg.autoSessionStart === false) return {};

    // Lightweight mtime-based incremental sync for enabled external knowledge sources
    try {
      if (Array.isArray(cfg.externalSources) && cfg.externalSources.some((s) => s && s.enabled !== false)) {
        engine.syncExternalSources({ force: false });
      }
    } catch {}

    const overview = engine.getOverview();
    const project = extractProjectName(input);
    const identityRows = engine.recall({
      query: "",
      layers: ["anchor", "self"],
      limit: 3,
      touch: false,
    });
    const goals = engine.listGoals().filter((g) => (g.extra?.status || "active") === "active").slice(0, 3);

    const lines = [];
    lines.push(`[蓝汐 · 认知图谱已就绪] 活跃节点 ${overview.totalNodes} 个（硬保护 ${overview.protectedCount}，图谱边 ${overview.edgesCount}）。`);

    if (cfg.projectBriefing !== false && project) {
      const briefing = engine.buildProjectBriefing(project, { maxChars: 850 });
      if (briefing.nodeCount > 0 && briefing.text) {
        lines.push(briefing.text);
      }
    }

    if (identityRows.length > 0) {
      lines.push("【身份与自我锚点】");
      for (const n of identityRows) {
        const snippet = String(n.body || n.preview || "").replace(/\s+/g, " ").trim().slice(0, 160);
        lines.push(`- [${n.layer}] ${n.title}: ${snippet}`);
      }
    }

    if (goals.length > 0) {
      lines.push("【当前活跃目标】");
      for (const g of goals) {
        const prog = g.extra?.progress ?? 0;
        lines.push(`- ${g.title}（进度 ${prog}%）`);
      }
    }

    if (lines.length <= 1 && overview.totalNodes === 0) return {};

    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: lines.join("\n"),
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
