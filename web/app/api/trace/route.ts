import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function plannerBase() {
  const raw = process.env.PLANNER_URL || "http://127.0.0.1:8080";
  return raw.replace(/\/+$/, "").replace(/\/invocations$/, "");
}

async function openUpstream(url: string, ms = 10000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, {
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      cache: "no-store",
      signal: ac.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return new Response("Missing sessionId", { status: 400 });
  }

  const base = plannerBase();
  const queryUrl = `${base}/trace/stream?session_id=${encodeURIComponent(sessionId)}`;
  const pathUrl  = `${base}/trace/stream/${encodeURIComponent(sessionId)}`;

  // Try query-style first
  let upstream = await openUpstream(queryUrl).catch((e: any) => {
    return new Response(`fetch error: ${e?.message || e}`, { status: 599 }) as any;
  });

  // If 404/400/405 or no body, retry with path-style
  if (!('ok' in upstream) || !upstream.ok || !upstream.body) {
    const st = (upstream as Response).status ?? 0;
    if (st === 404 || st === 400 || st === 405) {
      upstream = await openUpstream(pathUrl).catch((e: any) => {
        return new Response(`fetch error: ${e?.message || e}`, { status: 599 }) as any;
      });
    }
  }

  if (!('ok' in upstream) || !upstream.ok || !upstream.body) {
    const st = (upstream as Response).status ?? 0;
    const text = typeof (upstream as any).text === "function" ? await (upstream as Response).text().catch(() => "") : "";
    return new Response(`Trace upstream error ${st}: ${text || "(no body)"}`, { status: 502 });
  }

  // Success: tunnel the stream through Next without buffering
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
