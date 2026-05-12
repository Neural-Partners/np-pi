# pi-yo Orchestrator Reliability Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Slice 1 of the pi-yo orchestrator reliability layer: stale-shim diagnostics, stable message IDs, retained inbox with per-reader cursors, dedup, and state/status commands for Scott's Claude Code/iTerm orchestrator + Pi/Codex/Supacode agents.

**Architecture:** Extend `pi-bridge-core.js` with small, testable primitives for event journaling, inbox cursors, state snapshots, git probes, and shim diagnostics. Wire those primitives into both runtime receivers (`extensions/pi-bridge.ts` and `bin/pi-cc-bridge`) and both human CLIs (`bin/pimsg` and `bin/pi-cc-bridge`). Keep the legacy mailbox path during rollout, but make `pi-cc-bridge inbox --format hook --consume` the new canonical Claude Code hook path.

**Tech Stack:** Node.js CommonJS core/CLI, Pi TypeScript extension, owner-only Unix IPC files under `~/.pi/agent/ipc`, Node built-in test runner, Prettier, TypeScript no-emit check for the extension.

---

## Scope

This plan implements **Slice 1 only** from the approved design:

- Phase 0: stale shim diagnostics and explicit sync command.
- Phase 1: retained event journal, stable IDs, dedup primitives.
- Phase 2: retained Claude Code inbox command and hook format.
- Phase 3 MVP: state/status snapshots and `state` commands.

Slice 2 is intentionally excluded and gets a later plan:

- orchestrator CC summaries for all direct cross-agent traffic,
- dispatch ledger,
- overdue query,
- fleet digest beyond direct inbox/status content.

This split is deliberate: Scott's two highest-leverage items were state command and cross-vendor delivery reliability. Ship those first without turning this into a bridge hairball. A modest hairball is enough.

---

## File structure and responsibilities

### Modify: `packages/pi-yo/lib/pi-bridge-core.js`

Owns all reusable pure-ish bridge primitives:

- path constants for new IPC files,
- shim diagnostics and sync helpers,
- event journal append/read/dedup,
- cursor read/write/consume,
- inbox formatting,
- state status normalization/update/read,
- git/PR probes,
- state report formatting,
- exports.

Keep this file as the compatibility layer consumed by all CLIs and the Pi extension.

### Modify: `packages/pi-yo/bin/pi-cc-bridge`

Owns Claude Code daemon behavior and Claude-facing commands:

- daemon writes accepted messages to the event journal as canonical source,
- daemon still appends to legacy mailbox for compatibility,
- daemon periodically touches heartbeat/state,
- new `inbox` command reads retained journal with per-reader cursor,
- new `state` command reports local or target state,
- `status` includes inbox unread count from journal.

### Modify: `packages/pi-yo/bin/pimsg`

Owns human CLI operations from anywhere:

- `doctor` reports stale shim diagnostics,
- `doctor --sync-shims` explicitly syncs local shims,
- `state <target>` and `state --all`,
- `list --with-status`,
- existing send path already gets `sendToSocket()` message IDs but should display receipt message ID when useful.

### Modify: `packages/pi-yo/extensions/pi-bridge.ts`

Owns Pi/Codex runtime behavior:

- every send path sets a stable message ID before socket send,
- receiver writes accepted events to the journal,
- receiver updates heartbeat/status,
- new `update_session_status` tool,
- optional `/bridge-status` command for humans,
- `list_sessions` includes status summary when available.

### Modify: `packages/pi-yo/tests/pi-bridge-core.test.js`

Core unit/integration tests for journal, inbox cursors, dedup, state, git probes, and shim diagnostics.

### Modify: `packages/pi-yo/tests/pimsg-cli.test.js`

CLI tests for `pimsg doctor`, `state`, and `list --with-status`.

### Create: `packages/pi-yo/tests/pi-cc-bridge-cli.test.js`

CLI tests for retained `pi-cc-bridge inbox`, hook JSON output, and `state` command behavior.

### Modify: `packages/pi-yo/tests/pi-package.test.js`

Static package tests for extension tool/docs/syntax coverage.

### Modify: `packages/pi-yo/README.md`

Document reliable inbox, Claude Code hook snippet, state commands, and shim sync.

### Modify: `packages/pi-yo/skills/pi-yo/SKILL.md`

Teach agents to keep status fresh and use `update_session_status` around dispatch work.

### Modify: `packages/pi-yo/package.json`

Add TypeScript extension no-emit check to `syntax`, bump package version to `0.3.0` after implementation.

---

### Task 0: Baseline guardrails and script coverage

**Files:**

- Modify: `packages/pi-yo/package.json`
- Test: `packages/pi-yo/tests/pi-package.test.js`

- [ ] **Step 1: Confirm clean worktree baseline**

Run:

```bash
cd /Users/scottblodgett/Projects/personal/np-pi/.worktrees/pi-yo-orchestrator-reliability
git status --short --branch
npm run verify --workspace @neuralpartners/pi-yo
```

Expected:

```txt
## design/pi-yo-orchestrator-reliability...origin/main [ahead 2]
# no modified files except this plan if not committed yet
# 39 tests pass
# syntax passes
```

- [ ] **Step 2: Add a failing static test requiring TypeScript extension syntax coverage**

Append this test to `packages/pi-yo/tests/pi-package.test.js`:

```js
test("package syntax script typechecks the Pi extension", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"),
  );

  assert.match(packageJson.scripts.syntax, /tsc --noEmit/);
  assert.match(packageJson.scripts.syntax, /extensions\/pi-bridge\.ts/);
  assert.match(packageJson.scripts.syntax, /--moduleResolution NodeNext/);
});
```

- [ ] **Step 3: Run the package static test and verify it fails**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-package.test.js
```

Expected failure:

```txt
not ok ... package syntax script typechecks the Pi extension
AssertionError ... expected 'node -c lib/pi-bridge-core.js ...' to match /tsc --noEmit/
```

- [ ] **Step 4: Update `packages/pi-yo/package.json` syntax script**

Change scripts from:

```json
"syntax": "node -c lib/pi-bridge-core.js && node -c bin/pimsg && node -c bin/pi-cc-bridge",
"verify": "npm run test && npm run syntax"
```

to:

```json
"syntax": "node -c lib/pi-bridge-core.js && node -c bin/pimsg && node -c bin/pi-cc-bridge && tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck --strict --esModuleInterop extensions/pi-bridge.ts",
"verify": "npm run test && npm run syntax"
```

- [ ] **Step 5: Run package static test and syntax**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-package.test.js
npm run syntax --workspace @neuralpartners/pi-yo
```

Expected:

```txt
# package static tests pass
# node -c checks pass
# TypeScript no-emit check passes
```

- [ ] **Step 6: Commit**

Run:

```bash
git add packages/pi-yo/package.json packages/pi-yo/tests/pi-package.test.js
git commit -m "test(pi-yo): cover extension typecheck in syntax"
```

---

### Task 1: Add core event journal and retained inbox primitives

**Files:**

- Modify: `packages/pi-yo/lib/pi-bridge-core.js`
- Test: `packages/pi-yo/tests/pi-bridge-core.test.js`

- [ ] **Step 1: Add failing tests for event log paths, append/read, and owner-only modes**

Append these tests near the existing filesystem/security tests in `packages/pi-yo/tests/pi-bridge-core.test.js`:

```js
test("bridge event journal appends owner-only JSONL events in order", () => {
  const paths = core.buildPaths(tempHome());
  const first = core.appendBridgeEvent(
    {
      kind: "message.accepted",
      messageId: "msg_a",
      from: { pid: 1, name: "sender", cwd: "/sender" },
      to: { pid: 2, name: "receiver", cwd: "/receiver", readerKey: "pi:2" },
      content: "first",
      acceptedAt: 1000,
    },
    { eventsFile: paths.eventsFile },
  );
  const second = core.appendBridgeEvent(
    {
      kind: "message.accepted",
      messageId: "msg_b",
      from: { pid: 1, name: "sender", cwd: "/sender" },
      to: { pid: 2, name: "receiver", cwd: "/receiver", readerKey: "pi:2" },
      content: "second",
      acceptedAt: 2000,
    },
    { eventsFile: paths.eventsFile },
  );

  assert.equal(fileMode(paths.eventsFile), 0o600);
  const events = core.readBridgeEvents({ eventsFile: paths.eventsFile });
  assert.deepEqual(
    events.map((event) => event.messageId),
    ["msg_a", "msg_b"],
  );
  assert.match(first.eventId, /^evt_/);
  assert.match(second.eventId, /^evt_/);
});
```

- [ ] **Step 2: Add failing tests for per-reader cursor consumption**

Append:

```js
test("retained inbox consume advances only the selected reader cursor", () => {
  const paths = core.buildPaths(tempHome());
  core.appendBridgeEvent(
    {
      kind: "message.accepted",
      messageId: "msg_one",
      from: { pid: 1, name: "sender", cwd: "/sender" },
      to: {
        pid: 2,
        name: "receiver",
        cwd: "/receiver",
        readerKey: "cc:abcd1234",
      },
      content: "one",
      acceptedAt: 1000,
    },
    { eventsFile: paths.eventsFile },
  );
  core.appendBridgeEvent(
    {
      kind: "message.accepted",
      messageId: "msg_two",
      from: { pid: 1, name: "sender", cwd: "/sender" },
      to: {
        pid: 2,
        name: "receiver",
        cwd: "/receiver",
        readerKey: "cc:abcd1234",
      },
      content: "two",
      acceptedAt: 2000,
    },
    { eventsFile: paths.eventsFile },
  );

  const firstRead = core.readInboxEvents({
    readerKey: "cc:abcd1234",
    eventsFile: paths.eventsFile,
    cursorsFile: paths.cursorsFile,
  });
  assert.deepEqual(
    firstRead.events.map((event) => event.messageId),
    ["msg_one", "msg_two"],
  );

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
```

- [ ] **Step 3: Add failing tests for dedup labeling and hook formatting**

Append:

```js
test("message duplicate detection labels repeated message ids", () => {
  const paths = core.buildPaths(tempHome());
  const first = core.recordAcceptedBridgeMessage({
    message: sampleMessage({
      id: "msg_same",
      fromPid: 777,
      fromName: "sender",
    }),
    to: { pid: 888, name: "receiver", cwd: "/receiver", readerKey: "pi:888" },
    eventsFile: paths.eventsFile,
  });
  const duplicate = core.recordAcceptedBridgeMessage({
    message: sampleMessage({
      id: "msg_same",
      fromPid: 777,
      fromName: "sender",
    }),
    to: { pid: 888, name: "receiver", cwd: "/receiver", readerKey: "pi:888" },
    eventsFile: paths.eventsFile,
  });

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.kind, "message.duplicate");
  assert.equal(duplicate.event.duplicateOf, first.event.eventId);

  const inbox = core.readInboxEvents({
    readerKey: "pi:888",
    eventsFile: paths.eventsFile,
  });
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
      to: {
        pid: 2,
        name: "receiver",
        cwd: "/repo/receiver",
        readerKey: "cc:abcd",
      },
      content: "hello orchestrator",
      isReply: true,
    },
  ]);

  const parsed = JSON.parse(payload);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(
    parsed.hookSpecificOutput.additionalContext,
    /^\[pi-bridge inbox\]/,
  );
  assert.match(
    parsed.hookSpecificOutput.additionalContext,
    /hello orchestrator/,
  );
});
```

- [ ] **Step 4: Run targeted tests and verify they fail**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-bridge-core.test.js
```

Expected failures reference missing functions/properties:

```txt
TypeError: core.appendBridgeEvent is not a function
TypeError: core.readInboxEvents is not a function
TypeError: core.recordAcceptedBridgeMessage is not a function
TypeError: core.formatInboxHookPayload is not a function
```

- [ ] **Step 5: Extend `buildPaths()` and IPC ownership matching**

In `packages/pi-yo/lib/pi-bridge-core.js`, change `buildPaths()` to:

```js
function buildPaths(home = os.homedir()) {
  const ipcDir = path.join(home, ".pi", "agent", "ipc");
  return {
    ipcDir,
    registryFile: path.join(ipcDir, "registry.json"),
    eventsFile: path.join(ipcDir, "bridge-events.jsonl"),
    cursorsFile: path.join(ipcDir, "bridge-cursors.json"),
    stateFile: path.join(ipcDir, "bridge-state.json"),
  };
}
```

Update `bridgeOwnedIpcFile()` so the return expression includes:

```js
fileName === "bridge-events.jsonl" ||
fileName === "bridge-cursors.json" ||
fileName === "bridge-state.json" ||
```

- [ ] **Step 6: Add event/cursor helpers before `doctorIpcPermissions()`**

Insert this block before `function doctorIpcPermissions(options = {}) {`:

```js
function normalizeReaderKey(value) {
  return sanitizeMetadata(value, 256).toLowerCase();
}

function sessionReaderKey(session) {
  if (!session) return "unknown";
  if (session.readerKey) return normalizeReaderKey(session.readerKey);
  if (session.name && /\(CC\)$/.test(String(session.name))) {
    return `cc:${crypto
      .createHash("sha256")
      .update(String(session.cwd || ""))
      .digest("hex")
      .slice(0, 8)}`;
  }
  if (Number.isSafeInteger(session.pid) && session.pid > 0)
    return `pi:${session.pid}`;
  return `cwd:${crypto
    .createHash("sha256")
    .update(String(session.cwd || "unknown"))
    .digest("hex")
    .slice(0, 12)}`;
}

function newEventId(prefix = "evt") {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function sanitizeBridgeParty(party = {}) {
  return {
    pid:
      Number.isSafeInteger(party.pid) && party.pid > 0 ? party.pid : undefined,
    name: sanitizeMetadata(party.name, 200),
    cwd: sanitizeMetadata(party.cwd, 2048),
    readerKey: party.readerKey
      ? normalizeReaderKey(party.readerKey)
      : undefined,
  };
}

function readBridgeEvents(options = {}) {
  const eventsFile = options.eventsFile || DEFAULT_PATHS.eventsFile;
  try {
    assertNotSymlink(eventsFile);
    const raw = fs.readFileSync(eventsFile, "utf-8");
    const events = [];
    let malformed = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof parsed.eventId === "string"
        )
          events.push(parsed);
        else malformed += 1;
      } catch {
        malformed += 1;
      }
    }
    if (options.withDiagnostics) return { events, malformed };
    return events;
  } catch (err) {
    if (err && err.code === "ENOENT")
      return options.withDiagnostics ? { events: [], malformed: 0 } : [];
    throw err;
  }
}

function appendBridgeEvent(input, options = {}) {
  const eventsFile = options.eventsFile || DEFAULT_PATHS.eventsFile;
  const now = Date.now();
  const event = {
    schemaVersion: 1,
    eventId: input.eventId || newEventId(),
    kind: input.kind || "message.accepted",
    acceptedAt: Number.isFinite(input.acceptedAt) ? input.acceptedAt : now,
    messageId: input.messageId
      ? sanitizeMetadata(input.messageId, 256)
      : undefined,
    from: sanitizeBridgeParty(input.from),
    to: sanitizeBridgeParty(input.to),
    isReply: input.isReply === true,
    dispatchId: input.dispatchId
      ? sanitizeMetadata(input.dispatchId, 256)
      : undefined,
    content:
      input.content === undefined
        ? undefined
        : truncateContent(input.content).text,
    contentBytes:
      input.content === undefined ? 0 : byteLength(String(input.content)),
    duplicateOf: input.duplicateOf || null,
  };
  appendFileSecure(eventsFile, JSON.stringify(event) + "\n", {
    maxBytes: options.maxBytes || DEFAULT_TOOL_USAGE_MAX_BYTES,
    backups: options.backups || DEFAULT_TOOL_USAGE_BACKUPS,
  });
  return event;
}

function messageIdentityKey(eventOrMessage) {
  const messageId = sanitizeMetadata(
    (eventOrMessage && eventOrMessage.messageId) ||
      (eventOrMessage && eventOrMessage.id),
    256,
  );
  const fromPid =
    eventOrMessage &&
    (eventOrMessage.fromPid ||
      (eventOrMessage.from && eventOrMessage.from.pid));
  const fromName = sanitizeMetadata(
    eventOrMessage &&
      (eventOrMessage.fromName ||
        (eventOrMessage.from && eventOrMessage.from.name)),
    200,
  );
  return `${messageId}|${fromPid || "unknown"}|${fromName}`;
}

function findExistingMessageEvent(message, events) {
  const key = messageIdentityKey(message);
  return events.find(
    (event) =>
      event.kind === "message.accepted" && messageIdentityKey(event) === key,
  );
}

function recordAcceptedBridgeMessage(options = {}) {
  const message = ensureMessageId(options.message || {});
  const eventsFile = options.eventsFile || DEFAULT_PATHS.eventsFile;
  const existing = findExistingMessageEvent(
    message,
    readBridgeEvents({ eventsFile }),
  );
  const to = sanitizeBridgeParty(options.to || {});
  if (!to.readerKey) to.readerKey = sessionReaderKey(to);
  const event = appendBridgeEvent(
    {
      kind: existing ? "message.duplicate" : "message.accepted",
      messageId: message.id,
      from: {
        pid: message.fromPid,
        name: message.fromName,
        cwd: message.fromCwd,
      },
      to,
      isReply: message.isReply === true,
      dispatchId: message.dispatchId,
      content: message.content,
      duplicateOf: existing ? existing.eventId : null,
      acceptedAt: message.timestamp,
    },
    { eventsFile },
  );
  return { duplicate: Boolean(existing), event };
}

function readBridgeCursors(cursorsFile = DEFAULT_PATHS.cursorsFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorsFile, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function writeBridgeCursors(cursors, cursorsFile = DEFAULT_PATHS.cursorsFile) {
  secureWriteFile(cursorsFile, JSON.stringify(cursors || {}, null, 2));
}

function readInboxEvents(options = {}) {
  const readerKey = normalizeReaderKey(options.readerKey);
  const cursorsFile = options.cursorsFile || DEFAULT_PATHS.cursorsFile;
  const eventsFile = options.eventsFile || DEFAULT_PATHS.eventsFile;
  const cursors = readBridgeCursors(cursorsFile);
  const cursor = cursors[readerKey] || { acceptedAt: 0, eventId: "" };
  const allEvents = readBridgeEvents({ eventsFile });
  const events = allEvents.filter((event) => {
    const eventReader = normalizeReaderKey(
      event && event.to && event.to.readerKey,
    );
    if (eventReader !== readerKey) return false;
    if (options.all === true) return true;
    if ((event.acceptedAt || 0) > (cursor.acceptedAt || 0)) return true;
    if (
      (event.acceptedAt || 0) === (cursor.acceptedAt || 0) &&
      String(event.eventId) > String(cursor.eventId || "")
    )
      return true;
    return false;
  });
  return { readerKey, events, cursorsFile, latest: events[events.length - 1] };
}

function consumeInboxEvents(inbox, options = {}) {
  if (!inbox || !inbox.readerKey || !inbox.latest) return false;
  const cursorsFile =
    options.cursorsFile || inbox.cursorsFile || DEFAULT_PATHS.cursorsFile;
  const cursors = readBridgeCursors(cursorsFile);
  cursors[inbox.readerKey] = {
    acceptedAt: inbox.latest.acceptedAt || Date.now(),
    eventId: inbox.latest.eventId,
    consumedAt: Date.now(),
  };
  writeBridgeCursors(cursors, cursorsFile);
  return true;
}

function formatBridgeTimestamp(value) {
  const date = new Date(Number(value) || Date.now());
  return date.toLocaleString();
}

function formatInboxEvents(events, options = {}) {
  if (!Array.isArray(events) || events.length === 0) return "";
  return events
    .map((event) => {
      const sender = `${sanitizeMetadata(event.from && event.from.name, 200)} (${path.basename(sanitizeMetadata(event.from && event.from.cwd, 1000))})`;
      if (event.kind === "message.duplicate") {
        return `[duplicate] ${sanitizeMetadata(event.messageId, 256)} already seen at ${formatBridgeTimestamp(event.acceptedAt)} from ${sender}`;
      }
      const reply = event.isReply ? "  (reply)" : "";
      return [
        "---",
        `📨 From: ${sender}  |  ${formatBridgeTimestamp(event.acceptedAt)}${reply}`,
        event.messageId
          ? `Message-ID: ${sanitizeMetadata(event.messageId, 256)}`
          : "",
        "",
        String(event.content || ""),
        "",
        event.isReply
          ? "_This is a reply — no further reply needed._"
          : "_Please reply with reply_to_session or pimsg --reply after processing._",
      ]
        .filter((line) => line !== "")
        .join("\n");
    })
    .join("\n\n");
}

function formatInboxHookPayload(events) {
  const formatted = formatInboxEvents(events).trim();
  if (!formatted) return "";
  return JSON.stringify(
    {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `[pi-bridge inbox]\n${formatted}`,
      },
    },
    null,
    2,
  );
}
```

- [ ] **Step 7: Export new helpers**

Add these names to `module.exports`:

```js
appendBridgeEvent,
consumeInboxEvents,
findExistingMessageEvent,
formatInboxEvents,
formatInboxHookPayload,
messageIdentityKey,
newEventId,
normalizeReaderKey,
readBridgeCursors,
readBridgeEvents,
readInboxEvents,
recordAcceptedBridgeMessage,
sessionReaderKey,
writeBridgeCursors,
```

- [ ] **Step 8: Run targeted tests**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-bridge-core.test.js
```

Expected:

```txt
# new journal/inbox tests pass
# existing core tests pass
```

- [ ] **Step 9: Commit**

Run:

```bash
git add packages/pi-yo/lib/pi-bridge-core.js packages/pi-yo/tests/pi-bridge-core.test.js
git commit -m "feat(pi-yo): add retained bridge inbox primitives"
```

---

### Task 2: Wire retained journal into Pi and Claude Code receivers

**Files:**

- Modify: `packages/pi-yo/bin/pi-cc-bridge`
- Modify: `packages/pi-yo/extensions/pi-bridge.ts`
- Test: `packages/pi-yo/tests/pi-package.test.js`
- Test: `packages/pi-yo/tests/pi-bridge-core.test.js` indirectly through full package test

- [ ] **Step 1: Add static failing package test for receiver journaling and message IDs**

Append to `packages/pi-yo/tests/pi-package.test.js`:

```js
test("receivers record accepted messages and extension send paths ensure ids", () => {
  const ccBridge = fs.readFileSync(
    path.join(packageRoot, "bin", "pi-cc-bridge"),
    "utf-8",
  );
  const extension = fs.readFileSync(
    path.join(packageRoot, "extensions", "pi-bridge.ts"),
    "utf-8",
  );

  assert.match(ccBridge, /recordAcceptedBridgeMessage/);
  assert.match(ccBridge, /sessionReaderKey/);
  assert.match(extension, /recordAcceptedBridgeMessage/);
  assert.match(extension, /ensureMessageId/);
  assert.match(extension, /readerKey: bridgeCore\.sessionReaderKey/);
});
```

- [ ] **Step 2: Run static test and verify it fails**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-package.test.js
```

Expected failure:

```txt
not ok ... receivers record accepted messages and extension send paths ensure ids
AssertionError ... expected ... to match /recordAcceptedBridgeMessage/
```

- [ ] **Step 3: Update `bin/pi-cc-bridge` to compute its reader key**

Near the `META_FILE` constant, add:

```js
const READER_KEY = `cc:${cwdHash}`;
```

In the `registerSession({...})` call inside `runDaemon()`, add:

```js
readerKey: READER_KEY,
lastHeartbeatAt: Date.now(),
```

- [ ] **Step 4: Add a `recordAcceptedMessage()` helper in `bin/pi-cc-bridge`**

Insert after `writeSocketResponse()`:

```js
function recordAcceptedMessage(msg) {
  return core.recordAcceptedBridgeMessage({
    message: msg,
    to: {
      pid: process.pid,
      name,
      cwd,
      readerKey: READER_KEY,
    },
  });
}
```

- [ ] **Step 5: Call journaling from the Claude Code receiver before legacy mailbox append**

In `runDaemon()` inside the `if (msg.type === "message")` block, replace:

```js
appendToMailbox(msg);
writeSocketResponse(socket, socketResponse("ack", msg));
```

with:

```js
const recorded = recordAcceptedMessage(msg);
appendToMailbox(msg);
writeSocketResponse(
  socket,
  socketResponse("ack", msg, {
    eventId: recorded.event.eventId,
    duplicate: recorded.duplicate,
  }),
);
```

Do not remove legacy `appendToMailbox()` in this slice.

- [ ] **Step 6: Update `socketResponse()` signature in `bin/pi-cc-bridge`**

Change:

```js
function socketResponse(type, msg) {
  return core.createSocketResponse(type, msg, {
    fromPid: process.pid,
    fromName: name,
    fromCwd: cwd,
  });
}
```

to:

```js
function socketResponse(type, msg, extra = {}) {
  return core.createSocketResponse(
    type,
    msg,
    {
      fromPid: process.pid,
      fromName: name,
      fromCwd: cwd,
    },
    extra,
  );
}
```

- [ ] **Step 7: Update Pi extension send helper to ensure message IDs**

In `packages/pi-yo/extensions/pi-bridge.ts`, change `sendToSocket()` from:

```ts
async function sendToSocket(
  socketPath: string,
  message: BridgeMessage,
): Promise<any> {
  return bridgeCore.sendToSocket(socketPath, message);
}
```

to:

```ts
async function sendToSocket(
  socketPath: string,
  message: BridgeMessage,
): Promise<any> {
  return bridgeCore.sendToSocket(
    socketPath,
    bridgeCore.ensureMessageId(message),
  );
}
```

- [ ] **Step 8: Add Pi extension receiver journaling helper**

Inside the extension function, after `setMyVisibility()`, add:

```ts
function myReaderKey(): string {
  return bridgeCore.sessionReaderKey({
    pid: myPid,
    name: myName,
    cwd: currentCtx?.cwd ?? process.cwd(),
  });
}

function recordAcceptedMessage(msg: BridgeMessage, ctx: ExtensionContext): any {
  return bridgeCore.recordAcceptedBridgeMessage({
    message: msg,
    to: {
      pid: myPid,
      name: myName,
      cwd: ctx.cwd,
      readerKey: bridgeCore.sessionReaderKey({
        pid: myPid,
        name: myName,
        cwd: ctx.cwd,
      }),
    },
  });
}
```

- [ ] **Step 9: Call Pi extension journaling before delivery policy action**

In `handleIncoming(msg, ctx)`, immediately after the `ping` block and before `const policy = readPolicy();`, add:

```ts
const recorded = recordAcceptedMessage(msg, ctx);
```

Keep `recorded` in scope for ACK details by returning it from `handleIncoming()`.

Change function signature from:

```ts
function handleIncoming(msg: BridgeMessage, ctx: ExtensionContext): void {
```

to:

```ts
function handleIncoming(msg: BridgeMessage, ctx: ExtensionContext): any {
```

For ping branch, return undefined:

```ts
if (msg.type === "ping") {
  ctx.ui.notify(`📡 Ping from ${sender}`, "info");
  return undefined;
}
```

At both message delivery exits, return `recorded`:

```ts
return recorded;
```

- [ ] **Step 10: Include journal receipt details in Pi extension ACK**

In the socket server data handler, replace:

```ts
handleIncoming(msg, ctx);
const responseType = msg.type === "ping" ? "pong" : "ack";
const response = bridgeCore.createSocketResponse(responseType, msg, {
  fromPid: myPid,
  fromName: myName,
  fromCwd: ctx.cwd,
});
```

with:

```ts
const recorded = handleIncoming(msg, ctx);
const responseType = msg.type === "ping" ? "pong" : "ack";
const response = bridgeCore.createSocketResponse(
  responseType,
  msg,
  {
    fromPid: myPid,
    fromName: myName,
    fromCwd: ctx.cwd,
  },
  recorded
    ? {
        eventId: recorded.event.eventId,
        duplicate: recorded.duplicate,
      }
    : {},
);
```

- [ ] **Step 11: Add `readerKey` and heartbeat to Pi registry entries**

In the `registerSession({...})` object in `session_start`, add:

```ts
readerKey: bridgeCore.sessionReaderKey({ pid: myPid, name: myName, cwd: ctx.cwd }),
lastHeartbeatAt: Date.now(),
```

- [ ] **Step 12: Run static/package tests and extension syntax**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-package.test.js
npm run syntax --workspace @neuralpartners/pi-yo
```

Expected:

```txt
# static tests pass
# TypeScript extension check passes
```

- [ ] **Step 13: Commit**

Run:

```bash
git add packages/pi-yo/bin/pi-cc-bridge packages/pi-yo/extensions/pi-bridge.ts packages/pi-yo/tests/pi-package.test.js
git commit -m "feat(pi-yo): journal accepted bridge messages"
```

---

### Task 3: Add retained `pi-cc-bridge inbox` command

**Files:**

- Create: `packages/pi-yo/tests/pi-cc-bridge-cli.test.js`
- Modify: `packages/pi-yo/bin/pi-cc-bridge`
- Modify: `packages/pi-yo/tests/pi-package.test.js`

- [ ] **Step 1: Create failing CLI tests for inbox formatting and consumption**

Create `packages/pi-yo/tests/pi-cc-bridge-cli.test.js`:

```js
#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const core = require("../lib/pi-bridge-core.js");
const bridge = path.resolve(__dirname, "..", "bin", "pi-cc-bridge");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-home-"));
}

function runBridge(home, cwd, args) {
  return spawnSync(process.execPath, [bridge, ...args], {
    cwd,
    env: { ...process.env, HOME: home },
    encoding: "utf-8",
  });
}

function ccReaderKey(cwd) {
  return `cc:${crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8)}`;
}

test("pi-cc-bridge inbox reads retained events and consume advances only its cursor", () => {
  const home = tempHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cwd-"));
  const paths = core.buildPaths(home);
  const readerKey = ccReaderKey(cwd);

  core.appendBridgeEvent(
    {
      kind: "message.accepted",
      messageId: "msg_1",
      from: { pid: 111, name: "agent", cwd: "/repo/agent" },
      to: { pid: 222, name: `${path.basename(cwd)} (CC)`, cwd, readerKey },
      content: "first retained message",
      acceptedAt: 1000,
    },
    { eventsFile: paths.eventsFile },
  );

  const first = runBridge(home, cwd, ["inbox", "--consume"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /first retained message/);
  assert.match(first.stdout, /Message-ID: msg_1/);

  const second = runBridge(home, cwd, ["inbox"]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /\(no new messages\)/);

  const all = runBridge(home, cwd, ["inbox", "--all"]);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /first retained message/);
});

test("pi-cc-bridge inbox hook format emits valid Claude hook JSON", () => {
  const home = tempHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cwd-"));
  const paths = core.buildPaths(home);
  const readerKey = ccReaderKey(cwd);

  core.appendBridgeEvent(
    {
      kind: "message.accepted",
      messageId: "msg_hook",
      from: { pid: 111, name: "agent", cwd: "/repo/agent" },
      to: { pid: 222, name: `${path.basename(cwd)} (CC)`, cwd, readerKey },
      content: "hook message",
      acceptedAt: 1000,
    },
    { eventsFile: paths.eventsFile },
  );

  const result = runBridge(home, cwd, [
    "inbox",
    "--format",
    "hook",
    "--consume",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(parsed.hookSpecificOutput.additionalContext, /hook message/);

  const empty = runBridge(home, cwd, [
    "inbox",
    "--format",
    "hook",
    "--consume",
  ]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout.trim(), "");
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-cc-bridge-cli.test.js
```

Expected failure:

```txt
Unknown command: inbox
```

- [ ] **Step 3: Add inbox helper functions to `bin/pi-cc-bridge`**

After `cmdMailbox()`, add:

```js
function cmdInbox(args = []) {
  ensureIpcDir();
  const consume = args.includes("--consume");
  const all = args.includes("--all");
  const formatIndex = args.indexOf("--format");
  const format = formatIndex >= 0 ? args[formatIndex + 1] : "text";
  const inbox = core.readInboxEvents({
    readerKey: READER_KEY,
    all,
  });

  if (format === "hook") {
    const payload = core.formatInboxHookPayload(inbox.events);
    if (payload) process.stdout.write(payload + "\n");
  } else {
    const formatted = core.formatInboxEvents(inbox.events).trim();
    console.log(formatted || "(no new messages)");
  }

  if (consume && inbox.events.length > 0) {
    core.consumeInboxEvents(inbox);
  }
}
```

- [ ] **Step 4: Wire command dispatch**

In the `switch (cmd)` block, add:

```js
case "inbox": cmdInbox(process.argv.slice(3)); break;
```

Update the usage string in the default branch from:

```js
Usage: pi - cc - bridge[start | status | mailbox | stop];
```

to:

```js
Usage: pi - cc - bridge[start | status | mailbox | inbox | state | stop];
```

- [ ] **Step 5: Update top-of-file usage comment**

Add this line to the usage comment:

```txt
 *   pi-cc-bridge inbox       Print retained inbox events without clearing the journal
```

- [ ] **Step 6: Run new CLI tests**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-cc-bridge-cli.test.js
```

Expected:

```txt
# 2 tests pass
```

- [ ] **Step 7: Run package syntax**

Run:

```bash
npm run syntax --workspace @neuralpartners/pi-yo
```

Expected:

```txt
# JS syntax passes
# TS extension no-emit passes
```

- [ ] **Step 8: Commit**

Run:

```bash
git add packages/pi-yo/bin/pi-cc-bridge packages/pi-yo/tests/pi-cc-bridge-cli.test.js
git commit -m "feat(pi-yo): add retained Claude Code inbox"
```

---

### Task 4: Add state/status core primitives

**Files:**

- Modify: `packages/pi-yo/lib/pi-bridge-core.js`
- Test: `packages/pi-yo/tests/pi-bridge-core.test.js`

- [ ] **Step 1: Add failing tests for status normalization and self-reported state**

Append to `packages/pi-yo/tests/pi-bridge-core.test.js`:

```js
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
  const result = core.updateSessionStatus(
    {
      pid: 123,
      name: "agent",
      cwd: "/repo/agent",
      status: "working",
      currentTask: "Implement retained inbox",
      dispatchId: "dispatch-1",
      blockedOn: "none",
      summary: "green so far",
    },
    { stateFile: paths.stateFile },
  );

  assert.equal(result.status, "working");
  assert.equal(result.currentTask, "Implement retained inbox");
  assert.equal(fileMode(paths.stateFile), 0o600);

  const state = core.readBridgeState(paths.stateFile);
  assert.equal(state.sessions["pid:123"].dispatchId, "dispatch-1");
});
```

- [ ] **Step 2: Add failing test for git state probe**

Append:

```js
test("getGitState reports branch dirty counts and head commit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-state-"));
  const run = (cmd) =>
    require("node:child_process").execFileSync(cmd[0], cmd.slice(1), {
      cwd: dir,
      encoding: "utf-8",
    });
  run(["git", "init"]);
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
```

- [ ] **Step 3: Add failing test for state report formatting**

Append:

```js
test("buildSessionStateReport combines registry state self-report and git summary", () => {
  const paths = core.buildPaths(tempHome());
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "state-report-"));
  core.writeRegistry(
    {
      sessions: [
        {
          pid: process.pid,
          name: "agent",
          cwd,
          socketPath: path.join(paths.ipcDir, `${process.pid}.sock`),
          startedAt: Date.now() - 60000,
          readerKey: `pi:${process.pid}`,
          lastHeartbeatAt: Date.now(),
        },
      ],
    },
    paths.registryFile,
  );
  core.updateSessionStatus(
    {
      pid: process.pid,
      name: "agent",
      cwd,
      status: "working",
      currentTask: "Testing report",
      blockedOn: "none",
    },
    { stateFile: paths.stateFile },
  );

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
```

- [ ] **Step 4: Run targeted tests and verify they fail**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-bridge-core.test.js
```

Expected failures reference missing functions:

```txt
TypeError: core.normalizeSessionStatus is not a function
TypeError: core.updateSessionStatus is not a function
TypeError: core.getGitState is not a function
```

- [ ] **Step 5: Add state helpers before `doctorIpcPermissions()`**

Insert this block after the inbox helper block from Task 1:

```js
const SESSION_STATUSES = Object.freeze([
  "idle",
  "working",
  "blocked",
  "review",
  "done",
  "unknown",
]);

function normalizeSessionStatus(value) {
  return SESSION_STATUSES.includes(value) ? value : "unknown";
}

function stateSessionKey(input = {}) {
  if (Number.isSafeInteger(input.pid) && input.pid > 0)
    return `pid:${input.pid}`;
  return sessionReaderKey(input);
}

function readBridgeState(stateFile = DEFAULT_PATHS.stateFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    return {
      schemaVersion: 1,
      sessions:
        parsed && parsed.sessions && typeof parsed.sessions === "object"
          ? parsed.sessions
          : {},
    };
  } catch {
    return { schemaVersion: 1, sessions: {} };
  }
}

function writeBridgeState(state, stateFile = DEFAULT_PATHS.stateFile) {
  secureWriteFile(
    stateFile,
    JSON.stringify(
      { schemaVersion: 1, sessions: state.sessions || {} },
      null,
      2,
    ),
  );
}

function updateSessionStatus(input = {}, options = {}) {
  const stateFile = options.stateFile || DEFAULT_PATHS.stateFile;
  const state = readBridgeState(stateFile);
  const key = stateSessionKey(input);
  const current = state.sessions[key] || {};
  const next = {
    ...current,
    pid: Number.isSafeInteger(input.pid) ? input.pid : current.pid,
    name: sanitizeMetadata(input.name || current.name, 200),
    cwd: sanitizeMetadata(input.cwd || current.cwd, 2048),
    readerKey: input.readerKey
      ? normalizeReaderKey(input.readerKey)
      : current.readerKey,
    status: normalizeSessionStatus(input.status || current.status),
    currentTask:
      input.currentTask !== undefined
        ? sanitizeMetadata(input.currentTask, 1000)
        : current.currentTask,
    dispatchId:
      input.dispatchId !== undefined
        ? sanitizeMetadata(input.dispatchId, 256)
        : current.dispatchId,
    blockedOn:
      input.blockedOn !== undefined
        ? sanitizeMetadata(input.blockedOn, 1000)
        : current.blockedOn,
    summary:
      input.summary !== undefined
        ? sanitizeMetadata(input.summary, 2000)
        : current.summary,
    updatedAt: Date.now(),
  };
  state.sessions[key] = next;
  writeBridgeState(state, stateFile);
  return next;
}

function execGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2000,
  }).trim();
}

function getGitState(cwd, options = {}) {
  try {
    execGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { isRepo: false };
  }
  let status = "";
  try {
    status = execGit(cwd, ["status", "--porcelain=v1", "--branch"]);
  } catch {}
  const lines = status.split("\n").filter(Boolean);
  const branchLine =
    lines.find((line) => line.startsWith("## ")) || "## unknown";
  const branch = branchLine
    .replace(/^##\s+/, "")
    .split("...")[0]
    .trim();
  const changes = lines.filter((line) => !line.startsWith("## "));
  let head = "unknown";
  let headSubject = "unknown";
  try {
    head = execGit(cwd, ["rev-parse", "--short", "HEAD"]);
  } catch {}
  try {
    headSubject = execGit(cwd, ["log", "-1", "--pretty=%s"]);
  } catch {}
  return {
    isRepo: true,
    branch,
    dirty: changes.filter((line) => !line.startsWith("??")).length,
    untracked: changes.filter((line) => line.startsWith("??")).length,
    head,
    headSubject,
  };
}

function findSessionState(session, state) {
  const byPid = state.sessions[`pid:${session.pid}`];
  if (byPid) return byPid;
  const byReader = state.sessions[sessionReaderKey(session)];
  return byReader || {};
}

function buildOneSessionStateText(session, options = {}) {
  const state = readBridgeState(options.stateFile || DEFAULT_PATHS.stateFile);
  const self = findSessionState(session, state);
  const safe = sanitizeSessionForDisplay(session);
  const alive = isProcessAlive(session.pid) ? "alive" : "dead";
  const visibility = normalizeBridgeVisibility(session.bridgeVisibility);
  const status = normalizeSessionStatus(self.status);
  const heartbeat = session.lastHeartbeatAt
    ? `${Math.round((Date.now() - session.lastHeartbeatAt) / 1000)}s ago`
    : "unknown";
  const lines = [
    `${safe.name} pid:${session.pid} ${alive} ${visibility}`,
    `cwd: ${safe.cwd}`,
    `running: ${Math.round((Date.now() - session.startedAt) / 60000)}m  lastHeartbeat: ${heartbeat}`,
    `status: ${status}${self.dispatchId ? `  dispatch: ${self.dispatchId}` : ""}`,
    `currentTask: ${self.currentTask || "unknown"}`,
    `blockedOn: ${self.blockedOn || "none"}`,
  ];
  if (options.includeGit !== false) {
    const git = getGitState(session.cwd, { includePr: options.includePr });
    if (git.isRepo)
      lines.push(
        `git: ${git.branch} dirty:${git.dirty} untracked:${git.untracked} head:${git.head} ${git.headSubject}`,
      );
    else lines.push("git: not a repository or unavailable");
  }
  if (self.summary) lines.push(`summary: ${self.summary}`);
  return lines.join("\n");
}

function buildSessionStateReport(target, options = {}) {
  const sessions = activeSessions({
    registryFile: options.registryFile || DEFAULT_PATHS.registryFile,
  });
  if (target === "--all" || target === "all") {
    return {
      status: "found",
      sessions,
      text:
        sessions
          .map((session) => buildOneSessionStateText(session, options))
          .join("\n\n") || "No active Pi sessions found.",
    };
  }
  const resolution = resolveSessionTarget(target, sessions, {
    includeInvisible: true,
  });
  if (resolution.status !== "found") {
    return {
      status: resolution.status,
      resolution,
      text:
        resolution.status === "ambiguous"
          ? `Ambiguous session target \"${sanitizeMetadata(target, 200)}\".\nCandidates:\n  ${formatCandidateList(resolution.candidates)}`
          : `Session \"${sanitizeMetadata(target, 200)}\" not found.\nAvailable:\n  ${formatCandidateList(sessions)}`,
    };
  }
  return {
    status: "found",
    session: resolution.session,
    text: buildOneSessionStateText(resolution.session, options),
  };
}
```

- [ ] **Step 6: Export state helpers**

Add to `module.exports`:

```js
buildOneSessionStateText,
buildSessionStateReport,
findSessionState,
getGitState,
normalizeSessionStatus,
readBridgeState,
stateSessionKey,
updateSessionStatus,
writeBridgeState,
```

- [ ] **Step 7: Run targeted core tests**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-bridge-core.test.js
```

Expected:

```txt
# state tests pass
# existing core tests pass
```

- [ ] **Step 8: Commit**

Run:

```bash
git add packages/pi-yo/lib/pi-bridge-core.js packages/pi-yo/tests/pi-bridge-core.test.js
git commit -m "feat(pi-yo): add session state primitives"
```

---

### Task 5: Wire `state` commands into `pimsg` and `pi-cc-bridge`

**Files:**

- Modify: `packages/pi-yo/bin/pimsg`
- Modify: `packages/pi-yo/bin/pi-cc-bridge`
- Modify: `packages/pi-yo/tests/pimsg-cli.test.js`
- Modify: `packages/pi-yo/tests/pi-cc-bridge-cli.test.js`

- [ ] **Step 1: Add failing `pimsg state` and `list --with-status` tests**

Append to `packages/pi-yo/tests/pimsg-cli.test.js`:

```js
test("pimsg state reports self-reported status and list --with-status includes compact status", () => {
  const home = tempHome();
  const paths = core.buildPaths(home);
  core.writeRegistry(
    {
      sessions: [
        {
          pid: process.pid,
          name: "agent",
          cwd: process.cwd(),
          socketPath: path.join(paths.ipcDir, `${process.pid}.sock`),
          startedAt: Date.now(),
          readerKey: `pi:${process.pid}`,
        },
      ],
    },
    paths.registryFile,
  );
  core.updateSessionStatus(
    {
      pid: process.pid,
      name: "agent",
      cwd: process.cwd(),
      status: "working",
      currentTask: "Build state command",
    },
    { stateFile: paths.stateFile },
  );

  const state = runPimsg(home, ["state", "agent"]);
  assert.equal(state.status, 0, state.stderr);
  assert.match(state.stdout, /status: working/);
  assert.match(state.stdout, /currentTask: Build state command/);

  const list = runPimsg(home, ["list", "--with-status"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /\[working\]/);
});
```

- [ ] **Step 2: Add failing `pi-cc-bridge state` test**

Append to `packages/pi-yo/tests/pi-cc-bridge-cli.test.js`:

```js
test("pi-cc-bridge state reports target state", () => {
  const home = tempHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cwd-"));
  const paths = core.buildPaths(home);
  core.writeRegistry(
    {
      sessions: [
        {
          pid: process.pid,
          name: "agent",
          cwd,
          socketPath: path.join(paths.ipcDir, `${process.pid}.sock`),
          startedAt: Date.now(),
          readerKey: `pi:${process.pid}`,
        },
      ],
    },
    paths.registryFile,
  );
  core.updateSessionStatus(
    {
      pid: process.pid,
      name: "agent",
      cwd,
      status: "blocked",
      blockedOn: "waiting on deploy",
    },
    { stateFile: paths.stateFile },
  );

  const result = runBridge(home, cwd, ["state", "agent"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status: blocked/);
  assert.match(result.stdout, /blockedOn: waiting on deploy/);
});
```

- [ ] **Step 3: Run CLI tests and verify failures**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pimsg-cli.test.js tests/pi-cc-bridge-cli.test.js
```

Expected failures:

```txt
Session "state" not found
Unknown command: state
```

- [ ] **Step 4: Update `pimsg` help text**

In `printHelp()`, add lines:

```js
"  pimsg state <target|--all>           Show bridge state for one or all sessions",
"  pimsg list --with-status             List sessions with self-reported status",
```

- [ ] **Step 5: Add status label helper in `pimsg`**

After `visibilityLabel()`, add:

```js
function statusLabel(session) {
  const state = core.readBridgeState();
  const self = core.findSessionState(session, state);
  const status = core.normalizeSessionStatus(self && self.status);
  return status === "unknown" ? "" : `  [${status}]`;
}
```

- [ ] **Step 6: Update `listSessions()` in `pimsg` to accept status option**

Inside `listSessions()`, after `const visibility = visibilityLabel(rawSession);`, add:

```js
const state = options.withStatus ? statusLabel(rawSession) : "";
```

Change the `console.log(...)` line to append `${state}` before `${label}`:

```js
console.log(
  `  ${bullet} ${nameStr} ${pidStr} ${session.cwd}  (${age}m ago)${sc}${visibility}${state}${label}`,
);
```

- [ ] **Step 7: Wire `pimsg list --with-status` and `pimsg state`**

Change the `list` branch to:

```js
if (args[0] === "list") {
  listSessions({
    includeInvisible: args.includes("--all"),
    withStatus: args.includes("--with-status"),
  });
  return;
}
```

Add after the `doctor` branch:

```js
if (args[0] === "state") {
  const target = args[1] || "--all";
  const report = core.buildSessionStateReport(target, { includeGit: true });
  if (report.status !== "found") die(report.text);
  console.log(report.text);
  return;
}
```

- [ ] **Step 8: Wire `pi-cc-bridge state` command**

In `bin/pi-cc-bridge`, add after `cmdInbox()`:

```js
function cmdState(args = []) {
  const target = args[0] || "--all";
  const report = core.buildSessionStateReport(target, { includeGit: true });
  if (report.status !== "found") die(report.text);
  console.log(report.text);
}
```

Add to the switch:

```js
case "state": cmdState(process.argv.slice(3)); break;
```

- [ ] **Step 9: Run CLI tests**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pimsg-cli.test.js tests/pi-cc-bridge-cli.test.js
```

Expected:

```txt
# pimsg and pi-cc-bridge CLI tests pass
```

- [ ] **Step 10: Run syntax**

Run:

```bash
npm run syntax --workspace @neuralpartners/pi-yo
```

Expected:

```txt
# JS syntax and extension typecheck pass
```

- [ ] **Step 11: Commit**

Run:

```bash
git add packages/pi-yo/bin/pimsg packages/pi-yo/bin/pi-cc-bridge packages/pi-yo/tests/pimsg-cli.test.js packages/pi-yo/tests/pi-cc-bridge-cli.test.js packages/pi-yo/lib/pi-bridge-core.js
git commit -m "feat(pi-yo): add bridge state commands"
```

---

### Task 6: Add Pi status update tool and heartbeat updates

**Files:**

- Modify: `packages/pi-yo/extensions/pi-bridge.ts`
- Modify: `packages/pi-yo/bin/pi-cc-bridge`
- Modify: `packages/pi-yo/tests/pi-package.test.js`

- [ ] **Step 1: Add failing static test for status tool and heartbeat wiring**

Append to `packages/pi-yo/tests/pi-package.test.js`:

```js
test("extension exposes session status updates and bridge daemon heartbeats", () => {
  const extension = fs.readFileSync(
    path.join(packageRoot, "extensions", "pi-bridge.ts"),
    "utf-8",
  );
  const ccBridge = fs.readFileSync(
    path.join(packageRoot, "bin", "pi-cc-bridge"),
    "utf-8",
  );

  assert.match(extension, /update_session_status/);
  assert.match(extension, /updateSessionStatus/);
  assert.match(extension, /lastHeartbeatAt/);
  assert.match(ccBridge, /updateSessionStatus/);
  assert.match(ccBridge, /setInterval\(touchHeartbeat/);
});
```

- [ ] **Step 2: Run static test and verify it fails**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-package.test.js
```

Expected failure references missing `update_session_status` or `setInterval(touchHeartbeat`.

- [ ] **Step 3: Add heartbeat helper to `bin/pi-cc-bridge`**

After `recordAcceptedMessage(msg)`, add a heartbeat helper that updates liveness only and does not overwrite working/blocked/done status:

```js
function touchHeartbeat() {
  try {
    const registry = core.readRegistry(REGISTRY_FILE);
    const entry = registry.sessions.find(
      (session) => session.pid === process.pid,
    );
    if (entry) {
      entry.lastHeartbeatAt = Date.now();
      core.writeRegistry(registry, REGISTRY_FILE);
    }
  } catch {}
}
```

In `runDaemon()`, after successful `registerSession(...)`, initialize status once and then start the heartbeat interval:

```js
core.updateSessionStatus({
  pid: process.pid,
  name,
  cwd,
  readerKey: READER_KEY,
  status: "idle",
});
touchHeartbeat();
heartbeatTimer = setInterval(touchHeartbeat, 30_000);
```

In `cleanup()`, before `process.exit(0);`, add:

```js
clearInterval(heartbeatTimer);
```

Declare timer before cleanup:

```js
let heartbeatTimer;
```

- [ ] **Step 4: Add Pi extension status helper**

Inside the extension function after `setMyVisibility()`, add:

```ts
function updateMyStatus(input: any): any {
  const ctx = currentCtx;
  return bridgeCore.updateSessionStatus({
    pid: myPid,
    name: myName || (ctx ? getMyName(ctx) : "unknown"),
    cwd: ctx?.cwd ?? process.cwd(),
    readerKey: myReaderKey(),
    status: input.status,
    currentTask: input.currentTask,
    dispatchId: input.dispatchId,
    blockedOn: input.blockedOn,
    summary: input.summary,
  });
}

function touchHeartbeat(): void {
  const registry = readRegistry();
  const entry = registry.sessions.find((session) => session.pid === myPid);
  if (entry) {
    entry.lastHeartbeatAt = Date.now();
    writeRegistry(registry);
  }
}
```

- [ ] **Step 5: Start/stop Pi extension heartbeat interval**

Near `let senderRateLimiter...`, add:

```ts
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
```

At the end of `session_start`, after the ready notification block, initialize status once and then start the heartbeat interval without overwriting status later:

```ts
updateMyStatus({ status: "idle" });
touchHeartbeat();
heartbeatTimer = setInterval(() => touchHeartbeat(), 30_000);
```

In `session_shutdown`, before closing the server, add:

```ts
if (heartbeatTimer) clearInterval(heartbeatTimer);
```

- [ ] **Step 6: Register `update_session_status` Pi tool**

Before `pi.registerTool({ name: "set_session_visibility", ... })`, insert:

```ts
pi.registerTool({
  name: "update_session_status",
  label: "Update Pi Session Status",
  description:
    "Update this Pi session's self-reported pi-yo status for orchestrator state checks. " +
    "Use this when starting work, becoming blocked, entering review, completing work, or going idle.",
  promptSnippet:
    "Report current task/status to the pi-yo orchestrator state layer",
  promptGuidelines: [
    "Set status=working when accepting a dispatch or starting implementation.",
    "Set status=blocked with blockedOn when waiting on a decision, deploy, review, credential, or another agent.",
    "Set status=done with a short summary after verification passes.",
    "Do not include secrets, tokens, or private customer data in status fields.",
  ],
  parameters: Type.Object({
    status: Type.String({
      description: "Use idle, working, blocked, review, done, or unknown.",
    }),
    currentTask: Type.Optional(
      Type.String({ description: "Short current task description." }),
    ),
    dispatchId: Type.Optional(
      Type.String({
        description: "Dispatch/run ID if this work came from a dispatch.",
      }),
    ),
    blockedOn: Type.Optional(
      Type.String({ description: "Specific blocker, or 'none'." }),
    ),
    summary: Type.Optional(
      Type.String({ description: "Short status summary." }),
    ),
  }),
  async execute(_toolCallId, params) {
    const updated = updateMyStatus(params);
    return {
      content: [
        {
          type: "text",
          text: `Session status updated: ${updated.status}${updated.currentTask ? ` — ${updated.currentTask}` : ""}`,
        },
      ],
      details: updated,
    };
  },
});
```

- [ ] **Step 7: Add `/bridge-status` human command**

Before `/bridge-visibility`, add:

```ts
pi.registerCommand("bridge-status", {
  description:
    "Show or update this session's bridge status (usage: /bridge-status working <task>)",
  handler: async (args, ctx) => {
    logToolUsage(ctx, "slash_command", "bridge-status", {
      hasArgs: Boolean(args.trim()),
    });
    const [statusRaw, ...rest] = args.trim().split(/\s+/);
    if (!statusRaw) {
      const report = bridgeCore.buildSessionStateReport(String(myPid), {
        includeGit: false,
      });
      notifyCommand(
        ctx,
        report.text,
        "info",
        "Use /bridge-status working <task>, blocked <reason>, done <summary>, or idle.",
      );
      return;
    }
    const updated = updateMyStatus({
      status: statusRaw,
      currentTask: rest.join(" "),
    });
    notifyCommand(
      ctx,
      `Session status updated: ${updated.status}${updated.currentTask ? ` — ${updated.currentTask}` : ""}`,
      "success",
    );
  },
});
```

- [ ] **Step 8: Run package static test and syntax**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-package.test.js
npm run syntax --workspace @neuralpartners/pi-yo
```

Expected:

```txt
# static status test passes
# TypeScript extension check passes
```

- [ ] **Step 9: Commit**

Run:

```bash
git add packages/pi-yo/extensions/pi-bridge.ts packages/pi-yo/bin/pi-cc-bridge packages/pi-yo/tests/pi-package.test.js
git commit -m "feat(pi-yo): add session status reporting"
```

---

### Task 7: Add stale-shim diagnostics and explicit sync

**Files:**

- Modify: `packages/pi-yo/lib/pi-bridge-core.js`
- Modify: `packages/pi-yo/bin/pimsg`
- Test: `packages/pi-yo/tests/pi-bridge-core.test.js`
- Test: `packages/pi-yo/tests/pimsg-cli.test.js`

- [ ] **Step 1: Add failing core test for shim diagnostics**

Append to `packages/pi-yo/tests/pi-bridge-core.test.js`:

```js
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
  fs.writeFileSync(
    path.join(packageRoot, "lib", "pi-bridge-core.js"),
    "core-new",
  );
  fs.writeFileSync(path.join(localRoot, "bin", "pimsg"), "same");
  fs.writeFileSync(path.join(localRoot, "bin", "pi-cc-bridge"), "old");
  fs.writeFileSync(
    path.join(localRoot, "lib", "pi-bridge-core.js"),
    "core-old",
  );

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
```

- [ ] **Step 2: Add failing `pimsg doctor` CLI test**

Append to `packages/pi-yo/tests/pimsg-cli.test.js`:

```js
test("pimsg doctor reports shim diagnostics", () => {
  const home = tempHome();
  const result = runPimsg(home, ["doctor"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pi-bridge IPC permissions/);
  assert.match(result.stdout, /Shim diagnostics/);
});
```

- [ ] **Step 3: Run tests and verify failures**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-bridge-core.test.js tests/pimsg-cli.test.js
```

Expected failure references missing `diagnoseShimVersions` and missing `Shim diagnostics` text.

- [ ] **Step 4: Add shim diagnostic helpers to core**

In `packages/pi-yo/lib/pi-bridge-core.js`, after `doctorIpcPermissions()`, insert:

```js
function fileHash(file) {
  try {
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex");
  } catch {
    return undefined;
  }
}

function diagnoseShimVersions(options = {}) {
  const packageRoot = options.packageRoot || path.resolve(__dirname, "..");
  const agentRoot =
    options.agentRoot || path.join(os.homedir(), ".pi", "agent");
  const files = [
    {
      name: "pimsg",
      packagePath: path.join(packageRoot, "bin", "pimsg"),
      localPath: path.join(agentRoot, "bin", "pimsg"),
    },
    {
      name: "pi-cc-bridge",
      packagePath: path.join(packageRoot, "bin", "pi-cc-bridge"),
      localPath: path.join(agentRoot, "bin", "pi-cc-bridge"),
    },
    {
      name: "lib/pi-bridge-core.js",
      packagePath: path.join(packageRoot, "lib", "pi-bridge-core.js"),
      localPath: path.join(agentRoot, "lib", "pi-bridge-core.js"),
    },
  ].map((file) => {
    const packageHash = fileHash(file.packagePath);
    const localHash = fileHash(file.localPath);
    const status = !localHash
      ? "missing"
      : packageHash === localHash
        ? "current"
        : "stale";
    return { ...file, packageHash, localHash, status };
  });
  return {
    agentRoot,
    packageRoot,
    ok: files.every((file) => file.status === "current"),
    files,
  };
}

function formatShimDiagnostics(result) {
  const lines = ["Shim diagnostics:"];
  for (const file of result.files) {
    lines.push(
      `  ${file.name}: ${file.status}${file.localHash ? ` local:${file.localHash.slice(0, 12)}` : ""}${file.packageHash ? ` package:${file.packageHash.slice(0, 12)}` : ""}`,
    );
  }
  if (!result.ok) lines.push("  Run: pimsg doctor --sync-shims");
  return lines.join("\n");
}

function syncLocalShims(options = {}) {
  const diagnostics = diagnoseShimVersions(options);
  for (const file of diagnostics.files) {
    fs.mkdirSync(path.dirname(file.localPath), {
      recursive: true,
      mode: 0o700,
    });
    assertNotSymlink(file.localPath);
    fs.copyFileSync(file.packagePath, file.localPath);
    chmodSafe(
      file.localPath,
      file.name === "lib/pi-bridge-core.js" ? 0o600 : 0o755,
    );
  }
  return diagnoseShimVersions(options);
}
```

Export:

```js
diagnoseShimVersions,
formatShimDiagnostics,
syncLocalShims,
```

- [ ] **Step 5: Wire `pimsg doctor --sync-shims`**

In `bin/pimsg`, inside the `doctor` branch after `const fix = args.includes("--fix");`, add:

```js
const syncShims = args.includes("--sync-shims");
```

After printing permission findings, add:

```js
if (syncShims) {
  const synced = core.syncLocalShims();
  console.log(core.formatShimDiagnostics(synced));
} else {
  console.log(core.formatShimDiagnostics(core.diagnoseShimVersions()));
}
```

Update help line from:

```js
"  pimsg doctor [--fix]              Inspect or repair pi-bridge IPC permissions",
```

to:

```js
"  pimsg doctor [--fix] [--sync-shims] Inspect or repair IPC permissions and local shims",
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-bridge-core.test.js tests/pimsg-cli.test.js
npm run syntax --workspace @neuralpartners/pi-yo
```

Expected:

```txt
# shim diagnostics tests pass
# syntax passes
```

- [ ] **Step 7: Commit**

Run:

```bash
git add packages/pi-yo/lib/pi-bridge-core.js packages/pi-yo/bin/pimsg packages/pi-yo/tests/pi-bridge-core.test.js packages/pi-yo/tests/pimsg-cli.test.js
git commit -m "feat(pi-yo): diagnose stale local shims"
```

---

### Task 8: Docs, skill guidance, version bump

**Files:**

- Modify: `packages/pi-yo/README.md`
- Modify: `packages/pi-yo/skills/pi-yo/SKILL.md`
- Modify: `packages/pi-yo/tests/pi-package.test.js`
- Modify: `packages/pi-yo/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Add failing docs/package static test**

Append to `packages/pi-yo/tests/pi-package.test.js`:

```js
test("README and skill document reliable inbox and state commands", () => {
  const readme = fs.readFileSync(path.join(packageRoot, "README.md"), "utf-8");
  const skill = fs.readFileSync(
    path.join(packageRoot, "skills", "pi-yo", "SKILL.md"),
    "utf-8",
  );
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"),
  );

  for (const required of [
    "pi-cc-bridge inbox --format hook --consume",
    "pimsg state <target>",
    "pimsg list --with-status",
    "update_session_status",
    "pimsg doctor --sync-shims",
    "retained inbox",
  ]) {
    assert.match(readme, new RegExp(escapeRegExp(required)));
  }

  for (const required of [
    "update_session_status",
    "Set status=working",
    "Set status=done",
    "pimsg state",
    "retained inbox",
  ]) {
    assert.match(skill, new RegExp(escapeRegExp(required)));
  }

  assert.equal(packageJson.version, "0.3.0");
});
```

- [ ] **Step 2: Run static test and verify failure**

Run:

```bash
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-package.test.js
```

Expected failure references missing README/skill strings and version `0.2.2` vs `0.3.0`.

- [ ] **Step 3: Update README CLI section**

In `packages/pi-yo/README.md`, extend the CLI block to include:

```bash
pimsg state <target>
pimsg state --all
pimsg list --with-status
pimsg doctor --sync-shims

pi-cc-bridge inbox
pi-cc-bridge inbox --format hook --consume
pi-cc-bridge state <target>
```

Add a section after `## CLI`:

````md
## Reliable Claude Code inbox

For Claude Code/iTerm orchestrator sessions, prefer the retained inbox over the legacy mailbox:

```bash
pi-cc-bridge inbox --format hook --consume
```
````

The retained inbox reads `~/.pi/agent/ipc/bridge-events.jsonl` and advances only this bridge reader's cursor in `bridge-cursors.json`. It does not delete message history, so another hook/manual read cannot clear messages before the orchestrator processes them.

Legacy `pi-cc-bridge mailbox` remains available during rollout, but it is read-and-clear and should not be used as the orchestrator hook source once retained inbox is installed.

Claude Code hook snippet:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.pi/agent/bin/pi-cc-bridge inbox --format hook --consume || true",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

````

Add a state section:

```md
## Session state

Agents can self-report current work with `update_session_status` or `/bridge-status`.

Use these commands before dispatching more work:

```bash
pimsg state <target>
pimsg state --all
pimsg list --with-status
pi-cc-bridge state <target>
````

State combines liveness, registry metadata, self-reported status, and local git summary when available. It is a coordination aid, not proof that tests passed; verify claims against repo state before risky changes.

````

Add a shim section:

```md
## Local shim diagnostics

If `pimsg` on PATH comes from `~/.pi/agent/bin`, it can lag the installed npm package. Check and repair explicitly:

```bash
pimsg doctor
pimsg doctor --sync-shims
````

`--sync-shims` copies the installed package's `pimsg`, `pi-cc-bridge`, and `pi-bridge-core.js` into `~/.pi/agent`.

````

- [ ] **Step 4: Update bundled skill guidance**

In `packages/pi-yo/skills/pi-yo/SKILL.md`, update Agent Workflow list to include:

```md
3. Use `update_session_status` when accepting work, becoming blocked, entering review, completing work, or going idle. Keep status short and secret-free.
4. Before dispatching implementation or review work, use `pimsg state <target>` / `list_sessions` context or ask the target for current state if the bridge state is stale.
````

Adjust numbering for later items.

Add to Quick Reference:

```md
- Update current work state: `update_session_status`
- Check a peer before dispatch: `pimsg state <target>` or `pimsg list --with-status`
- Claude Code retained inbox: `pi-cc-bridge inbox --format hook --consume`
```

Add to Common Mistakes table:

```md
| Letting status rot | Call `update_session_status` at dispatch start, blocked, review, done, and idle transitions. |
| Using read-and-clear mailbox for orchestrator | Use retained inbox hook: `pi-cc-bridge inbox --format hook --consume`. |
```

- [ ] **Step 5: Bump package version to `0.3.0`**

Run:

```bash
npm version 0.3.0 --workspace @neuralpartners/pi-yo --no-git-tag-version
```

Expected:

```txt
@neuralpartners/pi-yo
v0.3.0
```

- [ ] **Step 6: Run format and static test**

Run:

```bash
npm run format
npm run test --workspace @neuralpartners/pi-yo -- tests/pi-package.test.js
```

Expected:

```txt
# Prettier formats markdown/json
# static docs/version test passes
```

- [ ] **Step 7: Commit**

Run:

```bash
git add packages/pi-yo/README.md packages/pi-yo/skills/pi-yo/SKILL.md packages/pi-yo/tests/pi-package.test.js packages/pi-yo/package.json package-lock.json
git commit -m "docs(pi-yo): document retained inbox and state commands"
```

---

### Task 9: Final verification and live-safe smoke notes

**Files:**

- Modify: `docs/superpowers/plans/2026-05-12-pi-yo-orchestrator-reliability-slice-1-implementation.md` only if recording verification notes in-plan is useful.

- [ ] **Step 1: Run package verification**

Run:

```bash
npm run verify --workspace @neuralpartners/pi-yo
```

Expected:

```txt
# all pi-yo tests pass
# node syntax checks pass
# TypeScript extension no-emit check passes via npm run syntax
```

- [ ] **Step 2: Run root formatting check**

Run:

```bash
npm run format:check
```

Expected:

```txt
All matched files use Prettier code style!
```

- [ ] **Step 3: Run structural greps**

Run:

```bash
rg -n "recordAcceptedBridgeMessage|readInboxEvents|formatInboxHookPayload|update_session_status|diagnoseShimVersions|pimsg state|pi-cc-bridge inbox" packages/pi-yo
rg -n "focusSupacodeTab\(|openSupacodeTab\(session\)" packages/pi-yo/bin packages/pi-yo/extensions || true
```

Expected:

```txt
# first grep returns expected implementation/docs/tests references
# second grep returns no stale direct focus helper calls from send paths
```

- [ ] **Step 4: Run git diff safety check**

Run:

```bash
git diff --check
```

Expected:

```txt
# no output
```

- [ ] **Step 5: Optional local shim dry check without syncing**

Run:

```bash
node packages/pi-yo/bin/pimsg doctor
```

Expected:

```txt
# permission diagnostic output
# Shim diagnostics output
# stale shims may be reported on Scott's machine; do not run --sync-shims unless Scott explicitly approves during rollout
```

- [ ] **Step 6: Optional retained inbox smoke in temp HOME**

Run:

```bash
HOME=$(mktemp -d) node - <<'NODE'
const core = require('./packages/pi-yo/lib/pi-bridge-core.js');
const path = require('node:path');
const os = require('node:os');
const home = process.env.HOME;
const paths = core.buildPaths(home);
core.appendBridgeEvent({kind:'message.accepted', messageId:'msg_smoke', from:{pid:1,name:'agent',cwd:'/tmp/agent'}, to:{pid:2,name:'orchestrator (CC)',cwd:process.cwd(),readerKey:'cc:smoke'}, content:'smoke retained inbox', acceptedAt:Date.now()}, {eventsFile: paths.eventsFile});
const inbox = core.readInboxEvents({readerKey:'cc:smoke', eventsFile:paths.eventsFile, cursorsFile:paths.cursorsFile});
console.log(core.formatInboxEvents(inbox.events));
core.consumeInboxEvents(inbox, {cursorsFile:paths.cursorsFile});
console.log('after consume', core.readInboxEvents({readerKey:'cc:smoke', eventsFile:paths.eventsFile, cursorsFile:paths.cursorsFile}).events.length);
NODE
```

Expected:

```txt
smoke retained inbox
after consume 0
```

- [ ] **Step 7: Ensure worktree is clean**

Run:

```bash
git status --short --branch
```

Expected:

```txt
## design/pi-yo-orchestrator-reliability...origin/main [ahead N]
# no unstaged/untracked files
```

- [ ] **Step 8: Request code review before merge/publish**

Use the `requesting-code-review` skill before claiming completion. Ask review to focus on:

```txt
- retained inbox cursor semantics and no destructive clears
- duplicate handling safety
- state command accuracy/failure modes
- socket ACK compatibility with old senders/receivers
- shim sync safety
- TypeScript extension typing
```

- [ ] **Step 9: Final commit if verification docs changed**

If verification notes were added to this plan or docs, commit them:

```bash
git add docs/superpowers/plans/2026-05-12-pi-yo-orchestrator-reliability-slice-1-implementation.md
git commit -m "docs(pi-yo): record orchestrator reliability verification"
```

If no files changed, do not create an empty commit.

---

## Implementation notes and known risks

- `pi-cc-bridge mailbox` stays read-and-clear for compatibility. The new Claude hook must use `pi-cc-bridge inbox --format hook --consume`.
- Journal events contain full direct message content for messages addressed to that receiver. Keep file mode `0600` and do not expose remotely.
- `pimsg doctor --sync-shims` overwrites local shims. It must be explicit and documented; do not run it automatically during package install.
- Git state probing must degrade gracefully. A repo can be huge, have broken git config, or lack `gh` auth. The state command should still return liveness/status.
- Do not implement orchestrator CC in this slice. The journal schema is designed to support it, but CC summaries belong to Slice 2.

## Definition of done

- `npm run verify --workspace @neuralpartners/pi-yo` passes.
- `npm run format:check` passes.
- `packages/pi-yo/extensions/pi-bridge.ts` is covered by `npm run syntax`.
- `pi-cc-bridge inbox --format hook --consume` works in tests and does not delete journal events.
- `pimsg state <target>` and `pi-cc-bridge state <target>` work in tests.
- `update_session_status` is exposed in the Pi extension.
- `pimsg doctor` reports shim diagnostics, and `--sync-shims` is explicit.
- README and bundled skill document the retained inbox and state workflow.
- Package version is `0.3.0`.

---

## Review — 2026-05-12 Slice 1 Execution

- Implemented Slice 1 on branch `design/pi-yo-orchestrator-reliability` through `7aa2e2a fix(pi-yo): make inbox cursors append-order safe`.
- Package version bumped to `@neuralpartners/pi-yo@0.3.0`.
- Added retained bridge journal/cursors, per-reader retained `pi-cc-bridge inbox`, hook JSON output, stable IDs/ACK metadata, dedup events, session state commands, `update_session_status`, heartbeat updates, and explicit shim diagnostics/sync.
- Self-review found and fixed a cursor-ordering bug: cursors now advance by append order when timestamps tie, and accepted message events use local acceptance time instead of sender-provided timestamps.
- Verification evidence:
  - `npm run verify --workspace @neuralpartners/pi-yo` — 60/60 tests passed; JS syntax and TypeScript extension no-emit check passed.
  - `npm run format:check` — all matched files use Prettier style.
  - Structural greps found expected retained inbox/state/shim references and no stale direct focus calls.
  - `git diff --check` — clean.
  - `node packages/pi-yo/bin/pimsg doctor` — reports IPC OK plus stale local shim diagnostics and explicit `pimsg doctor --sync-shims` instruction.
  - Temp-HOME retained inbox smoke showed message output and `after consume 0` without deleting journal history.
- Code review was requested via pi-yo from `Projects (CC)` and `neural-core-app`; no reviewer reply was received before this verification note.
