# pi-yo Orchestrator Reliability Layer Design

**Date:** 2026-05-12  
**Package:** `@neuralpartners/pi-yo`  
**Baseline:** `origin/main` at `@neuralpartners/pi-yo@0.2.2`  
**Workflow decision:** keep Scott's current workflow — Orchestrator/human in Claude Code + iTerm; agents in Pi/Codex + Supacode.

## Problem

Real multi-agent usage exposed five bridge reliability gaps:

1. **Codex/Pi → Claude Code delivery is weaker than Pi → Pi delivery.** Pi sessions use the extension and can auto-inject into the conversation. Claude Code sessions rely on `pi-cc-bridge mailbox`, which is a file-based read-and-clear path. That makes Codex replies easy to miss from the orchestrator.
2. **Direct cross-agent traffic bypasses the orchestrator.** Agent X can signal Agent Y directly, but the orchestrator does not see even a summary. That caused coordination mistakes when Scott dispatched work without seeing prior cross-agent state.
3. **Dispatch decisions lack current state.** The bridge registry proves process liveness, not work state. Scott has to ask agents whether a task/PR/design is already done before dispatching more work.
4. **Mailbox ordering and duplicates require manual discipline.** Old messages can resurface mixed with new messages; duplicate deliveries are not labeled because not every send path has a stable message ID.
5. **Content can be consumed before the orchestrator acts.** `pi-cc-bridge mailbox` clears the mailbox when read. A hook, manual check, or another read path can consume important content before the orchestrator processes it.

There is also an immediate operational smell: global npm has `@neuralpartners/pi-yo@0.2.2`, but `~/.pi/agent/bin/pimsg` and `~/.pi/agent/lib/pi-bridge-core.js` are stale private shims. They predate smart focus and invisible-session behavior. The reliability work should make this mismatch visible and easy to repair.

## Goals

- Preserve the current workflow: Claude Code/iTerm orchestrator, Pi/Codex/Supacode agents.
- Make cross-vendor delivery symmetric enough that `Pi/Codex -> Claude Code` is not a second-class path.
- Replace destructive mailbox consumption with retained, per-reader inbox semantics.
- Deduplicate by stable `messageId` across all send paths.
- Add a state command that answers: session identity, liveness, git state, open PRs when available, last bridge activity, current self-reported task/status, and dispatch status.
- Give the orchestrator visibility into cross-agent direct messages by default once an orchestrator is configured.
- Track dispatches with IDs, assignees, status, sent/reply times, and overdue state.
- Add a fleet digest suitable for Claude Code `UserPromptSubmit` hook injection before orchestrator turns.
- Keep everything trusted-local and owner-only; do not turn pi-yo into an auth boundary.

## Non-goals

- No remote transport.
- No multi-user authorization model.
- No LLM-based summarization in the bridge core. The bridge may produce deterministic summaries/previews; models can summarize later.
- No attempt to read private model thoughts or infer hidden state.
- No forced workflow migration to Pi/Supacode as orchestrator.
- No destructive migration of existing mailbox files; legacy mailbox compatibility remains during rollout.

## Recommended approach

Build a **phased orchestrator reliability layer**.

### Phase 0 — Plumbing and version hygiene

Add diagnostics so users can see when active bridge shims lag the installed package.

- `pimsg doctor` reports:
  - active `pimsg` path,
  - active `pi-cc-bridge` path,
  - active `pi-bridge-core.js` path,
  - package version and core hash,
  - stale shim warnings when `~/.pi/agent/bin/*` or `~/.pi/agent/lib/*` differ from the package.
- `pimsg doctor --fix` may repair permissions as today.
- A new explicit repair mode, `pimsg doctor --sync-shims`, updates local `~/.pi/agent/bin/*` and `~/.pi/agent/lib/pi-bridge-core.js` from the installed package. It is explicit because overwriting user-local shims is operationally meaningful.

This phase does not change delivery semantics, but it prevents debugging stale code by accident.

### Phase 1 — Retained event journal and stable message IDs

Introduce a shared append-only event journal in the IPC directory:

```txt
~/.pi/agent/ipc/bridge-events.jsonl
~/.pi/agent/ipc/bridge-cursors.json
```

Owner-only permissions stay consistent with current IPC hardening:

- IPC dir: `0700`
- event journal: `0600`
- cursor file: `0600`

Every accepted bridge message writes an event:

```json
{
  "schemaVersion": 1,
  "eventId": "evt_<time>_<random>",
  "kind": "message.accepted",
  "messageId": "msg_<time>_<random>",
  "acceptedAt": 1778600000000,
  "from": {
    "pid": 65022,
    "name": "neural-data-ingest",
    "cwd": "/Users/scottblodgett/Projects/neural-data-ingest"
  },
  "to": {
    "pid": 6192,
    "name": "Projects (CC)",
    "cwd": "/Users/scottblodgett/Projects"
  },
  "isReply": true,
  "dispatchId": "FORM_SUBMISSIONS_REFLIP",
  "content": "...full direct message content...",
  "contentBytes": 842,
  "duplicateOf": null
}
```

All send paths must call `ensureMessageId()` before sending:

- `pimsg`
- `pi-cc-bridge` replies if any future send mode is added
- Pi extension `/bridge-send`
- Pi extension `/yo`
- Pi LLM tools `send_to_session` and `reply_to_session`

Duplicate handling:

- A duplicate is any accepted message with the same normalized `messageId` and same sender PID/name.
- The receiver ACKs duplicates so retries are safe.
- The retained inbox labels duplicates instead of re-injecting raw content:

```txt
[duplicate] msg_abc123 already seen at 2026-05-12 10:42:11 from neural-showrooms
```

The journal is retained. Cursor movement, not file deletion, marks what a consumer has seen.

### Phase 2 — Reliable Claude Code inbox

Replace `pi-cc-bridge mailbox` as the orchestrator hook's source of truth with retained inbox commands:

```bash
pi-cc-bridge inbox
pi-cc-bridge inbox --consume
pi-cc-bridge inbox --since <cursor-or-time>
pi-cc-bridge inbox --format hook --consume
pi-cc-bridge inbox --all
```

Semantics:

- `inbox` reads events addressed to the current Claude Code bridge session plus orchestrator CC/digest events when configured.
- `--consume` advances only the current reader's cursor in `bridge-cursors.json`.
- Consuming does not delete journal entries.
- Another reader/session cannot clear the orchestrator's unread messages.
- `--format hook --consume` prints Claude Code hook JSON only when there is meaningful content:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "[pi-bridge inbox]\n..."
  }
}
```

Legacy compatibility:

- `pi-cc-bridge mailbox` remains available for old workflows.
- During rollout, inbound Claude Code bridge messages can still append to the legacy mailbox file, but the new event journal is canonical.
- Docs and Claude hook snippets move to `pi-cc-bridge inbox --format hook --consume`.

This directly addresses content drops, stale resurfacing, duplicates, and Codex/Pi replies getting missed by Claude Code.

### Phase 3 — State snapshots and `state` command

Add state files alongside the journal:

```txt
~/.pi/agent/ipc/bridge-state.json
```

State combines three sources:

1. **Mechanical session state** from registry and process checks:
   - name, PID, cwd, visibility,
   - alive/dead,
   - running duration,
   - last heartbeat,
   - socket path validity.
2. **Local repo state** computed from `cwd` when safe:
   - git branch,
   - clean/dirty/untracked summary,
   - head commit SHA + subject,
   - ahead/behind vs upstream,
   - open PRs via `gh` when available and authenticated.
3. **Self-reported agent state** from tools/commands:
   - `status`: `idle | working | blocked | review | done | unknown`,
   - `currentTask`,
   - `dispatchId`,
   - `blockedOn`,
   - `summary`,
   - `updatedAt`.

Commands:

```bash
pimsg state <target>
pimsg state --all
pimsg list --with-status
pi-cc-bridge state <target>
pi-cc-bridge state --all
pi-cc-bridge state --set status=working dispatchId=abc currentTask="..."
```

Pi extension tool:

```ts
update_session_status({
  status: "working" | "blocked" | "review" | "done" | "idle",
  currentTask?: string,
  dispatchId?: string,
  blockedOn?: string,
  summary?: string
})
```

State command output should be deterministic and compact:

```txt
neural-showroom-template pid:45547 alive visible
cwd: /Users/scottblodgett/Projects/neural-showroom-template
running: 22h12m  lastHeartbeat: 12s ago
status: working  dispatch: FORM_SUBMISSIONS_REFLIP
currentTask: smoke Templates env flip on scott-dev
blockedOn: none

git: main dirty:0 untracked:0 head:0c9066f update workspace build guard
pr: none open for current branch

last bridge:
- 10:41 Showrooms -> Templates: FORM_SUBMISSIONS_API_URL re-flip GO
- 10:55 Templates -> Orchestrator: deployed + smoke green
```

Mechanical state is automatic. Self-reported state is explicit and guided by the bundled `pi-yo` skill.

### Phase 4 — Dispatch ledger

Add a local dispatch ledger to the event journal rather than a separate database. Dispatch events share the same JSONL file:

```json
{
  "schemaVersion": 1,
  "eventId": "evt_dispatch_...",
  "kind": "dispatch.sent",
  "dispatchId": "admin-ui-decoupling-pr152-check",
  "targetPid": 42956,
  "targetName": "neural-core-app",
  "sentAt": 1778600000000,
  "status": "pending",
  "summary": "Verify whether admin UI decoupling PRs are already merged",
  "expectedReplyBy": 1778601800000
}
```

Ways to create/update dispatches:

```bash
pimsg --dispatch <dispatchId> <target> "message"
pimsg dispatch list
pimsg dispatch status <dispatchId>
pimsg dispatch update <dispatchId> --status blocked --summary "..."
```

Pi LLM tool parameters can grow optional fields:

```ts
send_to_session({ target, message, dispatchId?, expectedReplyMinutes? })
reply_to_session({ target, message, dispatchId?, status? })
```

Automatic updates:

- A reply with matching `dispatchId` updates `replyAt` and status.
- A reply to a known `messageId` updates the related dispatch if the original was dispatch-linked.
- `state --all` and digest output can flag overdue dispatches.

### Phase 5 — Orchestrator CC and fleet digest

Add local orchestrator config:

```txt
~/.pi/agent/bridge-orchestrator.json
```

Shape:

```json
{
  "enabled": true,
  "target": { "name": "Projects (CC)", "cwd": "/Users/scottblodgett/Projects" },
  "ccTraffic": {
    "enabled": true,
    "mode": "summary",
    "maxPreviewBytes": 600
  },
  "digest": {
    "enabled": true,
    "maxEvents": 20,
    "includeDirectMessages": true,
    "includeCcSummaries": true,
    "includeStateChanges": true,
    "includeOverdueDispatches": true
  }
}
```

Setup command:

```bash
pimsg orchestrator set <target>
pimsg orchestrator status
pimsg orchestrator disable
```

CC behavior:

- If Agent X sends Agent Y a direct bridge message and neither side is the orchestrator, the journal records an orchestrator CC event.
- The orchestrator CC event is a deterministic summary, not necessarily the full payload:

```txt
Showrooms -> Templates: FORM_SUBMISSIONS_API_URL re-flip GO
```

Digest behavior:

- `pi-cc-bridge inbox --format hook --consume` prepends a fleet activity digest when there are new CC summaries, state changes, direct messages, or overdue dispatches.
- Digest output is bounded to avoid flooding Claude context.
- Full direct messages addressed to the orchestrator remain visible; cross-agent CC summaries stay compact by default.

Example hook context:

```txt
[pi-bridge inbox]
Fleet activity since last turn:
- Showrooms -> Templates: FORM_SUBMISSIONS_API_URL re-flip GO
- Core status: done, PR #152 already merged
- Templates status: working, smoke scott-dev env flip
- Overdue: dispatch admin-ui-decoupling-pr152-check waiting on Core for 18m

Direct messages:
---
From: neural-data-ingest (reply)
...
```

## Data model summary

### Registry entry additions

Existing registry entries can gain optional fields:

```ts
type RegistryEntry = {
  pid: number;
  name: string;
  cwd: string;
  socketPath: string;
  startedAt: number;
  bridgeVisibility?: "visible" | "invisible";
  lastHeartbeatAt?: number;
  lastStateAt?: number;
  status?: "idle" | "working" | "blocked" | "review" | "done" | "unknown";
  currentTask?: string;
  dispatchId?: string;
  blockedOn?: string;
  summary?: string;
};
```

### Event kinds

Initial event kinds:

- `message.accepted`
- `message.duplicate`
- `message.delivered`
- `message.ack_timeout`
- `status.updated`
- `dispatch.sent`
- `dispatch.updated`
- `orchestrator.cc`

The implementation should keep event writing append-only and schema-versioned.

## Error handling

- If event journaling fails, socket delivery still returns an ACK only after the direct delivery path accepted the message. The sender receives a warning that the message delivered but journal recording failed.
- If cursor writing fails, `inbox --consume` prints content but reports a non-zero exit so hooks do not silently lose unread state.
- If `git`/`gh` state probes fail, `state` reports the failed probe as unavailable; it does not fail the whole command.
- If orchestrator target resolution is ambiguous, CC is disabled until `pimsg orchestrator set <exact-pid-or-name>` succeeds.
- If the journal contains malformed lines, readers skip them and include a diagnostic count.

## Security and privacy

- Same trusted-local IPC model as current pi-yo.
- All new files are owner-only.
- Inbound message content remains prompt-injection-capable by design. Hook/digest output must keep explicit `[pi-bridge inbox]` labeling and should not instruct the model to execute content blindly.
- Do not store secrets in state or dispatch summaries.
- Deterministic CC summaries should cap content previews and sanitize control characters.
- No remote sockets, HTTP servers, or external services are introduced.

## Rollout plan

Split implementation into two release slices to avoid a monster PR.

### Slice 1 — Delivery reliability + state command MVP

Ships:

- stale shim diagnostics and explicit sync command,
- stable IDs for every send path,
- event journal + per-reader cursors,
- `pi-cc-bridge inbox --format hook --consume`,
- dedup labeling,
- mechanical + self-reported state,
- `pimsg state` / `pi-cc-bridge state`,
- docs + updated Claude hook snippet.

This slice directly handles the two highest-leverage needs Scott named: reliable cross-vendor delivery and state checking.

### Slice 2 — Orchestrator CC + dispatch ledger + fleet digest

Ships:

- orchestrator config commands,
- cross-agent CC summary events,
- dispatch ledger commands and optional tool fields,
- overdue query,
- fleet digest integration in the retained inbox hook.

## Testing strategy

Unit/integration tests should use temp `HOME`/IPC dirs.

Required coverage:

1. All send paths call `ensureMessageId()` or otherwise emit a message ID.
2. Event journal writes owner-only JSONL and preserves ordering.
3. `inbox --consume` advances only that reader's cursor and does not delete events.
4. Duplicate message IDs are labeled and not reinjected as raw fresh messages.
5. Legacy `mailbox` still works during rollout.
6. `state <target>` reports mechanical state and git state from temp repos.
7. State command degrades cleanly when `gh` is unavailable.
8. Self-reported state updates registry/state file.
9. Orchestrator config rejects ambiguous targets.
10. Cross-agent direct messages create CC summaries when orchestrator config is enabled.
11. Dispatch replies update ledger state.
12. Hook format emits valid Claude Code hook JSON only when there is content.
13. Manual TypeScript check still covers `packages/pi-yo/extensions/pi-bridge.ts` until package scripts include it.

## Acceptance criteria

- Claude Code orchestrator can use `pi-cc-bridge inbox --format hook --consume` without losing messages to another reader.
- Codex/Pi replies to Claude Code are retained, ordered, deduped, and hook-injectable.
- `pimsg state <agent>` answers whether an agent is alive, what repo/branch/PR state it has, and what it last reported doing.
- Direct Agent X → Agent Y messages create orchestrator-visible summaries when configured.
- Dispatch IDs can be queried for owner/status/reply/overdue state.
- Stale `~/.pi/agent` shims are detected and repairable.
- Existing Pi-to-Pi and `pimsg` flows remain backward compatible.
