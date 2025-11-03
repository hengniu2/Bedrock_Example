// web/server/agent-bridge.ts
import "server-only";

type RunAgentArgs = { prompt: string; sessionId?: string; plannerUrl?: string };

export async function runAgent({ prompt, sessionId, plannerUrl }: RunAgentArgs) {
  // @ts-ignore ESM outside /web
  const mod = await import("../../agent/cli.mjs");
  // Pass the BASE URL; the agent will normalize to /invocations exactly once.
  return await mod.runAgent(prompt, {
    sessionId,
    plannerUrl: plannerUrl || process.env.PLANNER_URL, // e.g. http://127.0.0.1:8080
  });
}
