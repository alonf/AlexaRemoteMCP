# Spec Delta

## Purpose

Defines how remote MCP clients are authorized: the OAuth 2.1 flow, client registration, token binding and the single-owner sign-in, so that only the owner's approved clients can reach tools.

## ADDED Requirements

### Requirement: OAuth 2.1 with PKCE
The service SHALL act as an OAuth 2.1 authorization server for its MCP resource and SHALL publish protected-resource and authorization-server metadata that advertises PKCE `S256` and an issuer (AUTH-05, SEC-02).

#### Scenario: Client discovers authorization
- **WHEN** a client fetches the protected-resource metadata
- **THEN** it learns the authorization server, which advertises `S256` and the registration method

#### Scenario: Authorization without PKCE
- **WHEN** an authorization request omits PKCE `S256`
- **THEN** it is rejected and no code is issued

### Requirement: Restricted client registration
Dynamic client registration or Client ID Metadata Documents SHALL be accepted only for the configured redirect URIs of approved clients (ChatGPT and Claude), and unknown redirect URIs MUST be rejected (SEC-02).

#### Scenario: Approved client registers
- **WHEN** a client registers with an approved redirect URI
- **THEN** it receives a public client identity

#### Scenario: Unknown redirect URI
- **WHEN** a registration or authorization request uses a redirect URI that is not approved
- **THEN** it is rejected and nothing is stored for that client

### Requirement: Single owner principal
Authorization SHALL complete only for the configured owner principal, signed in through the owner's identity provider, and any other account MUST be refused (SEC-04).

#### Scenario: Owner signs in
- **WHEN** the owner signs in and approves a client
- **THEN** an authorization code is issued bound to that client and principal

#### Scenario: Another account signs in
- **WHEN** a different account completes the identity provider sign-in
- **THEN** authorization is refused and no code is issued

### Requirement: Audience-bound tokens
Access and refresh tokens SHALL be bound to the MCP resource, the client and the principal, stored only as hashes, and refresh SHALL rotate (SEC-02, SEC-05).

#### Scenario: Token for another audience
- **WHEN** a token issued for a different resource is presented
- **THEN** the request is rejected

#### Scenario: Refresh rotation
- **WHEN** a refresh token is used
- **THEN** a new pair is issued, the old refresh token stops working, and a replayed old token is rejected

#### Scenario: Token store disclosure
- **WHEN** the token store is inspected
- **THEN** it holds no usable token values

### Requirement: Scopes and no model-granted privilege
Tools SHALL require scopes that the owner granted, and a value supplied by the model, including a confirmation flag, MUST NOT grant any privilege (SEC-07).

#### Scenario: Read-only scope calls the mutation
- **WHEN** a client holding only the read scope calls the mutation tool
- **THEN** the call is rejected before any Amazon call

#### Scenario: Confirmation flag in arguments
- **WHEN** a mutation call includes a model-generated "confirmed" argument without the mutation scope
- **THEN** the flag is ignored and the call is rejected
