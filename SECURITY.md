# Security policy

Warrant is a hackathon project that runs against the **PayPal sandbox only**. It has not been security-audited and must not be used with live PayPal credentials or real funds.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (Security tab), or email the maintainers at `<SECURITY_CONTACT_EMAIL>`. Do not open a public issue for vulnerabilities. We aim to acknowledge reports within 3 business days.

## Design stance

The threat model is documented in [docs/threat-model.md](docs/threat-model.md). Core principles:

- Facts come from signatures, hashes and PayPal records, never from a language model.
- The dispute agent proposes actions; money-moving actions need merchant approval by default.
- Consent signatures cover one cart hash and cannot be produced by the agent.

## Handling secrets

- Never commit `.env`. Only `.env.example` is tracked.
- PayPal, Anthropic and signing keys stay on the server. The browser never receives them.
- If you suspect a leaked sandbox secret, rotate it in the PayPal Developer Dashboard and regenerate signing keys.

## Scope notes

In scope: the warrant package, verifier, registry, PayPal client, webhook handler, ledger, dispute agent, workspace isolation. Out of scope: attacks that require control of the PayPal sandbox itself, vulnerabilities in third-party services, and denial of service against the public demo beyond what the rate limits cover.
