# pi-yo Usage Skill Design

## Goal

Bundle a Pi skill with `@neuralpartners/pi-yo` so installed agents know when and how to coordinate with other local Pi/Claude Code sessions safely.

## Current State

- `packages/pi-yo/package.json` exposes the extension at `pi.extensions` and an image, but no skills.
- `packages/pi-yo/extensions/pi-bridge.ts` registers LLM tools: `list_sessions`, `send_to_session`, and `reply_to_session`.
- `packages/pi-yo` already documents slash commands and CLI helpers in its README.
- Pi `skills.md` expects package skills under `skills/<name>/SKILL.md`; skill `name` must be lowercase hyphenated and match the parent directory.

## Selected Approach

Create `packages/pi-yo/skills/pi-yo/SKILL.md`, explicitly expose it via `pi.skills: ["./skills"]` in `packages/pi-yo/package.json`, and bump `@neuralpartners/pi-yo` from `0.1.6` to `0.2.0`.

This matches Pi's package docs and keeps the manifest explicit because `pi-yo` already uses the `pi` manifest for extension and gallery metadata. The skill will be concise and loaded only when cross-session coordination is relevant. The minor version bump reflects the new bundled Pi capability.

## Skill Content

The skill should cover:

- when to use pi-yo: user-requested inter-session coordination, handoffs, blockers, deploy/test status, review requests, shared-resource warnings
- when not to use it: no useful target session, private/secrets content, broad broadcast spam, or replies to messages already marked as replies
- tool workflow: run `list_sessions` before sending when target identity is unknown; use exact PID/name for duplicates; use `send_to_session` for new outbound messages; use `reply_to_session` for replies
- message hygiene: concise context, requested action, relevant paths/commands, whether a reply is required
- mailbox/policy awareness: ACK means accepted by transport, not completed; mailbox-only/allowlist/rate-limit policies can hold messages
- human fallbacks: `/bridge-list`, `/bridge-send`, `/bridge-mailbox`, `/bridge-ping`, `/yo`, `pimsg`, and `pi-cc-bridge`

## Verification

Add automated package tests that fail before the skill exists and pass after implementation:

- package manifest includes `pi.skills` with `./skills`
- skill file exists at `skills/pi-yo/SKILL.md`
- frontmatter name/description obey Pi `skills.md` rules
- description starts with `Use when`
- body includes the required tool and safety guidance

Run package tests, root verification, a direct Pi skill-loader validation, and `npm pack --dry-run` to confirm the skill is included.

## Self-Review

- No placeholders or unresolved decisions remain.
- Scope is limited to one package and one skill.
- The selected approach matches the user-approved design and Pi docs.
