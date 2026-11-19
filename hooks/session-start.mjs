import { LanxiEngine } from "../lib/engine.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function main() {
  const engine = new LanxiEngine();
  try {
    const cfg = engine.loadConfig();
    if (cfg.autoSessionStart === false) return {};

    const overview = engine.getOverview();
    const identityRows = engine.recall({
      query: "",
      layers: ["anchor", "self"],
      limit: 3,
      touch: false,
    });
    const goals = engine.listGoals().filter((g) => (g.extra?.status || "active") === "active").slice(0, 3);

    const lines = [];
    lines.push(`[蓝汐 · 认知图谱已就绪] 活跃节点 ${overview.totalNodes} 个（硬保护 ${overview.protectedCount}，图谱边 ${overview.edgesCount}）。`);

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
  await readStdin();
  const out = main();
  process.stdout.write(JSON.stringify(out) + "\n");
} catch {
  process.stdout.write("{}\n");
}
