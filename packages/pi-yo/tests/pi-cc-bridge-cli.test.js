#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
  const realCwd = fs.realpathSync(cwd);
  return core.sessionReaderKey({ name: `${path.basename(realCwd)} (CC)`, cwd: realCwd });
}

test("pi-cc-bridge inbox reads retained events and consume advances only its cursor", () => {
  const home = tempHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cwd-"));
  const paths = core.buildPaths(home);
  const readerKey = ccReaderKey(cwd);

  core.appendBridgeEvent({
    kind: "message.accepted",
    messageId: "msg_1",
    from: { pid: 111, name: "agent", cwd: "/repo/agent" },
    to: { pid: 222, name: `${path.basename(cwd)} (CC)`, cwd, readerKey },
    content: "first retained message",
    acceptedAt: 1000,
  }, { eventsFile: paths.eventsFile });

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

  core.appendBridgeEvent({
    kind: "message.accepted",
    messageId: "msg_hook",
    from: { pid: 111, name: "agent", cwd: "/repo/agent" },
    to: { pid: 222, name: `${path.basename(cwd)} (CC)`, cwd, readerKey },
    content: "hook message",
    acceptedAt: 1000,
  }, { eventsFile: paths.eventsFile });

  const result = runBridge(home, cwd, ["inbox", "--format", "hook", "--consume"]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(parsed.hookSpecificOutput.additionalContext, /hook message/);

  const empty = runBridge(home, cwd, ["inbox", "--format", "hook", "--consume"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout.trim(), "");
});

test("pi-cc-bridge state reports target state", () => {
  const home = tempHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cwd-"));
  const paths = core.buildPaths(home);
  core.writeRegistry({ sessions: [
    { pid: process.pid, name: "agent", cwd, socketPath: path.join(paths.ipcDir, `${process.pid}.sock`), startedAt: Date.now(), readerKey: `pi:${process.pid}` },
  ] }, paths.registryFile);
  core.updateSessionStatus({
    pid: process.pid,
    name: "agent",
    cwd,
    status: "blocked",
    blockedOn: "waiting on deploy",
  }, { stateFile: paths.stateFile });

  const result = runBridge(home, cwd, ["state", "agent"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status: blocked/);
  assert.match(result.stdout, /blockedOn: waiting on deploy/);
});
