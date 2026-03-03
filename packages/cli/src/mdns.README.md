# mDNS Service Advertisement

The `mdns` module provides Bonjour/mDNS service advertisement for Codemote, enabling iOS apps to discover the service on the local network.

## Overview

This module uses the `bonjour-service` package to advertise the Codemote service as `_codemote._tcp.local`, which iOS apps can discover using the Network framework.

## Quick Start

```typescript
import { advertiseService } from "codemote";

// Start advertising on port 8080
// NOTE: the PIN is NOT advertised via mDNS TXT records.
const advertiser = advertiseService(8080, "123456");

process.on("SIGINT", () => {
	advertiser.destroy();
	process.exit(0);
});
```

## API Reference

### `MDNSAdvertiser`

The main class for managing mDNS service advertisement.

#### Methods

##### `advertise(config: ServiceConfig): void`

Starts advertising the Codemote service on the local network.

```typescript
const advertiser = new MDNSAdvertiser();
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

Stops advertising the service but keeps the Bonjour instance alive.

```typescript
advertiser.stop();
```

##### `destroy(): void`

Stops advertising and destroys the Bonjour instance. Call this when completely shutting down.

```typescript
advertiser.destroy();
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

### `advertiseService(port: number, pin: string): MDNSAdvertiser`

Convenience function to quickly start advertising.

```typescript
const advertiser = advertiseService(3000, "123456");
```

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
import { MDNSAdvertiser, generatePIN } from "codemote";

const advertiser = new MDNSAdvertiser();
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
process.on("SIGINT", () => {
  clearInterval(interval);
  advertiser.destroy();
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

1. **Always clean up**: Call `destroy()` when shutting down to release network resources
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
const advertiser1 = advertiseService(3000, "123456");
const advertiser2 = advertiseService(3001, "654321");

// Bad: Same port will cause issues
const advertiser1 = advertiseService(3000, "123456");
const advertiser2 = advertiseService(3000, "654321"); // Conflict!
```
