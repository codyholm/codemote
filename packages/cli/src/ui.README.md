# Terminal UI

This module renders a terminal UI for the local server:

- ASCII QR code
- 6-digit PIN (formatted as `123 456`)
- Local relay URL
- Short TLS fingerprint (first 8 chars)
- Status line

## UI State

```ts
export interface UIState {
  qrCode: string;
  pin?: string;
  pairingCode?: string; // alias
  localURL: string;
  tlsPin?: string; // 64 hex chars (sha256 leaf cert DER)
  status: "starting" | "ready" | "connected" | "error";
  errorMessage?: string;
}
```

## Example

```ts
import { renderUI } from "./ui.js";

await renderUI({
  qrCode,
  pin: "851843",
  localURL: "wss://10.0.0.28:8080",
  tlsPin: "b61ea072...", // 64 hex chars
  status: "ready",
});
```

## Notes

- The UI shows only a short fingerprint prefix; do not print full TLS pins or deep link URLs to logs.
- The PIN is shown because it is a user-facing pairing secret; server logs should redact it.
