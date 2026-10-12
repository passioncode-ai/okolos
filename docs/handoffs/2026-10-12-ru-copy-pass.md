# Russian copy pass handoff (2026-10-12)

## Objective

The operator asked on 2026-10-12 for a review of all the Russian text in the product, and for it
to be fixed. That covers the catalogue (`apps/extension/_locales/ru/messages.json`), the Russian
store listing (`docs/store/listing.md`) and the public landing and status pages
(`apps/proxy/src/router.ts`). The pass followed the brand pack in [docs/brand/](../brand/). Keys,
`$PLACEHOLDER$`s, product names, numbers and store limits were kept exactly as they were.

## Completed

- 215 of 552 catalogue messages were rewritten. By word, 29% of the catalogue changed (1062 of
  3632 words). The script that counts this is in the PR description. The patterns fixed:
  - one form for errors: «Не удалось прочитать журнал», not «Журнал не прочитался» (11 → 0);
  - «Это не значит, что…» in place of «Это не утверждение, что…» (4 → 0);
  - «сбой хранилища» in place of «неполадка» (3 → 0);
  - one label for retry, «Попробовать ещё раз» (there were two before);
  - impersonal loading states («Подсчёт…», «Чтение журнала…») in place of «мы» (`voice.md` →
    Обращение);
  - terms from `terminology.md`: «журнал отправок», «встроенный фрейм», «проверка по префиксу
    хеша», «нерешённая находка», «списки блокировок»;
  - rhetorical dashes (56 → 13; every one left is a copula or an elided verb);
  - numbers written as «дней: N» where the noun after a number would need agreement and
    `chrome.i18n` has no plurals (`blockStale`, `credFactSeenForDays`, `noteSurfaceRemoved`,
    `warnAlsoHere`, `warnPasswordReuse`, `popupChangedCount`);
  - the recovery choices no longer written in the masculine only.
- `docs/privacy.md` and its generated page: three data kinds now carry the same name as in the
  wipe dialog (`tools/data-kinds.test.ts` requires this).
- `docs/ux/screens.md` and `docs/ux/scenarios.md`: the labels they quote were updated to match.
- `CHANGELOG.md` (under a lease): one entry, plus two older entries that used the old terms.
- 19 exact-string assertions in 10 test files now match the new wording. Each test still checks
  what it checked before.
- The store screenshots were taken again with `pnpm screenshots`, because three of the four
  showed text that has now changed.

## Open

- **Missing terms.** These are reported to `brand-voice` and not added here:
  - «очередь» (the queue behind «Что требует вас»);
  - «журнал событий» (the journal as a data kind);
  - «опись» / `stageInventory`;
  - `stageCorpus` («корпус»), which still shows to a person as a source of a decision;
  - «частичное обновление» (feed delta);
  - «инцидент»;
  - «сбой хранилища».
- **A raw identifier on screen.** `auditTriggeredBy` shows `triggeredBy` as it is stored, for
  example `user:leak-check`. `voice.md` forbids this. Fixing it needs a key per trigger, which
  is code work, not copy work.
- **The restore note is lower-case after a full stop.** `explainRestore`
  (`apps/extension/src/content/index.ts`) joins «Возвращено: N. » with lower-case fragments. The
  English has the same fault. The fix is in code.
- `voice.md` has no `Humanization:` field. The super-ux linter reports B064 as advisory.
  `voice.md` belongs to `brand-voice`, so it was not edited.
- The English listing still calls the audit screen «self-audit screen». The Russian now uses its
  real name, «Что отправлено». The English was outside this pass.

## Checks run

`pnpm gates`, `pnpm test:e2e`, `python3 docs/brand/lint.py`, the super-ux `brand_lint.py
docs/brand --fail-on B063`, `pnpm screenshots`. The exit codes are in the PR description.

## Next task

Merge the PR. Then give `brand-voice` the missing terms above, and open a code task for
`auditTriggeredBy` and `explainRestore`.
