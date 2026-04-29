# pi-yo Usage Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle a `pi-yo` Pi skill with `@neuralpartners/pi-yo` so agents have precise inter-session coordination guidance.

**Architecture:** Add a package-level skill at `packages/pi-yo/skills/pi-yo/SKILL.md`, expose it through the existing package `pi` manifest, bump the package to `0.2.0`, and document it in the package README. Add tests that treat the skill and package manifest as the contract.

**Tech Stack:** Pi Agent Skills markdown format, Node.js built-in test runner, npm workspace verification, Prettier.

---

## File Structure

- Create: `packages/pi-yo/skills/pi-yo/SKILL.md` — bundled Pi skill loaded on demand by Pi.
- Modify: `packages/pi-yo/package.json` — add explicit `pi.skills: ["./skills"]`, bump version to `0.2.0`, and preserve existing extension/image metadata.
- Modify: `package-lock.json` — sync the workspace package version bump.
- Modify: `packages/pi-yo/README.md` — mention bundled skill and core agent workflow.
- Create: `packages/pi-yo/tests/pi-package.test.js` — add contract tests for skill packaging and required content.
- Create: `docs/superpowers/specs/2026-04-28-pi-yo-usage-skill-design.md` — approved design record.
- Create: `docs/superpowers/plans/2026-04-28-pi-yo-usage-skill-implementation.md` — this plan.

## Task 1: Add failing package tests for the bundled skill contract

**Files:**

- Create: `packages/pi-yo/tests/pi-package.test.js`

- [ ] **Step 1: Add the failing skill contract test**

Create `packages/pi-yo/tests/pi-package.test.js`:

```js
#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");

test("package exposes the bundled pi-yo skill with required coordination guidance", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"),
  );
  assert.deepEqual(packageJson.pi.skills, ["./skills"]);

  const skillPath = path.join(packageRoot, "skills", "pi-yo", "SKILL.md");
  const skill = fs.readFileSync(skillPath, "utf-8");

  assert.match(skill, /^---\nname: pi-yo\ndescription: Use when .+\n---/m);
  assert.ok(skill.length < 12000);

  for (const required of [
    "list_sessions",
    "send_to_session",
    "reply_to_session",
    "/bridge-mailbox",
    "ACK means transport accepted the message",
    "Do not send secrets",
  ]) {
    assert.match(
      skill,
      new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd packages/pi-yo
npm test
```

Expected: FAIL because `packageJson.pi.skills` is missing and/or `skills/pi-yo/SKILL.md` does not exist.

## Task 2: Create the `pi-yo` skill, expose it in the package manifest, and bump the package

**Files:**

- Create: `packages/pi-yo/skills/pi-yo/SKILL.md`
- Modify: `packages/pi-yo/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Create the skill file**

Create `packages/pi-yo/skills/pi-yo/SKILL.md` with frontmatter:

```markdown
---
name: pi-yo
description: Use when coordinating with other local Pi or Claude Code agent sessions through pi-yo inter-session messaging, handoffs, blocker updates, review requests, shared-resource warnings, or replies to incoming bridge messages.
---
```

The body should include sections for: overview, when to use, agent workflow, message template, safety rules, mailbox/policy notes, human command fallback, common mistakes, and quick reference.

- [ ] **Step 2: Add the package manifest skill entry and version bump**

Update `packages/pi-yo/package.json` so `version` is `0.2.0` and the `pi` object is:

```json
"pi": {
  "extensions": [
    "./extensions/pi-bridge.ts"
  ],
  "skills": [
    "./skills"
  ],
  "image": "https://raw.githubusercontent.com/Neural-Partners/np-pi/main/packages/pi-yo/assets/pi-to-claude-code-flow.png"
}
```

- [ ] **Step 3: Sync the lockfile version**

Run from repo root:

```bash
npm version 0.2.0 --workspace @neuralpartners/pi-yo --no-git-tag-version
```

Expected: `packages/pi-yo/package.json` and `package-lock.json` both record `0.2.0`.

- [ ] **Step 4: Run the package tests and verify GREEN**

Run:

```bash
cd packages/pi-yo
npm test
```

Expected: PASS.

## Task 3: Document the bundled skill in the package README

**Files:**

- Modify: `packages/pi-yo/README.md`

- [ ] **Step 1: Add a concise bundled skill section**

Add a section after `## What it does` or before `## Install`:

```markdown
## Bundled Pi skill

This package includes the `pi-yo` skill. When installed, Pi can load it for inter-session coordination workflows: discover peers with `list_sessions`, send new handoffs with `send_to_session`, and answer inbound bridge messages with `reply_to_session` to avoid reply loops.
```

- [ ] **Step 2: Run formatting check**

Run:

```bash
npm run format:check
```

Expected: PASS.

## Task 4: Validate Pi skill loading and package contents

**Files:**

- No source edits unless verification exposes an issue.

- [ ] **Step 1: Run Pi skill-loader validation through Pi internals**

Run from repo root:

```bash
node --input-type=module -e 'import { loadSkillsFromDir } from "/Users/scottblodgett/.nvm/versions/node/v22.22.2/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/skills.js"; const result = loadSkillsFromDir({ dir: "packages/pi-yo/skills", source: "path" }); console.log(JSON.stringify({ skills: result.skills.map((s) => ({ name: s.name, description: s.description })), diagnostics: result.diagnostics }, null, 2)); if (result.diagnostics.length || !result.skills.some((s) => s.name === "pi-yo")) process.exit(1);'
```

Expected: JSON includes one skill named `pi-yo` and an empty diagnostics array.

- [ ] **Step 2: Run full root verification**

Run:

```bash
npm run verify
```

Expected: PASS.

- [ ] **Step 3: Confirm npm package includes the skill**

Run:

```bash
cd packages/pi-yo
npm pack --dry-run
```

Expected: output includes `skills/pi-yo/SKILL.md`.

## Task 5: Review and report

**Files:**

- Modify: `.claude/todo.md`

- [ ] **Step 1: Review the diff**

Run:

```bash
git diff -- package-lock.json packages/pi-yo/package.json packages/pi-yo/README.md packages/pi-yo/tests/pi-package.test.js packages/pi-yo/skills/pi-yo/SKILL.md docs/superpowers/specs/2026-04-28-pi-yo-usage-skill-design.md docs/superpowers/plans/2026-04-28-pi-yo-usage-skill-implementation.md
```

Confirm the diff only changes the approved skill/package/docs scope.

- [ ] **Step 2: Update `.claude/todo.md`**

Mark implementation and verification items complete.

- [ ] **Step 3: Report results**

Summarize changed files and verification commands with pass/fail status.

## Self-Review

- Spec coverage: all approved design points are covered by tasks 1-4.
- Placeholder scan: no `TBD`, `TODO`, or vague implementation placeholders remain.
- Type/path consistency: package paths use `packages/pi-yo/...`; skill name and directory are both `pi-yo`.
