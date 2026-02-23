# Security Policy

## Supported scope
This project is intended for self-hosted/private use. If you expose it publicly, review permissions and credentials carefully.

## Sensitive data
- `.env` contains secrets and must never be committed.
- Rotate tokens immediately if exposed.

## Action Mode caution
`Action Mode` allows OpenClaw to execute tools. Restrict usage to trusted users/channels.

## Minimum hardening checklist
- Use least-privilege Discord bot permissions
- Keep host OS and dependencies updated
- Restrict shell/tool access where possible
- Store logs without secrets

## Reporting
If you find a security issue, open a private report to the maintainer before public disclosure.
