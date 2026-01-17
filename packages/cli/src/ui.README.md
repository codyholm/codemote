# Terminal UI Module

Beautiful terminal UI for Guild Remote CLI with QR code, PIN display, and status updates.

## Features

- QR code display for easy iPhone scanning
- Formatted 6-digit PIN (e.g., "847 291")
- Status indicators (starting, ready, connected, error)
- Bordered box layout using Unicode box-drawing characters
- Color-coded status messages with Chalk

## Usage

### Basic Usage

```typescript
import { renderUI, formatPIN } from './ui.js';
import { generateQRCode, buildPairingURL, getLocalIP } from './qrcode.js';
import type { UIState } from './ui.js';

// Generate pairing data
const host = getLocalIP();
const port = 3000;
const pin = '123456';
const pairingURL = buildPairingURL(host, port, pin);
const qrCode = await generateQRCode(pairingURL);

// Create UI state
const state: UIState = {
  qrCode,
  pin,
  localURL: `http://${host}:${port}`,
  status: 'ready',
};

// Render the UI
await renderUI(state);
```

### Status Updates

```typescript
// Update with a new state
state.status = 'connected';
await renderUI(state);

// Show error
state.status = 'error';
state.errorMessage = 'Connection lost';
await renderUI(state);
```

### PIN Formatting

```typescript
import { formatPIN } from './ui.js';

const formattedPin = formatPIN('847291'); // Returns "847 291"
```

## API Reference

### `renderUI(state: UIState): Promise<void>`

Clears the terminal and renders the full UI with QR code, PIN, and status.

**Parameters:**
- `state.qrCode` - QR code ASCII art string (from `generateQRCode()`)
- `state.pin` - 6-digit PIN string
- `state.localURL` - Local server URL (e.g., "http://192.168.1.100:3000")
- `state.status` - Current status: 'starting' | 'ready' | 'connected' | 'error'
- `state.errorMessage` - Optional error message (shown when status is 'error')

### `formatPIN(pin: string): string`

Formats a 6-digit PIN with a space separator for readability.

**Parameters:**
- `pin` - 6-digit PIN string (e.g., "847291")

**Returns:**
- Formatted PIN with space (e.g., "847 291")

### `updateStatus(status: string): void`

Updates just the status line without full redraw using ANSI cursor control.

**Parameters:**
- `status` - Status message to display

**Note:** This function uses ANSI escape codes to move the cursor. Use `renderUI()` for full redraws.

## UI States

### Starting
```
   Starting...
```

### Ready
```
   Advertising via Bonjour... Ready for connections
```

### Connected
```
   ✓ Device connected
```

### Error
```
   ✗ Error: Connection lost
```

## Example Output

```
┌─────────────────────────────────────────────────────────────┐
│                      Guild Remote                           │
│                                                             │
│   █▀▀▀▀▀█ ▄ █▄ ▀ █▀▀▀▀▀█                                    │
│   █ ███ █ ▄▀▀██▀ █ ███ █                                    │
│   █ ▀▀▀ █ █ ▀ █▄ █ ▀▀▀ █                                    │
│   ▀▀▀▀▀▀▀ █▄█ █▄█ ▀▀▀▀▀▀▀                                    │
│                                                             │
│   Scan with iPhone Camera or enter PIN:                    │
│                    847 291                                  │
│                                                             │
│   Local: http://192.168.1.100:3000                          │
│   Advertising via Bonjour... Ready for connections          │
└─────────────────────────────────────────────────────────────┘
```

## Color Scheme

- **Borders:** Cyan
- **Title:** Bold White
- **PIN:** Bold Yellow
- **URL:** Dimmed
- **Status - Ready/Connected:** Green
- **Status - Starting:** Yellow
- **Status - Error:** Red

## Dependencies

- `chalk` - Terminal color library
- `./qrcode.js` - QR code generation utilities

## Testing

Run tests with:
```bash
npm test ui.test
```

See `ui-example.ts` for a complete working demo.
