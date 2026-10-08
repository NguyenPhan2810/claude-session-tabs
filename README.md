# session-tabs

OpenCode-style session tabs for the Claude Code terminal UI: a sidebar with a tab for each of your
Claude Code sessions, titled by what you asked in them. A tab stays until you close it, even after
its session ends, and clicking it takes you there in tmux.

```
│4 sessions · 1 needs you
│────────────────────────────────────────
│⠹ Refactor auth middleware             ✕
│  backend
│────────────────────────────────────────
│● Docs pass for v2 release             ✕
│  docs
│────────────────────────────────────────
│– Flaky CI tests                       ✕
│  web
│────────────────────────────────────────
│✓ Nightly dependency cleanup           ✕
│  infra
│────────────────────────────────────────
│+ New session
```

A spinner means working, a yellow `●` waiting for you, `○` idle, `–` exited, `✓` done (a background
session). The session you're in is in bold.

It's a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview), a plugin of
function hooks. Built and tested on Claude Code 2.1.294, on Linux with tmux 3.4.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-tabs --marketplace NguyenPhan2810/claude-session-tabs
```

Answer `y` to add the marketplace, then pick a scope (user scope runs it in every session).

## Use

- **Click a tab**, or type **`/tabs 2`** / **`/tabs docs`** (a title prefix), to go to that session:
  - running in a tmux pane: your terminal jumps to that pane
  - exited: it's reopened (`claude --resume`) in a new tmux window, and you jump there
  - a background session: it's opened (`claude attach`) in a new tmux window, or the window
    already showing it
- **+ New session** or **`/tabs new`** starts `claude` in a new tmux window, in this session's folder.
- **✕** or **`/tabs close 2`** closes a tab. Like OpenCode, that only hides it: a background
  session keeps running, and any conversation can still be resumed. **`/tabs reopen`** brings back
  the last tab you closed.
- **`/tabs`** toggles the sidebar. If you close the sidebar, it stays closed in new sessions until
  you run `/tabs` again.
- Focus the sidebar (`Ctrl+X` then `Tab`), then `Tab` and `Enter` to open tabs from the keyboard.

### Titles

A tab shows the name you gave its session with `/rename`, or one Claude Code gave it. Otherwise,
after its first turn, each session titles itself from your first prompt, the way OpenCode does: it
asks a small model (Haiku) for a 3 to 5 word title, once per session, through your own Claude
plan or API key. Where that isn't available, the first line of the prompt is the title.

Tabs are shared by all your sessions and kept across restarts. A tab closes on its own only when
there's nothing left to open: a session that ended before its first message, or a background
session you deleted (`claude rm`, or `Ctrl+X` twice in `claude agents`). Past 40 tabs, the ones
whose sessions ended longest ago close.

### Sessions that keep running without a terminal

Like OpenCode's background server, Claude Code can run sessions in a background service that
outlives your terminal: start one with `claude --bg "task"`, or press `←` on an empty prompt (or run
`/bg`) to move the current one there. Its tab shows its progress, and clicking it attaches. A plain
`claude` session lives in its terminal: when you exit, its tab stays as exited and clicking it
resumes the conversation.

### Fullscreen gives you the sidebar

Claude Code docks a mod's pane beside the transcript only in
[fullscreen rendering](https://code.claude.com/docs/en/fullscreen). Under the classic renderer
the list sits in a compact block above the prompt instead. Switch with `/tui fullscreen`, or start
with `CLAUDE_CODE_NO_FLICKER=1 claude`. The sidebar opens by itself once the terminal is at least
144 columns wide.

### Switching needs tmux

A mod can't move your terminal from one session to another, so tabs open through tmux: a session's
own pane, or a new window. Outside tmux, opening a tab tells you the command to run instead.

## How it works

- While the sidebar is open, every 2 seconds it reads Claude Code's session registry,
  `~/.claude/sessions/<pid>.json` (or under `$CLAUDE_CONFIG_DIR`). It reads only those `.json`
  files and never the `.key` files beside them. With the sidebar closed it polls nothing.
- Background sessions, finished ones included, come from `claude agents --json --all`. Every
  session shares one answer through the mod's store, so the machine runs it at most once per
  10 seconds.
- A crashed session can leave its registry file behind, and its pid can later belong to another
  program. On Linux the mod compares each session's recorded start time with `/proc/<pid>/stat`;
  elsewhere it uses the `claude agents` answer.
- Tabs live in the mod's own store (`~/.claude/plugins/store/`), one entry per tab, with closing
  and titles kept apart so two sessions refreshing at once can't undo a close or lose a title.
- The spinner redraws the sidebar about 8 times a second, only while a tab is working and the
  sidebar is open.
- Before jumping to a running session's pane, it asks tmux which process runs there and checks the
  session runs under it, so it never jumps to a same-numbered pane on another tmux server. Windows
  it opens are tagged with the tmux pane option `@session-tabs`, so a second click goes to the
  same window.

The registry format is internal to Claude Code and may change between releases. If it does, the
list may come up empty until this mod is updated.

Mods are not sandboxed: this one runs with your user's permissions. It reads the registry folder,
`/proc/<pid>/stat`, whether a session's transcript exists, and its own session's first prompt (to
title it). It runs `claude agents --json --all`, `tmux`, `claude`, `claude --resume` or
`claude attach` in the windows it opens, and `ps` on systems without `/proc`.

## Develop

```
claude --plugin-dir .            # run it from this folder; edits hot-reload
claude plugin validate .         # what the engine would load or refuse
claude plugin test .             # tests/*.test.ts
```

Claude Code writes the API types to `.claude-plugin/types/` the first time it loads the mod;
after that, `npx -p typescript tsc -p .` type-checks it.

## License

MIT
