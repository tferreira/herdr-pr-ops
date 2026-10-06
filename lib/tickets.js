"use strict";

// Turn whatever was pasted or clicked into a task source:
//   PROJ-123, https://x.youtrack.cloud/issue/PROJ-123/slug     -> youtrack
//   API-1A, https://org.sentry.io/issues/123456/               -> sentry
// YouTrack and Sentry short IDs share the PREFIX-SUFFIX shape. A prefix that
// is a known Sentry project (a repo name, or a sentryProjects key) means
// Sentry; otherwise digits-only means YouTrack.

const fs = require("node:fs");
const path = require("node:path");
const { config, expand } = require("./util");

function sentryProjects() {
  const cfg = config();
  const map = { ...(cfg.sentryProjects || {}) };
  for (const r of localRepos()) if (!(r.name.toLowerCase() in map)) map[r.name.toLowerCase()] = r.name;
  return map;
}

function parse(input, forceKind) {
  const s = (input || "").trim();
  if (!s) return null;
  const cfg = config();

  let m = s.match(/^https?:\/\/[^\s]*?\/issue\/([A-Za-z][A-Za-z0-9_]*-\d+)/);
  if (m) return youtrack(m[1].toUpperCase(), s.split(/\s/)[0]);

  m = s.match(/^https?:\/\/([^/\s]*sentry[^/\s]*)\/(?:organizations\/[^/]+\/)?issues\/(\d+)/);
  if (m) return { kind: "sentry", id: m[2], url: s.split(/\s/)[0], project: null };

  m = s.match(/^([A-Za-z][A-Za-z0-9_]*)-([A-Za-z0-9]+)$/);
  if (!m) return null;
  const prefix = m[1].toLowerCase();
  const id = `${m[1]}-${m[2]}`.toUpperCase();
  const projects = sentryProjects();
  let kind = forceKind;
  if (!kind) kind = prefix in projects || !/^\d+$/.test(m[2]) ? "sentry" : "youtrack";
  if (kind === "youtrack") return youtrack(id, null);
  const org = cfg.sentryOrg;
  return {
    kind: "sentry",
    id,
    url: org ? `https://${org}.sentry.io/issues/?query=${encodeURIComponent(id)}` : null,
    project: prefix,
  };

  function youtrack(id, url) {
    const base = cfg.youtrackUrl;
    return { kind: "youtrack", id, url: url || (base ? `${base.replace(/\/$/, "")}/issue/${id}` : null) };
  }
}

// Primary clones under repoRoots: a directory with a .git directory. Linked
// worktrees (api-proj123) have a .git file and are skipped.
function localRepos() {
  const out = [];
  const seen = new Set();
  const cfg = config();
  for (const [full, p] of Object.entries(cfg.repos || {})) {
    const dir = expand(p);
    out.push({ name: full.split("/")[1], path: dir });
    seen.add(dir);
  }
  for (const root of cfg.repoRoots) {
    let entries = [];
    try {
      entries = fs.readdirSync(expand(root), { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(expand(root), e.name);
      if (seen.has(dir)) continue;
      try {
        if (fs.statSync(path.join(dir, ".git")).isDirectory() && inOrgs(dir, cfg.orgs)) {
          out.push({ name: e.name, path: dir });
          seen.add(dir);
        }
      } catch {}
    }
  }
  return out;
}

// Is the clone's origin in one of `orgs`? Reads .git/config directly so the
// picker stays instant over dozens of repos.
function inOrgs(dir, orgs) {
  if (!orgs || !orgs.length) return true;
  let conf = "";
  try {
    conf = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
  } catch {
    return false;
  }
  const m = conf.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
  if (!m) return false;
  const owner = (m[1].match(/[:/]([^/:]+)\/[^/]+?(\.git)?$/) || [])[1];
  return !!owner && orgs.some((o) => o.toLowerCase() === owner.toLowerCase());
}

// The repo a Sentry project lives in, if known.
function repoForProject(project) {
  if (!project) return null;
  const name = sentryProjects()[project];
  if (!name) return null;
  const short = name.includes("/") ? name.split("/")[1] : name;
  return localRepos().find((r) => r.name === short) || null;
}

// Worktree folder suffix, matching the existing convention:
// PROJ-123 -> proj123, API-1A -> 1a, Sentry 123456 -> sentry123456.
function slug(t) {
  if (t.kind === "sentry") return /^\d+$/.test(t.id) ? `sentry${t.id}` : t.id.split("-").pop().toLowerCase();
  return t.id.replace("-", "").toLowerCase();
}

module.exports = { parse, localRepos, repoForProject, slug };
