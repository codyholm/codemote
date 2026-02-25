# Terminal QR Code Pairing

This module builds a deep link URL for pairing and renders it as a terminal-friendly QR code.

## What the QR contains

The QR code encodes a `codemote://pair` deep link.

Current format (preferred):

```
codemote://pair?
  host=<lan-host>
  &port=<relay-port>
  &relay=wss%3A%2F%2F<lan-host>%3A<relay-port>%2Fws
  &pin=<6-digit>
  &tlsPin=<sha256-hex-64>
  &code=<6-digit>
```

Notes:

- `tlsPin` is the trust anchor for first-time pairing in local mode.
- `pin` is canonical; `code` is a legacy alias accepted by older clients.
- `relay` allows the iOS app to avoid manual URL entry.
- `relay` is URL-encoded in the deep link query (so it can safely contain `://` and `/ws`).

## API

### `buildPairingURL(host, port, pin, options)`

```ts
type BuildPairingURLOptions = {
  tlsPin: string;
  relayUrl?: string; // defaults to wss://{host}:{port}/ws
};

buildPairingURL(host: string, port: number, pin: string, options: BuildPairingURLOptions): string
```

### `generateQRCode(url)`

```ts
generateQRCode(url: string): Promise<string>
```

## Example

```ts
import { buildPairingURL, generateQRCode, getLocalIP } from "./qrcode.js";

const host = getLocalIP();
const port = 8080;
const pin = "851843";
const tlsPin = "b61ea072..."; // 64 hex chars

const url = buildPairingURL(host, port, pin, { tlsPin });
const qr = await generateQRCode(url);

console.log(qr);
```

## Security Notes

- Do not print the raw pairing URL to logs (it contains the PIN).
- Do not include the PIN in mDNS TXT records.
- Prefer showing the QR in the UI and redacting the PIN in logs.

See `.guild/brain/SECURITY_ARCHITECTURE.md`.
