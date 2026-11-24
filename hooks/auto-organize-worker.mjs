import fs from "node:fs";
import path from "node:path";
import { LanxiEngine } from "../lib/engine.mjs";
import { countPendingEpisodic, runOrganizeSession } from "../lib/organizer.mjs";

const COOLDOWN_MS = 30 * 60 * 1000;

async function main() {
  const engine = new LanxiEngine();
  const lockPath = path.join(engine.dataDir, ".auto-organize.lock");
  try {
    const cfg = engine.loadConfig();
    if (!cfg.autoOrganize || !cfg.ai?.llmEnabled) return;

    const threshold = Math.max(4, Number(cfg.autoOrganizeThreshold || 15));
    const pending = countPendingEpisodic(engine);
    if (pending < threshold) return;

    // Check lock & cooldown
    if (fs.existsSync(lockPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        const age = Date.now() - Number(meta.ts || 0);
        if (meta.running && age < 15 * 60 * 1000) return;
        if (!meta.running && age < COOLDOWN_MS) return;
      } catch {}
    }

    fs.writeFileSync(lockPath, JSON.stringify({ running: true, pid: process.pid, ts: Date.now() }), "utf8");

    await runOrganizeSession(engine, {
      mode: "auto",
      maxNodes: Math.min(12, threshold),
      clusterSize: 6,
      order: "oldest",
      archiveSources: cfg.autoOrganizeArchiveSources !== false,
      dryRun: false,
    });

    fs.writeFileSync(lockPath, JSON.stringify({ running: false, pid: process.pid, ts: Date.now() }), "utf8");
  } catch {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ running: false, pid: process.pid, ts: Date.now(), error: true }), "utf8");
    } catch {}
  } finally {
    engine.close();
  }
}

main().catch(() => {});
