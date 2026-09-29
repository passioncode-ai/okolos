# Licensing

Okolos is open source and free to use — for yourself, or across your whole
organisation. There is no subscription, no paid tier and no licence key.

It ships under two licences, split by what each part is for. The decision and
its reasons are [ADR-0014](docs/adr/0014-the-engine-is-permissive-the-product-is-copyleft.md);
`tools/licensing.test.ts` fails the build when the tree stops matching this page.

## What is under which licence

| Part | Licence | Why |
|---|---|---|
| **The engine**: `packages/contracts` and every `packages/core-*` | [Apache-2.0](packages/contracts/LICENSE) | It is meant to be embedded: in a mail client's Worker, in an agent, in someone else's product. A permissive licence with a patent grant is what lets it go there. |
| The evaluation corpora: `corpora/` | [Apache-2.0](corpora/LICENSE) | A verdict you cannot re-measure is a claim. The corpora travel with the engine they measure. |
| **The product**: `apps/extension`, `apps/proxy` (the Cloudflare Worker), `apps/mail-cli`, `packages/{i18n,model,net,platform,storage,ui}`, the tools and the documentation — and the local security agent when it exists | [AGPL-3.0-only](LICENSE) | A security product's central claim is "you can verify this". A hosted or redistributed fork of it has to publish its source. |
| `packages/core-lookalike/src/suffixes.json` | MPL-2.0 | A selection of Public Suffix List rules; see that package's [NOTICE](packages/core-lookalike/NOTICE). |
| `feeds/phishing.json` | its source's terms | Hosts from the OpenPhish community feed; Okolos does not relicense data it did not create. |

**The direction only goes one way.** Engine code never imports product code:
an Apache package that pulled in an AGPL one would quietly stop being
embeddable. The test reads every engine package's imports and refuses that.

## What you may do

| You want to | Allowed | What it asks of you |
|---|---|---|
| Use the extension yourself, or install it for everyone in your company | yes | nothing |
| Run the Okolos Worker or agent for your own team | yes | nothing, as long as you do not change it |
| Change the extension, Worker or agent and give it to others, or let others use it over a network | yes | publish your changed source under AGPL-3.0 |
| Embed the engine in your own product, open or closed, free or paid | yes | keep the `LICENSE` and `NOTICE` of the packages you ship |
| Fork the engine | yes | keep the notices; mark what you changed |

The name "Okolos" and its logo are not licensed by either licence. A fork is
welcome; calling it Okolos is not.

## Contributing

Contributions are accepted under [CLA.md](CLA.md), the same agreement every
PassionCode.ai repository uses: you keep your copyright and grant the
maintainer the right to distribute your contribution under these and other
licences. Tick the box in the pull request template.

Copyright 2026 Siarhei Sheleh. Questions: contact@passioncode.ai.
