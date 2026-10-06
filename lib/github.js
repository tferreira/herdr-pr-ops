"use strict";

const { shAsync, config } = require("./util");

// Full detail for one PR. Fetched only for PRs whose signature changed (see
// LIGHT_FIELDS), since this costs about 2 rate-limit points per PR.
const PR_FIELDS = `
  ... on PullRequest {
    id number title url isDraft updatedAt reviewDecision mergeable headRefName
    author { login }
    repository { nameWithOwner name }
    myReviews: reviews(author: $me, last: 1) { nodes { state submittedAt } }
    commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { state contexts(first: 50) { nodes {
      __typename
      ... on StatusContext { state description }
      ... on CheckRun { status conclusion }
    } } } } } }
    pushes: timelineItems(last: 1, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) { nodes { ... on HeadRefForcePushedEvent { createdAt } } }
    requests: timelineItems(last: 10, itemTypes: [REVIEW_REQUESTED_EVENT]) { nodes { ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } } } } }
    reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
    reviewThreads(first: 50) { nodes {
      isResolved
      first: comments(first: 1) { nodes { author { login } } }
      last: comments(last: 1) { nodes { author { __typename login } createdAt } }
    } }
    comments(last: 15) { nodes { author { __typename login } createdAt } }
    reviews(last: 20) { nodes { author { __typename login } state body submittedAt } }
  }`;

// Just enough to notice a change: comments, reviews and pushes bump
// updatedAt, but CI results and mergeability do not, so those ride along.
const LIGHT_FIELDS = `
  ... on PullRequest {
    id url updatedAt mergeable reviewDecision
    commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
  }`;

const signature = (n) => {
  const c = n.commits.nodes[0] && n.commits.nodes[0].commit;
  return [n.updatedAt, n.mergeable, n.reviewDecision, c && c.oid, c && c.statusCheckRollup && c.statusCheckRollup.state].join("|");
};

// `orgs` and `excludeRepos` from config narrow every search. Several org:
// qualifiers are OR'ed by GitHub search.
function searchQuery() {
  const cfg = config();
  const scope = [
    ...(cfg.orgs || []).map((o) => `org:${o}`),
    ...(cfg.excludeRepos || []).map((r) => `-repo:${r}`),
  ].join(" ");
  const q = (extra) => JSON.stringify(`is:pr is:open archived:false ${extra} ${scope}`.trim());
  return `query {
  rateLimit { cost remaining resetAt }
  mine: search(query: ${q("author:@me")}, type: ISSUE, first: 100) { issueCount nodes { ${LIGHT_FIELDS} } }
  requested: search(query: ${q("review-requested:@me")}, type: ISSUE, first: 100) { issueCount nodes { ${LIGHT_FIELDS} } }
  reviewed: search(query: ${q("reviewed-by:@me -author:@me")}, type: ISSUE, first: 100) { issueCount nodes { ${LIGHT_FIELDS} } }
}`;
}

const DETAIL_QUERY = `query($me: String!, $ids: [ID!]!) {
  rateLimit { cost remaining resetAt }
  nodes(ids: $ids) { ${PR_FIELDS} }
}`;

async function graphql(query, vars = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (Array.isArray(v)) for (const x of v) args.push("-f", `${k}[]=${x}`);
    else args.push("-F", `${k}=${v}`);
  }
  const res = JSON.parse(await shAsync("gh", args));
  if (res.errors && !res.data) throw new Error(res.errors.map((e) => e.message).join("; "));
  return res.data;
}

let cachedLogin = null;
async function viewerLogin() {
  if (!cachedLogin) cachedLogin = (await shAsync("gh", ["api", "user", "--jq", ".login"])).trim();
  return cachedLogin;
}

// CircleCI approval jobs report "pending / on hold" until someone clicks
// approve, which is the normal state of a green PR that gates a release, so
// they count as passing.
function ciState(commit) {
  const rollup = commit && commit.statusCheckRollup;
  if (!rollup) return "none";
  let pending = false;
  for (const c of rollup.contexts.nodes) {
    if (c.__typename === "StatusContext") {
      if (c.state === "FAILURE" || c.state === "ERROR") return "fail";
      if (c.state === "PENDING" && !/on hold/i.test(c.description || "")) pending = true;
    } else if (c.__typename === "CheckRun") {
      if (c.status !== "COMPLETED") pending = true;
      else if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(c.conclusion)) return "fail";
    }
  }
  return pending ? "pending" : "pass";
}

const maxDate = (...ds) => ds.filter(Boolean).sort().pop() || null;

function normalize(n, me, requestedUrls) {
  const commit = n.commits.nodes[0] && n.commits.nodes[0].commit;
  const myLast = n.myReviews.nodes[0] || null;
  const myLastAt = myLast && myLast.submittedAt;
  const headAt = maxDate(commit && commit.committedDate, n.pushes.nodes[0] && n.pushes.nodes[0].createdAt);
  const reRequestedAt = maxDate(
    ...n.requests.nodes.filter((r) => r.requestedReviewer && r.requestedReviewer.login === me).map((r) => r.createdAt),
  );
  const threads = n.reviewThreads.nodes;
  const unresolved = threads.filter((t) => !t.isResolved).length;
  // Threads I opened where someone else spoke last, after my last review.
  const replies = threads.filter((t) => {
    const first = t.first.nodes[0];
    const last = t.last.nodes[0];
    return (
      first && first.author && first.author.login === me &&
      last && last.author && last.author.login !== me &&
      (!myLastAt || last.createdAt > myLastAt)
    );
  }).length;
  // On my own PRs: things someone said that I have not answered yet.
  const isBot = (a) => !a || a.__typename === "Bot" || /\[bot\]$/.test(a.login);
  const mine = (a) => a && a.login === me;
  const myActivity = maxDate(
    headAt,
    ...n.comments.nodes.filter((c) => mine(c.author)).map((c) => c.createdAt),
    ...n.reviews.nodes.filter((r) => mine(r.author)).map((r) => r.submittedAt),
  );
  const after = (at) => !myActivity || at > myActivity;
  const unansweredThreads = threads.filter((t) => {
    const last = t.last.nodes[0];
    return !t.isResolved && last && !mine(last.author) && !isBot(last.author);
  }).length;
  const unansweredComments = n.comments.nodes.filter((c) => !mine(c.author) && !isBot(c.author) && after(c.createdAt)).length;
  const unansweredReviews = n.reviews.nodes.filter(
    (r) => !mine(r.author) && !isBot(r.author) && r.state === "COMMENTED" && (r.body || "").trim() && after(r.submittedAt),
  ).length;
  const toAnswer = unansweredThreads + unansweredComments + unansweredReviews;

  const directRequest = n.reviewRequests.nodes.some(
    (r) => r.requestedReviewer && r.requestedReviewer.login === me,
  );

  return {
    url: n.url,
    number: n.number,
    title: n.title,
    repo: n.repository.nameWithOwner,
    repoName: n.repository.name,
    author: n.author ? n.author.login : "ghost",
    isDraft: n.isDraft,
    updatedAt: n.updatedAt,
    headRef: n.headRefName,
    reviewDecision: n.reviewDecision,
    conflict: n.mergeable === "CONFLICTING",
    mergeable: n.mergeable,
    ci: ciState(commit),
    unresolved,
    toAnswer,
    replies,
    requested: requestedUrls.has(n.url),
    teamOnly: requestedUrls.has(n.url) && !directRequest,
    myLast: myLast ? { state: myLast.state, at: myLastAt } : null,
    headAt,
    reRequestedAt,
  };
}

// Mine:      needs me -> in review -> ready to ship
// To review: new -> recheck -> waiting
// Returns null when the PR should not be shown.
function classify(pr, tab) {
  if (tab === "mine") {
    const needs = [];
    if (pr.reviewDecision === "CHANGES_REQUESTED") needs.push("changes requested");
    if (pr.toAnswer) needs.push(`${pr.toAnswer} to answer`);
    if (pr.ci === "fail") needs.push("CI failed");
    if (pr.conflict) needs.push("conflict");
    if (needs.length) return { col: 0, reason: needs.join(", ") };
    if (pr.reviewDecision === "APPROVED" && pr.ci !== "pending") return { col: 2 };
    return { col: 1, reason: pr.reviewDecision === "APPROVED" ? "CI running" : "" };
  }
  const my = pr.myLast;
  if (!my) return pr.requested ? { col: 0, reason: pr.teamOnly ? "team" : "" } : null;
  if (pr.reRequestedAt && pr.reRequestedAt > my.at) return { col: 1, reason: "re-requested" };
  if (my.state === "APPROVED") return null;
  const reasons = [];
  if (pr.headAt && pr.headAt > my.at) reasons.push("new commits");
  if (pr.replies) reasons.push(`${pr.replies} repl${pr.replies > 1 ? "ies" : "y"}`);
  if (reasons.length) return { col: 1, reason: reasons.join(", ") };
  return { col: 2 };
}

// prev: the last cache (its `raw` holds full PR nodes by url). full: ignore it
// and refetch every PR's detail.
async function fetchAll(prev, { full = false } = {}) {
  const me = await viewerLogin();
  const light = await graphql(searchQuery());
  const raw = (!full && prev && prev.raw) || {};
  const lists = ["mine", "requested", "reviewed"].map((k) => light[k].nodes.filter((n) => n.url));

  const stale = new Map();
  for (const n of lists.flat()) {
    const hit = raw[n.url];
    if (!hit || hit.sig !== signature(n)) stale.set(n.id, signature(n));
  }
  let cost = light.rateLimit.cost;
  let rate = light.rateLimit;
  const ids = [...stale.keys()];
  const nextRaw = {};
  for (let i = 0; i < ids.length; i += 25) {
    const d = await graphql(DETAIL_QUERY, { me, ids: ids.slice(i, i + 25) });
    cost += d.rateLimit.cost;
    rate = d.rateLimit;
    for (const node of d.nodes) if (node) nextRaw[node.url] = { sig: stale.get(node.id), node };
  }
  for (const n of lists.flat()) if (!nextRaw[n.url] && raw[n.url]) nextRaw[n.url] = raw[n.url];

  const requestedUrls = new Set(lists[1].map((n) => n.url));
  const prs = [];
  const seen = new Set();
  const add = (n, tab) => {
    if (seen.has(n.url) || !nextRaw[n.url]) return;
    seen.add(n.url);
    const pr = normalize(nextRaw[n.url].node, me, requestedUrls);
    const c = classify(pr, tab);
    if (c) prs.push({ ...pr, tab, ...c });
  };
  for (const n of lists[0]) add(n, "mine");
  for (const n of [...lists[1], ...lists[2]]) add(n, "review");
  // One search page holds 100; say so when a list is longer.
  const truncated = ["mine", "requested", "reviewed"]
    .filter((k) => light[k].issueCount > light[k].nodes.length)
    .map((k) => ({ list: k, shown: light[k].nodes.length, total: light[k].issueCount }));
  return {
    me,
    fetchedAt: new Date().toISOString(),
    truncated,
    prs,
    raw: nextRaw,
    rate: { cost, refetched: ids.length, remaining: rate.remaining, resetAt: rate.resetAt },
  };
}

module.exports = { fetchAll };
