# OpenSpec development workflow

OpenSpec was initialized with the already installed CLI **1.17.0** on 2026-11-13. This setup did not upgrade the global installation. Node.js 24.13.0 was present.

To reproduce this version on another development machine:

```powershell
npm install -g @fission-ai/openspec@1.17.0
openspec init --tools 'github-copilot,claude,codex' --profile core --no-copilot-cloud
```

The project contains integrations for GitHub Copilot (`.github/skills`, `.github/prompts`), Claude (`.claude/skills`, `.claude/commands`) and Codex (`.agents/skills`). Restart/reload the coding assistant or IDE to discover the new commands.

REQUIREMENTS.md remains the product baseline; openspec/config.yaml supplies workflow context. ROADMAP.md retains the complete single-instance MVP. The first change is `establish-alexa-connectivity-proof`, covering only risk-reduction Milestone A. Planning does not certify Alexa compatibility or grant permission to perform live actions.

Review the proposal, design, delta specs and unchecked tasks in openspec/changes/establish-alexa-connectivity-proof before implementation. Validate with:

```powershell
openspec validate establish-alexa-connectivity-proof --strict
openspec status --change establish-alexa-connectivity-proof
```

When the owner explicitly chooses to begin implementation, use `/opsx-apply establish-alexa-connectivity-proof` in Copilot, `/opsx:apply establish-alexa-connectivity-proof` in Claude, or the `openspec-apply-change` skill in Codex. Approval for setup is not approval for Amazon sign-in, device actions or public releases. Keep all live tests explicitly owner-approved and record uncertain outcomes honestly.

OpenSpec is development tooling, not an Alexa server process. End users of the eventual server will not need OpenSpec. No background application or Amazon session was started by this setup.
