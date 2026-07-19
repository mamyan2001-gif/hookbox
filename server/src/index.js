import express from "express";
import cors from "cors";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import {
  ROOT,
  ensureDirs,
  loadInboxes,
  saveInboxes,
  getInbox,
  deleteInbox,
  isValidInboxId,
  isValidEventId,
  withStoreLock,
  MAX_EVENTS_PER_INBOX,
} from "./store.js";

const PORT = Number(process.env.PORT) || 5070;
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES) || 256 * 1024;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";
const REDACT_HEADERS = new Set(["cookie", "authorization", "proxy-authorization"]);
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

await ensureDirs();

const app = express();
app.disable("x-powered-by");
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || ""));
if (TRUST_PROXY) app.set("trust proxy", 1);

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'",
  );
  next();
});

if (CORS_ORIGIN) {
  const allowed = CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || allowed.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
    }),
  );
}

app.use("/api", express.json({ limit: "32kb" }));

/** Simple sliding-window rate limiter (per key). */
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function rateLimit(key) {
    const now = Date.now();
    let bucket = hits.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      hits.set(key, bucket);
    }
    bucket.count += 1;
    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (now - v.start >= windowMs) hits.delete(k);
      }
    }
    return bucket.count <= max;
  };
}

const captureLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120 });
const apiLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers["x-forwarded-for"];
    if (typeof xf === "string" && xf.trim()) return xf.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

function clientError(res, status, message) {
  return res.status(status).json({ error: message });
}

function captureUrl(id) {
  return `/h/${id}`;
}

function publicCaptureUrl(id) {
  const base = PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`;
  return `${base}/h/${id}`;
}

function inboxPublicView(id, inbox, { includeSecret = false } = {}) {
  const view = {
    id,
    captureUrl: captureUrl(id),
    publicUrl: publicCaptureUrl(id),
    createdAt: inbox.createdAt,
    eventCount: Array.isArray(inbox.events) ? inbox.events.length : 0,
    hasHmacSecret: Boolean(inbox.hmacSecret),
  };
  if (includeSecret && inbox.hmacSecret) {
    view.hmacSecret = inbox.hmacSecret;
  }
  return view;
}

function sanitizeHeaders(headers) {
  const out = Object.create(null);
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (REDACT_HEADERS.has(lower)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

function verifyHmac(rawBody, secret, headers) {
  if (!secret) return null;
  const hub = headers["x-hub-signature-256"];
  const sig = headers["x-signature"];
  const provided = typeof hub === "string" ? hub : typeof sig === "string" ? sig : null;
  if (!provided) return null;
  if (provided.length > 200) return false;

  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedPrefixed = `sha256=${digest}`;
  const candidates = [expectedPrefixed, digest];

  let match = provided.trim();
  if (match.toLowerCase().startsWith("sha256=")) {
    match = `sha256=${match.slice(7).toLowerCase()}`;
  } else {
    match = match.toLowerCase();
  }

  for (const candidate of candidates) {
    const a = Buffer.from(match);
    const b = Buffer.from(candidate);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function isBlockedReplayHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  // Cloud metadata / link-local — never allow (SSRF)
  if (h === "169.254.169.254" || h.startsWith("169.254.")) return true;
  if (h === "metadata.google.internal" || h.endsWith(".metadata.google.internal")) {
    return true;
  }
  if (h === "metadata" || h === "metadata.internal") return true;
  if (h.startsWith("fe80:") || h.startsWith("fd00:") || h.startsWith("fc00:")) return true;
  if (h.startsWith("::ffff:169.254.")) return true;
  return false;
}

function isSafeTargetUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host || isBlockedReplayHost(host)) return false;
  // Loopback / LAN allowed for local webhook debugging
  return true;
}

function replayHeaders(stored) {
  const out = Object.create(null);
  for (const [key, value] of Object.entries(stored || {})) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || REDACT_HEADERS.has(lower)) continue;
    if (value === "[REDACTED]") continue;
    out[key] = value;
  }
  return out;
}

/** Capture raw body for /h/:id (any method), capped at MAX_BODY_BYTES. */
function captureBody(req, res, next) {
  const chunks = [];
  let size = 0;
  let aborted = false;

  const fail = (status, message) => {
    if (aborted || res.headersSent) return;
    aborted = true;
    // Drain remaining request data so the socket can close cleanly
    req.on("data", () => {});
    req.resume();
    clientError(res, status, message);
  };

  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail(413, "Payload too large");
  }

  req.on("data", (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      return fail(413, "Payload too large");
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (aborted || res.headersSent) return;
    req.rawBody = Buffer.concat(chunks);
    next();
  });

  req.on("error", () => {
    if (!res.headersSent) clientError(res, 400, "Request failed");
  });
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "hookbox",
    version: "1.0.0",
    maxBodyBytes: MAX_BODY_BYTES,
    maxEventsPerInbox: MAX_EVENTS_PER_INBOX,
  });
});

app.post("/api/inboxes", async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!apiLimiter(`api:${ip}`)) {
      return clientError(res, 429, "Too many requests. Try again later.");
    }

    const id = nanoid(12);
    const hmacSecret = crypto.randomBytes(24).toString("hex");
    const inbox = {
      hmacSecret,
      createdAt: new Date().toISOString(),
      events: [],
    };

    await withStoreLock(async () => {
      const data = await loadInboxes();
      data.inboxes[id] = inbox;
      await saveInboxes(data);
    });

    res.status(201).json(inboxPublicView(id, inbox, { includeSecret: true }));
  } catch (err) {
    console.error("[Hookbox] create inbox failed:", err);
    clientError(res, 500, "Failed to create inbox");
  }
});

app.get("/api/inboxes/:id", async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!apiLimiter(`api:${ip}`)) {
      return clientError(res, 429, "Too many requests. Try again later.");
    }

    const id = req.params.id;
    if (!isValidInboxId(id)) return clientError(res, 404, "Inbox not found");

    const data = await loadInboxes();
    const inbox = getInbox(data, id);
    if (!inbox) return clientError(res, 404, "Inbox not found");

    res.json(inboxPublicView(id, inbox));
  } catch (err) {
    console.error("[Hookbox] get inbox failed:", err);
    clientError(res, 500, "Failed to load inbox");
  }
});

app.get("/api/inboxes/:id/events", async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!apiLimiter(`api:${ip}`)) {
      return clientError(res, 429, "Too many requests. Try again later.");
    }

    const id = req.params.id;
    if (!isValidInboxId(id)) return clientError(res, 404, "Inbox not found");

    const data = await loadInboxes();
    const inbox = getInbox(data, id);
    if (!inbox) return clientError(res, 404, "Inbox not found");

    res.json({
      id,
      events: Array.isArray(inbox.events) ? inbox.events : [],
    });
  } catch (err) {
    console.error("[Hookbox] list events failed:", err);
    clientError(res, 500, "Failed to load events");
  }
});

app.delete("/api/inboxes/:id", async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!apiLimiter(`api:${ip}`)) {
      return clientError(res, 429, "Too many requests. Try again later.");
    }

    const id = req.params.id;
    if (!isValidInboxId(id)) return clientError(res, 404, "Inbox not found");

    const removed = await deleteInbox(id);
    if (!removed) return clientError(res, 404, "Inbox not found");

    res.json({ ok: true });
  } catch (err) {
    console.error("[Hookbox] delete inbox failed:", err);
    clientError(res, 500, "Delete failed");
  }
});

app.post("/api/inboxes/:id/events/:eventId/replay", async (req, res) => {
  try {
    const ip = clientIp(req);
    if (!apiLimiter(`replay:${ip}`)) {
      return clientError(res, 429, "Too many requests. Try again later.");
    }

    const { id, eventId } = req.params;
    if (!isValidInboxId(id) || !isValidEventId(eventId)) {
      return clientError(res, 404, "Not found");
    }

    const targetUrl = typeof req.body?.targetUrl === "string" ? req.body.targetUrl.trim() : "";
    if (!targetUrl || !isSafeTargetUrl(targetUrl)) {
      return clientError(res, 400, "A valid http(s) targetUrl is required");
    }

    const data = await loadInboxes();
    const inbox = getInbox(data, id);
    if (!inbox) return clientError(res, 404, "Inbox not found");

    const event = (inbox.events || []).find((e) => e.id === eventId);
    if (!event) return clientError(res, 404, "Event not found");

    const headers = replayHeaders(event.headers);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    try {
      const upstream = await fetch(targetUrl, {
        method: event.method || "POST",
        headers,
        body: ["GET", "HEAD"].includes((event.method || "").toUpperCase())
          ? undefined
          : event.body ?? "",
        signal: controller.signal,
        redirect: "manual",
      });

      const text = await upstream.text().catch(() => "");
      res.json({
        ok: true,
        status: upstream.status,
        statusText: upstream.statusText,
        bodyPreview: text.slice(0, 2048),
      });
    } catch (fetchErr) {
      if (fetchErr?.name === "AbortError") {
        return clientError(res, 504, "Replay timed out");
      }
      console.error("[Hookbox] replay failed:", fetchErr.message);
      return clientError(res, 502, "Replay failed");
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error("[Hookbox] replay error:", err);
    clientError(res, 500, "Replay failed");
  }
});

app.all("/h/:id", captureBody, async (req, res) => {
  try {
    const id = req.params.id;
    const ip = clientIp(req);
    if (!captureLimiter(`capture:${ip}`)) {
      return clientError(res, 429, "Too many requests. Try again later.");
    }

    if (!isValidInboxId(id)) return clientError(res, 404, "Inbox not found");

    const rawBody = req.rawBody || Buffer.alloc(0);
    const bodyText = rawBody.toString("utf8");

    const result = await withStoreLock(async () => {
      const data = await loadInboxes();
      const inbox = getInbox(data, id);
      if (!inbox) return { ok: false };

      const verified = verifyHmac(rawBody, inbox.hmacSecret, req.headers);
      const event = {
        id: nanoid(12),
        method: req.method,
        path: req.path,
        query: req.query && typeof req.query === "object" ? { ...req.query } : {},
        headers: sanitizeHeaders(req.headers),
        body: bodyText,
        contentType: req.headers["content-type"] || null,
        receivedAt: new Date().toISOString(),
        verified,
        size: rawBody.length,
      };

      const events = Array.isArray(inbox.events) ? inbox.events : [];
      events.unshift(event);
      inbox.events = events.slice(0, MAX_EVENTS_PER_INBOX);
      data.inboxes[id] = inbox;
      await saveInboxes(data);
      return { ok: true, event };
    });

    if (!result.ok) return clientError(res, 404, "Inbox not found");

    res.status(200).json({
      ok: true,
      id: result.event.id,
      receivedAt: result.event.receivedAt,
      verified: result.event.verified,
    });
  } catch (err) {
    console.error("[Hookbox] capture failed:", err);
    if (!res.headersSent) clientError(res, 500, "Capture failed");
  }
});

const dist = path.join(ROOT, "client", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api)(?!\/h\/).*/, (_req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
}

app.listen(PORT, HOST, () => {
  console.log(`Hookbox listening on http://${HOST}:${PORT}`);
});
