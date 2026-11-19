import path from "node:path";
import { LanxiEngine } from "../lib/engine.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const FILLER_RE = /(?:不需要的|不需要|有没有|那就|这个|那个|我们|你们|他们|它们|咱们|这里|那里|一下吧|一下|什么|可以|怎么|没有|还是|或者|已经|现在|刚才|觉得|认为|需要|跟进|但是|不过|其实|好像|大概|可能|应该|随便|都行|因为|所以|如果|然后|就是|不是|帮我|给我|看看|好呀|好的|谢谢)/g;
const EDGE_PARTICLE_RE = /[吗呢吧呀啊哦嘛，。！？、,.!?\s]+/g;

function extractRecallQuery(text) {
  return String(text || "")
    .replace(FILLER_RE, " ")
    .replace(EDGE_PARTICLE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractProjectName(input) {
  const raw = (Array.isArray(input?.workspacePaths) && input.workspacePaths[0]) || input?.cwd || "";
  const trimmed = String(raw || "").trim().replace(/[\\/]+$/, "");
  if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) return "";
  const base = path.basename(trimmed);
  return base.length >= 2 ? base : "";
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
    const cleanedQuery = extractRecallQuery(userText);
    const project = extractProjectName(input);

    if (cfg.autoRecall && userText.length >= 8 && cleanedQuery.length >= 3) {
      const hits = engine.recall({
        query: cleanedQuery,
        layers: ["structural", "knowledge", "episodic", "goals", "unresolved"],
        project,
        allowFallback: false,
        limit: cfg.recallWindow || 6,
        touch: false,
      });

      const idHits = engine
        .recall({
          query: cleanedQuery,
          layers: ["anchor", "self"],
          project,
          allowFallback: false,
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

      const merged = [...idHits, ...hits].slice(0, cfg.recallWindow || 6);
      if (merged.length > 0) {
        const recallLines = ["【蓝汐自动召回（参考记忆，按需可用 cg_read 读全文）】"];
        let budget = cfg.recallMaxChars || 1600;
        for (const item of merged) {
          const line = `- [${item.layer}|id:${item.id}|重要度:${item.importance}] ${item.title}: ${item.preview}`;
          if (line.length > budget) break;
          recallLines.push(line);
          budget -= line.length + 1;
        }
        if (recallLines.length > 1) {
          parts.push(recallLines.join("\n"));
        }
      }
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
