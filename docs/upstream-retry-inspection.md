# Upstream retry and error inspection (REL-03, REL-04)

Source reviewed: `alexa-remote2` 8.1.1 and `alexa-cookie2` 5.0.6 from the
locked npm packages. These are source findings, not live-account evidence.

## Probe paths

| Probe | Pinned method and source location | Transport |
| --- | --- | --- |
| Echo inventory | `getDevices`, `alexa-remote.js:1460` | GET via `httpsGet` |
| Smart-home inventory | `getSmarthomeDevicesV2`, `:3436` | GraphQL POST via `httpsGet`; validates the endpoint items array |
| Groups | `getSmarthomeGroups`, `:3454` | GET via `httpsGet` |
| Routine metadata | `getAutomationRoutines`, `:3080` | GET via `httpsGet` |
| State read | `querySmarthomeDevices`, `:3569` | POST via `httpsGet`; response can contain per-item errors |
| DND read | `getDoNotDisturb` / `getDeviceStatusList`, `:2218` | GET via `httpsGet` |
| Harmless mutation | `executeSmarthomeDeviceAction`, `:3627` | PUT via `httpsGet` |
| Routine execution | `executeAutomationRoutine` / `sendSequenceCommand`, `:3091`, `:3029` | POST via `httpsGet`; requires routine object and target |
| DND write | `setDoNotDisturb`, `:2513` | PUT via `httpsGet` |

The package's TypeScript declaration describes the routine argument as a
string, but the implementation consumes a routine object and reads its
automation and sequence properties. The local adapter uses the observed
runtime signature; an offline contract test exercises the actual pinned methods
and checks their generated requests.

`httpsGet` (`:1180`) may check authentication and call `init` before dispatch.
On an authentication-check transport error it still attempts the request.
`init` (`:171`) can recursively initialize after invalid authentication or
missing registration material, starts its own refresh timer by default, and
falls back to cookie generation after refresh failure. A session manager must
not assume these behaviors satisfy single-owner refresh or no-login-loop rules.

`httpsGetCall` (`:1228`) retries a 503 once, and retries responses containing
throttling text once, regardless of HTTP method. The internal `isRetry` flag
suppresses those branches, but the public mutation methods do not expose that
flag. Merely wrapping their callbacks cannot prevent a nested retry. Live writes
remain blocked pending a safe interception or patch and fault-injection tests.
The same retry mechanism also affects read operations, including POST reads.
An offline loopback fault-injection test confirms two dispatches on a 503 for
each of the three pinned write methods; timeout, reset and 401 each produced
one dispatch in that baseline test. A versioned local patch now disables those
write retries and reports non-2xx, empty and throttling responses as errors.
The same tests against the patched version assert at most one dispatch and
classify post-dispatch errors as `unknown`. `npm install` applies the patch;
the internal write-response wrapper refuses dispatch if it is absent. A
successful callback remains an internal response, not a verified outcome.
Live writes still require the approval, journal, normalization and adapter
checks in the remaining tasks.

The transport reports 401 as an error but may return parsed JSON for other
non-2xx statuses without an error; it treats empty successful responses as
`{success: true}`. Malformed bodies, transport errors, timeouts and closed
connections take different callback paths. It does not expose a status to the
normal callback in the general case. A reliable normalizer cannot infer an HTTP
success status from a successful callback alone; the eventual adapter must
preserve the actual status and post-dispatch uncertainty.

The cookie helper's request function (`alexa-cookie.js:78`) follows redirects
recursively, turning redirected requests into GETs, without an evident redirect
limit in that function. Refresh (`:786`) performs token and cookie exchanges
and reports failures through callbacks. Both packages can log sensitive
request/response or registration data; never pass their raw logger messages to
the proof's output. The helper also defaults its login proxy to `0.0.0.0`
(`:205`); setup must explicitly enforce loopback binding and a time limit.
