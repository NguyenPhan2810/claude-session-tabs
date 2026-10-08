# session-tabs

Vertical session tabs for the Claude Code terminal UI: a sidebar listing every Claude Code session
running on your machine, with its status. Inside tmux it jumps to another session's pane on click or
with `/tabs N`.

```
│2 sessions · 1 needs you
│
│● 1: api-refactor
│  working 3m · backend
│
│● 2: docs-pass
│  input needed 1m · docs
│
│○ 3: frontend ◂
│  idle 12m · web
│
│/tabs N to switch
```

`●` working, `●` (yellow) waiting for you, `○` idle. `◂` marks the session you're in.

It's a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview), a plugin of
function hooks. Built and tested on Claude Code 2.1.294, on Linux with tmux 3.4.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-tabs --marketplace NguyenPhan2810/claude-session-tabs
```

Answer `y` to add the marketplace, then pick a scope (user scope runs it in every session).

## Use

- The sidebar opens by itself in each new session once the terminal is at least 144 columns wide.
- **`/tabs`** toggles it. If you close it, it stays closed in new sessions until you run `/tabs` again.
- **`/tabs 2`** or **`/tabs docs`** switches to session 2, or to the first session whose name starts
  with `docs`. Works from the prompt, even while Claude is working.
- Click a session, or focus the pane (`Ctrl+X` then `Tab`) and press its number.

### Fullscreen gives you the sidebar

Claude Code docks a mod's pane beside the transcript only in
[fullscreen rendering](https://code.claude.com/docs/en/fullscreen). Under the classic renderer
the list sits in a compact block above the prompt instead. Switch with `/tui fullscreen`, or start with `CLAUDE_CODE_NO_FLICKER=1 claude`.

### Switching needs tmux

Claude Code can't move your terminal from one session to another, so switching goes through tmux:
each session records the tmux pane it runs in, and the mod runs `tmux switch-client -t <pane>`.
That needs both sessions in the same tmux server. A session that isn't in tmux still shows in the
list with its status, but pressing it just says it can't be reached from here. For background
sessions, use `claude agents`.

## How it works

- While the sidebar is open, it reads Claude Code's session registry every 2 seconds:
  `~/.claude/sessions/<pid>.json`, or under `$CLAUDE_CONFIG_DIR`. It reads only those `.json`
  files and never the `.key` files beside them. With the sidebar closed it polls nothing.
- A crashed session can leave its file behind, and its pid can later belong to another program.
  On Linux the mod compares each session's recorded start time with `/proc/<pid>/stat`. Elsewhere
  it runs `claude agents --json` every 15 seconds.
- Before switching, it asks tmux which process runs in the target pane and checks the session runs
  under it, so it never jumps to a same-numbered pane on another tmux server. It switches the
  terminal that's showing your current session.

The registry format is internal to Claude Code and may change between releases. If it does, the list
may come up empty until this mod is updated.

Mods are not sandboxed: this one runs with your user's permissions. It reads only the registry
folder and `/proc/<pid>/stat`. It runs only `tmux`, plus `ps` and `claude agents --json` on systems
without `/proc`.

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
