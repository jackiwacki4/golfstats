import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { runScan, type ScanOptions } from "./engine/scan.js";
import { presentBoard } from "./engine/present.js";

const WEB_DIR = resolve(process.cwd(), "web");

/**
 * Constant-time password comparison.
 *
 * `===` on secrets leaks length and prefix through timing. It's a small risk
 * for a personal tool, but it costs nothing to do properly.
 */
function passwordMatches(supplied: string): boolean {
  const expected = Buffer.from(config.dashboardPassword);
  const actual = Buffer.from(supplied);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function isAuthorized(header: string | undefined): boolean {
  // No password required when bound to loopback — only you can reach it.
  if (!config.dashboardPassword && config.host === "127.0.0.1") return true;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return passwordMatches(password);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (!isAuthorized(req.headers.authorization)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="kalshisportsbot"',
      "Content-Type": "text/plain",
    });
    res.end("Authentication required.");
    return;
  }

  // Never let a private dashboard get framed or sniffed.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  /** Shared query parsing for both the raw and presented endpoints. */
  const readOptions = (): ScanOptions => {
    const options: ScanOptions = {};
    const minEdge = url.searchParams.get("minEdge");
    if (minEdge) options.minEdge = Number(minEdge) / 100;
    const categories = url.searchParams.get("categories");
    if (categories) options.categories = categories.split(",").filter(Boolean);

    const horizon = url.searchParams.get("horizon");
    if (horizon === "today" || horizon === "24h" || horizon === "all") {
      options.horizon = horizon;
    }
    const screaming = url.searchParams.get("screamingEdge");
    if (screaming) options.screamingEdge = Number(screaming) / 100;
    if (url.searchParams.get("fresh") === "1") options.fresh = true;
    if (url.searchParams.get("futures") === "off") {
      options.includeScreamingFutures = false;
    }
    return options;
  };

  // `/api/board` is what the website consumes: pre-formatted, presentation
  // shaped. `/api/scan` returns the raw engine output for debugging and for
  // anything else that wants to do its own maths.
  if (url.pathname === "/api/board" || url.pathname === "/api/scan") {
    try {
      const result = await runScan(readOptions());
      const body = url.pathname === "/api/board" ? presentBoard(result) : result;
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    try {
      const html = readFileSync(resolve(WEB_DIR, "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("web/index.html not found — run from the project root.");
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// Refuse to expose an unauthenticated dashboard to a network.
if (config.host !== "127.0.0.1" && !config.dashboardPassword) {
  console.error(
    `Refusing to bind ${config.host} without DASHBOARD_PASSWORD set.\n` +
      "Set one in .env, or use HOST=127.0.0.1 for local-only access.",
  );
  process.exit(1);
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${config.port} is already in use — an older copy is probably still running.\n` +
        `Stop it, or set PORT to something else in .env.`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(config.port, config.host, () => {
  console.log(`kalshisportsbot -> http://${config.host}:${config.port}`);
  if (!config.dashboardPassword) console.log("Local-only mode (no password set).");
});
