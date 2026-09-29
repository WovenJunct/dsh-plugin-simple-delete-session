# Changelog

All notable changes to this plugin are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · versioning: [SemVer](https://semver.org/).

## [0.2.0] — 2026-09-30

Verified on DSH desktop **0.2.0-rc.1** (Windows).

### Added

- Sidebar session menu row **删除会话 / Delete session** (`sidebar.workspaces.session.menu.item`, `order: 900`).
- Two-step confirmation dialog in `shell.overlay`: title + session id, red irreversibility warning, mandatory acknowledgement checkbox, running-session warning and **Stop and delete** action.
- After deleting the session that is currently open, the shell navigates to the most recently used remaining session (or to the new-session empty state when none is left).
- zh/en copy that follows the client locale service.
- Zero-dependency self-check (`npm run verify`) covering the disk logic, the host delete orchestration and the browser half.

### Changed

- Hard delete now releases the live in-memory session through the store entry's own detach capability, so the sidebar row disappears immediately instead of after a restart.
- Hard delete also removes the session's persisted projection-cache row (`session_projcache`), which previously kept folded metadata such as the title on disk.
- The delete route is registered as soon as a web carrier exists (`ctx.inject`), so the browser half no longer receives the `/plugins` bundle route's 405.

### Fixed

- Cold (persistence-only) sessions no longer linger as an "Ungrouped" ghost row: the host broadcasts both `session/disposed` and `api-session/removed`.
- A log directory recreated by a lingering writer right after the unlink is detected and erased again.

## [0.1.0] — 2026-09-30

### Added

- First working version: menu row, confirmation dialog, host delete route and the ordered hard-delete chain (cancel running turn → `flush` → release `ctx.sessions` residency → detach from workspaces / archive / pin → remove the session's own log directory → re-scan verification → broadcast `session/disposed`).
- Sessions-root resolution through `ctx.configEditor` (`session-persistence-jsonl.root`), then `DSH_SESSIONS_ROOT`, then `DSH_HOME`/`sessions`.
