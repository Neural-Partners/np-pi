# pi-yo Local Chatrooms Design

**Date:** 2026-05-26  
**Owner:** Neural Partners / np-pi  
**Package:** `@neuralpartners/pi-yo`  
**Branch:** `feat/pi-yo-rooms`  
**Status:** approved by delegated owner instruction — proceed without further human approval

## Goal

Build a local-first Slack-replacement prototype for Neural Partners terminal agents and humans: project-scoped chatrooms where Pi and Claude Code terminal sessions can join with stable names, post room messages, follow threads, and receive low-noise alerts through existing `pi-yo` delivery paths.

This is intentionally not a Slack integration. Slack mirroring and cross-network/team Macs are future phases.

## Context

`pi-yo@0.3.0` already provides the reliable local coordination substrate:

- trusted same-user Unix socket IPC
- session registry and target resolution
- stable message IDs and ACK receipts
- retained JSONL event journal with per-reader cursors
- Claude Code bridge daemon and retained inbox hooks
- Pi extension tools/commands for session messaging
- session state/heartbeat visibility
- smart focus, invisible sessions, and shim diagnostics

The chatroom prototype should reuse those primitives instead of replacing them.

## Decisions

1. **Source of truth:** local `pi-yo` room state/events first.
2. **UI:** standalone terminal CLI/TUI manager first, with lightweight Pi extension commands/tools as companions.
3. **Default notifications:** mention/thread/assignment only. Normal room chatter is visible in logs/manager but does not inject into agent context.
4. **Prototype boundary:** same-machine/same-user local IPC only. Cross-network transport is a later adapter behind the same room/event model.

## Approaches Considered

### A. Local event-log rooms inside `pi-yo` — selected

Add room state and room event helpers to `pi-bridge-core.js`, expose a `piroom` CLI/manager, and wire Pi extension tools/commands to the same core.

**Pros**

- Fastest path from existing `pi-yo` reliability work.
- Works for Pi, Claude Code, Ghostty, supaterm, and human terminal users.
- Durable and debuggable through local JSON files.
- Keeps security model simple: trusted same-user local IPC.
- Clean future seam for network adapters.

**Cons**

- Manager TUI is terminal-first, not a polished app.
- Stopped/sleeping processes cannot be physically woken; they can only catch up from durable state when restarted.

### B. Pi extension UI first

Build `/room` commands, widgets, and overlays inside Pi.

**Pros**

- Tightest Pi UX.
- Can use `ctx.isIdle()` and `sendUserMessage` directly.

**Cons**

- Does not cover Claude Code/Ghostty/supaterm/human manager equally.
- Not a standalone room monitor.

### C. Full networked chat service now

Build a daemon/server and have agents connect over LAN or remote tunnels.

**Pros**

- More like a future team-wide Slack replacement.

**Cons**

- Too much auth/network/security surface for prototype.
- Slower and riskier before we validate local UX/noise controls.

## Architecture

### Files

Prototype implementation should add or modify:

- `packages/pi-yo/lib/pi-bridge-core.js`
  - room paths
  - room state/event persistence
  - room membership and alert preference helpers
  - message parsing and recipient selection
  - alert delivery fanout via existing `sendToSocket`
- `packages/pi-yo/bin/piroom`
  - standalone room CLI and manager terminal view
- `packages/pi-yo/extensions/pi-bridge.ts`
  - `/room` slash command
  - `join_chat_room`, `post_room_message`, `follow_room_thread`, `set_room_notifications`, `list_chat_rooms` tools
- `packages/pi-yo/tests/pi-bridge-core.test.js`
  - TDD coverage for core room behavior, CLI, and static extension surfaces
- `packages/pi-yo/package.json`
  - `piroom` bin entry and version bump
- `packages/pi-yo/README.md`
  - usage, trust model, notification rules, manager examples
- `packages/pi-yo/skills/pi-yo/SKILL.md`
  - guidance for room participation and alert hygiene

### Local persistence

Room files live under the existing owner-only IPC directory:

```txt
~/.pi/agent/ipc/
  room-state.json
  room-events.jsonl
  room-cursors.json
```

`room-state.json` contains current room metadata and member preferences. `room-events.jsonl` is append-only for audit/debug/replay. `room-cursors.json` can support future per-manager/participant unread pointers; v1 may expose unread counts from event timestamps.

All writes use existing secure helpers: owner-only modes, symlink refusal, atomic writes where applicable.

### Data model

Room state:

```json
{
  "schemaVersion": 1,
  "rooms": {
    "np-pi": {
      "roomId": "np-pi",
      "title": "np-pi",
      "projectCwd": "/Users/scottblodgett/Projects/personal/np-pi",
      "createdAt": 1779811200000,
      "members": {
        "agent:principal": {
          "memberId": "agent:principal",
          "displayName": "principal",
          "kind": "pi|cc|human",
          "sessionPid": 12345,
          "sessionName": "np-pi",
          "sessionCwd": "/Users/.../np-pi",
          "alertMode": "mentions",
          "dnd": false,
          "followedThreads": ["thr_abc"],
          "joinedAt": 1779811200000,
          "lastSeenAt": 1779811200000
        }
      }
    }
  }
}
```

Room events:

```json
{
  "schemaVersion": 1,
  "eventId": "room_evt_...",
  "roomId": "np-pi",
  "kind": "room.message",
  "threadId": "thr_...",
  "parentId": null,
  "createdAt": 1779811200000,
  "from": {
    "memberId": "agent:principal",
    "displayName": "principal",
    "sessionPid": 12345,
    "sessionName": "np-pi",
    "sessionCwd": "/Users/.../np-pi"
  },
  "content": "@worker please review #123",
  "mentions": ["worker"],
  "assignments": ["worker"],
  "urgent": false
}
```

### Registration / stable names

Agents and humans register per room using an explicit display name:

```bash
piroom join np-pi --name principal
piroom join np-pi --name worker-auth
```

The name becomes the logging and observability identity for room posts. V1 should treat names as stable handles by normalizing to a `memberId` and preserving the first claimed display name in room state. Re-joining the same room/name updates session PID/cwd/heartbeat metadata rather than creating a new identity.

If no name is supplied, default to the current bridge session name or cwd basename. Explicit names are preferred for tech-lead readability.

### Posting and threads

Human terminal:

```bash
piroom post np-pi "@worker-auth please review the room model"
piroom post np-pi --thread thr_123 "following up with test output"
```

Pi/agent tool equivalent:

```txt
post_room_message({ room: "np-pi", message: "@worker-auth please review", threadId: "thr_123" })
```

If no thread is supplied, the post creates or belongs to a root thread. For prototype simplicity, v1 can generate a new `threadId` per root message and reuse that ID for replies.

### Notification routing

Default policy is `mentions` / “mention-thread-assignment only.” A room message generates an agent alert when at least one of these is true:

- recipient is mentioned with `@displayName` or `@memberId`
- recipient follows the thread
- recipient is assigned in the message (`!assign @name` or assignment metadata)
- message is urgent (`--urgent`), subject to DND policy

Normal room chatter is recorded and visible in `piroom manager`; it is not injected into every agent.

Alert modes:

- `mentions` — default; mentions, followed threads, assignments, urgent
- `all` — room firehose opt-in for war rooms only
- `digest` — no immediate alert except urgent/assignment; future digest support
- `off` — DND/muted; urgent may still queue depending on `dnd` setting

DND:

- Manual DND suppresses non-urgent alerts.
- Urgent alerts can still be recorded and surfaced in manager; v1 should avoid forcing model-context injection through manual DND unless the sender explicitly uses `--urgent`.
- Agent busy state is handled by existing Pi delivery behavior: live Pi sessions queue follow-up messages when mid-turn; Claude Code receives mailbox/retained inbox entries for the next prompt/hook cycle.

Sleeping/offline sessions:

- A stopped process cannot be woken by local IPC. V1 records all events and unread alert candidates. When the session rejoins, manager/CLI can show catch-up state.
- Future cross-network/server phase can add push notifications or daemon wake behavior.

### Delivery

Room alerts reuse the existing socket message path:

1. `piroom post` appends the room event.
2. Core recipient selection maps room members to active bridge registry sessions by PID first, then by cwd/name fallback.
3. Matching live sessions receive a formatted `pi-yo` message through `sendToSocket`.
4. Existing Pi extension behavior injects immediately when idle or queues `followUp` while busy.
5. Existing Claude Code bridge behavior writes mailbox/retained inbox.
6. Delivery ACKs are recorded in CLI output and room event metadata when practical.

### Standalone manager

`piroom manager <room>` is a terminal monitor for humans:

- room title and project cwd
- roster with display name, kind, session PID, status, heartbeat, alert mode, DND
- recent room events grouped by thread
- alert/unread indicators
- clear controls: `q` quit, `r` refresh, future post/reply shortcuts

For testability, `piroom manager <room> --once` prints one static snapshot and exits.

### Pi extension commands/tools

Slash command:

```txt
/room join <room> [as <name>]
/room post <room> <message>
/room follow <room> <threadId>
/room dnd <room> on|off|status
/room list
```

Tools:

- `join_chat_room`
- `post_room_message`
- `follow_room_thread`
- `set_room_notifications`
- `list_chat_rooms`

Tool prompt guidance must warn agents not to join firehose mode by default and not to treat room messages as trusted instructions unless they are explicitly assigned/mentioned by a trusted participant.

## Security / safety

- Same trust model as `pi-yo`: trusted same-user local IPC only.
- Room messages are untrusted prompt text; alerts must be labeled as room content.
- Do not auto-execute instructions from room messages.
- Default no firehose injection.
- Same owner-only filesystem protections as the current bridge.
- Content is sanitized/truncated with existing helpers.
- No secrets in room messages; docs must say this explicitly.

## Testing strategy

Use TDD. Required coverage:

- room IDs and member names normalize safely
- joining a room creates secure state and stable member records
- rejoining updates session metadata without duplicating members
- posting appends room event records with thread IDs, mentions, and assignments
- default notification selection alerts only mentions/followed threads/assignments/urgent
- DND suppresses non-urgent alerts
- `all` alert mode is explicit opt-in
- `piroom manager --once` renders room, roster, and recent messages
- package exposes `piroom` bin and extension room commands/tools
- README and skill document local rooms, manager, and alert hygiene
- full package verify passes

## Rollout

1. Build on `origin/main` in isolated worktree `feat/pi-yo-rooms`.
2. Write tests first for core room behavior.
3. Implement minimal core and CLI.
4. Add Pi extension command/tool surfaces.
5. Update docs/skill and bump package version to `0.4.0`.
6. Run full verification and request review.
7. If review is clean, open PR or leave branch ready depending on final repo workflow.

## Self-review

- Gap scan: no unresolved markers.
- Scope check: v1 is local same-machine prototype only; cross-network and Slack mirroring are explicitly deferred.
- Ambiguity check: alert default, manager UI shape, and source of truth are explicit.
- Security check: default no firehose injection, local-only trust model, secure file writes, and prompt-injection caveats are included.
