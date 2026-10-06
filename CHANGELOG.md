# Changelog

Versions follow [semantic versioning](https://semver.org). Before 1.0 the
board, keys and config can still change between minor versions.

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
- Agent marks in herdr-radar style; drafts drawn dashed and dim with GitHub's
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
