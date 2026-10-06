"use strict";

// Fake board for `dashboard.js --demo`: try the UI without GitHub, and take
// screenshots without showing real pull requests.

const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

function pr(o) {
  const [repoName, number] = o.id.split("#");
  return {
    url: `https://github.com/acme/${repoName}/pull/${number}`,
    number: Number(number),
    repo: `acme/${repoName}`,
    repoName,
    author: "octocat",
    isDraft: false,
    updatedAt: ago(o.age || 30),
    headRef: o.branch || `feature-${number}`,
    reviewDecision: "REVIEW_REQUIRED",
    conflict: false,
    mergeable: "MERGEABLE",
    ci: "pass",
    unresolved: 0,
    toAnswer: 0,
    replies: 0,
    requested: false,
    teamOnly: false,
    myLast: null,
    headAt: ago(o.age || 30),
    reRequestedAt: null,
    reason: "",
    ...o,
  };
}

const PRS = [
  // mine
  pr({ id: "api#482", tab: "mine", col: 0, title: "feat(billing): prorate plan changes in the middle of a cycle", reviewDecision: "APPROVED", toAnswer: 2, unresolved: 2, reason: "2 to answer", age: 14 }),
  pr({ id: "api#471", tab: "mine", col: 0, title: "fix(auth): keep refresh tokens valid across clock skew", ci: "fail", reason: "CI failed", age: 180 }),
  pr({ id: "web#1290", tab: "mine", col: 1, title: "feat(dashboard): realtime usage chart with per-team filters", isDraft: true, ci: "pending", age: 2900 }),
  pr({ id: "web#1301", tab: "mine", col: 1, title: "fix(i18n): pluralize Japanese counters", age: 75 }),
  pr({ id: "api#479", tab: "mine", col: 2, title: "chore(deps): bump grpc to 1.66 and drop the keepalive patch", reviewDecision: "APPROVED", age: 40 }),
  pr({ id: "infra#88", tab: "mine", col: 2, title: "feat(k8s): autoscale workers on queue depth", reviewDecision: "APPROVED", age: 300 }),
  pr({ id: "web#1288", tab: "mine", col: 2, title: "fix(auth): rotate session cookies on privilege change", reviewDecision: "APPROVED", quiet: { kind: "merged", at: ago(6) }, reason: "merged", age: 6 }),
  // to review
  pr({ id: "web#1307", tab: "review", col: 0, author: "mona", requested: true, title: "refactor(router): move the auth guard into middleware", age: 22 }),
  pr({ id: "api#486", tab: "review", col: 0, author: "hubot", requested: true, teamOnly: true, reason: "team", title: "perf(search): cache the tokenizer per tenant", age: 95 }),
  pr({ id: "api#466", tab: "review", col: 1, author: "linus", reason: "new commits, 2 replies", unresolved: 3, myLast: { state: "COMMENTED", at: ago(1500) }, title: "feat(export): stream CSV for large reports", age: 12 }),
  pr({ id: "infra#91", tab: "review", col: 2, author: "ada", myLast: { state: "CHANGES_REQUESTED", at: ago(400) }, unresolved: 1, title: "fix(terraform): pin provider versions", age: 400 }),
];

function data() {
  return { me: "octocat", fetchedAt: ago(1.5), prs: PRS };
}

const AGENTS = [
  ["demo:p1", "api#482", "review", "working"],
  ["demo:p2", "api#466", "review", "blocked"],
  ["demo:p3", "api#479", "deploy", "done"],
  ["demo:p4", "web#1288", "deploy", "working"],
];

function agents() {
  return new Map(AGENTS.map(([pane, , , status]) => [pane, { pane_id: pane, agent: "claude", agent_status: status }]));
}

function agentMap() {
  const map = {};
  for (const [pane, id, slot] of AGENTS) {
    const p = PRS.find((x) => `${x.repoName}#${x.number}` === id);
    map[p.url] = { [slot]: pane };
  }
  return map;
}

// Repos for the new-task box, so the demo never lists real local clones.
function repos() {
  return ["api", "web", "infra", "mobile", "docs", "design-system"].map((name) => ({ name, path: `/demo/${name}` }));
}

module.exports = { data, agents, agentMap, repos };
