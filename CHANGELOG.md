# Changelog

All notable changes to this plugin are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · versioning: [SemVer](https://semver.org/).

## [0.1.0] — 2026-01-01

### Added

- Sidebar session menu row **删除会话 / Delete session** (`sidebar.workspaces.session.menu.item`, `order: 900`).
- Two-step confirmation dialog in `shell.overlay`: title + session id, red irreversibility warning, mandatory acknowledgement checkbox, running-session warning and **Stop and delete** action.
- Host route `POST /plugins/dsh-plugin-simple-delete-session/delete` (mirrored at `/api/session-delete/delete`) with `describe` and `delete` actions.
- Ordered, fail-safe hard delete: cancel running turn → `flush` → release `ctx.sessions` residency → detach from workspaces / archive / pin → remove the session's own log directory → re-scan verification → broadcast `session/disposed`.
- Sessions-root resolution through `ctx.configEditor` (`session-persistence-jsonl.root`), then `DSH_SESSIONS_ROOT`, then `DSH_HOME`/`sessions`.
- zh/en copy that follows the client locale service.
