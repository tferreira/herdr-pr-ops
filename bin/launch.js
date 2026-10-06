#!/usr/bin/env node
"use strict";

// launch.js <review|recheck|status|address|deploy> <pr-url> [<pr-url>...] [--pane <id>]
//   several urls: deploy only, one repo. --pane: an agent already on the PR
//   (picked by the dashboard), prompted instead of starting a new one when idle.
// launch.js task '{"kind":"jira","label":"Jira issue","id":"PROJ-123","url":null,"repoPath":"/.../api","repoName":"api"}'
//
// Starts (or reuses) a Claude pane for a PR. Reviews run in a Herdr worktree
// checked out at the PR head (branch pr-<N>); deploys run in a new tab of the
// repo's workspace. The dashboard runs this detached and follows progress
// through launches.json.

const { checkoutInfo } = require("../lib/gitinfo");
const { paths, readJSON, writeJSON, config, log, herdr, sh, localRepoPath, HOME, fill } = require("../lib/util");

const argv = process.argv.slice(2);
const paneFlag = argv.indexOf("--pane");
const reusePane = paneFlag >= 0 ? argv.splice(paneFlag, 2)[1] : null;
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
  for (const k of keys) {
    if (state === "done") delete all[k];
    else all[k] = { kind, state, msg, at: new Date().toISOString() };
  }
  writeJSON(paths.launches, all);
}

// {url} and {urls} both take every PR url (space separated) so a one-PR
// template like "/deploy {url}" also works for a multi-PR deploy.
function prompts(prs) {
  const urls = prs.map((p) => p.url).join(" ");
  const numbers = prs.map((p) => p.number).join(" ");
  return fill(config().prompts[kind], { url: urls, urls, repo: prs[0].repo, number: numbers, numbers });
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
let ghToken = null;
function fetchGh(repoPath, nameWithOwner, refspecs) {
  if (!ghToken) ghToken = sh("gh", ["auth", "token"]).trim();
  const base = "https://github.com:443/";
  const auth = Buffer.from(`x-access-token:${ghToken}`).toString("base64");
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${base}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}`,
  };
  try {
    sh("git", ["-C", repoPath, "fetch", "--quiet", `${base}${nameWithOwner}.git`, ...refspecs], { env });
  } catch (e) {
    throw new Error(`git fetch ${nameWithOwner}: ${e.message.split(": ").slice(-1)[0]}`);
  }
}

// My own PR: an existing checkout of its branch (moved to origin's head when
// clean), or a new worktree of it.
function addressPane(pr) {
  const repo = localRepoPath(pr.repo);
  const label = `${pr.repoName}#${pr.number}`;
  if (!repo) return rootPane(herdr(["workspace", "create", "--cwd", HOME, "--label", label, "--no-focus"]));
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
  return rootPane(herdr(["worktree", "create", "--cwd", repo, "--branch", branch, "--path", wtPath, "--label", label, "--no-focus"]));
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
  fetchGh(repo, pr.repo, [`+refs/pull/${pr.number}/head:${ref}`]);

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

function deployPane(prs) {
  const pr = prs[0];
  const repo = localRepoPath(pr.repo) || HOME;
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
  return rootPane(herdr(args));
}

async function runTask(t) {
  const agents = readJSON(paths.agents, {});
  const live = liveAgent(agents[url] && agents[url].task);
  if (live) throw new Error(`an agent already works on ${t.id} (${live.pane_id})`);
  setStatus("starting", "opening pane");
  const pane = taskPane(t);
  setStatus("starting", "starting agent");
  const name = `t-${branch.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`.slice(0, 32);
  await startAgent(name, pane);
  const fresh = readJSON(paths.agents, {});
  fresh[url] = { task: pane };
  writeJSON(paths.agents, fresh);
  const cfg = config();
  const custom = (cfg.trackers || []).find((x) => x.name === t.kind);
  const tpl = (custom && custom.prompt) || cfg.prompts[t.kind] || cfg.prompts.ticket;
  const text = fill(tpl, { id: t.id, label: t.label, url: t.url || "", urlNote: t.url ? ` (${t.url})` : "" });
  herdr(["agent", "prompt", pane, text]);
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
    herdr(["agent", "prompt", live.pane_id, prompts(prs)]);
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

  herdr(["agent", "prompt", pane, prompts(prs)]);
  setStatus("done");
  log(`${kind} started for ${keys.join(" ")} in ${pane}`);
}

main().catch((e) => {
  log(`${kind} ${keys.join(" ")} failed:`, e.message);
  setStatus("error", e.message.split("\n")[0].slice(0, 200));
  try {
    herdr(["notification", "show", `${kind} failed`, "--body", e.message.slice(0, 200), "--sound", "none"]);
  } catch {}
  process.exit(1);
});
