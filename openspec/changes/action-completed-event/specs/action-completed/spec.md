## ADDED Requirements

### Requirement: Completion event
The server SHALL publish an `action.completed` event to subscribers after a mutation reaches a final status, carrying only a short summary and the status. It SHALL NOT publish for calls rejected by policy, and a publish failure SHALL NOT change the mutation outcome.

#### Scenario: Mutation finishes
- **WHEN** a mutation completes with any final status
- **THEN** an `action.completed` event is published with the summary and status

#### Scenario: Policy rejection
- **WHEN** a mutation is rejected by policy before execution
- **THEN** no event is published
