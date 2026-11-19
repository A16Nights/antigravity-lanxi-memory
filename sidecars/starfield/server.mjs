import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { LanxiEngine } from "../../lib/engine.mjs";
import { testAiConnection, isMaskedPlaceholder } from "../../lib/ai-client.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, "index.html");
const engine = new LanxiEngine();

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

  if (pathname === "/healthz") {
    sendJson(res, 200, { ok: true, service: "lanxi-starfield" });
    return;
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    const html = fs.readFileSync(HTML_PATH, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (pathname.startsWith("/api/")) {
    if (!checkAuth(req, url)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    try {
      engine.config = engine.loadConfig();

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
});

function shutdown() {
  try { engine.close(); } catch {}
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
