These are synthetic, redacted protocol fixtures for known response shapes. They
are deliberately small and contain malformed/missing fields to exercise partial
results. They are not a HAR recording or evidence of access to a live account.

`social-browser.test.ts`, enabled with `OWNGATE_REAL_BROWSER_TEST=1`, executes real
Chromium page JavaScript and reads its real Playwright response events. Network
requests are fulfilled locally from these fixtures; no platform account is used.
Live acceptance still requires an operator to log in normally, record a redacted
HAR, and confirm endpoint/field semantics on each platform before calling that
connection supported.
