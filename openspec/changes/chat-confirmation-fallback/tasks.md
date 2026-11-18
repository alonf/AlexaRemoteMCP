## 1. Implementation

- [x] 1.1 Issue time in the signed approval state; `confirmation_too_soon` refusal
- [x] 1.2 Gate returns `confirmation_required` and verifies the repeat call
- [x] 1.3 Mutation tools accept `approvalId` and `confirmed`
- [x] 1.4 `CHAT_CONFIRMATION=off` switch; catalog edits excluded

## 2. Verification

- [x] 2.1 Tests: ask, delay, single use, wrong device, decline, expiry, off switch
- [x] 2.2 Live check: ChatGPT asks, the user answers in chat, the boiler action is dispatched once and journaled

## 3. Documentation

- [x] 3.1 `docs/cloud-deployment.md`
