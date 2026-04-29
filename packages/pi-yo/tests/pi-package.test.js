#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
    "task ACK",
    "ack | deliverable | blocker | qa-result",
    "Target by exact PID, cwd, or role alias",
    "one assignment → one ACK → one deliverable",
    "runId",
    "msgId",
    "replyTo",
    "No auto-execution from message text",
    "Reserve message IDs up front",
    "Do not send secrets",
    "set_session_visibility",
    "invisible",
    "Exact PID",
  ]) {
    assert.match(skill, new RegExp(escapeRegExp(required)));
  }
});

test("README documents invisible session mode", () => {
  const readme = fs.readFileSync(path.join(packageRoot, "README.md"), "utf-8");

  for (const required of [
    "Invisible sessions",
    "/bridge-visibility invisible",
    "set_session_visibility",
    "pimsg list --all",
    "Exact PID",
  ]) {
    assert.match(readme, new RegExp(escapeRegExp(required)));
  }
});

test("extension exposes self visibility controls", () => {
  const extensionPath = path.join(packageRoot, "extensions", "pi-bridge.ts");
  const extension = fs.readFileSync(extensionPath, "utf-8");

  for (const required of [
    "bridgeVisibility",
    "bridge-visibility",
    "set_session_visibility",
    "This session is hidden from normal pi-yo discovery",
    "Exact PID still works",
  ]) {
    assert.match(extension, new RegExp(escapeRegExp(required)));
  }
});
