# pi-yo

Trusted-local inter-session messaging for Pi agents.

Source repository: <https://github.com/Neural-Partners/np-pi/tree/main/packages/pi-yo>

> **Status:** public npm package published as `@neuralpartners/pi-yo` (unscoped `pi-yo` is blocked by npm similarity rules).

## What it does

`pi-yo` lets local Pi sessions discover each other and send JSONL messages over owner-only Unix sockets. It provides:

- Pi LLM tools: `list_sessions`, `send_to_session`, `reply_to_session`
- slash commands: `/bridge-list`, `/bridge-send`, `/bridge-mailbox`, `/bridge-ping`, `/yo`
- CLI helpers: `pimsg`, `pi-cc-bridge`
- transport receipts: `ACK received` / `pong` from the recipient process

Use it as the walkie-talkie layer between agents that are already running in different terminals. Common coordination messages include:

- telling another agent a deploy started, finished, failed, or needs smoke testing
- warning that a file, branch, Terraform stack, local port, or package version is being edited
- asking a peer session to avoid a path while another agent owns it
- sharing dependency/API/schema changes before downstream work continues
- sending blockers, review requests, reproduction steps, or handoff notes without switching terminals
- replying with `reply_to_session` / `pimsg --reply` so agents do not create infinite reply loops

Transport ACK means the recipient process validated and accepted the frame for its local path. In the Pi extension path that means it queued the message for `sendUserMessage` or held it in the bridge mailbox; in `pi-cc-bridge` it means the message was appended to the mailbox. It does **not** mean the human or agent completed the work.

## License

`pi-yo` is released under the **MIT License**.

Commercial use, private use, modification, distribution, and forks are allowed under the MIT terms. See [`LICENSE`](LICENSE).

## Trust model

This package is for trusted same-user local IPC only.

- It is not an authentication boundary.
- Do not expose its sockets to remote hosts or untrusted local users.
- Inbound messages can be injected into model context by design when policy allows auto-inject.
- Treat all inbound message content as untrusted prompt-injection text.
- Same-UID malicious processes are out of scope; compromised peer sessions are only partially mitigated.

IPC files are owner-only by default:

- `~/.pi/agent/ipc`: `0700`
- registry, sockets, mailboxes, pid/log files: `0600` where the platform allows it

## Bridge policy

Policy lives outside the package:

```txt
~/.pi/agent/bridge-policy.json
```

Default policy preserves the original behavior:

```json
{
  "mode": "auto-inject",
  "allowlist": [],
  "rateLimit": { "perSenderPer10s": 5 }
}
```

Modes:

- `auto-inject`: inject allowed inbound messages into the receiving Pi conversation.
- `mailbox-only`: hold all inbound messages in the local bridge mailbox for manual review with `/bridge-mailbox`.

Allowlist behavior:

- Empty `allowlist` means any same-user local sender may auto-inject when `mode` is `auto-inject`.
- Non-empty `allowlist` means only matching senders auto-inject; non-matching senders are held in the mailbox.
- Match entries can use exact `pid`, `name`, or `cwd`:

```json
{
  "mode": "auto-inject",
  "allowlist": [{ "name": "backend" }, { "cwd": "/Users/me/project" }],
  "rateLimit": { "perSenderPer10s": 5 }
}
```

If a sender exceeds the per-sender rate limit, messages are held in the mailbox instead of auto-injected.

## Install

From Pi:

```bash
pi install npm:@neuralpartners/pi-yo
```

For local development, run temporarily:

```bash
pi -e ./packages/pi-yo/extensions/pi-bridge.ts
```

## Configuration

Roster config lives outside the package:

```txt
~/.pi/agent/bridge-roster.json
```

Public package defaults intentionally ship with no personal project aliases. Add local aliases in your own config.

## CLI

```bash
pimsg list
pimsg <target> "message"
pimsg --reply <target> "reply"
pimsg doctor --fix

pi-cc-bridge start
pi-cc-bridge mailbox
pi-cc-bridge stop
```

## Verification

```bash
npm run verify
```
