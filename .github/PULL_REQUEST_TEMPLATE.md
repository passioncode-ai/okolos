## What and why

## Checks

- [ ] `pnpm gates` (the pre-push hook runs the same chain)
- [ ] `python3 docs/ux/lint.py` after any change to user-facing behaviour
- [ ] Engine packages (`packages/contracts`, `packages/core-*`) import no product package — `tools/licensing.test.ts`

No credential values, local paths or personal data in code, tests, fixtures or this description.

## Contributor License Agreement

- [ ] I agree to [CLA.md](https://github.com/passioncode-ai/okolos/blob/main/CLA.md) for every contribution in this pull request.
