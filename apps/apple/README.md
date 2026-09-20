# Apple native apps (spec §16)

`macOS/TxtMac` is the macOS app: SwiftUI scene + AppKit/TextKit editing surface
(`NSTextView`), standard toolbar/menu bar, and no WebView.

The shared core lives in `packages/TxtCore` (Swift Package): document model,
crypto contract, API client, sync engine, draft store and the editor bridge.
It is platform-free so both the macOS and the future iOS app use the same code,
and so its rules are unit-testable from the command line.

## Build and test

```sh
# Shared core: model, crypto vectors, editor bridge
cd packages/TxtCore && swift test

# macOS app
cd apps/apple/macOS
xcodebuild -project TxtMac.xcodeproj -scheme TxtMac -configuration Debug build
```

Signing uses the team and bundle ID in the project file; the entitlements
request the shared `webcredentials:txt.2-38.com` associated domain, which is
what lets a passkey created in Safari unlock the native app (spec §13).

## Verification notes

- `swift test` in `packages/TxtCore` covers the cross-implementation crypto
  vectors (KEK, document key, AADs, media chunk container), the document model
  and repair rules, and the editor bridge round-trip.
- The app writes a one-line trace to stderr when `TXT_DIAGNOSTICS=1` is set,
  which is how the boot flow is verified when the machine has no interactive
  session (AppKit cannot connect to the window server over SSH, and
  Accessibility automation is unavailable there).
