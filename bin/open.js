#!/usr/bin/env node
"use strict";

// open.js            open the dashboard popup (bound to prefix+d)
// open.js --refresh  ask the poller to scan now
// open.js --daemon   make sure the poller runs (startup hook)
// open.js --demo     open the dashboard with fake data
// open.js --task     open the dashboard on the new-task box, prefilled with
//                    the ctrl+clicked YouTrack / Sentry link if there is one

const { PLUGIN_ID, herdr, ensureDaemon, daemonPid, log, paths, writeJSON } = require("../lib/util");

const flag = process.argv[2];
if (flag !== "--demo") ensureDaemon();

if (flag === "--refresh") {
  // A freshly started daemon scans on its own; signal only a running one.
  setTimeout(() => {
    const pid = daemonPid();
    if (pid) process.kill(pid, "SIGUSR2");
  }, 200);
} else if (flag !== "--daemon") {
  if (flag === "--task") writeJSON(paths.pendingTask, { input: process.env.HERDR_PLUGIN_CLICKED_URL || "" });
  try {
    herdr(["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", flag === "--demo" ? "demo" : "board"]);
  } catch (e) {
    log("open failed:", e.message);
    process.exit(1);
  }
}
