# Pairing + Trusted Devices (Implementation Notes)

This document describes the **shipped** pairing and resume path for the local Codemote server (`npx codemote`) in the `0.7.4` baseline.

## Where pairing happens

Server-side pairing/trust is implemented in the relay inside `@codemote/server`:

- Pairing code issuance + consume: `packages/server/src/relay/services/codes.ts` (`PairingCodeService`)
- WebSocket protocol + rate limiting: `packages/server/src/relay/routes/ws.ts`
- Trusted device persistence (resume without PIN): `packages/server/src/relay/services/trusted-pairings.ts`

The CLI composes the local server and runs the bridge:

- Local server composition: `packages/cli/src/server.ts`
- CLI entry point: `packages/cli/src/cli.ts`
- Bridge (protocol translation): `packages/cli/src/bridge.ts`

## High-level flow (local LAN)

1. CLI starts relay + uplink and the bridge registers an uplink “device” with the relay.
2. Relay issues a 6-digit PIN tied to that uplink device (`PairingCodeService.create`).
3. iOS connects over WSS and pins the relay identity (TLS pin delivered out-of-band via QR deep link).
4. iOS sends `pair` with `{ pin, deviceId }` (legacy alias: `pairingCode`).
5. Relay rate-limits pairing attempts, consumes the PIN, joins mobile + uplink into the same room, and records trusted pairing.
6. On later reconnects, iOS can send `resume` with `{ uplinkDeviceId, deviceId }` without re-entering the PIN.

## Trusted pairings store

Defaults:

- Path: `~/.codemote/trusted-pairings.json`
- Format: `{ version, updatedAt, records: [...] }`

Configuration:

- Disable persistence: `CODEMOTE_TRUSTED_PAIRINGS=0` (or `false`)
- Override path: `CODEMOTE_PAIRING_STORE_PATH=/path/to/trusted-pairings.json`

Behavior:

- In-memory index for fast resume checks.
- Atomic write via `*.tmp` + rename.
- File permissions: `0600` (file) and `0700` (parent directory).
- Corrupt-file recovery: renamed to `*.corrupt-<timestamp>` and replaced with a fresh store.

## Pairing rate limiting

Relay rate limiting lives in `packages/server/src/relay/routes/ws.ts`:

- `register`: burst limiter (default 20/min per client IP)
- `pair`: exponential backoff + lockout (default: 1s/2s/4s/8s backoff, lockout after 5 failed attempts for 60s)

These limits are enforced server-side so mobile clients stay simple.

## Legacy / utility code (not the shipped path)

`packages/cli/src/pairing.ts` includes standalone PIN generation (`generatePIN`) + `RateLimiter` utilities and tests.
It’s used for examples and as a library export, but the **active** pairing flow is relay-issued PINs + relay-side rate limiting.
