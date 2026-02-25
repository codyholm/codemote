# Local Server (CLI)

This package is the composition root for the **local** Codemote experience (`npx codemote`).

It runs a single Node.js process that starts:

- Relay server (`@codemote/server` → `createRelayServer`) — pairing + message routing
- Uplink server (`@codemote/server` → `UplinkServer`) — sessions/workspaces + runtime executors
- Bridge (`packages/cli/src/bridge.ts`) — connects an uplink “device” to the relay and translates:
  - mobile JSON protocol ↔ uplink command/response
  - uplink `StreamEvent` → mobile payloads
  - endpoint hints (e.g. Tailscale)

Important: this is a local server process. If it isn’t running, your phone can’t connect.

- **If you close the terminal or stop the process, the session ends.**
- To keep it running without watching a terminal, run it under `tmux`/`screen`/a process manager (or ship a menubar app/service — roadmap).

For the connection architecture roadmap (LAN → Tailscale → hosted relay), see `docs/connection-architecture.md`.

## Run

```bash
# End-user
npx codemote

# From repo root
pnpm -C packages/cli start

# With debug logs
GUILD_REMOTE_DEBUG=1 pnpm -C packages/cli start
```

## What You See

- A QR code for pairing (deep link)
- A 6-digit PIN (same value used by pairing)
- Status updates (connected / paired)

## Pairing + Trust

Local relay uses **WSS** with a self-signed certificate generated under `~/.codemote/tls/`.

- QR deep link includes:
  - `relay` (wss URL)
  - `pin`
  - `tlsPin` (certificate fingerprint)

This allows iOS to pin the relay identity without manual URL entry.

Security reference: `docs/security-architecture.md`.

## Ports

The CLI uses two consecutive ports:

- Port `N`: relay (mobile connects here)
- Port `N+1`: uplink (loopback only; bridge connects here)

Default: `8080` and `8081`.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Relay port (default 8080) |
| `CODEMOTE_START_DIR` | Workspace browsing root (default: cwd) |
| `CODEMOTE_REPO_PATH` | Alias of `CODEMOTE_START_DIR` (back-compat) |
| `CODEMOTE_TRUSTED_PAIRINGS` | Set to `0`/`false` to disable trusted pairing persistence |
| `CODEMOTE_PAIRING_STORE_PATH` | Override trusted pairings JSON path |
| `GUILD_REMOTE_DEBUG` | Enable verbose bridge logging |
| `GUILD_REMOTE_DISABLE_TLS` | Dev-only: disable TLS (requires `GUILD_REMOTE_ALLOW_INSECURE=1`) |
| `GUILD_REMOTE_ALLOW_INSECURE` | Explicit opt-in to allow insecure mode |

## Source Map

| File | Responsibility |
|------|----------------|
| `packages/cli/src/cli.ts` | CLI entry point (`npx codemote`) |
| `packages/cli/src/server.ts` | Starts relay + uplink + bridge |
| `packages/cli/src/bridge.ts` | Uplink “device” registration + protocol translation |
| `packages/cli/src/tls.ts` | Self-signed TLS cert generation |
| `packages/cli/src/mdns.ts` | Bonjour advertisement (no secrets) |
| `packages/cli/src/qrcode.ts` | Deep link creation + QR rendering |

## Notes

- App-layer E2E encryption is not wired in the `0.7.x` baseline; payloads are plaintext JSON over WSS.
- Hosted relay mode is planned but not shipped; see `docs/connection-architecture.md`.
