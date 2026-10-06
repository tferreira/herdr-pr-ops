#!/usr/bin/env node
"use strict";

// launch.js <review|recheck|deploy> <pr-url>
// launch.js task '{"kind":"youtrack","id":"PROJ-123","url":null,"repoPath":"/.../api"}'
//
// Starts (or reuses) a Claude pane for a PR. Reviews run in a Herdr worktree
// checked out at the PR head (branch pr-<N>); deploys run in a new tab of the
// repo's workspace. The dashboard runs this detached and follows progress
// through launches.json.

const { paths, readJSON, writeJSON, config, log, herdr, sh, localRepoPath, HOME, fill } = require("../lib/util");

const [kind, arg] = process.argv.slice(2);
const task = kind === "task" ? JSON.parse(arg) : null;
// launches.json / agents.json key: the PR url, or task:<ticket id>.
const url = task ? `task:${task.id}` : arg;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(state, msg = "") {
  const all = readJSON(paths.launches, {});
  if (state === "done") delete all[url];
  else all[url] = { kind, state, msg, at: new Date().toISOString() };
  writeJSON(paths.launches, all);
}

function prompts(pr) {
  return fill(config().prompts[kind], { url: pr.url, repo: pr.repo, number: pr.number });
}

function agentName(pr) {
  const prefix = kind === "deploy" ? "deploy" : "pr";
  const room = 32 - prefix.length - String(pr.number).length - 2;
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

function reviewPane(pr) {
  const repo = localRepoPath(pr.repo);
  const label = `${pr.repoName}#${pr.number}`;
  if (!repo) {
    log(`no local clone for ${pr.repo}, reviewing from ~`);
    return rootPane(herdr(["workspace", "create", "--cwd", HOME, "--label", label, "--no-focus"]));
  }
  const branch = `pr-${pr.number}`;
  const ref = `refs/remotes/origin/pr/${pr.number}`;
  setStatus("starting", "fetching PR head");
  sh("git", ["-C", repo, "fetch", "--quiet", "origin", `+refs/pull/${pr.number}/head:${ref}`]);

  const wts = herdr(["worktree", "list", "--cwd", repo]).worktrees || [];
  const wt = wts.find((w) => w.branch === branch);
  if (!wt) {
    sh("git", ["-C", repo, "branch", "-f", branch, ref]);
    setStatus("starting", "creating worktree");
    const wtPath = fill(config().worktreePath, { repo, number: pr.number });
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

function deployPane(pr) {
  const repo = localRepoPath(pr.repo) || HOME;
  const label = `deploy #${pr.number}`;
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
  const kindName = config().agentKind;
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      return herdr(["agent", "start", i < 3 ? name : `${name.slice(0, 28)}-${i}`, "--kind", kindName, "--pane", pane, "--timeout", "60000"], {
        timeout: 70000,
      });
    } catch (e) {
      lastErr = e;
      log(`agent start attempt ${i + 1}:`, e.message);
      await sleep(1500);
    }
  }
  throw lastErr;
}

// Task worktrees start from the remote default branch, not whatever the
// main checkout happens to have checked out. An existing branch or worktree
// for the ticket is reused.
function taskPane(t) {
  const { slug } = require("../lib/tickets");
  const repo = t.repoPath;
  const branch = t.id;
  setStatus("starting", "fetching origin");
  sh("git", ["-C", repo, "fetch", "--quiet", "origin"]);
  const wtPath = fill(config().taskWorktreePath, { repo, slug: slug(t) });
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
  if (!hasBranch) {
    let base;
    try {
      base = sh("git", ["-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).trim();
    } catch {
      base = "origin/master";
    }
    args.push("--base", base);
  }
  setStatus("starting", "creating worktree");
  return rootPane(herdr(args));
}

async function runTask(t) {
  const agents = readJSON(paths.agents, {});
  const live = liveAgent(agents[url] && agents[url].task);
  if (live) throw new Error(`an agent already works on ${t.id} (${live.pane_id})`);
  setStatus("starting", "opening pane");
  const pane = taskPane(t);
  setStatus("starting", "starting agent");
  const name = `t-${t.id.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`.slice(0, 32);
  await startAgent(name, pane);
  const fresh = readJSON(paths.agents, {});
  fresh[url] = { task: pane };
  writeJSON(paths.agents, fresh);
  const text = fill(config().prompts[t.kind], { id: t.id, url: t.url || "", urlNote: t.url ? ` (${t.url})` : "" });
  herdr(["agent", "prompt", pane, text]);
  setStatus("done");
  herdr(["notification", "show", `${t.kind === "sentry" ? "Sentry" : "YouTrack"} task started`, "--body", `${t.id} in ${t.repoName}`, "--sound", "none"]);
  log(`task ${t.id} started in ${pane}`);
}

async function main() {
  if (task) return runTask(task);
  const cache = readJSON(paths.cache, { prs: [] });
  const pr = cache.prs.find((p) => p.url === url);
  if (!pr) throw new Error(`PR not in cache: ${url}`);
  const slot = kind === "deploy" ? "deploy" : "review";
  const agents = readJSON(paths.agents, {});
  const known = agents[url] && agents[url][slot];

  const live = liveAgent(known);
  if (live) {
    if (!["idle", "done"].includes(live.agent_status)) {
      throw new Error(`agent is ${live.agent_status}, press enter to go to it`);
    }
    herdr(["agent", "prompt", live.pane_id, prompts(pr)]);
    setStatus("done");
    return;
  }

  setStatus("starting", "opening pane");
  const pane = kind === "deploy" ? deployPane(pr) : reviewPane(pr);
  setStatus("starting", "starting agent");
  await startAgent(agentName(pr), pane);

  const fresh = readJSON(paths.agents, {});
  fresh[url] = { ...(fresh[url] || {}), [slot]: pane };
  writeJSON(paths.agents, fresh);

  herdr(["agent", "prompt", pane, prompts(pr)]);
  setStatus("done");
  log(`${kind} started for ${url} in ${pane}`);
}

main().catch((e) => {
  log(`${kind} ${url} failed:`, e.message);
  setStatus("error", e.message.split("\n")[0].slice(0, 200));
  try {
    herdr(["notification", "show", `${kind} failed`, "--body", e.message.slice(0, 200), "--sound", "none"]);
  } catch {}
  process.exit(1);
});
