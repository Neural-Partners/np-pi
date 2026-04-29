# pi-yo Smart Focus Policy Design

**Date:** 2026-04-29  
**Owner:** Neural Partners  
**Package:** `@neuralpartners/pi-yo`  
**Status:** Approved design direction; ready for implementation planning after user review

## Problem

`pi-yo` currently focuses the target Supacode tab after successful bridge sends whenever the target session has Supacode metadata. That is useful when the human is actively working in an agent/dev surface, but it is distracting when the human is in another app like Chrome: macOS jumps to Supacode, then often back to the previous app.

The focus behavior should stay available because it makes dispatching across agents fast. It just needs to stop stealing focus when the human is not currently engaged with an agent/dev window.

## Current behavior

The following send paths call `focusSupacodeTab(session)` unconditionally after delivery:

- `packages/pi-yo/bin/pimsg`
- `packages/pi-yo/extensions/pi-bridge.ts` command `/bridge-send`
- `packages/pi-yo/extensions/pi-bridge.ts` command `/yo`
- `packages/pi-yo/extensions/pi-bridge.ts` tool `send_to_session`
- `packages/pi-yo/extensions/pi-bridge.ts` tool `reply_to_session`

`focusSupacodeTab()` calls `bridgeCore.openSupacodeTab(session)`, which builds a `supacode://worktree/<id>/tab/<id>` URL and opens it via macOS `open`.

That means any successful send can foreground Supacode, regardless of the user's current app.

## Goals

1. Keep the good workflow: when the human is actively in Supacode, a terminal, Cursor, or another dev/agent app, bridge sends may focus the target agent tab.
2. Stop focus stealing when the human is in non-agent apps such as Chrome, Figma, Slack, email, etc.
3. Make focus behavior configurable.
4. Apply the same policy consistently to CLI, slash-command, and LLM-tool send paths.
5. Preserve backward compatibility for existing `bridge-policy.json` files.
6. Fail closed: if focus eligibility cannot be determined, do not focus.

## Non-goals

- Do not add true target focusing for Cursor, VS Code, Windsurf, Kiro, or other IDE sessions in v1. Current registry metadata only knows how to focus Supacode targets.
- Do not infer whether a human is physically typing. Use frontmost app as the v1 proxy for active engagement.
- Do not change inbound message delivery policy (`auto-inject` vs `mailbox-only`) except to share the same policy file.
- Do not make focus decisions based on message content, sender identity, or ACK status beyond requiring successful delivery.

## Design

Add a shared smart-focus gate to `pi-yo` core. All outbound send paths call one helper instead of calling `openSupacodeTab()` directly.

```txt
message delivered
  ↓
target session has focus metadata?
  ↓
read normalized bridge policy
  ↓
focus.mode === "never"  → skip
focus.mode === "always" → focus target
focus.mode === "smart"  → check current frontmost app
  ↓
frontmost app is allowed? focus target : skip
```

The target focus mechanism remains Supacode-specific in v1 because the registry already stores:

- `supacodeWorktreeId`
- `supacodeTabId`
- `supacodeSurfaceId`

Allowed IDEs and terminals matter as **frontmost-app eligibility**, not as target focus adapters yet.

## Configuration

Extend `~/.pi/agent/bridge-policy.json` with a `focus` section:

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

### Focus modes

| Mode     | Behavior                                                                               |
| -------- | -------------------------------------------------------------------------------------- |
| `smart`  | Default. Focus only when the current frontmost macOS app is in `allowedFrontmostApps`. |
| `always` | Current behavior. Focus whenever the target has Supacode metadata.                     |
| `never`  | Never auto-focus after bridge sends.                                                   |

### Normalization rules

- Missing `focus` config defaults to `smart` with the default allowlist.
- Invalid `focus.mode` defaults to `smart`.
- `allowedFrontmostApps` is treated case-insensitively.
- Empty or invalid app names are dropped.
- If the final allowlist is empty, smart focus skips focusing.

## Frontmost app detection

On macOS, core should detect the current frontmost app using `osascript`:

```bash
osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'
```

Implementation requirements:

- Use `execFileSync("osascript", ["-e", script], { timeout: 500 })` or equivalent safe argument passing.
- Never shell-interpolate app names or URLs.
- Trim and sanitize the returned app name before comparison.
- If `osascript` fails, times out, or returns an empty value, smart focus returns `false`.
- Tests must inject a fake frontmost-app provider instead of running AppleScript.

## API shape

Add core helpers in `packages/pi-yo/lib/pi-bridge-core.js`:

```js
function defaultFocusPolicy() {}
function normalizeFocusPolicy(input) {}
function getFrontmostAppName(options = {}) {}
function shouldFocusSession(session, policy, options = {}) {}
function maybeFocusSession(session, policy, options = {}) {}
```

Expected behavior:

- `shouldFocusSession()` is pure when passed a mocked `frontmostAppName` or `frontmostAppProvider`.
- `maybeFocusSession()` calls `openSupacodeTab()` only when `shouldFocusSession()` returns `true`.
- `maybeFocusSession()` returns a structured result so senders can report accurately:

```js
{ focused: true, reason: "frontmost app allowed", frontmostApp: "Cursor" }
{ focused: false, reason: "frontmost app not allowed", frontmostApp: "Google Chrome" }
{ focused: false, reason: "focus mode is never" }
{ focused: false, reason: "target has no focus metadata" }
```

## Sender integration

Replace direct calls to `focusSupacodeTab(session)` with a single wrapper that reads policy and calls `bridgeCore.maybeFocusSession()`.

Affected paths:

- CLI: `pimsg <target> ...`
- Slash commands: `/bridge-send`, `/yo`
- LLM tools: `send_to_session`, `reply_to_session`

Messaging should stop saying `Focused their Supacode tab` unless focus actually happened.

Suggested message wording:

- Focused: `Focused target Supacode tab.`
- Skipped smart focus: `Focus skipped: frontmost app is Google Chrome.`
- No target metadata: omit focus wording from normal success output.

For LLM tools, include focus details in `details.focus` so agents can report without guessing.

## Tests

Add tests in `packages/pi-yo/tests/pi-bridge-core.test.js` for:

1. Old policy files without `focus` normalize to smart focus defaults.
2. `focus.mode: "never"` skips focus even for valid Supacode targets.
3. `focus.mode: "always"` focuses valid Supacode targets regardless of frontmost app.
4. `focus.mode: "smart"` focuses when frontmost app is allowed, e.g. `Supacode`, `Cursor`, `Sublime Text`, `Antigravity`, `Kiro`, `Windsurf`, `Claude Desktop`, `Codex`.
5. `focus.mode: "smart"` skips when frontmost app is not allowed, e.g. `Google Chrome`.
6. Smart focus skips when frontmost detection fails.
7. Smart focus skips when target session has no Supacode metadata.
8. `maybeFocusSession()` calls the opener only when focus is allowed.
9. Existing Supacode URL validation and shell-injection tests still pass.

## Documentation updates

Update:

- `packages/pi-yo/README.md`
- `docs/pi-agent-ownership.md` if ownership/runtime notes need the new focus policy mentioned

Docs should explain:

- smart focus default
- config location
- allowed frontmost apps
- `always` escape hatch for old behavior
- `never` option for zero auto-focus
- v1 only focuses Supacode targets because that is the only target metadata currently registered

## Rollout

1. Implement and test in `packages/pi-yo`.
2. Run package verification:

   ```bash
   cd packages/pi-yo
   npm run verify
   ```

3. Run root formatting check:

   ```bash
   npm run format:check
   ```

4. Bump package version.
5. Publish if this is going to npm as a public package release.
6. Upgrade local install:

   ```bash
   pi install npm:@neuralpartners/pi-yo
   /reload
   pi-cc-bridge stop && pi-cc-bridge start
   ```

7. Confirm behavior manually:
   - Frontmost app `Supacode` → send focuses target.
   - Frontmost app `Cursor` → send focuses target.
   - Frontmost app `Google Chrome` → send does not focus target.

## Acceptance criteria

- Default behavior is smart focus, not unconditional focus.
- Chrome/non-dev frontmost apps are not interrupted by agent bridge sends.
- Supacode, terminal, IDE, Claude Desktop, and Codex frontmost apps preserve the fast focus workflow.
- Users can set `focus.mode` to `always` to restore current behavior.
- Users can set `focus.mode` to `never` to disable focus entirely.
- All outbound send paths use the same focus policy.
- Tests prove focus decisions without launching real apps.
- Existing bridge policy and Supacode URL hardening behavior remains intact.
