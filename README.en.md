# dsh-plugin-simple-delete-session

[简体中文](README.md)


> A DeepSeek Harness (DSH) plugin that adds a **“Delete session”** item to the sidebar session menu. After a second confirmation it **permanently deletes that one session** — **without touching any other session**, and **there is no way to get it back**.

![“Delete session” in the session menu](docs/menu.png)

![The confirmation dialog](docs/delete.png)

---

## Features

- **Sidebar session row “…” menu → “Delete session”** (red, after the shipped Pin / Rename / Fork / Archive rows).
- **Two-step confirmation dialog**: shows the session title and id, warns in red that deletion cannot be undone, and requires ticking *“I understand this cannot be recovered.”* before the delete button enables. A running session gets an extra warning and the button becomes **Stop and delete**.
- **A real hard delete**: removes this session's own log directory (`<DSH_HOME>/sessions/<project>/<session-id>/`) and drops it from the in-memory session store, workspace accounting, the archive set and the pin set; the row disappears immediately.
- **Navigates away when it deletes what you are viewing**: the shell switches to the most recently used remaining session, or to the new-session empty state when none is left — it never leaves you on the page of a session that no longer exists.
- **Only that one session**: other sessions, the workspace itself, directories, attachments and DSH configuration are untouched.
- Bilingual copy (zh/en) that follows the UI language.

---

## Compatibility

- Verified on **DSH desktop 0.2.0-rc.1** (Windows); `dsh.engines.dsh` in `package.json` declares `>=0.1.0-rc.6`.
- The desktop client and `dsh web` share this one implementation; the plugin uses public Cordis services and official slots only, and never modifies files inside the DSH installation.

---

## Installation

Requires the DSH desktop client or `dsh web`. Replace the profile name with your own (the desktop client usually uses `desktop`).

### From GitHub

```sh
dsh plugin --profile desktop add github:<your-github-user>/dsh-plugin-simple-delete-session
```

### From a local checkout

```sh
dsh plugin --profile desktop add file:<absolute-path>/dsh-plugin-simple-delete-session
```

On Windows the repository also ships `install.cmd`:

```bat
install.cmd            rem install into the desktop profile
install.cmd web        rem install into the web profile
```

### After installing

1. **Restart DSH** (the host half registers its endpoint at startup);
2. refresh the page (`Ctrl+Shift+R`);
3. any sidebar session row → “…” → **Delete session** at the bottom.

Uninstall:

```sh
dsh plugin --profile desktop remove dsh-plugin-simple-delete-session
```

> Local development note: DSH installs the plugin directory as a **copied snapshot**, so after editing the source run `dsh plugin add` again (or copy the changed files into the profile's `node_modules/dsh-plugin-simple-delete-session/`) and restart DSH.

---

## License

MIT — see [LICENSE](LICENSE).
