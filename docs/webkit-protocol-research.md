# WebKit Protocol Connection Research

## Status: Pending Spike (Epic 1B, Story #32)

## Candidates

| Method | Description | Pros | Cons | Status |
|--------|-------------|------|------|--------|
| ios-webkit-debug-proxy | Proxy Safari's debug socket to ws://localhost:9222 | CDP-like WebSocket, OSS, simulator support | Extra process | **Top candidate** |
| safaridriver | Apple's official WebDriver | Official, stable | WebDriver protocol (not native), limited JS | Backup |
| Direct WebKit Protocol | Connect to Safari debug socket directly | No middleware | Undocumented | Research needed |
| Appium + XCUITest | Full simulator control | Rich API | Heavy dependency | Comparison only |

## Decision
To be made in Epic 1B Spike (Story #32).

## References
- ios-webkit-debug-proxy: https://github.com/nicolo-ribaudo/nicolo-ribaudo.github.io (original: google/ios-webkit-debug-proxy)
- WebKit Inspector Protocol: https://github.com/nicolo-ribaudo/nicolo-ribaudo.github.io/nicolo-ribaudo/nicolo-ribaudo.github.io
- safaridriver: Built into macOS (/usr/bin/safaridriver)
