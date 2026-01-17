# PIN Generation and Rate Limiting Implementation

## Overview

Implemented a complete PIN generation and rate limiting system for device pairing operations in `packages/cli/src/pairing.ts`.

## Components

### 1. PIN Generation (`generatePIN`)

- Generates random 6-digit numeric PINs (000000-999999)
- Uses `Math.random()` for generation
- Zero-pads to ensure consistent 6-digit format

### 2. Rate Limiter (`RateLimiter`)

Implements sophisticated rate limiting with:

- **Exponential Backoff**: Progressively increasing delays between attempts
  - First attempt: 1s
  - Second attempt: 2s
  - Third attempt: 4s
  - Fourth attempt: 8s
  - Fifth attempt: 16s

- **Lockout Mechanism**: After max attempts (default 5), client is locked out for 60 seconds

- **Time Window**: Attempts are tracked within a 60-second window

- **Per-Client Tracking**: Each client IP is tracked independently

### 3. PIN Manager (`PINManager`)

Manages PIN lifecycle with:

- **Automatic Expiry**: PINs expire after configurable TTL (default 5 minutes)
- **Auto-Regeneration**: New PIN generated automatically on expiry
- **Validation**: Check if provided PIN matches current unexpired PIN
- **Callbacks**: Notify on regeneration for UI updates
- **Time Tracking**: Query remaining time until expiry

## Key Implementation Details

### Rate Limiter Logic

1. Check if client is locked out (has lockedUntil timestamp)
2. If lockout expired, clear record and treat as fresh start
3. If no record or outside time window, allow and record attempt
4. For failed attempts, check if max attempts exceeded
5. If max exceeded, set lockout timestamp
6. Otherwise apply exponential backoff based on attempt count
7. Successful attempts clear the client's record

### PIN Manager Logic

1. Generate initial PIN on construction
2. Set expiry timestamp = now + TTL
3. Schedule automatic regeneration timer
4. On PIN access, check expiry and regenerate if needed
5. Validation checks both PIN match and expiry
6. Regeneration clears old timer, generates new PIN, schedules next regeneration

## Testing

Comprehensive test suite with 34 tests covering:

- PIN generation (format, range, uniqueness)
- Rate limiter basic functionality
- Exponential backoff behavior
- Lockout mechanism (trigger, persistence, expiry)
- Time window reset
- Client isolation
- PIN manager initialization
- PIN expiry and regeneration
- Validation
- Callbacks

### Test Strategy

- Used real timers instead of fake timers for reliability
- Added generous buffers to timeouts to account for test environment variability
- Fixed lockout expiry logic to properly clear expired lockouts

## Files Created

- `/packages/cli/package.json` - Package configuration
- `/packages/cli/tsconfig.json` - TypeScript configuration
- `/packages/cli/src/pairing.ts` - Main implementation (287 lines)
- `/packages/cli/src/pairing.test.ts` - Test suite (34 tests, 447 lines)
- `/packages/cli/src/index.ts` - Public exports
- `/packages/cli/README.md` - Package documentation
- `/packages/cli/demo.ts` - Usage demonstration

## Usage Example

```typescript
import { generatePIN, RateLimiter, PINManager } from "@guild-remote/cli";

// Generate PIN
const pin = generatePIN(); // "042815"

// Rate limiting
const limiter = new RateLimiter({
  maxAttempts: 5,
  windowMs: 60_000,
  backoffMs: [1000, 2000, 4000, 8000, 16_000],
  lockoutMs: 60_000,
});

const result = await limiter.checkAndRecord("192.168.1.1", false);
if (!result.allowed) {
  console.log(result.message); // "Too many attempts. Wait 2s before retrying"
}

// PIN management
const manager = new PINManager(5 * 60 * 1000); // 5 min TTL
console.log(manager.pin); // Current PIN
manager.validate("123456"); // Check if matches
manager.setOnRegenerate((newPin) => {
  // Handle regeneration
});
```

## Build Output

- TypeScript compilation successful
- Generated declaration files (.d.ts)
- Source maps included
- All 34 tests passing
