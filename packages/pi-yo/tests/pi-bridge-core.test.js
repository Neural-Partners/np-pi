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

test("bridge event journal appends owner-only JSONL events in order", () => {
  const paths = core.buildPaths(tempHome());
  const first = core.appendBridgeEvent({
    kind: "message.accepted",
    messageId: "msg_a",
    from: { pid: 1, name: "sender", cwd: "/sender" },
    to: { pid: 2, name: "receiver", cwd: "/receiver", readerKey: "pi:2" },
    content: "first",
    acceptedAt: 1000,
  }, { eventsFile: paths.eventsFile });
  const second = core.appendBridgeEvent({
    kind: "message.accepted",
    messageId: "msg_b",
    from: { pid: 1, name: "sender", cwd: "/sender" },
    to: { pid: 2, name: "receiver", cwd: "/receiver", readerKey: "pi:2" },
    content: "second",
    acceptedAt: 2000,
  }, { eventsFile: paths.eventsFile });

  assert.equal(fileMode(paths.eventsFile), 0o600);
  const events = core.readBridgeEvents({ eventsFile: paths.eventsFile });
  assert.deepEqual(events.map((event) => event.messageId), ["msg_a", "msg_b"]);
  assert.match(first.eventId, /^evt_/);
  assert.match(second.eventId, /^evt_/);
});

test("retained inbox consume advances only the selected reader cursor", () => {
  const paths = core.buildPaths(tempHome());
  core.appendBridgeEvent({
    kind: "message.accepted",
    messageId: "msg_one",
    from: { pid: 1, name: "sender", cwd: "/sender" },
    to: { pid: 2, name: "receiver", cwd: "/receiver", readerKey: "cc:abcd1234" },
    content: "one",
    acceptedAt: 1000,
  }, { eventsFile: paths.eventsFile });
  core.appendBridgeEvent({
    kind: "message.accepted",
    messageId: "msg_two",
    from: { pid: 1, name: "sender", cwd: "/sender" },
    to: { pid: 2, name: "receiver", cwd: "/receiver", readerKey: "cc:abcd1234" },
    content: "two",
    acceptedAt: 2000,
  }, { eventsFile: paths.eventsFile });

  const firstRead = core.readInboxEvents({
    readerKey: "cc:abcd1234",
    eventsFile: paths.eventsFile,
    cursorsFile: paths.cursorsFile,
  });
  assert.deepEqual(firstRead.events.map((event) => event.messageId), ["msg_one", "msg_two"]);

  core.consumeInboxEvents(firstRead, { cursorsFile: paths.cursorsFile });

  const secondRead = core.readInboxEvents({
    readerKey: "cc:abcd1234",
    eventsFile: paths.eventsFile,
    cursorsFile: paths.cursorsFile,
  });
  const otherReader = core.readInboxEvents({
    readerKey: "cc:other",
    eventsFile: paths.eventsFile,
    cursorsFile: paths.cursorsFile,
  });

  assert.deepEqual(secondRead.events, []);
  assert.deepEqual(otherReader.events, []);
  assert.equal(fileMode(paths.cursorsFile), 0o600);
});

test("retained inbox cursor follows append order when timestamps tie", () => {
  const paths = core.buildPaths(tempHome());
  core.appendBridgeEvent(
    {
      eventId: "evt_z",
      kind: "message.accepted",
      messageId: "msg_first",
      from: { pid: 1, name: "sender", cwd: "/sender" },
      to: { pid: 2, name: "receiver", cwd: "/receiver", readerKey: "cc:repo" },
      content: "first",
      acceptedAt: 1000,
    },
    { eventsFile: paths.eventsFile },
  );
  const firstRead = core.readInboxEvents({
    readerKey: "cc:repo",
    eventsFile: paths.eventsFile,
    cursorsFile: paths.cursorsFile,
  });
  assert.equal(core.consumeInboxEvents(firstRead), true);

  core.appendBridgeEvent(
    {
      eventId: "evt_a",
      kind: "message.accepted",
      messageId: "msg_second",
      from: { pid: 1, name: "sender", cwd: "/sender" },
      to: { pid: 2, name: "receiver", cwd: "/receiver", readerKey: "cc:repo" },
      content: "second",
      acceptedAt: 1000,
    },
    { eventsFile: paths.eventsFile },
  );

  const secondRead = core.readInboxEvents({
    readerKey: "cc:repo",
    eventsFile: paths.eventsFile,
    cursorsFile: paths.cursorsFile,
  });
  assert.deepEqual(secondRead.events.map((event) => event.messageId), ["msg_second"]);
});

test("recordAcceptedBridgeMessage uses local acceptance time for cursor safety", () => {
  const paths = core.buildPaths(tempHome());
  const before = Date.now();
  const recorded = core.recordAcceptedBridgeMessage({
    message: sampleMessage({ id: "msg_old_sender", timestamp: 1 }),
    to: { pid: 888, name: "receiver", cwd: "/receiver", readerKey: "pi:888" },
    eventsFile: paths.eventsFile,
  });

  assert.ok(recorded.event.acceptedAt >= before);
});

test("message duplicate detection labels repeated message ids", () => {
  const paths = core.buildPaths(tempHome());
  const first = core.recordAcceptedBridgeMessage({
    message: sampleMessage({ id: "msg_same", fromPid: 777, fromName: "sender" }),
    to: { pid: 888, name: "receiver", cwd: "/receiver", readerKey: "pi:888" },
    eventsFile: paths.eventsFile,
  });
  const duplicate = core.recordAcceptedBridgeMessage({
    message: sampleMessage({ id: "msg_same", fromPid: 777, fromName: "sender" }),
    to: { pid: 888, name: "receiver", cwd: "/receiver", readerKey: "pi:888" },
    eventsFile: paths.eventsFile,
  });

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.kind, "message.duplicate");
  assert.equal(duplicate.event.duplicateOf, first.event.eventId);

  const inbox = core.readInboxEvents({ readerKey: "pi:888", eventsFile: paths.eventsFile });
  const formatted = core.formatInboxEvents(inbox.events);
  assert.match(formatted, /hello/);
  assert.match(formatted, /\[duplicate\] msg_same already seen/);
});

test("formatInboxHookPayload emits Claude hook JSON only when content exists", () => {
  assert.equal(core.formatInboxHookPayload([]), "");

  const payload = core.formatInboxHookPayload([
    {
      eventId: "evt_1",
      kind: "message.accepted",
      messageId: "msg_one",
      acceptedAt: 1000,
      from: { pid: 1, name: "sender", cwd: "/repo/sender" },
      to: { pid: 2, name: "receiver", cwd: "/repo/receiver", readerKey: "cc:abcd" },
      content: "hello orchestrator",
      isReply: true,
    },
  ]);

  const parsed = JSON.parse(payload);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(parsed.hookSpecificOutput.additionalContext, /^\[pi-bridge inbox\]/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /hello orchestrator/);
});

test("session status normalizes to known states", () => {
  assert.equal(core.normalizeSessionStatus("working"), "working");
  assert.equal(core.normalizeSessionStatus("blocked"), "blocked");
  assert.equal(core.normalizeSessionStatus("review"), "review");
  assert.equal(core.normalizeSessionStatus("done"), "done");
  assert.equal(core.normalizeSessionStatus("idle"), "idle");
  assert.equal(core.normalizeSessionStatus("nonsense"), "unknown");
});

test("updateSessionStatus persists sanitized self-reported state", () => {
  const paths = core.buildPaths(tempHome());
  const result = core.updateSessionStatus({
    pid: 123,
    name: "agent",
    cwd: "/repo/agent",
    status: "working",
    currentTask: "Implement retained inbox",
    dispatchId: "dispatch-1",
    blockedOn: "none",
    summary: "green so far",
  }, { stateFile: paths.stateFile });

  assert.equal(result.status, "working");
  assert.equal(result.currentTask, "Implement retained inbox");
  assert.equal(fileMode(paths.stateFile), 0o600);

  const state = core.readBridgeState(paths.stateFile);
  assert.equal(state.sessions["pid:123"].dispatchId, "dispatch-1");
});

test("getGitState reports branch dirty counts and head commit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-state-"));
  const run = (cmd) => require("node:child_process").execFileSync(cmd[0], cmd.slice(1), { cwd: dir, encoding: "utf-8" });
  run(["git", "init", "-b", "master"]);
  run(["git", "config", "user.email", "test@example.com"]);
  run(["git", "config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(dir, "file.txt"), "one\n");
  run(["git", "add", "file.txt"]);
  run(["git", "commit", "-m", "initial"]);
  fs.writeFileSync(path.join(dir, "untracked.txt"), "new\n");

  const state = core.getGitState(dir, { includePr: false });
  assert.equal(state.isRepo, true);
  assert.equal(state.branch, "master");
  assert.equal(state.untracked, 1);
  assert.match(state.head, /^[a-f0-9]{7,40}$/);
  assert.equal(state.headSubject, "initial");
});

test("buildSessionStateReport combines registry state self-report and git summary", () => {
  const paths = core.buildPaths(tempHome());
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "state-report-"));
  core.writeRegistry({ sessions: [
    { pid: process.pid, name: "agent", cwd, socketPath: path.join(paths.ipcDir, `${process.pid}.sock`), startedAt: Date.now() - 60000, readerKey: `pi:${process.pid}`, lastHeartbeatAt: Date.now() },
  ] }, paths.registryFile);
  core.updateSessionStatus({
    pid: process.pid,
    name: "agent",
    cwd,
    status: "working",
    currentTask: "Testing report",
    blockedOn: "none",
  }, { stateFile: paths.stateFile });

  const report = core.buildSessionStateReport("agent", {
    registryFile: paths.registryFile,
    stateFile: paths.stateFile,
    includeGit: false,
  });

  assert.equal(report.status, "found");
  assert.match(report.text, /agent pid:/);
  assert.match(report.text, /status: working/);
  assert.match(report.text, /currentTask: Testing report/);
});

test("setSessionVisibility updates one live registry entry and preserves other sessions", () => {
  const paths = core.buildPaths(tempHome());
  core.writeRegistry({ sessions: [
    { pid: process.pid, name: "current", cwd: process.cwd(), socketPath: path.join(paths.ipcDir, `${process.pid}.sock`), startedAt: 1 },
    { pid: process.pid + 100000, name: "dead", cwd: "/tmp/dead", socketPath: path.join(paths.ipcDir, `${process.pid + 100000}.sock`), startedAt: 1 },
  ] }, paths.registryFile);

  const result = core.setSessionVisibility(process.pid, "invisible", paths.registryFile);
  const registry = core.readRegistry(paths.registryFile);

  assert.equal(result.updated, true);
  assert.equal(result.visibility, "invisible");
  assert.equal(registry.sessions.length, 1);
  assert.equal(registry.sessions[0].pid, process.pid);
  assert.equal(registry.sessions[0].bridgeVisibility, "invisible");
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

test("resolveSessionTarget ignores invisible sessions for name cwd and fuzzy matches", () => {
  const sessions = [
    { pid: 111, name: "frontend", cwd: "/workspace/frontend", socketPath: "/tmp/111.sock", startedAt: 1 },
    { pid: 222, name: "frontend", cwd: "/workspace/frontend", socketPath: "/tmp/222.sock", startedAt: 2, bridgeVisibility: "invisible" },
  ];

  const exactName = core.resolveSessionTarget("frontend", sessions);
  assert.equal(exactName.status, "found");
  assert.equal(exactName.session.pid, 111);

  const cwdBase = core.resolveSessionTarget("frontend", [sessions[1]]);
  assert.equal(cwdBase.status, "not_found");

  const cwdSuffix = core.resolveSessionTarget("workspace/frontend", [sessions[1]]);
  assert.equal(cwdSuffix.status, "not_found");

  const fuzzy = core.resolveSessionTarget("front", [sessions[1]]);
  assert.equal(fuzzy.status, "not_found");
});

test("resolveSessionTarget can target an invisible session by exact PID", () => {
  const sessions = [
    { pid: 222, name: "frontend", cwd: "/workspace/frontend", socketPath: "/tmp/222.sock", startedAt: 2, bridgeVisibility: "invisible" },
  ];

  const result = core.resolveSessionTarget("222", sessions);

  assert.equal(result.status, "found");
  assert.equal(result.matchKind, "pid");
  assert.equal(result.session.pid, 222);
});

test("duplicateCwdWarnings ignores invisible sessions by default", () => {
  const sessions = [
    { pid: 111, name: "frontend", cwd: "/workspace/frontend", socketPath: "/tmp/111.sock", startedAt: 1 },
    { pid: 222, name: "frontend standby", cwd: "/workspace/frontend", socketPath: "/tmp/222.sock", startedAt: 2, bridgeVisibility: "invisible" },
  ];

  assert.deepEqual(core.duplicateCwdWarnings(sessions), []);
  assert.equal(core.duplicateCwdWarnings(sessions, { includeInvisible: true }).length, 1);
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

test("diagnoseShimVersions reports stale local shim hashes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-diag-"));
  const packageRoot = path.join(dir, "pkg");
  const localRoot = path.join(dir, "agent");
  fs.mkdirSync(path.join(packageRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "lib"), { recursive: true });
  fs.mkdirSync(path.join(localRoot, "bin"), { recursive: true });
  fs.mkdirSync(path.join(localRoot, "lib"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "bin", "pimsg"), "same");
  fs.writeFileSync(path.join(packageRoot, "bin", "pi-cc-bridge"), "pkg");
  fs.writeFileSync(path.join(packageRoot, "lib", "pi-bridge-core.js"), "core-new");
  fs.writeFileSync(path.join(localRoot, "bin", "pimsg"), "same");
  fs.writeFileSync(path.join(localRoot, "bin", "pi-cc-bridge"), "old");
  fs.writeFileSync(path.join(localRoot, "lib", "pi-bridge-core.js"), "core-old");

  const result = core.diagnoseShimVersions({
    packageRoot,
    agentRoot: localRoot,
  });
  const stale = result.files
    .filter((file) => file.status === "stale")
    .map((file) => file.name)
    .sort();
  assert.deepEqual(stale, ["lib/pi-bridge-core.js", "pi-cc-bridge"]);
  assert.equal(result.ok, false);
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
