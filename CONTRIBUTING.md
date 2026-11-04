# Contributing

Thanks for looking. Warrant is early, and small, focused contributions are welcome.

## Ground rules

- **Sandbox only.** Do not add code paths that default to production PayPal.
- **Facts come from code.** Do not let a language model decide a verification result, a fact or a dispute outcome. Models may extract a claim type from an enum and write explanations that are checked against the facts.
- **Money is integer minor units** in code. Decimal strings only at the PayPal and warrant-document boundaries.
- **Every verifier rule and fact needs tests:** at least one passing case, one failing case, and a scenario in `sim/`.
- **Money-moving dispute actions** stay behind merchant approval unless Autopilot is explicitly on.

## Getting started

```bash
pnpm install
pnpm test
pnpm eval
```

See [docs/setup.md](docs/setup.md) for PayPal sandbox setup and [docs/architecture.md](docs/architecture.md) for the design.

## Pull requests

1. Open an issue first for anything larger than a fix.
2. Keep PRs small, and describe the behaviour change and how you tested it.
3. Run `pnpm lint && pnpm typecheck && pnpm test && pnpm eval` before pushing.
4. Update the relevant doc in `docs/` and the README feature table when behaviour changes.

## Changing the spec

Warrant's format is documented in [docs/warrant-spec.md](docs/warrant-spec.md). Changes to field names or signing rules need an issue, a version bump, and updated test vectors: edit `packages/warrant/test/vectors.ts`, then run `pnpm --filter @warrant/warrant vectors` to regenerate [docs/test-vectors.json](docs/test-vectors.json). A test fails if the committed file is out of date. Interpretations and open gaps are tracked in [docs/implementation-notes.md](docs/implementation-notes.md).

## Code of conduct

Be kind and assume good faith. Harassment and abuse are not tolerated.

## License

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).
