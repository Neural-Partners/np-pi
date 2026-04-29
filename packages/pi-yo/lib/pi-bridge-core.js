"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const DEFAULT_PROTOCOL_VERSION = 1;
const DEFAULT_ACK_TIMEOUT_MS = 750;
const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_MAX_CONTENT_BYTES = 32 * 1024;
const DEFAULT_MAX_FIELD_BYTES = 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 2000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_TOOL_USAGE_MAX_BYTES = 1024 * 1024;
const DEFAULT_TOOL_USAGE_BACKUPS = 3;
const DEFAULT_POLICY_RATE_LIMIT = Object.freeze({ perSenderPer10s: 5 });
const DEFAULT_BRIDGE_POLICY = Object.freeze({
  mode: "auto-inject",
  allowlist: Object.freeze([]),
  rateLimit: DEFAULT_POLICY_RATE_LIMIT,
});
const DEFAULT_FOCUS_ALLOWED_FRONTMOST_APPS = Object.freeze([
  "Supacode",
  "Terminal",
  "iTerm2",
  "Warp",
  "Ghostty",
  "WezTerm",
  "Cursor",
  "Visual Studio Code",
  "Code",
  "Zed",
  "Sublime Text",
  "Antigravity",
  "Kiro",
  "Windsurf",
  "WebStorm",
  "IntelliJ IDEA",
  "Claude",
  "Claude Desktop",
  "Codex",
]);
const DEFAULT_FOCUS_POLICY = Object.freeze({
  mode: "smart",
  allowedFrontmostApps: DEFAULT_FOCUS_ALLOWED_FRONTMOST_APPS,
});
const FRONTMOST_APP_SCRIPT =
  'tell application "System Events" to get name of first application process whose frontmost is true';

function buildPaths(home = os.homedir()) {
  const ipcDir = path.join(home, ".pi", "agent", "ipc");
  return {
    ipcDir,
    registryFile: path.join(ipcDir, "registry.json"),
  };
}

const DEFAULT_PATHS = buildPaths();

function chmodSafe(file, mode) {
  try {
    fs.chmodSync(file, mode);
  } catch {
    // Best effort: chmod can fail on some socket/platform combinations.
  }
}

function ensureIpcDir(ipcDir = DEFAULT_PATHS.ipcDir) {
  fs.mkdirSync(ipcDir, { recursive: true, mode: 0o700 });
  chmodSafe(ipcDir, 0o700);
}

function assertNotSymlink(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      throw new Error(`Refusing to write symbolic link: ${file}`);
    }
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
}

function noFollowFlag() {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

function openSecureFile(file, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSafe(path.dirname(file), 0o700);
  assertNotSymlink(file);

  const baseFlags = mode === "append"
    ? fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND
    : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC;
  const fd = fs.openSync(file, baseFlags | noFollowFlag(), 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Refusing to write non-regular file: ${file}`);
    return fd;
  } catch (err) {
    try { fs.closeSync(fd); } catch {}
    throw err;
  }
}

function secureWriteFile(file, content) {
  const fd = openSecureFile(file, "write");
  try {
    fs.writeFileSync(fd, String(content), { encoding: "utf-8" });
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  chmodSafe(file, 0o600);
}

function rotateFileIfNeeded(file, nextContent, options = {}) {
  const maxBytes = options.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return;
  const backups = Number.isSafeInteger(options.backups) && options.backups >= 0
    ? options.backups
    : DEFAULT_TOOL_USAGE_BACKUPS;
  if (backups === 0) return;

  let stat;
  try {
    assertNotSymlink(file);
    stat = fs.statSync(file);
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
    return;
  }

  if (stat.size + byteLength(nextContent) <= maxBytes) return;

  for (let i = backups; i >= 1; i -= 1) {
    const source = i === 1 ? file : `${file}.${i - 1}`;
    const target = `${file}.${i}`;
    try { assertNotSymlink(source); } catch (err) { if (!err || err.code !== "ENOENT") throw err; }
    try { fs.unlinkSync(target); } catch {}
    try {
      fs.renameSync(source, target);
      chmodSafe(target, 0o600);
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
  }
}

function appendFileSecure(file, content, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSafe(path.dirname(file), 0o700);
  rotateFileIfNeeded(file, content, options);
  const fd = openSecureFile(file, "append");
  try {
    fs.writeFileSync(fd, String(content), { encoding: "utf-8" });
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  chmodSafe(file, 0o600);
}

function readAndClearFileAtomic(file, options = {}) {
  const readingFile = `${file}.reading.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}`;
  try {
    assertNotSymlink(file);
    fs.renameSync(file, readingFile);
  } catch (err) {
    if (err && err.code === "ENOENT") return "";
    throw err;
  }

  try {
    assertNotSymlink(readingFile);
    if (typeof options.afterRename === "function") options.afterRename(readingFile);
    const content = fs.readFileSync(readingFile, "utf-8");
    try { fs.unlinkSync(readingFile); } catch {}
    return content;
  } catch (err) {
    try { fs.unlinkSync(readingFile); } catch {}
    throw err;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withRegistryLock(registryFile = DEFAULT_PATHS.registryFile, fn, options = {}) {
  const lockFile = options.lockFile || `${registryFile}.lock`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  ensureIpcDir(path.dirname(registryFile));

  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockFile, "wx", 0o600);
      chmodSafe(lockFile, 0o600);
    } catch (err) {
      if (!err || err.code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error(`Failed to acquire registry lock ${lockFile}: ${err && err.message ? err.message : err}`);
      }
      sleepSync(retryMs);
    }
  }

  try {
    return fn(lockFile);
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockFile); } catch {}
  }
}

function readRegistry(registryFile = DEFAULT_PATHS.registryFile) {
  try {
    const raw = fs.readFileSync(registryFile, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return { sessions: [] };
  }
}

function writeRegistry(registry, registryFile = DEFAULT_PATHS.registryFile) {
  ensureIpcDir(path.dirname(registryFile));
  assertNotSymlink(registryFile);
  const tmp = `${registryFile}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}`;
  secureWriteFile(tmp, JSON.stringify(registry, null, 2));
  fs.renameSync(tmp, registryFile);
  chmodSafe(registryFile, 0o600);
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function bridgeOwnedIpcFile(fileName) {
  return (
    fileName === "registry.json" ||
    fileName === "registry.json.lock" ||
    /^\d+\.sock$/.test(fileName) ||
    /^cc-[a-f0-9]{8}\.(sock|pid|mailbox|log|json)$/.test(fileName)
  );
}

function isAllowedBridgeSocketPath(socketPath, ipcDir = DEFAULT_PATHS.ipcDir) {
  if (typeof socketPath !== "string" || socketPath.length === 0) return false;
  const resolvedSocket = path.resolve(socketPath);
  const resolvedIpcDir = path.resolve(ipcDir);
  if (path.dirname(resolvedSocket) !== resolvedIpcDir) return false;
  const base = path.basename(resolvedSocket);
  return /^\d+\.sock$/.test(base) || /^cc-[a-f0-9]{8}\.sock$/.test(base);
}

function pruneDeadSessions(sessions, options = {}) {
  const removeSockets = options.removeSockets !== false;
  return sessions.filter((session) => {
    if (isProcessAlive(session.pid)) return true;
    if (removeSockets && session.socketPath) {
      try {
        fs.unlinkSync(session.socketPath);
      } catch {}
    }
    return false;
  });
}

function activeSessions(options = {}) {
  const registryFile = options.registryFile || DEFAULT_PATHS.registryFile;
  const ipcDir = options.ipcDir || path.dirname(registryFile);
  const registry = readRegistry(registryFile);
  let sessions = pruneDeadSessions(registry.sessions, { removeSockets: options.removeSockets });

  if (options.validateSocketPaths !== false) {
    sessions = sessions.filter((session) => isAllowedBridgeSocketPath(session.socketPath, ipcDir));
  }

  if (sessions.length !== registry.sessions.length && options.writePruned !== false) {
    writeRegistry({ sessions }, registryFile);
  }

  return sessions.filter((session) => session.pid !== options.excludePid);
}

function registerSession(entry, registryFile = DEFAULT_PATHS.registryFile) {
  return withRegistryLock(registryFile, () => {
    const registry = readRegistry(registryFile);
    const alive = pruneDeadSessions(registry.sessions).filter((session) => session.pid !== entry.pid);
    alive.push(entry);
    writeRegistry({ sessions: alive }, registryFile);
  });
}

function unregisterSession(pid, registryFile = DEFAULT_PATHS.registryFile) {
  try {
    return withRegistryLock(registryFile, () => {
      const registry = readRegistry(registryFile);
      writeRegistry({ sessions: registry.sessions.filter((session) => session.pid !== pid) }, registryFile);
    });
  } catch {
    // Best-effort cleanup.
  }
}

function duplicateCwdWarnings(sessions) {
  const byCwd = new Map();
  for (const session of sessions) {
    const list = byCwd.get(session.cwd) || [];
    list.push(session);
    byCwd.set(session.cwd, list);
  }

  return [...byCwd.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([cwd, list]) => {
      const safeCwd = sanitizeMetadata(cwd, 500);
      const safeSessions = list.map((session) => `${sanitizeMetadata(session.name, 200)} pid:${session.pid}`).join(", ");
      return `${safeCwd}: ${safeSessions}`;
    });
}

function normalize(value) {
  return String(value || "").toLowerCase().trim();
}

function cwdEndsWithSegment(cwd, query) {
  const normalizedCwd = normalize(cwd);
  const normalizedQuery = normalize(query).replace(/^\/+/, "");
  return normalizedCwd === normalizedQuery || normalizedCwd.endsWith(`/${normalizedQuery}`);
}

function resolveSessionTarget(query, sessions) {
  const q = normalize(query);
  if (!q) return { status: "not_found", query, candidates: [] };

  const buckets = [
    { kind: "pid", candidates: sessions.filter((session) => String(session.pid) === q) },
    { kind: "exact-name", candidates: sessions.filter((session) => normalize(session.name) === q) },
    { kind: "exact-cwd-basename", candidates: sessions.filter((session) => normalize(path.basename(session.cwd)) === q) },
    { kind: "cwd-suffix", candidates: sessions.filter((session) => cwdEndsWithSegment(session.cwd, q)) },
    { kind: "fuzzy-name", candidates: sessions.filter((session) => normalize(session.name).includes(q)) },
  ];

  for (const bucket of buckets) {
    if (bucket.candidates.length === 0) continue;
    if (bucket.candidates.length === 1) {
      return {
        status: "found",
        query,
        matchKind: bucket.kind,
        session: bucket.candidates[0],
        candidates: bucket.candidates,
      };
    }
    return {
      status: "ambiguous",
      query,
      matchKind: bucket.kind,
      candidates: bucket.candidates,
    };
  }

  return { status: "not_found", query, candidates: [] };
}

function formatCandidateList(candidates) {
  if (!candidates || candidates.length === 0) return "(none)";
  return candidates
    .map((session) => `"${sanitizeMetadata(session.name, 200)}" pid:${session.pid} cwd:${sanitizeMetadata(session.cwd, 500)}`)
    .join("\n  ");
}

function newMessageId(prefix = "msg") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function ensureMessageId(message, prefix = "msg") {
  if (message && typeof message.id === "string" && message.id.trim()) return message;
  return { ...message, id: newMessageId(prefix) };
}

function responseMatchesMessage(response, message) {
  if (!response || typeof response !== "object") return false;
  if (response.type !== "ack" && response.type !== "pong") return false;
  if (message.id && response.ackFor && response.ackFor !== message.id) return false;
  return true;
}

function noAckWarning(ackTimeoutMs) {
  return `No ACK received within ${ackTimeoutMs}ms; target may need /reload or pi-cc-bridge restart.`;
}

function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

function truncateToBytes(value, maxBytes) {
  const text = String(value);
  if (byteLength(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

function stripControlChars(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]/g, "");
}

function sanitizeMetadata(value, maxBytes = DEFAULT_MAX_FIELD_BYTES) {
  const stripped = stripControlChars(value).trim();
  const safe = stripped || "unknown";
  return truncateToBytes(safe, maxBytes);
}

function sanitizeSessionForDisplay(session) {
  const safe = {
    ...session,
    name: sanitizeMetadata(session && session.name, 200),
    cwd: sanitizeMetadata(session && session.cwd, 1000),
  };
  if (session && session.supacodeTabId !== undefined) safe.supacodeTabId = sanitizeMetadata(session.supacodeTabId, 128);
  if (session && session.supacodeWorktreeId !== undefined) safe.supacodeWorktreeId = sanitizeMetadata(session.supacodeWorktreeId, 256);
  if (session && session.supacodeSurfaceId !== undefined) safe.supacodeSurfaceId = sanitizeMetadata(session.supacodeSurfaceId, 128);
  return safe;
}

function defaultBridgePolicy() {
  return {
    mode: DEFAULT_BRIDGE_POLICY.mode,
    allowlist: [],
    rateLimit: { ...DEFAULT_BRIDGE_POLICY.rateLimit },
    focus: defaultFocusPolicy(),
  };
}

function defaultFocusPolicy() {
  return {
    mode: DEFAULT_FOCUS_POLICY.mode,
    allowedFrontmostApps: [...DEFAULT_FOCUS_POLICY.allowedFrontmostApps],
  };
}

function normalizeFocusPolicy(input = {}) {
  const defaults = defaultFocusPolicy();
  const source =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const mode =
    source.mode === "always" ||
    source.mode === "never" ||
    source.mode === "smart"
      ? source.mode
      : defaults.mode;
  const rawApps = Array.isArray(source.allowedFrontmostApps)
    ? source.allowedFrontmostApps
    : defaults.allowedFrontmostApps;
  const seen = new Set();
  const allowedFrontmostApps = [];

  for (const app of rawApps) {
    if (typeof app !== "string") continue;
    const safe = sanitizeMetadata(app, 128);
    if (!safe || safe === "unknown") continue;
    const key = safe.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    allowedFrontmostApps.push(safe);
  }

  return { mode, allowedFrontmostApps };
}

function normalizeBridgePolicy(input = {}) {
  const defaults = defaultBridgePolicy();
  const mode = input.mode === "mailbox-only" || input.mode === "auto-inject" ? input.mode : defaults.mode;
  const rawAllowlist = Array.isArray(input.allowlist) ? input.allowlist : [];
  const allowlist = rawAllowlist
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => {
      const normalized = {};
      if (Number.isSafeInteger(entry.pid) && entry.pid > 0) normalized.pid = entry.pid;
      if (typeof entry.name === "string" && entry.name.trim()) normalized.name = sanitizeMetadata(entry.name, 200);
      if (typeof entry.cwd === "string" && entry.cwd.trim()) normalized.cwd = sanitizeMetadata(entry.cwd, 2048);
      return normalized;
    })
    .filter((entry) => entry.pid || entry.name || entry.cwd);

  const perSenderPer10s = Number.isSafeInteger(input.rateLimit && input.rateLimit.perSenderPer10s) && input.rateLimit.perSenderPer10s > 0
    ? input.rateLimit.perSenderPer10s
    : defaults.rateLimit.perSenderPer10s;

  const focus = normalizeFocusPolicy(input.focus);

  return { mode, allowlist, rateLimit: { perSenderPer10s }, focus };
}

function readBridgePolicy(policyFile, options = {}) {
  const defaults = normalizeBridgePolicy(options.defaults || defaultBridgePolicy());
  try {
    if (!fs.existsSync(policyFile)) {
      secureWriteFile(policyFile, JSON.stringify(defaults, null, 2));
      return defaults;
    }
    chmodSafe(policyFile, 0o600);
    return normalizeBridgePolicy(JSON.parse(fs.readFileSync(policyFile, "utf-8")));
  } catch {
    return defaults;
  }
}

function senderMatchesAllowlist(message, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return true;
  return allowlist.some((entry) => {
    if (entry.pid && entry.pid === message.fromPid) return true;
    if (entry.name && entry.name === message.fromName) return true;
    if (entry.cwd && entry.cwd === message.fromCwd) return true;
    return false;
  });
}

function decideMessageDelivery(message, policy, options = {}) {
  const normalized = normalizeBridgePolicy(policy);
  if (normalized.mode === "mailbox-only") {
    return { action: "mailbox", reason: "bridge policy mode is mailbox-only" };
  }
  if (!senderMatchesAllowlist(message, normalized.allowlist)) {
    return { action: "mailbox", reason: "sender is not allowlisted by bridge policy" };
  }
  if (options.rateLimited) {
    return { action: "mailbox", reason: options.rateLimitReason || "sender exceeded bridge rate limit" };
  }
  return { action: "auto-inject", reason: "sender allowed by bridge policy" };
}

function createSenderRateLimiter(options = {}) {
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_POLICY_RATE_LIMIT.perSenderPer10s;
  const windowMs = Number.isSafeInteger(options.windowMs) && options.windowMs > 0 ? options.windowMs : 10_000;
  const buckets = new Map();

  return {
    check(key, now = Date.now()) {
      const senderKey = sanitizeMetadata(key || "unknown", 256);
      const bucket = buckets.get(senderKey);
      if (!bucket || now - bucket.windowStart >= windowMs) {
        buckets.set(senderKey, { windowStart: now, count: 1 });
        return { allowed: true, remaining: limit - 1 };
      }
      if (bucket.count >= limit) {
        return { allowed: false, remaining: 0, reason: `rate limit exceeded for ${senderKey}` };
      }
      bucket.count += 1;
      return { allowed: true, remaining: limit - bucket.count };
    },
  };
}

function truncateContent(value, maxBytes = DEFAULT_MAX_CONTENT_BYTES) {
  const text = String(value).replace(/\u0000/g, "");
  const originalBytes = byteLength(text);
  if (originalBytes <= maxBytes) return { text, truncated: false, originalBytes };
  const marker = `\n[pi-bridge: content truncated from ${originalBytes} bytes to ${maxBytes} bytes]`;
  const head = truncateToBytes(text, maxBytes);
  return { text: `${head}${marker}`, truncated: true, originalBytes };
}

function validateBridgeMessage(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Message must be a JSON object" };
  }

  if (input.protocol !== undefined && input.protocol !== DEFAULT_PROTOCOL_VERSION) {
    return { ok: false, error: `Unsupported protocol version: ${input.protocol}` };
  }

  const type = input.type;
  if (type !== "message" && type !== "ping") {
    return { ok: false, error: "Message type must be message or ping" };
  }

  if (!Number.isSafeInteger(input.fromPid) || input.fromPid <= 0) {
    return { ok: false, error: "fromPid must be a positive safe integer" };
  }

  if (typeof input.fromName !== "string" || typeof input.fromCwd !== "string") {
    return { ok: false, error: "fromName and fromCwd must be strings" };
  }

  if (input.isReply !== undefined && typeof input.isReply !== "boolean") {
    return { ok: false, error: "isReply must be a boolean when present" };
  }

  if (input.id !== undefined && typeof input.id !== "string") {
    return { ok: false, error: "id must be a string when present" };
  }

  const maxContentBytes = options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  const content = type === "ping" && input.content === undefined ? "" : input.content;
  if (typeof content !== "string") {
    return { ok: false, error: "content must be a string" };
  }

  const now = Date.now();
  const skewMs = options.timestampSkewMs ?? 24 * 60 * 60 * 1000;
  const timestamp = Number.isFinite(input.timestamp) && Math.abs(input.timestamp - now) <= skewMs
    ? input.timestamp
    : now;
  const truncated = truncateContent(content, maxContentBytes);

  return {
    ok: true,
    value: {
      protocol: input.protocol === undefined ? undefined : DEFAULT_PROTOCOL_VERSION,
      id: input.id ? sanitizeMetadata(input.id, 256) : undefined,
      type,
      fromPid: input.fromPid,
      fromName: sanitizeMetadata(input.fromName),
      fromCwd: sanitizeMetadata(input.fromCwd, 2048),
      content: truncated.text,
      timestamp,
      isReply: input.isReply === true,
    },
    warnings: truncated.truncated ? [`content truncated from ${truncated.originalBytes} bytes`] : [],
  };
}

function collectJsonLines(buffer, chunk, options = {}) {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const combined = `${buffer || ""}${chunk || ""}`;
  const parts = combined.split("\n");
  const nextBuffer = parts.pop() || "";

  for (const line of parts) {
    if (byteLength(line) > maxFrameBytes) {
      return { buffer: "", lines: [], overflow: true };
    }
  }

  if (byteLength(nextBuffer) > maxFrameBytes) {
    return { buffer: "", lines: [], overflow: true };
  }

  return { buffer: nextBuffer, lines: parts, overflow: false };
}

function validateSupacodeComponent(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
  return /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/.test(value);
}

function buildSupacodeUrl(session) {
  if (!session || !validateSupacodeComponent(session.supacodeWorktreeId) || !validateSupacodeComponent(session.supacodeTabId)) {
    return undefined;
  }
  return `supacode://worktree/${session.supacodeWorktreeId}/tab/${session.supacodeTabId}`;
}

function openSupacodeTab(session, opener = execFileSync) {
  const url = buildSupacodeUrl(session);
  if (!url) return false;
  try {
    opener("open", [url], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getFrontmostAppName(options = {}) {
  try {
    if (typeof options.frontmostAppName === "string") {
      const safe = sanitizeMetadata(options.frontmostAppName, 128);
      return safe === "unknown" ? undefined : safe;
    }

    if (typeof options.frontmostAppProvider === "function") {
      const provided = options.frontmostAppProvider();
      const safe = sanitizeMetadata(provided, 128);
      return safe === "unknown" ? undefined : safe;
    }

    const runner = options.runner || execFileSync;
    const output = runner("osascript", ["-e", FRONTMOST_APP_SCRIPT], {
      encoding: "utf8",
      timeout: Number.isSafeInteger(options.timeoutMs)
        ? options.timeoutMs
        : 500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const safe = sanitizeMetadata(output, 128);
    return safe === "unknown" ? undefined : safe;
  } catch {
    return undefined;
  }
}

function focusAppKey(value) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase();
}

function shouldFocusSession(session, policy = {}, options = {}) {
  if (!buildSupacodeUrl(session)) {
    return { shouldFocus: false, reason: "target has no focus metadata" };
  }

  const focus = normalizeFocusPolicy(policy.focus || policy);

  if (focus.mode === "never") {
    return { shouldFocus: false, reason: "focus mode is never" };
  }

  if (focus.mode === "always") {
    return { shouldFocus: true, reason: "focus mode is always" };
  }

  const frontmostApp = getFrontmostAppName(options);
  if (!frontmostApp) {
    return { shouldFocus: false, reason: "frontmost app unavailable" };
  }

  const allowed = new Set(focus.allowedFrontmostApps.map(focusAppKey));
  if (allowed.has(focusAppKey(frontmostApp))) {
    return { shouldFocus: true, reason: "frontmost app allowed", frontmostApp };
  }

  return {
    shouldFocus: false,
    reason: "frontmost app not allowed",
    frontmostApp,
  };
}

function maybeFocusSession(session, policy = {}, options = {}) {
  const decision = shouldFocusSession(session, policy, options);
  if (!decision.shouldFocus) {
    return {
      focused: false,
      reason: decision.reason,
      frontmostApp: decision.frontmostApp,
    };
  }

  const opened = openSupacodeTab(session, options.opener || execFileSync);
  return {
    focused: opened,
    reason: opened ? decision.reason : "focus opener failed",
    frontmostApp: decision.frontmostApp,
  };
}

function doctorIpcPermissions(options = {}) {
  const ipcDir = options.ipcDir || DEFAULT_PATHS.ipcDir;
  const fix = options.fix === true;
  const findings = [];

  function check(file, expectedMode) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        findings.push({ path: file, issue: "symbolic-link", expectedMode, fixed: false });
        return;
      }
      const actualMode = stat.mode & 0o777;
      if (actualMode !== expectedMode) {
        findings.push({ path: file, actualMode, expectedMode, fixed: fix });
        if (fix) chmodSafe(file, expectedMode);
      }
    } catch {}
  }

  if (!fs.existsSync(ipcDir)) ensureIpcDir(ipcDir);
  check(ipcDir, 0o700);
  if (fix) chmodSafe(ipcDir, 0o700);

  for (const entry of fs.readdirSync(ipcDir, { withFileTypes: true })) {
    if (!entry.isFile() && !entry.isSocket()) continue;
    if (!bridgeOwnedIpcFile(entry.name)) continue;
    check(path.join(ipcDir, entry.name), 0o600);
  }

  for (const extraFile of options.extraFiles || []) {
    if (fs.existsSync(extraFile)) check(extraFile, 0o600);
  }

  return { ipcDir, fixed: fix, findings };
}

function writePidMetadata(file, metadata) {
  secureWriteFile(file, JSON.stringify({ ...metadata, writtenAt: Date.now() }, null, 2));
}

function readPidMetadata(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

function getProcessCommand(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function isExpectedDaemonProcess(pid, expected = {}) {
  if (!isProcessAlive(pid)) return false;
  const metadata = expected.metadataFile ? readPidMetadata(expected.metadataFile) : expected.metadata;
  if (metadata) {
    if (metadata.pid !== pid) return false;
    if (expected.cwd && metadata.cwd !== expected.cwd) return false;
    if (expected.scriptPath && metadata.scriptPath !== expected.scriptPath) return false;
  }
  const command = getProcessCommand(pid);
  if (!command) return false;
  if (expected.scriptPath && !command.includes(expected.scriptPath)) return false;
  return true;
}

async function sendToSocket(socketPath, inputMessage, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const requireAck = options.requireAck === true;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const message = ensureMessageId({ ...inputMessage, protocol: DEFAULT_PROTOCOL_VERSION });

  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let settled = false;
    let writeCompleted = false;
    let buffer = "";
    let connectTimer;
    let ackTimer;

    function cleanup() {
      clearTimeout(connectTimer);
      clearTimeout(ackTimer);
    }

    function settleResolve(receipt) {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        client.end();
      } catch {}
      resolve(receipt);
    }

    function settleReject(error) {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        client.destroy();
      } catch {}
      reject(error);
    }

    function settleNoAck() {
      const warning = noAckWarning(ackTimeoutMs);
      if (requireAck) {
        settleReject(new Error(warning));
      } else {
        settleResolve({ delivered: true, acked: false, message, warning });
      }
    }

    connectTimer = setTimeout(() => {
      settleReject(new Error(`Connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    client.on("connect", () => {
      client.write(JSON.stringify(message) + "\n", "utf-8", (err) => {
        if (settled) return;
        if (err) {
          settleReject(err);
          return;
        }
        writeCompleted = true;
        clearTimeout(connectTimer);
        ackTimer = setTimeout(settleNoAck, ackTimeoutMs);
      });
    });

    client.on("data", (chunk) => {
      const collected = collectJsonLines(buffer, chunk.toString("utf-8"), { maxFrameBytes });
      if (collected.overflow) {
        settleReject(new Error(`ACK frame exceeded ${maxFrameBytes} bytes`));
        return;
      }
      buffer = collected.buffer;

      for (const line of collected.lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const response = JSON.parse(trimmed);
          if (responseMatchesMessage(response, message)) {
            settleResolve({ delivered: true, acked: true, message, response });
            return;
          }
        } catch {
          // Ignore malformed receipt lines and keep waiting until ACK timeout.
        }
      }
    });

    client.on("close", () => {
      if (!settled && writeCompleted) settleNoAck();
    });

    client.on("error", (err) => {
      settleReject(err);
    });
  });
}

function createSocketResponse(type, message, sender, extra = {}) {
  return {
    protocol: DEFAULT_PROTOCOL_VERSION,
    type,
    ackFor: message && message.id,
    ok: true,
    fromPid: sender.fromPid,
    fromName: sender.fromName,
    fromCwd: sender.fromCwd,
    timestamp: Date.now(),
    ...extra,
  };
}

const DEFAULT_NOTICE_CONTROLS = "Controls: Esc closes this notice • Ctrl+C exits Pi";

function formatNoticeWithControls(content, options = {}) {
  const body = String(content ?? "").trimEnd() || "(empty)";
  const action = typeof options.action === "string" ? options.action.trim() : "";
  const controls = options.controls === false
    ? ""
    : typeof options.controls === "string" && options.controls.trim()
      ? options.controls.trim()
      : DEFAULT_NOTICE_CONTROLS;

  return [body, action, controls].filter(Boolean).join("\n\n").trimEnd();
}

function formatMailboxNotice(content) {
  const body = String(content ?? "").trim();
  if (!body) {
    return formatNoticeWithControls("Bridge mailbox is empty.", {
      action: "Mailbox was checked and remains empty.",
    });
  }

  return formatNoticeWithControls(body, {
    action: "Mailbox was cleared when this notice opened. Copy anything you need before closing.",
  });
}

module.exports = {
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_BRIDGE_POLICY,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_FOCUS_ALLOWED_FRONTMOST_APPS,
  DEFAULT_FOCUS_POLICY,
  DEFAULT_MAX_CONTENT_BYTES,
  DEFAULT_MAX_FIELD_BYTES,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_NOTICE_CONTROLS,
  DEFAULT_PATHS,
  DEFAULT_PROTOCOL_VERSION,
  DEFAULT_TOOL_USAGE_BACKUPS,
  DEFAULT_TOOL_USAGE_MAX_BYTES,
  activeSessions,
  appendFileSecure,
  buildPaths,
  buildSupacodeUrl,
  chmodSafe,
  collectJsonLines,
  createSenderRateLimiter,
  createSocketResponse,
  decideMessageDelivery,
  defaultBridgePolicy,
  defaultFocusPolicy,
  doctorIpcPermissions,
  duplicateCwdWarnings,
  ensureIpcDir,
  ensureMessageId,
  formatCandidateList,
  formatMailboxNotice,
  formatNoticeWithControls,
  getFrontmostAppName,
  getProcessCommand,
  isAllowedBridgeSocketPath,
  isExpectedDaemonProcess,
  isProcessAlive,
  maybeFocusSession,
  newMessageId,
  normalizeBridgePolicy,
  normalizeFocusPolicy,
  openSecureFile,
  openSupacodeTab,
  pruneDeadSessions,
  readAndClearFileAtomic,
  readBridgePolicy,
  readPidMetadata,
  readRegistry,
  registerSession,
  resolveSessionTarget,
  sanitizeMetadata,
  sanitizeSessionForDisplay,
  secureWriteFile,
  sendToSocket,
  shouldFocusSession,
  truncateContent,
  unregisterSession,
  validateBridgeMessage,
  withRegistryLock,
  writePidMetadata,
  writeRegistry,
};
