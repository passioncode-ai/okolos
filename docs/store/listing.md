# Карточка в магазине

Источник для полей Chrome Web Store и Firefox Add-ons. Написано по
[бренд-паку](../brand/voice.md); каждое утверждение — из
[facts.md](../brand/facts.md), и тест не даёт написать здесь то, чего там нет.

Лимиты магазина проверяются тем же тестом: имя ≤ 75, краткое описание ≤ 132,
полное ≤ 16 000.

## Имя

**ru:** `Okolos — защита от скрытых инструкций`
**en:** `Okolos — a guard against hidden instructions`

Имя берётся из `_locales`, а не пишется здесь второй раз: в манифесте стоит
`__MSG_appName__`.

## Краткое описание

**ru:** `Находит текст, спрятанный на странице для вашего ассистента, и показывает всё, что уходит с устройства.`

**en:** `Finds text hidden on a page for your assistant, and shows you everything that leaves the device.`

## Полное описание

### ru

```
Страницу всё чаще читает не человек, а ассистент: боковая панель браузера,
AI-браузер, расширение-суммаризатор. Текст, спрятанный от ваших глаз, для него
видим — и может оказаться инструкцией.

Okolos ищет такой текст на странице, обезвреживает его, не ломая страницу, и
показывает, что именно было спрятано и где.

Что он делает

• Находит скрытые инструкции — текст, невидимый человеку, но видимый ассистенту:
  подобранный под фон, в комментарии, в alt, в aria-label, в JSON-LD.
• Держит действие ассистента до вашего решения, если на странице есть
  неразобранная находка.
• Блокирует страницы по подписанному списку — до того, как они загрузятся.
• Предупреждает о доменах-двойниках, включая подмену латиницы кириллицей.
• Судит о загрузках и никогда не выдаёт непроверенное за проверенное.
• Следит за изменениями в установленных расширениях.
• Проверяет утечки по адресу почты и пароли по префиксу хеша.
• Ведёт по шагам восстановления после инцидента.

Чего он не делает

• Не отправляет историю браузинга. Страницы проверяются на устройстве по списку,
  скачанному целиком.
• Не считает «заблокированные угрозы» и не рисует уровень защиты.
• Не собирает аналитику, не просит аккаунт, не показывает рекламу.
• Не проверяет ваш адрес и пароли в фоне — только когда вы нажали.
• Не хранит ничего дольше 90 дней.

Что проверяемо

Каждый вердикт называет источник: какой список, какая ступень, дата записи.
Каждый вердикт оспаривается одним нажатием.

Экран «Самоаудит» показывает журнал отправок целиком: что ушло, куда, зачем и
когда. Его можно выгрузить одним файлом и стереть все данные.

Проверка пароля идёт по k-анонимности: уходят первые пять символов SHA-1-хеша,
не пароль. Проверка утечек отправляет введённый адрес целиком — иначе службы не
ответят, и мы говорим это прямо, а не прячем.

Расширение просит доступ ко всем сайтам, потому что скрытые инструкции ищутся на
любой странице. Ответ на это не обещание, а экран самоаудита.

Что уходит с устройства и почему: https://okolos-proxy.sergeysheleg4.workers.dev/privacy

Исходный код открыт под GNU AGPL-3.0. Бесплатно для людей и компаний; лицензия
для закрытых продуктов — по договорённости: https://passioncode.ai/business/
```

### en

```
A page is increasingly read by an assistant rather than a person: a browser
sidebar, an AI browser, a summarising extension. Text hidden from your eyes is
visible to it — and can turn out to be an instruction.

Okolos finds that text, neutralises it without breaking the page, and shows you
what was hidden and where.

What it does

• Finds hidden instructions — text invisible to a person and visible to an
  assistant: colour-on-colour, in a comment, in alt text, in an aria-label, in
  JSON-LD.
• Holds an assistant's action until you decide, when the page carries an
  unresolved finding.
• Blocks pages against a signed list, before they load.
• Warns about lookalike domains, including Latin letters replaced by Cyrillic.
• Judges downloads and never reports unchecked as clean.
• Watches your installed extensions for changes.
• Checks breaches by email address and passwords by hash prefix.
• Walks you through recovery after an incident.

What it does not do

• Does not send your browsing history. Pages are checked on the device against a
  list downloaded whole.
• Does not count "threats blocked" and draws no protection score.
• Collects no analytics, asks for no account, shows no advertising.
• Does not check your address or passwords in the background — only when you
  press.
• Keeps nothing longer than 90 days.

What is checkable

Every verdict names its source: which list, which stage, the date of the entry.
Every verdict is disputable in one click.

The self-audit screen shows the outbound log in full: what left, where to, why
and when. It exports as one file and wipes everything.

The password check uses k-anonymity: the first five characters of a SHA-1 hash
leave, not the password. The breach check sends the address you typed whole —
the services will not answer otherwise, and we say so rather than hide it.

The extension asks for access to all sites because hidden instructions are
looked for on any page. The answer to that is not a promise but a screen.

What leaves the device and why: https://okolos-proxy.sergeysheleg4.workers.dev/privacy

The source is open under the GNU AGPL-3.0. Free for people and companies; a
licence for closed-source products by agreement: https://passioncode.ai/business/
```

## Категория и языки

- **Категория:** Privacy & Security
- **Языки:** русский (основной), английский
- **Политика приватности:** `https://okolos-proxy.sergeysheleg4.workers.dev/privacy`

## Скриншоты

Снимаются с собранного расширения командой `pnpm screenshots` — это настоящие
экраны продукта, а не макеты. 1280×800, как требует магазин.

Сняты после B-16: у продукта есть визуальный слой, значения приходят из
`packages/ui/src/tokens.ts`, девять проверок axe проходят на стилизованной
сборке.

**Все четыре снимка по-русски** и проходят посценовую проверку языка:
`pnpm screenshots` называет поимённо любой экран без кириллицы и возвращает
ненулевой код. Кадр попапа центрирован, очередь засеяна.

Как получен русский, при том что браузер этого не умеет: `chrome.i18n.getUILanguage()` отвечает `ru-RU`, а
`getMessage('@@ui_locale')` в том же вызове — `en_GB`: у Chromium, который
ставит Playwright, **нет ни одного языкового пакета**, поэтому Chrome выбирает
каталог по запасному локалю независимо от `--lang=ru`. Проверять очевидное
(`getUILanguage`) бесполезно: оно соглашается с намерением.

Обход не требует другого браузера. Снимки делаются с копии сборки, из которой
удалён каталог `_locales/en`: Chrome надёжно падает на `default_locale`, а он
здесь `ru`. Код расширения при этом побайтово тот же, и каждая строка на снимке
— настоящая строка настоящего каталога.

Продукта это не касается — у пользователя с русским Chrome каталог `ru`
резолвится (195 ключей, `default_locale: ru`, проверено в собранном
артефакте). Это ограничение снимающего инструмента.

`pnpm screenshots` теперь **отказывается писать файлы**, если расширение
резолвит не русский, и печатает причину. Чтобы получить годные снимки, запустить
на браузере с языковыми пакетами (обычный Google Chrome — 220 локалей).

Кадрирование при этом исправлено и проверено: попап рисуется в ~390px, а кадр
магазина 1280×800, поэтому снимок был карточкой в углу с двумя третями пустоты.
Теперь попап центрируется, а очередь засеяна двумя находками через то же
хранилище, что у продукта — «ничего не требует вашего внимания» на витрине
показывало продукт, которому нечего сказать.

**Имя файла — утверждение, и оно две недели было ложным.** `03-self-audit.png` показывал
**обзор**: снимок открывал `options.html` без хеша, тогда как таблица ниже называла SCR-10, а
проза над ней продавала именно экран самоаудита. Рецензент сверяет подпись с картинкой первым
делом. Снимок теперь открывает `#audit`, и это держат два механизма: `pnpm screenshots`
отказывается писать файл, если названный экран не отрисован (`expects`), и записывает в расписку
роль, которая на нём оказалась; `tools/listing.test.ts` сверяет имя файла с этой записью
(B-109).

| Файл | Экран | Что показывает |
|---|---|---|
| `01-interstitial.png` | SCR-05 | блокировка до загрузки, с названием списка и датой записи |
| `02-first-run.png` | SCR-01 | первый запуск: что проверено локально |
| `03-self-audit.png` | SCR-10 | журнал отправок: что ушло, куда, зачем и когда, плюс выбор периода |
| `04-popup.png` | SCR-02 | вердикт по текущей странице |

## Чего в карточке нет намеренно

- **Скриншотов третьей ступени на модели** — она не выпускается.
- **Слов «полностью», «гарантированно», «100%»** — правило голоса, и не
  риторическое: вердикт не может обогнать проверки, которые прошли.
- **«Ваш компьютер под угрозой»** и подобного — это текст мошенников, который
  продукт детектирует.
