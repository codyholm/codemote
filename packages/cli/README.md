# Codemote

Control AI coding agents from your phone. Start Claude Code, Codex, OpenCode, or Gemini sessions and watch them work in real time.

## Quick Start

```bash
npx codemote
```

Leave it running — it starts a local server your phone connects to.

Scan the QR code with your iPhone camera or open the Codemote app and enter the PIN. That's it.

## Background Service

Pair the phone during an interactive `npx codemote` run first. To keep Codemote running without an open terminal, install the CLI persistently and register the platform service:

```bash
npm install -g codemote
codemote service install
codemote service start
codemote service status
codemote service logs
```

An ephemeral `npx` installation cannot be registered as a background service. Codemote uses a user LaunchAgent on macOS, a user systemd unit on Linux, and Task Scheduler on Windows. Commands are also available for `stop` and `uninstall`.

## How It Works

1. **Run `npx codemote`** in your terminal — a QR code and PIN appear
2. **Pair your phone** — scan the QR code or enter the PIN in the Codemote iOS app
3. **Pick a project** — browse directories on your machine from the app
4. **Start a session** — choose an AI agent, type a prompt, and watch it work
5. **Stay in the loop** — stream output in real time, send follow-ups, manage sessions on the go

Everything runs on your machine. In the default LAN mode, your phone connects directly to your machine (no third-party relay).

## Requirements

- **Node.js 22+**
- **At least one AI coding agent** installed on your machine:
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code) ·
  [Codex](https://github.com/openai/codex) ·
  [OpenCode](https://github.com/anomalyco/opencode) ·
  [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- **Codemote iOS app** — TestFlight access is provided directly to invited testers

## Configuration

Works out of the box. These environment variables are available if needed:

| Variable             | Default           | Description                             |
| -------------------- | ----------------- | --------------------------------------- |
| `PORT`               | `8080`            | Server port                             |
| `CODEMOTE_START_DIR` | Current directory | Starting directory for project browsing |

## Security

- TLS encrypted by default (self-signed cert, generated locally)
- Pairing requires a 6-digit PIN shown only in your terminal
- In LAN mode your phone connects directly to your machine and traffic stays on your local network, with no external server involved

## Source availability

Copyright © 2026 Codemote. All rights reserved.
No license is granted to copy, modify, distribute, sublicense, publish, or create derivative works from this code or other repository contents.
