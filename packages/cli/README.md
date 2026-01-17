# @guild-remote/cli

CLI utilities for Guild Remote, including PIN generation and rate limiting for pairing operations.

## Features

### PIN Generation

Generate secure 6-digit PINs for device pairing:

```typescript
import { generatePIN } from "@guild-remote/cli";

const pin = generatePIN(); // "042815"
```

### Rate Limiting

Protect pairing endpoints with exponential backoff and lockout:

```typescript
import { RateLimiter } from "@guild-remote/cli";

const limiter = new RateLimiter({
  maxAttempts: 5,
  windowMs: 60_000,
  backoffMs: [1000, 2000, 4000, 8000, 16_000],
  lockoutMs: 60_000,
});

const result = await limiter.checkAndRecord(clientIP, success);
if (!result.allowed) {
  console.log(result.message); // "Too many attempts. Wait 2s before retrying"
}
```

### PIN Management

Manage PIN lifecycle with automatic expiry:

```typescript
import { PINManager } from "@guild-remote/cli";

const manager = new PINManager(5 * 60 * 1000); // 5 minute TTL

console.log(manager.pin); // Current PIN
manager.validate("123456"); // Check if PIN matches

manager.setOnRegenerate((newPin) => {
  console.log("New PIN:", newPin);
  // Update UI, notify clients, etc.
});
```

## API

### `generatePIN(): string`

Generates a random 6-digit PIN (000000-999999).

### `RateLimiter`

Rate limiter with exponential backoff.

**Constructor:**
- `config.maxAttempts` - Max failed attempts before lockout (default: 5)
- `config.windowMs` - Time window for rate limiting (default: 60000)
- `config.backoffMs` - Backoff delays for each attempt (default: [1000, 2000, 4000, 8000, 16000])
- `config.lockoutMs` - Lockout duration after max attempts (default: 60000)

**Methods:**
- `checkAndRecord(clientIP, success)` - Check if request is allowed and record attempt
- `reset(clientIP)` - Clear rate limit for client
- `clear()` - Clear all rate limit records

### `PINManager`

Manages PIN generation, expiry, and validation.

**Constructor:**
- `ttlMs` - PIN time-to-live in milliseconds (default: 300000 = 5 minutes)

**Properties:**
- `pin` - Get current PIN (regenerates if expired)

**Methods:**
- `validate(pin)` - Check if PIN matches and is not expired
- `getRemainingTime()` - Get milliseconds until expiry
- `isExpired()` - Check if PIN is expired
- `forceRegenerate()` - Manually regenerate PIN
- `setOnRegenerate(callback)` - Set callback for regeneration events
- `dispose()` - Clean up timers

## Testing

```bash
pnpm test
```

## Building

```bash
pnpm build
```
