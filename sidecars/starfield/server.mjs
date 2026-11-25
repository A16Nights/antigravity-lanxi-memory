import { checkGithubUpdate } from "../../lib/update-checker.mjs";
import { isLeftSidebarEnabled, setLeftSidebarEnabled, listOwnedPluginsNavState, registerSidecarRuntime, refreshAntigravityMcpServers, injectSidebarToggleWidget } from "../../lib/sidebar-nav.mjs";
import { handleAzureThemeHttp } from "../../lib/azure-theme.mjs";
import { injectAzureUiKit } from "../../lib/azure-ui-kit.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { LanxiEngine } from "../../lib/engine.mjs";
import { testAiConnection, isMaskedPlaceholder } from "../../lib/ai-client.mjs";
import {
  countPendingEpisodic,
  countActiveKnowledge,
  readOrganizeHistory,
  markAuditCardAppliedInHistory,
  runOrganizeSession,
  runKnowledgeAuditSession,
  applyKnowledgeAuditDecision,
} from "../../lib/organizer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, "index.html");
const engine = new LanxiEngine();

// Real-time observable organize job manager
let activeOrganizeJob = null;
const organizeSseClients = new Set();

function serializeOrganizeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    taskType: job.taskType || "episodic",
    mode: job.mode,
    status: job.status,
    dryRun: Boolean(job.dryRun),
    startedAt: job.startedAt,
    endedAt: job.endedAt || null,
    model: job.model || "",
    currentStep: job.currentStep || "",
    stopRequested: Boolean(job.stopRequested),
    stats: { ...(job.stats || {}) },
    results: [...(job.results || [])],
    logs: [...(job.logs || [])],
    error: job.error || null,
  };
}

function broadcastOrganizeEvent(eventName, payload) {
  const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of [...organizeSseClients]) {
    try {
      client.write(frame);
    } catch {
      organizeSseClients.delete(client);
    }
  }
}

const PORT = parseInt(
  process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || "18792",
  10
);
const TOKEN = (
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ||
  process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN ||
  process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN ||
  ""
).trim();

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 2 * 1024 * 1024) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function checkAuth(req, url) {
  if (!TOKEN) return true;
  const hdr = req.headers["x-codeium-sidecar-token"] || req.headers["x-sidecar-token"];
  const q = url.searchParams.get("token");
  return hdr === TOKEN || q === TOKEN;
}

let actualPort = PORT;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${actualPort}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/check-update") {
    const force = new URL(req.url, "http://127.0.0.1").searchParams.get("force") === "1";
    const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const info = await checkGithubUpdate({ pluginRoot, repo: "A16Nights/antigravity-lanxi-memory", force });
    sendJson(res, 200, info);
    return;
  }

  if (pathname === "/healthz") {
    sendJson(res, 200, { ok: true, service: "lanxi-starfield" });
    return;
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    const html = fs.readFileSync(HTML_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(injectAzureUiKit(injectSidebarToggleWidget(html, "lanxi-memory"), "lanxi-memory"));
    return;
  }

  if (pathname.startsWith("/api/")) {
    if (!checkAuth(req, url)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    try {
      engine.config = engine.loadConfig();

      if (await handleAzureThemeHttp(req, res)) return;
    if (req.method === "GET" && pathname === "/api/sidebar-nav") {
        sendJson(res, 200, {
          ok: true,
          pluginId: "lanxi-memory",
          showInLeftSidebar: isLeftSidebarEnabled("lanxi-memory"),
          plugins: listOwnedPluginsNavState()
        });
        return;
      }
      if (req.method === "POST" && pathname === "/api/sidebar-nav") {
        const body = await readBody(req);
        const targetId = String(body.pluginId || "lanxi-memory").trim();
        const nextVal = Boolean(body.showInLeftSidebar);
        setLeftSidebarEnabled(targetId, nextVal);
        const rf = await refreshAntigravityMcpServers();
        sendJson(res, 200, {
          ok: true,
          pluginId: targetId,
          showInLeftSidebar: nextVal,
          refreshed: Boolean(rf?.ok),
          plugins: listOwnedPluginsNavState()
        });
        return;
      }
      if (req.method === "GET" && pathname === "/api/overview") {
        const overview = engine.getOverview();
        const webUrl = TOKEN
          ? `http://127.0.0.1:${actualPort}/?token=${encodeURIComponent(TOKEN)}`
          : `http://127.0.0.1:${actualPort}/`;
        sendJson(res, 200, { ...overview, webUrl });
        return;
      }

      if (req.method === "GET" && pathname === "/api/memories") {
        const layer = url.searchParams.get("layer") || null;
        const query = url.searchParams.get("q") || "";
        const project = url.searchParams.get("project") || null;
        const lifecycle = url.searchParams.get("lifecycle") || "active";
        const sort = url.searchParams.get("sort") || "recent";
        const hybrid = url.searchParams.get("hybrid") === "1";
        const limit = parseInt(url.searchParams.get("limit") || "60", 10);
        const offset = parseInt(url.searchParams.get("offset") || "0", 10);

        if (hybrid && query.trim() && lifecycle === "active") {
          const layers = layer && layer !== "archive" ? [layer] : null;
          const items = await engine.recallHybrid({ query: query.trim(), layers, project, limit, touch: false });
          sendJson(res, 200, { total: items.length, items, hybridUsed: true });
          return;
        }
        sendJson(res, 200, engine.listMemories({ layer, query, project, lifecycle, sort, limit, offset }));
        return;
      }

      if (req.method === "GET" && pathname === "/api/memory") {
        const id = url.searchParams.get("id") || "";
        const node = engine.readMemory(id);
        if (!node) {
          sendJson(res, 404, { error: `未找到节点: ${id}` });
          return;
        }
        sendJson(res, 200, node);
        return;
      }

      if (req.method === "POST" && pathname === "/api/write") {
        const body = await readBody(req);
        sendJson(res, 200, engine.writeMemory({
          ...body,
          importanceSource: body.importanceSource || "confirmed",
          confirmedBy: body.confirmedBy || "ui",
        }));
        return;
      }

      if (req.method === "POST" && pathname === "/api/update") {
        const body = await readBody(req);
        sendJson(res, 200, engine.updateMemory(body.id, body));
        return;
      }

      if (req.method === "POST" && pathname === "/api/forget") {
        const body = await readBody(req);
        sendJson(res, 200, engine.forgetMemory(body.id, { reason: body.reason || "", override: Boolean(body.override) }));
        return;
      }

      if (req.method === "POST" && pathname === "/api/restore") {
        const body = await readBody(req);
        sendJson(res, 200, engine.restoreMemory(body.id));
        return;
      }

      if (req.method === "POST" && pathname === "/api/delete") {
        const body = await readBody(req);
        sendJson(res, 200, engine.deleteMemory(body.id, { override: Boolean(body.override) }));
        return;
      }

      if (req.method === "POST" && pathname === "/api/archive/purge") {
        const body = await readBody(req);
        sendJson(res, 200, engine.purgeArchived({ ids: Array.isArray(body.ids) ? body.ids : null }));
        return;
      }

      if (req.method === "POST" && pathname === "/api/link") {
        const body = await readBody(req);
        sendJson(res, 200, engine.linkMemories(body.sourceId, body.targetId, body.relation || "related_to", body.weight ?? 1.0));
        return;
      }

      if (req.method === "GET" && pathname === "/api/graph") {
        const centerId = url.searchParams.get("centerId") || null;
        const limit = parseInt(url.searchParams.get("limit") || "75", 10);
        const layersParam = url.searchParams.get("layers");
        const layers = layersParam ? layersParam.split(",").filter(Boolean) : null;
        sendJson(res, 200, engine.getGraph({ centerId, limit, layers }));
        return;
      }

      if (req.method === "GET" && pathname === "/api/goals") {
        sendJson(res, 200, { items: engine.listGoals() });
        return;
      }

      if (req.method === "POST" && pathname === "/api/goals") {
        const body = await readBody(req);
        sendJson(res, 200, engine.upsertGoal(body));
        return;
      }

      if (req.method === "POST" && pathname === "/api/reflect") {
        const body = await readBody(req);
        sendJson(res, 200, engine.reflect(body));
        return;
      }

      if (req.method === "GET" && pathname === "/api/maintain") {
        sendJson(res, 200, engine.getMaintenanceQueue());
        return;
      }

      if (req.method === "POST" && pathname === "/api/maintain/importance") {
        const body = await readBody(req);
        sendJson(res, 200, engine.setImportanceBatch(body));
        return;
      }

      if (req.method === "POST" && pathname === "/api/promote") {
        const body = await readBody(req);
        sendJson(res, 200, engine.promoteMemory(body.id, body.targetLayer || "knowledge"));
        return;
      }

      if (req.method === "POST" && pathname === "/api/touch") {
        const body = await readBody(req);
        sendJson(res, 200, engine.touchMemory(body.id));
        return;
      }

      if (req.method === "POST" && pathname === "/api/consolidate") {
        const body = await readBody(req);
        sendJson(res, 200, engine.consolidateCluster(body));
        return;
      }

      if (req.method === "POST" && pathname === "/api/ai/consolidate") {
        const body = await readBody(req);
        sendJson(res, 200, await engine.aiConsolidateCluster(body));
        return;
      }

      if (req.method === "GET" && pathname === "/api/organize/status") {
        sendJson(res, 200, {
          active: serializeOrganizeJob(activeOrganizeJob),
          pendingEpisodicCount: countPendingEpisodic(engine),
          knowledgeCount: countActiveKnowledge(engine),
          history: readOrganizeHistory(engine.dataDir).slice(0, 10),
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/organize/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        res.write(`event: snapshot\ndata: ${JSON.stringify({
          active: serializeOrganizeJob(activeOrganizeJob),
          pendingEpisodicCount: countPendingEpisodic(engine),
          knowledgeCount: countActiveKnowledge(engine),
        })}\n\n`);
        organizeSseClients.add(res);
        const hb = setInterval(() => {
          try { res.write(": keepalive\n\n"); } catch {}
        }, 15000);
        req.on("close", () => {
          clearInterval(hb);
          organizeSseClients.delete(res);
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/organize/start") {
        if (activeOrganizeJob && activeOrganizeJob.status === "running") {
          sendJson(res, 409, {
            error: "当前已有整理任务正在运行",
            active: serializeOrganizeJob(activeOrganizeJob),
          });
          return;
        }
        const body = await readBody(req);
        const taskType = body.taskType === "audit" ? "audit" : "episodic";
        const jobId = `${taskType === "audit" ? "aud" : "org"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const cfg = engine.loadConfig();
        activeOrganizeJob = {
          id: jobId,
          taskType,
          mode: "manual",
          status: "running",
          dryRun: Boolean(body.dryRun),
          startedAt: Date.now(),
          endedAt: null,
          model: cfg.ai?.llmModel || "",
          currentStep: taskType === "audit" ? "正在准备知识库过时体检..." : "正在准备情景整理任务...",
          stopRequested: false,
          stats: {
            totalAvailable: 0,
            totalCandidates: 0,
            totalClusters: 0,
            completedClusters: 0,
            createdNodes: 0,
            updatedNodes: 0,
            supersededNodes: 0,
            archivedSources: 0,
            cleanClusters: 0,
            skippedClusters: 0,
            errors: 0,
          },
          results: [],
          logs: [],
          error: null,
        };
        broadcastOrganizeEvent("snapshot", {
          active: serializeOrganizeJob(activeOrganizeJob),
          pendingEpisodicCount: countPendingEpisodic(engine),
          knowledgeCount: countActiveKnowledge(engine),
        });

        const runnerCallbacks = {
          shouldStop: () => Boolean(activeOrganizeJob && activeOrganizeJob.id === jobId && activeOrganizeJob.stopRequested),
          onEvent: ({ entry, stats, results }) => {
            if (!activeOrganizeJob || activeOrganizeJob.id !== jobId) return;
            activeOrganizeJob.stats = stats;
            activeOrganizeJob.results = results;
            activeOrganizeJob.currentStep = entry.message;
            activeOrganizeJob.logs.push(entry);
            if (activeOrganizeJob.logs.length > 300) activeOrganizeJob.logs.shift();
            broadcastOrganizeEvent("progress", {
              active: serializeOrganizeJob(activeOrganizeJob),
              entry,
            });
          },
        };

        const runPromise = taskType === "audit"
          ? runKnowledgeAuditSession(
              engine,
              {
                mode: "manual",
                jobId,
                maxClusters: body.maxClusters ?? 12,
                project: body.project || "",
                dryRun: Boolean(body.dryRun),
              },
              runnerCallbacks
            )
          : runOrganizeSession(
              engine,
              {
                mode: "manual",
                jobId,
                maxNodes: body.maxNodes ?? 24,
                clusterSize: body.clusterSize ?? 6,
                project: body.project || "",
                order: body.order || "oldest",
                archiveSources: body.archiveSources !== false,
                checkExisting: body.checkExisting !== false,
                dryRun: Boolean(body.dryRun),
                sourceIds: Array.isArray(body.sourceIds) && body.sourceIds.length ? body.sourceIds : null,
              },
              runnerCallbacks
            );

        runPromise
          .then((finished) => {
            if (activeOrganizeJob && activeOrganizeJob.id === jobId) {
              activeOrganizeJob.status = finished.status;
              activeOrganizeJob.endedAt = finished.endedAt;
              activeOrganizeJob.stats = finished.stats;
              activeOrganizeJob.results = finished.results;
              activeOrganizeJob.logs = finished.logs;
              activeOrganizeJob.error = finished.error || null;
              activeOrganizeJob.currentStep = finished.logs[finished.logs.length - 1]?.message || "整理完成";
              broadcastOrganizeEvent("done", {
                active: serializeOrganizeJob(activeOrganizeJob),
                pendingEpisodicCount: countPendingEpisodic(engine),
                knowledgeCount: countActiveKnowledge(engine),
                history: readOrganizeHistory(engine.dataDir).slice(0, 10),
              });
            }
          })
          .catch((err) => {
            if (activeOrganizeJob && activeOrganizeJob.id === jobId) {
              activeOrganizeJob.status = "error";
              activeOrganizeJob.endedAt = Date.now();
              activeOrganizeJob.error = err?.message || String(err);
              activeOrganizeJob.currentStep = `整理异常中断：${activeOrganizeJob.error}`;
              activeOrganizeJob.logs.push({ ts: Date.now(), type: "error", message: activeOrganizeJob.currentStep });
              broadcastOrganizeEvent("done", {
                active: serializeOrganizeJob(activeOrganizeJob),
                pendingEpisodicCount: countPendingEpisodic(engine),
                knowledgeCount: countActiveKnowledge(engine),
                history: readOrganizeHistory(engine.dataDir).slice(0, 10),
              });
            }
          });

        sendJson(res, 200, { ok: true, active: serializeOrganizeJob(activeOrganizeJob) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/organize/apply-audit") {
        const body = await readBody(req);
        const resExec = applyKnowledgeAuditDecision(engine, body.verdict || body);
        if (body.cardId) {
          if (activeOrganizeJob && Array.isArray(activeOrganizeJob.results)) {
            const hit = activeOrganizeJob.results.find((r) => r.cardId === body.cardId);
            if (hit) {
              hit.applied = true;
              hit.dryRun = false;
            }
          }
          markAuditCardAppliedInHistory(engine.dataDir, body.cardId);
        }
        sendJson(res, 200, { ok: true, ...resExec });
        return;
      }

      if (req.method === "POST" && pathname === "/api/organize/stop") {
        if (!activeOrganizeJob || activeOrganizeJob.status !== "running") {
          sendJson(res, 200, { ok: true, message: "当前没有运行中的整理任务" });
          return;
        }
        activeOrganizeJob.stopRequested = true;
        activeOrganizeJob.currentStep = "已请求停止，等待当前分组完成后优雅结束...";
        const entry = { ts: Date.now(), type: "warn", message: activeOrganizeJob.currentStep };
        activeOrganizeJob.logs.push(entry);
        broadcastOrganizeEvent("progress", {
          active: serializeOrganizeJob(activeOrganizeJob),
          entry,
        });
        sendJson(res, 200, { ok: true, active: serializeOrganizeJob(activeOrganizeJob) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/ai/backfill-embeddings") {
        const body = await readBody(req);
        sendJson(res, 200, await engine.backfillEmbeddings(body.limit ?? 50));
        return;
      }

      if (req.method === "POST" && pathname === "/api/ai/test") {
        const body = await readBody(req);
        const cfg = engine.loadConfig();
        const mergedAi = { ...cfg.ai, ...(body.ai || {}) };
        if (!body.ai?.llmApiKey || isMaskedPlaceholder(body.ai.llmApiKey)) mergedAi.llmApiKey = cfg.ai?.llmApiKey;
        if (!body.ai?.embeddingApiKey || isMaskedPlaceholder(body.ai.embeddingApiKey)) mergedAi.embeddingApiKey = cfg.ai?.embeddingApiKey;
        sendJson(res, 200, await testAiConnection(mergedAi));
        return;
      }

      if (req.method === "POST" && pathname === "/api/ai/import-orchestrator") {
        const orchPath = path.join(os.homedir(), ".gemini", "external-orchestrator", "config.json");
        if (!fs.existsSync(orchPath)) {
          sendJson(res, 404, { error: "未检测到苍蓝协奏台配置文件（~/.gemini/external-orchestrator/config.json）" });
          return;
        }
        const orch = JSON.parse(fs.readFileSync(orchPath, "utf8"));
        const providers = Array.isArray(orch.providers) ? orch.providers.filter((p) => p && p.enabled !== false && p.baseUrl) : [];
        if (!providers.length) {
          sendJson(res, 400, { error: "苍蓝协奏台暂无已启用的外部模型渠道" });
          return;
        }
        const routing = orch.routing || {};
        const pickRef = routing.fast?.primary || routing.default?.primary || "";
        let pickedProvider = null;
        let pickedModel = "";
        if (pickRef && pickRef.includes(":")) {
          const [pid, ...rest] = pickRef.split(":");
          const found = providers.find((p) => p.id === pid);
          if (found) {
            pickedProvider = found;
            pickedModel = rest.join(":");
          }
        }
        if (!pickedProvider) {
          pickedProvider = providers[0];
          pickedModel = pickedProvider.defaultModel || (Array.isArray(pickedProvider.models) ? pickedProvider.models[0] : "") || "gpt-4o-mini";
        }
        engine.updateSettings({
          ai: {
            llmEnabled: true,
            llmBaseUrl: pickedProvider.baseUrl,
            llmModel: pickedModel,
            ...(pickedProvider.apiKey ? { llmApiKey: pickedProvider.apiKey } : {}),
          },
        });
        sendJson(res, 200, {
          ok: true,
          providerName: pickedProvider.name || pickedProvider.id,
          baseUrl: pickedProvider.baseUrl,
          model: pickedModel,
          config: engine.getPublicConfig(),
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/settings") {
        const body = await readBody(req);
        sendJson(res, 200, engine.updateSettings(body));
        return;
      }

      if (req.method === "POST" && pathname === "/api/import-vault") {
        const body = await readBody(req);
        sendJson(res, 200, engine.importFromVault(body.sourceDir));
        return;
      }

      if (req.method === "POST" && pathname === "/api/rebuild") {
        sendJson(res, 200, engine.rebuildIndex());
        return;
      }

      if (req.method === "POST" && pathname === "/api/rollback") {
        const body = await readBody(req);
        sendJson(res, 200, engine.rollbackMemory(body.id, body.backupFile || null));
        return;
      }

      if (req.method === "GET" && pathname === "/api/briefing") {
        const proj = url.searchParams.get("project") || "";
        const projects = engine.listProjects();
        const targetProj = proj || (projects[0]?.project || "");
        const briefing = targetProj ? engine.buildProjectBriefing(targetProj, { maxChars: 1200 }) : { project: "", nodeCount: 0, text: "", sections: {} };
        sendJson(res, 200, { projects, briefing });
        return;
      }

      if (req.method === "GET" && pathname === "/api/external-sources") {
        sendJson(res, 200, { sources: engine.listExternalSources() });
        return;
      }

      if (req.method === "POST" && pathname === "/api/external-sources/add") {
        const body = await readBody(req);
        sendJson(res, 200, engine.addExternalSource(body));
        return;
      }

      if (req.method === "POST" && pathname === "/api/external-sources/toggle") {
        const body = await readBody(req);
        sendJson(res, 200, { sources: engine.toggleExternalSource(body.id, body.enabled) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/external-sources/remove") {
        const body = await readBody(req);
        sendJson(res, 200, { sources: engine.removeExternalSource(body.id) });
        return;
      }

      if (req.method === "POST" && pathname === "/api/external-sources/sync") {
        const body = await readBody(req);
        const result = engine.syncExternalSources({ sourceId: body.id || null, force: Boolean(body.force) });
        sendJson(res, 200, { result, sources: engine.listExternalSources() });
        return;
      }

      if (req.method === "GET" && pathname === "/api/mcp-share-config") {
        const mcpEntry = path.resolve(__dirname, "..", "..", "mcp-server.mjs");
        const dataDir = engine.dataDir;
        const standardJson = JSON.stringify(
          {
            mcpServers: {
              "lanxi-memory": {
                command: "node",
                args: [mcpEntry],
                env: {
                  LANXI_DATA_DIR: dataDir,
                },
              },
            },
          },
          null,
          2
        );
        const claudeCli = `claude mcp add lanxi-memory -e LANXI_DATA_DIR="${dataDir}" -- node "${mcpEntry}"`;
        sendJson(res, 200, { mcpEntry, dataDir, standardJson, claudeCli });
        return;
      }

      sendJson(res, 404, { error: "API route not found" });
    } catch (err) {
      sendJson(res, 400, { error: err.message || String(err) });
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  if (addr && typeof addr === "object") actualPort = addr.port;
  console.log(`[lanxi-memory starfield] listening on http://127.0.0.1:${actualPort}`);
  try {
    const __a = server.address();
    const __p = (__a && typeof __a === "object" && __a.port) ? __a.port : Number(PORT) || 0;
    const __t = (process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN || process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN || "").trim();
    const __u = __t ? `http://127.0.0.1:${__p}/?token=${encodeURIComponent(__t)}` : `http://127.0.0.1:${__p}/`;
    registerSidecarRuntime("lanxi-memory", { port: __p, url: __u });
  } catch {}
});

function shutdown() {
  try { engine.close(); } catch {}
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
