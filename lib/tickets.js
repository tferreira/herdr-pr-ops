"use strict";

// Turn whatever was pasted or clicked into a task: which tracker, which
// ticket, which URL. Built-in trackers:
//
//   github    https://github.com/o/r/issues/12, o/r#12
//   sentry    https://acme.sentry.io/issues/123/, API-1A (prefix = a repo or
//             a sentryProjects key)
//   linear    https://linear.app/acme/issue/ENG-12/...
//   jira      https://acme.atlassian.net/browse/PROJ-12 (any /browse/ URL)
//   youtrack  https://acme.youtrack.cloud/issue/PROJ-12/...
//
// A bare PROJ-12 goes to `defaultTracker`, or the first of jira, linear,
// youtrack whose base URL is configured; tab in the task box cycles through
// every tracker that accepts the input. `trackers` in config.json adds
// custom ones: { name, label, urlPattern, idPattern, link, prompt }.

const fs = require("node:fs");
const path = require("node:path");
const { config, expand } = require("./util");

const KEY_ID = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;
const firstWord = (s) => s.split(/\s/)[0];
const trim = (u) => (u || "").replace(/\/+$/, "");

function sentryProjects() {
  const cfg = config();
  const map = { ...(cfg.sentryProjects || {}) };
  for (const r of localRepos()) if (!(r.name.toLowerCase() in map)) map[r.name.toLowerCase()] = r.name;
  return map;
}

// Each tracker: fromUrl(s) -> id | null, fromId(s) -> id | null, link(id).
function builtins(cfg) {
  return [
    {
      name: "github",
      label: "GitHub issue",
      fromUrl: (s) => {
        const m = s.match(/^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/);
        return m && `${m[1]}#${m[2]}`;
      },
      fromId: (s) => (/^[\w.-]+\/[\w.-]+#\d+$/.test(s) ? s : null),
      link: (id) => {
        const [repo, n] = id.split("#");
        return `https://github.com/${repo}/issues/${n}`;
      },
    },
    {
      name: "sentry",
      label: "Sentry issue",
      fromUrl: (s) => {
        const m = s.match(/^https?:\/\/[^/\s]*sentry[^/\s]*\/(?:organizations\/[^/]+\/)?issues\/(\d+)/);
        return m && m[1];
      },
      // Short IDs (API-1A) look like ticket keys; only a known project prefix
      // or a non-numeric suffix makes them Sentry.
      fromId: (s, loose) => {
        const m = s.match(/^([A-Za-z][A-Za-z0-9_]*)-([A-Za-z0-9]+)$/);
        if (!m) return null;
        if (loose || m[1].toLowerCase() in sentryProjects() || !/^\d+$/.test(m[2])) return s.toUpperCase();
        return null;
      },
      link: (id) =>
        cfg.sentryOrg
          ? /^\d+$/.test(id)
            ? `https://${cfg.sentryOrg}.sentry.io/issues/${id}/`
            : `https://${cfg.sentryOrg}.sentry.io/issues/?query=${encodeURIComponent(id)}`
          : null,
      project: (id) => (/^\d+$/.test(id) ? null : id.split("-")[0].toLowerCase()),
    },
    {
      name: "linear",
      label: "Linear issue",
      fromUrl: (s) => {
        const m = s.match(/^https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9_]*-\d+)/);
        return m && m[1].toUpperCase();
      },
      fromId: (s) => (KEY_ID.test(s) ? s.toUpperCase() : null),
      link: (id) => (cfg.linearUrl ? `${trim(cfg.linearUrl)}/issue/${id}` : null),
      configured: !!cfg.linearUrl,
    },
    {
      name: "jira",
      label: "Jira issue",
      fromUrl: (s) => {
        const m = s.match(/^https?:\/\/[^/\s]+\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/);
        return m && m[1].toUpperCase();
      },
      fromId: (s) => (KEY_ID.test(s) ? s.toUpperCase() : null),
      link: (id) => (cfg.jiraUrl ? `${trim(cfg.jiraUrl)}/browse/${id}` : null),
      configured: !!cfg.jiraUrl,
    },
    {
      name: "youtrack",
      label: "YouTrack issue",
      fromUrl: (s) => {
        const m = s.match(/^https?:\/\/[^\s]*?\/issue\/([A-Za-z][A-Za-z0-9_]*-\d+)/);
        return m && m[1].toUpperCase();
      },
      fromId: (s) => (KEY_ID.test(s) ? s.toUpperCase() : null),
      link: (id) => (cfg.youtrackUrl ? `${trim(cfg.youtrackUrl)}/issue/${id}` : null),
      configured: !!cfg.youtrackUrl,
    },
  ];
}

// Custom trackers from config: regex strings and a {id} link template.
function custom(cfg) {
  return (cfg.trackers || []).map((t) => {
    const urlRe = t.urlPattern ? new RegExp(t.urlPattern, "i") : null;
    const idRe = t.idPattern ? new RegExp(t.idPattern, "i") : null;
    return {
      name: t.name,
      label: t.label || t.name,
      fromUrl: (s) => {
        const m = urlRe && s.match(urlRe);
        return m && (m[1] || m[0]);
      },
      fromId: (s) => (idRe && idRe.test(s) ? s : null),
      link: (id) => (t.link ? t.link.replace(/\{id\}/g, id) : null),
      configured: true,
    };
  });
}

function trackers() {
  const cfg = config();
  return [...custom(cfg), ...builtins(cfg)];
}

// Which tracker a bare ticket key belongs to when nothing else decides.
function defaultTracker() {
  const cfg = config();
  if (cfg.defaultTracker) return cfg.defaultTracker;
  const all = trackers();
  const set = all.find((t) => t.configured && ["jira", "linear", "youtrack"].includes(t.name));
  return set ? set.name : "jira";
}

function make(t, id, url) {
  return {
    kind: t.name,
    label: t.label,
    id,
    url: url || t.link(id),
    project: t.project ? t.project(id) : null,
  };
}

// Trackers that accept this input, best guess first.
function candidates(input) {
  const s = (input || "").trim();
  if (!s) return [];
  const all = trackers();
  const byUrl = all.map((t) => [t, t.fromUrl(firstWord(s))]).filter(([, id]) => id);
  if (byUrl.length) return byUrl.slice(0, 1).map(([t, id]) => make(t, id, firstWord(s)));
  const strict = all.map((t) => [t, t.fromId(s)]).filter(([, id]) => id);
  const def = defaultTracker();
  const customNames = new Set((config().trackers || []).map((t) => t.name));
  strict.sort(([a], [b]) => rank(a) - rank(b));
  function rank(t) {
    if (customNames.has(t.name)) return -1; // your own trackers first
    if (t.name === "sentry") return 0; // a known project prefix wins
    if (t.name === def) return 1;
    return 2;
  }
  const out = strict.map(([t, id]) => make(t, id));
  // Let tab reach Sentry for a key whose prefix is not a known project.
  if (!out.some((t) => t.kind === "sentry")) {
    const sentry = all.find((t) => t.name === "sentry");
    const id = sentry && sentry.fromId(s, true);
    if (id) out.push(make(sentry, id));
  }
  return out;
}

// The chosen reading of the input: `kind` picks a tracker (tab in the box).
function parse(input, kind) {
  const c = candidates(input);
  return (kind && c.find((t) => t.kind === kind)) || c[0] || null;
}

// Worktree folder suffix: PROJ-123 -> proj123, API-1A in repo api -> 1a,
// o/r#12 -> issue12, Sentry 123456 -> sentry123456.
function slug(t, repoName) {
  if (/#\d+$/.test(t.id)) return `issue${t.id.split("#").pop()}`;
  if (/^\d+$/.test(t.id)) return `${t.kind}${t.id}`;
  let id = t.id.toLowerCase();
  if (repoName && id.startsWith(`${repoName.toLowerCase()}-`)) id = id.slice(repoName.length + 1);
  return id.replace(/[^a-z0-9]/g, "");
}

// Branch for the task: the ticket key itself (PROJ-123), else kind-number.
function branchName(t) {
  if (/^[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9]+$/.test(t.id)) return t.id.toUpperCase();
  return `${t.kind === "github" ? "issue" : t.kind}-${t.id.split("#").pop()}`;
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


module.exports = { parse, candidates, localRepos, repoForProject, slug, branchName, trackers };
