# QR Code Module

Terminal QR code generation for Guild Remote pairing.

## Features

- Build deep link pairing URLs with host, port, and PIN
- Auto-detect local network IP address
- Generate terminal-friendly QR codes for mobile scanning

## API

### `buildPairingURL(host: string, port: number, pin: string): string`

Builds a deep link URL for pairing.

```typescript
const url = buildPairingURL('192.168.1.100', 3000, '123456');
// Returns: 'guildremote://pair?host=192.168.1.100&port=3000&pin=123456'
```

### `getLocalIP(): string`

Detects the local network IP address.

**Detection Strategy:**
1. Prefers common interfaces: `en0` (macOS), `eth0` (Linux), `en1`, `wlan0`
2. Filters out:
   - Loopback (`127.0.0.1`)
   - Docker interfaces (`docker0`, `veth*`, `br-*`)
   - Link-local addresses (`169.254.x.x`)
   - Internal/virtual interfaces
3. Falls back to `127.0.0.1` if no valid interface found

```typescript
const ip = getLocalIP();
// Returns: '192.168.1.100' (example)
```

### `generateQRCode(url: string): Promise<string>`

Generates a terminal-displayable QR code.

```typescript
const qrCode = await generateQRCode('guildremote://pair?host=192.168.1.100&port=3000&pin=123456');
console.log(qrCode);
// Displays ASCII QR code
```

## Example Usage

```typescript
import { buildPairingURL, getLocalIP, generateQRCode } from './qrcode.js';

async function showPairingQRCode(port: number, pin: string) {
  const host = getLocalIP();
  const url = buildPairingURL(host, port, pin);

  console.log('Scan this QR code with the Guild Remote app:');
  const qrCode = await generateQRCode(url);
  console.log(qrCode);

  console.log(`PIN: ${pin}`);
}
```

## Testing

Run tests with:

```bash
pnpm test qrcode
```

Tests cover:
- URL building with various inputs
- IP detection across different network configurations
- QR code generation and uniqueness
