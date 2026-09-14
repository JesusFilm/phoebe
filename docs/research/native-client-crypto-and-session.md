# WebCrypto and secure storage on Electron and Expo for the secret envelope and the session

Research notes, 2026-09-14. Ticket #520, part of the relay map (#497). Two decided
mechanisms assume a browser: the secret envelope (#514) is ECIES built from WebCrypto
only (X25519, HKDF-SHA256, AES-256-GCM), and the session (#499, #506) is a `__Host-`
cookie the relay sets after a Google OIDC authorization-code flow. This note records what
a packaged Electron app and an Expo SDK 54 app can and cannot do with each. Facts only;
the sign-in ticket decides. Every claim cites the source that owns it; anything I could
not pin to a primary source is marked unverified.

Pins in the one current consumer (youtube-studio): `apps/resonance` pins `electron`
`30.5.1`, `apps/wheat` pins `^30.0.0`; the `expo` catalog pins `expo ~54.0.0` and
`react-native` `npm:react-native-tvos@0.81.5-2`.

## 1. Electron

### 1.1 Renderer WebCrypto is Chromium's, and X25519 arrived in Chromium 133

Chromium shipped "X25519 algorithm of the Web Cryptography API" enabled by default in
milestone 133 on desktop, Android, WebView and iOS; no flag; spec
https://w3c.github.io/webcrypto/#x25519. Source: chromestatus feature 6291245926973440,
https://chromestatus.com/feature/6291245926973440 (read through the JSON API at
https://chromestatus.com/api/v0/features/6291245926973440). The Intent to Ship is dated
2024-11-22: https://groups.google.com/a/chromium.org/g/blink-dev/c/A7lbRONS1lY/m/6J6wRdj4AAAJ.
Firefox is listed as shipped (bugzilla 1904836); Safari as "in development" (WebKit
258279), same chromestatus entry.

Ed25519 in WebCrypto is a separate entry (4913922408710144) and is still "In developer
trial (Behind a flag)" at milestone 137. The envelope does not need it; the relay
verifies Ed25519 in Node, not the browser.

Mapping to Electron majors, from https://releases.electronjs.org/releases.json:

| Electron | Chromium | Node | date | X25519 in renderer `crypto.subtle` |
|---|---|---|---|---|
| 30.0.0 | 124.0.6367.49 | 20.11.1 | 2024-04-15 | no (Chromium < 133) |
| 30.5.1 (last 30.x; youtube-studio's pin) | 124.0.6367.243 | 20.16.0 | 2024-09-12 | no |
| 34.x | 132 | 20.x | | no |
| 35.0.0 (first with X25519) | 134.0.6998.44 | 22.14.0 | 2025-03-04 | yes |
| 43.7.0 | 150.0.7871.250 | 24.21.0 | 2026-09-10 | yes |
| 44.3.0 (current stable) | 152.0.7977.78 | 24.20.0 | 2026-09-08 | yes |

The Electron 35 release post confirms Chromium 134.0.6998.44 / Node 22.14.0:
https://www.electronjs.org/blog/electron-35-0.

So #514's envelope as written does not run in the renderer of the pinned Electron 30.x.
Whether X25519 was reachable in Chromium 124 behind
`--enable-experimental-web-platform-features` is unverified: the Intent to Prototype
(2022-09-28, https://groups.google.com/a/chromium.org/g/blink-dev/c/n0uKIqfypW0/m/xu5UBbaBAwAJ)
and the Intent to Ship do not name a flag, and I did not test a 30.x binary. HKDF and
AES-GCM are in the base WebCrypto spec and were in Chromium long before 124; nothing on
chromestatus suggests otherwise.

The main process is a different story. Electron 30.5.1 bundles Node 20.16.0, and Node's
`crypto.subtle` gained `'X25519'` in v18.4.0 / v16.17.0. In Node 20.16 it is still marked
experimental (X25519 and Ed25519 became stable in v23.5.0, v22.13.0 and v20.19.3), but it
is present without a flag. `deriveBits`/`deriveKey` list `'X25519'` and `'HKDF'`;
`generateKey`/`encrypt` list `'AES-GCM'`. Source: https://nodejs.org/api/webcrypto.html
(stability 2, "Node.js provides an implementation of the Web Crypto API standard"). A
packaged Electron 30 app could therefore run the exact envelope code in the main process
(or a utility process) and hand the renderer the result over IPC; Electron 35+ can run it
in either.

### 1.2 The `__Host-` cookie: remote origin versus `file://` or a custom scheme

The prefix rules are MDN's: "Cookies with names starting with `__Host-` must be set with
the `Secure` attribute by a secure page (HTTPS). In addition, they must not have a
`Domain` attribute specified, and the `Path` attribute must be set to `/`." And:
"Insecure sites (`http:`) cannot set cookies with the `Secure` attribute. The `https:`
requirements are ignored when the `Secure` attribute is set by localhost." Source:
https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie.

Renderer loading the relay's `https://` origin directly (`win.loadURL('https://relay')`).
This is an ordinary Chromium page on an ordinary HTTPS origin. The relay's `Set-Cookie`
lands in the session's cookie jar and rides on same-origin `fetch` and `EventSource`
requests exactly as in a browser; `credentials` defaults to `same-origin` (MDN,
https://developer.mozilla.org/en-US/docs/Web/API/RequestInit). Nothing changes for #499
or #506 §10. Where the jar lives: a `partition` string starting with `persist:` "will use
a persistent session available to all pages in the app with the same partition"; without
the prefix "the page will use an in-memory session"; `ses.getStoragePath()` returns "the
absolute file system path where data for this session is persisted on disk. For in
memory sessions this returns null." Source:
https://github.com/electron/electron/blob/main/docs/api/session.md. Chromium's persistent
cookie store encrypts values through `net::CookieCryptoDelegate` ("Implements encryption
and decryption for the persistent cookie store",
https://chromium.googlesource.com/chromium/src/+/main/net/extras/sqlite/cookie_crypto_delegate.h)
backed by `components/os_crypt` ("cryptographic primitives that allow binding data to the
OS user", https://chromium.googlesource.com/chromium/src/+/main/components/os_crypt/README.md).
Whether Electron wires that delegate for every session is unverified; I did not trace the
Electron network-context code.

Renderer loading a bundled page over `file://` and calling the relay cross-origin. The
page's origin is `file://`, which the Secure Contexts spec treats as potentially
trustworthy ("If origin's scheme component is 'file', return 'Potentially Trustworthy'",
https://w3c.github.io/webappsec-secure-contexts/), so `crypto.subtle` works there. But the
session cookie belongs to the relay's origin, not to `file://`, so what matters is
cross-origin `fetch` with `credentials: 'include'`, which MDN says requires the server to
answer `Access-Control-Allow-Credentials` and an explicit (non-wildcard)
`Access-Control-Allow-Origin` (RequestInit page above). A `file://` page sends
`Origin: null`, and `Access-Control-Allow-Origin: null` is the only value that matches it;
whether Chromium will then store and replay a `__Host-` cookie for a request initiated
from a `file://` page is unverified. Cookies *on* the `file` scheme itself are off:
Chromium's cookieable-scheme list "defaults to 'http' and 'https'"; `file` was only added
"when file cookies are enabled via --enable-file-cookies"
(https://www.chromium.org/developers/design-documents/network-stack/cookiemonster/), and
that flag no longer works in current Chrome
(https://groups.google.com/a/chromium.org/d/msg/net-dev/47jdSKRnbqA/0hWYDY9t2gMJ). This only
matters if the relay and the page were the same origin, which they are not in this
layout.

Renderer loading a custom scheme (`app://`). Electron's `protocol.registerSchemesAsPrivileged`
takes `standard`, `secure`, `bypassCSP`, `allowServiceWorkers`, `supportFetchAPI`,
`corsEnabled`, `stream`, `codeCache`. The doc says "By default web storage apis
(localStorage, sessionStorage, webSQL, indexedDB, cookies) are disabled for non standard
schemes" and defines `standard` ("adheres to what RFC 3986 calls generic URI syntax. For
example http and https are standard schemes, while file is not") but never defines
`secure`. Source: https://github.com/electron/electron/blob/main/docs/api/protocol.md.
Cookies scoped to the custom origin itself remain unsupported: electron/electron#27981
"[Feature]: Support cookies on pages loaded over custom protocols" is still open
(2021-03-03, last comment 2025-03-06). As with `file://`, the relay's cookie is on the
relay's origin, so the question is again cross-origin `fetch` with `credentials:
'include'` from an `app://` origin plus CORS on the relay. That works in Chromium for
`https:` pages; for a page on a registered-secure custom scheme it is unverified.

Main-process alternative. `net.fetch` "will issue requests from the default session"; to
use another, "use ses.fetch()", which "sends a request, similarly to how fetch() works in
the renderer, using Chromium's network stack" (net.md and session.md above). Requests
from the main process to `https://relay` are same-origin from the cookie jar's point of
view, so the `__Host-` cookie set by the relay's callback response is stored and replayed
by the session with no CORS involved. `ses.cookies.set` needs a `url` ("The URL to
associate the cookie with. The promise will be rejected if the URL is invalid"); `secure`
"Defaults to false unless Same Site=None attribute is used", `httpOnly` "Defaults to
false", `sameSite` defaults to `lax`. Source: https://www.electronjs.org/docs/latest/api/cookies.
I did not verify whether `ses.cookies.set` accepts a `__Host-` name with `secure: true`
and `path: '/'` on an `https://` URL; Chromium's prefix checks apply to programmatic sets
in Chrome, so it should, but that is an inference.

### 1.3 `safeStorage` for a token at rest

`safeStorage` (main process only) offers `isEncryptionAvailable()`,
`encryptString(plainText) → Buffer`, `decryptString(buffer) → string`, async variants
(`encryptStringAsync`, `decryptStringAsync` returning `{ shouldReEncrypt, result }`),
`getSelectedStorageBackend()` (Linux: `basic_text`, `gnome_libsecret`, `kwallet`,
`kwallet5`, `kwallet6`, `unknown`) and `setUsePlainTextEncryption()` (Linux only). Backends
per the doc: macOS "Keychain" ("content is protected from other users and other apps
running in the same userspace"); Windows DPAPI (protects "content from other users on
the same machine, but not from other apps running in the same userspace"); Linux kwallet
variants, gnome-libsecret or the portal secret service, with the warning "If no secret
store is available, items stored ... will be unprotected as they are encrypted via
hardcoded plaintext password". Source: https://www.electronjs.org/docs/latest/api/safe-storage.
It returns ciphertext; where to keep it (a file under `app.getPath('userData')`) is the
app's job. It is what a bearer token would be wrapped in if the app holds one; a cookie
in a `persist:` session is already stored by Chromium and needs none of this.

## 2. Expo SDK 54 / React Native 0.81 / Hermes

SDK 54 package versions on the `sdk-54` branch of expo/expo: `expo` 54.0.37,
`expo-crypto` 15.0.9, `expo-secure-store` 15.0.8, `expo-web-browser` 15.0.11,
`expo-auth-session` 7.0.11 (each package's `package.json`,
https://github.com/expo/expo/tree/sdk-54/packages).

### 2.1 `globalThis.crypto.subtle` does not exist on Hermes

Hermes ships no `crypto` global. Its built-in library list (`lib/VM/JSLib/` on
facebook/hermes `main`: Array, ArrayBuffer, Base64, BigInt, DataView, Date, Intl, JSON,
Map, Math, Proxy, Reflect, RegExp, Set, TypedArray, WeakRef, ...) has no crypto entry, and
facebook/hermes#1003 "Expose important CSPRNG: crypto.getRandomValues" (2023) is still
open; PR facebook/hermes#2161 "Add crypto.getRandomValues as a JSI extension" (which
"installs `globalThis.crypto`" with only `getRandomValues`) is open and unmerged as of
2026-08-28. Sources: https://github.com/facebook/hermes/issues/1003,
https://github.com/facebook/hermes/pull/2161.

React Native 0.81.5 does not add one either: `Libraries/Core/` sets up globals, timers,
XHR, navigator and so on, with no crypto setup file
(https://github.com/facebook/react-native/tree/v0.81.5/packages/react-native/Libraries/Core).
Expo's WinterCG runtime shim for SDK 54 installs `TextDecoder`, `TextDecoderStream`,
`TextEncoderStream`, `URL`, `URLSearchParams`, `structuredClone` and a `FormData` patch,
not `crypto`
(https://github.com/expo/expo/blob/sdk-54/packages/expo/src/winter/runtime.native.ts). A
code search for `globalThis.crypto` in expo/expo finds only `expo-crypto`'s web
implementation and an Expo Go dev tool shim. Any claim that `crypto.subtle` is "available
on Hermes from RN 0.71+" (it turns up in secondary write-ups) does not match the engine
source and I treat it as false.

### 2.2 What `expo-crypto` 15.0.9 provides

`digestStringAsync`, `digest` (MD2, MD4, MD5, SHA-1, SHA-256, SHA-384, SHA-512),
`getRandomBytes`, `getRandomBytesAsync`, `getRandomValues`, `randomUUID`. All native
(Expo module) on Android, iOS, tvOS; web maps to the browser. Source:
https://docs.expo.dev/versions/v54.0.0/sdk/crypto/ and
https://github.com/expo/expo/blob/sdk-54/packages/expo-crypto/src/Crypto.ts. No
`subtle`, no AES-GCM, no HKDF, no X25519, no ECDH. It does not install itself onto
`globalThis.crypto` on native (the source imports `ExpoCrypto` and exports functions;
nothing writes to `globalThis`). So on its own it covers the envelope's random IV and
nothing else.

### 2.3 What `react-native-quick-crypto` 1.1.7 provides

Latest release v1.1.7 (2026-08-15). It is "C/C++ JSI with Nitro Modules and OpenSSL",
requires React Native 0.75+ for 1.x, depends on `react-native-nitro-modules`
(`>=0.31.2`; pinned dev version 0.33.2), and installs with
`import { install } from 'react-native-quick-crypto'; install();`, which sets
`global.crypto` and `global.Buffer`. It needs native code, so it runs in a development
build or `expo prebuild`, not Expo Go. Source: README at
https://github.com/margelo/react-native-quick-crypto and
`packages/react-native-quick-crypto/package.json`.

Its implementation-coverage document
(https://github.com/margelo/react-native-quick-crypto/blob/main/.docs/implementation-coverage.md)
marks as implemented: `crypto.subtle` with `deriveBits`, `deriveKey`, `digest`, `encrypt`,
`decrypt`, `exportKey`, `generateKey`, `importKey`, `sign`, `verify`, `wrapKey`,
`unwrapKey`, plus `encapsulate*`/`decapsulate*`; under `subtle.deriveBits`: `ECDH`,
`X25519`, `HKDF` all checked; under `subtle.decrypt`: `AES-GCM` checked; Node-style
`generateKeyPair` with `x25519` and `ed25519`, `createECDH`, `hkdf`/`hkdfSync`. That is
every primitive #514 §6 names, in native code. I did not run its test-suite; the
checkmarks are the maintainers' claim. The AES-GCM `generateKey` and `pkcs8` import gaps
tracked in margelo/react-native-quick-crypto#569 predate 1.x and the coverage table now
lists them as done; whether every WebCrypto edge (e.g. `importKey("raw", ..., "X25519")` of
a peer public key, which the envelope needs) behaves identically to Chromium is
unverified.

Bottom line for the envelope on Expo: with quick-crypto installed, the browser-side
envelope code can run unchanged against `globalThis.crypto.subtle`; without it there is
no X25519, HKDF or AES-GCM on the device, and any pure-JS alternative would be a new
dependency the design rejected.

### 2.4 `expo-web-browser` and `expo-auth-session` against a self-hosted relay

`WebBrowser.openAuthSessionAsync(url, redirectUrl, options)`. On iOS the module is a
Swift wrapper over `ASWebAuthenticationSession`
(https://github.com/expo/expo/blob/sdk-54/packages/expo-web-browser/ios/WebAuthSession.swift).
On iOS 17.4+/macOS 14.4+, if `redirectUrl` is `https://` URL with a host it constructs the
session with `callback: .https(host:path:)`; otherwise it falls back to
`callbackURLScheme: redirectUrl.scheme`; `options.preferEphemeralSession` maps to
`prefersEphemeralWebBrowserSession`. Apple's docs: the class is available from iOS 12 /
macOS 10.15; "In iOS, the browser is a secure, embedded web view"; the `https(host:path:)`
callback (iOS 17.4, macOS 14.4) requires that "The host must be a member of a domain
associated with the app" (Associated Domains / universal links);
`prefersEphemeralWebBrowserSession` asks "that the browser doesn't share cookies or other
browsing data between the authentication session and the user's normal browser session.
Safari always respects the request", default `false`. Sources:
https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession,
.../callback/https(host:path:), .../prefersephemeralwebbrowsersession.

On Android there is no native auth session; the JS says "If there is no native
AuthSession implementation available (which is the case on Android) these params will be
used in the browser polyfill", which opens a Chrome Custom Tab and resolves when
`Linking` delivers a URL matching `redirectUrl`
(https://github.com/expo/expo/blob/sdk-54/packages/expo-web-browser/src/WebBrowser.ts).
Custom Tabs share the browser's state: "Shared cookie jar and permissions model so users
don't have to sign-in to sites they are already connected to"
(https://developer.chrome.com/docs/android/custom-tabs). So on Android the user's Google
login in Chrome is reused, and any cookie the relay sets during the flow lands in
Chrome's jar, not the app's.

`expo-auth-session` 7.0.11. `AuthRequest` defaults to `ResponseType.Code` with
`usePKCE: true` and `CodeChallengeMethod.S256`; `fetchDiscoveryAsync` / `useAutoDiscovery`
read an OIDC issuer's discovery document; `exchangeCodeAsync` posts to `tokenEndpoint`,
adding `Authorization: Basic base64(client_id:client_secret)` when a `clientSecret` is
given and `client_id` in the body otherwise
(https://github.com/expo/expo/blob/sdk-54/packages/expo-auth-session/src/TokenRequest.ts).
`makeRedirectUri({ native, scheme, path, preferLocalhost })` returns `native` verbatim in
standalone/bare builds when given, else `Linking.createURL(path, { scheme })`; the docs say
"You must define the URI scheme that will be used in a custom built native application"
(https://docs.expo.dev/versions/v54.0.0/sdk/auth-session/). The Google provider defaults
the native redirect to `${Application.applicationId}:/oauthredirect` (a commented-out
alternative is `com.googleusercontent.apps.${guid}:/oauthredirect`) and disables PKCE for
implicit response types
(https://github.com/expo/expo/blob/sdk-54/packages/expo-auth-session/src/providers/Google.ts).
The docs carry one hard warning: "Never put any secret keys inside your application code,
there is no secure way to do this!"

What Google accepts as a redirect URI depends on the OAuth client type, and this is the
constraint that shapes the relay's side:

- Web application clients (what #499 chose; the relay holds the secret): "Redirect URIs
  must use the HTTPS scheme, not plain HTTP. Localhost URIs (including localhost IP
  address URIs) are exempt from this rule." "Hosts cannot be raw IP addresses." No
  fragment, no userinfo, no path traversal. Custom schemes are not allowed. Source:
  https://developers.google.com/identity/protocols/oauth2/web-server (Validation rules).
- Installed (iOS/Android/desktop) clients: custom URI scheme
  `com.googleusercontent.apps.123:redirect_uri_path` (reverse DNS of the client id), but
  "Custom URI schemes are no longer supported on Android and Chrome apps" and "Custom
  URI schemes are no longer supported due to the risk of app impersonation"; loopback
  `http://127.0.0.1:port` for macOS/Linux/Windows desktop, "DEPRECATED for Android,
  Chrome app and iOS OAuth client types"; "The client_secret is not applicable to
  requests from clients registered as Android, iOS, or Chrome applications." PKCE
  `code_challenge` recommended. Source:
  https://developers.google.com/identity/protocols/oauth2/native-app.

Put together: a native app cannot complete #499's flow against Google directly with the
relay's Web client, because Google will only redirect to the relay's `https://` callback.
The shape that satisfies both sides is Google → `https://relay/auth/callback` (the relay
exchanges the code with its secret, as today) → the relay redirects a second time to the
app, either a custom scheme a `myapp://` URL (matched by `callbackURLScheme` on iOS and
`Linking` on Android) or an `https://` universal/app link the app owns (matched by
`.https(host:path:)` on iOS 17.4+). The relay then needs to accept and register one
callback URI with Google (its own) and hand the app something on that final hop. What it
hands over is the choice in §3.

### 2.5 `expo-secure-store` 15.0.8 for a token at rest

"On Android, values are stored in SharedPreferences, encrypted with Android's Keystore
system"; the SDK 54 implementation's `AESEncryptor` uses a Keystore AES key with
`GCMParameterSpec` per value
(https://github.com/expo/expo/blob/sdk-54/packages/expo-secure-store/android/src/main/java/expo/modules/securestore/encryptors/AESEncryptor.kt).
"On iOS, values are stored using the keychain services as `kSecClassGenericPassword`",
with `keychainAccessible` selectable (`WHEN_UNLOCKED`, `AFTER_FIRST_UNLOCK`,
`WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`, and `_THIS_DEVICE_ONLY` variants); the default is
`whenUnlockedThisDeviceOnly` (rendered docs). "Size limit for a value is 2048 bytes. An
attempt to store larger values may fail." `requireAuthentication` gates reads behind
biometrics, and "any data protected with the `requireAuthentication` option set to `true`
will become inaccessible if there are changes to the user's biometric settings". "Data
saved using `expo-secure-store` will not be preserved upon app uninstallation" (the
`sdk-54` MDX; the current rendered page adds that iOS keychain items can survive a
reinstall with the same bundle id, which is Apple behaviour, not Expo's). Android Auto
Backup must exclude its preferences because "app's entries are deleted from the Android
Key Store when the app is uninstalled". Not available on web. Sources:
https://github.com/expo/expo/blob/sdk-54/docs/pages/versions/v54.0.0/sdk/securestore.mdx,
https://docs.expo.dev/versions/v54.0.0/sdk/securestore/. A session token fits easily
under 2048 bytes; the box-key material never needs to live here, it is public.

## 3. Both: can the relay's `__Host-` cookie be reused from a native HTTP client?

From Electron's main process or a `persist:` session, yes, without qualification: it is
Chromium's cookie jar talking to an `https://` origin (§1.2). The cookie is set by the
relay's callback response only if the callback is loaded by that same session, which
means either the renderer loads the relay directly or the main process drives the
sign-in in a `BrowserWindow` on the same partition.

From React Native's `fetch`, the answer is "the platform's jar, with caveats". RN's
`fetch` is `whatwg-fetch` over RN's own `XMLHttpRequest`
(https://github.com/facebook/react-native/blob/v0.81.5/packages/react-native/Libraries/Network/fetch.js),
whose `withCredentials` defaults to `true`
(.../Libraries/Network/XMLHttpRequest.js line 154). On iOS the request handler uses
`NSURLSessionConfiguration.defaultSessionConfiguration` with `HTTPShouldSetCookies = YES`,
`NSHTTPCookieAcceptPolicyAlways` and `NSHTTPCookieStorage.sharedHTTPCookieStorage`, and
on redirect it re-attaches cookies by hand ("Reset the cookies on redirect. This is
necessary because we're not letting iOS handle cookies by itself",
.../Libraries/Network/RCTHTTPRequestHandler.mm). On Android OkHttp is wired to a
`ForwardingCookieHandler` that "forwards all cookies to the WebView CookieManager" and
"relies on CookieManager to persist cookies to disk so cookies may be lost if the
application is terminated before it syncs"
(.../ReactAndroid/src/main/java/com/facebook/react/modules/network/ForwardingCookieHandler.kt).
The RN docs list `credentials: omit` and `redirect: manual` as "currently not working
with fetch", say "Cookie based authentication is currently unstable" (facebook/react-native#23185),
and warn that on iOS "when redirected through a 302, if a Set-Cookie header is present,
the cookie is not set properly" (https://reactnative.dev/docs/network). `expo/fetch`
(SDK 54's WinterCG fetch) defaults `credentials` to `'include'` and its types note
`same-origin is not supported`
(https://github.com/expo/expo/blob/sdk-54/packages/expo/src/winter/fetch/fetch.ts,
NativeRequest.ts).

Two things follow for the relay's cookie specifically:

1. A `__Host-` cookie is just a `Secure; Path=/` cookie without `Domain`; the native
   stacks (NSHTTPCookieStorage, Android CookieManager) store and replay it for
   `https://relay` like any other. The prefix's extra checks are enforced by the user
   agent that receives the `Set-Cookie`, and whether NSHTTPCookieStorage or Android's
   CookieManager enforce the `__Host-` rules is unverified (RFC 6265bis puts the checks on
   the UA; MDN documents browsers). Nothing in the prefix breaks native replay.
2. The cookie is only *set* in the app's jar if the app's own HTTP stack loads the
   callback response. In §2.4's shape the callback is loaded by ASWebAuthenticationSession
   (a system web view whose jar the app cannot read) or a Chrome Custom Tab (Chrome's
   jar), so the relay's `Set-Cookie` never reaches the app's NSHTTPCookieStorage or
   CookieManager. The redirect back to the app carries only what the relay puts in that
   URL. With `preferEphemeralSession`, even the Google login cookie is discarded after
   the flow.

So a native app can reuse a `__Host-` session cookie only when its own networking stack
fetched the page that set it. In the Electron-loads-remote-origin and
Electron-main-process cases that holds. In the Expo case it does not, which is why the
last hop back to the app has to carry a credential of some shape (a one-time code the
app exchanges over `fetch` for a session cookie set on the app's jar, or a bearer token
stored in SecureStore and sent as a header). Which of those, and whether the relay grows a
second session shape or reuses the in-memory session map behind a header, is the sign-in
ticket's call. The relay's in-memory session (#506 §3) is indifferent to which carrier
delivers the id.

## 4. Summary table

| Need | Electron 30.5.1 | Electron 35+ / 44.3.0 | Expo SDK 54 (RN 0.81.5, Hermes) |
|---|---|---|---|
| X25519 in renderer/JS `crypto.subtle` | no (Chromium 124) | yes (Chromium ≥ 133) | no `crypto.subtle` at all without a library |
| X25519 + HKDF + AES-GCM anywhere in-process | main process, Node 20.16 (X25519 experimental, no flag) | main or renderer | `react-native-quick-crypto` 1.1.7, native OpenSSL, `install()` sets `global.crypto`; dev build only |
| `expo-crypto` | n/a | n/a | digests, random bytes, `randomUUID` only |
| `__Host-` cookie stored and replayed | yes, if the session loads the relay origin | same | only if the app's own stack loaded the callback; system auth sessions keep it |
| Sign-in surface | `BrowserWindow` on the relay's `https://` origin | same | `openAuthSessionAsync` (ASWebAuthenticationSession / Custom Tab), redirect back via custom scheme or `https` universal link |
| Google redirect URI the relay registers | its own `https://` callback (Web client) | same | same; Google refuses custom schemes on the Web client and for Android clients |
| Token at rest | `safeStorage` (Keychain / DPAPI / libsecret-kwallet, plaintext fallback on Linux) | same | `expo-secure-store` (Keychain `kSecClassGenericPassword` / Keystore AES-GCM), 2048-byte cap |

## 5. Unverified, listed once

- X25519 behind a Chromium flag before M133 (would matter for Electron 30 renderers).
- Electron enabling `CookieCryptoDelegate`/OSCrypt encryption on its persistent cookie
  store.
- Chromium's handling of `credentials: 'include'` cookies for requests initiated from a
  `file://` or registered-secure custom-scheme page.
- `ses.cookies.set` accepting a `__Host-`-prefixed name.
- `__Host-` prefix enforcement inside NSHTTPCookieStorage and Android CookieManager.
- Byte-for-byte WebCrypto parity of react-native-quick-crypto's X25519 `importKey('raw')`
  with Chromium/Node.
