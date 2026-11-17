# Spec Delta

## Purpose

Defines the single-instance cloud deployment of the service: hosting, secret storage, health exposure and the evidence needed about running the Alexa session from a cloud address.

## ADDED Requirements

### Requirement: Single-instance reproducible deployment
The slice SHALL deploy as one instance from checked-in infrastructure code, with no broker, cluster or distributed runtime, and with no secrets in the repository (DEP-01, DEP-05, ARCH-02).

#### Scenario: Clean deployment
- **WHEN** the infrastructure code is applied to an empty subscription scope
- **THEN** it creates the hosting, secret store and identity, and the service answers over HTTPS with a managed certificate

#### Scenario: Repository scan
- **WHEN** the repository is scanned for secrets
- **THEN** none are found

### Requirement: Secrets in a managed secret store
Signing keys, client secrets and the Amazon session SHALL live in a managed secret store accessed by managed identity, not in settings, images or logs (SEC-06).

#### Scenario: Service reads a secret
- **WHEN** the service starts
- **THEN** it reads its secrets through its managed identity and no secret appears in configuration or logs

### Requirement: Health endpoints do not leak
Public health endpoints SHALL return only liveness and a coarse readiness state, without account details (SEC-08, DEP-06).

#### Scenario: Anonymous health check
- **WHEN** an anonymous caller requests health
- **THEN** the response has no account, device or session detail

### Requirement: Cloud session viability is evidence
The project SHALL record, from owner-approved live tests, whether an Amazon session seeded from the owner's machine survives refresh from the cloud address, and MUST NOT claim cloud support before that evidence exists (AUTH-04, REL-08).

#### Scenario: Refresh fails or is challenged from the cloud
- **WHEN** Amazon rejects or challenges the cloud refresh
- **THEN** the state becomes `reauthentication_required`, no sign-in loop starts, and the finding is recorded as sanitized evidence

#### Scenario: Refresh succeeds
- **WHEN** refresh succeeds from the cloud address for the tested period
- **THEN** the evidence records the period and the result, with no account identifiers

### Requirement: Restart and rollback
The deployment SHALL survive restart without losing the journal or the session, and a documented rollback SHALL restore the previous version (DEP-07, REL-06).

#### Scenario: Instance restart
- **WHEN** the instance restarts
- **THEN** the journal and session are available and incomplete records are `unknown`
