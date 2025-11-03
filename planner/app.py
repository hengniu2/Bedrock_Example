import os
import json
import uuid
import logging
import time
import asyncio
import re
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException, Body
from fastapi.responses import JSONResponse, HTMLResponse, StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv

import boto3
from botocore.config import Config
from botocore.exceptions import ParamValidationError

# =============================
# Startup & Config
# =============================
load_dotenv()

REGION = os.getenv("AWS_REGION", os.getenv("BEDROCK_REGION", "eu-north-1"))
MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "eu.amazon.nova-pro-v1:0")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("planner")

app = FastAPI(title="Planner + Chat + Codegen (trace)", version="4.4.0")

@app.get("/__routes")
def __routes():
    return {"paths": [getattr(r, "path", None) for r in app.routes]}

# =============================
# Bedrock helper
# =============================
class BedrockClient:
    def __init__(self, model_id: str, region: str):
        self.model_id = model_id
        # ⏱ Tighter client timeouts so the UI never hangs forever
        self.client = boto3.client(
            "bedrock-runtime",
            region_name=region,
            config=Config(connect_timeout=3, read_timeout=20, retries={"max_attempts": 2}),
        )

    def _retry_without_tools_if_needed(self, fn, req: Dict[str, Any]):
        try:
            return fn(**req)
        except ParamValidationError as e:
            msg = str(e)
            if 'Unknown parameter in input: "tools"' in msg or "Unknown parameter in input: 'tools'" in msg:
                req2 = dict(req)
                req2.pop("tools", None)
                req2.pop("toolConfig", None)
                log.warning("SDK rejected 'tools'; retrying without tools for %s", fn.__name__)
                return fn(**req2)
            raise

    def converse(self, system_prompt: Optional[str], messages: List[Dict[str, Any]],
                 tools: Optional[List[Dict[str, Any]]] = None,
                 tool_config: Optional[Dict[str, Any]] = None,
                 inference_config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        req: Dict[str, Any] = {"modelId": self.model_id, "messages": messages}
        if system_prompt: req["system"] = [{"text": system_prompt}]
        if tools: req["tools"] = tools
        if tool_config: req["toolConfig"] = tool_config
        if inference_config: req["inferenceConfig"] = inference_config
        return self._retry_without_tools_if_needed(self.client.converse, req)

    def converse_stream(self, system_prompt: Optional[str], messages: List[Dict[str, Any]],
                        tools: Optional[List[Dict[str, Any]]] = None,
                        inference_config: Optional[Dict[str, Any]] = None):
        req: Dict[str, Any] = {"modelId": self.model_id, "messages": messages}
        if system_prompt: req["system"] = [{"text": system_prompt}]
        if tools: req["tools"] = tools
        if inference_config: req["inferenceConfig"] = inference_config
        return self._retry_without_tools_if_needed(self.client.converse_stream, req)

brx = BedrockClient(MODEL_ID, REGION)

# =============================
# Prompts & Tools
# =============================
PLANNER_SYSTEM = (
    "You are a software planning agent. Prefer the emit_plan tool to return actionable steps. "
    "Avoid long prose; keep outputs concise."
)
CHAT_SYSTEM = "You are a helpful, concise engineering assistant. Keep answers brief."
CODEGEN_SYSTEM = "You are a senior software engineer. Use emit_files to return complete files when needed."

EMIT_FILES_TOOL = [{
    "toolSpec": {
        "name": "emit_files",
        "description": "Return one or more files as JSON.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "files": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "path": {"type": "string"},
                                "contents": {"type": "string"},
                            },
                            "required": ["path", "contents"],
                        },
                    }
                },
                "required": ["files"],
            }
        },
    }
}]

EMIT_PLAN_TOOL = [{
    "toolSpec": {
        "name": "emit_plan",
        "description": "Return a structured plan JSON. May include an 'actions' array with file/command steps.",
        "inputSchema": {
            "json": {
                "type": "object",
                "properties": {
                    "summary": {"type": "string"},
                    "steps": {"type": "array", "items": {"type": "string"}},
                    "assumptions": {"type": "array", "items": {"type": "string"}},
                    "risks": {"type": "array", "items": {"type": "string"}},
                    "actions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": {"type": "string"},
                                "path": {"type": "string"},
                                "contents": {"type": "string"},
                                "command": {"type": "string"},
                            },
                            "required": ["type"],
                        },
                    },
                },
                "required": ["summary", "steps"],
            }
        },
    }
}]

# Strict JSON-only fallback instruction (no tools)
JSON_PLAN_SYSTEM = (
    "You are a code planning agent for a Next.js app. "
    "Output ONLY strict minified JSON, no prose, no markdown, no comments. "
    "Schema: {\"actions\":[{\"type\":\"create_file|update_file|delete_file|run_command\","
    "\"path\"?:string, \"contents\"?:string, \"command\"?:string}]}. "
    "Always include full file contents for create/update. "
    "Prefer updating or creating Next.js routes under app/**/page.tsx so a preview updates. "
    "If the user asks to 'clear components', remove or simplify components and update app/page.tsx accordingly."
)

# =============================
# Pydantic models
# =============================
class PlanRequest(BaseModel):
    input: str
    context: Optional[Dict[str, Any]] = None
    session_id: Optional[str] = None

class PlanResponse(BaseModel):
    assistant_message: Optional[str] = None
    actions: List[Dict[str, Any]] = []

class ChatSendRequest(BaseModel):
    session_id: Optional[str] = None
    user_input: str
    context: Optional[Dict[str, Any]] = None

class ChatSendResponse(BaseModel):
    session_id: str
    assistant_output: str
    history_len: int

class CodeGenRequest(BaseModel):
    instructions: str
    language: Optional[str] = None
    context: Optional[Dict[str, Any]] = None
    session_id: Optional[str] = None

class CodeGenResponse(BaseModel):
    files: List[Dict[str, str]]

# =============================
# In-memory chat store
# =============================
_SESSIONS: Dict[str, List[Dict[str, Any]]] = {}

def _new_session_id() -> str:
    return str(uuid.uuid4())

def _get_history(session_id: str) -> List[Dict[str, Any]]:
    return _SESSIONS.setdefault(session_id, [])

# =============================
# Preview plumbing
# =============================
_PREVIEW_HTML: str = ""  # updated by /code/generate

def _tsx_wrapper(tsx_filename: str, tsx_code: str) -> str:
    return f"""<!doctype html>
<html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>{tsx_filename} preview</title>
<style>html,body,#root{{height:100%;margin:0}}*,*:before,*:after{{box-sizing:border-box}}</style>
<script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
</head>
<body><div id="root"></div>
<script type="text/babel" data-presets="typescript,react">
{tsx_code}
try {{
  const C = (typeof RootLayout!=='undefined'&&RootLayout) || (typeof App!=='undefined'&&App) || (typeof Layout!=='undefined'&&Layout);
  if (!C) throw new Error('No RootLayout/App/Layout export found to mount.');
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(C, {{}}));
}} catch (e) {{
  const pre = document.createElement('pre'); pre.textContent = 'Preview error:\\n' + String(e);
  document.body.appendChild(pre);
}}
</script></body></html>"""

def _choose_preview_html(files: List[Dict[str, str]]) -> str:
    for f in files:
        p = (f.get("path") or "").lower()
        if p.endswith("index.html"):
            return f.get("contents", "")
    for f in files:
        name = (f.get("path") or "").split("/")[-1]
        if name in {"layout.tsx", "app.tsx", "App.tsx", "index.tsx"} or name.lower().endswith(".tsx"):
            return _tsx_wrapper(f.get("path", ""), f.get("contents", ""))
    for f in files:
        if (f.get("path") or "").lower().endswith(".html"):
            return f.get("contents", "")
    if files:
        first = files[0]
        return f"<pre>{first.get('path','(no path)')}\\n\\n{first.get('contents','')}</pre>"
    return "<p>(no content)</p>"

_SHELL_PREVIEW = """<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>html,body{height:100%;margin:0}*,*:before,*:after{box-sizing:border-box}body{overflow:hidden}#root{min-height:100%}[data-hide-in-preview],.hide-in-preview{display:none!important}</style>
<title>{title}</title></head><body><div id="root">{content}</div></body></html>"""

_SHELL_PAGE = """<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>html,body{height:100%;margin:0}*,*:before,*:after{box-sizing:border-box}body{overflow:auto}#root{min-height:100%}</style>
<title>{title}</title></head><body><div id="root">{content}</div></body></html>"""

@app.get("/preview")
def preview():
    html = _SHELL_PREVIEW.format(title="Preview", content=_PREVIEW_HTML or "<p>(no content yet)</p>")
    return HTMLResponse(html)

@app.get("/page")
def page():
    html = _SHELL_PAGE.format(title="Full Page", content=_PREVIEW_HTML or "<p>(no content yet)</p>")
    return HTMLResponse(html)

# =============================
# TRACE BUS (SSE)
# =============================
SESSION_QUEUES: Dict[str, asyncio.Queue[Tuple[str, dict]]] = {}

def _get_queue(session_id: str) -> asyncio.Queue:
    q = SESSION_QUEUES.get(session_id)
    if q is None:
        q = asyncio.Queue()
        SESSION_QUEUES[session_id] = q
    return q

def trace(session_id: str, kind: str, payload: dict):
    q = _get_queue(session_id)
    q.put_nowait((kind, payload))

@app.get("/trace/stream")
async def trace_stream(session_id: str):
    log.info("[trace] open session_id=%s", session_id)
    q = _get_queue(session_id)

    async def gen():
        yield "event: hello\n" + f"data: {json.dumps({'ts': time.time()})}\n\n"
        last_ping = time.time()
        try:
            while True:
                try:
                    kind, payload = await asyncio.wait_for(q.get(), timeout=5.0)
                    yield f"event: {kind}\n" + f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    if time.time() - last_ping > 30:
                        last_ping = time.time()
        finally:
            SESSION_QUEUES.pop(session_id, None)
            log.info("[trace] closed session_id=%s", session_id)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

@app.get("/trace/stream/{session_id}")
async def trace_stream_path(session_id: str):
    return await trace_stream(session_id)

@app.post("/trace/push")
async def trace_push(
    session_id: str = Body(..., embed=True),
    kind: str = Body(..., embed=True),
    payload: dict = Body(default_factory=dict, embed=True),
):
    _get_queue(session_id)
    trace(session_id, kind, payload)
    return JSONResponse({"ok": True})

# =============================
# Friendly assistant summaries
# =============================
def _peek(s: Optional[str]) -> str:
    if not s: return ""
    t = re.sub(r"\s+", " ", s.strip())
    return t[:60] + ("…" if len(t) > 60 else "")

def _guess_button_label(src: str) -> Optional[str]:
    m = re.search(r"<button[^>]*>([^<]{1,40})</button>", src, flags=re.I|re.S)
    if m:
        label = m.group(1).strip()
        label = re.sub(r"\s+", " ", label)
        return label
    return None

def _guess_color(src: str) -> Optional[str]:
    s = src.lower()
    m = re.search(r"\b(bg|text|border)-([a-z]+)-\d{2,3}\b", s)
    if m: return m.group(0)
    m = re.search(r"color:\s*([^;}{]+)", s)
    if m: return f"color {m.group(1).strip()}"
    m = re.search(r"background(?:-color)?:\s*([^;}{]+)", s)
    if m: return f"background {m.group(1).strip()}"
    return None

def _describe_contents(src: str) -> List[str]:
    hints: List[str] = []
    low = src.lower()
    if "<button" in low:
        lbl = _guess_button_label(src)
        if lbl: hints.append(f"added/updated a button “{lbl}”")
        else: hints.append("added/updated a button")
        c = _guess_color(src)
        if c: hints.append(f"with {c}")
    if re.search(r"<h1[^>]*>", src, flags=re.I): hints.append("changed the main heading")
    if re.search(r"<p[^>]*>", src, flags=re.I): hints.append("updated page copy")
    if re.search(r"className=.*?(grid|flex|container)", src, flags=re.I): hints.append("adjusted layout")
    return hints

def build_assistant_message(user_text: str, actions: List[Dict[str, Any]]) -> str:
    created = sum(1 for a in actions if a["type"] == "create_file")
    updated = sum(1 for a in actions if a["type"] == "update_file")
    deleted = sum(1 for a in actions if a["type"] == "delete_file")
    ran = sum(1 for a in actions if a["type"] == "run_command")
    paths = [a.get("path") for a in actions if a.get("path")]

    insights: List[str] = []
    for a in actions:
        if a["type"] in ("create_file", "update_file"):
            cont = a.get("contents") or ""
            insights.extend(_describe_contents(cont))

    touched = ", ".join(paths[:3]) + ("…" if len(paths) > 3 else "")
    head = "✅ changes applied" if (created + updated + deleted + ran) else "✅ no-op"

    counts = f" ({created} create, {updated} update, {deleted} delete, {ran} run)."
    detail = f" Touched: {touched}." if touched else ""
    hint = f" I {', '.join(insights)}." if insights else ""
    tail = f" You asked: “{_peek(user_text)}”."

    return f"{head}{counts}{detail}{hint}{tail}"

# =============================
# Helpers for planning fallbacks
# =============================
class _ToolCapture:
    def __init__(self):
        self.actions: List[Dict[str, Any]] = []
    def absorb(self, part: Dict[str, Any]):
        tu = part.get("toolUse")
        if tu and isinstance(tu.get("input"), dict):
            acts = tu["input"].get("actions")
            if isinstance(acts, list):
                self.actions = acts

def _context_blob(context: Optional[Dict[str, Any]], char_budget: int = 10000) -> str:
    if not context or "files" not in context: return ""
    files = context["files"]
    chunks = []
    used = 0
    for rel, src in files.items():
        header = f"\n--- FILE: {rel} ---\n"
        take = max(0, char_budget - used - len(header))
        if take <= 0: break
        body = (src if len(src) <= take else src[:take])
        chunks.append(header + body)
        used += len(header) + len(body)
        if used >= char_budget: break
    return "".join(chunks)

def _json_only_plan(session_id: str, user_text: str, context: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    trace(session_id, "step", {"msg": "json-plan.start"})
    snapshot = _context_blob(context)
    prompt = f"User request:\n{user_text}\n\nProject snapshot:\n{snapshot}\n\nReturn ONLY the JSON per schema."

    messages = [{"role": "user", "content": [{"text": prompt}]}]
    try:
        resp = brx.converse(JSON_PLAN_SYSTEM, messages, tools=None, inference_config={"temperature": 0.2})
        out = resp.get("output", {})
        parts = out.get("message", {}).get("content", [])
        text = "\n".join([p.get("text", "") for p in parts if p.get("text")]).strip()
        if not text:
            trace(session_id, "error", {"where": "json_plan", "message": "empty text"})
            return []
        # robust JSON slice
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            text = text[start:end+1]
        data = json.loads(text)
        acts = data.get("actions", [])
        if isinstance(acts, list):
            trace(session_id, "step", {"msg": "json-plan.ok", "count": len(acts)})
            return acts
        trace(session_id, "error", {"where": "json_plan", "message": "no actions key"})
        return []
    except Exception as e:
        trace(session_id, "error", {"where": "json_plan", "message": str(e)})
        return []

def _synthesize_minimal_action(user_text: str) -> List[Dict[str, Any]]:
    safe_text = user_text.replace("<", "&lt;").replace(">", "&gt;")
    tsx = f"""export default function Page() {{
  return (
    <main className="min-h-screen grid place-items-center p-10">
      <div className="max-w-xl text-center">
        <h1 className="text-3xl font-bold mb-3">Applied: {safe_text}</h1>
        <p className="text-slate-500">This is a minimal update because the model did not return actionable steps.</p>
      </div>
    </main>
  );
}}
"""
    return [{"type": "update_file", "path": "app/page.tsx", "contents": tsx}]

# =============================
# Endpoints
# =============================
@app.post("/invocations", response_model=PlanResponse)
def plan_endpoint(req: PlanRequest):
    """
    Planner with streaming traces.
    If no tool actions are returned, run a JSON-only planning pass (with context),
    and if that still yields nothing, synthesize a minimal update.
    """
    session_id = req.session_id or str(uuid.uuid4())
    try:
        user_text = req.input
        messages = [{"role": "user", "content": [{"text": user_text}]}]

        trace(session_id, "step", {"msg": "planning.start"})
        trace(session_id, "model.start", {"model": MODEL_ID, "phase": "plan"})

        assistant_chunks: List[str] = []
        capture = _ToolCapture()

        async def _run_stream():
            stream = brx.converse_stream(
                PLANNER_SYSTEM, messages, tools=EMIT_PLAN_TOOL, inference_config={"temperature": 0.2}
            )
            for ev in stream.get("stream"):
                if "contentBlockDelta" in ev:
                    delta = ev["contentBlockDelta"].get("delta", {})
                    if "text" in delta:
                        t = delta["text"]; assistant_chunks.append(t)
                        trace(session_id, "token", {"text": t})
                    if "toolUse" in delta:
                        trace(session_id, "tool.delta", delta["toolUse"])
                if "contentBlockStart" in ev:
                    start = ev["contentBlockStart"].get("start", {})
                    if "toolUse" in start: trace(session_id, "tool.start", start["toolUse"])
                if "contentBlockStop" in ev:
                    stop = ev["contentBlockStop"].get("stop", {})
                    if "toolUse" in stop: trace(session_id, "tool.stop", stop["toolUse"])
                if "message" in ev:
                    for part in ev["message"].get("content", []):
                        capture.absorb(part)
                        if part.get("text"):
                            t = part["text"]; assistant_chunks.append(t)
                            trace(session_id, "token", {"text": t})
                if "metadata" in ev and "usage" in ev["metadata"]:
                    u = ev["metadata"]["usage"]
                    trace(session_id, "meta", {"inputTokens": u.get("inputTokens"), "outputTokens": u.get("outputTokens")})
                if "messageStop" in ev:
                    trace(session_id, "model.stop", {"phase": "plan"})

        # ⏱ Timebox streaming; if it stalls, fallback to non-stream
        try:
            asyncio.get_event_loop().run_until_complete(asyncio.wait_for(_run_stream(), timeout=20))
        except Exception as stream_err:
            log.warning("Streaming timed out or failed, falling back: %s", stream_err)
            resp = brx.converse(PLANNER_SYSTEM, messages, tools=EMIT_PLAN_TOOL, inference_config={"temperature": 0.2})
            out = resp.get("output", {})
            parts = out.get("message", {}).get("content", [])
            for p in parts:
                if p.get("text"):
                    t = p["text"]; assistant_chunks.append(t)
                    trace(session_id, "token", {"text": t})
                capture.absorb(p)
            trace(session_id, "model.stop", {"phase": "plan"})

        actions: List[Dict[str, Any]] = capture.actions

        if not actions:
            actions = _json_only_plan(session_id, user_text, req.context)

        if not actions:
            trace(session_id, "step", {"msg": "synthesize.minimal"})
            actions = _synthesize_minimal_action(user_text)

        trace(session_id, "step", {"msg": "planning.response", "actions": len(actions)})

        # ✅ Friendly assistant message
        short_msg = build_assistant_message(user_text, actions)

        return PlanResponse(assistant_message=short_msg, actions=actions)

    except Exception as e:
        trace(session_id, "error", {"where": "invocations", "message": str(e)})
        log.exception("Planner error")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/chat/send", response_model=ChatSendResponse)
def chat_send(req: ChatSendRequest):
    try:
        session_id = req.session_id or _new_session_id()
        history = _get_history(session_id)

        messages = history + [{"role": "user", "content": [{"text": req.user_input}]}]
        trace(session_id, "model.start", {"model": MODEL_ID, "phase": "chat"})
        resp = brx.converse(CHAT_SYSTEM, messages)
        out = resp.get("output", {})
        content = out.get("message", {}).get("content", [])
        assistant_text = "\n".join([c.get("text", "") for c in content if c.get("text")]).strip() or "(no text output)"
        if len(assistant_text) > 220: assistant_text = assistant_text[:220].rstrip() + " …"
        trace(session_id, "token", {"text": assistant_text})
        trace(session_id, "model.stop", {"phase": "chat"})

        history.append({"role": "user", "content": [{"text": req.user_input}]})
        history.append({"role": "assistant", "content": [{"text": assistant_text}]})
        _SESSIONS[session_id] = history

        return ChatSendResponse(session_id=session_id, assistant_output=assistant_text, history_len=len(history))
    except Exception as e:
        trace(req.session_id or "(no-session)", "error", {"where": "chat_send", "message": str(e)})
        log.exception("Chat error")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/code/generate", response_model=CodeGenResponse)
def code_generate(req: CodeGenRequest):
    try:
        prompt_lines = [req.instructions]
        if req.language: prompt_lines.append(f"Preferred language: {req.language}")
        if req.context:  prompt_lines.append(f"Context: {json.dumps(req.context)[:1000]}")
        messages = [{"role": "user", "content": [{"text": "\n\n".join(prompt_lines)}]}]

        trace(req.session_id or "(no-session)", "model.start", {"model": MODEL_ID, "phase": "codegen"})
        resp = brx.converse(CODEGEN_SYSTEM, messages, tools=EMIT_FILES_TOOL)
        out = resp.get("output", {})
        parts = out.get("message", {}).get("content", [])

        files: List[Dict[str, str]] = []
        for p in parts:
            tu = p.get("toolUse")
            if tu and tu.get("name") == "emit_files":
                files = (tu.get("input") or {}).get("files", [])
                break
        if not files:
            text = "\n".join([p.get("text", "") for p in parts if p.get("text")]).strip()
            if text:
                files = [{"path": "OUTPUT.txt", "contents": text}]
        if not files:
            raise HTTPException(status_code=502, detail="Model did not return files or text.")

        global _PREVIEW_HTML
        _PREVIEW_HTML = _choose_preview_html(files)

        if req.session_id:
            ops = [{"op": "update_file", "path": f.get("path")} for f in files]
            trace(req.session_id, "plan", {"ops": ops})
            trace(req.session_id, "model.stop", {"phase": "codegen"})

        return CodeGenResponse(files=files)
    except Exception as e:
        trace(req.session_id or "(no-session)", "error", {"where": "code_generate", "message": str(e)})
        log.exception("Codegen error")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/chat/history/{session_id}")
def chat_history(session_id: str):
    return JSONResponse(content={"session_id": session_id, "history": _SESSIONS.get(session_id, [])})

@app.get("/healthz")
def healthz():
    return {"ok": True, "model": MODEL_ID, "region": REGION}
