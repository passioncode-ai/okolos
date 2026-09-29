# Решения (ADR)

Каждое решение здесь уже принято и уже действует — это не предложения. Формат
короткий намеренно: контекст, решение, цена, и **чем оно держится**, потому что
решение без механизма это намерение.

Записывать сюда стоит то, о чём через полгода спросят «почему так?» и ответ
нельзя будет прочитать из кода. Всё остальное живёт в коде и в его комментариях.

| № | Решение | Держится |
|---|---|---|
| [0001](0001-closed-shadow-root.md) | Внутристраничные поверхности — в закрытом shadow-корне | `tools/gates/bundle-scan.test.ts` |
| [0002](0002-worker-never-signs.md) | Воркер никогда не подписывает фиды | `tools/feed-key.test.ts` |
| [0003](0003-single-network-choke-point.md) | Один аудируемый узел сети, запись до запроса | `tools/gates/bundle-scan.test.ts`, `packages/net` |
| [0004](0004-verdict-never-outruns-checks.md) | Вердикт не обгоняет проверки, которые прошли | `packages/core-download/src/judge.test.ts` |
| [0005](0005-trusted-event-is-not-a-person.md) | Доверенное событие — не доказательство человека | `packages/core-gate/src/decide.test.ts` |
| [0006](0006-third-stage-not-shipped.md) | Третья ступень на модели не выпускается | `docs/licences.md`, `tools/model/evaluate.py` |
| [0007](0007-generate-what-would-drift.md) | Всё, что иначе разойдётся, — генерируется | `tools/wireframes.mjs`, `icons.mjs`, `tokens.mjs`, `privacy-page.mjs` |
| [0008](0008-words-in-the-catalogue-mapping-in-code.md) | Слово живёт в каталоге, отображение — в коде | `tools/locales.test.ts`, `tools/copy.test.ts`, `tools/entry-resolver.test.ts` |
| [0009](0009-the-page-watcher-observes-and-never-holds.md) | Наблюдатель страницы смотрит и никогда не задерживает | `apps/extension/src/page-watch/`, `tools/gates/bundle-scan.test.ts` |
| [0010](0010-the-blocklist-is-about-hosts-so-the-sources-must-be.md) | Блок-лист про хосты, значит и источники должны быть про хосты | `tools/ingest.test.ts` |
| [0011](0011-the-signature-primitive-decides-the-supported-range.md) | Примитив подписи решает, какие браузеры мы поддерживаем | `tools/manifest.test.ts`, `apps/extension/src/background/feeds.test.ts` |
| [0012](0012-one-signal-is-a-suspicion.md) | Один сигнал — подозрение, два — вердикт | `packages/core-injection/src/stage1.test.ts`, `chars.test.ts`, `corpora/injections/negatives.json` |
| [0013](0013-a-finding-crosses-contexts-by-being-asked-for.md) | Находка переходит между контекстами тем, что её спрашивают | `tools/crossing-contexts.test.ts`, `e2e/scn-031`, `scn-034`, `scn-035`, `scn-036`, `tools/firefox-e2e.mjs` |
| [0014](0014-the-engine-is-permissive-the-product-is-copyleft.md) | Движок — Apache-2.0, продукт — AGPL-3.0; движок не импортирует продукт | `tools/licensing.test.ts` |
