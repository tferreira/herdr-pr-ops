"use strict";

// First-run detection: everything the setup screen can fill in by itself.
// Runs locally only: it asks gh about the user's own PRs, looks for git
// clones under the home directory, and reads coding-agent config files for
// tracker URLs. `node lib/setup.js --detect` prints the result as JSON.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { HOME } = require("./util");

const SKIP = new Set([
  "Library", "Applications", "Movies", "Music", "Pictures", "Public", "Desktop", "Documents",
  "Downloads", "Dropbox", "OneDrive", "Google Drive", "node_modules", "snap", "go", "venv",
]);
const MAX_ENTRIES = 6000;

function gh(args) {
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: 20000 });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || "gh failed").trim().split("\n")[0]);
  return r.stdout;
}

const tilde = (p) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);

function originOwner(dir) {
  let conf;
  try {
    conf = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
  } catch {
    return null;
  }
  const m = conf.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
  const o = m && m[1].match(/github\.com[:/]([^/:]+)\/[^/]+?(\.git)?$/);
  return o ? o[1] : null;
}

function isClone(dir) {
  try {
    return fs.statSync(path.join(dir, ".git")).isDirectory();
  } catch {
    return false;
  }
}

// Folders under ~ (one or two levels down) that hold GitHub clones, with
// how many clones per owner.
function findCloneDirs() {
  const found = new Map(); // dir -> Map(owner -> count)
  let budget = MAX_ENTRIES;
  const list = (dir) => {
    if (budget <= 0) return [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."));
      budget -= entries.length;
      return entries.map((e) => path.join(dir, e.name));
    } catch {
      return [];
    }
  };
  const scan = (parent, depth) => {
    for (const child of list(parent)) {
      if (depth === 0 && SKIP.has(path.basename(child))) continue;
      if (isClone(child)) {
        const owner = originOwner(child);
        if (!owner) continue;
        if (!found.has(parent)) found.set(parent, new Map());
        const m = found.get(parent);
        m.set(owner, (m.get(owner) || 0) + 1);
      } else if (depth === 0) {
        scan(child, 1);
      }
    }
  };
  scan(HOME, 0);
  return found;
}

// Tracker base URLs the user's coding agents are already connected to.
function findTrackers() {
  const files = [
    ".claude.json", ".claude/settings.json", ".codex/config.toml", ".cursor/mcp.json",
    ".gemini/settings.json", ".config/opencode/opencode.json",
  ].map((f) => path.join(HOME, f));
  const out = new Map(); // url -> { kind, url, source }
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const source = tilde(f);
    for (const m of text.matchAll(/https:\/\/([a-z0-9-]+)\.youtrack\.cloud/gi)) {
      out.set(`https://${m[1]}.youtrack.cloud`, { kind: "youtrack", url: `https://${m[1]}.youtrack.cloud`, source });
    }
    for (const m of text.matchAll(/https:\/\/([a-z0-9-]+)\.atlassian\.net/gi)) {
      out.set(`https://${m[1]}.atlassian.net`, { kind: "jira", url: `https://${m[1]}.atlassian.net`, source });
    }
    for (const m of text.matchAll(/https:\/\/linear\.app\/([a-z0-9-]+)/gi)) {
      out.set(`https://linear.app/${m[1]}`, { kind: "linear", url: `https://linear.app/${m[1]}`, source });
    }
  }
  return [...out.values()];
}

function detect() {
  const result = { login: null, ghError: null, orgs: [], clones: [], trackers: [], keys: [] };
  let nodes = [];
  try {
    result.login = gh(["api", "user", "--jq", ".login"]).trim();
    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const q = (s) => JSON.stringify(s);
    const query = `query {
      open: search(query: ${q("is:pr is:open involves:@me")}, type: ISSUE, first: 100) { nodes { ... on PullRequest { title repository { owner { login } } } } }
      recent: search(query: ${q(`is:pr involves:@me updated:>${since}`)}, type: ISSUE, first: 100) { nodes { ... on PullRequest { title repository { owner { login } } } } }
    }`;
    const data = JSON.parse(gh(["api", "graphql", "-f", `query=${query}`])).data;
    nodes = [...data.open.nodes, ...data.recent.nodes].filter((n) => n.repository);
  } catch (e) {
    result.ghError = e.message;
  }

  // Orgs: owners of the PRs the user is involved in, busiest first.
  const counts = new Map();
  for (const n of nodes) {
    const o = n.repository.owner.login;
    counts.set(o, (counts.get(o) || 0) + 1);
  }
  let member = [];
  try {
    member = gh(["api", "user/orgs", "--jq", ".[].login"]).split("\n").filter(Boolean);
  } catch {}
  for (const o of member) if (!counts.has(o)) counts.set(o, 0);
  result.orgs = [...counts.entries()]
    .map(([name, count]) => ({ name, count, personal: name === result.login }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const top = result.orgs.find((o) => !o.personal && o.count > 0);
  for (const o of result.orgs) o.checked = !!top && !o.personal && o.count >= Math.max(1, top.count / 4);

  // Clone folders holding repos of the orgs found above.
  const wanted = new Set(result.orgs.map((o) => o.name.toLowerCase()));
  for (const [dir, owners] of findCloneDirs()) {
    const byOrg = {};
    let total = 0;
    for (const [owner, n] of owners) {
      if (wanted.size && !wanted.has(owner.toLowerCase())) continue;
      byOrg[owner] = n;
      total += n;
    }
    if (total) result.clones.push({ dir: tilde(dir), byOrg, count: total });
  }
  result.clones.sort((a, b) => b.count - a.count);

  // Ticket keys in PR titles: [CORE-2364] fix(...) -> CORE.
  const keys = new Map();
  for (const n of nodes) {
    for (const m of n.title.matchAll(/\b([A-Z][A-Z0-9]{1,15})-\d+\b/g)) keys.set(m[1], (keys.get(m[1]) || 0) + 1);
  }
  result.keys = [...keys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);
  result.trackers = findTrackers();
  return result;
}

// Which clone folders and trackers to pre-select for the chosen orgs.
function preselect(result) {
  const orgs = new Set(result.orgs.filter((o) => o.checked).map((o) => o.name.toLowerCase()));
  for (const c of result.clones) {
    const n = Object.entries(c.byOrg).filter(([o]) => !orgs.size || orgs.has(o.toLowerCase())).reduce((s, [, v]) => s + v, 0);
    c.matching = n;
    c.checked = n > 0;
  }
  return result;
}

// The config.json changes for the choices on the setup screen.
function toConfig({ orgs, clones, tracker }) {
  const cfg = {};
  if (orgs.length) cfg.orgs = orgs;
  if (clones.length) cfg.repoRoots = clones;
  if (tracker) {
    cfg[`${tracker.kind}Url`] = tracker.url;
    cfg.defaultTracker = tracker.kind;
  }
  return cfg;
}

// Map a typed tracker URL to a tracker.
function trackerFromUrl(url) {
  const u = (url || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(u)) return null;
  if (/\.youtrack\.cloud$|youtrack/i.test(u)) return { kind: "youtrack", url: u.replace(/\/issue.*$/, "") };
  if (/atlassian\.net|\/jira/i.test(u)) return { kind: "jira", url: u.replace(/\/browse.*$/, "") };
  const lin = u.match(/^https:\/\/linear\.app\/[^/]+/);
  if (lin) return { kind: "linear", url: lin[0] };
  return null;
}

module.exports = { detect, preselect, toConfig, trackerFromUrl };

if (require.main === module && process.argv.includes("--detect")) {
  process.stdout.write(JSON.stringify(preselect(detect())));
}
