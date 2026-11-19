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

function parseSynthesisJson(rawText) {
  const text = String(rawText || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  const jsonStr = objMatch ? objMatch[0] : candidate;
  const parsed = JSON.parse(jsonStr);
  const targetLayer = parsed.targetLayer === "structural" ? "structural" : "knowledge";
  return {
    title: String(parsed.title || "").trim().slice(0, 100) || "凝结知识节点",
    summary: String(parsed.summary || "").trim(),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8) : ["consolidated"],
    targetLayer,
  };
}

export async function synthesizeConsolidation(nodes, aiConfig, { timeoutMs = 20000 } = {}) {
  const creds = resolveAiCredentials(aiConfig);
  if (!creds.llmApiKey) {
    throw new Error("未配置 LLM API Key");
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("请至少选择一个源记忆节点进行凝结");
  }

  const formattedNodes = nodes
    .map((n, idx) => {
      const body = String(n.body || n.preview || "").trim().slice(0, 1200);
      return `[#${idx + 1} id=${n.id} layer=${n.layer} title=${n.title}]\n${body}`;
    })
    .join("\n\n---\n\n");

  const systemPrompt = [
    "你是一个严谨的知识图谱凝结助手。请把用户提供的多条零散记忆节点提炼为一条高信息密度的长期记忆。",
    "要求：",
    "1. 保留关键事实、路径、参数、因果结论，不编造不存在的信息。",
    "2. 仅输出一个 JSON 对象，不要附加额外解释。",
    'JSON 字段格式：{"title":"简明标题","summary":"提炼后的 Markdown 正文","tags":["标签1","标签2"],"targetLayer":"knowledge 或 structural"}',
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
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `请凝结以下 ${nodes.length} 条记忆节点：\n\n${formattedNodes}` },
        ],
      }),
    },
    timeoutMs
  );

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("LLM 响应内容为空");
  }
  const result = parseSynthesisJson(content);
  if (!result.summary) {
    throw new Error("LLM 凝结结果缺少 summary 正文");
  }
  return result;
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
