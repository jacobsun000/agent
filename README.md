# agent

A local multi-channel AI agent gateway that receives messages, keeps per-session context, and exposes the agent through HTTP, Telegram, and a local CLI.

## What it does

This repository runs an OpenAI-backed agent as a long-lived local service. It provides:

- **HTTP channel** for local apps to send messages and receive streamed replies
- **Telegram channel** for chatting with the agent through a bot
- **Session and pairing flow** keyed by channel + chat ID
- **Built-in tools** such as shell execution, sub-agents, cron jobs, and file sending
- **Supporting services** for heartbeat reports, scheduling, transcription, and attachment storage
- **Workspace bootstrapping** under `~/.agent/` for config, memory, heartbeat, and cron data

This is best described as a personal agent runtime / gateway rather than a general-purpose SDK.

## Stack

- Node.js + TypeScript
- tsx
- yargs
- OpenAI + Vercel AI SDK
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

Main config file:

```bash
~/.agent/config.jsonc
```

You will typically need to fill in:

- `providers[].apiKey`
- `channels.telegram.token` if Telegram is enabled
- `heartbeat.reportSession`
- `cron.reportSession`

The default template also includes:

- HTTP listening on `127.0.0.1:8100`
- agent model `openai/gpt-5.4`
- transcription model `openai/gpt-4o-mini-transcribe`

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
agent pair <code>
agent cli --url http://127.0.0.1:8100
```

Notes:

- `gateway run`: run the gateway in the foreground
- `gateway install/start/stop/...`: manage the installed user service
- `pair <code>`: approve a pending pairing code
- `cli`: open a local CLI session that talks to the HTTP gateway

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
