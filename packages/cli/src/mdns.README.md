# mDNS Service Advertisement

The `mdns` module provides Bonjour/mDNS service advertisement for Codemote, enabling iOS apps to discover the service on the local network.

## Overview

This module uses a platform-aware strategy pattern to advertise the Codemote service as `_codemote._tcp.local`. On macOS, it delegates to the OS's native `mDNSResponder` via `dns-sd -R`, avoiding UDP socket conflicts and hostname collisions. On Linux and Windows, it uses the `bonjour-service` npm package. The `createAdvertiser()` factory selects the right implementation automatically.

## Quick Start

```typescript
import { createAdvertiser } from "codemote";

const advertiser = createAdvertiser();
advertiser.advertise({ port: 8080, pin: "123456" });

// destroy() is async — await it for clean goodbye packets
process.on("SIGINT", async () => {
	await advertiser.destroy();
	process.exit(0);
});
```

## API Reference

### `MDNSAdvertiser` (interface)

Strategy interface implemented by platform-specific advertisers.

#### Methods

##### `advertise(config: ServiceConfig): void`

Starts advertising the Codemote service on the local network.

```typescript
const advertiser = createAdvertiser();
advertiser.advertise({
  port: 3000,
  pin: "123456",
  version: "1"  // optional, defaults to "1"
});
```

##### `updatePairingCode(newPairingCode: string): void`

Updates the pairing token associated with the advertiser.

Security note: the pairing token is not published in TXT records; updating it is for internal bookkeeping
and any future extensions (not for discovery).

```typescript
advertiser.updatePairingCode("654321");
```

##### `stop(): void`

Stops advertising the service but keeps the underlying instance alive.

```typescript
advertiser.stop();
```

##### `destroy(): Promise<void>`

Stops advertising and releases all resources. Call this when completely shutting down.

```typescript
await advertiser.destroy();
```

##### `isAdvertising(): boolean`

Returns `true` if the service is currently advertising.

```typescript
if (advertiser.isAdvertising()) {
  console.log("Service is live");
}
```

##### `getConfig(): ServiceConfig | null`

Returns a copy of the current service configuration, or `null` if not advertising.

```typescript
const config = advertiser.getConfig();
console.log(`Port: ${config?.port}, PIN: ${config?.pin}`);
```

### `createAdvertiser(): MDNSAdvertiser`

Factory function that returns a platform-appropriate advertiser:

- **macOS**: `DnsSdAdvertiser` (delegates to mDNSResponder via `dns-sd -R`)
- **Linux/Windows**: `BonjourAdvertiser` (uses `bonjour-service` npm package)

```typescript
const advertiser = createAdvertiser();
```

### `advertiseService(port, pin)` (deprecated)

Convenience function that creates an advertiser and immediately starts advertising. Use `createAdvertiser()` instead.

```typescript
// Deprecated — prefer createAdvertiser()
const advertiser = advertiseService(3000, "123456");
```

### Implementations

#### `BonjourAdvertiser`

Uses the `bonjour-service` npm package. Runs its own mDNS responder on UDP port 5353. `destroy()` waits for goodbye packets (TTL=0) before closing the socket.

#### `DnsSdAdvertiser`

macOS-only. Spawns `dns-sd -R` as a child process to register the service with the OS mDNSResponder. Goodbye packets are sent automatically when the process is killed — no manual teardown delay needed. Uses `scutil --get ComputerName` for stable service naming (unaffected by mDNS hostname collisions).

### Types

#### `ServiceConfig`

```typescript
interface ServiceConfig {
	port: number; // Port where the service is listening
	pin: string; // Pairing token (NOT broadcast via TXT)
	pairingCode?: string; // Back-compat alias
	version?: string; // Protocol version (default: "1")
}
```

## Platform Behavior

**macOS**: Uses the system mDNSResponder via `dns-sd -R`. No UDP socket conflicts, no hostname collisions (the `LocalHostName rename` popup). Service names use `ComputerName` from `scutil` for stability.

**Linux**: Uses `bonjour-service`. Typically no mDNS conflicts because Avahi (the common Linux mDNS implementation) uses a different socket model.

**Windows**: Uses `bonjour-service`. Windows mDNS is passive — no conflict with the npm package's responder.

## Service Discovery

The advertised service includes endpoint metadata only:

- **Service Type**: `_codemote._tcp.local`
- **Service Name**: `Codemote on <hostname>`
- **Port**: the configured port
- **TXT Records**:
  - `version`
  - `hostname`
  - `port`

The pairing PIN is intentionally NOT included in TXT records.

### iOS Discovery Example

```swift
import Network

let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_codemote._tcp", domain: nil), using: .tcp)

browser.browseResultsChangedHandler = { results, changes in
    for result in results {
        switch result.endpoint {
        case .service(let name, let type, let domain, let interface):
            print("Found: \(name)")
            // Access TXT records for PIN, version, etc.
        default:
            break
        }
    }
}

browser.start(queue: .main)
```

## Integration with PIN rotation

If you rotate the pairing token, you can keep local discovery stable while updating the UI/QR.
This example shows a simple timer-based rotation:

```typescript
import { createAdvertiser, generatePIN } from "codemote";

const advertiser = createAdvertiser();
let currentPIN = generatePIN();

advertiser.advertise({
  port: 3000,
  pin: currentPIN,
});

const interval = setInterval(() => {
  currentPIN = generatePIN();
  console.log(`PIN rotated to: ${currentPIN}`);
  if (advertiser.isAdvertising()) {
    advertiser.updatePairingCode(currentPIN);
  }
}, 15 * 60 * 1000);

// Clean up on shutdown
process.on("SIGINT", async () => {
  clearInterval(interval);
  await advertiser.destroy();
  process.exit(0);
});
```

## Error Handling

The `updatePairingCode` method will throw an error if called when not advertising:

```typescript
try {
  advertiser.updatePairingCode("123456");
} catch (error) {
  console.error("Cannot update pairing code:", error.message);
  // "Cannot update pairing code: service is not currently advertising"
}
```

## Network Behavior

- The service is advertised on **all network interfaces**
- Discovery is limited to the **local network** (link-local)
- The service automatically handles IP address changes
- Multiple instances can run on the same machine (different ports)

## Testing

Run the test suite:

```bash
pnpm test src/mdns.test.ts
```

Run the example:

```bash
tsx src/mdns.example.ts
```

## Best Practices

1. **Always clean up**: Call `await destroy()` when shutting down to release network resources
2. **Do not advertise secrets**: keep the PIN out of mDNS TXT records
3. **Handle errors**: Wrap `updatePairingCode` in try-catch blocks
4. **Single instance**: Only create one advertiser per port to avoid conflicts
5. **Unique ports**: Use different ports for multiple services on the same machine

## Troubleshooting

### Service not discoverable

- Check firewall settings (mDNS uses UDP port 5353)
- Ensure devices are on the same network
- Verify the service is advertising with `isAdvertising()`
- Check for port conflicts

### PIN updates not reflecting

- Ensure you're calling `updatePairingCode()` on the correct instance
- Verify the service is advertising before updating
- iOS apps may cache TXT records briefly

### Multiple advertisers

```typescript
// Good: Different ports
const a1 = createAdvertiser();
a1.advertise({ port: 3000, pin: "123456" });

const a2 = createAdvertiser();
a2.advertise({ port: 3001, pin: "654321" });

// Bad: Same port will cause issues
const a3 = createAdvertiser();
a3.advertise({ port: 3000, pin: "111111" }); // Conflict with a1!
```
