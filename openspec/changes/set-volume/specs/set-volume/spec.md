## ADDED Requirements

### Requirement: Volume tool
The server SHALL provide `set_volume` requiring the mutate scope, accepting one allowed Echo and an integer level 0-100. The level SHALL be clamped to the configured ceiling (default 70) and the clamped value reported.

#### Scenario: Clamped
- **WHEN** a level above the ceiling is requested
- **THEN** the ceiling is applied and returned

#### Scenario: Invalid level
- **WHEN** the level is not an integer from 0 to 100
- **THEN** the call is refused and nothing is sent

### Requirement: Same guardrails as speech
Targets SHALL follow the speech allowlist, with identical refusals for unknown and disallowed devices and a refusal for offline ones. Unless the policy is `allow`, the owner SHALL approve the exact device and level first. Calls SHALL share the speech rate limit.

#### Scenario: Approval
- **WHEN** the policy is approve
- **THEN** nothing is sent before approval

### Requirement: Private records
Records SHALL contain no device names or serials.

#### Scenario: Journal
- **WHEN** a volume change is made
- **THEN** the journal holds the operation kind, a target count and the outcome
