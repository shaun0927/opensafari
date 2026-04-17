# StoreKit / In-App Purchase Automation

OpenSafari exposes three MCP tools for automating StoreKit and In-App Purchase (IAP)
flows on the iOS Simulator. These tools wrap `xcrun simctl storekit` subcommands
and are designed for Flutter apps using `in_app_purchase` and native IAP QA pipelines.

## Requirements

- macOS with Xcode 14 or later installed
- A booted iOS Simulator (`device_boot`)
- A `.storekit` configuration file created in Xcode (or manually, see example below)

## Quick Start

### 1. Load a StoreKit configuration

```json
// Tool call: app_storekit_configure
{
  "configPath": "/path/to/MyApp.storekit"
}
```

Returns:
```json
{
  "ok": true,
  "productIds": ["com.example.monthly_sub", "com.example.lifetime"],
  "udid": "AABBCCDD-...",
  "configPath": "/path/to/MyApp.storekit"
}
```

### 2. List pending transactions

```json
// Tool call: app_storekit_test_session
{
  "action": "list"
}
```

Returns:
```json
{
  "ok": true,
  "action": "list",
  "udid": "AABBCCDD-...",
  "transactions": [
    { "id": "txn-001", "state": "pending", "productId": "com.example.monthly_sub" }
  ]
}
```

### 3. Approve a pending transaction

```json
// Tool call: app_storekit_test_session
{
  "action": "approve",
  "transactionId": "txn-001"
}
```

### 4. Pull the sandbox receipt

```json
// Tool call: app_storekit_receipt
{
  "bundleId": "com.example.myapp"
}
```

Returns:
```json
{
  "receipt": "<base64-encoded-receipt>",
  "path": "/Users/.../StoreKit/sandboxReceipt",
  "bytes": 4096,
  "bundleId": "com.example.myapp",
  "udid": "AABBCCDD-..."
}
```

---

## Tool Reference

### `app_storekit_configure`

Loads a `.storekit` configuration file into the simulator, making its products
available for purchase in the sandbox environment.

| Parameter    | Type     | Required | Description                                         |
|-------------|----------|----------|-----------------------------------------------------|
| `configPath` | `string` | Yes      | Absolute path to the `.storekit` file               |
| `udid`       | `string` | No       | Simulator UDID. Falls back to the sole booted device |

**Success response:**
```json
{ "ok": true, "productIds": ["..."], "udid": "...", "configPath": "..." }
```

**Error codes:**
- `MISSING_FILE` — `.storekit` file not found or invalid JSON
- `DEVICE_NOT_BOOTED` — No simulator specified and none booted
- `STOREKIT_DISABLED` — `OPENSAFARI_DISABLE_STOREKIT=1` is set
- `XCODE_TOO_OLD` — Xcode version does not support `simctl storekit`
- `STOREKIT_ERROR` — Underlying simctl error

---

### `app_storekit_test_session`

Controls the StoreKit sandbox test session on the simulator. Supports listing,
approving, declining, refunding, and clearing transactions, as well as toggling
Ask to Buy parental controls.

| Parameter       | Type      | Required                              | Description                                          |
|----------------|-----------|---------------------------------------|------------------------------------------------------|
| `action`        | `string`  | Yes                                   | `list`, `approve`, `decline`, `refund`, `clear`, `askToBuy` |
| `udid`          | `string`  | No                                    | Simulator UDID. Falls back to the sole booted device  |
| `transactionId` | `string`  | Required for `approve`/`decline`/`refund` | The transaction ID to act on                    |
| `enabled`       | `boolean` | Required for `askToBuy`               | `true` to enable, `false` to disable Ask to Buy      |

**Actions:**

| Action      | Description                                         |
|-------------|-----------------------------------------------------|
| `list`      | Returns all pending sandbox transactions             |
| `approve`   | Approves a specific pending transaction              |
| `decline`   | Declines a specific pending transaction              |
| `refund`    | Issues a refund for a completed transaction          |
| `clear`     | Clears all pending transactions from the test session |
| `askToBuy`  | Enables or disables Ask to Buy parental gate         |

**Error codes:**
- `MISSING_TRANSACTION_ID` — `transactionId` not provided for approve/decline/refund
- `MISSING_ENABLED` — `enabled` not provided for askToBuy
- `DEVICE_NOT_BOOTED` — No simulator specified and none booted
- `STOREKIT_DISABLED` — `OPENSAFARI_DISABLE_STOREKIT=1` is set
- `XCODE_TOO_OLD` — Xcode version does not support `simctl storekit`
- `STOREKIT_ERROR` — Underlying simctl error

---

### `app_storekit_receipt`

Retrieves the StoreKit sandbox receipt from the app's data container on the
simulator, returned as a base64-encoded string. Checks both the modern path
(`StoreKit/sandboxReceipt`) and the legacy path (`Documents/receipt`).

| Parameter  | Type     | Required | Description                                         |
|-----------|----------|----------|-----------------------------------------------------|
| `bundleId` | `string` | Yes      | App bundle identifier (e.g. `com.example.myapp`)    |
| `udid`     | `string` | No       | Simulator UDID. Falls back to the sole booted device |

**Success response:**
```json
{
  "receipt": "<base64>",
  "path": "/Users/.../StoreKit/sandboxReceipt",
  "bytes": 4096,
  "bundleId": "com.example.myapp",
  "udid": "AABBCCDD-..."
}
```

**Error codes:**
- `APP_NOT_INSTALLED` — App not found in simulator
- `NO_RECEIPT` — Receipt file not present (purchase not yet made or app not launched)
- `READ_ERROR` — Receipt file could not be read
- `DEVICE_NOT_BOOTED` — No simulator specified and none booted
- `STOREKIT_DISABLED` — `OPENSAFARI_DISABLE_STOREKIT=1` is set

---

## Sample `.storekit` File

```json
{
  "identifier": "MyApp StoreKit Config",
  "nonRenewingSubscriptions": [],
  "products": [
    {
      "displayPrice": "0.99",
      "familyShareable": false,
      "localizations": [
        {
          "description": "Monthly subscription",
          "displayName": "Monthly Pro",
          "locale": "en_US"
        }
      ],
      "productID": "com.example.monthly_sub",
      "referenceName": "Monthly Pro",
      "type": "RecurringSubscription"
    },
    {
      "displayPrice": "9.99",
      "familyShareable": false,
      "localizations": [
        {
          "description": "Lifetime access",
          "displayName": "Lifetime",
          "locale": "en_US"
        }
      ],
      "productID": "com.example.lifetime",
      "referenceName": "Lifetime",
      "type": "NonConsumable"
    }
  ],
  "settings": {},
  "subscriptionGroups": [],
  "version": {
    "major": 2,
    "minor": 0
  }
}
```

---

## Full IAP QA Walk-through

### English (en-US)

```
1. Boot simulator:           device_boot
2. Launch app:               app_launch { bundleId: "com.example.myapp" }
3. Load StoreKit config:     app_storekit_configure { configPath: "/path/to/Config.storekit" }
4. Trigger purchase in app:  (tap the buy button via app_tap)
5. List transactions:        app_storekit_test_session { action: "list" }
6. Approve transaction:      app_storekit_test_session { action: "approve", transactionId: "<id>" }
7. Verify receipt:           app_storekit_receipt { bundleId: "com.example.myapp" }
8. Test refund:              app_storekit_test_session { action: "refund", transactionId: "<id>" }
9. Clear session:            app_storekit_test_session { action: "clear" }
```

### 한국어 (ko-KR)

```
1. 시뮬레이터 부팅:          device_boot
2. 앱 실행:                  app_launch { bundleId: "com.example.myapp" }
3. StoreKit 설정 로드:       app_storekit_configure { configPath: "/path/to/Config.storekit" }
4. 앱에서 구매 트리거:       (app_tap으로 구매 버튼 탭)
5. 트랜잭션 목록 조회:       app_storekit_test_session { action: "list" }
6. 트랜잭션 승인:            app_storekit_test_session { action: "approve", transactionId: "<id>" }
7. 영수증 확인:              app_storekit_receipt { bundleId: "com.example.myapp" }
8. 환불 테스트:              app_storekit_test_session { action: "refund", transactionId: "<id>" }
9. 세션 초기화:              app_storekit_test_session { action: "clear" }
```

---

## Disabling StoreKit Automation

Set `OPENSAFARI_DISABLE_STOREKIT=1` in the environment to disable all three StoreKit
tools at call time. All tools will return `{ error: "STOREKIT_DISABLED" }` immediately.
This is useful for CI environments that do not need IAP testing to avoid accidental
simulator StoreKit state changes.

## Telemetry

All three tools emit `_meta._telemetry` with `backend: "storekit"` in their success
responses. This field is always present and is not gated behind an env var (unlike the
input-backend telemetry for tap/swipe operations).
