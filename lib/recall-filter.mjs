import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = process.env.USERPROFILE || os.homedir();

/** 人格卡配置（soul-md）默认路径 */
export const DEFAULT_SOUL_CONFIG_PATH =
  process.env.SOUL_MD_CONFIG || path.join(HOME, ".gemini", "soul-md", "config.json");

/**
 * 中文虚词 / 口头语停用词表（多字词 + 单字语气词）。
 * 多字词直接整体剔除；单字词仅在整个 token 只剩单字时剔除，
 * 避免破坏「在线」「目的」这类含有虚字的技术词。
 */
export const STOPWORDS = [
  // 多字虚词 / 口头语
  "我们",
  "你们",
  "他们",
  "她们",
  "它们",
  "咱们",
  "这个",
  "那个",
  "这些",
  "那些",
  "这里",
  "那里",
  "这样",
  "那样",
  "什么",
  "怎么",
  "为什么",
  "怎么样",
  "是不是",
  "有没有",
  "能不能",
  "可不可以",
  "是不是",
  "对不对",
  "好不好",
  "行不行",
  "可以",
  "应该",
  "需要",
  "还是",
  "或者",
  "而且",
  "但是",
  "不过",
  "因为",
  "所以",
  "如果",
  "然后",
  "就是",
  "不是",
  "其实",
  "好像",
  "大概",
  "可能",
  "觉得",
  "认为",
  "知道",
  "已经",
  "现在",
  "刚才",
  "一下",
  "一点",
  "一些",
  "帮我",
  "给我",
  "看看",
  "请问",
  "麻烦",
  "谢谢",
  "好的",
  "好呀",
  "好吧",
  "收到",
  "明白",
  "明白了",
  "知道了",
  "继续",
  "继续吧",
  "开始",
  "开始吧",
  "可以的",
  "没问题",
  "是的",
  "对的",
  "早安",
  "晚安",
  "辛苦了",
  "没事",
  "等等",
  "随便",
  "都行",
  "对吧",
  "的话",
  "而已",
  "哈哈",
  "嘿嘿",
  "呵呵",
  "嗯嗯",
  "啊啊",
  "不要",
  "没有",
  "还要",
  "而是",
  "并且",
  "以及",
  "关于",
  "对于",
  "由于",
  "虽然",
  "然而",
  "同时",
  "反正",
  "总之",
  // 单字语气词 / 虚字
  "的",
  "了",
  "是",
  "在",
  "我",
  "你",
  "他",
  "她",
  "它",
  "们",
  "呢",
  "吗",
  "吧",
  "啊",
  "呀",
  "哦",
  "嗯",
  "嘛",
  "哈",
  "也",
  "都",
  "就",
  "才",
  "而",
  "与",
  "及",
  "或",
  "把",
  "被",
  "给",
  "对",
  "从",
  "到",
  "这",
  "那",
  "个",
  "很",
  "太",
  "又",
  "还",
  "之",
  "其",
];

const MULTI_STOPWORDS = STOPWORDS.filter((w) => w.length > 1).sort((a, b) => b.length - a.length);
const SINGLE_STOPWORDS = new Set(STOPWORDS.filter((w) => w.length === 1));

const PUNCT_RE = /[\s\u3000，。！？、；：""''（）【】《》〈〉…—·~～,.!?;:()[\]{}<>"'`/\\|*_+=%^&$#@-]+/g;
const MULTI_RE = new RegExp(`(?:${MULTI_STOPWORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");

/**
 * 清洗召回查询：去标点、去停用词，返回以单空格分隔的词块。
 */
export function cleanRecallQuery(rawText) {
  let text = String(rawText ?? "");
  if (!text) return "";
  text = text.replace(PUNCT_RE, " ");
  if (MULTI_STOPWORDS.length > 0) text = text.replace(MULTI_RE, " ");
  const tokens = text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t) => !(t.length === 1 && SINGLE_STOPWORDS.has(t)));
  return tokens.join(" ");
}

/**
 * 是否值得触发自动召回：拦截短闲聊与纯虚词。
 * @returns {{ allow: boolean, reason: string, cleaned: string }}
 */
export function shouldRunAutoRecall(rawText, { minRawLen = 8, minCleanLen = 3 } = {}) {
  const raw = String(rawText ?? "").trim();
  const cleaned = cleanRecallQuery(raw);
  const cleanedLen = cleaned.replace(/\s+/g, "").length;
  if (raw.length < minRawLen) {
    return { allow: false, reason: "raw_too_short", cleaned };
  }
  if (cleanedLen < minCleanLen) {
    return { allow: false, reason: "cleaned_too_short", cleaned };
  }
  return { allow: true, reason: "ok", cleaned };
}

/**
 * 批次归一化过滤召回结果。
 * recall() 的 score 是未归一化乘积（量级 1~16+），因此先取批次最高分：
 * maxScore > 1 时用 score / maxScore 归一化，否则直接用 score 比较。
 */
export function filterRecallResults(items, { minScore = 0.55, maxChars = 1400 } = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return [];

  const scores = list.map((x) => Number(x?.score) || 0);
  const maxScore = Math.max(...scores, 0);
  const useNormalization = maxScore > 1;
  const thresholdRaw = Number(minScore);
  const threshold = Number.isFinite(thresholdRaw) ? thresholdRaw : 0.55;
  const budgetRaw = Number(maxChars);
  const budget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : 1400;

  const candidates = list
    .map((item, idx) => {
      const score = scores[idx];
      const normScore = useNormalization ? (maxScore > 0 ? score / maxScore : 0) : score;
      return { item, score, normScore };
    })
    .filter((c) => c.normScore >= threshold)
    .sort((a, b) => b.normScore - a.normScore);

  const kept = [];
  let used = 0;
  for (const { item, score, normScore } of candidates) {
    const id = String(item.id ?? "");
    const layer = String(item.layer ?? "unknown");
    const title = String(item.title ?? "").replace(/\s+/g, " ").trim();
    const rawPreview = String(item.preview ?? item.body ?? "").replace(/\s+/g, " ").trim();
    const headLen = `- [${layer}|id:${id}] ${title}: `.length;
    const remaining = budget - used - headLen - 1;
    if (remaining <= 0) break;
    const preview = rawPreview.slice(0, Math.min(180, remaining));
    const lineLen = headLen + preview.length;
    if (used + lineLen + 1 > budget && kept.length > 0) break;
    kept.push({
      id,
      layer,
      title,
      preview,
      importance: Number(item.importance) || 0,
      score: Number(score),
      normScore: Number(normScore.toFixed(4)),
      ...(Array.isArray(item.alerts) && item.alerts.length > 0 ? { alerts: item.alerts } : {}),
    });
    used += lineLen + 1;
  }
  return kept;
}

function readSoulConfig(soulConfigPath) {
  const target = soulConfigPath || DEFAULT_SOUL_CONFIG_PATH;
  try {
    if (!target || !fs.existsSync(target)) return null;
    const raw = JSON.parse(fs.readFileSync(target, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

function normalizePath(p) {
  const s = String(p ?? "").trim();
  if (!s) return "";
  try {
    return path.resolve(s).toLowerCase().replace(/[\\/]+$/, "");
  } catch {
    return s.toLowerCase().replace(/[\\/]+$/, "");
  }
}

function pickWorkspacePath(hookInput) {
  const candidates = [
    hookInput?.cwd,
    hookInput?.workspace,
    hookInput?.workspacePath,
    Array.isArray(hookInput?.workspacePaths) ? hookInput.workspacePaths[0] : "",
  ];
  for (const c of candidates) {
    const value = Array.isArray(c) ? c[0] : c;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * 解析当前生效的人格卡：按工作区路径匹配 workspaceCards，回退 defaultCard。
 */
export function resolveActivePersona(hookInput = {}, soulConfigPath) {
  try {
    const cfg = readSoulConfig(soulConfigPath);
    if (!cfg) return "";
    const defaultCard = typeof cfg.defaultCard === "string" ? cfg.defaultCard.trim() : "";
    const cards = cfg.workspaceCards && typeof cfg.workspaceCards === "object" ? cfg.workspaceCards : {};
    const target = normalizePath(pickWorkspacePath(hookInput || {}));
    if (target) {
      const entries = Object.entries(cards);
      for (const [key, value] of entries) {
        if (normalizePath(key) === target && typeof value === "string" && value.trim()) {
          return value.trim();
        }
      }
      for (const [key, value] of entries) {
        const normalizedKey = normalizePath(key);
        if (normalizedKey && target.startsWith(normalizedKey + path.sep) && typeof value === "string" && value.trim()) {
          return value.trim();
        }
      }
    }
    return defaultCard;
  } catch {
    return "";
  }
}

/**
 * 当前人设是否被禁用记忆：命中 disabledList（或 soul 配置的 memory.disabledCards）。
 */
export function isPersonaMemoryDisabled(hookInput = {}, disabledList = [], soulConfigPath) {
  try {
    const persona = resolveActivePersona(hookInput || {}, soulConfigPath);
    if (!persona) return { disabled: false, persona: "" };
    const list = Array.isArray(disabledList)
      ? disabledList
      : typeof disabledList === "string"
        ? [disabledList]
        : [];
    const normalized = list.map((x) => String(x ?? "").trim()).filter(Boolean);
    if (normalized.includes(persona)) {
      return { disabled: true, persona, reason: "settings" };
    }
    const cfg = readSoulConfig(soulConfigPath);
    const soulDisabled = Array.isArray(cfg?.memory?.disabledCards) ? cfg.memory.disabledCards : [];
    if (soulDisabled.map((x) => String(x ?? "").trim()).filter(Boolean).includes(persona)) {
      return { disabled: true, persona, reason: "soul_config" };
    }
    return { disabled: false, persona };
  } catch {
    return { disabled: false, persona: "" };
  }
}
