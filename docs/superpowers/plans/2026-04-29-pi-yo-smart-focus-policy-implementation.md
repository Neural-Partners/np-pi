# pi-yo Smart Focus Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable smart-focus behavior to `@neuralpartners/pi-yo` so bridge sends focus Supacode only when the human is currently in an allowed dev/agent app.

**Architecture:** Centralize focus policy in `packages/pi-yo/lib/pi-bridge-core.js`, normalize it through the existing `bridge-policy.json` path, and replace every direct `openSupacodeTab()` send-path call with `maybeFocusSession()`. Smart mode uses the current macOS frontmost app as the v1 engagement signal and fails closed when detection fails.

**Tech Stack:** Node.js CommonJS core/CLI, TypeScript Pi extension, Node built-in test runner, macOS `osascript` through `execFileSync`.

---

## Base-state requirement

Implement this on top of the published `@neuralpartners/pi-yo@0.2.0` source, not the stale `0.1.6` package metadata currently visible in the active checkout.

Recommended branch setup before implementation:

```bash
git fetch origin
git checkout -B fix/pi-yo-smart-focus origin/skill/pi-yo-usage
git cherry-pick c3351d5
```

Why: npm latest is already `0.2.0`; this feature should release as `0.2.1`. Publishing from a branch that still says `0.1.6` risks cutting a package that drops the bundled `pi-yo` skill.

## File structure

**Modify:**

- `packages/pi-yo/lib/pi-bridge-core.js` — default focus policy, normalization, frontmost app detection, focus decision helpers, exports.
- `packages/pi-yo/tests/pi-bridge-core.test.js` — unit tests for focus policy, allowed apps, failure behavior, and opener calls.
- `packages/pi-yo/bin/pimsg` — CLI should call smart focus helper and report focus accurately.
- `packages/pi-yo/extensions/pi-bridge.ts` — `/bridge-send`, `/yo`, `send_to_session`, and `reply_to_session` should call smart focus helper and include focus details.
- `packages/pi-yo/README.md` — document smart focus config and v1 Supacode-only target focus.
- `packages/pi-yo/package.json` — bump package version to `0.2.1`.
- `package-lock.json` — bump workspace package lock metadata to `0.2.1`.

---

### Task 1: Add failing core tests for focus policy

**Files:**

- Modify: `packages/pi-yo/tests/pi-bridge-core.test.js`

- [ ] **Step 1: Add focus policy test helpers**

Add this helper after `sampleMessage()`:

```js
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

function captureOpener(calls) {
  return (cmd, args, options) => calls.push({ cmd, args, options });
}
```

- [ ] **Step 2: Add failing tests**

Append these tests after the existing `bridge policy routes non-allowlisted senders to mailbox` test:

```js
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
```

- [ ] **Step 3: Run tests and verify they fail for missing helpers**

Run:

```bash
cd packages/pi-yo
npm test
```

Expected: FAIL with messages like `core.maybeFocusSession is not a function` or `Cannot read properties of undefined (reading 'mode')`.

---

### Task 2: Implement core focus policy helpers

**Files:**

- Modify: `packages/pi-yo/lib/pi-bridge-core.js`

- [ ] **Step 1: Add focus policy constants**

Insert after `DEFAULT_BRIDGE_POLICY`:

```js
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
```

- [ ] **Step 2: Add focus normalization helpers**

Insert after `defaultBridgePolicy()`:

```js
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
```

- [ ] **Step 3: Extend `defaultBridgePolicy()`**

Replace the existing function with:

```js
function defaultBridgePolicy() {
  return {
    mode: DEFAULT_BRIDGE_POLICY.mode,
    allowlist: [],
    rateLimit: { ...DEFAULT_BRIDGE_POLICY.rateLimit },
    focus: defaultFocusPolicy(),
  };
}
```

- [ ] **Step 4: Extend `normalizeBridgePolicy()` return value**

Replace the final return in `normalizeBridgePolicy()` with:

```js
const focus = normalizeFocusPolicy(input.focus);

return { mode, allowlist, rateLimit: { perSenderPer10s }, focus };
```

- [ ] **Step 5: Add frontmost app and focus decision helpers**

Insert after `openSupacodeTab()`:

```js
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
```

- [ ] **Step 6: Export the new helpers/constants**

Add these properties to `module.exports` near the existing defaults and helper exports:

```js
  DEFAULT_FOCUS_ALLOWED_FRONTMOST_APPS,
  DEFAULT_FOCUS_POLICY,
```

And:

```js
  defaultFocusPolicy,
  getFrontmostAppName,
  maybeFocusSession,
  normalizeFocusPolicy,
  shouldFocusSession,
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
cd packages/pi-yo
node --test tests/pi-bridge-core.test.js
```

Expected: PASS for all tests in `pi-bridge-core.test.js`.

---

### Task 3: Wire smart focus into the CLI

**Files:**

- Modify: `packages/pi-yo/bin/pimsg`

- [ ] **Step 1: Replace the old focus helper**

Replace:

```js
function focusSupacodeTab(session) {
  core.openSupacodeTab(session);
}
```

With:

```js
const os = require("node:os");
const BRIDGE_POLICY_FILE = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "bridge-policy.json",
);

function maybeFocusSession(session) {
  const policy = core.readBridgePolicy(BRIDGE_POLICY_FILE);
  return core.maybeFocusSession(session, policy);
}

function focusSuffix(focus) {
  if (!focus) return "";
  if (focus.focused) return " — focused their tab";
  if (focus.frontmostApp && /not allowed/i.test(focus.reason || "")) {
    return ` — focus skipped: ${safeText(focus.frontmostApp, 80)} is frontmost`;
  }
  return "";
}
```

- [ ] **Step 2: Include the bridge policy file in doctor checks**

In the `doctor` `extraFiles` array, add:

```js
        path.join(require("node:os").homedir(), ".pi", "agent", "bridge-policy.json"),
```

The full array should include roster, policy, and tool usage files.

- [ ] **Step 3: Replace the direct focus call in send flow**

Replace:

```js
focusSupacodeTab(session);
const safe = safeSession(session);
const sc = safe.supacodeTabId ? " — focused their tab" : "";
const ack = receipt.acked
  ? " — ACK received"
  : ` — delivered, but ${receipt.warning}`;
console.log(`✓ ${verb} to "${safe.name}" (${safe.cwd})${sc}${ack}`);
```

With:

```js
const focus = maybeFocusSession(session);
const safe = safeSession(session);
const ack = receipt.acked
  ? " — ACK received"
  : ` — delivered, but ${receipt.warning}`;
console.log(
  `✓ ${verb} to "${safe.name}" (${safe.cwd})${focusSuffix(focus)}${ack}`,
);
```

- [ ] **Step 4: Run CLI syntax check**

Run:

```bash
cd packages/pi-yo
node -c bin/pimsg
```

Expected: exits 0 with no output.

---

### Task 4: Wire smart focus into the Pi extension

**Files:**

- Modify: `packages/pi-yo/extensions/pi-bridge.ts`

- [ ] **Step 1: Replace the old Supacode focus helper**

Replace:

```ts
function focusSupacodeTab(session: RegistryEntry): void {
  bridgeCore.openSupacodeTab(session);
}
```

With:

```ts
function maybeFocusSession(session: RegistryEntry): any {
  const policy = bridgeCore.readBridgePolicy(BRIDGE_POLICY_FILE);
  return bridgeCore.maybeFocusSession(session, policy);
}

function focusNotice(focus: any): string {
  if (!focus) return "";
  if (focus.focused) return " Focused target Supacode tab.";
  if (focus.frontmostApp && /not allowed/i.test(String(focus.reason ?? ""))) {
    return ` Focus skipped: frontmost app is ${safeText(focus.frontmostApp, 80)}.`;
  }
  return "";
}
```

- [ ] **Step 2: Update `/bridge-send`**

Replace the send success block:

```ts
const receipt = await sendToSocket(session.socketPath, msg);
focusSupacodeTab(session);
const safe = safeSession(session);
notifyCommand(
  ctx,
  `✉️  Sent to "${safe.name}"${safe.supacodeTabId ? " — focusing their tab" : ""}.${receiptSuffix(receipt)}`,
  receipt.acked ? "success" : "warning",
  "Transport ACK only means the recipient process accepted the message.",
);
```

With:

```ts
const receipt = await sendToSocket(session.socketPath, msg);
const focus = maybeFocusSession(session);
const safe = safeSession(session);
notifyCommand(
  ctx,
  `✉️  Sent to "${safe.name}".${focusNotice(focus)}${receiptSuffix(receipt)}`,
  receipt.acked ? "success" : "warning",
  "Transport ACK only means the recipient process accepted the message.",
);
```

- [ ] **Step 3: Update `/yo`**

Replace:

```ts
const receipt = await sendToSocket(session.socketPath, msg);
focusSupacodeTab(session);
const safe = safeSession(session);
```

With:

```ts
const receipt = await sendToSocket(session.socketPath, msg);
const focus = maybeFocusSession(session);
const safe = safeSession(session);
```

Then add `focusNotice(focus)` to the notification lines by inserting this line before the warning line:

```ts
					focusNotice(focus),
```

The notification array should include delivery, receipt, reply expectation, focus notice, optional warning, and completion warning.

- [ ] **Step 4: Update `send_to_session` tool**

Replace:

```ts
const receipt = await sendToSocket(session.socketPath, msg);
focusSupacodeTab(session);
const safe = safeSession(session);
```

With:

```ts
const receipt = await sendToSocket(session.socketPath, msg);
const focus = maybeFocusSession(session);
const safe = safeSession(session);
```

Replace the text string:

```ts
							text: `Message delivered to "${safe.name}" (${safe.cwd}).${safe.supacodeTabId ? " Focused their Supacode tab." : ""}${receiptSuffix(receipt)}`,
```

With:

```ts
							text: `Message delivered to "${safe.name}" (${safe.cwd}).${focusNotice(focus)}${receiptSuffix(receipt)}`,
```

Replace details:

```ts
				details: { to: safe.name, toCwd: safe.cwd, acked: receipt.acked, receipt: receipt.response },
```

With:

```ts
				details: { to: safe.name, toCwd: safe.cwd, acked: receipt.acked, receipt: receipt.response, focus },
```

- [ ] **Step 5: Update `reply_to_session` tool**

Make the same replacements in `reply_to_session`:

```ts
const receipt = await sendToSocket(session.socketPath, msg);
const focus = maybeFocusSession(session);
const safe = safeSession(session);
return {
  content: [
    {
      type: "text",
      text: `Reply delivered to "${safe.name}" (${safe.cwd}).${focusNotice(focus)}${receiptSuffix(receipt)}`,
    },
  ],
  details: {
    to: safe.name,
    toCwd: safe.cwd,
    acked: receipt.acked,
    receipt: receipt.response,
    focus,
  },
};
```

- [ ] **Step 6: Verify no direct focus calls remain in package senders**

Run:

```bash
rg -n "focusSupacodeTab\(|openSupacodeTab\(" packages/pi-yo/bin/pimsg packages/pi-yo/extensions/pi-bridge.ts
```

Expected: no output.

- [ ] **Step 7: Run package syntax verification**

Run:

```bash
cd packages/pi-yo
npm run syntax
```

Expected: exits 0; `node -c` checks all package JS/CLI files.

---

### Task 5: Document smart focus policy

**Files:**

- Modify: `packages/pi-yo/README.md`

- [ ] **Step 1: Extend bridge policy example**

Replace the default policy JSON example with:

```json
{
  "mode": "auto-inject",
  "allowlist": [],
  "rateLimit": { "perSenderPer10s": 5 },
  "focus": {
    "mode": "smart",
    "allowedFrontmostApps": [
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
      "Codex"
    ]
  }
}
```

- [ ] **Step 2: Add a focus policy section**

Add this section after the rate limit paragraph:

```markdown
## Smart focus policy

`pi-yo` can focus the target Supacode tab after a successful bridge send. The default is `smart`, which focuses only when your current frontmost macOS app is an agent/dev app. This keeps the fast dispatch workflow when you are working in Supacode, a terminal, Cursor, an IDE, Claude Desktop, or Codex, but avoids stealing focus when you are in Chrome, Figma, Slack, email, or another non-agent app.

Focus config lives in `~/.pi/agent/bridge-policy.json`:

- `focus.mode: "smart"` — default; focus only when the frontmost app is allowlisted.
- `focus.mode: "always"` — restore the old behavior and focus whenever the target has Supacode metadata.
- `focus.mode: "never"` — disable auto-focus entirely.

In v1, only Supacode targets can be focused because the bridge registry currently stores Supacode tab/worktree IDs. IDE names in `allowedFrontmostApps` mean "it is OK to focus a Supacode target while this app is frontmost"; they do not yet focus Cursor, VS Code, Windsurf, Kiro, or other IDE windows as targets.
```

- [ ] **Step 3: Run formatting check**

Run:

```bash
npm run format:check
```

Expected: PASS. If it fails, run `npx prettier --write packages/pi-yo/README.md` and then run the check again.

---

### Task 6: Bump package version and lockfile

**Files:**

- Modify: `packages/pi-yo/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Bump `packages/pi-yo` to `0.2.1`**

Run from the repo root:

```bash
npm version 0.2.1 --workspace packages/pi-yo --no-git-tag-version
```

Expected: `packages/pi-yo/package.json` and `package-lock.json` update package metadata to `0.2.1`.

- [ ] **Step 2: Verify package version in both files**

Run:

```bash
node -e "const pkg=require('./packages/pi-yo/package.json'); const lock=require('./package-lock.json'); console.log(pkg.version, lock.packages['packages/pi-yo'].version)"
```

Expected output:

```txt
0.2.1 0.2.1
```

---

### Task 7: Full verification and manual smoke checklist

**Files:**

- No code changes unless verification reveals a defect.

- [ ] **Step 1: Run package verification**

Run:

```bash
cd packages/pi-yo
npm run verify
```

Expected: all tests pass and syntax checks exit 0.

- [ ] **Step 2: Run root verification relevant to this docs/code change**

Run from repo root:

```bash
npm run format:check
```

Expected: all Markdown/JSON/YAML files pass Prettier.

- [ ] **Step 3: Run grep safety checks**

Run from repo root:

```bash
rg -n "Focused their Supacode tab|focusing their tab|focusSupacodeTab\(" packages/pi-yo
```

Expected: no output. New wording should be `Focused target Supacode tab` and `Focus skipped` only.

- [ ] **Step 4: Manual local smoke test after installing package**

After package install/reload, verify these manually:

```bash
# with Supacode frontmost
pimsg list
pimsg <target-pid-or-name> "focus smoke: Supacode frontmost"

# with Cursor or another allowlisted IDE frontmost
pimsg <target-pid-or-name> "focus smoke: IDE frontmost"

# with Google Chrome frontmost, trigger an agent/tool bridge send from Pi
# Expected: message delivered, no Supacode focus steal.
```

Expected:

- Supacode frontmost: target Supacode tab focuses.
- Cursor/IDE frontmost: target Supacode tab focuses.
- Chrome frontmost: target Supacode tab does not focus.

- [ ] **Step 5: Commit implementation**

Run:

```bash
git add packages/pi-yo/lib/pi-bridge-core.js packages/pi-yo/tests/pi-bridge-core.test.js packages/pi-yo/bin/pimsg packages/pi-yo/extensions/pi-bridge.ts packages/pi-yo/README.md packages/pi-yo/package.json package-lock.json
git commit -m "fix: add smart focus policy to pi-yo"
```

Expected: commit succeeds with the smart focus implementation.
