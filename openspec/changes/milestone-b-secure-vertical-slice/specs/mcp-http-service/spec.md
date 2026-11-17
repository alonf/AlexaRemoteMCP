# Spec Delta

## Purpose

Defines the native Streamable HTTP MCP endpoint, its read-only inventory tools, and the example client contract, so that remote clients can use the service without a stdio subprocess.

## ADDED Requirements

### Requirement: Native Streamable HTTP endpoint
The service SHALL expose one MCP endpoint over Streamable HTTP, without a stdio subprocess or the previous stdio project's code (ARCH-01, MCP-01, MCP-02).

#### Scenario: Authorized client lists tools
- **WHEN** an authorized client initializes a session and lists tools
- **THEN** the service returns only the slice's tools with typed input and output schemas

#### Scenario: Unauthenticated request
- **WHEN** a request arrives without a valid access token
- **THEN** it is rejected with a challenge pointing to the protected-resource metadata, and no tool is listed or run

### Requirement: Request hardening
The service SHALL validate the origin, reject oversized requests and reject malformed tool input before any Amazon call (MCP-03, SEC-03).

#### Scenario: Invalid origin
- **WHEN** a browser request carries an origin that is not allowed
- **THEN** it is rejected before authentication work or tool dispatch

#### Scenario: Oversized or malformed input
- **WHEN** a request exceeds the size limit or fails schema validation
- **THEN** it is rejected with a structured error and nothing is dispatched

### Requirement: Read-only inventory tools
The service SHALL provide read-only inventory tools that return stable IDs, declared capabilities and per-device errors, and MUST NOT present stale or unsupported values as current state (CAP-01, CAP-02).

#### Scenario: Inventory with partial failure
- **WHEN** some devices cannot be read
- **THEN** the result lists the readable devices and a per-device error for the others, and the call does not report overall success

#### Scenario: Stale or missing value
- **WHEN** a value has no source timestamp or is older than the freshness limit
- **THEN** it is marked stale or missing and not reported as current

#### Scenario: Session needs sign-in
- **WHEN** the Amazon session is in `reauthentication_required`
- **THEN** the tool returns that state without trying to sign in, and without session material

### Requirement: Example client
The repository SHALL include an example client that connects by the same authorization flow as other clients, lists inventory and runs the controlled mutation, and requires no household data (MCP-06, OSS-05).

#### Scenario: Example client runs against a local instance
- **WHEN** the example client runs against a local instance with a static test client
- **THEN** it completes sign-in, lists inventory and prints the structured outcome of the mutation
