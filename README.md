# Alexa Remote MCP

An independent, self-hosted Node.js/TypeScript MCP server design based on [alexa-remote2](https://github.com/Apollon77/alexa-remote), with native Streamable HTTP transport.

> **Status: requirements and design phase.** This repository does not yet contain an implemented server, deployable package, or verified Alexa integration.

## Project direction

- Build a new implementation, not a fork of, subprocess wrapper around, or dependency on an existing stdio MCP server. Stdio remains a valid MCP transport; this project targets independently hosted HTTP access.
- Deliver a functional single-instance MVP covering the validated end-user capabilities of the selected upstream library, with explicit support and limitation reporting.
- Include secure authentication persistence, least-privilege MCP authorization, safe action handling, reversible temporary settings, diagnostics, and documented VM/container deployment.
- Investigate additional state, smart-home control, media, notifications, settings, and event capabilities beyond the comparison project's tool set.
- Prove Amazon connectivity and Alexa+ compatibility before adding infrastructure complexity. High availability is a future option, not an MVP dependency. No Home Assistant, Kubernetes, Dapr, or Aspire requirement.

## Requirements

Read [REQUIREMENTS.md](REQUIREMENTS.md) for the proposed capability scope, risk controls, architecture, compatibility investigations, delivery gates, acceptance criteria, and source references.

“Full capability coverage” requires a reviewed capability ledger and runtime evidence. It does not promise every Alexa device, region, skill, setting, or undocumented endpoint will work.

## Unofficial integration and security

This project is not affiliated with or endorsed by Amazon. The underlying library relies on unofficial Amazon interfaces that may change. Alexa+ support and individual operations require validation; no live-account compatibility certification is claimed here.

Do not publish Amazon cookies, refresh tokens, signing material, account identifiers, private device information, or real household logs in issues or contributions. Use synthetic examples and sanitized diagnostics only.

## License status

MIT is proposed in the requirements, pending repository-owner selection and dependency review. No project license has been adopted yet. Upstream dependencies retain their own licenses. A license and applicable notices must be included before a usable open-source release.
