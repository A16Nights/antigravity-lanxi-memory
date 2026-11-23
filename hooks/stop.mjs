import fs from "node:fs";
import path from "node:path";
import { LanxiEngine } from "../lib/engine.mjs";

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

const TRIVIAL_RE = /^(好的|好呀|谢谢|感谢|收到|明白|ok|okay|yes|no|嗯+|哈哈+|辛苦了|没问题|可以)[!！。.~～\s]*$/i;

function redactSecrets(text) {
  return String(text || "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, "Bearer [REDACTED_TOKEN]");
}

function readLastTranscriptMeta(transcriptPath, maxChars = 400) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return { snippet: "", stepIndex: null };
  try {
    const stat = fs.statSync(transcriptPath);
    const readSize = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(transcriptPath, "r");
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split(/\r?\n/).filter(Boolean);
    let snippet = "";
    let stepIndex = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (stepIndex === null && typeof obj.step_index === "number") {
          stepIndex = obj.step_index;
        }
        if (!snippet && obj.source === "MODEL" && obj.content && String(obj.content).trim()) {
          snippet = String(obj.content).replace(/\s+/g, " ").trim().slice(0, maxChars);
        }
        if (snippet && stepIndex !== null) break;
      } catch {}
    }
    return { snippet, stepIndex };
  } catch {}
  return { snippet: "", stepIndex: null };
}

function main(input) {
  const engine = new LanxiEngine();
  try {
    const cfg = engine.loadConfig();
    if (!cfg.autoIngest) return { decision: "allow" };
    if (input.terminationReason && input.terminationReason !== "NO_TOOL_CALL") {
      return { decision: "allow" };
    }

    const userText = String(input.lastUserInput || "").trim();
    if (userText.length < 12 || TRIVIAL_RE.test(userText)) {
      return { decision: "allow" };
    }

    const convId = input.conversationId || "default";
    const { shouldIngest } = engine.shouldIngestAndMark(convId, userText);
    if (!shouldIngest) {
      return { decision: "allow" };
    }

    const safeUser = redactSecrets(userText).slice(0, 320);
    const meta = readLastTranscriptMeta(input.transcriptPath, 400);
    const assistantSnippet = redactSecrets(meta.snippet);
    const sourceRef = meta.stepIndex !== null ? `${convId}#${meta.stepIndex}` : convId;
    const title = safeUser.replace(/\s+/g, " ").slice(0, 56);
    const body = assistantSnippet
      ? `**用户问题**：${safeUser}\n\n**回应摘要**：${assistantSnippet}`
      : `**用户记录**：${safeUser}`;

    engine.writeMemory({
      layer: "episodic",
      title,
      content: body,
      importance: 0.45,
      confidence: 0.65,
      project: extractProjectName(input) || undefined,
      session_id: convId,
      source_ref: sourceRef,
      role: "user",
      source: "auto-ingest",
      tags: ["auto-ingest", "antigravity"],
    });
  } finally {
    engine.close();
  }
  return { decision: "allow" };
}

try {
  const raw = await readStdin();
  const input = raw ? JSON.parse(raw) : {};
  const res = main(input);
  process.stdout.write(JSON.stringify(res) + "\n");
} catch {
  process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
}
