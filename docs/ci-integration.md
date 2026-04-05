# CI/CD Integration

OpenSafari QA audit results can be consumed by any CI/CD pipeline. The `qa_full_audit` tool supports
`junit` and `json` output formats specifically for this purpose, and the `QAHistory.getExitCode()`
API gives you a reliable non-zero exit code when critical issues are found.

## GitHub Actions

### Basic JUnit workflow

The example below audits a staging URL on every push to `main`, publishes results to GitHub's
built-in test-results view via `dorny/test-reporter`, and fails the job when critical issues exist.

```yaml
name: Mobile QA Audit

on:
  push:
    branches: [main]
  pull_request:
    branches: [main, develop]

jobs:
  qa-audit:
    runs-on: macos-latest

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install opensafari
        run: npm install -g opensafari-mcp

      - name: Install ios-webkit-debug-proxy
        run: brew install ios-webkit-debug-proxy

      - name: Boot iOS Simulator
        run: |
          opensafari serve &
          sleep 3

      - name: Run QA audit (JUnit output)
        run: |
          opensafari audit \
            --url https://staging.example.com \
            --format junit \
            --output qa-results.xml

      - name: Publish test results
        uses: dorny/test-reporter@v1
        if: always()
        with:
          name: OpenSafari QA
          path: qa-results.xml
          reporter: java-junit

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: qa-report
          path: qa-results.xml
```

### Using the MCP tool directly (Claude Code / AI agent pipelines)

When opensafari is invoked as an MCP tool from an AI agent, pass `format: "junit"` to get
JUnit-compatible XML back as the tool response:

```json
{
  "tool": "qa_full_audit",
  "params": {
    "url": "https://staging.example.com",
    "format": "junit"
  }
}
```

Redirect the text content of the response to a file and upload it as an artifact:

```yaml
      - name: Save JUnit output from agent
        run: echo "$JUNIT_CONTENT" > qa-results.xml
        env:
          JUNIT_CONTENT: ${{ steps.audit.outputs.junit }}

      - name: Upload test results
        uses: actions/upload-artifact@v4
        with:
          name: qa-results
          path: qa-results.xml
```

### JSON format for structured downstream processing

Use `format: "json"` when you want to post-process results (e.g. comment on a PR, send to
Datadog, or drive a custom dashboard):

```json
{
  "tool": "qa_full_audit",
  "params": {
    "url": "https://staging.example.com",
    "format": "json"
  }
}
```

Example step that extracts the score and posts a PR comment:

```yaml
      - name: Run QA audit (JSON)
        id: audit
        run: |
          opensafari audit \
            --url https://staging.example.com \
            --format json \
            --output qa-results.json

      - name: Comment score on PR
        if: github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const report = JSON.parse(fs.readFileSync('qa-results.json', 'utf8'));
            const score = report.score;
            const critical = report.summary.critical;
            const emoji = critical > 0 ? ':x:' : score >= 80 ? ':white_check_mark:' : ':warning:';
            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body: `${emoji} **OpenSafari QA Score: ${score}/100** — ${critical} critical issue(s)`
            });
```

## CI gating with exit codes

`QAHistory.getExitCode()` returns `1` when the audit should block the pipeline, `0` otherwise.
The default policy fails on any `critical` severity issue.

```typescript
import { QAHistory } from 'opensafari-mcp/qa/history';

const history = new QAHistory();
const report = await audit.runFullAudit(url);
await history.save(report);

const exitCode = history.getExitCode(report);
// exitCode === 1 → critical issues found, fail the build
// exitCode === 0 → clean or only low/medium issues, pass

process.exit(exitCode);
```

You can customize the policy:

| Option | Default | Description |
|--------|---------|-------------|
| `failOnCritical` | `true` | Exit 1 if any `critical` issues are found |
| `failOnHigh` | `false` | Exit 1 if any `high` severity issues are found |
| `minScore` | `undefined` | Exit 1 if the audit score is below this threshold |

```typescript
// Fail on critical OR high, and require a minimum score of 70
const exitCode = history.getExitCode(report, {
  failOnCritical: true,
  failOnHigh: true,
  minScore: 70,
});
```

## Other CI systems

### Jenkins

```groovy
pipeline {
  agent any
  stages {
    stage('QA Audit') {
      steps {
        sh 'opensafari audit --url https://staging.example.com --format junit --output qa-results.xml'
      }
      post {
        always {
          junit 'qa-results.xml'
        }
      }
    }
  }
}
```

### CircleCI

```yaml
version: 2.1

jobs:
  qa-audit:
    macos:
      xcode: '16.0.0'
    steps:
      - checkout
      - run:
          name: Install opensafari
          command: npm install -g opensafari-mcp
      - run:
          name: Run QA audit
          command: |
            opensafari audit \
              --url https://staging.example.com \
              --format junit \
              --output ~/test-results/qa-results.xml
      - store_test_results:
          path: ~/test-results
      - store_artifacts:
          path: ~/test-results/qa-results.xml

workflows:
  qa:
    jobs:
      - qa-audit
```

## Report format reference

### JUnit XML (`format: "junit"`)

Each QA detector maps to a `<testcase>`. The mapping is:

| Detector result | JUnit element |
|----------------|---------------|
| Passed | `<testcase />` (no children) |
| Failed — `critical` or `high` severity | `<testcase><failure /></testcase>` |
| Failed — `low` severity | `<testcase><skipped /></testcase>` |
| Detector error | `<testcase><error /></testcase>` |

Suite-level properties include the audited URL, device name, viewport dimensions, and overall
score.

### JSON (`format: "json"`)

The JSON report includes:

```jsonc
{
  "url": "https://example.com",
  "device": "iPhone 17",
  "viewport": { "w": 393, "h": 852 },
  "score": 87,
  "timestamp": "2026-03-31T00:00:00.000Z",
  "duration": 4821,
  "summary": {
    "total": 13,
    "passed": 11,
    "failed": 2,
    "critical": 0,
    "high": 1,
    "medium": 1,
    "low": 0
  },
  "detectors": [
    {
      "detector": "auto-zoom",
      "passed": false,
      "severity": "high",
      "issueCount": 1,
      "issues": [
        {
          "selector": "input[type=search]",
          "problem": "font-size 14px triggers auto-zoom (min 16px required)",
          "severity": "high"
        }
      ]
    }
  ]
}
```

## Native app observability in CI

OpenSafari v0.2.0 adds native-level tools that complement the browser-based QA audit pipeline.
These tools are useful for capturing device-level evidence during test failures.

### Native screenshots

Capture the full simulator screen (not just the browser viewport) at any point during a flow:

```json
{
  "tool": "app_screenshot_native",
  "params": {
    "deviceId": "<UDID>",
    "format": "png",
    "mask": true
  }
}
```

When `mask` is `true`, the status bar is set to deterministic values (9:41, full battery, full signal)
so screenshots are diffable across runs. The result includes a base64-encoded image.

### Device log export

Export structured JSON logs from the simulator, filtered by app, level, or text:

```json
{
  "tool": "app_logs",
  "params": {
    "deviceId": "<UDID>",
    "bundleId": "com.example.myapp",
    "level": "error",
    "since": "5m",
    "limit": 50
  }
}
```

Upload the JSON output as a CI artifact for post-mortem analysis of failing runs.

### Structured assertions (`app_assert`)

Run native assertions that produce CI-friendly JSON output:

```json
{
  "tool": "app_assert",
  "params": {
    "deviceId": "<UDID>",
    "assertion": "app_running",
    "bundleId": "com.example.myapp",
    "suiteName": "smoke-tests",
    "testName": "app-launches"
  }
}
```

Each assertion returns a structured result:

```json
{
  "passed": true,
  "assertion": "app_running",
  "testName": "app-launches",
  "suiteName": "smoke-tests",
  "message": "App com.example.myapp is running",
  "durationMs": 142,
  "timestamp": "2026-04-05T03:35:00.000Z"
}
```

Available assertion types: `app_running`, `element_exists`, `element_visible`,
`screen_contains_text`, `text_matches`.

### Hybrid context switching

For apps that embed WebViews, discover and switch between native and web contexts:

```json
// Step 1: List available targets
{ "tool": "app_webview_connect", "params": { "deviceId": "<UDID>" } }

// Step 2: Switch to WebView context
{ "tool": "set_active_context", "params": { "context": "webview", "targetId": "<id>" } }

// Step 3: Run browser-level tools inside the WebView
{ "tool": "navigate", "params": { "url": "https://example.com" } }

// Step 4: Switch back to Safari
{ "tool": "set_active_context", "params": { "context": "safari" } }
```

### CI workflow with native artifacts

```yaml
      - name: Run native smoke test
        run: |
          # Capture pre-test screenshot
          opensafari tool app_screenshot_native --mask true --output pre-test.png

          # Run app assertions
          opensafari tool app_assert \
            --assertion app_running \
            --bundleId com.example.myapp \
            --suiteName ci --testName launch > assert-result.json

          # On failure, export logs
          opensafari tool app_logs \
            --bundleId com.example.myapp \
            --level error \
            --since 5m > error-logs.json

          # Capture post-test screenshot
          opensafari tool app_screenshot_native --mask true --output post-test.png

      - name: Upload native artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: native-test-artifacts
          path: |
            pre-test.png
            post-test.png
            assert-result.json
            error-logs.json
```

## See also

- [Getting Started](getting-started.md)
- [API Reference](api-reference.md)
- [Troubleshooting](troubleshooting.md)
