// web/app/api/files/route.ts
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

/**
 * Find the real Next.js app root (the folder that contains /app).
 * Works if you run `npm run dev` in repo root or inside /web.
 */
function resolveAppRoot(): string {
  const cwd = process.cwd();

  // If current working dir already has /app, use it (e.g. running inside /web).
  if (fs.existsSync(path.join(cwd, "app"))) return cwd;

  // Common monorepo layout: repo root -> /web contains app/
  const webCandidate = path.join(cwd, "web");
  if (fs.existsSync(path.join(webCandidate, "app"))) return webCandidate;

  // Try walking up a couple of levels just in case
  let cur = cwd;
  for (let i = 0; i < 3; i++) {
    const up = path.dirname(cur);
    if (up === cur) break;
    if (fs.existsSync(path.join(up, "app"))) return up;
    const upWeb = path.join(up, "web");
    if (fs.existsSync(path.join(upWeb, "app"))) return upWeb;
    cur = up;
  }

  // Fallback to cwd (will yield empty tree instead of crashing)
  return cwd;
}

const APP_ROOT = resolveAppRoot();

/** Which top-level dirs we expose in the tree (relative to APP_ROOT) */
const ALLOWED_TOP = new Set(["app", "components", "lib", "styles"]);

/** Ignore junk/system/build folders and dotfiles (except .env.local if you later want it) */
function shouldIgnore(rel: string, abs: string): boolean {
  const bn = path.basename(abs);
  if (
    bn === "node_modules" ||
    bn === ".next" ||
    bn === ".git" ||
    bn === ".turbo" ||
    bn === ".vercel"
  ) return true;

  // Skip hidden files/dirs (starting with .), except allow .gitignore if you want
  if (bn.startsWith(".")) return true;

  // Skip api and chat folders
  if (bn === "api" || bn === "chat") return true;

  // Never serve binaries or large assets here
  const ext = path.extname(bn).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".pdf", ".mp4", ".mp3"].includes(ext)) {
    return true;
  }
  return false;
}

type FileNode = {
  name: string;
  path: string; // relative to APP_ROOT
  type: "file" | "dir";
  mtime?: number;
  size?: number;
  children?: FileNode[];
};

function statSafe(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

function readDirSafe(p: string): string[] {
  try { return fs.readdirSync(p); } catch { return []; }
}

function walkDir(absDir: string, relDir: string): FileNode[] {
  const out: FileNode[] = [];
  for (const name of readDirSafe(absDir)) {
    const abs = path.join(absDir, name);
    const rel = path.join(relDir, name);
    if (shouldIgnore(rel, abs)) continue;
    const st = statSafe(abs);
    if (!st) continue;

    if (st.isDirectory()) {
      const children = walkDir(abs, rel);
      // Only include dirs that have visible children
      if (children.length > 0) {
        out.push({ name, path: rel.replace(/\\/g, "/"), type: "dir", children });
      }
    } else if (st.isFile()) {
      // Only include code/text-y files
      const ext = path.extname(name).toLowerCase();
      if (
        [
          ".tsx", ".ts", ".jsx", ".js",
          ".mdx", ".md",
          ".css", ".scss",
          ".json"
        ].includes(ext)
      ) {
        out.push({
          name,
          path: rel.replace(/\\/g, "/"),
          type: "file",
          mtime: st.mtimeMs,
          size: st.size
        });
      }
    }
  }

  // Stable sort: directories first, then files (lexicographically)
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return out;
}

function buildTree(): FileNode[] {
  const roots: FileNode[] = [];
  for (const top of ALLOWED_TOP) {
    const absTop = path.join(APP_ROOT, top);
    if (!fs.existsSync(absTop)) continue;
    const children = walkDir(absTop, top);
    if (children.length > 0) {
      roots.push({ name: top, path: top, type: "dir", children });
    }
  }
  return roots;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const op = url.searchParams.get("op") || "list";

    if (op === "list") {
      const tree = buildTree();
      return NextResponse.json({
        ok: true,
        root: APP_ROOT,
        tree
      });
    }

    if (op === "read") {
      const rel = (url.searchParams.get("path") || "").replace(/^\/+/, "");
      if (!rel) {
        return NextResponse.json({ ok: false, error: "Missing 'path' parameter" }, { status: 400 });
      }

      // Make sure the path stays inside APP_ROOT
      const abs = path.normalize(path.join(APP_ROOT, rel));
      if (!abs.startsWith(APP_ROOT)) {
        return NextResponse.json({ ok: false, error: "Invalid path" }, { status: 400 });
      }

      const st = statSafe(abs);
      if (!st || !st.isFile()) {
        return NextResponse.json({ ok: false, error: "File not found" }, { status: 404 });
      }

      const content = fs.readFileSync(abs, "utf8");
      return NextResponse.json({ ok: true, path: rel, content });
    }

    return NextResponse.json({ ok: false, error: "Unsupported op" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Server error" }, { status: 500 });
  }
}
