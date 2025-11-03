// agent/cli.mjs
import fs from "node:fs/promises";
import fscb from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import crypto from "node:crypto";

// ------------------------------
// Paths
// ------------------------------
const CWD = process.cwd();
const WEB_ROOT =
  path.basename(CWD).toLowerCase() === "web" ? CWD : path.join(CWD, "web");
const WEB_ROOT_WITH_SEP = WEB_ROOT + path.sep;

// ------------------------------
// Planner endpoint normalization
// ------------------------------
// Accept either base (http://127.0.0.1:8080) or full (http://.../invocations)
function toInvocationsEndpoint(urlLike) {
  const raw =
    urlLike ||
    process.env.PLANNER_URL ||
    "http://127.0.0.1:8080"; // base default

  if (/\/invocations\/?$/i.test(raw)) return raw.replace(/\/+$/, "");
  return raw.replace(/\/+$/, "") + "/invocations";
}

// ------------------------------
// Trace helper (best-effort)
// ------------------------------
function plannerBaseFromInvocations(invUrl) {
  return invUrl.replace(/\/+invocations\/?$/i, "");
}
async function pushTrace(invocationsUrl, sessionId, kind, payload = {}) {
  try {
    const base = plannerBaseFromInvocations(invocationsUrl);
    await fetch(`${base}/trace/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, kind, payload }),
      cache: "no-store",
    });
  } catch {
    // tracing is best-effort
  }
}

// ------------------------------
// Validation
// ------------------------------
function validatePlan(actions) {
  const allowed = new Set([
    "create_file",
    "update_file",
    "delete_file",
    "run_command",
  ]);
  if (!Array.isArray(actions)) throw new Error("actions must be an array");
  for (const a of actions) {
    if (!allowed.has(a.type)) throw new Error(`Disallowed action: ${a.type}`);
    if (
      (a.type === "create_file" || a.type === "update_file") &&
      typeof a.contents !== "string"
    ) {
      throw new Error(`${a.type} requires contents`);
    }
    if (
      (a.type === "create_file" ||
        a.type === "update_file" ||
        a.type === "delete_file") &&
      typeof a.path !== "string"
    ) {
      throw new Error(`${a.type} requires path`);
    }
    if (a.type === "run_command" && typeof a.command !== "string") {
      throw new Error(`run_command requires command`);
    }
  }
  return actions;
}

// ------------------------------
// Safe FS helpers
// ------------------------------
function resolveInsideWeb(relPath) {
  const abs = path.resolve(WEB_ROOT, relPath);
  if (!abs.startsWith(WEB_ROOT_WITH_SEP))
    throw new Error(`Refusing to touch outside web/: ${relPath}`);
  return abs;
}

async function diffAgainstExisting(absPath, nextContents) {
  const exists = fscb.existsSync(absPath);
  if (!exists) return { existed: false };
  const prev = await fs.readFile(absPath, "utf8");
  const prevLines = prev.split("\n");
  const nextLines = nextContents.split("\n");
  const changes = [];
  const max = Math.min(prevLines.length, nextLines.length);
  for (let i = 0; i < max; i++) {
    if (prevLines[i] !== nextLines[i]) {
      changes.push({ line: i + 1, before: prevLines[i], after: nextLines[i] });
      if (changes.length >= 8) break;
    }
  }
  if (nextLines.length > prevLines.length) {
    changes.push({ added: nextLines.length - prevLines.length });
  } else if (prevLines.length > nextLines.length) {
    changes.push({ removed: prevLines.length - nextLines.length });
  }
  return { existed: true, changes };
}

// ------------------------------
// Command runner (streaming to trace)
// ------------------------------
const ALLOWED_COMMANDS = new Set([
  "npm run build",
  "npm run lint",
  "npm run typecheck",
  "next build",
]);

function runWhitelistedCommandStreaming(invocationsUrl, sessionId, command, cwd = WEB_ROOT) {
  return new Promise((resolve) => {
    if (!ALLOWED_COMMANDS.has(command)) {
      pushTrace(invocationsUrl, sessionId, "command.end", {
        cmd: command,
        skipped: true,
        code: 0,
        reason: "not whitelisted",
      });
      return resolve({ code: 0, stdout: "", stderr: "" });
    }

    pushTrace(invocationsUrl, sessionId, "command.start", { cmd: command, cwd });

    const child = cp.spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
    });

    let stdout = "",
      stderr = "";
    const sendLines = (streamKind, chunk) => {
      const s = chunk?.toString() ?? "";
      if (!s) return;
      for (const line of s.split(/\r?\n/)) {
        if (!line) continue;
        pushTrace(invocationsUrl, sessionId, "command.chunk", {
          cmd: command,
          stream: streamKind,
          line,
        });
      }
    };

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      sendLines("stdout", d);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      sendLines("stderr", d);
    });

    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      pushTrace(invocationsUrl, sessionId, "command.end", {
        cmd: command,
        code: -1,
        timeout: true,
      });
      resolve({ code: -1, stdout, stderr: stderr + "\n[Timed out]" });
    }, 15_000);

    child.on("close", (code) => {
      clearTimeout(t);
      pushTrace(invocationsUrl, sessionId, "command.end", {
        cmd: command,
        code: code ?? 0,
      });
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

// ------------------------------
// Build minimal inline context for planner
// ------------------------------
async function buildContextInline() {
  async function safeRead(rel) {
    try {
      return await fs.readFile(path.join(WEB_ROOT, rel), "utf8");
    } catch {
      return null;
    }
  }
  const files = {};
  for (const rel of [
    "package.json",
    "next.config.js",
    "next.config.ts",
    "app/page.tsx",
    "app/layout.tsx",
    "app/global.css",
    "pages/index.tsx",
    // Intentionally NOT including app/chat/page.tsx in context snapshot here
  ]) {
    const c = await safeRead(rel);
    if (c != null) files[rel] = c;
  }
  return { files };
}

// ------------------------------
// Preview path inference
// ------------------------------
function inferPreviewPathFromActions(actions) {
  const isChatPath = (p) => {
    const np = p.replace(/\\/g, "/");
    return (
      np === "app/chat/page.tsx" ||
      np.startsWith("app/chat/") ||
      np === "pages/chat.tsx" ||
      np.startsWith("pages/chat/")
    );
  };

  // Prefer last touched non-chat app route
  const touched = [...actions].reverse();
  for (const a of touched) {
    if (!("path" in a) || !a.path) continue;
    const p = a.path.replace(/\\/g, "/");
    if (isChatPath(p)) continue; // 🚫 never preview the chat route

    if (p.startsWith("app/") && p.endsWith("/page.tsx")) {
      const sub = p.slice("app/".length, -"/page.tsx".length);
      const cleaned = sub
        .split("/")
        .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
        .join("/");
      return "/" + cleaned;
    }
    if (p.startsWith("pages/") && p.endsWith(".tsx")) {
      const sub = p.slice("pages/".length, -".tsx".length);
      if (sub === "index") return "/";
      return "/" + sub.replace(/\/index$/, "");
    }
  }

  // If explicitly touched the app root page, use it
  if (
    touched.some(
      (a) =>
        a.path === "app/page.tsx" ||
        a.path === "pages/index.tsx"
    )
  ) {
    return "/";
  }

  // Final fallback: root
  return "/";
}

// ------------------------------
// Agent core
// ------------------------------
export async function runAgent(userPrompt, { plannerUrl, sessionId } = {}) {
  const sid = sessionId || crypto.randomUUID();
  const invUrl = toInvocationsEndpoint(plannerUrl);

  // Smoke trace so UI confirms wiring immediately
  await pushTrace(invUrl, sid, "step", {
    msg: "agent.enter",
    preview: String(userPrompt).slice(0, 200),
  });

  // 1) Call planner (/invocations)
  const context = await buildContextInline();

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error("Planner request timed out")), 20000);

  let actions = [];
  let assistant_message = "";
  try {
    await pushTrace(invUrl, sid, "step", { msg: "planning.start" });
    await pushTrace(invUrl, sid, "bedrock.call", { endpoint: "/invocations" });

    const res = await fetch(invUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: userPrompt, context, session_id: sid }),
      signal: ac.signal,
    });
    clearTimeout(t);

    if (!res.ok) {
      const text = await res.text();
      await pushTrace(invUrl, sid, "error", {
        where: "planner.invocations",
        status: res.status,
        text,
      });
      throw new Error(`Planner error: ${res.status} ${text}`);
    }

    const json = await res.json();
    assistant_message = json.assistant_message || "";
    actions = validatePlan(json.actions || []);

    await pushTrace(invUrl, sid, "bedrock.done", { ok: true, actions: actions.length });
    await pushTrace(invUrl, sid, "step", { msg: "planning.response" });
    await pushTrace(invUrl, sid, "plan.summary", {
      total: actions.length,
      create: actions.filter((a) => a.type === "create_file").length,
      update: actions.filter((a) => a.type === "update_file").length,
      del: actions.filter((a) => a.type === "delete_file").length,
      run: actions.filter((a) => a.type === "run_command").length,
      files: actions.filter((a) => a.path).map((a) => a.path).slice(0, 50),
    });
  } catch (err) {
    clearTimeout(t);
    await pushTrace(invUrl, sid, "error", { where: "planner.call", message: String(err) });
    // ensure UI unblocks
    return {
      assistant: assistant_message || String(err),
      plan: [],
      logs: [`Planner failed: ${String(err)}`],
      previewPath: "/",
      sessionId: sid,
    };
  }

  // 2) Apply plan (stream as we work)
  const logs = [];
  await pushTrace(invUrl, sid, "step", { msg: "apply.start" });

  for (const a of actions) {
    if (a.type === "create_file" || a.type === "update_file") {
      const abs = resolveInsideWeb(a.path);
      const next = a.contents;

      const diffInfo = await diffAgainstExisting(abs, next);
      await pushTrace(invUrl, sid, "fileOp.start", {
        op: a.type,
        path: a.path,
        existed: !!diffInfo.existed,
      });

      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, next, "utf8");

      if (diffInfo.existed && diffInfo.changes?.length) {
        await pushTrace(invUrl, sid, "fileOp.diff", {
          path: a.path,
          sample: diffInfo.changes,
        });
      }

      await pushTrace(invUrl, sid, "fileOp.end", {
        op: a.type,
        path: a.path,
        bytes: Buffer.byteLength(next, "utf8"),
      });
      logs.push(`${a.type.replace("_", " ")} ${a.path}`);
    } else if (a.type === "delete_file") {
      const abs = resolveInsideWeb(a.path);
      await pushTrace(invUrl, sid, "fileOp.start", { op: "delete_file", path: a.path });
      await fs.rm(abs, { force: true });
      await pushTrace(invUrl, sid, "fileOp.end", { op: "delete_file", path: a.path });
      logs.push(`deleted ${a.path}`);
    } else if (a.type === "run_command") {
      await runWhitelistedCommandStreaming(invUrl, sid, a.command);
      logs.push(`$ ${a.command}`);
    }
  }

  await pushTrace(invUrl, sid, "step", { msg: "apply.done" });

  // 3) Compute preview path and finish (🚫 never /chat)
  const previewPath = inferPreviewPathFromActions(actions) || "/";
  await pushTrace(invUrl, sid, "step", { msg: "preview.path", previewPath });
  await pushTrace(invUrl, sid, "done", { ok: true });

  return {
    assistant: assistant_message,
    plan: actions,
    logs,
    previewPath,
    sessionId: sid,
  };
}

// ------------------------------
// CLI helper
// ------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const prompt = process.argv.slice(2).join(" ").trim();
    if (!prompt) {
      console.error("Usage: node agent/cli.mjs \"your prompt\"");
      process.exit(1);
    }
    const sid = crypto.randomUUID();
    try {
      const { assistant, plan, previewPath } = await runAgent(prompt, {
        sessionId: sid,
      });
      console.log("\nAssistant:\n", assistant);
      console.log("\nPlan:\n", JSON.stringify(plan, null, 2));
      console.log("\nPreview:\n", previewPath);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  })();
}
