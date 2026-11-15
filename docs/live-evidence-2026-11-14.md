# Milestone A live evidence: 2026-11-14

Sanitized. One owner account, one region, owner present and approving each step
through the local approval file. Devices are described by role, not name or ID.
This is observation of unofficial interfaces on one account on one day; it is
not a compatibility or support claim.

| Operation | Result | Notes |
| --- | --- | --- |
| Interactive sign-in (proxy) | Works | Needed an `en-US` locale hint; the default German login page broke the flow. Benign gzip "Unzip" console errors appear from cut-off proxy responses. |
| Protected persistence | Works | Session file in an owner-only directory; ACL lists only the owner (inherited full control). |
| Refresh | Works | `refresh` reported `usable`, rewrote the session file; a new process then read data with the saved session. |
| Restart | Works | Every CLI run is a fresh process loading the saved session. Expiry/revocation was not observed. |
| Inventory read | Works | Echo devices, smart-home entries and routines returned. |
| Groups read | Works after a parser fix | Groups returned, all of kind `SPACE` (rooms). The response key is `applianceGroups`; the parser had expected `groups`. |
| DND read | Works | All devices off before the test. |
| Device state read | Works after a skill fix | See findings 1 and 2. Fresh `OK` health and `powerState` returned. |
| Harmless mutation (light on/off) | Works | `turnOn` and `turnOff` `accepted`; readback `verified`. Several calls returned `unknown`, see finding 3. |
| Explicit routine run by ID | Works | Routine spoke on an Echo Show; owner heard it. See finding 4. |
| DND write and restore (one Echo) | Works | Set true, read back true on exactly that device, restored to false, read back no device on. |
| Native DND duration | Not observed | Not tested. |
| Event connection observation (6.9) | Not tested | Optional. |
| Alexa+ commands, drop-in | Not tested | Library support exists for speak, announce and text commands; replies are only visible indirectly through activity history; no audio channel for drop-in. |
| Linux permissions | Not tested | |
| Expiry or revocation | Not observed | |

## Findings

1. **Retrievable flag.** A custom smart-home skill that advertised
   `retrievable: false` for a property makes state reads return empty. Setting
   `retrievable: true` and re-running account discovery fixed it.
2. **ID forms.** The endpoint-style ID returned empty with `ENTITY` and an error
   with `APPLIANCE`. The legacy appliance ID with `APPLIANCE` is what works for
   both state reads and control. Discovery is account-wide and cannot be limited
   to one skill.
3. **Intermittent `unknown` writes.** Some device writes returned a non-2xx or
   uncertain response and the device did not move, with no skill-side log entry.
   Retries after 12 to 15 seconds were accepted. Cause unconfirmed (suspected
   throttling, or the skill's cold start exceeding Alexa's wait).
4. **Routine runs return HTTP 200 with an empty body.** The write guard
   classed this `unknown` even though the routine ran. The patch now allows an
   empty 2xx body for the routine call only (`proofEmptyBodyOk`); the outcome
   is `accepted`, which still does not prove execution. Alexa regenerates the
   routine's `sequence.sequenceId` on every fetch, so it is excluded from the
   definition hash.
5. **`no_state`.** Empty state with no errors is reported as `no_state`, not as
   an error.
6. **Thermostat reads.** A thermostat-class device returned mode, fan, power and
   setpoint but no current room temperature. Mutating that class stays blocked.
7. **Hard-coded locale.** The library's routine call sends a hard-coded `de-DE`
   locale in the sequence JSON; routines still ran.
8. **Custom-skill latency.** A custom smart-home skill backed by a Lambda
   function showed slow first requests on a new instance (several seconds, not
   Lambda init), which can exceed the roughly 8 seconds Alexa allows for a
   smart-home reply and shows up as `unknown` writes. Raising Lambda memory and
   keeping skill-side retry waits and HTTP timeouts below Alexa's window
   helped. Alexa state reads are often served from its own cache (observed age
   of about 57 minutes) and can take 55 to 70 seconds and return
   `compatibility_error` right after a Lambda configuration change.

## Go/no-go for Milestone B

Go, conditional on:

- an explicit decision on how to treat `unknown` write outcomes (retry policy,
  verification by readback) given finding 3;
- rate and timeout behavior investigated, including the skill's cold start;
- reassessing every unofficial interface before any support claim;
- the DND native duration, event connection, Linux permissions
  and expiry/revocation remaining untested.
