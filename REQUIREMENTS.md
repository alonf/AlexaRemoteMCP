# Alexa MCP: Product and Engineering Requirements

**Status:** Proposed implementation specification, not a working-server claim  
**Version:** 0.1  
**Research date:** 13 November 2026  
**Intended publication:** Public GitHub repository, independent implementation  
**Working name:** Alexa MCP (final repository/package name subject to availability)

## 1. Product decision

Build a self-hosted Node.js/TypeScript MCP server that lets authorized MCP clients read Alexa-connected household information and perform explicitly permitted actions. Use the existing **alexa-remote2** library rather than porting Amazon connectivity to C# or rebuilding its authentication and private endpoints.

The first release is a **fully functional, single-instance product**, not merely a connectivity demonstration. It includes the validated end-user capability surface of the selected library, secured remote MCP access, reliable authentication persistence, useful diagnostics, deployment documentation, and tests. It deliberately excludes distributed deployment and high availability. Connectivity spikes are internal milestones toward this release, not a reduced substitute for it.

Create a new codebase, new package identity, and new repository. Do not fork the existing stdio MCP project, wrap its subprocess, inherit its implementation, or depend on its package. It is a comparison reference only. Reusing alexa-remote2 and complying with its license is intentional.

**Terminology:** stdio is a valid MCP transport. This project's differentiation is a native, independently hosted **Streamable HTTP MCP endpoint**, not being “more real” MCP. HA in this document means **high availability**, not Home Assistant.

### Success

A household administrator can install one service on a supported server or VM, complete Amazon sign-in securely, connect a supported MCP client, discover available devices and capabilities, read supported states, run approved routines, and manage supported settings without maintaining a process on every client computer. The operator can understand what succeeded, what Amazon merely accepted, what is unsupported, and what is unknown.

### Non-goals for the MVP

- Kubernetes, Dapr, Aspire, brokers, distributed databases, multiple workers, active/standby, or cluster failover.
- Reimplementing alexa-remote2 in another language.
- Home Assistant integration or dependency.
- A hosted multi-tenant commercial service, multiple Amazon accounts per installation, or universal compatibility with every Alexa region/device/skill.
- Camera video, recorded footage, microphone access, or general sensor history without demonstrated upstream support.
- Replacing safety systems, emergency notifications, physical controls, or the Alexa app.
- A claim that Alexa+ is fully supported before account-specific validation.

## 2. Evidence, assumptions, and limitations

The comparator currently registers 18 tools in its source: Echo/smart-home/group inventory, announcement, text command, volume get/set, routine list/run, list inventory/items/add, single-device DND, smart-home state query, SSML, and group create/update/delete. Its lockfile references alexa-remote2 8.1.1. These are **static source findings**, not proof that every endpoint currently works on a real account. [S1–S3]

The library uses Alexa/Amazon cloud interfaces rather than direct local Echo control. Connectivity therefore depends on Amazon internet services, account authentication, regional behavior, and undocumented interfaces. Running at home does not remove those dependencies. The library exposes considerably more than the comparator's tools. The selected library version must be pinned and independently tested; 8.1.1 is the inspected reference, not a recommendation that it is the newest or best release. [S4]

No Amazon account was used to certify functionality for this requirements document. Code-present functionality is a candidate until runtime validation. Every release must publish a dated compatibility matrix stating account region, locale, device family, library version, protocol/client versions, and test status without exposing household identifiers.

“Full capability coverage” means every end-user library operation is accounted for and each feasible supported operation has a suitable interface. It does **not** mean exposing raw networking helpers, leaking credentials, or pretending removed Amazon APIs work. Any deferred or excluded end-user capability requires a documented reason and explicit release-scope decision; it must not disappear silently from the MVP.

## 3. Users and use cases

1. **Household operator:** Installs and updates the server, signs in, grants permissions, diagnoses failed operations, and revokes access.
2. **MCP client user:** Discovers capabilities, reads state, and requests actions through an authorized assistant.
3. **Open-source contributor:** Adds or fixes adapters with sanitized test fixtures and reproducible compatibility reports.

Representative scenarios:

- “Which devices and rooms are available, and which of them can report state?”
- “Run this saved routine on this Echo,” by stable ID rather than a guessed spoken phrase.
- “Enable DND on these Echo devices until a specified time, preserving previous settings.”
- “Report which devices failed to change and which changes were verified.”
- “Query the states of these lights, then set a supported brightness.”
- “Read my reminders and add one at a timezone-specific time.”
- “What is playing, and set the volume on this device?”

Device names, routine text, lists, history, and other returned content are untrusted data. They cannot grant new privileges or become instructions to the server or assistant.

## 4. Architecture and boundaries

### 4.1 Single-instance architecture

**Authorized MCP client → HTTPS endpoint → MCP transport and authorization → typed capability services → Alexa adapter → alexa-remote2 → Amazon cloud**

Alongside these components: a protected single-node persistence store, one authentication/session manager, a bounded command executor, timed-action reconciliation, and redacted diagnostics.

**ARCH-01:** One long-running application instance owns one Amazon session and any optional upstream event connection. Multiple clients may connect; this must not create duplicate sessions, initializations, refresh loops, or pollers.

**ARCH-02:** Separate transport, policy, business operations, adapter, and persistence. MCP handlers must not call arbitrary Amazon endpoints directly.

**ARCH-03:** Use TypeScript with strict checking, typed request validation, normalized results, and a narrow adapter around callback-based upstream methods. Keep unknown upstream capability data available safely without making it executable.

**ARCH-04:** Use a durable local store, proposed SQLite, for operation records, setting snapshots, restoration deadlines, and configuration revisions. A protected credential store may be separate. Do not require Redis, RabbitMQ, external databases, or a cloud subscription.

**ARCH-05:** Default to bounded per-account concurrency and serialization for conflicting mutations. Enforce per-device ordering when operations conflict. Batch independent reads only where the backend supports them.

**ARCH-06:** A service restart recovers durable records and timed work. It does not blindly replay any operation that may already have reached Amazon.

### 4.2 Remote MCP contract

**MCP-01:** Use the official maintained MCP SDK and native Streamable HTTP. Record supported protocol revisions and test their actual client negotiation/compatibility behavior. Do not hardcode assumptions from an older MCP session model. [S8]

**MCP-02:** Provide stable tool names, clear descriptions, validated input and output schemas, structured content, meaningful error codes, and accurate read-only/destructive/idempotent annotations where the negotiated SDK supports them. An annotation is not an authorization mechanism.

**MCP-03:** Provide capability discovery with support state, permissions, device constraints, verification method, and limitations. Paginate large data. Bound arrays, text, request sizes, execution times, and concurrent operations.

**MCP-04:** Implement cancellation and disconnect handling according to the selected protocol revision. A disconnected caller does not establish that an already-dispatched Alexa action was cancelled.

**MCP-05:** Long-running operations use a stable operation ID and a status lookup if they cannot complete within client limits. Use a protocol-native task facility only when supported and tested; otherwise a documented application operation resource is sufficient.

**MCP-06:** Version tool schemas deliberately, with migration notes for breaking changes. Validate against MCP Inspector and at least two independent clients, including the intended remote assistant client.

## 5. Functional MVP scope and comparison

Legend: **Baseline** = represented in comparator tools. **Additional** = not exposed there, or substantially expanded. **Conditional** = upstream/device/account verification required. **Restricted** = implemented only behind a specific operator permission, not enabled for general assistants by default.

| Capability family | MVP requirement | Difference and evidence |
|---|---|---|
| Discovery | Echo devices, smart-home entities/devices, groups, capabilities, supported actions, routine metadata | Baseline plus richer normalized inventory; S4 |
| State | Batch smart-home state query, per-device errors, timestamps and freshness, capability descriptions | Baseline plus consistent partial-result semantics |
| Direct smart-home control | Validated actions for capabilities actually advertised by each target, with safe type-specific schemas | Additional: upstream executeSmarthomeDeviceAction |
| Routines | List, inspect, execute existing saved routine by ID with explicit target where required | Baseline; eliminate arbitrary client-supplied automation objects |
| Speech | Plain speech, announcements, SSML with validated content and permitted target sets | Baseline plus tested multi-device targeting |
| Text commands | Supported text-command execution with strong restrictions and outcome uncertainty | Baseline; not a way around device/tool permissions |
| Volume and audio | Read/set volume, supported player/media state and playback commands, queue, supported providers and whole-home groups | Volume baseline; broader media additional |
| DND | Read state, set one/selected/all authorized Echoes, native duration where validated, timed restoration and reconciliation | Strong additional coverage over boolean single-device baseline |
| Bluetooth | Read paired/connected state; supported connect, disconnect and unpair | Additional; unpair restricted |
| Lists | Read lists/items, add/update/delete supported items, pagination/concurrency where supported | Read/add baseline; update/delete additional |
| Notifications | Read alarms/reminders; create, change, activate/deactivate/cancel/delete supported types; sound/volume and ascending alarm options | Additional; changes affecting alarms restricted |
| Device settings | Typed supported preference/settings operations, including display/brightness/equalizer/speaker options where present | Additional; never imply all devices expose all settings |
| Group management | Read/create/update/delete groups; preview full membership changes; conflict checks | Baseline with safer mutation workflow |
| Device management | Supported rename, rediscovery, enablement, device removal, and bulk removal | Additional; destructive removal disabled by default and explicitly confirmed |
| Account metadata | Minimal account/household metadata needed for capability resolution and administration | Additional; sensitive details omitted by default |
| Skills/catalogs | Read available skills, routine action/sound catalogs, provider metadata where supported | Additional; do not imply skill installation is available |
| History/cards | Optional bounded activity/history/card reads with strict privacy controls and retention | Additional; restricted and independently validated |
| Communications | Optional supported contacts/conversation reads and send/delete operations | Additional; restricted, recipient-specific authorization; never general background outreach |
| Upstream events | Optional validated event ingestion, normalized timestamps, bounded local event buffer and diagnostics | Additional; not a promise of all smart-home events |
| Operations/health | Capabilities, authenticated session health, service status, operation status and sanitized diagnostics | Additional platform functionality |

### 5.1 Exhaustive capability ledger

**CAP-01:** Before freezing the MVP scope, generate a ledger from every public method and meaningful command/settings variant in the pinned upstream version. A method count alone is insufficient because sequence and settings methods carry many operations.

For each entry record: upstream method/version; end-user meaning; exposed tool/resource; read/write/risk class; schemas; region/device prerequisites; source evidence; authentication needs; retry policy; verification strategy; tests; support state; exclusion/defer reason where applicable.

**CAP-02:** Categorize internal lifecycle/network/authentication helpers as internal, not user-facing omissions. Do not expose generic `httpsGet`, arbitrary URL fetches, unrestricted raw sequence JSON, tokens, registration secrets, or a generic “execute any method” tool.

**CAP-03:** Support states are `verified`, `experimental`, `unsupported`, `disabled_by_policy`, and `temporarily_unavailable`. Experimental status must not be presented as proven support. A disabled capability may be implemented without being allowed for a particular principal.

**CAP-04:** Core claimed functionality must pass live-account acceptance before a stable release. Where a device or account cannot test a family, publish that limitation and obtain a scope decision rather than marking the family complete by source inspection.

### 5.2 Important restrictions

- A thermostat, lock, door, security system, or other safety-relevant device requires a separately reviewed action policy. Generic text commands and saved routines must not bypass it.
- Routines can contain consequential actions. Allowlist routine IDs and record a reviewed definition/version hash; require renewed approval when a definition changes materially or cannot be inspected adequately.
- Do not support purchases, payments, account security changes, or emergency response through open-ended Alexa commands.
- Do not infer that turning on DND suppresses every kind of alarm, Ring announcement, routine, call, or sound. Test and publish actual behavior for supported devices and configurations.
- Creating/editing entire routine definitions is not promised merely because execution is available. Add only if a supported, validated route exists; otherwise document the exclusion.
- Group creation/update in the comparator uses direct endpoints. Review and implement a separate adapter if the selected library lacks those methods; do not copy the comparator or claim they are library-native.

## 6. Reversible temporary settings: first-class use case

**TEMP-01:** A temporary DND request identifies exact devices or a previewed inventory snapshot, start/end or duration, timezone, desired state, and restoration policy. “All devices” means the authorized devices resolved at approval time, not future unknown devices.

**TEMP-02:** Read and durably record existing per-device values before modifying them. Unknown initial state is an explicit failure/approval decision, not an assumed false value.

**TEMP-03:** Prefer Amazon's native duration feature when supported and verified. Upstream includes duration-related behavior, but actual expiry, timezone and device behavior must be tested. For a local restoration timer, state that restoration needs the service and Amazon to be reachable.

**TEMP-04:** Persist an operation ID, source state, desired state, per-device outcome, deadline, and revision before dispatch. Report partial changes. Do not roll back successful devices automatically when doing so might undo a user's later changes.

**TEMP-05:** At expiry, read current values. Restore only values still attributable to this managed operation and unchanged since it, using upstream revisions if available. Without upstream revision/history, equality alone cannot prove that the user did not change a value away and back. Document this limitation and use a conservative conflict policy rather than claiming perfect compare-and-swap.

**TEMP-06:** Detect known manual changes, superseding temporary operations, and cancellations. Never overwrite a newer explicit user request. On restart, reconcile expired and outstanding operations; report missed/uncertain restorations without fabricating success.

**TEMP-07:** Distinguish “restore original state” from “disable DND.” Devices that began with DND enabled must not be switched off as a blanket cleanup.

Acceptance includes timezone/DST boundaries, service restart, unavailable Echo, unavailable Amazon, overlap, manual changes, unchanged values, and a failed persistence write.

## 7. Authentication and security

### 7.1 Two separate trust boundaries

**SEC-01:** Amazon account authentication and MCP-client authorization are separate. Amazon cookies must never serve as MCP credentials. MCP access tokens must never be forwarded to Amazon.

**SEC-02:** Provide a documented, secure remote-access profile compatible with MCP's current HTTP authorization specification and the selected clients. Prefer a maintained OAuth authorization component rather than inventing authentication. Validate token audience, issuer, expiry, scope, and revocation behavior. Reject token passthrough. A narrowly scoped static token may be an explicitly documented private-network option only for clients that support it; it is not a substitute for required OAuth interoperability. [S9]

**SEC-03:** Default binding is loopback. Remote access requires deliberate authenticated configuration and TLS termination. Validate Host/Origin as appropriate, reject DNS rebinding, constrain CORS, trust forwarded headers only from configured proxies, and limit request rates and body sizes. No unauthenticated LAN-wide “convenience mode.”

### 7.2 Amazon session lifecycle

**AUTH-01:** Support interactive owner sign-in using the library's supported registration/login flow. The owner completes password/MFA/CAPTCHA challenges directly in the protected login flow; secrets are never requested through ordinary MCP tools or model conversation.

**AUTH-02:** Keep the setup/login interface separate from the normal MCP route. A local login proxy binds to loopback and exists only during an authenticated, time-limited setup session. Remote setup requires a documented secure administrative path, not exposing the login proxy publicly.

**AUTH-03:** Persist all session/registration data required by the selected library, including refresh and signing material where applicable, atomically and with restrictive OS permissions. Treat the entire session file as highly sensitive. If encryption is used, protect its key separately; an adjacent key file is not sufficient protection from an equivalent filesystem compromise.

**AUTH-04:** One manager owns initialization and refresh. Concurrent callers join an in-flight operation. Persist refresh events; detect write failures; expose `reauthentication_required` without looping or continuing to claim healthy persistence. Support restart, refresh, expiry, revocation, and explicit logout/local credential removal.

**AUTH-05:** Configurable Amazon region/domain, language, timezone, and supported registration settings. No hardcoded one-region or one-language assumption. Sensitive overrides must be allowlisted, not arbitrary network destinations.

### 7.3 Least privilege and privacy

**SEC-04:** Authorization covers principal, tool family, target device/group/routine, and risk. Read-only access is default. Separate policy for reversible control, settings, destructive administration, history, and communications.

**SEC-05:** High-impact operations require a deliberate authorization workflow bound to the exact targets and parameters. A model-supplied `confirmed: true` flag is not evidence of owner confirmation. Use an authenticated operator approval path or configured explicit policy.

**SEC-06:** Secrets, raw cookies, account identifiers, contact details, routine contents, transcripts, Wi-Fi details, private device labels, and household locations must not appear in default logs, metrics, errors, telemetry, crash reports, screenshots, examples, or public fixtures.

**SEC-07:** Privacy-sensitive reads are opt-in and bounded by date/count. No background collection of voice history or communications by default. Provide configurable retention and local data deletion, without silently deleting Amazon data.

**SEC-08:** Validate SSML and constrain external media references. Prevent injection, unintended remote content retrieval, SSRF, and arbitrary command/network escape paths. Returned text stays data.

**SEC-09:** Publish a threat model, security reporting policy, dependency/SBOM and secret-scanning practices. Never request contributors' real session files to diagnose an issue.

## 8. Outcomes, retries, and consistency

**REL-01:** Every mutation has an application operation ID, normalized arguments hash, target set, dispatch timestamp, and per-target result. Client-supplied idempotency keys are scoped to the authenticated principal. Reuse with different arguments is rejected.

**REL-02:** Result states distinguish `rejected`, `not_dispatched`, `accepted`, `verified`, `failed`, `partially_applied`, and `unknown`. An HTTP callback without an error proves neither physical execution nor audible playback. Verification records its source and time.

**REL-03:** Normalize non-2xx status, transport failure, malformed/empty payload, and per-device failures. Inspect upstream automatic retries and error handling, including retries that can occur beneath the adapter. Disable or safely patch unsafe write retries; merely adding an outer retry policy is insufficient.

**REL-04:** Bounded retries with jitter may apply to safe reads and proven pre-dispatch failures. A timeout after dispatch is uncertain. Do not automatically repeat announcements, messages, routines, list additions, or other non-idempotent writes. Idempotent-looking target-state changes also require consideration of newer user intent before replay.

**REL-05:** Where possible, perform state readback. If Amazon reports stale state or a capability has no readback, return `accepted` or `unknown` with a reason. Never invent a verified result.

**REL-06:** Persist before dispatch and after outcome. A crash between external execution and local recording cannot be made exactly-once by a local journal. Recover as uncertain and reconcile. Document the residual risk.

**REL-07:** Inventory and state results distinguish fetchedAt, source/event timestamp, cache status, age, and per-item errors. Missing timestamps or missing values are unknown. A present device record is not evidence that its sensor state is retrievable.

**REL-08:** Timeouts, bounded queues, rate limits and a circuit breaker prevent retry storms during an Amazon outage. Health checks must not repeatedly sign in or generate unnecessary backend traffic.

## 9. Alexa+ compatibility plan

Alexa+ is a mandatory compatibility investigation, not a separate implementation assumption. Official skill/device integration announcements do not certify undocumented consumer-account APIs. An open upstream issue asks about Alexa+ compatibility without a definitive maintainer guarantee. [S10–S12]

**PLUS-01:** Test the actual target account for sign-in/refresh, Echo and smart-home inventory, state retrieval, explicit routine execution, speech, DND, and events. Record whether Alexa+ is enabled/available and record region/locale/device family.

**PLUS-02:** Prefer deterministic IDs and typed operations. Natural-language commands may be reinterpreted by Alexa+ and must not be used as proof that an exact saved routine ran.

**PLUS-03:** Preserve extensible upstream capability schemas and unknown fields safely. Do not flatten new capabilities into misleading booleans. Handle unknown enums and response shapes with explicit compatibility errors.

**PLUS-04:** Review event framing, fragmentation and reconnect behavior. Upstream event issues are evidence of risks to test, not proof that Alexa+ causes them. Do not expose an event feature as reliable merely because a connection opens. [S13]

**PLUS-05:** Publish separate verified/experimental/unsupported matrix entries. When an upstream change breaks an operation, disable or mark that operation unavailable while retaining unaffected reads and controls.

## 10. Deployment and operations

**DEP-01:** Offer two first-class single-instance paths: a documented Docker/Compose installation on a supported Linux host/VM, and a native Node.js installation for supported Windows/Linux systems. A dedicated Hyper-V Linux VM is a supported deployment pattern. No Kubernetes prerequisite.

**DEP-02:** Select a supported Node LTS and pin the supported range after testing. Pin dependencies and ship a lockfile. Images use non-root execution, versioned tags and persistent protected volumes. Publish architecture support only for builds actually tested.

**DEP-03:** Provide one-service startup, OS/container restart policy, graceful shutdown, liveness/readiness, and a protected diagnostic command. Readiness distinguishes “process is running” from “Amazon authentication usable.”

**DEP-04:** Include minimal configuration examples, setup, remote HTTPS/auth integration, backup/restore, update/rollback, credential rotation, uninstall and troubleshooting. Never bundle working secrets or household-specific examples.

**DEP-05:** A cloud MCP client must have a reachable authenticated endpoint. LAN-only binding does not make it reachable from the cloud. Document supported ingress/reverse-proxy/tunnel patterns and their security consequences without automatically opening firewall ports or publishing credentials.

**DEP-06:** Test restoring the durable store and credentials onto a replacement single host. Backups receive equivalent secret protection. This is recovery, not HA or a zero-downtime promise.

**DEP-07:** Default telemetry is off; operational metrics are local and privacy-preserving. Useful metrics: request/error latency, queue depth, auth state, last refresh, last event time, timed-restoration failures, and uncertain outcomes.

## 11. Open-source project requirements

**OSS-01:** Public GitHub repository containing README, this requirements document, architecture decisions, API/capability reference, threat model, installation guide, compatibility matrix, troubleshooting, contribution guide, code of conduct, security policy, changelog, and license/third-party notices.

**OSS-02:** Proposed license: MIT, subject to repository-owner selection and final dependency audit. Inspected upstream/comparator licenses are MIT, but transitive dependencies, copied snippets, fixtures, and media require their own review. Do not imply that an open-source license authorizes access to Amazon services. [S14]

**OSS-03:** Clearly identify the project as unofficial and not endorsed by Amazon. Describe reliance on undocumented services and potential account/terms/compatibility risks. Review applicable Amazon terms before offering a hosted or commercial deployment; do not give blanket legal assurances. [S15]

**OSS-04:** Clean-room-style independent application implementation: use upstream library interfaces and original adapters/tests/docs, not copied comparator code. “Independent” does not mean claiming independent research into Amazon protocols already supplied by the library.

**OSS-05:** Automated lint/type/unit/contract/security checks on contributions. Live account tests are opt-in, isolated, and never triggered with credentials by untrusted fork pull requests. Protect publishing credentials and use reviewed releases with checksums/provenance where available.

**OSS-06:** Issue templates ask for sanitized versions, region, capability and error category, not session dumps. Public examples use synthetic devices/accounts. No private household names, addresses, calendars, credentials, or conversation history in the repository.

**OSS-07:** Documentation distinguishes planned capabilities from implemented/tested ones. Publishing a requirements repository must not be presented as shipping a functional server.

## 12. Risk reduction and delivery gates

| Risk | Mitigation | Exit evidence |
|---|---|---|
| Amazon sign-in instability | Prove interactive setup, protected persistence and single-owner refresh first | Restart, expiry/revocation, refresh and failed-write tests |
| Alexa+/region changes | Small real-account compatibility spike and dated matrix | Results for exact operations and environment |
| Unsupported or stale library methods | Exhaustive ledger; adapter contract tests; live confirmation | Every method classified; no silent scope exclusions |
| Duplicate real-world actions | Journal, scoped idempotency keys, no blind uncertain retry, inspect nested retries | Timeout/crash fault-injection tests |
| Dangerous remote control | Per-tool/target permissions, default read-only, operator approvals | Unauthorized and bypass attempts rejected |
| Credential exposure | Separate login, protected persistence, redaction, secret scanning | Logging/fixture/archive/security tests |
| Temporary settings not restored | Native timers where verified; durable reconciliation; conflict handling | Restart/overlap/manual-change/expiry tests |
| False success or false freshness | Structured outcomes, readback, source timestamps | Negative and partial-result fixtures |
| Public maintenance burden | Explicit support matrix and dependency update process | Reproducible clean installation and contributor guide |
| Premature infrastructure complexity | One process, local store, no distributed components | MVP deploys without broker, cluster or cloud service |

### Milestone A: Connectivity proof, no public support claims

Validate account login, protected refresh persistence, inventories, one state read, one harmless permitted mutation, one explicit routine and DND read/write/recovery. Inspect the pinned library's retry/error behavior. Establish Alexa+ status. Resolve blockers before building the broad tool surface.

### Milestone B: Secure vertical slice

Ship native HTTP MCP locally and through the intended secure ingress, real authorization, read-only inventory, one controlled mutation, operation journal, restart handling and an example client. This milestone tests architecture, not final functional scope.

### Milestone C: Functional completeness

Implement the capability ledger in coherent families. Add typed control, settings, media, lists, notifications, temporary-state workflows, and optional restricted capabilities. Review every excluded/experimental item. Complete comparator coverage and identify intentional safer differences.

### Milestone D: Public single-instance MVP

Pass release acceptance, clean installation, security review, compatibility documentation, package/image checks and recovery tests. Tag a version whose support claims match evidence. No HA prerequisite or distributed dependency.

### Milestone E: Optional future HA

Only after single-instance stability and a justified need. Design and validate separately; no dates or unsupported delivery estimates are implied here.

## 13. Acceptance criteria

A stable MVP release requires all applicable criteria below, with explicit exceptions approved and documented rather than silently marked passed.

1. **Transport:** Native remote MCP works through the supported authenticated HTTPS path with at least two clients. No stdio subprocess dependency.
2. **Authentication:** Initial login, restart, token refresh, revoked login, expired session, concurrent initialization and persistence failure produce correct states without credential leakage.
3. **Inventory/state:** Multi-device batches preserve IDs, capabilities, missing values, source timestamps and per-device errors; stale and unsupported are never presented as current state.
4. **Control:** A representative device in each claimed family performs a validated action. Unsupported capabilities and unauthorized targets fail before dispatch.
5. **Routines:** A stored routine ID resolves to its reviewed definition and target; changed or unknown definitions cannot bypass authorization. The adapter signature matches the pinned library.
6. **Temporary DND:** Selected/all authorized devices preserve prior values; expiry/restart/partial failure/manual-change cases match documented restoration policy. Alarm/announcement suppression claims match observed behavior.
7. **Lists/notifications/media/settings:** Every claimed operation has schema and contract tests, appropriate permissions and live evidence where required. Destructive operations are not enabled by default.
8. **Outcomes:** Network timeouts, HTTP errors, malformed responses, partial successes and crash windows cannot produce false “completed” responses or automatic duplicate non-idempotent actions.
9. **Events:** If enabled, fragmented/duplicate/out-of-order events, reconnects and stale timestamps are handled; unsupported event coverage is stated. Events are not treated as authorization.
10. **Security:** Unauthenticated/incorrect-audience access, cross-principal access, injection, SSRF, invalid origins, oversized requests and sensitive log leakage are tested. A model-generated confirmation flag cannot grant privileges.
11. **Operations:** Service restart, upgrade/rollback, backup/restore and reauthentication are documented and exercised. Local health endpoints do not become public account-detail leaks.
12. **Packaging:** A new user follows instructions on a clean supported VM without Kubernetes or a paid cloud dependency. At least one Windows/native and one Linux/container path are exercised before claiming both supported.
13. **Completeness:** Ledger accounts for all selected-library methods and variants. Every publicly advertised feature has traceable tests and a compatibility status.
14. **Publication:** Repository and release artifacts contain no private data; licenses/notices are included; security/compatibility limitations are clear; CI checks the exact release commit.

## 14. Future HA without locking in infrastructure

The later HA edition should retain the same tools and capability behavior. It may use multiple stateless API instances and competing workers, with a queue delivering each job to one worker rather than broadcasting every action to every instance.

Prepare only lightweight interfaces now: `AlexaAdapter`, `OperationStore`, `CredentialStore`, `CommandExecutor`, `Scheduler`, and `EventSource`. Do not create a general distributed framework before it is needed.

A later design must explicitly address shared durable operation results, credential ownership/refresh locking, account-wide rate limiting, per-target ordering, worker leases/fencing, failover of an upstream event connection, duplicate delivery, and uncertain effects. A queue does not guarantee exactly-once effects at Amazon. A single broker/database/proxy would itself remain a failure point unless separately made resilient.

Dapr is optional and does not inherently require Kubernetes; neither it nor Aspire is a requirement for this MVP. Future infrastructure choices must be justified against operating a small number of home servers. The ordinary single-instance installation remains supported, with no need for HA users' extra infrastructure.

## 15. Immediate implementation decisions to record

These are engineering decisions to resolve during the first milestone, not reasons to delay writing the project:

- Final repository/package name and license selection.
- Pinned alexa-remote2 and cookie-helper versions after reviewing current fixes.
- Supported Node version, MCP SDK/protocol revisions and actual remote-client authentication requirements.
- Authentication provider/component and secure administrative setup experience.
- Initial live-validation region/device/Alexa+ matrix and allowed test actions.
- Typed tool grouping and the scope/approval model for high-risk capability families.
- Exact event API and whether its verified reliability permits stable or experimental status.
- Native DND duration semantics and conservative fallback restoration policy.

## References

Sources were inspected for requirements planning; they are not live-account certification. Links to mutable branches must be replaced with exact commit references in the implementation's compatibility ledger.

- **S1:** Existing MCP tool implementation: https://github.com/serversmx/alexa-mcp/blob/main/src/index.js
- **S2:** Existing wrapper/adapter: https://github.com/serversmx/alexa-mcp/blob/main/src/alexa-client.js and login flow https://github.com/serversmx/alexa-mcp/blob/main/src/auth.js
- **S3:** Comparator dependency lock: https://github.com/serversmx/alexa-mcp/blob/main/package-lock.json
- **S4:** Inspected underlying library: https://github.com/Apollon77/alexa-remote/blob/v8.1.1/alexa-remote.js
- **S5:** Cookie/registration implementation: https://github.com/Apollon77/alexa-cookie/blob/v5.0.6/alexa-cookie.js and https://github.com/Apollon77/alexa-cookie/blob/v5.0.6/lib/proxy.js
- **S6:** Push implementation: https://github.com/Apollon77/alexa-remote/blob/v8.1.1/alexa-http2push.js
- **S7:** Official device-state reporting background: https://developer.amazon.com/docs/alexaplus/device-apis/alexa-statereport
- **S8:** Official MCP transports: https://modelcontextprotocol.io/specification/latest/basic/transports
- **S9:** Official MCP HTTP authorization: https://modelcontextprotocol.io/specification/latest/basic/authorization
- **S10:** Official Alexa+ announcement and integration context: https://developer.amazon.com/en-US/blogs/alexa/alexa-skills-kit/2025/02/new-alexa-announce-blog
- **S11:** Alexa+ custom-capability guidance: https://developer.amazon.com/docs/alexaplus/smarthome/build-custom-capability
- **S12:** Open upstream Alexa+ compatibility question, not a guarantee: https://github.com/Apollon77/alexa-remote/issues/291
- **S13:** Reported HTTP2 event handling issue, to reproduce rather than assume: https://github.com/Apollon77/alexa-remote/issues/311
- **S14:** Licenses: https://github.com/Apollon77/alexa-remote/blob/v8.1.1/LICENSE ; https://github.com/Apollon77/alexa-cookie/blob/master/LICENSE ; https://github.com/serversmx/alexa-mcp/blob/main/LICENSE
- **S15:** Amazon Alexa terms, applicable version/region to review: https://digprjsurvey.amazon.com/csad/help/node/201809740
