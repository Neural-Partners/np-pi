#!/usr/bin/env node
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const core = require("../lib/pi-bridge-core.js");
const pimsg = path.resolve(__dirname, "..", "bin", "pimsg");

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pimsg-home-"));
}

function runPimsg(home, args) {
  return spawnSync(process.execPath, [pimsg, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, HOME: home },
    encoding: "utf-8",
  });
}

test("pimsg list hides invisible sessions by default and list --all shows them", () => {
  const home = tempHome();
  const paths = core.buildPaths(home);
  core.writeRegistry({ sessions: [
    { pid: process.pid, name: "visible", cwd: "/workspace/visible", socketPath: path.join(paths.ipcDir, `${process.pid}.sock`), startedAt: Date.now() },
    { pid: process.pid, name: "standby", cwd: "/workspace/standby", socketPath: path.join(paths.ipcDir, `${process.pid}.sock`), startedAt: Date.now(), bridgeVisibility: "invisible" },
  ] }, paths.registryFile);

  const normal = runPimsg(home, ["list"]);
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(normal.stdout, /visible/);
  assert.doesNotMatch(normal.stdout, /standby/);

  const all = runPimsg(home, ["list", "--all"]);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /visible/);
  assert.match(all.stdout, /standby/);
  assert.match(all.stdout, /\[invisible\]/);
});

test("pimsg state reports self-reported status and list --with-status includes compact status", () => {
  const home = tempHome();
  const paths = core.buildPaths(home);
  core.writeRegistry({ sessions: [
    { pid: process.pid, name: "agent", cwd: process.cwd(), socketPath: path.join(paths.ipcDir, `${process.pid}.sock`), startedAt: Date.now(), readerKey: `pi:${process.pid}` },
  ] }, paths.registryFile);
  core.updateSessionStatus({
    pid: process.pid,
    name: "agent",
    cwd: process.cwd(),
    status: "working",
    currentTask: "Build state command",
  }, { stateFile: paths.stateFile });

  const state = runPimsg(home, ["state", "agent"]);
  assert.equal(state.status, 0, state.stderr);
  assert.match(state.stdout, /status: working/);
  assert.match(state.stdout, /currentTask: Build state command/);

  const list = runPimsg(home, ["list", "--with-status"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /\[working\]/);
});
