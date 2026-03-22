# agent

A local multi-channel AI agent gateway that receives messages, keeps per-session context, and exposes the agent through HTTP, Telegram, and a local CLI.

## What it does

This repository runs a provider-backed agent as a long-lived local service. It provides:

- **HTTP channel** for local apps to send messages and receive streamed replies
- **Telegram channel** for chatting with the agent through a bot
- **Session and pairing flow** keyed by channel + chat ID
- **Built-in tools** such as shell execution, sub-agents, cron jobs, file sending, local image read, and headless GUI actions
- **Supporting services** for heartbeat reports, scheduling, transcription, and attachment storage
- **Workspace bootstrapping** under `~/.agent/` for config, memory, heartbeat, and cron data

This is best described as a personal agent runtime / gateway rather than a general-purpose SDK.

## Stack

- Node.js + TypeScript
- tsx
- yargs
- OpenAI, OpenRouter + Vercel AI SDK
- Telegraf
- zod
- jsonc-parser
- consola
- pnpm

## Repository layout

- `src/`
  - `main.ts`: CLI entrypoint
  - `services/`: gateway, heartbeat, cron, transcription, sub-agent dispatch, CLI client
  - `channels/`: HTTP and Telegram channel implementations
  - `bus/`: message routing, session locking, and attachment delivery
  - `core/`: agent logic, context handling, prompts, and tool definitions
  - `utils/`: config loading, logging, workspace bootstrap, pairing, and service helpers
- `templates/`
  - default files copied into `~/.agent/` on first run
  - includes `config.jsonc`, `workspace/crons.json`, `workspace/HEARTBEAT.md`, and `workspace/memory/MEMORY.md`
- `dist/`
  - TypeScript build output

## Getting started

### Install dependencies

```bash
pnpm install
```

### Prepare config

On startup, the app copies missing files from `templates/` into `~/.agent/`.
For first-time setup, run:

```bash
pnpm start -- bootstrap
```

Main config file:

```bash
~/.agent/config.jsonc
```

You will typically need to fill in:

- `providers[].apiKey`
- `channels.telegram.token` if Telegram is enabled
- `heartbeat.reportSession` if you want something other than the first approved Telegram chat
- `cron.reportSession` if you want something other than the first approved Telegram chat

The default template also includes:

- HTTP listening on `127.0.0.1:8100`
- agent model `openai/gpt-5.4`
- transcription model `openai/gpt-4o-mini-transcribe`

OpenRouter is also supported. Example:

- `agent.model`: `openrouter/anthropic/claude-sonnet-4`
- `heartbeat.model`: `openrouter/anthropic/claude-sonnet-4`
- add provider entry: `{ "name": "openrouter", "apiKey": "sk-or-..." }`

### Run in development

```bash
pnpm dev
```

This runs:

```bash
tsx watch src/main.ts gateway
```

To call a specific subcommand directly:

```bash
pnpm start -- gateway run
```

### Build

```bash
pnpm build
```

### Type-check

```bash
pnpm check
```

## CLI commands

Current commands exposed by `src/main.ts`:

```bash
agent gateway run
agent gateway install
agent gateway start
agent gateway stop
agent gateway restart
agent gateway uninstall
agent gateway status
agent gui doctor
agent gui start --id default
agent gui screenshot --id default
agent gui exec --id default -- xmessage "hello"
agent update
agent bootstrap
agent pair <code>
agent cli --url http://127.0.0.1:8100
```

Notes:

- `gateway run`: run the gateway in the foreground
- `bootstrap`: interactively write `~/.agent/config.jsonc`
- `gateway install/start/stop/...`: manage the installed user service
- `gui`: manage headless Linux GUI sessions with Xvfb, screenshots, and DISPLAY-scoped command execution
- `update`: fetch from git, fast-forward pull when available, optionally refresh dependencies, and restart the installed gateway service
- `pair <code>`: approve a pending pairing code
- `cli`: open a local CLI session that talks to the HTTP gateway

### Headless GUI capability

The gateway now includes GUI-oriented tools and CLI helpers aimed at Linux headless servers:

- `gui_session`: start, stop, inspect, list, and doctor Xvfb-backed sessions
- `gui_screenshot`: capture the current root-window screenshot and feed the image back to the model
- `gui_input`: move/click mouse, type text, press keys, and emit scroll events with `xdotool`
- `gui_shell`: launch programs inside a running GUI session with `DISPLAY` preconfigured

Runtime prerequisites currently expected on the host:

- `Xvfb`
- `xdotool`
- ImageMagick `import`
- `xrandr`

Example:

```bash
pnpm start -- gui doctor
pnpm start -- gui start --id demo --width 1280 --height 800
pnpm start -- gui exec --id demo -- xmessage "GUI session is live"
pnpm start -- gui screenshot --id demo --label initial
pnpm start -- gui stop --id demo
```

Notes:

- sessions persist metadata under `~/.agent/workspace/gui/`
- set `AGENT_GUI_ROOT=/some/path` to override the GUI state directory, which is useful in restricted or sandboxed environments
- the default implementation starts a bare X11 display via `Xvfb`; a full desktop session or window manager is optional and can be launched through `gui exec` or `gui_session start` with `command`
- scrolling is synthesized through X11 wheel button events, so it is step-based rather than pixel-perfect

### Auto-update

The gateway can auto-check for updates from Git and restart the installed service after a successful fast-forward pull.

Set this in `~/.agent/config.jsonc`:

```jsonc
"updater": {
  "enabled": true,
  "interval": "300",
  "remote": "origin",
  "branch": "main",
  "installDependencies": true,
  "restartOnUpdate": true
}
```

Notes:

- updates are skipped if the repo worktree is dirty
- only fast-forward updates are applied
- if `package.json` or `pnpm-lock.yaml` changed, the updater runs `pnpm install --frozen-lockfile`
- automatic restart only applies to the installed gateway service

Manual update commands:

```bash
agent update --check-only
agent update
```

## Runtime flow

At a high level, startup looks like this:

1. `bootstrapWorkspace()` initializes `~/.agent/`
2. `~/.agent/config.jsonc` is loaded and validated
3. the `Agent` is created
4. HTTP and Telegram channels are registered
5. cron, heartbeat, and the message bus are started
6. messages are routed through the bus to the agent, and streamed results are sent back to the originating channel

## Notes

- `dist/` is committed, so the project is often used in compiled JavaScript form
- the `dev` and `start` scripts are slightly different from the yargs subcommand structure; when in doubt, follow the commands defined in `src/main.ts`
