# dnd-probe-recovery Specification

## Purpose
Defines the Do Not Disturb read, write and recovery probe, which preserves each device's prior setting and reports actual behavior without assuming what DND suppresses.

## Requirements

### Requirement: DND state read
The harness SHALL read per-device DND state for owner-designated Echo devices and report unknown when a value cannot be read (TEMP-02).

#### Scenario: Readable
- **WHEN** DND is read for an approved device
- **THEN** the result contains the current value with fetchedAt

#### Scenario: Unreadable
- **WHEN** a device does not return DND state
- **THEN** it is reported unknown and no write is made to it

### Requirement: Prior state recorded before change
Before any DND write the harness SHALL durably record each device's existing value; an unknown initial value MUST block the write unless the owner explicitly approves it (TEMP-02, TEMP-04).

#### Scenario: Snapshot persisted
- **WHEN** a DND probe is about to dispatch
- **THEN** a snapshot exists on disk with operation ID before dispatch

#### Scenario: Persistence failure
- **WHEN** the snapshot cannot be written
- **THEN** nothing is dispatched

### Requirement: Restore original, not disable
Recovery SHALL restore each device's recorded original value; a device that started with DND enabled MUST NOT be switched off (TEMP-07).

#### Scenario: Started enabled
- **GIVEN** a device originally had DND on
- **WHEN** recovery runs
- **THEN** it remains on

#### Scenario: Changed meanwhile
- **WHEN** the current value differs from the value this probe set
- **THEN** recovery does not overwrite it and reports a conflict (TEMP-05, TEMP-06)

### Requirement: Native duration behavior recorded
The probe SHALL record whether the library's native duration feature works, including expiry and timezone behavior, and fall back to a documented local restoration only if needed (TEMP-03).

#### Scenario: Duration unverified
- **WHEN** native expiry was not observed
- **THEN** it is marked experimental or unsupported in the evidence

### Requirement: No suppression claims
The evidence MUST NOT state what DND suppresses unless observed on the tested device (§5.2).

#### Scenario: Alarm behavior untested
- **WHEN** alarm or announcement behavior was not tested
- **THEN** the evidence states it as untested

### Requirement: Partial results and restart
Mixed successful and failed mutations SHALL be reported as `partially_applied` with each outcome; when no target changed, the aggregate SHALL report failure rather than partial application, and a restart MUST reconcile outstanding records without fabricating success (TEMP-04, TEMP-06).

#### Scenario: One device unavailable
- **WHEN** one of several devices fails
- **THEN** successful devices are not automatically rolled back and the result lists each outcome

### Requirement: Restoration attribution uncertainty
The harness SHALL use available revisions/history to attribute changes to its managed operation. Equal current and desired values alone MUST NOT be treated as proof that no manual away-and-back change occurred. Without reliable attribution it SHALL document the limitation and conservatively defer restoration for owner direction (TEMP-05).

#### Scenario: Equal value without revision evidence
- **WHEN** the current value equals the probe's desired value but revisions/history cannot rule out intervening manual changes
- **THEN** the harness reports restoration attribution as uncertain rather than silently claiming safe automatic restoration
