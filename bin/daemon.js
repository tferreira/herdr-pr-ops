#!/usr/bin/env node
"use strict";

// Resident poller: refreshes the PR cache every `pollSeconds`, and on SIGUSR1,
// and shows a Herdr notification when something needs you. Started
// detached by the startup hook and by the dashboard; a pid file keeps it
// single-instance. Exits when the Herdr server goes away.

const fs = require("node:fs");
const { paths, readJSON, writeJSON, config, log, herdr, daemonPid } = require("../lib/util");
const { fetchAll } = require("../lib/github");

if (daemonPid() && daemonPid() !== process.pid) process.exit(0);
writeJSON(paths.pid, process.pid);

let prev = readJSON(paths.cache, null);
let timer = null;
let running = false;
let failures = 0;

const label = (pr) => `${pr.repoName}#${pr.number}`;

function notify(title, body, sound = "request") {
  try {
    herdr(["notification", "show", title, "--body", body, "--sound", sound]);
  } catch (e) {
    log("notify failed:", e.message);
  }
}

function diff(before, after) {
  const old = new Map(before.prs.map((p) => [p.url, p]));
  const events = [];
  for (const pr of after.prs) {
    const o = old.get(pr.url);
    if (pr.quiet) {
      if (pr.quiet.kind === "merged" && pr.tab === "mine" && !(o && o.quiet)) events.push(["Merged", `${label(pr)}\n${pr.title}`, "done"]);
      continue;
    }
    if (pr.tab === "review") {
      if (pr.col === 0 && (!o || o.col !== 0)) events.push(["Review requested", `${label(pr)} · ${pr.author}\n${pr.title}`]);
      if (pr.col === 1 && (!o || o.col !== 1)) events.push(["Re-check", `${label(pr)} · ${pr.reason}\n${pr.title}`]);
      continue;
    }
    if (!o) continue;
    if (pr.reviewDecision !== o.reviewDecision) {
      if (pr.reviewDecision === "APPROVED") events.push(["Approved", `${label(pr)}\n${pr.title}`, "done"]);
      if (pr.reviewDecision === "CHANGES_REQUESTED") events.push(["Changes requested", `${label(pr)}\n${pr.title}`]);
    }
    if (pr.ci === "fail" && o.ci !== "fail") events.push(["CI failed", `${label(pr)}\n${pr.title}`]);
    if (pr.conflict && !o.conflict) events.push(["Merge conflict", `${label(pr)}\n${pr.title}`]);
    if ((pr.toAnswer || 0) > (o.toAnswer || 0)) events.push(["Question on your PR", `${label(pr)} · ${pr.toAnswer} to answer\n${pr.title}`]);
  }
  return events;
}

// SIGUSR1: incremental scan. SIGUSR2 (the R key): refetch every PR's detail.
async function poll(full = false) {
  if (running) return;
  running = true;
  try {
    // Doubles as the liveness check: no server, no reason to keep polling.
    herdr(["workspace", "list"], { timeout: 10000 });
  } catch (e) {
    log("herdr unreachable, exiting:", e.message);
    cleanup();
  }
  try {
    writeJSON(paths.cache, { ...(readJSON(paths.cache, {}) || {}), refreshing: true });
    const launched = Object.keys(readJSON(paths.agents, {}));
    const next = await fetchAll(prev, { full, launched });
    writeJSON(paths.cache, next);
    if (prev && prev.prs) for (const [t, b, s] of diff(prev, next)) notify(t, b, s);
    prev = next;
    failures = 0;
    log(`scan${full ? " (full)" : ""}: ${next.prs.length} PRs, refetched ${next.rate.refetched}, cost ${next.rate.cost}, ${next.rate.remaining} points left`);
  } catch (e) {
    failures++;
    log("poll failed:", e.message);
    const cur = readJSON(paths.cache, {}) || {};
    writeJSON(paths.cache, { ...cur, refreshing: false, error: e.message, errorAt: new Date().toISOString() });
  } finally {
    running = false;
    schedule();
  }
}

// Back off on errors (a rate limit most of all): 2x per failure, max 30 min.
function schedule() {
  clearTimeout(timer);
  const base = Math.max(30, config().pollSeconds);
  timer = setTimeout(poll, Math.min(1800, base * 2 ** failures) * 1000);
}

function cleanup() {
  try {
    if (readJSON(paths.pid, 0) === process.pid) fs.unlinkSync(paths.pid);
  } catch {}
  process.exit(0);
}

process.on("SIGUSR1", () => poll(false));
process.on("SIGUSR2", () => poll(true));
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
log("daemon started, pid", process.pid);
poll();
