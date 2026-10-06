#!/usr/bin/env node
"use strict";

// PR//OPS - the dashboard pane. Columns by state, swimlanes by repo.
// Reads the cache the daemon writes, polls Herdr for agent state, and hands
// launches to bin/launch.js so the UI never blocks.

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const U = require("../lib/util");
const { S, gradient, mix, width, fit, ESC } = require("../lib/term");

// ── palette ────────────────────────────────────────────────────────────────
const C = {
  bg: "#070b14",
  card: "#0c1322",
  sel: "#0f2036",
  line: "#18253d",
  grid: "#2b4066",
  dim: "#4b5e84",
  mute: "#7385ab",
  text: "#c6d3ef",
  white: "#eef4ff",
  cyan: "#00e5ff",
  magenta: "#ff2ed1",
  violet: "#8b5cff",
  green: "#2dffa0",
  amber: "#ffb020",
  red: "#ff3d6e",
  blue: "#4da3ff",
};
const LANE_COLORS = [C.cyan, C.magenta, C.violet, C.green, C.amber, C.blue, "#ff7ad9", "#2de2e6"];

const COLUMNS = {
  mine: [
    { title: "NEEDS YOU", color: C.red, glyph: "◢" },
    { title: "IN REVIEW", color: C.cyan, glyph: "◈" },
    { title: "READY TO SHIP", color: C.green, glyph: "◆" },
  ],
  review: [
    { title: "NEW", color: C.magenta, glyph: "✦" },
    { title: "RE-CHECK", color: C.amber, glyph: "↻" },
    { title: "WAITING ON AUTHOR", color: C.blue, glyph: "◌" },
  ],
};
const TABS = [
  { id: "mine", title: "MINE" },
  { id: "review", title: "TO REVIEW" },
];

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
// Mouse reporting: button events, SGR encoding.
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";
const SWEEP = "◜◝◞◟";
let LANE_W = 16; // sized to the longest repo name each frame
let CARD_H = 3; // 4 when columns are narrow and titles wrap to two lines

// ── state ──────────────────────────────────────────────────────────────────
// --demo: fake board, nothing is fetched, launched or saved.
const DEMO = process.argv.includes("--demo");
const demo = DEMO ? require("../lib/demo") : null;
let data = DEMO ? demo.data() : U.readJSON(U.paths.cache, null) || { prs: [] };
const ui = Object.assign(
  { tab: "review", sel: {}, snoozed: {}, showSnoozed: false },
  DEMO ? {} : U.readJSON(U.paths.ui, {}),
);
let cacheMtime = 0;
let agents = new Map(); // pane_id -> agent
let agentMap = U.readJSON(U.paths.agents, {});
let launches = U.readJSON(U.paths.launches, {});
let filter = "";
let filterMode = false;
let help = false;
let toast = null; // { text, color, until }
let scroll = 0;
let lastLines = [];
// Where things were drawn last frame, for mouse clicks (1-based rows/cols).
let hit = { tabs: [], cards: [] };
// --snapshot <cols>x<rows> [mine|review]: print one settled frame and exit.
const SNAP = process.argv.includes("--snapshot") ? process.argv.slice(process.argv.indexOf("--snapshot") + 1) : null;
const boot = SNAP ? Date.now() - 5000 : Date.now();
let tick = 0;
const { Header } = require("../lib/header");
const header = new Header(boot, C.bg);

const saveUi = () => {
  if (DEMO) return;
  try {
    U.writeJSON(U.paths.ui, ui);
  } catch {}
};
const T = require("../lib/tickets");
// New-task modal: { step: 0 ticket | 1 repo, input, kind, repoFilter, repoIdx }
let task = null;

const say = (text, color = C.cyan, ms = 3200) => (toast = { text, color, until: Date.now() + ms });

// ── data ───────────────────────────────────────────────────────────────────
function visiblePrs(tab) {
  const q = filter.toLowerCase();
  return data.prs.filter((p) => {
    if (p.tab !== tab) return false;
    const snooze = ui.snoozed[p.url];
    if (snooze && snooze === p.updatedAt && !ui.showSnoozed) return false;
    if (q && !`${p.repoName} ${p.number} ${p.title} ${p.author}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function laneColor(repo) {
  let h = 0;
  for (const ch of repo) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LANE_COLORS[h % LANE_COLORS.length];
}

// lanes: [{ repo, color, cols: [[pr], [pr], [pr]] }], busiest repo first.
function buildLanes(tab) {
  const byRepo = new Map();
  for (const p of visiblePrs(tab)) {
    if (!byRepo.has(p.repoName)) byRepo.set(p.repoName, [[], [], []]);
    byRepo.get(p.repoName)[p.col].push(p);
  }
  const lanes = [...byRepo.entries()].map(([repo, cols]) => {
    for (const c of cols) c.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    return { repo, color: laneColor(repo), cols };
  });
  const count = (l) => l.cols.reduce((n, c) => n + c.length, 0);
  lanes.sort((a, b) => count(b) - count(a) || a.repo.localeCompare(b.repo));
  return lanes;
}

// Flattened column: [{ pr, lane, idx }] top to bottom.
function column(lanes, c) {
  const out = [];
  lanes.forEach((l, li) => l.cols[c].forEach((pr, idx) => out.push({ pr, lane: li, idx })));
  return out;
}

function selected(lanes) {
  const s = ui.sel[ui.tab];
  if (s) {
    for (let c = 0; c < 3; c++) {
      const hit = column(lanes, c).find((e) => e.pr.url === s.url);
      if (hit) return { ...hit, col: c };
    }
  }
  // Selection vanished: stay in the same column if possible.
  const order = s ? [s.col, 0, 1, 2] : [0, 1, 2];
  for (const c of order) {
    const col = column(lanes, c);
    if (col.length) {
      const e = col[Math.min(s && s.col === c ? s.pos || 0 : 0, col.length - 1)];
      ui.sel[ui.tab] = { url: e.pr.url, col: c, pos: 0 };
      return { ...e, col: c };
    }
  }
  return null;
}

function select(entry, c, lanes) {
  const pos = column(lanes, c).findIndex((e) => e.pr.url === entry.pr.url);
  ui.sel[ui.tab] = { url: entry.pr.url, col: c, pos };
}

function move(dx, dy) {
  const lanes = buildLanes(ui.tab);
  const cur = selected(lanes);
  if (!cur) return;
  if (dy) {
    const col = column(lanes, cur.col);
    const i = col.findIndex((e) => e.pr.url === cur.pr.url);
    const next = col[Math.max(0, Math.min(col.length - 1, i + dy))];
    select(next, cur.col, lanes);
    return;
  }
  for (let c = cur.col + dx; c >= 0 && c < 3; c += dx) {
    const col = column(lanes, c);
    if (!col.length) continue;
    // Same lane, same row if possible; otherwise the nearest lane.
    const same = col.filter((e) => e.lane === cur.lane);
    let target;
    if (same.length) target = same[Math.min(cur.idx, same.length - 1)];
    else {
      target = col.reduce((best, e) => {
        const d = Math.abs(e.lane - cur.lane);
        const bd = Math.abs(best.lane - cur.lane);
        return d < bd || (d === bd && e.lane > cur.lane && best.lane > cur.lane && e.idx < best.idx) ? e : best;
      });
      // Coming from above, land on the lane's first card; from below, its last.
      const laneCards = col.filter((e) => e.lane === target.lane);
      target = target.lane > cur.lane ? laneCards[0] : laneCards[laneCards.length - 1];
    }
    select(target, c, lanes);
    return;
  }
}

// ── agents & launches ──────────────────────────────────────────────────────
const { linkAgents } = require("../lib/agentlink");
let links = new Map(); // pr url -> [agent]

function pollAgents() {
  if (DEMO) {
    agents = demo.agents();
    agentMap = demo.agentMap();
    links = linkAgents(agents, data.prs, agentMap);
    return;
  }
  agentMap = U.readJSON(U.paths.agents, {});
  execFile(process.env.HERDR_BIN_PATH || "herdr", ["agent", "list"], { encoding: "utf8", timeout: 5000 }, (err, out) => {
    if (err) return;
    try {
      const list = JSON.parse(out).result.agents || [];
      agents = new Map(list.map((a) => [a.pane_id, a]));
      links = linkAgents(agents, data.prs, agentMap);
    } catch {}
  });
}

const URGENCY = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };

// Live agents on a PR, most urgent first. See lib/agentlink.js for how an
// agent is matched to a PR.
function agentsFor(pr) {
  return (links.get(pr.url) || []).slice().sort((a, b) => (URGENCY[a.agent_status] ?? 9) - (URGENCY[b.agent_status] ?? 9));
}

function agentFor(pr) {
  return agentsFor(pr)[0] || null;
}

// Card border badge, herdr-radar style: logo, lifecycle mark, label.
const { agentMark, glyphs } = require("../lib/marks");
function agentBadge(pr, bg) {
  const list = agentsFor(pr);
  if (!list.length) return "";
  const m = agentMark(list[0], tick, C);
  const loud = list[0].agent_status === "blocked";
  const more = list.length > 1 ? S(` ×${list.length}`, { fg: C.mute, bg }) : "";
  return (
    S(m.logo, { fg: m.logoColor, bg, bold: true }) +
    S(" ", { bg }) +
    S(m.mark, { fg: m.markColor, bg, bold: true }) +
    S(` ${m.label}`, { fg: loud ? C.red : m.label === "working" ? m.markColor : C.mute, bg, bold: loud }) +
    more
  );
}

function pollFiles() {
  if (DEMO) return;
  try {
    const m = fs.statSync(U.paths.cache).mtimeMs;
    if (m !== cacheMtime) {
      cacheMtime = m;
      data = U.readJSON(U.paths.cache, data) || data;
      if (!data.prs) data.prs = [];
      pruneMarks();
    }
  } catch {}
  launches = U.readJSON(U.paths.launches, {});
}

// full: refetch every PR (the R key); otherwise only what changed.
function refresh(full = false) {
  if (DEMO) return say("DEMO MODE · NOTHING IS FETCHED", C.violet);
  U.ensureDaemon();
  const pid = U.daemonPid();
  if (pid) {
    try {
      process.kill(pid, full ? "SIGUSR2" : "SIGUSR1");
    } catch {}
  }
  data.refreshing = true;
  if (full) say("◎ FULL SCAN", C.cyan, 1500);
}

// One agent for `prs` (several only for deploy, all from one repo).
function launch(kind, prs, reusePane) {
  if (!Array.isArray(prs)) prs = [prs];
  const names = prs.map((p) => `${p.repoName}#${p.number}`).join(" ");
  if (DEMO) return say(`DEMO MODE · WOULD ${kind.toUpperCase()} ${names}`, C.violet);
  const all = U.readJSON(U.paths.launches, {});
  for (const p of prs) all[p.url] = { kind, state: "starting", msg: "queued", at: new Date().toISOString() };
  U.writeJSON(U.paths.launches, all);
  launches = all;
  const args = [path.join(__dirname, "launch.js"), kind, ...prs.map((p) => p.url)];
  if (reusePane) args.push("--pane", reusePane);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  const verb = { review: "REVIEW", recheck: "RE-CHECK", status: "STATUS CHECK", address: "ADDRESS COMMENTS", deploy: "DEPLOY" }[kind];
  say(`▲ ${verb} LAUNCHING · ${names}`, C.magenta);
}

// Marked PRs for a multi-deploy, in the order they were marked.
let marked = [];

function toggleMark(pr) {
  if (pr.tab !== "mine") return say("MARKING IS FOR DEPLOYS · MINE TAB", C.amber);
  const i = marked.indexOf(pr.url);
  if (i >= 0) {
    marked.splice(i, 1);
    return say(`☐ UNMARKED · ${marked.length} MARKED`, C.violet, 1500);
  }
  const ok = canDeploy(pr);
  if (ok !== true) return say(`CAN'T MARK · ${ok.toUpperCase()}`, C.red);
  marked.push(pr.url);
  say(`☑ MARKED ${marked.length} · d DEPLOYS ALL`, C.magenta, 1500);
}

// Drop marks whose PR left the board or stopped being shippable.
function pruneMarks() {
  marked = marked.filter((u) => {
    const pr = data.prs.find((p) => p.url === u);
    return pr && canDeploy(pr) === true;
  });
}

// One launch per repo, PRs in marking order.
function deployMarked() {
  const groups = new Map();
  for (const u of marked) {
    const pr = data.prs.find((p) => p.url === u);
    if (!groups.has(pr.repo)) groups.set(pr.repo, []);
    groups.get(pr.repo).push(pr);
  }
  for (const prs of groups.values()) launch("deploy", prs);
  const names = marked.map((u) => {
    const p = data.prs.find((x) => x.url === u);
    return `${p.repoName}#${p.number}`;
  });
  say(`${DEMO ? "DEMO MODE · WOULD DEPLOY" : "▲ DEPLOY LAUNCHING ·"} ${names.join(" ")}${groups.size > 1 ? ` · ${groups.size} AGENTS` : ""}`, DEMO ? C.violet : C.magenta, 4000);
  marked = [];
}

// Header line: what the agents on board PRs are doing.
function agentSummary() {
  const seen = new Map();
  for (const pr of data.prs) for (const a of agentsFor(pr)) seen.set(a.pane_id, a);
  if (!seen.size) return [];
  const list = [...seen.values()];
  const runs = [];
  for (const st of ["blocked", "working", "done", "idle"]) {
    const of = list.filter((a) => (st === "idle" ? !["blocked", "working", "done"].includes(a.agent_status) : a.agent_status === st));
    if (!of.length) continue;
    const m = agentMark(of[0], tick, C);
    runs.push([m.mark, { fg: m.markColor, bold: true }], [` ${of.length} ${m.label === "?" ? "idle" : m.label}   `, { fg: st === "blocked" ? C.red : C.mute, bold: st === "blocked" }]);
  }
  return runs;
}

// ── helpers ────────────────────────────────────────────────────────────────
function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const pulse = (a, b, period = 1200) => mix(a, b, (Math.sin((Date.now() / period) * Math.PI * 2) + 1) / 2);


// ── chips ──────────────────────────────────────────────────────────────────
function chips(pr, bg) {
  const out = [];
  const L = launches[pr.url];
  if (L && L.state === "starting") out.push(S(`${SWEEP[tick % 4]} ${L.msg || "launching"}`.toUpperCase(), { fg: pulse(C.cyan, C.violet, 800), bg, bold: true }));
  else if (L && L.state === "error") out.push(S("✕ LAUNCH FAILED", { fg: C.red, bg, bold: true }));
  if (pr.ci === "pass") out.push(S("✓ CI", { fg: C.green, bg }));
  else if (pr.ci === "fail") out.push(S("✕ CI", { fg: C.red, bg, bold: true }));
  else if (pr.ci === "pending") out.push(S(`${SWEEP[(tick >> 1) % 4]} CI`, { fg: C.amber, bg }));
  if (pr.conflict) out.push(S("▲ CONFLICT", { fg: C.red, bg, bold: true }));
  if (pr.isDraft) out.push(S("DRAFT", { fg: C.dim, bg }));
  if (pr.tab === "mine" && pr.toAnswer) out.push(S(`⁇ ${pr.toAnswer} TO ANSWER`, { fg: C.amber, bg, bold: true }));
  else if (pr.unresolved) out.push(S(`◇${pr.unresolved}`, { fg: C.text, bg }));
  if (pr.tab === "review" && pr.reason) out.push(S(pr.reason.toUpperCase(), { fg: pr.col === 1 ? C.amber : C.violet, bg }));
  if (ui.snoozed[pr.url] === pr.updatedAt) out.push(S("ZZZ", { fg: C.dim, bg }));
  return out;
}

// ── card ───────────────────────────────────────────────────────────────────
function card(pr, w, isSel, laneCol) {
  const draft = pr.isDraft;
  const bg = isSel ? C.sel : draft ? C.bg : C.card;
  const mark = marked.indexOf(pr.url);
  const border = isSel ? pulse(C.cyan, "#7af3ff", 1600) : mark >= 0 ? C.magenta : draft ? C.dim : C.grid;
  // Drafts get a dashed frame, a dim title and GitHub's grey draft icon.
  const [tl, tr, bl, br, h, v] = isSel
    ? draft
      ? ["┏", "┓", "┗", "┛", "╍", "╏"]
      : ["┏", "┓", "┗", "┛", "━", "┃"]
    : draft
      ? ["╭", "╮", "╰", "╯", "╌", "╎"]
      : ["╭", "╮", "╰", "╯", "─", "│"];
  const B = (s) => S(s, { fg: border, bg });
  const inner = w - 2;

  // top: ╭─  #1872 ───────── octocat · 21m ─╮
  const font = glyphs().done !== "✓";
  const prIcon = draft ? (font ? "\uf4dd" : "◌") : font ? "\uf407" : "●";
  const num =
    S(isSel ? "▶ " : "", { fg: C.white, bg, bold: true }) +
    (mark >= 0 ? S(`☑${mark + 1} `, { fg: C.magenta, bg, bold: true }) : "") +
    S(prIcon + " ", { fg: draft ? C.mute : C.green, bg, bold: true }) +
    S(`#${pr.number}`, { fg: isSel ? C.white : draft ? C.mute : laneCol, bg, bold: true });
  const badge = agentBadge(pr, bg);
  const meta =
    (badge ? badge + S(" · ", { fg: C.mute, bg }) : "") +
    S(`${pr.tab === "review" && !badge ? pr.author + " · " : ""}${ago(pr.updatedAt)}`, { fg: C.mute, bg });
  const fill = Math.max(1, w - 8 - width(num) - width(meta));
  const top = B(tl + h + " ") + num + B(" " + h.repeat(fill) + " ") + meta + B(" " + h + tr);

  // mid: │ title │ (one or two lines)
  const tStyle = { fg: isSel ? (draft ? C.text : C.white) : draft ? C.dim : C.text, bg, bold: isSel, italic: draft };
  const mids = wrap(pr.title, inner - 2, CARD_H - 2).map(
    (t) => B(v) + S(" ", { bg }) + fit(S(t, tStyle), inner - 2, S("", { bg }), true) + S(" ", { bg }) + B(v),
  );

  // bottom: ╰─ ✓ CI  ◇3 ──────╯
  let row = "";
  for (const c of chips(pr, bg)) {
    const next = row ? row + S("  ", { bg }) + c : c;
    if (width(next) > inner - 4) break;
    row = next;
  }
  const rest = Math.max(0, inner - 2 - width(row) - (row ? 2 : 0));
  const bot = B(bl + h) + (row ? S(" ", { bg }) + row + S(" ", { bg }) : "") + B(h.repeat(rest) + h + br);
  return [top, ...mids, bot].map((l) => fit(l, w));
}

// Greedy word wrap into at most `n` lines; the last line keeps the rest so
// fit() can cut it with an ellipsis.
function wrap(text, w, n) {
  if (n <= 1) return [text];
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  while (words.length && lines.length < n - 1) {
    const next = cur ? `${cur} ${words[0]}` : words[0];
    if (width(next) <= w || !cur) {
      cur = next;
      words.shift();
    } else {
      lines.push(cur);
      cur = "";
    }
  }
  if (cur) lines.push(cur);
  if (words.length) {
    if (lines.length < n) lines.push(words.join(" "));
    else lines[lines.length - 1] += " " + words.join(" ");
  }
  while (lines.length < n) lines.push("");
  return lines;
}

// ── frame ──────────────────────────────────────────────────────────────────
function render() {
  tick++;
  const [W, H] = SNAP ? SNAP[0].split("x").map(Number) : [process.stdout.columns || 120, process.stdout.rows || 40];
  const base = S("", { bg: C.bg });
  const line = (s) => fit(s, W, base);
  const out = [];

  const lanes = buildLanes(ui.tab);
  const sel = selected(lanes);
  const counts = Object.fromEntries(TABS.map((t) => [t.id, visiblePrs(t.id).length]));

  // header: animated logo band ──
  const clock = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const syncing = data.refreshing;
  const sync = syncing
    ? [[`${SWEEP[tick % 4]} SCANNING`, { fg: C.cyan, bold: true }]]
    : data.error
      ? [[`✕ SYNC ERROR ${ago(data.errorAt)}`, { fg: C.red, bold: true }]]
      : [["◉", { fg: pulse(C.green, C.bg, 2400) }], [` SYNC ${ago(data.fetchedAt) || "—"}`, { fg: C.mute }]];
  const text = [
    { row: 1, x: Header.LOGO_END + 3, runs: [["pull request mission control", { fg: C.dim, italic: true }]] },
    { row: 1, x: -2, runs: [[`@${data.me || "?"}   `, { fg: C.violet }], ...sync] },
    { row: 2, x: -2, runs: [...agentSummary(), [clock, { fg: C.mute }]] },
  ];
  for (const l of header.render(W, Date.now(), text)) out.push(line(l));

  // tabs ──
  let tabs = S(" ", { bg: C.bg });
  const tabHits = [];
  for (const t of TABS) {
    const active = ui.tab === t.id;
    const n = String(counts[t.id]).padStart(2, "0");
    const x0 = width(tabs) + 1;
    tabs += active
      ? S("◢", { fg: C.cyan, bg: C.bg }) + S(` ${t.title} ${n} `, { fg: C.bg, bg: C.cyan, bold: true }) + S("◣", { fg: C.cyan, bg: C.bg })
      : S(` ${t.title} `, { fg: C.dim, bg: C.bg }) + S(n, { fg: C.mute, bg: C.bg }) + S(" ", { bg: C.bg });
    tabHits.push({ id: t.id, x0, x1: width(tabs), y: out.length + 1 });
    tabs += S("  ", { bg: C.bg });
  }
  if (filterMode || filter) {
    tabs += S(" ⌕ ", { fg: C.amber, bg: C.bg }) + S(filter + (filterMode && tick % 8 < 4 ? "▏" : " "), { fg: C.white, bg: C.bg, bold: true });
  }
  out.push(line(tabs));

  // scanner rule: a bright head sweeps along it while refreshing ──
  let rule = "";
  const head = syncing ? Math.floor((tick * 2.2) % (W + 20)) - 10 : -100;
  for (let x = 0; x < W; x++) {
    const d = Math.abs(x - head);
    const baseCol = mix(C.cyan, C.magenta, x / W);
    const col = d < 10 ? mix(C.white, mix(baseCol, C.bg, 0.55), d / 10) : mix(baseCol, C.bg, 0.55);
    rule += S(d < 3 ? "━" : "─", { fg: col, bg: C.bg });
  }
  out.push(rule);

  // column headers ──
  LANE_W = Math.min(24, Math.max(12, ...lanes.map((l) => l.repo.length + 3)));
  const colW = Math.floor((W - LANE_W - 1) / 3);
  CARD_H = colW < 60 ? 4 : 3;
  let hdr = S(" ".repeat(LANE_W), { bg: C.bg });
  COLUMNS[ui.tab].forEach((c, i) => {
    const n = column(lanes, i).length;
    const active = sel && sel.col === i;
    const label = S(` ${c.glyph} `, { fg: c.color, bg: C.bg, bold: true }) + S(c.title, { fg: active ? C.white : c.color, bg: C.bg, bold: true }) + S(` ·${String(n).padStart(2, "0")}`, { fg: C.dim, bg: C.bg });
    hdr += fit(label, colW, base);
  });
  out.push(line(hdr));
  let under = S(" ".repeat(LANE_W), { bg: C.bg });
  COLUMNS[ui.tab].forEach((c, i) => {
    const active = sel && sel.col === i;
    under += S(" " + (active ? "▀" : "▔").repeat(colW - 2) + " ", { fg: active ? c.color : mix(c.color, C.bg, 0.6), bg: C.bg });
  });
  out.push(line(under));

  // body ──
  const body = [];
  const cardHits = [];
  let selRange = [0, 0];
  lanes.forEach((lane, li) => {
    const rows = Math.max(1, ...lane.cols.map((c) => c.length));
    const total = lane.cols.reduce((n, c) => n + c.length, 0);
    for (let r = 0; r < rows * CARD_H; r++) {
      const ci = Math.floor(r / CARD_H);
      const sub = r % CARD_H;
      let label;
      const bar = S("▍", { fg: lane.color, bg: C.bg });
      if (r === 0) label = bar + S(lane.repo.toUpperCase(), { fg: lane.color, bg: C.bg, bold: true });
      else if (r === 1) label = bar + S(`${total} PR${total > 1 ? "S" : ""}`, { fg: C.dim, bg: C.bg });
      else label = bar;
      let s = fit(label, LANE_W - 1, base, true) + S(" ", { bg: C.bg });
      for (let c = 0; c < 3; c++) {
        const pr = lane.cols[c][ci];
        if (!pr) {
          s += S(" ".repeat(colW), { bg: C.bg });
          continue;
        }
        const isSel = sel && sel.pr.url === pr.url;
        if (isSel && sub === 0) selRange = [body.length, body.length + CARD_H];
        if (sub === 0) cardHits.push({ url: pr.url, col: c, row: body.length, x0: LANE_W + c * colW + 1, x1: LANE_W + (c + 1) * colW - 1 });
        // Cards build in left to right on open.
        const appear = Date.now() - boot > 120 + c * 90 + li * 40;
        s += appear ? card(pr, colW - 1, isSel, lane.color)[sub] + S(" ", { bg: C.bg }) : S(" ".repeat(colW), { bg: C.bg });
      }
      body.push(line(s));
    }
    if (li < lanes.length - 1) {
      body.push(line(S(" " + "┈".repeat(W - 2), { fg: C.line, bg: C.bg })));
    }
  });

  if (!lanes.length) {
    const msg = data.fetchedAt
      ? filter
        ? "NO MATCH FOR FILTER"
        : ui.tab === "review"
          ? "✦ ALL CLEAR · NOBODY IS WAITING ON YOU ✦"
          : "✦ NO OPEN PULL REQUESTS ✦"
      : `${SWEEP[tick % 4]} FIRST SCAN IN PROGRESS`;
    body.push(line(""), line(""));
    const pad = Math.max(0, Math.floor((W - width(msg)) / 2));
    body.push(line(S(" ".repeat(pad), { bg: C.bg }) + gradient(msg, C.cyan, C.magenta, { bg: C.bg, bold: true })));
  }

  // footer ──
  const footer = footerLines(sel, W, base);
  const bodyH = Math.max(3, H - out.length - footer.length);
  if (selRange[1] - scroll > bodyH) scroll = selRange[1] - bodyH;
  if (selRange[0] < scroll) scroll = selRange[0];
  scroll = Math.max(0, Math.min(scroll, Math.max(0, body.length - bodyH)));
  const view = body.slice(scroll, scroll + bodyH);
  const top = out.length + 1;
  hit = {
    tabs: tabHits,
    cards: cardHits
      .map((h) => ({ ...h, y0: top + h.row - scroll, y1: top + h.row - scroll + CARD_H - 1 }))
      .filter((h) => h.y1 >= top && h.y0 < top + bodyH),
  };
  while (view.length < bodyH) view.push(line(""));
  // Scroll hints sit in the right margin, over the line's last cells.
  const hint = (l, ch) => fit(l, W - 2, base) + S(ch, { fg: C.cyan, bg: C.bg, bold: true }) + S(" ", { bg: C.bg });
  if (scroll > 0) view[0] = hint(view[0], "▲");
  if (scroll + bodyH < body.length) view[view.length - 1] = hint(view[view.length - 1], "▼");
  out.push(...view, ...footer);

  if (help) overlayHelp(out, W, H);
  if (task) overlayTask(out, W, H);

  // Rewrite only the lines that changed: the header animates constantly.
  const lines = out.map((l) => l + `${ESC}0m`);
  if (SNAP) return process.stdout.write(lines.join("\n"));
  let buf = "";
  lines.forEach((l, i) => {
    if (l !== lastLines[i]) buf += `${ESC}${i + 1};1H${l}`;
  });
  lastLines = lines;
  if (buf) process.stdout.write(`${ESC}?2026h${buf}${ESC}?2026l`);
}

// Action chips. When enter does the same as r or c, they share one chip
// ("↵ r REVIEW") so the bar keeps a fixed layout and shows what enter does.
function actionKeys(sel, key) {
  const pr = sel && sel.pr;
  const ag = pr && agentFor(pr);
  const act = pr && !ag ? enterAction(pr) : null;
  const enterIs = (kind) => act && act.kind === kind;
  let out = "";
  if (ag) out += key(" ↵ ", "JUMP");
  if (ui.tab === "review") {
    out += key(enterIs("review") ? " ↵ r " : " r ", "REVIEW");
    out += key(enterIs("recheck") ? " ↵ c " : " c ", "RE-CHECK");
    if (act && !act.kind) out += key(" ↵ ", act.label, false);
    return out;
  }
  if (act) out += key(" ↵ ", act.label);
  out += key(" c ", "FIX");
  out += key(" d ", marked.length ? `DEPLOY ${marked.length}` : "DEPLOY", marked.length > 0 || (pr && canDeploy(pr) === true));
  out += key(" ␣ ", "MARK", !!(pr && canDeploy(pr) === true));
  return out;
}

function footerLines(sel, W, base) {
  const line = (s) => fit(s, W, base);
  const rule = S("─".repeat(W), { fg: C.line, bg: C.bg });
  const lines = [rule];
  if (sel) {
    const pr = sel.pr;
    const ag = agentFor(pr);
    const L = launches[pr.url];
    lines.push(
      line(
        S(" ▶ ", { fg: C.cyan, bg: C.bg, bold: true }) +
          S(`${pr.repo}#${pr.number}`, { fg: C.white, bg: C.bg, bold: true }) +
          S(`  ${pr.author}  ⎇ ${pr.headRef}`, { fg: C.mute, bg: C.bg }) +
          (ag ? S(`  ⌁ agent ${ag.agent_status} in ${ag.pane_id}`, { fg: C.magenta, bg: C.bg }) : ""),
      ),
    );
    lines.push(line(S("   " + pr.title, { fg: C.text, bg: C.bg })));
    let status;
    if (L && L.state === "error") status = S(`   ✕ ${L.msg}`, { fg: C.red, bg: C.bg });
    else if (pr.tab === "review") {
      const my = pr.myLast ? `your last review: ${pr.myLast.state.toLowerCase().replace("_", " ")} ${ago(pr.myLast.at)} ago` : "not reviewed by you yet";
      status = S(`   ${my}${pr.reason ? " · " + pr.reason : ""}`, { fg: C.mute, bg: C.bg });
    } else {
      const decision = (pr.reviewDecision || "no reviews").toLowerCase().replace("_", " ");
      const text = pr.col === 0 ? pr.reason : `${decision} · CI ${pr.ci}${pr.reason ? " · " + pr.reason : ""}`;
      status = S(`   ${text}`, { fg: pr.col === 0 ? C.amber : C.mute, bg: C.bg });
    }
    lines.push(line(status));
  } else {
    lines.push(line(""), line(""), line(""));
  }

  // key bar + toast ──
  const key = (k, label, on = true) =>
    S(`${k}`, { fg: on ? C.bg : C.dim, bg: on ? C.cyan : C.line, bold: true }) + S(` ${label}  `, { fg: on ? C.text : C.dim, bg: C.bg });
  const keys =
    S(" ", { bg: C.bg }) +
    actionKeys(sel, key) +
    key(" o ", "OPEN") +
    key(" f ", "FILES") +
    key(" z ", "SNOOZE") +
    key(" / ", "FILTER") +
    key(" R ", "SCAN") +
    key(" n ", "TASK") +
    key(" ? ", "HELP");
  let t = "";
  if (toast && Date.now() < toast.until) t = S(` ${toast.text} `, { fg: C.bg, bg: toast.color, bold: true }) + S(" ", { bg: C.bg });
  const gap = W - width(keys) - width(t);
  lines.push(line(gap > 0 ? keys + S(" ".repeat(gap), { bg: C.bg }) + t : t ? t : keys));
  return lines;
}

function overlayHelp(out, W, H) {
  const rows = [
    ["←→ ↑↓", "move between columns / PRs (hjkl too)"],
    ["tab  1 2", "switch MINE / TO REVIEW"],
    ["r", "review: new agent pane in a PR worktree (prompts.review)"],
    ["c", "comments: re-check others' PRs / get mine ready (fix, draft replies)"],
    ["d", "deploy: prompts.deploy (approved, CI green, no conflict)"],
    ["space", "mark for a multi-deploy (alt+click too); d ships all"],
    ["enter", "jump to the PR's agent; none yet: review / re-check / status report"],
    ["o / f", "open PR / files changed in the browser"],
    ["y", "copy PR url"],
    ["z / s", "snooze until the PR changes / show snoozed"],
    ["n", "new task from a YouTrack ticket or Sentry issue"],
    [",", "settings: edit config.json in $EDITOR"],
    ["/", "filter by repo, title, author"],
    ["R  F5", "scan GitHub now"],
    ["q  esc", "close"],
  ];
  const w = Math.min(W - 4, 76);
  const h = rows.length + 4;
  const x = Math.floor((W - w) / 2);
  const y = Math.max(1, Math.floor((H - h) / 2));
  const bg = "#0a1426";
  const B = (s) => S(s, { fg: C.magenta, bg });
  const box = [B("╔" + "═".repeat(w - 2) + "╗"), B("║") + fit(gradient("  ◢◤ CONTROLS", C.cyan, C.magenta, { bg, bold: true }), w - 2, S("", { bg })) + B("║")];
  for (const [k, d] of rows) {
    box.push(B("║") + fit(S(`  ${k.padEnd(10)}`, { fg: C.cyan, bg, bold: true }) + S(d, { fg: C.text, bg }), w - 2, S("", { bg }), true) + B("║"));
  }
  box.push(B("║") + S(" ".repeat(w - 2), { bg }) + B("║"), B("╚" + "═".repeat(w - 2) + "╝"));
  box.forEach((b, i) => {
    if (y + i >= out.length) return;
    const bgS = S("", { bg: C.bg });
    out[y + i] = fit(S(" ".repeat(x), { bg: C.bg }) + b, W, bgS);
  });
}

// ── new task ───────────────────────────────────────────────────────────────
function repoChoices() {
  // Repos with open PRs first (busiest first), then every other clone.
  const counts = new Map();
  for (const p of data.prs) counts.set(p.repoName, (counts.get(p.repoName) || 0) + 1);
  const repos = (DEMO ? demo.repos() : T.localRepos()).sort((a, b) => (counts.get(b.name) || 0) - (counts.get(a.name) || 0) || a.name.localeCompare(b.name));
  const q = task.repoFilter.toLowerCase();
  return repos.filter((r) => r.name.toLowerCase().includes(q)).map((r) => ({ ...r, prs: counts.get(r.name) || 0 }));
}

function parsedTask() {
  return task && T.parse(task.input, task.kind);
}

function openTask(input) {
  task = { step: 0, input, kind: null, repoFilter: "", repoIdx: 0 };
  if (parsedTask()) toRepoStep();
}

function toRepoStep() {
  const t = parsedTask();
  if (!t) return say("PASTE A YOUTRACK ID/URL OR A SENTRY ISSUE", C.amber);
  task.step = 1;
  task.repoFilter = "";
  const known = DEMO ? null : T.repoForProject(t.project);
  const list = repoChoices();
  task.repoIdx = Math.max(0, known ? list.findIndex((r) => r.path === known.path) : 0);
}

function taskKey(k) {
  if (task.step === 0) {
    if (k === "\x1b") task = null;
    else if (k === "\r") toRepoStep();
    else if (k === "\t") {
      const t = T.parse(task.input);
      if (t && /^[A-Za-z]/.test(t.id)) task.kind = (task.kind || t.kind) === "sentry" ? "youtrack" : "sentry";
    } else if (k === "\x7f") task.input = task.input.slice(0, -1);
    else if (k.length === 1 && k >= " ") task.input += k;
    return;
  }
  const list = repoChoices();
  if (k === "\x1b" || k === "\x1b[Z") task.step = 0;
  else if (k === "\x1b[A") task.repoIdx = Math.max(0, task.repoIdx - 1);
  else if (k === "\x1b[B") task.repoIdx = Math.min(list.length - 1, task.repoIdx + 1);
  else if (k === "\x7f") {
    task.repoFilter = task.repoFilter.slice(0, -1);
    task.repoIdx = 0;
  } else if (k === "\r") {
    const repo = list[task.repoIdx];
    if (!repo) return say("NO REPO SELECTED", C.amber);
    launchTask({ ...parsedTask(), repoPath: repo.path, repoName: repo.name });
    task = null;
  } else if (k.length === 1 && k >= " ") {
    task.repoFilter += k;
    task.repoIdx = 0;
  }
}

function launchTask(t) {
  if (DEMO) return say(`DEMO MODE · WOULD START ${t.id} IN ${t.repoName}`, C.violet);
  const child = spawn(process.execPath, [path.join(__dirname, "launch.js"), "task", JSON.stringify(t)], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  say(`▲ TASK LAUNCHING · ${t.id} → ${t.repoName}`, C.magenta, 5000);
}

function overlayTask(out, W, H) {
  const w = Math.min(W - 4, 78);
  const bg = "#0a1426";
  const P = (s) => S(s, { bg });
  const B = (s) => S(s, { fg: C.magenta, bg });
  const row = (content) => B("║") + fit(P("  ") + content, w - 2, P(""), true) + B("║");
  const t = parsedTask();
  const cursor = tick % 8 < 4 ? "▏" : " ";
  const lab = (s, on) => S(s.padEnd(9), { fg: on ? C.cyan : C.dim, bg, bold: true });

  const lines = [B("╔" + "═".repeat(w - 2) + "╗"), row(gradient("◢◤ NEW TASK", C.cyan, C.magenta, { bg, bold: true })), row("")];
  lines.push(row(lab("TICKET", task.step === 0) + S(task.input + (task.step === 0 ? cursor : ""), { fg: C.white, bg, bold: true })));
  if (t) {
    const kindCol = t.kind === "sentry" ? C.violet : C.cyan;
    const hint = /^[A-Za-z]/.test(t.id) && task.step === 0 ? `   tab: it's ${t.kind === "sentry" ? "YouTrack" : "Sentry"}` : "";
    lines.push(row(" ".repeat(9) + S(`◆ ${t.kind.toUpperCase()} · ${t.id}`, { fg: kindCol, bg, bold: true }) + S(hint, { fg: C.dim, bg })));
  } else {
    lines.push(row(" ".repeat(9) + S("paste PROJ-123, a YouTrack URL, API-1A or a Sentry URL", { fg: C.dim, bg })));
  }
  lines.push(row(""));
  if (task.step === 1) {
    const list = repoChoices();
    lines.push(row(lab("REPO", true) + S(task.repoFilter + cursor, { fg: C.white, bg, bold: true })));
    const max = Math.max(3, Math.min(10, H - 16));
    const start = Math.max(0, Math.min(task.repoIdx - Math.floor(max / 2), list.length - max));
    for (let i = start; i < Math.min(list.length, start + max); i++) {
      const r = list[i];
      const on = i === task.repoIdx;
      lines.push(
        row(
          " ".repeat(9) +
            S(on ? "▶ " : "  ", { fg: C.cyan, bg, bold: true }) +
            S(r.name, { fg: on ? C.white : C.text, bg, bold: on }) +
            S(r.prs ? `  ${r.prs} PR${r.prs > 1 ? "s" : ""}` : "", { fg: C.dim, bg }),
        ),
      );
    }
    if (!list.length) lines.push(row(" ".repeat(9) + S("no matching repo", { fg: C.dim, bg })));
    lines.push(row(""));
    lines.push(row(S("↵ launch   ↑↓ pick   type to filter   esc back", { fg: C.mute, bg })));
  } else {
    lines.push(row(S("↵ next   esc cancel", { fg: C.mute, bg })));
  }
  lines.push(B("╚" + "═".repeat(w - 2) + "╝"));

  const x = Math.floor((W - w) / 2);
  const y = Math.max(1, Math.floor((H - lines.length) / 2));
  lines.forEach((b, i) => {
    if (y + i < out.length) out[y + i] = fit(S(" ".repeat(x), { bg: C.bg }) + b, W, S("", { bg: C.bg }));
  });
}

// ── actions ────────────────────────────────────────────────────────────────
// What enter does on a card without an agent: review new PRs, re-check
// those with news since my review, a report-only status check on mine.
function enterAction(pr) {
  if (pr.tab === "mine") return { kind: "status", label: "CHECK" };
  if (pr.col === 0) return { kind: "review", label: "REVIEW" };
  if (pr.col === 1) return { kind: "recheck", label: "RE-CHECK" };
  return { kind: null, label: "WAIT", why: "WAITING ON AUTHOR · NOTHING NEW SINCE YOUR REVIEW" };
}

function canDeploy(pr) {
  if (pr.tab !== "mine") return "deploy is for your own PRs";
  if (pr.reviewDecision !== "APPROVED") return "not approved yet";
  if (pr.toAnswer) return `${pr.toAnswer} comment${pr.toAnswer > 1 ? "s" : ""} to answer`;
  if (pr.ci !== "pass") return `CI is ${pr.ci}`;
  if (pr.conflict) return "has merge conflicts";
  return true;
}

// Hand the terminal to $EDITOR, then come back and rescan with the new
// config (the poller rereads it on every scan).
function editConfig() {
  const { spawnSync } = require("node:child_process");
  if (!fs.existsSync(U.paths.config)) {
    fs.mkdirSync(path.dirname(U.paths.config), { recursive: true });
    fs.writeFileSync(U.paths.config, "{\n}\n");
  }
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  process.stdin.setRawMode(false);
  process.stdout.write(`${MOUSE_OFF}${ESC}0m${ESC}?25h${ESC}?1049l`);
  spawnSync("/bin/sh", ["-c", `${editor} "$0"`, U.paths.config], { stdio: "inherit" });
  process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}2J${MOUSE_ON}`);
  process.stdin.setRawMode(true);
  lastLines = [];
  try {
    JSON.parse(fs.readFileSync(U.paths.config, "utf8"));
    refresh(true);
    say("⚙ SETTINGS SAVED · RESCANNING", C.green);
  } catch (e) {
    say(`✕ CONFIG IS NOT VALID JSON · ${e.message}`.toUpperCase(), C.red, 8000);
  }
}

function current() {
  const s = selected(buildLanes(ui.tab));
  return s && s.pr;
}

function openUrl(url) {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

function copy(text) {
  const cmds = process.platform === "darwin" ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "-b", "-i"]];
  for (const [cmd, ...args] of cmds) {
    const r = require("node:child_process").spawnSync(cmd, args, { input: text });
    if (!r.error && r.status === 0) return;
  }
}

function quit(after) {
  saveUi();
  process.stdout.write(`${MOUSE_OFF}${ESC}0m${ESC}?25h${ESC}?1049l`);
  if (after) {
    // The popup closes when this process exits, so focus from a detached
    // child once it is gone.
    const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
    spawn("/bin/sh", ["-c", `sleep 0.2; "${herdrBin}" agent focus "${after}"`], { detached: true, stdio: "ignore", env: process.env }).unref();
  }
  process.exit(0);
}

// SGR mouse. Herdr's popups only forward alt+click (plain clicks, ctrl+click
// and the wheel stay with Herdr), so alt+click is the gesture: it selects a
// card and marks it for deploy. Plain click (select) and the wheel are
// handled too, for when they do arrive.
const DEBUG_INPUT = !DEMO && U.config().debugInput;
function onMouse(k) {
  if (DEBUG_INPUT) U.log("mouse", JSON.stringify(k));
  const m = k.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
  if (!m || m[4] !== "M" || task || help) return;
  const [b, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (b & 64) return move(0, (b & 1) ? 1 : -1);
  if ((b & 3) !== 0 || b & 32) return;
  const tab = hit.tabs.find((t) => t.y === y && x >= t.x0 && x <= t.x1);
  if (tab) {
    ui.tab = tab.id;
    scroll = 0;
    return;
  }
  const c = hit.cards.find((h) => y >= h.y0 && y <= h.y1 && x >= h.x0 && x <= h.x1);
  if (!c) return;
  const pr = data.prs.find((p) => p.url === c.url);
  ui.sel[ui.tab] = { url: c.url, col: c.col, pos: 0 };
  if (b & (16 | 8) && pr) toggleMark(pr);
}

function onKey(k) {
  if (DEBUG_INPUT && k.startsWith("\x1b") && !k.startsWith("\x1b[<")) U.log("key", JSON.stringify(k));
  if (k.startsWith("\x1b[<")) return onMouse(k);
  if (task) return taskKey(k);
  if (filterMode) {
    if (k === "\r" || k === "\x1b[A" || k === "\x1b[B") filterMode = false;
    else if (k === "\x1b") {
      filter = "";
      filterMode = false;
    } else if (k === "\x7f") filter = filter.slice(0, -1);
    else if (k.length === 1 && k >= " ") filter += k;
    if (k !== "\x1b[A" && k !== "\x1b[B") return;
  }
  if (help) {
    help = false;
    return;
  }
  const pr = current();
  switch (k) {
    case "\x1b[A":
    case "k":
      return move(0, -1);
    case "\x1b[B":
    case "j":
      return move(0, 1);
    case "\x1b[D":
    case "h":
      return move(-1, 0);
    case "\x1b[C":
    case "l":
      return move(1, 0);
    case "\t":
    case "\x1b[Z":
      ui.tab = ui.tab === "mine" ? "review" : "mine";
      scroll = 0;
      return;
    case "1":
      ui.tab = "mine";
      scroll = 0;
      return;
    case "2":
      ui.tab = "review";
      scroll = 0;
      return;
    case "R":
    case "\x1b[15~":
      return refresh(true);
    case "/":
      filterMode = true;
      return;
    case "?":
      help = true;
      return;
    case "n":
      return openTask("");
    case ",":
      return editConfig();
    case "s":
      ui.showSnoozed = !ui.showSnoozed;
      say(ui.showSnoozed ? "SHOWING SNOOZED" : "HIDING SNOOZED", C.violet);
      return;
    case "q":
    case "\x1b":
    case "\x03":
      if (k === "\x1b" && filter) {
        filter = "";
        return;
      }
      if (k === "\x1b" && marked.length) {
        marked = [];
        return say("MARKS CLEARED", C.violet, 1500);
      }
      return quit();
  }
  if (!pr) return;
  switch (k) {
    case "r":
    case "c": {
      // c means "comments": re-check them on others' PRs, address them on mine.
      if (pr.tab !== "review" && k === "r") return say("r REVIEWS PRS ON THE TO REVIEW TAB · c ADDRESSES COMMENTS HERE", C.amber);
      const L = launches[pr.url];
      if (L && L.state === "starting") return say("ALREADY LAUNCHING", C.amber);
      const ag = agentFor(pr);
      if (ag && !["idle", "done"].includes(ag.agent_status)) return say(`AGENT IS ${ag.agent_status.toUpperCase()} · ↵ TO JUMP`, C.amber);
      const kind = pr.tab === "mine" ? "address" : k === "r" ? "review" : "recheck";
      return launch(kind, pr, ag && ag.pane_id);
    }
    case " ":
      return toggleMark(pr);
    case "d": {
      if (marked.length) {
        if (pr.tab !== "mine") return say("SWITCH TO MINE TO DEPLOY THE MARKED PRS", C.amber);
        if (marked.some((u) => launches[u] && launches[u].state === "starting")) return say("ALREADY LAUNCHING", C.amber);
        return deployMarked();
      }
      const ok = canDeploy(pr);
      if (ok !== true) return say(`NO DEPLOY · ${ok.toUpperCase()}`, C.red);
      const L = launches[pr.url];
      if (L && L.state === "starting") return say("ALREADY LAUNCHING", C.amber);
      return launch("deploy", pr);
    }
    case "\r": {
      const ag = agentFor(pr);
      if (ag) {
        if (DEMO) return say(`DEMO MODE · WOULD JUMP TO ${ag.pane_id}`, C.violet);
        return quit(ag.pane_id);
      }
      const act = enterAction(pr);
      if (!act.kind) return say(act.why, C.blue);
      const L = launches[pr.url];
      if (L && L.state === "starting") return say("ALREADY LAUNCHING", C.amber);
      return launch(act.kind, pr);
    }
    case "o":
      openUrl(pr.url);
      return say("↗ OPENED IN BROWSER", C.cyan, 1500);
    case "f":
      openUrl(`${pr.url}/files`);
      return say("↗ FILES CHANGED", C.cyan, 1500);
    case "y":
      copy(pr.url);
      return say("⧉ URL COPIED", C.cyan, 1500);
    case "z":
      if (ui.snoozed[pr.url] === pr.updatedAt) {
        delete ui.snoozed[pr.url];
        say("☀ UNSNOOZED", C.violet);
      } else {
        ui.snoozed[pr.url] = pr.updatedAt;
        say("☾ SNOOZED UNTIL IT CHANGES", C.violet);
      }
      saveUi();
      return;
  }
}

// ── main ───────────────────────────────────────────────────────────────────
function main() {
  if (SNAP) {
    if (SNAP[1]) ui.tab = SNAP[1];
    if (SNAP[2] !== undefined) openTask(SNAP[2]);
    // SNAP_KEYS='["\u001b[C","\r"]': replay keys before the frame (tests).
    for (const k of JSON.parse(process.env.SNAP_KEYS || "[]")) onKey(k);
    pollFiles();
    pollAgents();
    if (!DEMO) {
      // pollAgents is async; a snapshot needs the agents now.
      try {
        const out = require("node:child_process").execFileSync(process.env.HERDR_BIN_PATH || "herdr", ["agent", "list"], { encoding: "utf8" });
        agents = new Map((JSON.parse(out).result.agents || []).map((a) => [a.pane_id, a]));
        links = linkAgents(agents, data.prs, agentMap);
      } catch {}
    }
    if (process.env.SNAP_FX) {
      // Freeze a shooting star and a shimmer mid-flight for design checks.
      const now = Date.now();
      header.shoot = { start: now - 900, speed: 90, y0: 0.1, drop: 2.6 };
      header.shimmerAt = now - 400;
    }
    // SNAP_FRAMES=n: n frames SNAP_DT ms apart, separated by form feeds, for
    // the README GIF. The shooting star and the shimmer are timed into it.
    const frames = Number(process.env.SNAP_FRAMES || 0);
    if (frames) {
      const dt = Number(process.env.SNAP_DT || 100);
      const now = Date.now();
      header.shoot = null;
      header.nextShoot = now + 400;
      header.shimmerAt = now + 2600;
      header.nextShimmer = now + 2600;
      let i = 0;
      const step = () => {
        render();
        if (++i >= frames) return process.stdout.write(`${ESC}0m\n`);
        process.stdout.write(`${ESC}0m\f`);
        setTimeout(step, dt);
      };
      return step();
    }
    render();
    process.stdout.write(`${ESC}0m\n`);
    return;
  }
  if (!process.stdin.isTTY) {
    console.error("dashboard needs a terminal");
    process.exit(1);
  }
  process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}2J${MOUSE_ON}`);
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (buf) => {
    // A paste or fast typing can deliver several keys in one chunk.
    const keys = buf.match(/\x1b\[<[0-9;]*[Mm]|\x1b\[[0-9;]*[~A-Za-z]|\x1bO[A-Z]|\x1b|[\s\S]/g) || [];
    for (const k of keys) onKey(k);
    render();
  });
  process.stdout.on("resize", () => {
    lastLines = [];
    process.stdout.write(`${ESC}2J`);
    render();
  });
  process.on("SIGTERM", () => quit());
  process.on("exit", saveUi);

  // Drop stale snoozes and finished launch errors older than 10 minutes.
  for (const [url, at] of Object.entries(launches)) {
    if (at.state === "error" && Date.now() - Date.parse(at.at) > 600000) delete launches[url];
  }

  const pending = U.readJSON(U.paths.pendingTask, null);
  if (pending) {
    try {
      fs.unlinkSync(U.paths.pendingTask);
    } catch {}
    openTask(pending.input || "");
  }

  if (!DEMO) U.ensureDaemon();
  pollFiles();
  pollAgents();
  if (!data.fetchedAt || Date.now() - Date.parse(data.fetchedAt) > 60000) setTimeout(refresh, 300);

  setInterval(pollFiles, 600);
  setInterval(pollAgents, 1500);
  setInterval(render, 90);
  render();
}

main();
