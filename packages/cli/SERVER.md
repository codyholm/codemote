# Server Integration

Combined relay + uplink server for Guild Remote.

## Overview

The server integration bundles the relay server and uplink service into a single process, providing:

- **Unified Process**: Both relay and uplink run together
- **PIN-based Pairing**: 6-digit numeric PINs that auto-regenerate
- **Rate Limiting**: Protection against brute-force pairing attempts
- **Lifecycle Management**: Clean startup/shutdown with graceful handling

## Architecture

```
┌─────────────────────────────────────────┐
│         Combined Server Process         │
├─────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐  │
│  │ Relay Server │    │    Uplink    │  │
│  │   (WS API)   │◄──►│   Service    │  │
│  └──────────────┘    └──────────────┘  │
│         ▲                                │
│         │ WebSocket                     │
│  ┌──────┴────────┐                      │
│  │ PIN Manager   │                      │
│  │ Rate Limiter  │                      │
│  └───────────────┘                      │
└─────────────────────────────────────────┘
         ▲
         │ Mobile connects via PIN
         │
    📱 Mobile App
```

## Quick Start

```typescript
import { startServer } from "./server.js";

const server = await startServer({
  port: 8080,
  onPINRegenerate: (pin) => console.log(`New PIN: ${pin}`),
  onClientConnected: () => console.log("Client connected!"),
});

// Use `server.pin` for UI/QR display. Avoid printing it to stdout logs.
console.log(`WebSocket URL: ${server.url}`);

// Later...
await server.stop();
```

## API Reference

### `startServer(config: ServerConfig): Promise<ServerHandle>`

Start a combined relay + uplink server.

#### ServerConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | `number` | *required* | Port for relay server |
| `onPINRegenerate` | `(pin: string) => void` | `undefined` | Callback when PIN regenerates |
| `onClientConnected` | `() => void` | `undefined` | Callback when client connects |
| `dbPath` | `string` | `undefined` | Path to SQLite database |
| `repoPath` | `string` | `process.cwd()` | Repository path for uplink |
| `runtimes` | `RuntimeType[]` | `["opencode"]` | Runtime types to enable |

#### ServerHandle

| Property | Type | Description |
|----------|------|-------------|
| `pin` | `string` | Current 6-digit pairing PIN |
| `url` | `string` | WebSocket URL for clients |
| `stop()` | `() => Promise<void>` | Stop the server gracefully |
| `getStats()` | `() => Promise<RelayStats>` | Get relay statistics |
| `regeneratePIN()` | `() => void` | Force PIN regeneration |
| `validatePIN()` | `(pin, ip) => Promise<Result>` | Validate a PIN attempt |

## Features

### PIN Management

PINs are 6-digit numeric codes (000000-999999) that:

- Auto-regenerate every 5 minutes
- Are validated with rate limiting
- Trigger callbacks on regeneration
- Can be manually regenerated

```typescript
const server = await startServer({
  port: 8080,
  onPINRegenerate: (pin) => {
    console.log(`New PIN: ${pin}`);
    // Update UI, send notification, etc.
  },
});

// Current PIN
console.log(server.pin); // "123456"

// Force regeneration
server.regeneratePIN();
console.log(server.pin); // "789012"
```

### Rate Limiting

Prevents brute-force attacks on PIN pairing:

- **Max Attempts**: 5 failed attempts per IP
- **Time Window**: 60 seconds
- **Backoff**: Exponential delays (1s, 2s, 4s, 8s, 16s)
- **Lockout**: 60-second lockout after max attempts

```typescript
const result = await server.validatePIN("123456", "192.168.1.100");

if (!result.allowed) {
  console.log(result.message); // "Too many attempts. Wait 2s before retrying"
  console.log(result.waitMs);  // 2000
}
```

### Statistics

Monitor relay server health and connections:

```typescript
const stats = await server.getStats();

console.log(`Rooms: ${stats.rooms}`);
console.log(`Connections: ${stats.connections}`);
console.log(`Version: ${stats.version}`);
```

### Graceful Shutdown

Clean up resources and close connections:

```typescript
// Handle Ctrl+C
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await server.stop();
  process.exit(0);
});
```

## Port Usage

The server uses two consecutive ports:

- **Port N**: Relay server (WebSocket API for mobile)
- **Port N+1**: Uplink server (internal execution service)

Example: If you specify `port: 8080`, the relay runs on 8080 and uplink on 8081.

## Runtime Configuration

Configure which AI runtimes to enable:

```typescript
const server = await startServer({
  port: 8080,
  runtimes: ["opencode", "claude", "codex"],
});
```

Available runtimes:
- `opencode` - OpenCode AI
- `claude` - Anthropic Claude
- `codex` - OpenAI Codex
- `gemini` - Google Gemini

## Current Limitations

### 1. PIN Validation Not Fully Integrated

The PIN validation logic is implemented but not yet integrated into the relay's pairing flow. Currently:

- ✅ PINs are generated and managed
- ✅ Rate limiting works
- ⚠️ Relay still uses its own alphanumeric pairing codes
- ⚠️ Mobile needs to use relay codes (not PINs) for now

**Workaround**: Use the relay's pairing codes from the `/health` endpoint.

**Fix Required**: Modify relay package to support custom validation (see Integration Notes in code).

### 2. Uplink Doesn't Auto-Connect

The uplink service starts but doesn't automatically register with the relay. This means:

- ✅ Both servers start successfully
- ✅ Mobile can connect to relay
- ⚠️ Uplink-relay connection must be established manually

**Workaround**: Use the relay's registration flow manually.

**Fix Required**: Implement automatic uplink-relay pairing with key generation.

### 3. Connection Callbacks Not Implemented

The `onClientConnected` callback is accepted but not yet invoked because:

- ⚠️ Relay doesn't expose room manager events
- ⚠️ No hook into connection lifecycle

**Fix Required**: Modify relay to emit events when clients join rooms.

## Integration Notes

To fully integrate PIN validation, the relay package needs these changes:

### 1. Support PIN Field in Pairing

```typescript
// packages/relay/src/routes/ws.ts
export interface WsMessage {
  type: "register" | "pair" | "message";
  publicKey?: string;
  deviceType?: "mobile" | "uplink";
  pairingCode?: string;  // Existing
  pin?: string;          // NEW: Alternative to pairingCode
  payload?: unknown;
}
```

### 2. Add Validation Hook

```typescript
// packages/relay/src/server.ts
export interface RelayServerConfig {
  port: number;
  host: string;
  dbPath?: string;
  // NEW: Custom PIN validator
  validatePIN?: (pin: string, clientIP: string) => Promise<boolean>;
}
```

### 3. Modify Pair Handler

```typescript
case "pair": {
  let uplinkKey: string | null = null;

  if (msg.pin && config.validatePIN) {
    const clientIP = extractIP(ws);
    const isValid = await config.validatePIN(msg.pin, clientIP);
    if (isValid) {
      uplinkKey = await findUplinkForPIN(msg.pin);
    }
  } else if (msg.pairingCode) {
    uplinkKey = codes.consume(msg.pairingCode, msg.publicKey);
  }

  // ... rest of pairing logic
}
```

### 4. Expose Room Events

```typescript
// packages/relay/src/services/rooms.ts
export class RoomManager extends EventEmitter {
  join(roomId: string, member: RoomMember): void {
    // ... existing logic
    this.emit('memberJoined', { roomId, member });
  }
}
```

## Testing

Run the test suite:

```bash
npm test -- server.test.ts
```

Tests cover:
- Server startup/shutdown
- PIN generation and validation
- Rate limiting
- Statistics
- Configuration options

## Example

See `src/server-example.ts` for a complete working example:

```bash
npx tsx src/server-example.ts
```

This starts a server with:
- QR code generation
- PIN display
- Stats monitoring
- Graceful shutdown

## Related Files

- `src/server.ts` - Main implementation
- `src/server.test.ts` - Test suite
- `src/server-example.ts` - Usage example
- `src/pairing.ts` - PIN and rate limiting logic
- `src/pairing.test.ts` - Pairing tests

## Next Steps

1. **Relay Integration**: Add PIN validation hooks to relay package
2. **Auto-Pairing**: Implement automatic uplink-relay connection
3. **Event Hooks**: Expose connection events from relay
4. **Mobile Support**: Update mobile app to support PIN-based pairing
5. **Production Ready**: Add logging, monitoring, and error recovery
