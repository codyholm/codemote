# Local Server (CLI)

This package is the composition root for the **local** Codemote experience.

It starts (in one process):

- Relay server (`@codemote/relay`) — pairing + message routing
- Uplink server (`@codemote/uplink`) — spawns/streams Claude/OpenCode/Codex
- Bridge (`packages/cli/src/bridge.ts`) — E2E encryption + protocol translation

For the connection architecture roadmap (local → tailscale → hosted relay), see `docs/connection-architecture.md`.

## Run

```bash
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
| `GUILD_REMOTE_DEBUG` | Enable verbose bridge logging |
| `GUILD_REMOTE_DISABLE_TLS` | Dev-only: disable TLS (requires `GUILD_REMOTE_ALLOW_INSECURE=1`) |
| `GUILD_REMOTE_ALLOW_INSECURE` | Explicit opt-in to allow insecure mode |

## Source Map

| File | Responsibility |
|------|----------------|
| `packages/cli/src/server.ts` | Starts relay + uplink + bridge |
| `packages/cli/src/bridge.ts` | Uplink “device” registration + E2E encryption |
| `packages/cli/src/tls.ts` | Self-signed TLS cert generation |
| `packages/cli/src/mdns.ts` | Bonjour advertisement (no secrets) |
| `packages/cli/src/qrcode.ts` | Deep link creation + QR rendering |

## Roadmap Note (server consolidation)

Happy’s repo shape is a single “server” with internal modules.
We plan to move the local server composition out of `packages/cli` into a dedicated package:

- `packages/server` (new): local server runtime
- `packages/cli`: thin terminal UI wrapper

This keeps deployable hosted relay (`packages/relay`) separate from the local runtime.
