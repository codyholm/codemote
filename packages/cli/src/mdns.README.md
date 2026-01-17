# mDNS Service Advertisement

The `mdns` module provides Bonjour/mDNS service advertisement for Guild Remote, enabling iOS apps to discover the service on the local network.

## Overview

This module uses the `bonjour-service` package to advertise the Guild Remote service as `_guildremote._tcp.local`, which iOS apps can discover using the Network framework or Bonjour.

## Quick Start

```typescript
import { advertiseService } from '@guild-remote/cli';

// Start advertising on port 3000 with a PIN
const advertiser = advertiseService(3000, "123456");

// Service is now discoverable on the local network
// Remember to clean up when done
process.on('SIGINT', () => {
  advertiser.destroy();
  process.exit(0);
});
```

## API Reference

### `MDNSAdvertiser`

The main class for managing mDNS service advertisement.

#### Methods

##### `advertise(config: ServiceConfig): void`

Starts advertising the Guild Remote service on the local network.

```typescript
const advertiser = new MDNSAdvertiser();
advertiser.advertise({
  port: 3000,
  pin: "123456",
  version: "1"  // optional, defaults to "1"
});
```

##### `updatePIN(newPIN: string): void`

Updates the PIN in the TXT records without stopping the service. This is useful for PIN rotation.

```typescript
advertiser.updatePIN("654321");
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
  port: number;      // Port where the service is listening
  pin: string;       // PIN for pairing authentication
  version?: string;  // Protocol version (default: "1")
}
```

## Service Discovery

The advertised service includes the following information:

- **Service Type**: `_guildremote._tcp.local`
- **Service Name**: `Guild Remote on <hostname>`
- **Port**: The configured port number
- **TXT Records**:
  - `pin`: Current pairing PIN
  - `version`: Protocol version
  - `hostname`: System hostname

### iOS Discovery Example

```swift
import Network

let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_guildremote._tcp", domain: nil), using: .tcp)

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

## Integration with PINManager

The mDNS advertiser works seamlessly with the `PINManager` for automatic PIN rotation:

```typescript
import { MDNSAdvertiser, PINManager } from '@guild-remote/cli';

const advertiser = new MDNSAdvertiser();
const pinManager = new PINManager(5 * 60 * 1000); // 5 minute TTL

// Update mDNS when PIN regenerates
pinManager.setOnRegenerate((newPIN) => {
  console.log(`PIN rotated to: ${newPIN}`);
  advertiser.updatePIN(newPIN);
});

// Start advertising
advertiser.advertise({
  port: 3000,
  pin: pinManager.pin,
});

// Clean up on shutdown
process.on('SIGINT', () => {
  pinManager.dispose();
  advertiser.destroy();
  process.exit(0);
});
```

## Error Handling

The `updatePIN` method will throw an error if called when not advertising:

```typescript
try {
  advertiser.updatePIN("123456");
} catch (error) {
  console.error("Cannot update PIN:", error.message);
  // "Cannot update PIN: service is not currently advertising"
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
2. **Use PIN rotation**: Integrate with `PINManager` for automatic PIN updates
3. **Handle errors**: Wrap `updatePIN` in try-catch blocks
4. **Single instance**: Only create one advertiser per port to avoid conflicts
5. **Unique ports**: Use different ports for multiple services on the same machine

## Troubleshooting

### Service not discoverable

- Check firewall settings (mDNS uses UDP port 5353)
- Ensure devices are on the same network
- Verify the service is advertising with `isAdvertising()`
- Check for port conflicts

### PIN updates not reflecting

- Ensure you're calling `updatePIN()` on the correct instance
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
