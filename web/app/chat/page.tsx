"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Prism from "prismjs";
import "prismjs/themes/prism-tomorrow.css";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-css";
import "prismjs/components/prism-json";
import styles from "./page.module.css";

/* ------------------------------ */
/* Types                          */
/* ------------------------------ */
type ChatItem = { role: "user" | "assistant" | "system"; content: string; meta?: any; ts?: number };
type ChatResult = {
  assistant?: string;
  plan?: any[];
  logs?: string[];
  previewPath?: string;
  error?: string;
  serverMs?: number;
  sessionId?: string;
};

type TraceEvent = { kind: string; data: any; ts: number };
type ConnState = "connecting" | "open" | "closed";

/* NEW: file API types */
type FileNode = {
  name: string;
  path: string; // relative to /web
  type: "file" | "dir";
  mtime?: number;
  size?: number;
  children?: FileNode[];
};

/* ------------------------------ */
/* Session Id                     */
/* ------------------------------ */
function useSessionId() {
  const [sid] = useState(() => {
    if (typeof window !== "undefined") {
      const existing = window.sessionStorage.getItem("sid");
      if (existing) return existing;
      const s = crypto.randomUUID();
      window.sessionStorage.setItem("sid", s);
      return s;
    }
    return crypto.randomUUID();
  });
  return sid;
}

/* ------------------------------ */
/* Trace Console (footer)         */
/* ------------------------------ */
function TraceConsole({ sessionId }: { sessionId: string }) {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let stopped = false;
    let attempt = 0;

    const connect = () => {
      if (stopped) return;
      setConn("connecting");
      const url = `/api/trace?sessionId=${encodeURIComponent(sessionId)}&_=${Date.now()}`;
      es = new EventSource(url);
      const add = (kind: string) => (e: MessageEvent) => {
        let payload: any = e.data;
        try { payload = JSON.parse(e.data); } catch {}
        setEvents((prev) => [...prev, { kind, data: payload, ts: Date.now() }]);
      };
      ["hello","step","prompt","plan","fileOp","command","bedrock.call","bedrock.done","token","error","done"].forEach(
        (k) => es!.addEventListener(k, add(k))
      );
      es.onopen = () => { attempt = 0; setConn("open"); };
      es.onerror = () => {
        setConn("closed"); es?.close(); es = null;
        const delay = Math.min(5000, 500 * Math.pow(2, attempt++));
        setTimeout(connect, delay);
      };
    };
    connect();
    return () => { stopped = true; es?.close(); };
  }, [sessionId]);

  useEffect(() => {
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [events]);

  const statusDot = conn === "open" ? "🟢" : conn === "connecting" ? "🟡" : "🔴";

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-3 px-4 py-3 text-slate-100 text-sm border-b border-slate-700/50 bg-gradient-to-r from-slate-800/80 to-slate-700/70 backdrop-blur">
        <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center shadow-lg shadow-orange-500/25">
          <span className="text-white text-sm font-bold">📊</span>
        </div>
        <span className="font-semibold tracking-wide">Trace Console</span>
        <span className="opacity-70 text-xs">{statusDot}</span>
        <div className="flex-1" />
        <button
          onClick={() => setEvents([])}
          className="px-3 py-1.5 rounded-lg border text-xs text-slate-200 border-orange-500/50 hover:bg-orange-500/10 hover:border-orange-400/70 transition-all duration-200"
        >
          Clear
        </button>
      </div>
      <div
        ref={boxRef}
        className={`flex-1 min-h-0 bg-gradient-to-b from-slate-900/50 to-slate-950/80 text-slate-100 p-4 font-mono text-xs overflow-auto shadow-inner ${styles.traceScrollable}`}
      >
        {events.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyStateContent}>
              <div className={styles.emptyStateIcon}>📈</div>
              <div className={styles.emptyStateTitle}>No traces yet</div>
              <div className={styles.emptyStateSubtitle}>Operations will appear here</div>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {events.map((e, i) => (
              <div key={i} className="whitespace-pre-wrap leading-relaxed">
                <span className="opacity-50 text-xs">[{new Date(e.ts).toLocaleTimeString()}]</span>{" "}
                <span className={`font-medium ${
                  e.kind === "command.chunk" 
                    ? (e.data?.stream === "stderr" ? "text-red-400" : "text-slate-200")
                    : "text-emerald-400"
                }`}>
                  {e.kind}
                </span>{" "}
                <span className="text-slate-200">
                  {typeof e.data === "string" ? e.data : JSON.stringify(e.data, null, 2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ */
/* Chat UI                        */
/* ------------------------------ */
function Avatar({ role }: { role: ChatItem["role"] }) {
  const base = "w-8 h-8 rounded-full grid place-items-center shrink-0 text-xs font-bold";
  if (role === "user") return <div className={`${base} bg-indigo-600 text-white`}>U</div>;
  if (role === "assistant") return <div className={`${base} bg-emerald-600 text-white`}>A</div>;
  return <div className={`${base} bg-slate-700 text-white`}>S</div>;
}

function ChatBubble({ role, content, meta, ts, showTime }: ChatItem & { showTime?: boolean }) {
  const isUser = role === "user";
  const isSystem = role === "system";
  const bg = isSystem
    ? "bg-slate-800/70 text-slate-300 border border-slate-700"
    : isUser
    ? "bg-indigo-600 text-white"
    : meta?.error
    ? "bg-red-900/50 text-red-100 border border-red-500/40"
    : "bg-slate-800/80 text-slate-100 border border-slate-700";

  return (
    <div className={`flex items-start gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <Avatar role={role} />
      <div className={`max-w-[80%] md:max-w-[70%] ${isUser ? "items-end text-right" : ""}`}>
        <div className={`px-4 py-3 rounded-2xl shadow ${bg}`}>
          <div className="whitespace-pre-wrap leading-relaxed">{content}</div>
        </div>
        {showTime && ts ? <div className="mt-1 text-[10px] opacity-50">{role} · {new Date(ts).toLocaleTimeString()}</div> : null}
      </div>
    </div>
  );
}

/* ------------------------------ */
/* Iframe helpers                 */
/* ------------------------------ */
function sanitizePreviewPath(p?: string) {
  const toPath = (s: string) => (s.startsWith("/") ? s : `/${s}`);
  if (!p) return "/";
  try {
    const u = new URL(p, typeof window !== "undefined" ? window.location.origin : "http://x");
    const path = u.pathname || "/";
    return path === "/chat" || path.startsWith("/chat/") ? "/" : path;
  } catch {
    const path = toPath(p);
    return path === "/chat" || path.startsWith("/chat/") ? "/" : path;
  }
}

/* ------------------------------ */
/* Preview DOM inspector          */
/* ------------------------------ */

type DomNode = {
  id: string;
  tag: string;                 // '#text' for text nodes
  attrs: Record<string, string>;
  styles: Record<string, string>;
  text?: string;
  children: DomNode[];
};

type TreePath = number[];

/* utils */
function clamp(s: string, n = 80) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function rgbToHex(rgb: string): string | null {
  const m = rgb.replace(/\s+/g, "").match(/^rgba?\((\d+),(\d+),(\d+)(?:,(0|0?\.\d+|1))?\)$/i);
  if (!m) return null;
  const r = Math.min(255, parseInt(m[1], 10));
  const g = Math.min(255, parseInt(m[2], 10));
  const b = Math.min(255, parseInt(m[3], 10));
  const h = (x: number) => x.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/* extract attrs + computed styles */
function pickUsefulAttrs(el: Element, view: Window) {
  const attrs: Record<string, string> = {};
  const push = (k: string, v: string | null | undefined) => {
    if (v == null || v === "") return;
    attrs[k] = v;
  };
  const attr = (k: string) => (el.getAttribute(k) ?? "");

  // EXCLUDE class; keep practical attributes
  push("id", el.id);
  push("role", attr("role"));
  if (el instanceof HTMLAnchorElement) push("href", el.href);
  if (el instanceof HTMLImageElement) { push("src", el.src); push("alt", el.alt); }
  if (el instanceof HTMLInputElement) { push("type", el.type); if (el.value) push("value", el.value); }
  for (const a of Array.from(el.attributes)) {
    if (a.name.startsWith("data-")) attrs[a.name] = a.value;
  }

  const cs = view.getComputedStyle(el as Element);
  const styles: Record<string, string> = {};
  const add = (k: string, v: string | null | undefined) => { if (v) styles[k] = v; };

  // visuals
  add("color", cs.color);
  add("background-color", cs.backgroundColor);
  add("font-family", cs.fontFamily);
  add("font-size", cs.fontSize);
  add("font-weight", cs.fontWeight);
  add("line-height", cs.lineHeight);
  add("letter-spacing", cs.letterSpacing);
  add("text-transform", cs.textTransform);
  add("text-decoration", cs.textDecorationLine);

  // box/layout
  add("display", cs.display);
  add("position", cs.position);
  add("width", cs.width);
  add("height", cs.height);
  add("margin", `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`);
  add("padding", `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`);
  add("border", `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`);
  add("border-radius", cs.borderRadius);
  add("box-shadow", cs.boxShadow);
  add("opacity", cs.opacity);

  add("gap", cs.gap);
  add("flex", cs.flex);
  add("justify-content", cs.justifyContent);
  add("align-items", cs.alignItems);
  add("grid-template-columns", cs.gridTemplateColumns);
  add("grid-template-rows", cs.gridTemplateRows);

  const colorHex = rgbToHex(styles["color"] || "");
  if (colorHex) styles["color-hex"] = colorHex;
  const bgHex = rgbToHex(styles["background-color"] || "");
  if (bgHex) styles["background-hex"] = bgHex;

  return { attrs, styles };
}

function textSnippet(node: Node, max = 80) {
  const raw = (node.textContent || "").replace(/\s+/g, " ").trim();
  return raw.length > max ? raw.slice(0, max) + "…" : raw;
}

/* ——— crawl: builds a div-flattened tree ——— */
function crawlDom(root: Document, opts?: { maxDepth?: number; maxNodes?: number }): DomNode | null {
  const maxDepth = opts?.maxDepth ?? 12;
  const maxNodes = opts?.maxNodes ?? 2000;
  let seen = 0;
  const view = root.defaultView!;

  const EXCLUDE = new Set([
    "script",
    "style",
    "meta",
    "link",
    "noscript",
    "template",
    "next-route-announcer",
    "nextjs-portal",
  ]);
  const isExcluded = (tag: string) => EXCLUDE.has(tag);

  function walk(node: Node, depth: number, accChildren?: DomNode[]): DomNode | null {
    if (seen >= maxNodes || depth > maxDepth) return null;
    seen++;

    if (node.nodeType === Node.TEXT_NODE) {
      const txt = textSnippet(node);
      if (!txt) return null;
      return { id: "", tag: "#text", attrs: {}, styles: {}, text: txt, children: [] };
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node as Element;
    const tn = el.tagName.toLowerCase();

    if (isExcluded(tn)) return null;

    // flatten divs
    if (tn === "div") {
      for (const child of Array.from(el.childNodes)) {
        const d = walk(child, depth + 1, accChildren);
        if (d && accChildren) accChildren.push(d);
      }
      return null;
    }

    const { attrs, styles } = pickUsefulAttrs(el, view);
    const children: DomNode[] = [];
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const ctag = (child as Element).tagName.toLowerCase();
        if (ctag === "div") {
          for (const g of Array.from((child as Element).childNodes)) {
            const d = walk(g, depth + 1, children);
            if (d) children.push(d);
          }
          continue;
        }
        if (isExcluded(ctag)) continue;
      }
      const d = walk(child, depth + 1, children);
      if (d) children.push(d);
    }
    const id = attrs.id || "";
    return { id, tag: tn, attrs, styles, children };
  }

  const start = (root.getElementById("__next") || root.body);
  if (!start) return null;

  const head: DomNode = { id: "", tag: "root", attrs: {}, styles: {}, children: [] };
  for (const c of Array.from(start.childNodes)) {
    const d = walk(c, 0, head.children);
    if (d) head.children.push(d);
  }
  return head;
}

/* ——— map TreePath back to a real DOM node in the iframe ——— */
function flattenedChildrenOf(container: Element | Document): Node[] {
  const kids: Node[] = [];

  const EXCLUDE = new Set([
    "script",
    "style",
    "meta",
    "link",
    "noscript",
    "template",
    "next-route-announcer",
    "nextjs-portal",
  ]);
  const isExcluded = (tag: string) => EXCLUDE.has(tag);

  for (const child of Array.from(container.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = (child as Element).tagName.toLowerCase();
      if (isExcluded(tag)) continue;

      if (tag === "div") {
        for (const g of Array.from((child as Element).childNodes)) kids.push(g);
        continue;
      }
    }
    kids.push(child);
  }
  return kids;
}
function nodeFromPath(doc: Document, path: TreePath): Node | null {
  const start = (doc.getElementById("__next") || doc.body);
  if (!start) return null;
  let container: Element | Document = start;
  let node: Node | null = null;

  for (let i = 0; i < path.length; i++) {
    const list = flattenedChildrenOf(container);
    const idx = path[i];
    const n = list[idx];
    if (!n) return null;
    node = n;
    if (n.nodeType === Node.ELEMENT_NODE) {
      container = n as Element;
    } else {
      if (i !== path.length - 1) return null;
    }
  }
  return node;
}

/* ——— highlight overlays inside the iframe ——— */
function ensureOverlay(doc: Document, id: string, color: string) {
  let el = doc.getElementById(id) as HTMLDivElement | null;
  if (!el) {
    el = doc.createElement("div");
    el.id = id;
    // Apply base overlay styles via inline style (since this is in iframe, CSS modules won't work)
    // Base styles: position, pointer-events, z-index, border-radius are set here
    el.style.position = "absolute";
    el.style.pointerEvents = "none";
    el.style.zIndex = "2147483647";
    el.style.borderRadius = "6px";
    // Dynamic styles: border and box-shadow colors
    el.style.border = `2px solid ${color}`;
    el.style.boxShadow = `0 0 0 2px ${color}55`;
    doc.body.appendChild(el);
  } else {
    // Update dynamic styles
    el.style.borderColor = color;
    el.style.boxShadow = `0 0 0 2px ${color}55`;
  }
  return el;
}
function hideOverlay(doc: Document, id: string) {
  const el = doc.getElementById(id) as HTMLDivElement | null;
  if (el) {
    // Hide overlay by moving it off-screen and setting zero dimensions
    el.style.width = "0px";
    el.style.height = "0px";
    el.style.transform = "translate(-9999px,-9999px)";
  }
}
function positionOverlay(el: HTMLDivElement, rect: DOMRect) {
  const { scrollX, scrollY } = el.ownerDocument.defaultView!;
  el.style.width = Math.max(0, rect.width) + "px";
  el.style.height = Math.max(0, rect.height) + "px";
  el.style.transform = `translate(${Math.max(0, rect.left + scrollX)}px, ${Math.max(0, rect.top + scrollY)}px)`;
}
function rectOfNode(n: Node): DOMRect | null {
  if (n.nodeType === Node.ELEMENT_NODE) return (n as Element).getBoundingClientRect();
  if (n.nodeType === Node.TEXT_NODE) {
    const r = (n.ownerDocument as Document).createRange();
    r.selectNodeContents(n);
    const rect = r.getBoundingClientRect();
    r.detach();
    return rect;
  }
  return null;
}

/* ------------------------------ */
/* Pretty UI helpers              */
/* ------------------------------ */

function ColorSwatch({ color, className = "" }: { color: string; className?: string }) {
  return (
    <span
      className={`${styles.colorSwatch} ${className}`}
      style={{ background: color }}
    />
  );
}

function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "indigo" | "emerald" | "pink" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-800/60 text-slate-200 border-slate-700",
    indigo: "bg-indigo-900/30 text-indigo-200 border-indigo-800",
    emerald: "bg-emerald-900/30 text-emerald-200 border-emerald-800",
    pink: "bg-pink-900/30 text-pink-200 border-pink-800",
  };
  return <span className={`px-1.5 py-0.5 rounded border text-[10px] ${tones[tone]} whitespace-nowrap`}>{children}</span>;
}

function CountBadge({ n }: { n: number }) {
  return (
    <span className="px-2 py-0.5 rounded-full text-[10px] bg-slate-800/70 text-slate-200 border border-slate-700">
      {n}
    </span>
  );
}

/* icons + badges ---------------------------------------------------------- */
function Icon({ name, className = "" }: { name: string; className?: string }) {
  const cls = `w-4 h-4 ${className}`;
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;

  switch (name) {
    case "button":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...common}>
          <rect x="3" y="7.5" width="18" height="9" rx="4" />
          <circle cx="8" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="16" cy="12" r="1.6" />
        </svg>
      );
    case "text":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...common}>
          <path d="M4 6h16" />
          <path d="M9 6v12" />
          <path d="M4 12h10" />
          <path d="M4 18h14" />
        </svg>
      );
    case "heading":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...common}>
          <path d="M6 6v12" />
          <path d="M6 12h12" />
          <path d="M18 6v12" />
        </svg>
      );
    case "image":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="9" cy="10" r="2" />
          <path d="M3 17l5-5 3 3 3-3 7 7" />
        </svg>
      );
    case "list":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...common}>
          <path d="M9 7h11M9 12h11M9 17h11" />
          <circle cx="5" cy="7" r="1.4" />
          <circle cx="5" cy="12" r="1.4" />
          <circle cx="5" cy="17" r="1.4" />
        </svg>
      );
    case "link":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...common}>
          <path d="M10 14a4.5 4.5 0 0 1 0-6.4l1.8-1.8A4.5 4.5 0 1 1 19 12" />
          <path d="M14 10a4.5 4.5 0 0 1 0 6.4L12.2 18A4.5 4.5 0 1 1 5 12" />
        </svg>
      );
    case "input":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...common}>
          <rect x="3" y="7" width="18" height="10" rx="2" />
          <path d="M6 12h8" />
        </svg>
      );
    case "nav":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 9h18" />
          <circle cx="7" cy="7" r="1" />
          <circle cx="11" cy="7" r="1" />
          <circle cx="15" cy="7" r="1" />
        </svg>
      );
    case "section":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 8h10M7 12h6M7 16h8" />
        </svg>
      );
    case "gear":
      return (
        <svg viewBox="0 0 24 24" className={cls} {...common}>
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
          <path d="M19 12l1.5-1.5-1-2.5-2.5-1L16 5H8l-.5 1-2.5 1-1 2.5L5 12l-1.5 1.5 1 2.5 2.5 1 .5 1h8l.5-1 2.5-1 1-2.5Z" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" className={cls} {...common}>
          <rect x="4" y="6" width="16" height="12" rx="2" />
        </svg>
      );
  }
}
function iconForTag(tag: string): string {
  if (tag === "#text" || tag === "p" || tag === "span") return "text";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "a") return "link";
  if (tag === "img") return "image";
  if (["ul", "ol", "li"].includes(tag)) return "list";
  if (["button"].includes(tag)) return "button";
  if (["input", "textarea", "select"].includes(tag)) return "input";
  if (["nav"].includes(tag)) return "nav";
  if (["section", "header", "footer", "main", "article", "aside"].includes(tag)) return "section";
  return "section";
}
function NumberBadge({ n }: { n: number }) {
  return (
    <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-md bg-slate-800/80 text-slate-200 border border-slate-700 shadow-sm">
      {`#${n}`}
    </span>
  );
}

/* ------------------------------ */
/* Components panel rows          */
/* ------------------------------ */
function TreeNodeRow({
  node,
  level,
  onSelect,
  selectedPath,
  pathSoFar,
  indexMap,
  onHover,
  onUnhover,
}: {
  node: DomNode;
  level: number;
  onSelect: (n: DomNode, path: TreePath) => void;
  selectedPath: TreePath | null;
  pathSoFar: TreePath;
  indexMap: Map<string, number>;
  onHover: (path: TreePath) => void;
  onUnhover: () => void;
}) {
  const [open, setOpen] = useState(true);
  const isSelected = JSON.stringify(selectedPath) === JSON.stringify(pathSoFar);
  const seq = indexMap.get(JSON.stringify(pathSoFar)) ?? 0;
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;

  // Get component type icon
  const getComponentIcon = (tag: string) => {
    const iconMap: Record<string, string> = {
      'div': '📦',
      'span': '📄',
      'p': '📝',
      'h1': '🏷️',
      'h2': '🏷️',
      'h3': '🏷️',
      'h4': '🏷️',
      'h5': '🏷️',
      'h6': '🏷️',
      'button': '🔘',
      'input': '📝',
      'img': '🖼️',
      'a': '🔗',
      'ul': '📋',
      'ol': '🔢',
      'li': '•',
      'nav': '🧭',
      'header': '📋',
      'footer': '📋',
      'main': '🏠',
      'section': '📄',
      'article': '📰',
      'aside': '📄',
      'form': '📋',
      'label': '🏷️',
      'select': '📋',
      'textarea': '📝',
      'table': '📊',
      'tr': '➖',
      'td': '📄',
      'th': '📄',
    };
    return iconMap[tag.toLowerCase()] || '📄';
  };

  return (
    <div className="select-none">
      <div
        className={`group ${styles.treeNodeRow} ${isSelected ? styles.treeNodeRowSelected : styles.treeNodeRowDefault}`}
        style={{ paddingLeft: 12 + level * 16 }}
        onClick={() => onSelect(node, pathSoFar)}
        onMouseEnter={() => onHover(pathSoFar)}
        onMouseLeave={() => onUnhover()}
      >
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
            className={styles.treeNodeToggle}
            title={open ? "Collapse" : "Expand"}
          >
            <span className="text-xs font-bold">{open ? "▼" : "▶"}</span>
          </button>
        ) : (
          <span className="w-5 h-5" />
        )}

        <div className="flex items-center gap-2">
          <span className="text-lg">{getComponentIcon(node.tag)}</span>
          <span className="text-sm font-medium text-slate-200 font-mono tracking-wide">
            {node.tag === "#text" ? "Text" : node.tag.toUpperCase()}
          </span>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {node.attrs.id ? (
            <span className="px-2 py-1 rounded-md text-xs font-semibold bg-gradient-to-r from-indigo-500/20 to-indigo-600/20 
                             text-indigo-300 border border-indigo-500/30 shadow-sm">
              #{node.attrs.id}
            </span>
          ) : null}
          {node.tag === "#text" && node.text ? (
            <span className="text-xs text-slate-400 font-mono max-w-32 truncate">"{clamp(node.text, 20)}"</span>
          ) : null}
          <span className="px-2 py-1 rounded-md text-xs font-bold bg-gradient-to-r from-slate-600/80 to-slate-500/80 
                           text-slate-200 border border-slate-500/50 shadow-sm">
            #{seq}
          </span>
        </div>
      </div>

      {level === 0 && <div className="h-px mx-2 bg-slate-800/70" />}

      {open && hasChildren && node.children.map((c, idx) => (
        <TreeNodeRow
          key={idx}
          node={c}
          level={level + 1}
          onSelect={onSelect}
          selectedPath={selectedPath}
          pathSoFar={[...pathSoFar, idx]}
          indexMap={indexMap}
          onHover={onHover}
          onUnhover={onUnhover}
        />
      ))}
    </div>
  );
}

/* ------------------------------ */
/* Properties panel               */
/* ------------------------------ */
function KV({ label, value }: { label: string; value?: string }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-300 mb-2 flex items-center gap-2">
        <span className="text-slate-500">📋</span>
        {label}
      </div>
      <input
        readOnly
        value={value ?? ""}
        className="w-full rounded-lg bg-gradient-to-r from-slate-800/60 to-slate-700/60 border border-slate-600/50 
                   px-3 py-2 text-sm text-slate-100 font-mono shadow-sm transition-all duration-200
                   focus:border-purple-500/50 focus:ring-2 focus:ring-purple-500/20"
      />
    </div>
  );
}

function PropertiesPane({
  selected,
  onScrollIntoView,
}: {
  selected: DomNode | null;
  onScrollIntoView: () => void;
}) {
  const attrEntries = useMemo(() => {
    if (!selected || selected.tag === "#text") return [];
    return Object.entries(selected.attrs || {}).filter(([k]) => k !== "class");
  }, [selected]);

  const S = selected?.styles || {};

  const ColorRow = ({ label, cssName, hexName }: { label: string; cssName: keyof typeof S; hexName: keyof typeof S }) => {
    if (!S[cssName]) return null;
    return (
      <div className="mb-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-300 mb-2 flex items-center gap-2">
          <span className="text-slate-500">🎨</span>
          {label}
        </div>
        <div className="flex items-center gap-3">
          <ColorSwatch color={String(S[cssName])} />
          <input
            readOnly
            value={String(S[hexName] || S[cssName])}
            className="flex-1 rounded-lg bg-gradient-to-r from-slate-800/60 to-slate-700/60 border border-slate-600/50 
                       px-3 py-2 text-sm text-slate-100 font-mono shadow-sm transition-all duration-200
                       focus:border-purple-500/50 focus:ring-2 focus:ring-purple-500/20"
          />
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-0 flex flex-col">
      <div className="shrink-0 px-4 py-3 text-sm text-slate-100 border-b border-slate-700/50
                      bg-gradient-to-r from-slate-800/80 to-slate-700/70 backdrop-blur flex items-center gap-3">
        <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-purple-500 to-purple-600 flex items-center justify-center shadow-lg shadow-purple-500/25">
          <span className="text-white text-sm font-bold">⚙️</span>
        </div>
        <span className="tracking-wide font-semibold">Properties</span>
        <div className="flex-1" />
        <button
          onClick={onScrollIntoView}
          disabled={!selected}
          className={`text-xs px-3 py-1.5 rounded-lg border transition-all duration-200 shadow-sm ${
            selected
              ? "border-purple-500/50 text-slate-200 hover:bg-purple-500/10 hover:border-purple-400/70"
              : "border-slate-700 text-slate-500 cursor-not-allowed"
          }`}
          title="Scroll the selected element into view"
        >
          Scroll into view
        </button>
      </div>

      <div className={`min-h-0 flex-1 overflow-auto p-4 bg-gradient-to-b from-slate-800/20 to-slate-900/30 ${styles.propertiesScrollable}`}>
        {!selected ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyStateContent}>
              <div className={styles.emptyStateIcon}>🎯</div>
              <div className={styles.emptyStateTitle}>Select a component</div>
              <div className={styles.emptyStateSubtitle}>Choose from Components tab to view properties</div>
            </div>
          </div>
        ) : selected.tag === "#text" ? (
          <>
            <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">Text</div>
            <div className="rounded-lg border border-slate-700/70 bg-slate-900/70 p-3 text-slate-200 shadow-sm shadow-[inset_0_0_0_1px_rgba(148,163,184,.08)]">
              {selected.text}
            </div>
          </>
        ) : (
          <>
            <div className="text-xs uppercase tracking-wide text-slate-400 mb-2">{selected.tag}</div>

            {selected.attrs.id ? <KV label="Id" value={selected.attrs.id} /> : null}
            {selected.attrs["aria-label"] ? <KV label="Aria Label" value={selected.attrs["aria-label"]} /> : null}

            <ColorRow label="Color" cssName={"color"} hexName={"color-hex"} />
            <ColorRow label="Background Color" cssName={"background-color"} hexName={"background-hex"} />

            <div className="mb-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-300 mb-2 flex items-center gap-2">
                <span className="text-slate-500">👁️</span>
                Text Preview
              </div>
              <div
                className={styles.textPreviewContainer}
                style={{
                  fontFamily: S["font-family"],
                  fontSize: S["font-size"],
                  fontWeight: S["font-weight"] as any,
                  lineHeight: S["line-height"],
                  letterSpacing: S["letter-spacing"],
                }}
              >
                The quick brown fox jumps over the lazy dog.
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-4">
              <KV label="Display" value={S["display"]} />
              <KV label="Position" value={S["position"]} />
              <KV label="Width" value={S["width"]} />
              <KV label="Height" value={S["height"]} />
              <KV label="Margin" value={S["margin"]} />
              <KV label="Padding" value={S["padding"]} />
              <KV label="Border" value={S["border"]} />
              <KV label="Border Radius" value={S["border-radius"]} />
              <KV label="Box Shadow" value={S["box-shadow"]} />
              <KV label="Opacity" value={S["opacity"]} />
              <KV label="Gap" value={S["gap"]} />
              <KV label="Flex" value={S["flex"]} />
              <KV label="Justify Content" value={S["justify-content"]} />
              <KV label="Align Items" value={S["align-items"]} />
              <KV label="Grid Columns" value={S["grid-template-columns"]} />
              <KV label="Grid Rows" value={S["grid-template-rows"]} />
            </div>

            {attrEntries.length > 0 && (
              <>
                <div className="text-[11px] uppercase tracking-wide text-slate-400 mt-5 mb-2">Attributes</div>
                {attrEntries.map(([k, v]) => (
                  <KV key={k} label={k} value={String(v)} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ */
/* Components panel container     */
/* ------------------------------ */
/* ------------------------------ */
/* Syntax Highlighting Component  */
/* ------------------------------ */
function SyntaxHighlighter({ code, language }: { code: string; language: string }) {
  const [highlightedCode, setHighlightedCode] = useState("");

  function heuristicPrettyPrint(src: string, lang: string): string {
    // If the file has no line breaks, try to add some sensible ones for JSX/TSX/JS/CSS/JSON
    if (src.indexOf("\n") !== -1) return src;
    let out = src;
    // Add breaks between adjacent tags
    out = out.replace(/><(?!\s*\/)/g, ">\n<");
    // Add breaks after closing tags before next tokens
    out = out.replace(/>(\s*)<\//g, ">\n</");
    // Add breaks after semicolons
    out = out.replace(/;\s*(?=\S)/g, ";\n");
    // Add breaks around braces/parens commonly found in TSX/JS
    out = out.replace(/\{\s*(?=\S)/g, "{\n");
    out = out.replace(/\}\s*(?=\S)/g, "}\n");
    out = out.replace(/\)\s*\{/g, ")\n{");
    out = out.replace(/\)\s*(?=\S)/g, ")\n");
    // Compress multiple blank lines
    out = out.replace(/\n{3,}/g, "\n\n");
    return out;
  }

  function addIndentation(src: string): string {
    const lines = src.split("\n");
    let depth = 0;
    const INDENT = "  ";
    const selfClosing = /\/>\s*$/;
    const openTag = /^<(?!(?:\/|!|meta|link|img|br|hr|input|source|area|base|col|embed|param|track))/i;
    const closeTagStart = /^<\//;
    const openBrace = /\{(?![^"'`]*["'`])/g; // rough: count "{" not inside quotes
    const closeBraceStart = /^\}/;

    const out: string[] = [];
    for (let raw of lines) {
      const line = raw.trim();
      if (line.length === 0) { out.push(""); continue; }

      const preOutdent = closeTagStart.test(line) || closeBraceStart.test(line) || /^\)|^\]|^;\s*$/.test(line);
      if (preOutdent) depth = Math.max(0, depth - 1);

      out.push(INDENT.repeat(depth) + line);

      // Increase after printing for openers that clearly start a block
      const isOpeningTag = openTag.test(line) && !selfClosing.test(line) && !/<'?\w[^>]*><\//.test(line);
      if (isOpeningTag) depth += 1;

      const hasOpenBrace = (line.match(openBrace) || []).length;
      const hasCloseBrace = (line.match(/\}/g) || []).length;
      if (hasOpenBrace > hasCloseBrace) depth += (hasOpenBrace - hasCloseBrace);
      if (hasCloseBrace > hasOpenBrace && !preOutdent) depth = Math.max(0, depth - (hasCloseBrace - hasOpenBrace));
    }
    return out.join("\n");
  }

  useEffect(() => {
    // Normalize newlines to ensure proper formatting in <pre>
    const normalized = (code || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let cancelled = false;
    (async () => {
      let toHighlight = addIndentation(heuristicPrettyPrint(normalized, language));
      try {
        // Try Prettier for true formatting
        // @ts-ignore - Prettier runtime-only imports; types not required client-side
        const prettier = await import("prettier/standalone");
        // @ts-ignore - Plugin paths are part of Prettier's package; ignore TS resolution
        const [tsPlugin, babelPlugin, postcssPlugin, markdownPlugin, htmlPlugin] = await Promise.all([
          // @ts-ignore
          import("prettier/plugins/typescript"),
          // @ts-ignore
          import("prettier/plugins/babel"),
          // @ts-ignore
          import("prettier/plugins/postcss"),
          // @ts-ignore
          import("prettier/plugins/markdown"),
          // @ts-ignore
          import("prettier/plugins/html"),
        ]);
        const parserMap: Record<string, string> = {
          tsx: "typescript",
          typescript: "typescript",
          jsx: "babel",
          javascript: "babel",
          css: "css",
          scss: "scss",
          json: "json",
          markdown: "markdown",
          html: "html",
          md: "markdown",
          mdx: "markdown",
        };
        const parser = parserMap[language] || "babel";
        const formatted = await prettier.format(normalized, {
          parser,
          plugins: [tsPlugin, babelPlugin, postcssPlugin, markdownPlugin, htmlPlugin],
          semi: true,
          singleQuote: false,
          trailingComma: "es5",
          tabWidth: 2,
          useTabs: false,
          bracketSpacing: true,
          jsxSingleQuote: false,
        });
        toHighlight = formatted.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      } catch (e) {
        // Fallback to heuristic pretty print only
        console.warn("Prettier format failed, falling back:", e);
      }

      try {
        if (!cancelled) {
          const highlighted = Prism.highlight(toHighlight, Prism.languages[language] || Prism.languages.text, language);
          setHighlightedCode(highlighted);
        }
      } catch (error) {
        console.warn("Syntax highlighting failed:", error);
        if (!cancelled) setHighlightedCode(toHighlight);
      }
    })();

    return () => { cancelled = true; };
  }, [code, language]);

  return (
    <pre className={`p-4 text-sm text-slate-200 overflow-auto h-full font-mono whitespace-pre ${styles.codePre}`}>
      <code 
        className={`language-${language}`}
        dangerouslySetInnerHTML={{ __html: highlightedCode }}
      />
    </pre>
  );
}

function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    'tsx': 'tsx',
    'ts': 'typescript',
    'jsx': 'jsx',
    'js': 'javascript',
    'css': 'css',
    'scss': 'css',
    'json': 'json',
    'md': 'markdown',
    'mdx': 'markdown',
  };
  return languageMap[ext || ''] || 'text';
}

function ComponentsFromPreview({
  iframeRef,
  reloadKey,
  onSelect,
  selectedPath,
  onHoverPath,
  onUnhoverPath,
}: {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  reloadKey: number;
  onSelect: (n: DomNode, path: TreePath) => void;
  selectedPath: TreePath | null;
  onHoverPath: (p: TreePath) => void;
  onUnhoverPath: () => void;
}) {
  const [root, setRoot] = useState<DomNode | null>(null);

  const analyze = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const tree = crawlDom(doc, { maxDepth: 12, maxNodes: 2000 });
    setRoot(tree);
  };

  useEffect(() => {
    const onLoad = () => analyze();
    const f = iframeRef.current;
    if (f) f.addEventListener("load", onLoad);
    analyze(); // first pass
    return () => { if (f) f.removeEventListener("load", onLoad); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iframeRef, reloadKey]);

  const indexMap = useMemo(() => {
    const map = new Map<string, number>();
    let n = 1;
    function visit(node: DomNode, path: number[]) {
      map.set(JSON.stringify(path), n++);
      node.children?.forEach((c, i) => visit(c, [...path, i]));
    }
    root?.children?.forEach((c, i) => visit(c, [i]));
    return map;
  }, [root]);

  const total = useMemo(() => {
    let ct = 0;
    function count(node: DomNode) { ct++; node.children?.forEach(count); }
    root?.children?.forEach(count);
    return ct;
  }, [root]);

  return (
    <div className="min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center justify-between px-4 py-3 text-sm text-slate-100 border-b border-slate-700/50
                      bg-gradient-to-r from-slate-800/80 to-slate-700/70 backdrop-blur">
        <div className="inline-flex items-center gap-3">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-500/25">
            <span className="text-white text-sm font-bold">🧩</span>
          </div>
          <span className="tracking-wide font-semibold">Components</span>
        </div>
        <div className="bg-gradient-to-r from-emerald-500/20 to-emerald-600/20 border border-emerald-500/30 rounded-lg px-3 py-1">
          <CountBadge n={total || 0} />
        </div>
      </div>

      <div className={`min-h-0 flex-1 overflow-auto p-3 bg-gradient-to-b from-slate-800/20 to-slate-900/30 ${styles.componentsScrollable}`}>
        {!root ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyStateContent}>
              <div className={styles.emptyStateIcon}>⏳</div>
              <div className={styles.emptyStateTitle}>Loading components...</div>
            </div>
          </div>
        ) : (root.children || []).length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyStateContent}>
              <div className={styles.emptyStateIcon}>🔍</div>
              <div className={styles.emptyStateTitle}>No components found</div>
              <div className={styles.emptyStateSubtitle}>Try refreshing the preview</div>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {(root.children || []).map((n, i) => (
              <TreeNodeRow
                key={i}
                node={n}
                level={0}
                onSelect={onSelect}
                selectedPath={selectedPath}
                pathSoFar={[i]}
                indexMap={indexMap}
                onHover={onHoverPath}
                onUnhover={onUnhoverPath}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ */
/* NEW: File Explorer (panel)     */
/* ------------------------------ */

function FileIcon({ kind, className="" }: { kind: "dir" | "file"; className?: string }) {
  const cls = `w-4 h-4 ${className}`;
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return kind === "dir" ? (
    <svg viewBox="0 0 24 24" className={cls} {...common}>
      <path d="M3 7h6l2 2h10v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M3 7V6a2 2 0 0 1 2-2h5l2 2" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className={cls} {...common}>
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
      <path d="M14 2v7h7" />
    </svg>
  );
}

function LangBadge({ path }: { path: string }) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  const map: Record<string,string> = { 
    tsx:"TSX", ts:"TS", js:"JS", jsx:"JSX", css:"CSS", scss:"SCSS", 
    md:"MD", mdx:"MDX", json:"JSON", html:"HTML", svg:"SVG" 
  };
  return (
    <span className="px-2 py-1 rounded-md text-xs font-semibold bg-gradient-to-r from-slate-700/80 to-slate-600/80 
                     text-slate-200 border border-slate-600/50 shadow-sm">
      {map[ext] || ext || "FILE"}
    </span>
  );
}

function FileTreeRow({
  node, level, onPick, selectedPath,
}: {
  node: FileNode;
  level: number;
  onPick: (n: FileNode) => void;
  selectedPath: string | null;
}) {
  const [open, setOpen] = useState(true);
  const isDir = node.type === "dir";
  const isSelected = selectedPath === node.path;

  // Get file type icon
  const getFileIcon = (path: string) => {
    const ext = path.split('.').pop()?.toLowerCase();
    const iconMap: Record<string, string> = {
      'tsx': '⚛️',
      'ts': '📘',
      'jsx': '⚛️',
      'js': '📜',
      'css': '🎨',
      'scss': '🎨',
      'json': '📋',
      'md': '📝',
      'mdx': '📝',
      'html': '🌐',
      'svg': '🖼️',
    };
    return iconMap[ext || ''] || '📄';
  };

  return (
    <div className="select-none">
      <div
        className={`group ${styles.fileTreeRow} ${isSelected ? styles.fileTreeRowSelected : styles.fileTreeRowDefault}`}
        style={{ paddingLeft: 12 + level * 16 }}
        onClick={() => (isDir ? setOpen((o) => !o) : onPick(node))}
      >
        {isDir ? (
          <button
            onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
            className={styles.treeNodeToggle}
            title={open ? "Collapse" : "Expand"}
          >
            <span className="text-xs font-bold">{open ? "▼" : "▶"}</span>
          </button>
        ) : (
          <span className="w-5 h-5" />
        )}

        <div className="flex items-center gap-2">
          <span className="text-lg">{isDir ? "📁" : getFileIcon(node.path)}</span>
          <span className="text-sm font-medium text-slate-200 font-mono tracking-wide">{node.name}</span>
        </div>
        
        {node.type === "file" ? (
          <div className="ml-auto">
            <LangBadge path={node.path} />
          </div>
        ) : null}
      </div>

      {open && node.children?.map((c) => (
        <FileTreeRow key={c.path} node={c} level={level + 1} onPick={onPick} selectedPath={selectedPath} />
      ))}
    </div>
  );
}

function FileTreePanel({
  tree,
  onSelectFile,
  selectedFile,
}: {
  tree: FileNode[];
  onSelectFile: (f: FileNode) => void;
  selectedFile: string | null;
}) {
  const totalFiles = useMemo(() => {
    let n = 0;
    const walk = (nodes: FileNode[]) => {
      for (const x of nodes) {
        if (x.type === "file") n++;
        if (x.children) walk(x.children);
      }
    };
    walk(tree || []);
    return n;
  }, [tree]);

  return (
    <div className="min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center justify-between px-4 py-3 text-sm text-slate-100 border-b border-slate-700/50
                      bg-gradient-to-r from-slate-800/80 to-slate-700/70 backdrop-blur">
        <div className="inline-flex items-center gap-3">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
            <span className="text-white text-sm font-bold">📁</span>
          </div>
          <span className="tracking-wide font-semibold">Files</span>
        </div>
        <div className="bg-gradient-to-r from-blue-500/20 to-blue-600/20 border border-blue-500/30 rounded-lg px-3 py-1">
          <CountBadge n={totalFiles} />
        </div>
      </div>

      <div className={`min-h-0 flex-1 overflow-auto p-3 bg-gradient-to-b from-slate-800/20 to-slate-900/30 ${styles.fileTreeScrollable}`}>
        {tree.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyStateContent}>
              <div className={styles.emptyStateIcon}>📂</div>
              <div className={styles.emptyStateTitle}>No files found</div>
              <div className={styles.emptyStateSubtitle}>Files will appear here</div>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {tree.map((n) => (
              <FileTreeRow key={n.path} node={n} level={0} onPick={onSelectFile} selectedPath={selectedFile} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ */
/* NEW: Code window               */
/* ------------------------------ */
function CodeWindow({
  filePath,
  content,
  onRefresh,
}: {
  filePath: string | null;
  content: string | null;
  onRefresh: () => void;
}) {
  const withLineNumbers = useMemo(() => {
    if (!content) return "";
    return content
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(4, " ")}  ${line}`)
      .join("\n");
  }, [content]);

  return (
    <div className="min-h-0 rounded-2xl border border-slate-800 bg-slate-900/40 backdrop-blur shadow-xl overflow-hidden">
      <div className="shrink-0 px-4 py-2 text-slate-300 text-sm border-b border-white/5
                      bg-[linear-gradient(180deg,rgba(20,20,28,.7),rgba(10,10,14,.6))] flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 inline-block" />
        <span>Code</span>
        <span className="text-xs opacity-70 ml-2">{filePath || "No file selected"}</span>
        <div className="flex-1" />
        <button
          onClick={onRefresh}
          disabled={!filePath}
          className={`text-xs px-2 py-1 rounded-md border transition shadow-sm ${
            filePath
              ? "border-slate-700 text-slate-200 hover:bg-slate-800/60"
              : "border-slate-800 text-slate-600 cursor-not-allowed"
          }`}
        >
          Reload
        </button>
      </div>
      <div className="min-h-0 h-full overflow-auto">
        {!filePath ? (
          <div className="p-4 text-sm text-slate-400">Pick a file from the Files panel to view code.</div>
        ) : content == null ? (
          <div className="p-4 text-sm text-slate-400">Loading…</div>
        ) : (
          <pre className="p-4 m-0 text-sm leading-6 bg-slate-950 text-slate-100 font-mono">
            {withLineNumbers}
          </pre>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ */
/* Page layout + preview highlight */
/* ------------------------------ */
export default function ChatPage() {
  // Avoid recursion if /chat shown inside the preview
  const [inIframe, setInIframe] = useState(false);
  useEffect(() => {
    try { setInIframe(typeof window !== "undefined" && window.self !== window.top); }
    catch { setInIframe(true); }
  }, []);
  if (inIframe) {
    return (
      <div className="h-screen grid place-items-center bg-slate-950 text-slate-300">
        <div className="text-xs opacity-70">Chat hidden inside Preview to avoid recursion.</div>
      </div>
    );
  }

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<ChatItem[]>([
    { role: "system", content: "Welcome! Ask me to create or modify pages, components, or styles." },
  ]);

  const [previewPath, setPreviewPath] = useState<string>("/");
  const [serverMs, setServerMs] = useState<number | undefined>(undefined);
  const [mounted, setMounted] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  const [selectedNode, setSelectedNode] = useState<DomNode | null>(null);
  const [selectedPath, setSelectedPath] = useState<TreePath | null>(null);

  // NEW: file explorer state
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<"components" | "files">("components");
  const [centerTab, setCenterTab] = useState<"preview" | "code">("preview");
  const fileFetchAbortRef = useRef<AbortController | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLIFrameElement>(null);
  const sessionId = useSessionId();

  useEffect(() => setMounted(true), []);
  useEffect(() => { scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages]);

  // Load/update preview src (and keep it off /chat)
  useEffect(() => {
    if (!previewRef.current) return;
    const safe = sanitizePreviewPath(previewPath);
    const url = new URL(safe, window.location.origin);
    url.searchParams.set("_", String(Date.now()));
    previewRef.current.src = url.pathname + url.search;

    const kickOutOfChat = () => {
      const win = previewRef.current?.contentWindow;
      if (!win) return;
      try {
        const p = win.location?.pathname || "/";
        if (p === "/chat" || p.startsWith("/chat/")) {
          const u = new URL("/", window.location.origin);
          u.searchParams.set("_", String(Date.now()));
          win.location.replace(u.pathname + u.search);
        }
      } catch {}
    };
    const onLoad = () => kickOutOfChat();
    previewRef.current.addEventListener("load", onLoad);
    const id = window.setInterval(kickOutOfChat, 500);
    const stopId = window.setTimeout(() => window.clearInterval(id), 10_000);
    return () => {
      previewRef.current?.removeEventListener("load", onLoad);
      window.clearInterval(id);
      window.clearTimeout(stopId);
    };
  }, [previewPath, reloadTick]);

  /* ---- Highlight helpers bound to this page ---- */
  const highlightByPath = (path: TreePath, kind: "selected" | "hover") => {
    const doc = previewRef.current?.contentDocument;
    if (!doc) return;
    const n = nodeFromPath(doc, path);
    if (!n) return;

    const rect = rectOfNode(n);
    if (!rect || rect.width === 0 || rect.height === 0) return;

    const id = kind === "selected" ? "__agent_sel" : "__agent_hover";
    const color = kind === "selected" ? "#60a5fa" /* blue-400 */ : "#a78bfa" /* violet-400 */;
    const box = ensureOverlay(doc, id, color);
    positionOverlay(box, rect);
  };

  const clearHover = () => {
    const doc = previewRef.current?.contentDocument;
    if (!doc) return;
    hideOverlay(doc, "__agent_hover");
  };

  const clearSelected = () => {
    const doc = previewRef.current?.contentDocument;
    if (!doc) return;
    hideOverlay(doc, "__agent_sel");
  };

  // Update selection highlight whenever selectedPath changes
  useEffect(() => {
    clearSelected();
    if (selectedPath) highlightByPath(selectedPath, "selected");
  }, [selectedPath, reloadTick]);

  // Scroll into view (from Properties)
  const scrollSelectedIntoView = () => {
    const doc = previewRef.current?.contentDocument;
    if (!doc || !selectedPath) return;
    const n = nodeFromPath(doc, selectedPath);
    if (!n) return;
    const el = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : (n.parentElement as Element | null);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => selectedPath && highlightByPath(selectedPath, "selected"), 300);
  };

  /* ---- Files API helpers ---- */
  async function refreshFileTree() {
    try {
      const r = await fetch("/api/files?op=list");
      const j = await r.json();
      if (j?.ok && Array.isArray(j.tree)) {
        setFileTree(j.tree);
      } else {
        console.error("files:list failed", j);
        setFileTree([]); // ensures panel shows 'No files found' but we also have a console hint
      }
    } catch (err) {
      console.error("files:list error", err);
      setFileTree([]);
    }
  }

  async function openFileByPath(relPath: string, skipLoadingState = false) {
    // Cancel any ongoing file fetch
    if (fileFetchAbortRef.current) {
      fileFetchAbortRef.current.abort();
    }

    // Create new abort controller for this request
    const abortController = new AbortController();
    fileFetchAbortRef.current = abortController;

    if (!skipLoadingState) {
      setFileContent(null);
      setFileLoading(true);
    }

    const url = `/api/files?op=read&path=${encodeURIComponent(relPath)}`;
    
    try {
      const r = await fetch(url, {
        signal: abortController.signal,
      });
      
      // Check if request was aborted
      if (abortController.signal.aborted) {
        return;
      }

      // Check HTTP status before parsing JSON
      if (!r.ok) {
        let errorMsg = `HTTP ${r.status}: ${r.statusText}`;
        try {
          const errorJson = await r.json();
          errorMsg = errorJson?.error || errorMsg;
        } catch {
          // JSON parse failed, use status text
        }
        if (!abortController.signal.aborted) {
          console.error(`Failed to load file "${relPath}":`, errorMsg);
          setFileContent(`⚠️ Error loading file: ${errorMsg}\n\nPath: ${relPath}`);
          setFileLoading(false);
        }
        return;
      }

      const j = await r.json().catch((parseError) => {
        if (!abortController.signal.aborted) {
          console.error(`Failed to parse response for "${relPath}":`, parseError);
          throw parseError;
        }
        return null;
      });
      
      if (!j) return; // Aborted during JSON parse
      
      if (abortController.signal.aborted) {
        return;
      }

      if (j?.ok) {
        setFileContent(j.content || "");
      } else {
        const errorMsg = j?.error || "Unknown error";
        console.error(`API returned error for "${relPath}":`, errorMsg);
        setFileContent(`⚠️ ${errorMsg}\n\nPath: ${relPath}`);
      }
    } catch (e: any) {
      // Don't set error if request was aborted (another request is in progress)
      if (e?.name === "AbortError" || abortController.signal.aborted) {
        return;
      }
      const errorMsg = e?.message || "Failed to load file";
      console.error(`Exception loading file "${relPath}":`, e);
      setFileContent(`⚠️ ${errorMsg}\n\nPath: ${relPath}`);
    } finally {
      if (!abortController.signal.aborted) {
        setFileLoading(false);
      }
    }
  }

  // Guess route file from preview path, e.g. "/" -> app/page.tsx, "/about" -> app/about/page.tsx
  function guessRouteFile(pathname: string): string[] {
    const p = sanitizePreviewPath(pathname);
    const base = p === "/" ? "app/page" : `app${p.replace(/\/$/, "")}/page`;
    // Try common extensions in order:
    return [`${base}.tsx`, `${base}.mdx`, `${base}.jsx`, `${base}.ts`, `${base}.js`];
  }

  // Try to auto-open route file if nothing selected
  async function ensureRouteFileOpen() {
    if (selectedFile) return; // user already picked something
    const candidates = guessRouteFile(previewPath);
    for (const rel of candidates) {
      try {
        const res = await fetch(`/api/files?op=read&path=${encodeURIComponent(rel)}`);
        const j = await res.json();
        if (j?.ok) {
          setSelectedFile({ name: rel.split("/").pop() || rel, path: rel, type: "file" });
          setFileContent(j.content || "");
          return;
        }
      } catch {}
    }
  }

  // initial load + after Bedrock changes
  useEffect(() => { refreshFileTree(); }, []);
  useEffect(() => {
    refreshFileTree();
    // If a file is already selected, reload it; otherwise try to open the route file
    // Use skipLoadingState to avoid resetting loading state when user manually selected a file
    if (selectedFile) {
      openFileByPath(selectedFile.path, true);
    } else {
      ensureRouteFileOpen();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTick, previewPath]);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (fileFetchAbortRef.current) {
        fileFetchAbortRef.current.abort();
      }
    };
  }, []);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text, ts: Date.now() }]);
    setBusy(true);

    const ac = new AbortController();
    const clientTimeout = setTimeout(() => ac.abort(), 35000);

    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, sessionId }),
        signal: ac.signal,
      });
      clearTimeout(clientTimeout);

      const j: ChatResult = await r.json().catch(() => ({} as any));

      if (!r.ok || j.error) {
        const msg = j?.error || `Request failed (${r.status})`;
        setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${msg}`, meta: { error: true }, ts: Date.now() }]);
      } else {
        const resp = j.assistant || "Change applied.";
        setMessages((m) => [...m, { role: "assistant", content: resp, ts: Date.now() }]);
        setPreviewPath(sanitizePreviewPath(j.previewPath || "/"));
        setReloadTick((n) => n + 1);
        if (j.serverMs != null) setServerMs(j.serverMs);
        setSelectedNode(null);
        setSelectedPath(null);
        clearHover();
        clearSelected();
      }
    } catch (e: any) {
      const msg = e?.name === "AbortError" ? "Client-side timeout" : (e?.message || "Request failed");
      setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${msg}`, meta: { error: true }, ts: Date.now() }]);
    } finally {
      setBusy(false);
    }
  }

  const canSend = useMemo(() => input.trim().length > 0 && !busy, [input, busy]);

  const handleSelect = (n: DomNode, p: TreePath) => {
    setSelectedNode(n);
    setSelectedPath(p);
    highlightByPath(p, "selected");
  };
  const handleHoverPath = (p: TreePath) => highlightByPath(p, "hover");
  const handleUnhoverPath = () => clearHover();

  return (
    <div className="h-screen overflow-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      {/* 3 columns + footer. Left: Components/Files tabs + Chat | Center: Preview | Right: Properties */}
      <div className={`h-full grid ${styles.mainGrid}`}>
        {/* Left: Components/Files tabs */}
        <div className="min-h-0 flex flex-col rounded-2xl border border-slate-700/50 bg-gradient-to-b from-slate-900/80 to-slate-800/60 shadow-2xl backdrop-blur-sm overflow-hidden">
          {/* Tab Navigation */}
          <div className="shrink-0 border-b border-slate-700/50 bg-gradient-to-r from-slate-800/90 to-slate-700/80 backdrop-blur px-4 py-3">
            <div className={styles.tabContainer}>
              <button
                onClick={() => setActiveTab("components")}
                className={`${styles.tab} ${activeTab === "components" ? styles.tabActiveEmerald : styles.tabInactive}`}
              >
                <span className="flex items-center gap-2">
                  <span className="text-emerald-400">🧩</span>
                  Components
                </span>
              </button>
              <button
                onClick={() => setActiveTab("files")}
                className={`${styles.tab} ${activeTab === "files" ? styles.tabActiveEmerald : styles.tabInactive}`}
              >
                <span className="flex items-center gap-2">
                  <span className="text-blue-400">📁</span>
                  Files
                </span>
              </button>
            </div>
          </div>

          {/* Tab Content - Fixed Height with Scroll */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {activeTab === "components" ? (
              <ComponentsFromPreview
                iframeRef={previewRef}
                reloadKey={reloadTick}
                onSelect={handleSelect}
                selectedPath={selectedPath}
                onHoverPath={handleHoverPath}
                onUnhoverPath={handleUnhoverPath}
              />
            ) : (
              <FileTreePanel
                tree={fileTree}
                selectedFile={selectedFile?.path ?? null}
                onSelectFile={(f) => {
                  setSelectedFile(f);
                  setFileContent(null); // Clear content immediately when new file selected
                  openFileByPath(f.path, false); // Start loading with loading state
                  setCenterTab("code"); // Switch to code tab when file is selected
                }}
              />
            )}
          </div>
        </div>

        {/* Center: Preview/Code tabs */}
        <div className="min-h-0 rounded-2xl border border-slate-700/50 bg-gradient-to-b from-slate-900/80 to-slate-800/60 shadow-2xl backdrop-blur-sm overflow-hidden flex flex-col">
          {/* Tab Navigation */}
          <div className="shrink-0 border-b border-slate-700/50 bg-gradient-to-r from-slate-800/90 to-slate-700/80 backdrop-blur px-4 py-3">
            <div className={styles.tabContainer}>
              <button
                onClick={() => setCenterTab("preview")}
                className={`${styles.tab} ${centerTab === "preview" ? styles.tabActive : styles.tabInactive}`}
              >
                <span className="flex items-center gap-2">
                  <span className="text-blue-400">👁️</span>
                  Preview
                </span>
              </button>
              <button
                onClick={() => setCenterTab("code")}
                className={`${styles.tab} ${centerTab === "code" ? styles.tabActive : styles.tabInactive}`}
              >
                <span className="flex items-center gap-2">
                  <span className="text-cyan-400">💻</span>
                  Code
                </span>
              </button>
            </div>
          </div>

          {/* Tab Content (keep iframe mounted always to power Components panel) */}
          <div className="min-h-0 h-full overflow-hidden relative">
            {/* Preview iframe (always mounted) */}
            <div className={`${centerTab === "preview" ? "block" : "hidden"} h-full`}>
              <iframe ref={previewRef} title="Preview" src="/" className="w-full h-full bg-black rounded-none" />
            </div>

            {/* Code view (mounted alongside) */}
            <div className={`${centerTab === "code" ? "flex" : "hidden"} h-full flex-col`}>
              {selectedFile ? (
                <div className="h-full flex flex-col">
                  <div className="shrink-0 px-4 py-3 text-slate-200 text-sm border-b border-slate-700/50 bg-gradient-to-r from-slate-800/60 to-slate-700/50 flex items-center justify-between">
                    <span className="font-medium">{selectedFile.path}</span>
                    <span className="text-xs text-slate-400 bg-slate-700/50 px-2 py-1 rounded-md border border-slate-600/50">
                      {getLanguageFromPath(selectedFile.path)}
                    </span>
                  </div>
                  <div className={`flex-1 overflow-auto bg-slate-950/50 ${styles.codeScrollable}`}>
                    {fileLoading && fileContent === null ? (
                      <div className={styles.emptyState}>
                        <div className={styles.emptyStateContent}>
                          <div className={styles.emptyStateIcon}>⏳</div>
                          <div className={styles.emptyStateTitle}>Loading...</div>
                        </div>
                      </div>
                    ) : (
                      <SyntaxHighlighter
                        code={fileContent || ""}
                        language={getLanguageFromPath(selectedFile.path)}
                      />
                    )}
                  </div>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-slate-400 bg-gradient-to-br from-slate-800/30 to-slate-900/50">
                  <div className="text-center">
                    <div className="text-4xl mb-4 opacity-60">📄</div>
                    <div className="text-lg font-medium">Select a file to view its code</div>
                    <div className="text-sm mt-2 opacity-70">Choose from the Files tab to see syntax-highlighted code</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right: Properties */}
        <div className="min-h-0 rounded-2xl border border-slate-700/50 bg-gradient-to-b from-slate-900/80 to-slate-800/60 shadow-2xl backdrop-blur-sm overflow-hidden flex flex-col">
          <PropertiesPane selected={selectedNode} onScrollIntoView={scrollSelectedIntoView} />
        </div>

        {/* Footer row: Chat (left) and Trace (right) */}
        <div className="rounded-2xl border border-slate-700/50 bg-gradient-to-r from-slate-900/90 to-slate-800/80 shadow-2xl backdrop-blur-sm overflow-hidden">
          {/* Chat Panel - Bottom Left */}
          <div className="h-full flex flex-col">
            <div className="px-4 py-3 border-b border-slate-700/30 bg-gradient-to-r from-slate-800/60 to-slate-700/50">
              <div className="font-semibold text-sm text-slate-200 flex items-center gap-2">
                <span className="text-purple-400">💬</span>
                Chat
              </div>
            </div>
            <div className="flex-1 p-4 min-h-0 flex flex-col">
              <div className={`space-y-2 flex-1 min-h-0 overflow-auto ${styles.chatScrollable}`}>
                {messages.map((m, i) => (
                  <ChatBubble key={i} role={m.role} content={m.content} meta={m.meta} ts={m.ts} />
                ))}
                <div ref={scrollRef} />
              </div>
              <div className="flex items-center gap-3 mt-3">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && canSend && send()}
                  placeholder={busy ? "Working…" : "Type..."}
                  className={styles.chatInput}
                />
                <button
                  onClick={send}
                  disabled={!canSend}
                  className={`rounded-xl px-4 py-2 text-sm font-medium transition-all duration-200 ${
                    canSend
                      ? "bg-gradient-to-r from-purple-500 to-purple-600 hover:from-purple-400 hover:to-purple-500 text-white shadow-lg shadow-purple-500/25 hover:shadow-purple-500/40"
                      : "bg-slate-800 text-slate-500 cursor-not-allowed"
                  }`}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="col-span-2 rounded-2xl border border-slate-700/50 bg-gradient-to-r from-slate-900/90 to-slate-800/80 shadow-2xl backdrop-blur-sm overflow-hidden">
          <TraceConsole sessionId={sessionId} />
        </div>
      </div>
    </div>
  );
}
