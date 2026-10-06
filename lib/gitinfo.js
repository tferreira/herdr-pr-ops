"use strict";

// Which repo and branch is a directory checked out on? Reads .git files
// directly (no git process) so the dashboard can ask for every agent pane on
// every frame. Handles linked worktrees (.git file -> gitdir -> commondir).

const fs = require("node:fs");
const path = require("node:path");

const TTL = 10000;
const cache = new Map(); // dir -> { at, info }

function read(p) {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
}

function lookup(dir) {
  for (let d = dir; d && d !== path.dirname(d); d = path.dirname(d)) {
    const dotgit = path.join(d, ".git");
    let st;
    try {
      st = fs.statSync(dotgit);
    } catch {
      continue;
    }
    let gitdir = dotgit;
    if (st.isFile()) {
      const m = (read(dotgit) || "").match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      gitdir = path.resolve(d, m[1]);
    }
    const common = read(path.join(gitdir, "commondir"));
    const commonDir = common ? path.resolve(gitdir, common) : gitdir;
    const head = read(path.join(gitdir, "HEAD")) || "";
    const branch = (head.match(/^ref: refs\/heads\/(.+)$/) || [])[1] || null;
    const conf = read(path.join(commonDir, "config")) || "";
    const url = (conf.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/) || [])[1] || "";
    const m = url.match(/[:/]([^/:]+)\/([^/]+?)(\.git)?$/);
    return { root: d, branch, repo: m ? `${m[1]}/${m[2]}` : null };
  }
  return null;
}

function checkoutInfo(dir) {
  if (!dir) return null;
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < TTL) return hit.info;
  const info = lookup(dir);
  cache.set(dir, { at: Date.now(), info });
  return info;
}

module.exports = { checkoutInfo };
