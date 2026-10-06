"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFile } = require("node:child_process");

const PLUGIN_ID = "tferreira.herdr-pr-ops";
const HOME = os.homedir();

function expand(p) {
  return p && p.startsWith("~") ? path.join(HOME, p.slice(1)) : p;
}

// Herdr injects these for actions, panes and hooks. The fallbacks only matter
// when a script is run by hand during development.
const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR || path.join(HOME, ".local/state/herdr-pr-ops");
const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(HOME, ".config/herdr-pr-ops");
fs.mkdirSync(STATE_DIR, { recursive: true });

const paths = {
  cache: path.join(STATE_DIR, "cache.json"),
  ui: path.join(STATE_DIR, "ui.json"),
  agents: path.join(STATE_DIR, "agents.json"),
  pid: path.join(STATE_DIR, "daemon.pid"),
  log: path.join(STATE_DIR, "plugin.log"),
  launches: path.join(STATE_DIR, "launches.json"),
  pendingTask: path.join(STATE_DIR, "pending-task.json"),
  pendingSetup: path.join(STATE_DIR, "pending-setup.json"),
  config: path.join(CONFIG_DIR, "config.json"),
};

const DEFAULT_CONFIG = {
  // Local clones are looked up as <repoRoot>/<repo name>, first match wins.
  repoRoots: ["~/code", "~/src", "~/projects", "~/repos", "~/git", "~/dev"],
  // Explicit overrides: { "acme/api": "~/work/api" }.
  repos: {},
  // Only PRs from these GitHub orgs (empty: all). Also limits the task repo
  // picker to clones whose origin is in one of them.
  orgs: [],
  // "owner/name" repos to hide.
  excludeRepos: [],
  pollSeconds: 180,
  // "font": herdr-radar's icon font and Nerd Font icons; "text": plain
  // Unicode; "auto": font when herdr-radar is installed.
  glyphs: "auto",
  // Any Herdr agent kind: claude, codex, gemini, ...
  agentKind: "claude",
  // Prompts sent to the agent. {url} {repo} {number} are filled in.
  prompts: {
    review:
      "Review the pull request {url}. Read its description, diff, CI status and existing review threads, " +
      "then list your findings ranked by severity with file and line. Don't post anything to GitHub " +
      "without asking me.",
    recheck:
      "Were my review comments on {url} addressed? Check the commits and thread replies since my last review. " +
      "For each of my threads say addressed, partially addressed or not addressed, and draft short follow-up " +
      "replies where needed. Don't post anything without asking me.",
    status:
      "Check the status of my pull request {url} and report only: don't change code, commit, push or post. " +
      "With gh, look at unresolved review threads, top-level comments and comment reviews (who asked what), " +
      "failing CI checks (which and why), merge conflicts and missing approvals. End with a short list of " +
      "what needs doing, or say that nothing does.",
    address:
      "Get my pull request {url} ready. With gh, go through unresolved review threads, top-level comments, " +
      "comment reviews, failing CI and merge conflicts. Fix what needs fixing or draft a reply explaining why " +
      "not, run the relevant tests, then show me a summary with the draft replies before you commit, push or " +
      "post anything.",
    deploy:
      "Merge and release these pull requests, in this order: {urls}. Follow this repository's release " +
      "process (README, CONTRIBUTING, CLAUDE.md, CI config). Check approvals, CI and conflicts first, " +
      "and confirm with me before merging.",
    // Any tracker without its own prompt ({label}: "Jira issue", ...).
    ticket:
      "Work on {label} {id}{urlNote}. Read it, including comments and linked issues, with your tools for " +
      "that tracker (if you have no access, ask me to paste it), then explore the relevant code in this repo. " +
      "Propose a plan and wait for my OK before changing code.",
    github:
      "Work on GitHub issue {id}{urlNote}. Read it with `gh issue view --comments`, then explore the relevant " +
      "code in this repo. Propose a plan and wait for my OK before changing code.",
    sentry:
      "Investigate Sentry issue {id}{urlNote}. Read it with the Sentry tools (stack trace, breadcrumbs, tags, " +
      "frequency, first and last seen; if you have no access to Sentry, ask me to paste the stack trace), find " +
      "the root cause in this repo, then propose a fix plan and wait for my OK before changing code.",
  },
  // Tracker base URLs, all optional: links for bare IDs, and the tracker a
  // bare PROJ-123 goes to (defaultTracker, else the first one configured).
  jiraUrl: null,
  linearUrl: null,
  youtrackUrl: null,
  defaultTracker: null,
  // Extra trackers: [{ name, label, urlPattern, idPattern, link, prompt }].
  trackers: [],
  sentryOrg: null,
  // Sentry project slug -> repo name, when they differ ({"web": "matrice-web"}).
  sentryProjects: {},
  // Task worktrees. {repo} is the clone path, {slug} proj123 / 1a / sentry123.
  taskWorktreePath: "{repo}-{slug}",
  // Where review worktrees go. {repo} is the local clone path, {number} the PR.
  worktreePath: "{repo}-pr{number}",
};

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Write through a temp file so a reader never sees half a file.
function writeJSON(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function config() {
  const user = readJSON(paths.config, {});
  return { ...DEFAULT_CONFIG, ...user, prompts: { ...DEFAULT_CONFIG.prompts, ...(user.prompts || {}) } };
}

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

function log(...parts) {
  const line = `${new Date().toISOString()} [${path.basename(process.argv[1] || "?")}] ${parts.join(" ")}\n`;
  try {
    fs.appendFileSync(paths.log, line);
  } catch {}
}

const HERDR = process.env.HERDR_BIN_PATH || "herdr";

// Run a herdr CLI command and return `.result`. Throws with the server's
// error message on failure.
function herdr(args, { timeout = 60000 } = {}) {
  const r = spawnSync(HERDR, args, { encoding: "utf8", timeout });
  if (r.status !== 0) {
    let msg = (r.stderr || r.stdout || "").trim();
    try {
      const err = JSON.parse(msg).error;
      if (err) msg = `${err.code || ""} ${err.message || ""}`.trim();
    } catch {}
    throw new Error(`herdr ${args.slice(0, 2).join(" ")}: ${msg || `exit ${r.status}`}`);
  }
  try {
    return JSON.parse(r.stdout).result;
  } catch {
    return r.stdout;
  }
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")}: ${(r.stderr || r.stdout || "").trim() || `exit ${r.status}`}`);
  }
  return r.stdout;
}

function shAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function daemonPid() {
  const pid = Number(readJSON(paths.pid, 0));
  return pid && pidAlive(pid) ? pid : 0;
}

// Start the poller detached unless one is already running.
function ensureDaemon() {
  if (daemonPid()) return;
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, [path.join(__dirname, "..", "bin", "daemon.js")], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

function localRepoPath(nameWithOwner) {
  const cfg = config();
  if (cfg.repos[nameWithOwner]) return expand(cfg.repos[nameWithOwner]);
  const name = nameWithOwner.split("/")[1];
  for (const root of cfg.repoRoots) {
    const p = path.join(expand(root), name);
    if (fs.existsSync(path.join(p, ".git"))) return p;
  }
  return null;
}

module.exports = {
  PLUGIN_ID,
  HOME,
  STATE_DIR,
  CONFIG_DIR,
  paths,
  readJSON,
  writeJSON,
  config,
  log,
  herdr,
  sh,
  shAsync,
  pidAlive,
  daemonPid,
  ensureDaemon,
  localRepoPath,
  expand,
  fill,
};
