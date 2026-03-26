# Connection Method Spike Results

## Date: 2026-03-25

## Decision: ios-webkit-debug-proxy (Candidate A)

### Candidates Evaluated

| Candidate | Works? | Protocol Access | API Coverage | Latency | Setup | Stability |
|-----------|--------|----------------|-------------|---------|-------|-----------|
| A: ios-webkit-debug-proxy | **Yes** | Direct WebKit Protocol via WebSocket | Full (Runtime, Page, Network, Console, DOM, CSS) | <50ms per message | Easy (brew install) | Good (mature OSS) |
| B: safaridriver | Yes | WebDriver (W3C) | Partial (no direct JS eval, no cookie control, no events) | ~100ms | Built-in | Official but limited |
| C: Direct WebKit Protocol | Unverified | Would be direct | Theoretically full | Unknown | Hard (undocumented socket) | Unknown |
| D: Appium + XCUITest | Yes | WebDriver via Appium | Full but slow | ~200ms | Heavy (Java, Appium server) | Good but complex |

### Why ios-webkit-debug-proxy?

1. **Direct WebKit Inspector Protocol** — Same protocol as Safari Web Inspector. Full access to Runtime, Page, Network, Console, DOM, CSS domains.
2. **Per-device ports** — Each simulator gets its own WebSocket port (9222, 9223, ...). Natural fit for multi-device parallelism.
3. **Mature OSS** — Originally by Google, actively maintained. Supports simulators.
4. **Low overhead** — Single lightweight proxy process. No JVM, no Appium server.
5. **WebSocket API** — Standard ws:// connection. Our WebKitClient connects directly.

### Connection Flow

```
opensafari serve
  → spawn ios_webkit_debug_proxy
  → boot simulator(s)
  → open Safari via simctl openurl
  → GET http://localhost:9221/json (list all targets across all devices)
  → ws://localhost:9222/devtools/page/<id> (connect to specific Safari page)
  → Send WebKit Inspector Protocol messages
```

### Port Assignment

- Port 9221: Device/target listing endpoint (HTTP JSON)
- Port 9222: First simulator's Safari pages
- Port 9223: Second simulator
- Port 9224+: Additional simulators

### Proof of Concept

See `spike/iwdp-poc.ts` for a working connection test.

### Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| ios-webkit-debug-proxy not installed | `opensafari doctor` checks for it; suggest `brew install ios-webkit-debug-proxy` |
| Proxy process crashes | Auto-restart in SimulatorManager; health monitoring |
| Port conflicts | Configurable base port via `--webkit-debug-port` |
