# How PayPal could ship this

An outsider's proposal, written for a product manager. It uses only public information and says plainly what is a guess. PayPal's internal plans may differ.

## The problem in one paragraph

PayPal's own 2026 messaging says agentic commerce needs clear consumer consent, trusted identity, reliable payments and built-in fraud protection, and it lists returns and disputes among the post-purchase functions that agent protocols should support without describing how. PayPal also says its Purchase Protection and Seller Protection extend to agentic transactions, within eligibility limits. Industry commentary notes that no card network has published a liability rule for agent purchases, and that merchants generally bear the loss by default. So the question "this agent bought something; the buyer says they did not want it; who pays?" has no structured answer yet, and without one merchants will block or slow agent checkout.

## What Warrant demonstrates

| Capability | In the prototype |
|---|---|
| Machine-checkable proof that a human approved this cart for this agent | Signed mandate, cart and consent (see [warrant-spec.md](warrant-spec.md)) |
| Merchant-side verification before the order is paid | Verifier rules V01-V12 |
| Agent identity and status | A small registry with keys, status and a transparency log |
| Dispute handling that uses the proof | Facts engine, outcome table, evidence packet, liability memo |
| Efficient merchant operations | Proposed actions with one-click approval |

## Where PayPal would plug in

| Surface | Proposed integration | Why it is PayPal's to own |
|---|---|---|
| **Orders API / Agent Ready** | An optional `agent_authorization` reference on the order (warrant id and hash, by reference rather than payload). PayPal verifies it against its own registry and returns a verification result in the order and in webhooks | PayPal sees the order, the payer and the agent's traffic |
| **Know Your Agent** | The registry becomes PayPal's KYA directory: agent platform keys, status, attestations, and outcome statistics | PayPal has said it is extending identity checks to agents; it holds the identity and risk systems |
| **Disputes** | Auto-attach the verified authorisation as structured evidence and show it to the analyst in the dispute view with a plain summary | PayPal already receives the evidence; this makes it faster and more consistent |
| **Seller Protection** | Define eligibility for agent orders around a verified warrant | Turns a vague promise into a rule merchants can plan around |
| **Risk** | Verified warrants as a signal, and mismatches as a fraud signal | Reduces false declines for legitimate agent traffic |
| **Merchant tooling** | A verifier SDK and a dispute assistant in the merchant dashboard | Lowers integration cost and manual evidence work |

## Hypotheses to test (no numbers claimed)

1. Merchants that can verify agent authorisation will accept more agent orders.
2. Structured authorisation evidence shortens dispute handling and reduces inconsistent outcomes.
3. Agent-fault cases resolved quickly (accepted and attributed) cost less than cases fought and lost.
4. A registry with outcome statistics pushes low-quality agent platforms to improve.

Each needs real data from a pilot. The prototype cannot measure them.

## What only PayPal can do

- Bind the warrant to a verified PayPal account instead of trust on first use.
- Run the registry as an authority, with attestations and revocation.
- Decide how liability is allocated and communicate it to merchants and agent platforms.
- Use network-wide data for fraud signals and agent reputation.
- Fit warrants into existing protocols (ACP, UCP, AP2) and into card-network rules where PayPal acts as a processor.

## A phased path

1. **Spec and sandbox pilot.** Publish the warrant format, support it on a small set of sandbox merchants and agent platforms.
2. **Dispute assist.** Show the verified authorisation to merchants and analysts. No policy change.
3. **Protection rules.** Define seller-protection treatment for orders with a verified warrant.
4. **Standards alignment.** Map to AP2 mandates and Verifiable Intent chains so one credential works across ecosystems.

## Risks and open questions

- Privacy and data minimisation (selective disclosure).
- Gaming: farms of cheap agent identities; attestation design.
- Key management for consumers; passkey UX.
- Interaction with card-network chargeback rules, which PayPal does not control for card payments.
- Whether the warrant should be a PayPal-specific object or a profile of an open standard.
- Liability is a policy and legal question; the technology only supplies the evidence.

## Sources of the claims above

PayPal newsroom articles (Jan 2026 protocol article; Aug 2026 Ai4 article introducing Know Your Agent), PayPal's agent-ready page, PayPal's Disputes API documentation, and industry commentary on agent chargebacks (for example Chargeflow, a vendor). Check these primary sources again before quoting anything.
