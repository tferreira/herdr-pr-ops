#!/usr/bin/env node
"use strict";

// launch.js <review|recheck|status|address|deploy> <pr-url> [<pr-url>...] [--pane <id>] [--agent <kind>]
//   several urls: deploy only, one repo. --pane: an agent already on the PR
//   (picked by the dashboard), prompted instead of starting a new one when idle.
//   --agent: the Herdr agent kind to start (default: agentKind).
// launch.js task '{"kind":"jira","label":"Jira issue","id":"PROJ-123","url":null,"repoPath":"/.../api","repoName":"api"}'
//
// Starts (or reuses) a Claude pane for a PR. Reviews run in a Herdr worktree
// checked out at the PR head (branch pr-<N>); deploys run in a new tab of the
// repo's workspace. The dashboard runs this detached and follows progress
// through launches.json.

const fs = require("node:fs");
const path = require("node:path");
const { checkoutInfo } = require("../lib/gitinfo");
const { paths, readJSON, writeJSON, config, log, herdr, sh, localRepoPath, expand, fill, promptsFor } = require("../lib/util");

const argv = process.argv.slice(2);
const paneFlag = argv.indexOf("--pane");
const reusePane = paneFlag >= 0 ? argv.splice(paneFlag, 2)[1] : null;
const agentFlag = argv.indexOf("--agent");
const agentKind = (agentFlag >= 0 ? argv.splice(agentFlag, 2)[1] : null) || config().agentKind;
const [kind, arg, ...more] = argv;
const task = kind === "task" ? JSON.parse(arg) : null;
// launches.json / agents.json keys: the PR urls, or task:<ticket id>.
const keys = task ? [`task:${task.id}`] : [arg, ...more];
const url = keys[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(state, msg = "") {
  // Git and SSH errors carry \r and newlines that would garble the footer.
  msg = String(msg).replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  const all = readJSON(paths.launches, {});
  // The dashboard writes the entry before spawning us and drops it when the
  // agent is stopped mid-launch: a missing entry means cancelled.
  if (keys.some((k) => !all[k])) {
    log(`${kind} ${keys.join(" ")} cancelled`);
    process.exit(0);
  }
  for (const k of keys) {
    if (state === "done") delete all[k];
    else all[k] = { ...all[k], kind, state, msg, pid: process.pid, at: new Date().toISOString() };
  }
  writeJSON(paths.launches, all);
}

// {url} and {urls} both take every PR url (space separated) so a one-PR
// template like "/deploy {url}" also works for a multi-PR deploy. `agent`:
// the kind the prompt goes to, which picks the prompt set.
function prompts(prs, agent) {
  const urls = prs.map((p) => p.url).join(" ");
  const numbers = prs.map((p) => p.number).join(" ");
  return fill(promptsFor(agent)[kind], { url: urls, urls, repo: prs[0].repo, number: numbers, numbers });
}

function agentName(prs) {
  const pr = { ...prs[0], number: prs.map((p) => p.number).join("-") };
  const prefix = kind === "deploy" ? "deploy" : "pr";
  const room = Math.max(3, 32 - prefix.length - String(pr.number).length - 2);
  const repo = pr.repoName.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, room);
  return `${prefix}-${repo}-${pr.number}`;
}

function liveAgent(paneId) {
  if (!paneId) return null;
  const agents = herdr(["agent", "list"]).agents || [];
  return agents.find((a) => a.pane_id === paneId) || null;
}

// Creation results carry the new root pane; fall back to listing the
// workspace when a command only reports the workspace.
// A worktree inside the clone (the default, .claude/worktrees/) must not show
// up in the clone's own git status: its folder goes in .git/info/exclude,
// which is local and changes no tracked file.
function prepareWorktreePath(repo, wtPath) {
  const dir = path.dirname(wtPath);
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.relative(repo, dir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
  try {
    sh("git", ["-C", repo, "check-ignore", "--quiet", wtPath]);
    return;
  } catch {}
  const common = path.resolve(repo, sh("git", ["-C", repo, "rev-parse", "--git-common-dir"]).trim());
  const exclude = path.join(common, "info", "exclude");
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  let text = "";
  try {
    text = fs.readFileSync(exclude, "utf8");
  } catch {}
  fs.appendFileSync(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}/${rel.split(path.sep).join("/")}/\n`);
  log(`${exclude}: ignoring /${rel}/`);
}

function rootPane(result) {
  const pick = (o) => o && (o.pane_id || (o.root_pane && o.root_pane.pane_id) || (o.pane && o.pane.pane_id));
  const direct = pick(result) || pick(result && result.worktree) || pick(result && result.workspace);
  if (direct) return direct;
  const ws =
    (result && result.workspace && result.workspace.workspace_id) ||
    (result && result.workspace_id) ||
    (result && result.worktree && result.worktree.open_workspace_id);
  if (!ws) throw new Error(`no pane in result: ${JSON.stringify(result).slice(0, 300)}`);
  const panes = herdr(["pane", "list", "--workspace", ws]).panes || [];
  if (!panes.length) throw new Error(`workspace ${ws} has no panes`);
  return panes[0].pane_id;
}

// Fetch over HTTPS with gh's token. Plugin processes run inside the Herdr
// server, which often has no SSH agent, so `git fetch origin` over SSH fails
// with "Permission denied (publickey)" there even when it works in a pane.
// The URL names port 443 so a common `url.git@github.com:.insteadOf
// https://github.com/` rule does not turn it back into SSH, and the token
// travels in git's environment config, never in argv.
const GH_BASE = "https://github.com:443/";
let ghToken = null;
function ghEnv() {
  if (!ghToken) ghToken = sh("gh", ["auth", "token"]).trim();
  const auth = Buffer.from(`x-access-token:${ghToken}`).toString("base64");
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${GH_BASE}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}`,
  };
}

function fetchGh(repoPath, nameWithOwner, refspecs) {
  try {
    sh("git", ["-C", repoPath, "fetch", "--quiet", `${GH_BASE}${nameWithOwner}.git`, ...refspecs], { env: ghEnv() });
  } catch (e) {
    throw new Error(`git fetch ${nameWithOwner}: ${e.message.split(": ").slice(-1)[0]}`);
  }
}

// The local clone of a PR's repo, cloned into the first repoRoots folder that
// exists when there is none. Starting the agent elsewhere (~) does not work:
// Claude Code stops on its "trust this folder?" prompt in a folder you never
// opened it in, and the launch fails as not ready. The clone goes over HTTPS
// with gh's token like fetches, then origin is set to the URL a `gh repo
// clone` would give (gh's git_protocol), so pushing from it later works as
// from your other clones.
function ensureClone(nameWithOwner) {
  const found = localRepoPath(nameWithOwner);
  if (found) return found;
  const roots = config().repoRoots.map(expand);
  const root = roots.find((r) => {
    try {
      return fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
  if (!root) throw new Error(`no clone of ${nameWithOwner} and no repoRoots folder exists (${roots.join(", ")})`);
  const name = nameWithOwner.split("/")[1];
  const dest = path.join(root, name);
  if (fs.existsSync(dest)) throw new Error(`${dest} exists but is not a git clone, move it or set repos in config`);
  setStatus("starting", `cloning ${nameWithOwner}`);
  log(`no local clone for ${nameWithOwner}, cloning into ${dest}`);
  try {
    sh("git", ["clone", "--quiet", `${GH_BASE}${nameWithOwner}.git`, dest], { env: ghEnv() });
  } catch (e) {
    throw new Error(`git clone ${nameWithOwner}: ${e.message.split(": ").slice(-1)[0]}`);
  }
  let protocol = "https";
  try {
    protocol = sh("gh", ["config", "get", "git_protocol", "-h", "github.com"]).trim() || "https";
  } catch {}
  const origin = protocol === "ssh" ? `git@github.com:${nameWithOwner}.git` : `https://github.com/${nameWithOwner}.git`;
  sh("git", ["-C", dest, "remote", "set-url", "origin", origin]);
  return dest;
}

// My own PR: an existing checkout of its branch (moved to origin's head when
// clean), or a new worktree of it.
function addressPane(pr) {
  const repo = ensureClone(pr.repo);
  const label = `${pr.repoName}#${pr.number}`;
  const branch = pr.headRef;
  setStatus("starting", "fetching branch");
  fetchGh(repo, pr.repo, [`+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const remote = `refs/remotes/origin/${branch}`;
  const wts = herdr(["worktree", "list", "--cwd", repo]).worktrees || [];
  const wt = wts.find((w) => w.branch === branch);
  if (wt) {
    if (!sh("git", ["-C", wt.path, "status", "--porcelain"]).trim()) {
      try {
        sh("git", ["-C", wt.path, "merge", "--quiet", "--ff-only", remote]);
      } catch (e) {
        log(`${wt.path}: not fast-forwarded to origin (${e.message.split("\n")[0]})`);
      }
    }
    if (wt.open_workspace_id) {
      return rootPane(herdr(["tab", "create", "--workspace", wt.open_workspace_id, "--cwd", wt.path, "--label", "address", "--no-focus"]));
    }
    return rootPane(herdr(["worktree", "open", "--cwd", repo, "--path", wt.path, "--label", label, "--no-focus"]));
  }
  let hasBranch = true;
  try {
    sh("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  } catch {
    hasBranch = false;
  }
  if (!hasBranch) sh("git", ["-C", repo, "branch", "--track", branch, remote]);
  const wtPath = fill(config().worktreePath, { repo, number: pr.number });
  setStatus("starting", "creating worktree");
  prepareWorktreePath(repo, wtPath);
  return rootPane(herdr(["worktree", "create", "--cwd", repo, "--branch", branch, "--path", wtPath, "--label", label, "--no-focus"]));
}

function reviewPane(pr) {
  const repo = ensureClone(pr.repo);
  const label = `${pr.repoName}#${pr.number}`;
  const branch = `pr-${pr.number}`;
  const ref = `refs/remotes/origin/pr/${pr.number}`;
  setStatus("starting", "fetching PR head");
  fetchGh(repo, pr.repo, [`+refs/pull/${pr.number}/head:${ref}`]);

  const wts = herdr(["worktree", "list", "--cwd", repo]).worktrees || [];
  const wt = wts.find((w) => w.branch === branch);
  if (!wt) {
    sh("git", ["-C", repo, "branch", "-f", branch, ref]);
    setStatus("starting", "creating worktree");
    const wtPath = fill(config().worktreePath, { repo, number: pr.number });
    prepareWorktreePath(repo, wtPath);
    return rootPane(
      herdr(["worktree", "create", "--cwd", repo, "--branch", branch, "--path", wtPath, "--label", label, "--no-focus"]),
    );
  }
  // Review checkouts hold no local work, but never clobber one that does.
  if (!sh("git", ["-C", wt.path, "status", "--porcelain"]).trim()) {
    sh("git", ["-C", wt.path, "reset", "--quiet", "--hard", ref]);
  } else {
    log(`${wt.path} is dirty, not moving it to the new PR head`);
  }
  if (wt.open_workspace_id) {
    return rootPane(herdr(["tab", "create", "--workspace", wt.open_workspace_id, "--cwd", wt.path, "--label", "review", "--no-focus"]));
  }
  return rootPane(herdr(["worktree", "open", "--cwd", repo, "--branch", branch, "--label", label, "--no-focus"]));
}

function deployPane(prs) {
  const pr = prs[0];
  const repo = ensureClone(pr.repo);
  const label = `deploy ${prs.map((p) => `#${p.number}`).join(" ")}`;
  let ws = null;
  try {
    const main = (herdr(["worktree", "list", "--cwd", repo]).worktrees || []).find((w) => !w.is_linked_worktree);
    ws = main && main.open_workspace_id;
  } catch {}
  if (ws) return rootPane(herdr(["tab", "create", "--workspace", ws, "--cwd", repo, "--label", label, "--no-focus"]));
  return rootPane(herdr(["workspace", "create", "--cwd", repo, "--label", pr.repoName, "--no-focus"]));
}

// A fresh pane's shell may still be drawing its prompt; agent start refuses
// until it is ready, so retry a few times.
async function startAgent(name, pane) {
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      const extra = config().agentArgs[agentKind] || [];
      const args = ["agent", "start", i < 3 ? name : `${name.slice(0, 28)}-${i}`, "--kind", agentKind, "--pane", pane, "--timeout", "60000"];
      return herdr(extra.length ? [...args, "--", ...extra] : args, {
        timeout: 70000,
      });
    } catch (e) {
      lastErr = e;
      log(`agent start attempt ${i + 1}:`, e.message);
      // The pane was closed under us: retrying cannot bring it back.
      if (/agent_pane_not_found/.test(e.message)) break;
      await sleep(1500);
    }
  }
  throw lastErr;
}

// `agent start` can report a ready agent that never came up: a codex binary
// that macOS holds at launch leaves its command line as the terminal title,
// which herdr reads as an idle codex, and the prompt lands in a frozen
// terminal while the launch looks fine. With --wait, herdr fails with
// agent_prompt_stalled when no working or blocked state follows within 5s;
// a slow agent gets another 20s before the launch fails.
function promptAgent(pane, text, agent) {
  const busy = ["--until", "working", "--until", "blocked"];
  try {
    herdr(["agent", "prompt", pane, text, "--wait", ...busy, "--timeout", "15000"], { timeout: 20000 });
    return;
  } catch (e) {
    if (!/agent_prompt_stalled|timeout/.test(e.message)) throw e;
    log(`${pane}: ${e.message}`);
  }
  try {
    herdr(["agent", "wait", pane, ...busy, "--timeout", "20000"], { timeout: 25000 });
  } catch {
    throw new Error(`${agent} did not react to the prompt, it may be stuck starting: check that \`${agent} --version\` runs`);
  }
}

// Task worktrees start from the remote default branch, not whatever the
// main checkout happens to have checked out. An existing branch or worktree
// for the ticket is reused.
function taskPane(t) {
  const { slug, branchName } = require("../lib/tickets");
  const repo = t.repoPath;
  const branch = branchName(t);
  setStatus("starting", "fetching origin");
  let base;
  try {
    base = sh("git", ["-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
  } catch {
    base = "origin/master";
  }
  const nameWithOwner = (checkoutInfo(repo) || {}).repo;
  if (nameWithOwner) fetchGh(repo, nameWithOwner, [`+refs/heads/${base.replace(/^origin\//, "")}:refs/remotes/${base}`]);
  else sh("git", ["-C", repo, "fetch", "--quiet", "origin"]);
  const wtPath = fill(config().taskWorktreePath, { repo, slug: slug(t, t.repoName) });
  const wts = herdr(["worktree", "list", "--cwd", repo]).worktrees || [];
  const wt = wts.find((w) => w.branch === branch || w.path === wtPath);
  if (wt) {
    if (wt.open_workspace_id) {
      return rootPane(herdr(["tab", "create", "--workspace", wt.open_workspace_id, "--cwd", wt.path, "--label", t.id, "--no-focus"]));
    }
    return rootPane(herdr(["worktree", "open", "--cwd", repo, "--path", wt.path, "--label", t.id, "--no-focus"]));
  }
  const args = ["worktree", "create", "--cwd", repo, "--branch", branch, "--path", wtPath, "--label", t.id, "--no-focus"];
  let hasBranch = true;
  try {
    sh("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  } catch {
    hasBranch = false;
  }
  if (!hasBranch) args.push("--base", base);
  setStatus("starting", "creating worktree");
  prepareWorktreePath(repo, wtPath);
  return rootPane(herdr(args));
}

async function runTask(t) {
  const agents = readJSON(paths.agents, {});
  const live = liveAgent(agents[url] && agents[url].task);
  if (live) throw new Error(`an agent already works on ${t.id} (${live.pane_id})`);
  setStatus("starting", "opening pane");
  const pane = taskPane(t);
  setStatus("starting", "starting agent");
  const branch = require("../lib/tickets").branchName(t);
  const name = `t-${branch.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`.slice(0, 32);
  await startAgent(name, pane);
  const fresh = readJSON(paths.agents, {});
  fresh[url] = {
    task: pane,
    meta: { kind: t.kind, label: t.label, id: t.id, url: t.url, repoName: t.repoName, repo: (checkoutInfo(t.repoPath) || {}).repo, branch },
  };
  writeJSON(paths.agents, fresh);
  const cfg = config();
  const P = promptsFor(agentKind);
  const custom = (cfg.trackers || []).find((x) => x.name === t.kind);
  const tpl = (custom && custom.prompt) || P[t.kind] || P.ticket;
  const text = fill(tpl, { id: t.id, label: t.label, url: t.url || "", urlNote: t.url ? ` (${t.url})` : "" });
  promptAgent(pane, text, agentKind);
  setStatus("done");
  herdr(["notification", "show", `${t.label} task started`, "--body", `${t.id} in ${t.repoName}`, "--sound", "none"]);
  log(`task ${t.id} started in ${pane}`);
}

async function main() {
  if (task) return runTask(task);
  const cache = readJSON(paths.cache, { prs: [] });
  const prs = keys.map((k) => cache.prs.find((p) => p.url === k));
  const missing = keys.filter((k, i) => !prs[i]);
  if (missing.length) throw new Error(`PR not in cache: ${missing.join(" ")}`);
  if (new Set(prs.map((p) => p.repo)).size > 1) throw new Error("one launch per repo");
  const pr = prs[0];
  const slot = kind === "deploy" ? "deploy" : kind === "address" || kind === "status" ? "work" : "review";
  const agents = readJSON(paths.agents, {});
  const known = agents[url] && agents[url][slot];

  const live = keys.length === 1 ? liveAgent(reusePane) || liveAgent(known) : null;
  if (live) {
    if (!["idle", "done"].includes(live.agent_status)) {
      throw new Error(`agent is ${live.agent_status}, press enter to go to it`);
    }
    promptAgent(live.pane_id, prompts(prs, live.agent), live.agent);
    setStatus("done");
    return;
  }

  setStatus("starting", "opening pane");
  const pane =
    kind === "deploy" ? deployPane(prs) : kind === "address" || kind === "status" ? addressPane(pr) : reviewPane(pr);
  setStatus("starting", "starting agent");
  await startAgent(agentName(prs), pane);

  const fresh = readJSON(paths.agents, {});
  for (const k of keys) fresh[k] = { ...(fresh[k] || {}), [slot]: pane };
  writeJSON(paths.agents, fresh);

  promptAgent(pane, prompts(prs, agentKind), agentKind);
  setStatus("done");
  log(`${kind} (${agentKind}) started for ${keys.join(" ")} in ${pane}`);
}

main().catch((e) => {
  log(`${kind} ${keys.join(" ")} failed:`, e.message);
  setStatus("error", e.message.split("\n")[0].slice(0, 200));
  try {
    herdr(["notification", "show", `${kind} failed`, "--body", e.message.slice(0, 200), "--sound", "none"]);
  } catch {}
  process.exit(1);
});
