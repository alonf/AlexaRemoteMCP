## 1. Settings and service

- [x] 1.1 Add `SPEAK_URGENT_REASONS` and `SPEAK_URGENT_LIMIT` to `loadConfig` (invalid token or limit stops startup naming only the setting)
- [x] 1.2 In `SpeechService.say`, accept `reason`; a listed reason skips `gateApproval` after all other checks; separate urgent window with no fallback; journal records the reason
- [x] 1.3 Add the `speech.urgent` event type and publish it (reason only) from the service

## 2. Tool

- [x] 2.1 Add the optional `reason` argument to `speak` and list the allowed reasons in its description; wire settings and doorbell in `service.ts`

## 3. Verification

- [x] 3.1 Tests: listed reason skips approval; unlisted or empty list keeps approval; disallowed device, bad text and offline still refused; urgent limit with no fallback; event carries the reason only; journal holds no text
- [x] 3.2 Lint, full tests and the secret scan
- [ ] 3.3 Owner-approved live check with one test phrase and reason on one Echo
- [x] 3.4 Docs: `docs\cloud-deployment.md` and the roadmap entry
