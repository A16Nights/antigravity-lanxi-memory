import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LanxiEngine, computeRetention } from "../lib/engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

function makeVec(seed) {
  const arr = [0, 0, 0, 0];
  arr[seed % 4] = 1;
  return arr;
}

function startMockAiServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        if (req.url === "/v1/embeddings") {
          const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
          const data = inputs.map((text, index) => {
            const t = String(text || "");
            const vec = t.includes("宇宙蓝色") || t.includes("魔杖") ? [0.99, 0.1, 0, 0] : makeVec(index + 1);
            return { object: "embedding", index, embedding: vec };
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ object: "list", data }));
          return;
        }
        if (req.url === "/v1/chat/completions") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      title: "潮汐架构共识总结",
                      summary: "合并多条情景：确认采用纯 Node SQLite FTS5 与可选向量混合检索架构。",
                      tags: ["架构", "共识"],
                      targetLayer: "knowledge",
                    }),
                  },
                },
              ],
            })
          );
          return;
        }
        res.writeHead(404);
        res.end("{}");
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      resolve({ server: srv, baseUrl: `http://127.0.0.1:${addr.port}/v1` });
    });
  });
}

test("LanxiEngine core lifecycle, decay math, CJK recall, and protection guard", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lanxi-core-"));
  try {
    const engine = new LanxiEngine(tmpDir);

    const w1 = engine.writeMemory({
      layer: "knowledge",
      title: "数据库选型",
      content: "决定采用 SQLite FTS5 加中文二元分词实现本地检索。",
      importance: 0.75,
      tags: ["sqlite", "架构"],
    });
    assert.equal(w1.committed, true);
    assert.equal(w1.protected, true);

    const dup = engine.writeMemory({
      layer: "knowledge",
      content: "决定采用 SQLite FTS5 加中文二元分词实现本地检索。",
    });
    assert.equal(dup.deduplicated, true);

    const w2 = engine.writeMemory({
      layer: "episodic",
      title: "实验笔记",
      content: "测试潮汐星海工作台与 [[数据库选型]] 关联。",
      importance: 0.4,
    });
    assert.equal(w2.protected, false);

    // Retention check
    const oldNode = {
      layer: "episodic",
      importance: 0.4,
      protected: 0,
      created_at: Date.now() / 1000 - 14 * 86400,
      last_access: Date.now() / 1000 - 14 * 86400,
    };
    const ret = computeRetention(oldNode, engine.config, Date.now() / 1000);
    assert.ok(ret > 0.5 && ret < 0.65);
    assert.equal(computeRetention({ ...oldNode, protected: 1 }, engine.config), 1.0);

    // CJK Recall
    const hits = engine.recall({ query: "中文二元分词", limit: 5 });
    assert.ok(hits.some((h) => h.id === w1.id));

    // Link & Graph
    const lnk = engine.linkMemories(w2.id, w1.id, "references");
    assert.equal(lnk.linked, true);
    const graph = engine.getGraph({ centerId: w2.id });
    assert.ok(graph.edges.some((e) => e.source_id === w2.id && e.target_id === w1.id));

    // Protection guard
    assert.throws(() => engine.forgetMemory(w1.id), /硬保护/);
    const archived = engine.forgetMemory(w1.id, { reason: "test_archive", override: true });
    assert.equal(archived.archived, true);

    // Promote
    const promoted = engine.promoteMemory(w2.id, "knowledge");
    assert.equal(promoted.layer, "knowledge");
    assert.equal(promoted.protected, true);

    engine.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test("Optional AI semantic recall, LLM consolidation, and key masking", async () => {
  const mock = await startMockAiServer();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lanxi-ai-"));
  try {
    const engine = new LanxiEngine(tmpDir);
    const updatedCfg = engine.updateSettings({
      ai: {
        llmEnabled: true,
        llmBaseUrl: mock.baseUrl,
        llmModel: "mock-chat",
        llmApiKey: "test-mock-llm-key-9876",
        embeddingEnabled: true,
        embeddingBaseUrl: mock.baseUrl,
        embeddingModel: "mock-embed",
        embeddingApiKey: "test-mock-emb-key-4321",
      },
    });
    assert.ok(updatedCfg.ai.llmApiKey.includes("***"));
    assert.ok(!updatedCfg.ai.llmApiKey.includes("test-mock-llm-key"));
    assert.equal(updatedCfg.ai.hasLlmKey, true);

    const n1 = engine.writeMemory({
      layer: "episodic",
      title: "武器灵感记录",
      content: "宇宙蓝色法杖在星海共振时会产生特殊波纹。",
      importance: 0.45,
    });
    const n2 = engine.writeMemory({
      layer: "episodic",
      title: "普通日常杂记",
      content: "今天整理了桌面文件夹。",
      importance: 0.35,
    });

    const bf = await engine.backfillEmbeddings(10);
    assert.equal(bf.embedded, 2);

    // Query uses "魔杖" which has NO literal overlap with n1, matched via mock embedding vector!
    const semHits = await engine.recallHybrid({ query: "魔杖", limit: 3, touch: false });
    assert.equal(semHits[0].id, n1.id);
    assert.ok(semHits[0].semanticScore > 0.9);

    const cons = await engine.aiConsolidateCluster({
      sourceIds: [n1.id, n2.id],
      commit: true,
      archiveSources: true,
    });
    assert.equal(cons.committed, true);
    assert.equal(cons.node.title, "潮汐架构共识总结");
    assert.equal(cons.node.protected, true);

    engine.close();
  } finally {
    mock.server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Universal read-only Markdown/Obsidian vault importer", () => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "lanxi-imp-data-"));
  const tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), "lanxi-imp-src-"));
  try {
    fs.mkdirSync(path.join(tmpSrc, "knowledge"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSrc, "knowledge", "note-a.md"),
      "---\nid: \"note-a\"\ntags: [\"obsidian\"]\nimportance: 0.8\n---\n# 笔记 A\n关联 [[note-b]]。\n",
      "utf8"
    );
    fs.writeFileSync(path.join(tmpSrc, "note-b.md"), "# 笔记 B\n普通 Markdown 笔记内容。\n", "utf8");

    const engine = new LanxiEngine(tmpData);
    const res = engine.importFromVault(tmpSrc);
    assert.equal(res.imported, 2);
    assert.equal(res.errors, 0);

    const nodeA = engine.readMemory("note-a");
    assert.equal(nodeA.protected, true);
    assert.ok(nodeA.outgoing.some((e) => e.target_id === "note-b"));
    engine.close();
  } finally {
    fs.rmSync(tmpData, { recursive: true, force: true });
    fs.rmSync(tmpSrc, { recursive: true, force: true });
  }
});

test("MCP stdio server, lifecycle hooks, and Starfield Sidecar HTTP server", async () => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "lanxi-e2e-"));
  const env = { ...process.env, LANXI_DATA_DIR: tmpData };

  try {
    // 1. MCP stdio
    const mcpInput = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "cg_write", arguments: { layer: "knowledge", title: "测试 MCP 规范", content: "必须保证端到端测试通过。" } },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "cg_recall", arguments: { query: "端到端测试" } },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "cg_maintain", arguments: { op: "set_importance", ids: ["non-existent-id"], importance: 0.8, confirm: true } },
      }),
    ].join("\n") + "\n";

    const mcpOut = spawnSync("node", [path.join(ROOT_DIR, "mcp-server.mjs")], {
      input: mcpInput,
      encoding: "utf8",
      env,
      timeout: 15000,
    });
    assert.equal(mcpOut.status, 0, mcpOut.stderr);
    const msgs = mcpOut.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.ok(msgs[1].result.tools.length >= 12);
    const recallResult = JSON.parse(msgs[3].result.content[0].text);
    assert.ok(recallResult.length >= 1);
    const maintResult = JSON.parse(msgs[4].result.content[0].text);
    assert.deepEqual(maintResult.unknownIds, ["non-existent-id"]);

    // 2. Lifecycle hooks (default: SessionStart ON, PreInvocation autoRecall OFF)
    const cid = "test-conv-1";
    const ss = spawnSync("node", [path.join(ROOT_DIR, "hooks", "session-start.mjs")], {
      input: JSON.stringify({ conversationId: cid }),
      encoding: "utf8",
      cwd: ROOT_DIR,
      env,
    });
    assert.equal(ss.status, 0);
    assert.ok(ss.stdout.includes("蓝汐 · 认知图谱已就绪"));

    const preDefaultOff = spawnSync("node", [path.join(ROOT_DIR, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({ conversationId: cid, lastUserInput: "帮我确认端到端测试规范" }),
      encoding: "utf8",
      cwd: ROOT_DIR,
      env,
    });
    assert.equal(preDefaultOff.stdout.trim(), "{}");

    // Enable autoRecall to verify strict threshold recall & noise blocking
    const cfgEng = new LanxiEngine(tmpData);
    cfgEng.updateSettings({ autoRecall: true, recallStrictness: "strict" });
    cfgEng.close();

    const preCasual = spawnSync("node", [path.join(ROOT_DIR, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({ conversationId: cid, lastUserInput: "那就蓝汐吧" }),
      encoding: "utf8",
      cwd: ROOT_DIR,
      env,
    });
    assert.equal(preCasual.stdout.trim(), "{}");

    const preReal = spawnSync("node", [path.join(ROOT_DIR, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({ conversationId: cid, lastUserInput: "现在帮我确认端到端测试规范" }),
      encoding: "utf8",
      cwd: ROOT_DIR,
      env,
    });
    assert.ok(preReal.stdout.includes("蓝汐自动召回"));

    // Unmatched conversational sentence must NOT dump unrelated fallback nodes
    const preNoMatch = spawnSync("node", [path.join(ROOT_DIR, "hooks", "pre-invocation.mjs")], {
      input: JSON.stringify({ conversationId: cid, lastUserInput: "主要是我发现额度用的有点快，你现在也稍微调查一下有哪些可能的原因导致的" }),
      encoding: "utf8",
      cwd: ROOT_DIR,
      env,
    });
    assert.equal(preNoMatch.stdout.trim(), "{}");

    const stopRes = spawnSync("node", [path.join(ROOT_DIR, "hooks", "stop.mjs")], {
      input: JSON.stringify({
        conversationId: cid,
        terminationReason: "NO_TOOL_CALL",
        workspacePaths: ["D:\\Workspace\\lanxi-demo"],
        lastUserInput: "请记住我们的密钥 Bearer abcdefghijklmnop 不要泄露",
      }),
      encoding: "utf8",
      cwd: ROOT_DIR,
      env,
    });
    assert.equal(JSON.parse(stopRes.stdout).decision, "allow");

    // Verify redaction and workspace project tagging happened on episodic entry
    const eng = new LanxiEngine(tmpData);
    const ep = eng.listMemories({ layer: "episodic", project: "lanxi-demo", limit: 5 });
    assert.ok(ep.items.some((x) => x.preview.includes("[REDACTED_TOKEN]") && x.project === "lanxi-demo"));
    eng.close();

    // 3. Sidecar HTTP Server
    const srvProc = spawn("node", [path.join(ROOT_DIR, "sidecars", "starfield", "server.mjs")], {
      env: { ...env, ANTIGRAVITY_SIDECAR_WEB_PORT: "18911" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise((r) => setTimeout(r, 700));
      const h = await (await fetch("http://127.0.0.1:18911/healthz")).json();
      assert.equal(h.ok, true);
      const ov = await (await fetch("http://127.0.0.1:18911/api/overview")).json();
      assert.ok(ov.totalNodes >= 2);
      assert.equal(ov.dataStale, false);
      const html = await (await fetch("http://127.0.0.1:18911/")).text();
      assert.ok(html.includes("蓝汐 · 潮汐星海"));
      assert.ok(html.includes("sel-write-gate"));
      assert.ok(html.includes("tog-session-start"));
      assert.ok(html.includes("sel-strictness"));
      const impRes = await (
        await fetch("http://127.0.0.1:18911/api/maintain/importance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: [ep.items[0].id], importance: 0.75, confirm: true, confirmedBy: "ui-test" }),
        })
      ).json();
      assert.equal(impRes.updated.length, 1);
      assert.equal(impRes.updated[0].protected, true);
    } finally {
      const exited = new Promise((r) => srvProc.once("exit", r));
      srvProc.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]);
    }
  } finally {
    fs.rmSync(tmpData, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});

test("0.11 upgrades: default episodic layer, dataStale detection, writeGate & setImportanceBatch, layer guard, project boost", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lanxi-v11-"));
  let engine = null;
  try {
    engine = new LanxiEngine(tmpDir);

    // 1. Default layer is episodic
    const defNode = engine.writeMemory({
      title: "随手记录草稿",
      content: "这是一条未声明层级的草稿记录。",
      importance: 0.4,
    });
    assert.equal(defNode.layer, "episodic");

    // 2. Hint importance does not self-lock protection, even >= 0.7
    engine.updateSettings({ writeGate: "confirm_protect" });
    const hintNode = engine.writeMemory({
      layer: "knowledge",
      title: "AI 自评高分知识",
      content: "未经过确认的高重要度记录不应自动硬锁定。",
      importance: 0.85,
      importanceSource: "hint",
    });
    assert.equal(hintNode.protected, false);
    assert.equal(hintNode.protectionPendingConfirm, true);
    const hintRead = engine.readMemory(hintNode.id);
    assert.ok(computeRetention(hintRead, engine.config, Date.now() / 1000 + 20 * 86400) < 1.0);

    // Batch confirm via setImportanceBatch promotes protection cleanly
    const batchRes = engine.setImportanceBatch({
      ids: [hintNode.id, "missing_id_xyz"],
      importance: 0.9,
      confirm: true,
      confirmedBy: "human",
    });
    assert.equal(batchRes.updated.length, 1);
    assert.equal(batchRes.updated[0].protected, true);
    assert.equal(batchRes.updated[0].verification_state, "verified");
    assert.deepEqual(batchRes.unknownIds, ["missing_id_xyz"]);

    // Downgrading protected node without override gets recorded in skipped
    const skipRes = engine.setImportanceBatch({ ids: [hintNode.id], importance: 0.2, override: false });
    assert.equal(skipRes.skipped.length, 1);

    // 3. Strict gate blocks unconfirmed anchor/self/structural writes
    engine.updateSettings({ writeGate: "strict" });
    assert.throws(
      () => engine.writeMemory({ layer: "structural", content: "未确认的架构规则" }),
      /strict 写入闸门/
    );
    const strictOk = engine.writeMemory({
      layer: "structural",
      content: "已确认的核心架构规则",
      importance: 0.75,
      confirmedBy: "user",
    });
    assert.equal(strictOk.protected, true);

    // 4. Protected layer cannot be downgraded without override
    const selfNode = engine.writeMemory({
      layer: "self",
      title: "自我原则",
      content: "绝不篡改历史测试断言。",
      confirmedBy: "user",
    });
    assert.throws(() => engine.updateMemory(selfNode.id, { layer: "episodic" }), /受保护层/);

    // 5. Project attribution & priority boost
    const pAlpha = engine.writeMemory({
      layer: "knowledge",
      project: "alpha-app",
      title: "Alpha 部署端口约定",
      content: "部署端口统一使用配置中心下发端口。",
      confirmedBy: "user",
    });
    const pBeta = engine.writeMemory({
      layer: "knowledge",
      project: "beta-app",
      title: "Beta 部署端口约定",
      content: "部署端口统一使用配置中心下发端口（Beta）。",
      confirmedBy: "user",
    });
    const alphaHits = engine.recall({ query: "部署端口", project: "alpha-app", limit: 5, touch: false });
    assert.equal(alphaHits[0].id, pAlpha.id);
    assert.equal(alphaHits[0].projectMatch, true);
    const strictBeta = engine.recall({ query: "部署端口", project: "beta-app", strictProject: true, limit: 5, touch: false });
    assert.equal(strictBeta.length, 1);
    assert.equal(strictBeta[0].id, pBeta.id);

    // 6. Disk freshness / dataStale detection + rebuild preserves extra metadata
    assert.equal(engine.getOverview().dataStale, false);
    const future = new Date(Date.now() + 6000);
    fs.utimesSync(hintRead.file_path, future, future);
    const staleOv = engine.getOverview();
    assert.equal(staleOv.dataStale, true);
    assert.ok(staleOv.freshness.staleFilesCount >= 1);
    assert.equal(engine.readMemory(hintNode.id).diskSync.stale, true);

    engine.rebuildIndex();
    assert.equal(engine.checkDiskFreshness({ force: true }).dataStale, false);
    const afterRebuild = engine.readMemory(pAlpha.id);
    assert.equal(afterRebuild.project, "alpha-app");
    assert.equal(afterRebuild.extra.importance_confirmed_by, "user");
  } finally {
    try { engine?.close(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
});
