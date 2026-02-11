# Codemote

Control AI coding agents from your phone. Start Claude Code, Codex, OpenCode, or Gemini sessions and watch them work in real time.

## Quick Start

```bash
npx codemote
```

Scan the QR code with your iPhone camera or open the Codemote app and enter the PIN. That's it.

## How It Works

1. **Run `npx codemote`** in your terminal — a QR code and PIN appear
2. **Pair your phone** — scan the QR code or enter the PIN in the Codemote iOS app
3. **Pick a project** — browse directories on your machine from the app
4. **Start a session** — choose an AI agent, type a prompt, and watch it work
5. **Stay in the loop** — stream output in real time, send follow-ups, manage sessions on the go

Everything runs on your machine. Your phone connects directly over your local network — no data leaves your computer.

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

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Server port |
| `CODEMOTE_START_DIR` | Current directory | Starting directory for project browsing |

## Security

- TLS encrypted by default (self-signed cert, generated locally)
- Pairing requires a 6-digit PIN shown only in your terminal
- In LAN mode your phone connects directly to your machine and traffic stays on your local network, with no external server involved

## License

MIT
