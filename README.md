# pi-bash-background

Run shell commands **detached** in the [Pi coding agent](https://github.com/earendil-works/pi)
and get the agent **woken** when they produce output or finish — without blocking the
current turn.

Pi deliberately ships no background-bash support (its stance is "use tmux"). This extension
brings Claude Code's `Bash(run_in_background)` semantic to Pi, plus a streaming `monitor`
variant. The wake is a real, first-class Pi primitive: `pi.sendUserMessage(...)`, which
always triggers a turn.

## Tools

| Tool | What it does |
|------|--------------|
| `bash_background({ command, description? })` | Spawn detached, capture combined stdout+stderr to a logfile, return immediately. **Wake once on exit** (with the exit code). For builds / test runs / "tell me when it's done". |
| `monitor({ command, description? })` | Spawn detached, **wake on new output** (delivered in coalesced batches, not one turn per line) and once more on exit. For watching a dev server / tail / streaming log. |
| `background_stop({ id })` | Tree-kill a running job by id. No wake (the stop is intentional). |
| `background_list()` | List live jobs (`id`, kind, pid, logfile). |

Each arm returns immediately with an `id` (e.g. `bg-0`), the `pid`, and a `logpath` you can
`read` at any time for full output.

## Install

This is a source-only Pi extension (Pi loads TypeScript directly).

**One-off, point Pi at the file:**

```sh
pi -e /path/to/pi-bash-background/src/index.ts
```

**Always-on, drop it where Pi auto-discovers extensions** (`~/.pi/agent/extensions/`,
`.pi/extensions/`, or a `settings.json` extension source):

```sh
git clone https://github.com/fl4p/pi-bash-background.git
ln -s "$PWD/pi-bash-background/src/index.ts" ~/.pi/agent/extensions/bash-background.ts
```

No build step or dependencies to install — `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-ai` come from the Pi runtime that loads the extension.

## How it works

- **Detached spawn.** `spawn(shell, ["-c", command], { detached: true })` so the child leads
  its own process group; `background_stop` tree-kills via `process.kill(-pid, …)`
  (SIGTERM → SIGKILL backstop).
- **Wake.** On exit (or, for `monitor`, on a flush interval) the extension calls
  `pi.sendUserMessage(...)` — the **session-bound `pi` handle, not a captured execute-ctx**,
  so the wake follows the active session instead of throwing on a stale ctx after a
  fork/reload. Delivery is `followUp` while the agent is streaming (never truncates an
  in-flight turn) and a plain send when idle.
- **Dedup.** A one-shot `done` guard collapses a child's `error` + `exit` into a single wake.
- **`monitor` coalescing.** New lines accumulate and flush every ~1.5s as one batch, capped
  per batch (~8 KB) so a chatty process can't flood a turn; the full stream is always in the
  logfile.

## Limitations (v1)

- **No cross-fork ownership / persistence.** A job that outlives a session fork will wake
  whatever session is active; jobs don't survive a process restart. (The
  [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) `result-watcher` /
  `stale-run-reconciler` machinery is the reference if you need that.)
- **Unix-only process-group kill.** `process.kill(-pid)` assumes POSIX process groups.
- **Keep-alive in headless mode** (`pi -p` / RPC) is unverified; the interactive TUI keeps the
  process alive while a job runs.

## Prior art

- [`ogulcancelik/pi-extensions` → `pi-tmux`](https://github.com/ogulcancelik/pi-extensions) —
  Pi's officially-recommended tmux-pane approach to backgrounding (poll/read, no auto-wake).
- [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents) — full async-job
  tracking + wake-on-completion, scoped to subagent runs rather than arbitrary bash.

## License

MIT © Fabian
