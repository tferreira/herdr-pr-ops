#!/usr/bin/env node
"use strict";

// stop.js <pane-id>
//
// Stop an agent from the board without leaving empty layout behind:
//   - the pane's tab holds other panes   -> close just the pane
//   - it is the tab's only pane          -> close the tab (Herdr closes the
//                                           workspace with its last tab)
//   - and it is a clean review worktree  -> `worktree remove`: checkout and
//     (branch pr-<N>, last tab)             workspace go, the branch stays
// Task and address worktrees hold your work and are never removed, nor is a
// main clone. The PR stays on the board; only its agent goes.

const { paths, readJSON, writeJSON, log, herdr, sh } = require("../lib/util");
const { checkoutInfo } = require("../lib/gitinfo");

const pane = process.argv[2];

function forget() {
  const map = readJSON(paths.agents, {});
  for (const [url, slots] of Object.entries(map)) {
    for (const [slot, p] of Object.entries(slots)) if (p === pane) delete slots[slot];
    if (!Object.keys(slots).some((k) => k !== "meta")) delete map[url];
  }
  writeJSON(paths.agents, map);
}

function main() {
  const info = herdr(["pane", "get", pane]).pane;
  const ws = pane.split(":")[0];
  const tabs = herdr(["tab", "list", "--workspace", ws]).tabs || [];
  const tab = tabs.find((t) => t.tab_id === info.tab_id);
  const alone = tab && tab.pane_count <= 1;
  const lastTab = alone && tabs.length === 1;
  const co = checkoutInfo(info.foreground_cwd || info.cwd);
  const review = co && /^pr-\d+$/.test(co.branch || "") && co.root !== undefined;

  if (lastTab && review && !sh("git", ["-C", co.root, "status", "--porcelain"]).trim()) {
    try {
      herdr(["worktree", "remove", "--workspace", ws]);
      log(`stopped ${pane}: removed review worktree ${co.root}`);
      return forget();
    } catch (e) {
      log(`worktree remove failed (${e.message}), closing the tab instead`);
    }
  }
  if (alone) herdr(["tab", "close", info.tab_id]);
  else herdr(["pane", "close", pane]);
  log(`stopped ${pane}: closed ${alone ? `tab ${info.tab_id}` : "pane"}`);
  forget();
}

try {
  main();
} catch (e) {
  log(`stop ${pane} failed:`, e.message);
  try {
    herdr(["notification", "show", "Stop failed", "--body", e.message.slice(0, 200), "--sound", "none"]);
  } catch {}
  process.exit(1);
}
