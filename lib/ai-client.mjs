const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function maskKey(key) {
  const s = String(key || "").trim();
  if (!s) return "";
  if (s.length <= 8) return "****";
  const prefix = s.slice(0, Math.min(3, s.length - 4));
  const suffix = s.slice(-4);
  return `${prefix}***${suffix}`;
}

export function isMaskedPlaceholder(val) {
  return typeof val === "string" && (val.includes("***") || val === "****");
}

export function resolveAiCredentials(aiConfig = {}) {
  const llmKey = String(aiConfig.llmApiKey || process.env.LANXI_LLM_API_KEY || "").trim();
  const embKey = String(aiConfig.embeddingApiKey || process.env.LANXI_EMBEDDING_API_KEY || llmKey || "").trim();
  return {
    llmEnabled: Boolean(aiConfig.llmEnabled),
    llmBaseUrl: normalizeBaseUrl(aiConfig.llmBaseUrl || DEFAULT_BASE_URL),
    llmModel: String(aiConfig.llmModel || "gpt-4o-mini").trim(),
    llmApiKey: llmKey,
    embeddingEnabled: Boolean(aiConfig.embeddingEnabled),
    embeddingBaseUrl: normalizeBaseUrl(aiConfig.embeddingBaseUrl || aiConfig.llmBaseUrl || DEFAULT_BASE_URL),
    embeddingModel: String(aiConfig.embeddingModel || "text-embedding-3-small").trim(),
    embeddingApiKey: embKey,
  };
}

function normalizeBaseUrl(url) {
  return String(url || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length === 0 || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom <= 1e-12) return 0;
  return dot / denom;
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`接口返回非 JSON 内容 (HTTP ${res.status}): ${text.slice(0, 160)}`);
    }
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export async function embedTexts(texts, aiConfig, { timeoutMs = 8000 } = {}) {
  const creds = resolveAiCredentials(aiConfig);
  if (!creds.embeddingApiKey) {
    throw new Error("未配置 Embedding API Key");
  }
  const inputs = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || "").slice(0, 6000));
  if (inputs.length === 0) return [];

  const data = await fetchJsonWithTimeout(
    `${creds.embeddingBaseUrl}/embeddings`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.embeddingApiKey}`,
      },
      body: JSON.stringify({
        model: creds.embeddingModel,
        input: inputs,
      }),
    },
    timeoutMs
  );

  if (!Array.isArray(data?.data)) {
    throw new Error("Embeddings 响应缺少 data 数组");
  }
  const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return sorted.map((item) => new Float32Array(item.embedding || []));
}

function extractJsonObject(rawText) {
  const text = String(rawText || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  const jsonStr = objMatch ? objMatch[0] : candidate;
  return JSON.parse(jsonStr);
}

function fmtIsoDate(sec) {
  const d = new Date(Number(sec || 0) * 1000);
  if (Number.isNaN(d.getTime())) return "未知时间";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function parseSynthesisJson(rawText, allowedExistingIds = new Set()) {
  const parsed = extractJsonObject(rawText);
  const targetLayer = parsed.targetLayer === "structural" ? "structural" : "knowledge";
  const rawAction = String(parsed.action || "create").trim().toLowerCase();
  let action = ["create", "update", "supersede"].includes(rawAction) ? rawAction : "create";
  let targetId = parsed.targetId ? String(parsed.targetId).trim() : null;
  if (targetId && !allowedExistingIds.has(targetId)) {
    targetId = null;
  }
  const rawSuperseded = Array.isArray(parsed.supersededIds) ? parsed.supersededIds : [];
  const supersededIds = [...new Set(rawSuperseded.map((x) => String(x || "").trim()).filter((id) => allowedExistingIds.has(id)))];

  if (action === "update" && !targetId) {
    action = supersededIds.length > 0 ? "supersede" : "create";
  }
  if (action === "supersede" && supersededIds.length === 0) {
    action = "create";
  }

  return {
    action,
    targetId,
    supersededIds: supersededIds.filter((id) => id !== targetId),
    reason: String(parsed.reason || "").trim().slice(0, 220),
    title: String(parsed.title || "").trim().slice(0, 100) || "凝结知识节点",
    summary: String(parsed.summary || "").trim(),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8) : ["consolidated"],
    targetLayer,
  };
}

export async function synthesizeConsolidation(nodes, aiConfig, { timeoutMs = 30000, existingKnowledge = [] } = {}) {
  const creds = resolveAiCredentials(aiConfig);
  if (!creds.llmEnabled) {
    throw new Error("聊天模型开关当前已关闭，请先在「可选 AI 增强」中开启聊天模型开关");
  }
  if (!creds.llmApiKey) {
    throw new Error("未配置 LLM API Key");
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("请至少选择一个源记忆节点进行凝结");
  }

  const formattedNodes = nodes
    .map((n, idx) => {
      const body = String(n.body || n.preview || "").trim().slice(0, 1200);
      return `[新情景#${idx + 1} id=${n.id} time=${fmtIsoDate(n.created_at)} layer=${n.layer} title=${n.title}]\n${body}`;
    })
    .join("\n\n---\n\n");

  const validExisting = Array.isArray(existingKnowledge) ? existingKnowledge.slice(0, 5) : [];
  const allowedIds = new Set(validExisting.map((k) => k.id));

  let userPrompt = `请凝结以下 ${nodes.length} 条新情景记忆：\n\n${formattedNodes}`;
  let systemPrompt;

  if (validExisting.length > 0) {
    const formattedExisting = validExisting
      .map((k, idx) => {
        const body = String(k.body || k.preview || "").trim().slice(0, 700);
        return `[已有旧知识#${idx + 1} id=${k.id} updated=${fmtIsoDate(k.updated_at || k.created_at)} layer=${k.layer} title=${k.title}]\n${body}`;
      })
      .join("\n\n---\n\n");

    userPrompt += `\n\n====================\n以下是知识库中已有的最相关旧知识（请务必对比判断是否重复、可合并或已过时）：\n\n${formattedExisting}`;

    systemPrompt = [
      "你是一个严谨的知识图谱凝结与演进助手。请把新情景提炼为高密度长期记忆，并与「已有旧知识」对比避免重复或保留过时结论。",
      "决策规则：",
      "1. action=\"create\"：与已有旧知识主题不同，应新建独立知识节点。",
      "2. action=\"update\"：与某条已有旧知识高度重合或仅是补充更新，将新旧有效信息融合为最新完整版，填 targetId 为该旧知识 id（必须严格来自给定旧知识 id）。",
      "3. action=\"supersede\"：新结论推翻或替代了一条或多条已过时的旧知识（例如新版本/新路径/新架构替代旧方案），新建最新知识并在 supersededIds 中列出被取代的旧知识 id。",
      "4. 严禁编造不存在的事实或 id；如果不确定旧知识是否真的过时，优先保守选择 create 或 update，不要误伤无关旧知识。",
      "5. 仅输出一个 JSON 对象，不要附加额外解释。",
      'JSON 格式：{"action":"create|update|supersede","targetId":"update时的旧id或null","supersededIds":["过时旧id"],"reason":"一句话说明决策依据","title":"简明标题","summary":"提炼后的完整 Markdown 正文","tags":["标签1","标签2"],"targetLayer":"knowledge 或 structural"}',
    ].join("\n");
  } else {
    systemPrompt = [
      "你是一个严谨的知识图谱凝结助手。请把用户提供的多条零散记忆节点提炼为一条高信息密度的长期记忆。",
      "要求：",
      "1. 保留关键事实、路径、参数、因果结论，不编造不存在的信息。",
      "2. 仅输出一个 JSON 对象，不要附加额外解释。",
      'JSON 字段格式：{"title":"简明标题","summary":"提炼后的 Markdown 正文","tags":["标签1","标签2"],"targetLayer":"knowledge 或 structural"}',
    ].join("\n");
  }

  const data = await fetchJsonWithTimeout(
    `${creds.llmBaseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.llmApiKey}`,
      },
      body: JSON.stringify({
        model: creds.llmModel,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    },
    timeoutMs
  );

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM 响应内容为空");
  }
  const result = parseSynthesisJson(content, allowedIds);
  if (!result.summary) {
    throw new Error("LLM 凝结结果缺少 summary 正文");
  }
  return result;
}

export async function auditKnowledgeCluster(nodes, aiConfig, { timeoutMs = 45000 } = {}) {
  const creds = resolveAiCredentials(aiConfig);
  if (!creds.llmEnabled) {
    throw new Error("聊天模型开关当前已关闭，请先在「可选 AI 增强」中开启聊天模型开关");
  }
  if (!creds.llmApiKey) {
    throw new Error("未配置 LLM API Key");
  }
  if (!Array.isArray(nodes) || nodes.length < 2) {
    return { status: "clean", keepId: nodes?.[0]?.id || null, archiveIds: [], reason: "单条知识无需对比" };
  }

  const allowedIds = new Set(nodes.map((n) => n.id));
  const formatted = nodes
    .map((n, idx) => {
      const body = String(n.body || n.preview || "").trim().slice(0, 1000);
      const deadHint = Array.isArray(n.missingPaths) && n.missingPaths.length
        ? `\n[本地路径检测提示：以下路径当前已不存在 -> ${n.missingPaths.join(", ")}]`
        : "";
      return `[知识#${idx + 1} id=${n.id} created=${fmtIsoDate(n.created_at)} updated=${fmtIsoDate(n.updated_at)} layer=${n.layer} protected=${Boolean(n.protected)} title=${n.title}]${deadHint}\n${body}`;
    })
    .join("\n\n---\n\n");

  const systemPrompt = [
    "你是一个谨慎的知识库体检与冲突消解专家。请审查以下同一主题/相似的已有知识节点，判断是否存在「高度重复」或「已被更新记录取代的过时知识」。",
    "判断原则（保守精准，宁缺毋滥）：",
    "1. status=\"clean\"：各条知识分别记录了不同方面、不同规则或互补信息，无明显重复也无过时矛盾 → 全部保留。",
    "2. status=\"merge\"：有 2 条及以上高度重复、碎片化或版本叠加，合并为一条最新完整知识更清晰 → 选最新或最核心的 id 作为 keepId，其余重复项列入 archiveIds，并在 mergedTitle / mergedSummary / mergedTags 中给出合并后的完整正文。",
    "3. status=\"supersede\"：较早的节点明确已被较新的节点推翻/过时（如旧版本号、已删路径、被新架构替代）→ 填 keepId 为最新有效节点，被淘汰的旧节点 id 列入 archiveIds（无需改写正文时 mergedSummary 可留空）。",
    "4. 严禁编造不存在的 id；archiveIds 绝对不能包含 keepId。",
    "5. 仅输出一个 JSON 对象，不要附加额外解释。",
    'JSON 格式：{"status":"clean|merge|supersede","keepId":"主保留节点id","archiveIds":["需归档的重复或过时id"],"mergedTitle":"合并后标题(可选)","mergedSummary":"合并后完整Markdown正文(merge时必填)","mergedTags":["标签"],"reason":"简明中文判断理由"}',
  ].join("\n");

  const data = await fetchJsonWithTimeout(
    `${creds.llmBaseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.llmApiKey}`,
      },
      body: JSON.stringify({
        model: creds.llmModel,
        temperature: 0.15,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `请体检以下 ${nodes.length} 条同主题知识节点（按时间先后排序）：\n\n${formatted}` },
        ],
      }),
    },
    timeoutMs
  );

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM 体检响应为空");
  const parsed = extractJsonObject(content);
  const rawStatus = String(parsed.status || "clean").trim().toLowerCase();
  let status = ["clean", "merge", "supersede"].includes(rawStatus) ? rawStatus : "clean";
  let keepId = parsed.keepId && allowedIds.has(String(parsed.keepId).trim())
    ? String(parsed.keepId).trim()
    : nodes[nodes.length - 1].id;
  const archiveIds = [...new Set(
    (Array.isArray(parsed.archiveIds) ? parsed.archiveIds : [])
      .map((x) => String(x || "").trim())
      .filter((id) => allowedIds.has(id) && id !== keepId)
  )];

  if (status !== "clean" && archiveIds.length === 0) {
    status = "clean";
  }

  return {
    status,
    keepId,
    archiveIds,
    mergedTitle: String(parsed.mergedTitle || "").trim().slice(0, 100),
    mergedSummary: String(parsed.mergedSummary || "").trim(),
    mergedTags: Array.isArray(parsed.mergedTags)
      ? parsed.mergedTags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
      : [],
    reason: String(parsed.reason || "").trim().slice(0, 240) || "完成主题一致性核验",
  };
}

export async function testAiConnection(aiConfig) {
  const creds = resolveAiCredentials(aiConfig);
  const report = {
    llm: { ok: false, latencyMs: 0, detail: "未配置 Key" },
    embedding: { ok: false, dims: 0, latencyMs: 0, detail: "未配置 Key" },
  };

  if (creds.llmApiKey) {
    const t0 = Date.now();
    try {
      const data = await fetchJsonWithTimeout(
        `${creds.llmBaseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creds.llmApiKey}`,
          },
          body: JSON.stringify({
            model: creds.llmModel,
            max_tokens: 8,
            messages: [{ role: "user", content: "ping" }],
          }),
        },
        10000
      );
      report.llm = {
        ok: Boolean(data?.choices?.length),
        latencyMs: Date.now() - t0,
        detail: `模型 ${creds.llmModel} 连通正常`,
      };
    } catch (err) {
      report.llm = {
        ok: false,
        latencyMs: Date.now() - t0,
        detail: err.message || String(err),
      };
    }
  }

  if (creds.embeddingApiKey) {
    const t0 = Date.now();
    try {
      const vecs = await embedTexts(["lanxi connection test"], aiConfig, { timeoutMs: 10000 });
      const dims = vecs[0]?.length || 0;
      report.embedding = {
        ok: dims > 0,
        dims,
        latencyMs: Date.now() - t0,
        detail: dims > 0 ? `模型 ${creds.embeddingModel} 正常 (${dims} 维)` : "返回向量为空",
      };
    } catch (err) {
      report.embedding = {
        ok: false,
        dims: 0,
        latencyMs: Date.now() - t0,
        detail: err.message || String(err),
      };
    }
  }

  return report;
}
