#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const core = require("../lib/pi-bridge-core.js");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-home-"));
}

function fileMode(file) {
  return fs.statSync(file).mode & 0o777;
}

function sampleMessage(overrides = {}) {
  return {
    id: "msg_test_1",
    type: "message",
    fromPid: 12345,
    fromName: "tester",
    fromCwd: "/tmp/tester",
    content: "hello",
    timestamp: Date.now(),
    isReply: false,
    ...overrides,
  };
}

function sampleSupacodeSession(overrides = {}) {
  return {
    pid: 22222,
    name: "target",
    cwd: "/tmp/target",
    socketPath: "/tmp/target.sock",
    startedAt: 1,
    supacodeWorktreeId: "worktree-123_%2Fsafe",
    supacodeTabId: "tab_456",
    supacodeSurfaceId: "surface_789",
    ...overrides,
  };
}

test("bridge visibility defaults to visible and only invisible hides a session", () => {
  assert.equal(core.normalizeBridgeVisibility(undefined), "visible");
  assert.equal(core.normalizeBridgeVisibility("visible"), "visible");
  assert.equal(core.normalizeBridgeVisibility("invisible"), "invisible");
  assert.equal(core.normalizeBridgeVisibility("hidden"), "visible");
  assert.equal(core.isSessionVisible({ name: "legacy" }), true);
  assert.equal(core.isSessionVisible({ name: "standby", bridgeVisibility: "invisible" }), false);
});

test("visibleSessions excludes invisible sessions without mutating the original list", () => {
  const sessions = [
    { pid: 111, name: "visible", cwd: "/workspace/app", socketPath: "/tmp/111.sock", startedAt: 1 },
    { pid: 222, name: "standby", cwd: "/workspace/app", socketPath: "/tmp/222.sock", startedAt: 1, bridgeVisibility: "invisible" },
  ];

  const visible = core.visibleSessions(sessions);

  assert.deepEqual(visible.map((session) => session.pid), [111]);
  assert.equal(sessions.length, 2);
});

test("sanitizeSessionForDisplay includes normalized bridge visibility", () => {
  const safeLegacy = core.sanitizeSessionForDisplay({
    pid: 999,
    name: "legacy",
    cwd: "/tmp/project",
    socketPath: "/tmp/999.sock",
    startedAt: 1,
  });
  const safeInvisible = core.sanitizeSessionForDisplay({
    pid: 1000,
    name: "standby",
    cwd: "/tmp/project",
    socketPath: "/tmp/1000.sock",
    startedAt: 1,
    bridgeVisibility: "invisible",
  });

  assert.equal(safeLegacy.bridgeVisibility, "visible");
  assert.equal(safeInvisible.bridgeVisibility, "invisible");
});

function captureOpener(calls) {
  return (cmd, args, options) => calls.push({ cmd, args, options });
}

async function withSocketServer(handler, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbc-"));
  const socketPath = path.join(dir, "bridge.sock");
  const server = net.createServer(handler);
  server.listen(socketPath);
  await once(server, "listening");
  try {
    return await run(socketPath);
  } finally {
    server.close();
    await once(server, "close");
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("ensureIpcDir and writeRegistry use owner-only filesystem permissions", () => {
  const paths = core.buildPaths(tempHome());

  core.ensureIpcDir(paths.ipcDir);
  assert.equal(fileMode(paths.ipcDir), 0o700);

  core.writeRegistry({ sessions: [] }, paths.registryFile);
  assert.equal(fileMode(paths.registryFile), 0o600);
});

test("resolveSessionTarget prefers exact session name over duplicate cwd sessions", () => {
  const sessions = [
    { pid: 111, name: "frontend", cwd: "/workspace/frontend", socketPath: "/tmp/111.sock", startedAt: 1 },
    { pid: 222, name: "frontend (CC)", cwd: "/workspace/frontend", socketPath: "/tmp/222.sock", startedAt: 2 },
  ];

  const result = core.resolveSessionTarget("frontend", sessions);

  assert.equal(result.status, "found");
  assert.equal(result.matchKind, "exact-name");
  assert.equal(result.session.pid, 111);
});

test("resolveSessionTarget fails safely on ambiguous fuzzy targets", () => {
  const sessions = [
    { pid: 111, name: "frontend", cwd: "/workspace/frontend", socketPath: "/tmp/111.sock", startedAt: 1 },
    { pid: 222, name: "frontend (CC)", cwd: "/workspace/frontend", socketPath: "/tmp/222.sock", startedAt: 2 },
  ];

  const result = core.resolveSessionTarget("front", sessions);

  assert.equal(result.status, "ambiguous");
  assert.equal(result.matchKind, "fuzzy-name");
  assert.deepEqual(result.candidates.map((s) => s.pid).sort(), [111, 222]);
  assert.match(core.formatCandidateList(result.candidates), /pid:111/);
  assert.match(core.formatCandidateList(result.candidates), /pid:222/);
});

test("sendToSocket returns an ACK receipt from an updated recipient", async () => {
  await withSocketServer((socket) => {
    socket.on("data", (chunk) => {
      const msg = JSON.parse(String(chunk).trim());
      socket.write(JSON.stringify({
        type: "ack",
        ackFor: msg.id,
        ok: true,
        fromPid: 999,
        fromName: "receiver",
        fromCwd: "/tmp/receiver",
        timestamp: Date.now(),
      }) + "\n");
    });
  }, async (socketPath) => {
    const receipt = await core.sendToSocket(socketPath, sampleMessage(), { timeoutMs: 1000, ackTimeoutMs: 1000 });

    assert.equal(receipt.delivered, true);
    assert.equal(receipt.acked, true);
    assert.equal(receipt.response.type, "ack");
    assert.equal(receipt.response.ackFor, "msg_test_1");
  });
});

test("sendToSocket degrades gracefully when an older recipient does not ACK", async () => {
  await withSocketServer((socket) => {
    socket.on("data", () => {
      // Simulate an old bridge recipient: accepts the socket write but never returns a receipt.
    });
  }, async (socketPath) => {
    const receipt = await core.sendToSocket(socketPath, sampleMessage({ id: "msg_no_ack" }), { timeoutMs: 500, ackTimeoutMs: 50 });

    assert.equal(receipt.delivered, true);
    assert.equal(receipt.acked, false);
    assert.match(receipt.warning, /No ACK/i);
  });
});

test("buildSupacodeUrl rejects shell metacharacters and openSupacodeTab never shell-interpolates", () => {
  const hostile = {
    supacodeWorktreeId: 'abc";touch /tmp/pwned;"',
    supacodeTabId: "tab$(touch /tmp/pwned)",
  };
  assert.equal(core.buildSupacodeUrl(hostile), undefined);

  const calls = [];
  const valid = { supacodeWorktreeId: "worktree-123_%2Fsafe", supacodeTabId: "tab_456" };
  const opened = core.openSupacodeTab(valid, (cmd, args, options) => calls.push({ cmd, args, options }));

  assert.equal(opened, true);
  assert.deepEqual(calls, [{
    cmd: "open",
    args: ["supacode://worktree/worktree-123_%2Fsafe/tab/tab_456"],
    options: { stdio: "ignore" },
  }]);
});

test("validateBridgeMessage rejects invalid shapes and truncates oversized content", () => {
  assert.equal(core.validateBridgeMessage({ type: "ack" }).ok, false);
  assert.equal(core.validateBridgeMessage(sampleMessage({ fromPid: -1 })).ok, false);

  const result = core.validateBridgeMessage(sampleMessage({
    fromName: "evil\nname\u0000",
    content: "x".repeat(128),
  }), { maxContentBytes: 32 });

  assert.equal(result.ok, true);
  assert.equal(result.value.fromName, "evilname");
  assert.ok(Buffer.byteLength(result.value.content, "utf8") <= 96);
  assert.match(result.value.content, /truncated/);
});

test("collectJsonLines reports oversized frames before newline", () => {
  const result = core.collectJsonLines("", "x".repeat(20), { maxFrameBytes: 10 });

  assert.equal(result.overflow, true);
  assert.deepEqual(result.lines, []);
  assert.equal(result.buffer, "");
});

test("doctorIpcPermissions fixes bridge-owned ipc file modes", () => {
  const paths = core.buildPaths(tempHome());
  core.ensureIpcDir(paths.ipcDir);
  const files = [
    path.join(paths.ipcDir, "123.sock"),
    path.join(paths.ipcDir, "cc-1234abcd.mailbox"),
    path.join(paths.ipcDir, "cc-1234abcd.log"),
    path.join(paths.ipcDir, "cc-1234abcd.pid"),
  ];
  for (const file of files) {
    fs.writeFileSync(file, "x", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
  }

  const dry = core.doctorIpcPermissions({ ipcDir: paths.ipcDir, fix: false });
  assert.equal(dry.findings.length >= files.length, true);

  core.doctorIpcPermissions({ ipcDir: paths.ipcDir, fix: true });
  assert.equal(fileMode(paths.ipcDir), 0o700);
  for (const file of files) assert.equal(fileMode(file), 0o600);
});

test("activeSessions filters registry socket paths outside the IPC directory", () => {
  const paths = core.buildPaths(tempHome());
  core.writeRegistry({ sessions: [
    { pid: process.pid, name: "good", cwd: process.cwd(), socketPath: path.join(paths.ipcDir, `${process.pid}.sock`), startedAt: 1 },
    { pid: process.pid, name: "bad", cwd: process.cwd(), socketPath: "/tmp/evil.sock", startedAt: 1 },
  ] }, paths.registryFile);

  const sessions = core.activeSessions({ registryFile: paths.registryFile, ipcDir: paths.ipcDir, writePruned: false });

  assert.deepEqual(sessions.map((s) => s.name), ["good"]);
});

test("withRegistryLock creates and removes an owner-only lock file", () => {
  const paths = core.buildPaths(tempHome());
  let lockPath;
  core.withRegistryLock(paths.registryFile, (createdLockPath) => {
    lockPath = createdLockPath;
    assert.equal(fs.existsSync(lockPath), true);
    assert.equal(fileMode(lockPath), 0o600);
    return "locked";
  });

  assert.equal(fs.existsSync(lockPath), false);
});

test("secure write helpers refuse symlink targets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbc-symlink-"));
  const target = path.join(dir, "target.txt");
  const link = path.join(dir, "registry.json");
  fs.writeFileSync(target, "original", "utf-8");
  fs.symlinkSync(target, link);

  assert.throws(() => core.secureWriteFile(link, "clobber"), /symbolic link|symlink|ELOOP/i);
  assert.throws(() => core.appendFileSecure(link, "append"), /symbolic link|symlink|ELOOP/i);
  assert.equal(fs.readFileSync(target, "utf-8"), "original");
});

test("bridge policy routes non-allowlisted senders to mailbox", () => {
  const policy = core.normalizeBridgePolicy({
    mode: "auto-inject",
    allowlist: [{ name: "trusted" }],
    rateLimit: { perSenderPer10s: 5 },
  });

  assert.equal(core.decideMessageDelivery(sampleMessage({ fromName: "trusted" }), policy).action, "auto-inject");
  const denied = core.decideMessageDelivery(sampleMessage({ fromName: "stranger" }), policy);
  assert.equal(denied.action, "mailbox");
  assert.match(denied.reason, /allowlist/i);

  const mailboxOnly = core.normalizeBridgePolicy({ mode: "mailbox-only" });
  assert.equal(core.decideMessageDelivery(sampleMessage({ fromName: "trusted" }), mailboxOnly).action, "mailbox");
});

test("bridge policy defaults include smart focus policy", () => {
  const policy = core.normalizeBridgePolicy({
    mode: "auto-inject",
    allowlist: [],
    rateLimit: { perSenderPer10s: 5 },
  });

  assert.equal(policy.focus.mode, "smart");
  assert.ok(policy.focus.allowedFrontmostApps.includes("Supacode"));
  assert.ok(policy.focus.allowedFrontmostApps.includes("Sublime Text"));
  assert.ok(policy.focus.allowedFrontmostApps.includes("Antigravity"));
  assert.ok(policy.focus.allowedFrontmostApps.includes("Kiro"));
  assert.ok(policy.focus.allowedFrontmostApps.includes("Windsurf"));
  assert.ok(policy.focus.allowedFrontmostApps.includes("Claude Desktop"));
  assert.ok(policy.focus.allowedFrontmostApps.includes("Codex"));
});

test("focus mode never skips valid Supacode targets", () => {
  const calls = [];
  const result = core.maybeFocusSession(
    sampleSupacodeSession(),
    {
      focus: { mode: "never" },
    },
    {
      frontmostAppName: "Supacode",
      opener: captureOpener(calls),
    },
  );

  assert.equal(result.focused, false);
  assert.match(result.reason, /never/i);
  assert.equal(calls.length, 0);
});

test("focus mode always opens valid Supacode targets regardless of frontmost app", () => {
  const calls = [];
  const result = core.maybeFocusSession(
    sampleSupacodeSession(),
    {
      focus: { mode: "always" },
    },
    {
      frontmostAppName: "Google Chrome",
      opener: captureOpener(calls),
    },
  );

  assert.equal(result.focused, true);
  assert.match(result.reason, /always/i);
  assert.deepEqual(calls, [
    {
      cmd: "open",
      args: ["supacode://worktree/worktree-123_%2Fsafe/tab/tab_456"],
      options: { stdio: "ignore" },
    },
  ]);
});

test("smart focus opens when the frontmost app is in the dev allowlist", () => {
  const allowedApps = [
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
  ];

  for (const app of allowedApps) {
    const calls = [];
    const result = core.maybeFocusSession(
      sampleSupacodeSession(),
      {
        focus: { mode: "smart" },
      },
      {
        frontmostAppName: app,
        opener: captureOpener(calls),
      },
    );

    assert.equal(result.focused, true, `${app} should allow focus`);
    assert.equal(result.frontmostApp, app);
    assert.equal(calls.length, 1, `${app} should call opener once`);
  }
});

test("smart focus skips when the frontmost app is not in the dev allowlist", () => {
  const calls = [];
  const result = core.maybeFocusSession(
    sampleSupacodeSession(),
    {
      focus: { mode: "smart" },
    },
    {
      frontmostAppName: "Google Chrome",
      opener: captureOpener(calls),
    },
  );

  assert.equal(result.focused, false);
  assert.equal(result.frontmostApp, "Google Chrome");
  assert.match(result.reason, /not allowed/i);
  assert.equal(calls.length, 0);
});

test("smart focus skips when frontmost app detection fails", () => {
  const calls = [];
  const result = core.maybeFocusSession(
    sampleSupacodeSession(),
    {
      focus: { mode: "smart" },
    },
    {
      frontmostAppProvider: () => {
        throw new Error("no accessibility permission");
      },
      opener: captureOpener(calls),
    },
  );

  assert.equal(result.focused, false);
  assert.match(result.reason, /unavailable/i);
  assert.equal(calls.length, 0);
});

test("smart focus skips sessions without Supacode focus metadata", () => {
  const calls = [];
  const result = core.maybeFocusSession(
    sampleSupacodeSession({
      supacodeWorktreeId: undefined,
      supacodeTabId: undefined,
    }),
    {
      focus: { mode: "smart" },
    },
    {
      frontmostAppName: "Supacode",
      opener: captureOpener(calls),
    },
  );

  assert.equal(result.focused, false);
  assert.match(result.reason, /no focus metadata/i);
  assert.equal(calls.length, 0);
});

test("sender rate limiter caps bursts per sender window", () => {
  const limiter = core.createSenderRateLimiter({ limit: 2, windowMs: 10_000 });
  assert.equal(limiter.check("123", 1_000).allowed, true);
  assert.equal(limiter.check("123", 2_000).allowed, true);
  const denied = limiter.check("123", 3_000);
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /rate limit/i);
  assert.equal(limiter.check("123", 12_000).allowed, true);
});

test("sanitizeSessionForDisplay strips registry control characters", () => {
  const safe = core.sanitizeSessionForDisplay({
    pid: 999,
    name: "evil\nname\u0000",
    cwd: "/tmp/project\nIGNORE ME",
    socketPath: "/tmp/999.sock",
    startedAt: 1,
  });

  assert.equal(safe.name, "evilname");
  assert.equal(safe.cwd, "/tmp/projectIGNORE ME");
  assert.match(core.duplicateCwdWarnings([{ ...safe }, { ...safe, pid: 1000, name: "other" }])[0], /evilname|other/);
  assert.doesNotMatch(core.duplicateCwdWarnings([{ ...safe }, { ...safe, pid: 1000, name: "other" }])[0], /\n/);
});

test("appendFileSecure rotates capped jsonl files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbc-rotate-"));
  const file = path.join(dir, "tool-usage.jsonl");

  core.appendFileSecure(file, "12345\n", { maxBytes: 10, backups: 1 });
  core.appendFileSecure(file, "67890\n", { maxBytes: 10, backups: 1 });

  assert.equal(fs.readFileSync(file, "utf-8"), "67890\n");
  assert.equal(fs.readFileSync(`${file}.1`, "utf-8"), "12345\n");
  assert.equal(fileMode(file), 0o600);
  assert.equal(fileMode(`${file}.1`), 0o600);
});

test("readAndClearFileAtomic preserves messages appended during mailbox read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbc-mailbox-"));
  const mailbox = path.join(dir, "cc-1234abcd.mailbox");
  fs.writeFileSync(mailbox, "first", { mode: 0o600 });

  const content = core.readAndClearFileAtomic(mailbox, {
    afterRename() {
      core.appendFileSecure(mailbox, "second");
    },
  });

  assert.equal(content, "first");
  assert.equal(fs.readFileSync(mailbox, "utf-8"), "second");
});

test("protocol version is emitted and incompatible versions are rejected", () => {
  assert.equal(core.validateBridgeMessage(sampleMessage({ protocol: 1 })).ok, true);
  assert.equal(core.validateBridgeMessage(sampleMessage({ protocol: 2 })).ok, false);

  const response = core.createSocketResponse("ack", sampleMessage({ id: "msg_proto" }), {
    fromPid: 1,
    fromName: "receiver",
    fromCwd: "/tmp/receiver",
  });
  assert.equal(response.protocol, 1);
});

test("doctorIpcPermissions reports but does not chmod symlink extra files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pbc-doctor-link-"));
  const target = path.join(dir, "target.txt");
  const link = path.join(dir, "bridge-roster.json");
  fs.writeFileSync(target, "x", { mode: 0o644 });
  fs.chmodSync(target, 0o644);
  fs.symlinkSync(target, link);

  const result = core.doctorIpcPermissions({ ipcDir: path.join(dir, "ipc"), fix: true, extraFiles: [link] });

  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  assert.equal(result.findings.some((finding) => finding.path === link && finding.issue === "symbolic-link"), true);
});

test("formatNoticeWithControls appends an explicit dismiss footer", () => {
  const notice = core.formatNoticeWithControls("Active Pi sessions:\n  • backend", {
    action: "Use /bridge-send <target> <message> to send a message.",
  });

  assert.match(notice, /Active Pi sessions/);
  assert.match(notice, /Use \/bridge-send <target> <message>/);
  assert.match(notice, /Controls:/);
  assert.match(notice, /Esc/i);
  assert.match(notice, /close/i);
  assert.equal(notice.endsWith("\n"), false);
});

test("formatMailboxNotice explains close controls and mailbox clearing", () => {
  const notice = core.formatMailboxNotice("---\nmessage body\n---");

  assert.match(notice, /message body/);
  assert.match(notice, /Mailbox was cleared when this notice opened/);
  assert.match(notice, /Esc/i);

  const empty = core.formatMailboxNotice("");
  assert.match(empty, /Bridge mailbox is empty/);
  assert.match(empty, /Controls:/);
});
