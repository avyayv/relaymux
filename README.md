# agentmux

`agentmux` runs multiple coding agents in tmux and keeps them organized.

Use it when you want three agents reviewing the same repo, a separate agent doing implementation, and a final agent collecting the results without losing track of which terminal belongs to which run.

It is local-first and repo-agnostic:

- launches agent commands in tmux windows
- passes a repo or worktree as the working directory
- stores run metadata and completion events locally
- lets agents report progress with `agentmux notify`
- supports optional command or webhook notifications, disabled by default

There is no durable loop runner in this package. It only launches, tracks, and reports local tmux-backed agent runs.

## Install

```bash
npm install -g agentmux
```

For local development:

```bash
npm install
npm link
agentmux doctor
```

## Quick Start

Create the config:

```bash
agentmux init
```

Launch an agent:

```bash
agentmux launch \
  --repo ~/code/my-app \
  --agent codex \
  --name review-api \
  --prompt "Review the API layer for correctness bugs. Send a short summary with agentmux notify."
```

Check status:

```bash
agentmux status
```

Attach to the tmux session:

```bash
tmux attach -t agents
```

## Config

The default config path is:

```text
~/.config/agentmux/config.json
```

`agentmux init` writes a starter config like this:

```json
{
  "version": 1,
  "session": "agents",
  "stateDir": "~/.local/state/agentmux",
  "holdOnExit": false,
  "agents": {
    "pi": {
      "command": ["pi", "{prompt}"],
      "promptMode": "arg"
    },
    "codex": {
      "command": ["codex", "--model", "gpt-5.5", "--reasoning-effort", "xhigh", "{prompt}"],
      "promptMode": "arg"
    },
    "claude": {
      "command": ["claude", "{prompt}"],
      "promptMode": "arg"
    }
  },
  "notifier": {
    "command": {
      "enabled": false,
      "argv": []
    },
    "webhook": {
      "enabled": false,
      "url": "",
      "headers": {}
    }
  }
}
```

Agent commands are argv arrays, not shell strings. `agentmux` renders placeholders and shell-quotes every argv token before handing the wrapper command to tmux.

Supported placeholders:

- `{prompt}`: prompt text
- `{promptFile}`: path to a local prompt file
- `{repo}`: original repo path
- `{workdir}`: repo or worktree path used as the tmux working directory
- `{name}`: run name
- `{runId}`: run id
- `{agent}`: agent name

Prompt modes:

- `arg`: append the prompt as an argument when no prompt placeholder is present
- `stdin`: redirect the prompt file into the agent command
- `env`: expose the prompt as `AGENTMUX_PROMPT`
- `none`: do not pass the prompt automatically

## Commands

### `agentmux init`

Creates the config file.

```bash
agentmux init
agentmux init --force
agentmux init --config ./agentmux.config.json
```

### `agentmux launch`

Starts an agent in a tmux window.

```bash
agentmux launch \
  --repo ~/code/my-app \
  --agent codex \
  --prompt-file ./prompts/review.md \
  --name review-api
```

Useful options:

- `--session <name>`: override the tmux session name
- `--dry-run`: print the tmux command without launching it
- `--print-command`: print the tmux command before launching
- `--hold`: keep a shell open after the agent exits
- `--attach`: print the tmux attach command after launch

### `agentmux status`

Lists runs launched by `agentmux`, their tmux targets, and the latest local event.

```bash
agentmux status
agentmux status --json
agentmux status --all
```

### `agentmux notify`

Records a local event for a run. Agent prompts can ask subagents to call this directly.

```bash
agentmux notify \
  --run-id "$AGENTMUX_RUN_ID" \
  --event summary \
  --message "Found two likely API validation bugs."
```

The tmux wrapper automatically records `started` and `completed` events.

### `agentmux doctor`

Checks tmux, config, and whether configured agent executables are on `PATH`.

```bash
agentmux doctor
```

Missing agents do not fail `doctor`; one machine might only have `codex`, while another only has `claude`.

## Worktrees

Worktree support is generic and opt-in. `agentmux` does not assume a repo layout, branch naming scheme, or worktree directory.

Launch from an existing worktree:

```bash
agentmux launch \
  --repo ~/code/my-app \
  --worktree ~/code/my-app-review-api \
  --agent codex \
  --name review-api \
  --prompt-file ./prompts/review-api.md
```

Create a worktree before launch:

```bash
agentmux launch \
  --repo ~/code/my-app \
  --worktree ~/code/my-app-review-ui \
  --create-worktree \
  --worktree-branch agentmux/review-ui \
  --worktree-from main \
  --agent codex \
  --name review-ui \
  --prompt-file ./prompts/review-ui.md
```

## Example: Three Review Agents And A Fan-In Agent

Create focused prompts:

```bash
mkdir -p prompts
$EDITOR prompts/review-api.md
$EDITOR prompts/review-ui.md
$EDITOR prompts/review-tests.md
$EDITOR prompts/fan-in.md
```

Launch three review agents:

```bash
agentmux launch --repo ~/code/my-app --agent codex --name review-api --prompt-file prompts/review-api.md
agentmux launch --repo ~/code/my-app --agent codex --name review-ui --prompt-file prompts/review-ui.md
agentmux launch --repo ~/code/my-app --agent codex --name review-tests --prompt-file prompts/review-tests.md
```

In each prompt, ask the agent to finish with:

```bash
agentmux notify --run-id "$AGENTMUX_RUN_ID" --event summary --message "<one-paragraph summary>"
```

Then launch a fan-in agent:

```bash
agentmux launch \
  --repo ~/code/my-app \
  --agent codex \
  --name fan-in \
  --prompt-file prompts/fan-in.md
```

The fan-in prompt can ask the agent to inspect:

```bash
agentmux status --json
```

## Optional Notifications

Notifications are disabled by default. They are intentionally generic.

Command notifier:

```json
{
  "notifier": {
    "command": {
      "enabled": true,
      "argv": ["terminal-notifier", "-title", "agentmux", "-message", "{name}: {event} {message}"]
    }
  }
}
```

Webhook notifier:

```json
{
  "notifier": {
    "webhook": {
      "enabled": true,
      "url": "https://example.com/agentmux-events",
      "headers": {
        "authorization": "Bearer replace-me"
      }
    }
  }
}
```

Do not put secrets in a shared config file. Prefer local config files, environment-specific wrappers, or a secret manager for real tokens.

## Local State

By default, local state is written to:

```text
~/.local/state/agentmux/
```

Files:

- `runs.jsonl`: one record per launched run
- `events.jsonl`: `notify`, `started`, and `completed` events
- `prompts/`: prompt snapshots used by launched runs

## Safety Notes

- Agent commands are configured as argv arrays.
- `agentmux` does not use `eval` on config.
- The final tmux wrapper is a shell command because tmux accepts a shell command string; argv tokens are quoted before insertion.
- Use `--dry-run` or `--print-command` to inspect what will run.
- Notifier command integration also uses argv arrays, not shell strings.

## Development

```bash
npm install
npm run validate
```

The test suite covers argument parsing, config loading, template rendering, prompt passing, and shell quoting.
