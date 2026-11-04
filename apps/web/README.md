# @warrant/web

The React 19 + Vite app. It talks only to the server's API; no PayPal, Anthropic or signing key reaches the browser. The server's types are imported as types only (`@warrant/server/api-types`).

```bash
pnpm dev                       # from the repository root: starts this and the server
pnpm --filter @warrant/web build   # type-check and build to dist/, which the server then serves
```

In development Vite serves the app on :5173 and forwards `/api` and `/sim` to the server on :8787 (`VITE_SERVER_ORIGIN` changes the target).

## Pages

| Route | What it is |
|---|---|
| `/` Shop | Chat with the shopping agent. It asks for the mandate (budget, items, kinds of product, how long), shows the cart, and the wallet's consent screen rendered from the cart data itself. Approve, and pay on the PayPal page. A wallet panel shows the linked PayPal account and the mandates, which can be revoked |
| `/v/:cartJti` Verify | The public proof: signers and key status, the consented cart, whether the order matches, the facts, log inclusion, the checkout findings. Needs no login and trusts nothing the shop says |
| `/console/*` Merchant console | Overview (the merchant mode and the dispute autopilot), Orders (ship, refund), Disputes (the facts, the decision, the proposed action and its approval, an evidence PDF), Checkouts (including refused ones), Catalog (prices, availability), Registry (keys, suspend, revoke, log audit), Analytics (AG Studio over orders, checkouts and disputes). Lab runs are hidden unless "Include Dispute Lab runs" is ticked |
| `/lab` Dispute Lab | Run any of the 87 labelled scenarios live, or play the buyer: raise a dispute on a paid order with your own words, then play PayPal and decide it |
| `/checkout/return`, `/checkout/cancel` | Where the PayPal page sends the buyer back to |

A banner says when PayPal is the built-in simulator. The console asks for a token when the server's judge mode is off.

## Tests

`pnpm --filter @warrant/web test` runs 60 component and unit tests (Vitest, React Testing Library, jsdom) with coverage thresholds (about 90% of lines). `Studio.tsx` (AG Studio, which needs a real canvas) and `main.tsx` are excluded; the browser tests in [`e2e/`](../../e2e) load AG Studio in Chromium.

## AG Studio

`ag-studio` and `ag-studio-react` are pinned to the same version. Local development needs no licence key; a production build shows a watermark without one (`VITE_AG_STUDIO_LICENCE_KEY`, embedded in the client bundle, is not a secret). The Analytics page opens AG Studio in edit mode over three data sources. There is no pre-built dashboard, custom widget or Studio agent yet.
