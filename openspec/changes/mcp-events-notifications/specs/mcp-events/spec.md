## ADDED Requirements

### Requirement: Event discovery and subscription
The MCP endpoint SHALL declare the `events` capability and serve `events/list`, `events/subscribe` and `events/unsubscribe` to a signed-in client with the read scope. `events/list` SHALL describe `approval.requested` and `session.attention` with their payload schemas. A subscription SHALL name one of them, use `webhook` delivery and carry a `whsec_` secret.

#### Scenario: Listing
- **WHEN** a signed-in client calls `events/list`
- **THEN** both event types are returned with `webhook` as the only delivery mode

#### Scenario: Unknown event or mode
- **WHEN** a subscription names another event type or delivery mode
- **THEN** it is refused as invalid params and nothing is stored

#### Scenario: No read scope
- **WHEN** a client without the read scope subscribes
- **THEN** the request is refused

### Requirement: Callback verification
Before a subscription is stored the server SHALL send a signed challenge to the callback and store the subscription only if the callback answers 2xx echoing the challenge in full.

#### Scenario: Challenge passes
- **WHEN** the callback echoes the challenge
- **THEN** the subscription is stored and answered with its id and a `refreshBefore` time

#### Scenario: Challenge fails
- **WHEN** the callback is unreachable, times out or does not echo the challenge
- **THEN** the subscription is refused with error -32015 and a reason, and nothing is stored

### Requirement: Callback safety
The server SHALL call only HTTPS callbacks whose host is in `EVENT_CALLBACK_HOSTS` (default `connectors.api.openai.com`), without credentials in the URL. It SHALL resolve the name as it connects and refuse private, local, link-local and other non-public addresses, follow no redirects and bound each exchange by time and response size.

#### Scenario: Host not allowed
- **WHEN** the callback host is not in the allowlist
- **THEN** the subscription is refused and no request is sent

#### Scenario: Name resolves inward
- **WHEN** an allowed name resolves to a private address
- **THEN** the request is refused

### Requirement: Signed content-free delivery
Each event SHALL be sent as a Standard Webhooks signed POST (`webhook-id` equal to the event id, `webhook-timestamp`, `webhook-signature` `v1,` HMAC-SHA256 with the subscriber's key). The payload SHALL hold only the event type, event id, time and a short fixed summary, and for `approval.requested` the catalog label of the device and the operation phrase. It SHALL NOT carry approval ids, tokens, Alexa text or secrets.

#### Scenario: Approval waiting
- **WHEN** a device action is held for owner approval
- **THEN** every active `approval.requested` subscription receives one signed event

#### Scenario: Session needs attention
- **WHEN** the Alexa session health changes to `reauthentication_required` or `temporarily_unavailable`
- **THEN** every active `session.attention` subscription receives one signed event, and a repeat of the same state sends none

### Requirement: Retry, expiry and isolation
A failed send SHALL be retried with the same event id, re-signed, after 1, 2, 4 and 8 seconds, except after 410 (which ends the subscription) or 413. One subscriber's failure SHALL NOT delay another's. A subscription SHALL last at most 24 hours; after expiry nothing is sent. Delivery state is not kept across restarts: the client reads current state with a tool.

#### Scenario: Slow callback
- **WHEN** one callback times out
- **THEN** other subscribers still receive the event promptly

#### Scenario: Gone
- **WHEN** a callback answers 410
- **THEN** the subscription is removed

#### Scenario: Expired
- **WHEN** a subscription's lifetime has passed
- **THEN** no event is sent to it

### Requirement: Sealed storage and privacy
Subscription signing keys SHALL be stored encrypted, never logged, and each client SHALL be able to remove only its own subscription. Logs SHALL name the event type, a short hash of the client, the callback host and the status, and never addresses, secrets or payload text.

#### Scenario: Another client's subscription
- **WHEN** a client unsubscribes with another client's subscription id
- **THEN** nothing is removed and no error reveals that it exists
