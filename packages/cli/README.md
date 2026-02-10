# Codemote

Control AI coding agents from your phone. Start Claude Code, OpenCode, Codex, or Gemini sessions from an iOS app and watch them work in real time.

## Quick Start

```bash
npx codemote
```

This starts a local server, displays a QR code and PIN, and waits for the Codemote iOS app to connect.

## How It Works

1. Run `npx codemote` in your project directory
2. Scan the QR code with your iPhone camera, or open the Codemote app and enter the PIN
3. Once paired, start AI coding sessions from your phone
4. Watch output stream in real time, send follow-up prompts, and manage sessions remotely

Codemote runs entirely on your machine. No data leaves your network. The phone connects directly to your computer over your local network.

## Requirements

- Node.js 20 or later
- One or more AI coding agents installed: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenCode](https://github.com/anomalyco/opencode), [Codex](https://github.com/openai/codex), or [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- Codemote iOS app (available on TestFlight)

## Configuration

Codemote works out of the box with zero configuration. These environment variables are available for advanced use:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Server port |
| `CODEMOTE_REPO_PATH` | Current directory | Working directory for sessions |
| `CLAUDE_PATH` | `claude` | Path to Claude Code executable |
| `CODEX_PATH` | `codex` | Path to Codex executable |
| `GEMINI_PATH` | `gemini` | Path to Gemini CLI executable |

## Security

- All connections use TLS by default (self-signed certificate, generated locally)
- Pairing requires a 6-digit PIN displayed only on your terminal
- No data is sent to external servers. Everything runs locally.
- The relay, uplink, and bridge all run in a single process on your machine

## License

MIT
