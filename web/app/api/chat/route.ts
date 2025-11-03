import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function withTimeout<T>(p: Promise<T>, ms: number) {
  let t: NodeJS.Timeout;
  const timer = new Promise<T>((_, rej) =>
    (t = setTimeout(() => rej(new Error(`Server timeout after ${ms}ms`)), ms))
  );
  // @ts-ignore
  return Promise.race<T>([p.finally(() => clearTimeout(t)), timer]);
}

async function pushTrace(sessionId: string, kind: string, payload: any) {
  try {
    const base = (process.env.PLANNER_URL || "http://127.0.0.1:8080").replace(/\/+$/, "").replace(/\/invocations$/, "");
    await fetch(`${base}/trace/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, kind, payload }),
      cache: "no-store",
    });
  } catch {
    // best-effort; don't throw
  }
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  try {
    const body = await req.json();
    const message: string = body?.message;
    const sessionId: string | undefined = body?.sessionId;

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Missing 'message'." }, { status: 400 });
    }

    if (sessionId) {
      // You will ALWAYS see these two immediately in the Trace Console
      pushTrace(sessionId, "server.recv", { route: "/api/chat", at: new Date().toISOString() });
      pushTrace(sessionId, "prompt", { message });
    }

    const { runAgent } = await import("../../../server/agent-bridge");

    const result: any = await withTimeout(
      (async () => {
        const r = await runAgent({ prompt: message, sessionId });
        return r;
      })(),
      30000 // 30s hard cap per request
    ).catch((e: any) => {
      return {
        assistant:
          "⏱️ I paused this run due to a server timeout. Try again with a bit more detail or a smaller change.",
        plan: [],
        logs: [String(e?.message || e)],
        previewPath: "/",
        sessionId,
        error: "timeout",
      };
    });

    if (sessionId) {
      pushTrace(sessionId, "server.done", { ms: Date.now() - t0, ok: !result?.error });
    }

    result.serverMs = Date.now() - t0;
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}
