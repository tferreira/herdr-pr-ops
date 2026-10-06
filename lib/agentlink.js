"use strict";

// Which PR is each agent working on?
//
// An agent's shell often sits in the main clone while it edits files in a
// worktree (Claude Code does not cd), so the checkout of its cwd is a weak
// hint. Stronger evidence: the agent's terminal title (agents set it to the
// current topic), and for Claude Code the tail of its session transcript,
// where PR URLs, worktree paths, branch names and ticket IDs show up.
// Every PR gets a score from that evidence and each agent goes to its single
// best match, so one agent never lights up two cards.

const fs = require("node:fs");
const path = require("node:path");
const { HOME } = require("./util");
const { checkoutInfo } = require("./gitinfo");

const TAIL_BYTES = 160 * 1024;
const MIN_SCORE = 4;
const tails = new Map(); // file -> { mtimeMs, text }
const sessionFiles = new Map(); // session id -> transcript path | null

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (text, re) => Math.min(5, (text.match(re) || []).length);

function transcriptPath(agent) {
  const s = agent.agent_session;
  if (!s || s.agent !== "claude" || s.kind !== "id" || !s.value) return null;
  if (sessionFiles.has(s.value)) return sessionFiles.get(s.value);
  const projects = path.join(HOME, ".claude", "projects");
  let found = null;
  const cwd = agent.cwd || agent.foreground_cwd;
  if (cwd) {
    const guess = path.join(projects, cwd.replace(/[/.]/g, "-"), `${s.value}.jsonl`);
    if (fs.existsSync(guess)) found = guess;
  }
  if (!found) {
    try {
      for (const d of fs.readdirSync(projects)) {
        const p = path.join(projects, d, `${s.value}.jsonl`);
        if (fs.existsSync(p)) {
          found = p;
          break;
        }
      }
    } catch {}
  }
  sessionFiles.set(s.value, found);
  return found;
}

function tail(file) {
  if (!file) return "";
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return "";
  }
  const hit = tails.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
  const len = Math.min(TAIL_BYTES, st.size);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, len, st.size - len);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString("utf8");
  tails.set(file, { mtimeMs: st.mtimeMs, text });
  return text;
}

// Ticket-like IDs in a PR's title and branch: PROJ-123, API-1A.
function ticketIds(pr) {
  const ids = new Set();
  for (const src of [pr.title || "", pr.headRef || ""]) {
    for (const m of src.matchAll(/\b([A-Z][A-Z0-9]{1,15}-[0-9][0-9A-Z]*|[A-Z][A-Z0-9]{1,15}-[0-9A-Z]{2,4})\b/gi)) {
      if (/\d/.test(m[1].split("-")[1])) ids.add(m[1].toUpperCase());
    }
  }
  return [...ids];
}

// Branches of the worktrees an agent touched, from absolute paths in its
// transcript that point inside a git checkout.
function touchedBranches(text, repoName) {
  const out = new Map(); // branch -> mentions
  const re = new RegExp(`(/[^\\s"'\`\\\\]*?/${escapeRe(repoName)}[-_.][A-Za-z0-9._-]+)`, "g");
  const seen = new Map();
  for (const m of text.matchAll(re)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  for (const [p, n] of seen) {
    const info = checkoutInfo(p);
    if (info && info.branch) out.set(info.branch, (out.get(info.branch) || 0) + n);
  }
  return out;
}

const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk"]);

// Transcript evidence only counts for agents whose cwd is in a checkout of
// the PR's repo: a session elsewhere (say, one that just talked about PRs)
// is linked by its title alone. An agent in another repo never matches.
function score(agent, pr, evidence) {
  const { title, cwdInfo } = evidence;
  const knownRepo = cwdInfo && cwdInfo.repo;
  if (knownRepo && cwdInfo.repo.toLowerCase() !== pr.repo.toLowerCase()) return 0;
  const text = knownRepo ? evidence.text : "";
  let s = 0;
  const num = new RegExp(`${escapeRe(pr.repoName)}/pull/${pr.number}\\b`, "gi");
  s += 5 * count(text, num) + 8 * count(title, num);
  if (knownRepo && new RegExp(`(^|[^0-9])#${pr.number}\\b`).test(title)) s += 6;
  if (pr.headRef && !DEFAULT_BRANCHES.has(pr.headRef) && pr.headRef.length >= 4) {
    const br = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(pr.headRef)}($|[^A-Za-z0-9_-])`, "g");
    s += 3 * count(text, br) + 6 * count(title, br);
    const touched = knownRepo && evidence.branches.get(pr.repoName);
    if (touched && touched.get(pr.headRef)) s += 4 * Math.min(5, touched.get(pr.headRef));
  }
  for (const id of ticketIds(pr)) {
    const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(id)}($|[^0-9A-Za-z])`, "gi");
    s += 2 * count(text, re) + 6 * count(title, re);
  }
  if (knownRepo && (cwdInfo.branch === pr.headRef || cwdInfo.branch === `pr-${pr.number}`)) s += MIN_SCORE;
  return s;
}

// agents: Map pane -> agent. launched: { prUrl: { slot: pane } }.
// Returns Map prUrl -> [agent].
function linkAgents(agents, prs, launched) {
  const byPane = new Map();
  for (const [url, slots] of Object.entries(launched || {})) {
    if (!/^https?:\/\//.test(url)) continue; // task:<id> entries are not PRs
    for (const pane of Object.values(slots)) if (typeof pane === "string" && agents.has(pane)) byPane.set(pane, url);
  }
  for (const a of agents.values()) {
    if (byPane.has(a.pane_id)) continue;
    const title = a.terminal_title_stripped || a.terminal_title || "";
    const text = tail(transcriptPath(a));
    const cwdInfo = checkoutInfo(a.foreground_cwd || a.cwd);
    const branches = new Map();
    if (cwdInfo && cwdInfo.repo) branches.set(cwdInfo.repo.split("/")[1], touchedBranches(text, cwdInfo.repo.split("/")[1]));
    const evidence = { title, text, cwdInfo, branches };
    let best = null;
    let bestScore = 0;
    let tie = false;
    for (const pr of prs) {
      const sc = score(a, pr, evidence);
      if (sc > bestScore) {
        best = pr;
        bestScore = sc;
        tie = false;
      } else if (sc === bestScore && sc > 0) tie = true;
    }
    if (best && bestScore >= MIN_SCORE && !tie) byPane.set(a.pane_id, best.url);
  }
  const byPr = new Map();
  for (const [pane, url] of byPane) {
    if (!byPr.has(url)) byPr.set(url, []);
    byPr.get(url).push(agents.get(pane));
  }
  return byPr;
}

module.exports = { linkAgents };
