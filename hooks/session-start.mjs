import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LanxiEngine } from "../lib/engine.mjs";

const DATA_DIR = process.env.LANXI_DATA_DIR || path.join(os.homedir(), ".gemini", "lanxi-memory");
const SEEN_FILE = path.join(DATA_DIR, "session-start-seen.json");
const MAX_SEEN_ENTRIES = 200;

function hasSessionStartedBefore(convId) {
  if (!convId || convId === "default") return false;
  try {
    if (!fs.existsSync(SEEN_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
    return Boolean(data && typeof data === "object" && data[convId]);
  } catch {
    return false;
  }
}

function markSessionStarted(convId) {
  if (!convId || convId === "default") return;
  try {
    let data = {};
    if (fs.existsSync(SEEN_FILE)) {
      try { data = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")) || {}; } catch { data = {}; }
    }
    data[convId] = Date.now();
    const entries = Object.entries(data).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, MAX_SEEN_ENTRIES);
    const trimmed = Object.fromEntries(entries);
    fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    const tmp = `${SEEN_FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(trimmed), "utf8");
    fs.renameSync(tmp, SEEN_FILE);
  } catch {
    // fail-open
  }
}

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
  const convId = String(input?.conversationId || input?.conversation_id || "").trim();
  const initSteps = Number(input?.initialNumSteps ?? input?.initial_num_steps ?? 0);
  // Antigravity 2.35.1+ 重启/更新后自动恢复进行中会话时，避免重复注入整段开场简报
  if ((Number.isFinite(initSteps) && initSteps > 0) || hasSessionStartedBefore(convId)) {
    return {};
  }

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

    markSessionStarted(convId);
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
