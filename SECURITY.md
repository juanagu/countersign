# Security policy

This repository is a proof of concept with synthetic data and a mock identity provider. It is not deployed anywhere
and must not be run with real customer data or real credentials.

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**.
If that option is not available, open an issue that says you have a security report, without any details, and wait
for a private channel to be arranged.

Please include the affected component (`apps/web`, `apps/bff`, `services/bot`, an MCP server), steps to reproduce
and the impact. Reports are handled on a best-effort basis; there is no bounty.

## Scope

In scope: anything that breaks one of the eight security rules in [`AGENTS.md`](AGENTS.md), for example a tool call
that runs without its risk tier being enforced, a transfer that executes without approval and a matching step-up
token, a token accepted by the wrong MCP server, or PII reaching logs or traces.

Out of scope: the mock IdP's known shortcuts (anyone can sign in as a demo customer, the step-up PIN is fixed,
logout does not revoke a session) and the other limitations listed in [`docs/DEMO.md`](docs/DEMO.md) and
[`docs/backlog.md`](docs/backlog.md).
