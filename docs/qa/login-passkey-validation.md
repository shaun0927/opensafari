# Fast login and passkey live-validation recipe

OpenSafari should help teams validate login speed and passkey/OS prompt handling, but it should not become an authentication framework. Use this recipe to compose existing OpenSafari tools around a fixture or staging app without committing secrets.

## What this covers

- Reusing saved auth/browser state with OpenSafari auth-profile tools.
- Launching Safari, native apps, or app webviews into a login route.
- Detecting native OS prompts or passkey blockers with AX/native tools.
- Capturing screenshots/logs on failure.
- Resetting the profile/app to prove the test is not accidentally relying on stale state.

## What this does not cover

- Implementing a WebAuthn relying party.
- Adding Auth.js, SimpleWebAuthn, Keycloak, ZITADEL, Ory, Logto, or SuperTokens as OpenSafari runtime dependencies.
- Bypassing Face ID/Touch ID/passkey security prompts.
- Storing production credentials in GitHub Actions, repository files, trace artifacts, or screenshots.
- Duplicating auth profile hardening tracked by #699.

## Required pre-implementation decisions

1. **Fixture choice:** use a local fixture/staging app with non-production accounts, or a public demo that requires no secret.
2. **Secret handling:** if credentials are required, pass them through CI secrets and redact logs/artifacts.
3. **Prompt policy:** define whether passkey/OS prompts are expected to be handled, asserted, or documented as manual blockers.
4. **Reset policy:** define which OpenSafari reset tools prove the second run starts from the intended auth state.

## Canonical validation flow

1. Boot the target simulator.
2. Reset app/browser state for a clean first run.
3. Open the login URL or app deeplink.
4. Fill credentials or trigger the passkey flow using app/webview/native tools.
5. Use native alert/prompt detection when the OS presents a sheet.
6. Save an auth profile only after a successful login.
7. Terminate/relaunch the app or Safari.
8. Restore the auth profile and measure the second-run login/setup path.
9. Capture screenshots, app logs, crash reports, and native prompt evidence on failure.
10. Reset the profile/app and confirm the route returns to logged-out state.

## Merge/post-merge success criteria

- The flow uses only existing OpenSafari tools or explicitly documents a missing tool gap.
- No secret appears in stdout, trace artifacts, screenshots, issue bodies, or PR descriptions.
- The second run is measurably shorter or skips credential entry because saved state was restored.
- A blocked passkey/OS prompt produces actionable screenshot/log/native context evidence.
- Profile reset returns the app/browser to a logged-out state.

## Suggested PR checklist

- Link the issue covering this recipe.
- State fixture/staging account policy.
- Include commands or MCP tool sequence used for validation.
- Attach sanitized artifact paths or summaries.
- Cross-link #699 if auth persistence behavior is relevant.
