import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "../..");
export const DATA_DIR = path.join(ROOT, "data");
export const META_FILE = path.join(DATA_DIR, "inboxes.json");

const INBOX_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
export const MAX_EVENTS_PER_INBOX = 100;

let writeChain = Promise.resolve();

/** Serialize all metadata reads/writes to avoid lost updates. */
export function withStoreLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function isValidInboxId(id) {
  return typeof id === "string" && INBOX_ID_RE.test(id);
}

export function isValidEventId(id) {
  return typeof id === "string" && EVENT_ID_RE.test(id);
}

export async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(META_FILE);
  } catch {
    await fs.writeFile(META_FILE, JSON.stringify({ inboxes: {} }, null, 2), "utf8");
  }
}

function normalizeInboxes(raw) {
  const inboxes = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return inboxes;
  for (const [id, inbox] of Object.entries(raw)) {
    if (isValidInboxId(id) && inbox && typeof inbox === "object") {
      const events = Array.isArray(inbox.events) ? inbox.events.slice(0, MAX_EVENTS_PER_INBOX) : [];
      inboxes[id] = { ...inbox, events };
    }
  }
  return inboxes;
}

export async function loadInboxes() {
  await ensureDirs();
  let raw;
  try {
    raw = await fs.readFile(META_FILE, "utf8");
  } catch {
    return { inboxes: Object.create(null) };
  }
  try {
    const data = JSON.parse(raw);
    return { inboxes: normalizeInboxes(data?.inboxes) };
  } catch (err) {
    console.error("[Hookbox] corrupt inboxes.json, starting empty:", err.message);
    return { inboxes: Object.create(null) };
  }
}

export async function saveInboxes(data) {
  await ensureDirs();
  const payload = { inboxes: normalizeInboxes(data?.inboxes) };
  const tmp = `${META_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, META_FILE);
}

export function getInbox(data, id) {
  if (!isValidInboxId(id)) return null;
  if (!Object.prototype.hasOwnProperty.call(data.inboxes, id)) return null;
  return data.inboxes[id];
}

export async function deleteInbox(id) {
  return withStoreLock(async () => {
    const data = await loadInboxes();
    if (!Object.prototype.hasOwnProperty.call(data.inboxes, id)) return false;
    delete data.inboxes[id];
    await saveInboxes(data);
    return true;
  });
}
