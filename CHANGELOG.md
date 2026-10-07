# Changelog

Versions follow [semantic versioning](https://semver.org). Before 1.0 the
board, keys and config can still change between minor versions.

## 0.8.1 - 2026-10-07

### Fixed
- An agent started by hand in a clone left on the branch of a merged or
  closed PR took that branch's ticket (PROJ-123 from `PROJ-123-...`) on its
  In progress card. It now shows under the repo name, without the branch.

## 0.8.0 - 2026-10-07

### Changed
- Worktrees go inside the clone, in `.claude/worktrees/` (`pr-<N>` for
  reviews and fixes, the ticket slug for tasks), where Claude Code keeps its
  own, instead of next to it. The folder is added to the clone's
  `.git/info/exclude` when git does not ignore it yet. Existing worktrees
  are still found by branch; `worktreePath` and `taskWorktreePath` bring the
  old layout back.

### Fixed
- Agents working in a worktree under `.claude/worktrees/` were not matched
  to the PR of that worktree's branch.

## 0.7.0 - 2026-10-07

### Added
- A working deploy agent's badge reads `deploying` instead of `working`,
  and its cards carry a rocket (`⇡` with `icons: "text"`), also after the
  PR merges. When one deploy ships several PRs, each card lists the others
  (`WITH #1873`).

### Fixed
- A deploy of several marked PRs showed its agent on only one card; it now
  shows on each, and enter on any of them goes to it.

## 0.6.0 - 2026-10-07

### Added
- `a` switches the agent that new launches start between the installed
  ones (Claude Code, Codex, ...), shown in the header and remembered. Your
  `prompts` go to your default agent only; others get the built-in prompts
  or their own `agentPrompts`. `agents` config lists them by hand.
- `agentArgs` config: extra command-line arguments per agent kind.

### Fixed
- Codex's update dialog at startup took the board's prompt as its answer
  and started an upgrade; Codex now starts with its update check off.

### Changed
- The manifest lists macOS only until the plugin is tried on Linux.

## 0.5.0 - 2026-10-07

### Added
- Works over `herdr --remote`: `y` copies the PR link to the clipboard of
  the screen you look at (OSC 52), and also to the server's. On a machine
  without a display, `o` and `f` copy instead of opening a browser.
  `openLinks` config (`auto`, `browser`, `copy`).

### Changed
- Icons are Nerd Font icons for everyone, including the Claude and OpenAI
  logos (Nerd Fonts 3.5 or later). `"icons": "text"` uses plain Unicode for
  terminals without a Nerd Font. Replaces the `glyphs` setting.

### Fixed
- Stopping (`x`) the agent whose tab the board was opened from closed the
  board too (Herdr closes a popup with its tab); the board now reopens.

## 0.4.3 - 2026-10-06

### Fixed
- An agent in a main clone was matched to the PR of whatever branch that
  clone still had checked out. Claude Code's per-entry metadata (`gitBranch`,
  `cwd`, ...) no longer counts as evidence, the checkout's branch no longer
  counts for merged or closed PRs, and titles like "PR 1617" count.
  `AGENTLINK_DEBUG=1` prints the scores.

## 0.4.2 - 2026-10-06

### Fixed
- New commits on a PR where your review request is still open (a comment-only
  review keeps it open) now go to Re-check instead of Waiting.

## 0.4.1 - 2026-10-06

### Fixed
- A task's agent could still leave In progress for an unrelated PR its
  investigation mentioned. Agents started with `n` now stay on their task
  until a PR exists for the task's own branch.

## 0.4.0 - 2026-10-06

### Added
- `x` `x` stops the card's agent: closes its pane, or its tab when alone, and
  removes a clean review worktree. The PR stays on the board.
- Mine has an In progress column: tasks started with `n` and agents on a
  feature branch of your orgs' repos that has no PR yet, titled by the
  agent's own terminal title. `enter` jumps, `o` opens the ticket.
- Merged, closed and approved-by-you PRs keep their card while an agent is
  on them (tagged, last column, up to a day), so deploys and reviews stay
  reachable from the board. "Merged" notification for your PRs.
- Tasks show on the board as soon as they launch ("starting agent"), and a
  failed launch stays as a card with the reason; `enter` retries.

### Fixed
- Starting a task opened a tab but no agent ("branch is not defined").
- A task's card vanished once its agent started (task records were matched
  as PRs), and briefly showed twice while launching.

### Changed
- Re-check only for signals meant for you: re-requested, replies in your
  threads, or new commits after you requested changes. New commits after a
  comment or a dismissed review leave the PR in Waiting, tagged "new commits".

## 0.3.0 - 2026-10-06

### Added
- First-run setup screen: detects your orgs (from PRs you were involved in),
  clone folders under `~`, and the Jira, Linear or YouTrack URL your coding
  agent is connected to; `enter` saves them to `config.json`. The `setup`
  action reruns it.
- The install binds the board to `prefix+d` (or `prefix+alt+d`) in a marked
  block of Herdr's `config.toml`; `keybinding` and `remove-keybinding`
  actions.

## 0.2.0 - 2026-10-06

### Added
- `enter` does the obvious thing: jump to the PR's agent, or start one. A
  review for new PRs, a re-check for PRs with news since your review, a
  report-only status check (`prompts.status`) on your own PRs. Nothing on PRs
  waiting on their author.
- `c` on your own PR gets it ready: review feedback, CI, conflicts
  (`prompts.address`). Fixes or drafts replies, shows you before committing,
  pushing or posting.
- Multi-ship: `space` or alt+click marks ready PRs in shipping order, `d`
  ships them all, one agent per repo. `{urls}` prompt placeholder.
- Ticket trackers: GitHub Issues, Jira, Linear, YouTrack and Sentry built in,
  your own via `trackers`. Bare `PROJ-123` goes to `defaultTracker`; `tab`
  in the task box cycles the alternatives. Ctrl+click handlers for all five.
- Agent marks on cards; drafts drawn dashed and dim with GitHub's
  draft icon.
- Header warning when a list holds more than the 100 PRs one search page
  returns.
- `debugInput` config: log raw key and mouse input to `plugin.log`.

### Changed
- Agents are matched to PRs by evidence (title, cwd branch, and for Claude
  Code the PR URLs, worktree paths, branches and ticket IDs in the recent
  session), one PR per agent. A hand-started agent working in a worktree
  from the main clone now shows on the right card.
- Key bar: when `enter` does what `r` or `c` does, they share a chip.
- Default ship prompt handles several PRs; ticket prompts ask you to paste
  the ticket when the agent has no access to the tracker.
- `r` and `c` prompt an idle agent already on the PR instead of starting one.

### Fixed
- Fetching PR heads failed with "Permission denied (publickey)": plugin
  processes run in the Herdr server without an SSH agent. Fetches now use
  HTTPS with `gh`'s token, also past `url.<ssh>.insteadOf` rewrites.
- Launch errors ending in `\r` hid their own text in the footer.
- Approved PRs with unanswered comments showed as ready to ship.

## 0.1.0 - 2026-10-06

First release: Mine and To review boards (columns by state, swimlanes by
repo), one-key review, re-check, ship and ticket agents in Herdr panes,
background poller with notifications, incremental GitHub scans, demo mode.
