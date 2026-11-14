# Spec Delta

## Purpose

Defines read-only probes of Echo and smart-home inventory, routine metadata and one device state, so freshness, partial failure and unsupported data are visible before wider tooling is built.

## ADDED Requirements

### Requirement: Read-only inventory probes
The harness SHALL read Echo devices, smart-home entities, groups and routine metadata using the pinned library without mutating anything (Milestone A; CAP-04; acceptance 3).

#### Scenario: Inventory success
- **WHEN** a usable session exists and the owner approves the read probe
- **THEN** a sanitized summary reports counts and capability kinds per family with stable pseudonymous identifiers

#### Scenario: Family unavailable
- **WHEN** one inventory family fails or is empty
- **THEN** that family is reported as failed or unknown with a reason and the other families still report

### Requirement: Single state read with freshness
The harness SHALL read the state of one owner-selected smart-home device and report fetchedAt, source timestamp when present, cache status and per-item errors (REL-07).

#### Scenario: State with timestamp
- **WHEN** the response includes a value and a source timestamp
- **THEN** the result reports both values and the age

#### Scenario: Missing value or timestamp
- **WHEN** the response lacks a value or timestamp
- **THEN** that field is reported as unknown, and a present device record is not treated as proof the state is retrievable

### Requirement: Unknown upstream data preserved safely
Unknown fields, enums and response shapes SHALL be retained as data for evidence and MUST NOT be executable or flattened into misleading values (PLUS-03, CAP-02).

#### Scenario: Unrecognized shape
- **WHEN** a response has an unexpected shape
- **THEN** the probe returns an explicit compatibility error and no guessed state

### Requirement: Privacy of inventory output
Probe output committed or shared SHALL omit real device names, room names, addresses and account identifiers (SEC-06).

#### Scenario: Evidence sanitization
- **WHEN** inventory results are written to an evidence record
- **THEN** names and identifiers are replaced by synthetic labels and only the mapping stays in an ignored local file
