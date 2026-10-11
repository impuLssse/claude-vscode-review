# Diff Inline (Cursor Based)

Cursor-style review of [Claude Code](https://www.anthropic.com/claude-code) edits right inside VS Code. Claude changes your files, you open a file and see what changed in place — old lines in red, new lines in green — and press **Accept** or **Reject** for every change.

> **Unofficial extension.** Not affiliated with, endorsed or sponsored by Anthropic or Anysphere. See [Disclaimer](#disclaimer).

[Русская версия ниже](#на-русском)

## Requirements

|                            |                                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node.js 18+ — required** | The hook that tells the extension about Claude's edits runs as `node …`. `node` must be available in the terminal where Claude Code runs. Without it the extension sees nothing. |
| **Claude Code**            | CLI or the VS Code extension. The extension works through Claude Code hooks.                                                                                                     |
| **VS Code 1.100+**         |                                                                                                                                                                                  |
| git                        | Optional. Needed only to review edits Claude makes through the terminal (`sed`, scripts).                                                                                        |

## Getting started

1. Install the extension.
2. On first start it asks **«Подключить Diff Inline к Claude Code?»** ("Connect Diff Inline to Claude Code?") — press **Подключить** (Connect). It adds four hook entries to `~/.claude/settings.json` (a copy of the original file is saved as `settings.json.before-diff-inline`). Your other settings and hooks stay untouched.
3. If Claude Code is already running, open `/hooks` in it or restart it so it re-reads the settings.
4. Ask Claude to change something. When it finishes, a notification shows how many files changed — press **Смотреть** (View).

Connect and disconnect any time from the Command Palette: **Diff Inline: подключить к Claude Code** / **Diff Inline: отключить от Claude Code**.

## Using it

- **Review tab.** Opening a file with Claude's changes opens the review tab in its place: old lines in red, new lines in green, changed words highlighted brighter. Under every change there are green **Accept** and red **Reject** buttons.
- **Accept** keeps the change. **Reject** writes the old lines back to the file on disk.
- **Undo.** `⌘Z` brings back the last Accept or Reject together with its buttons — even after the tab turned back into the file or the window was reloaded.
- **Claude changes list** sits next to the Claude Code chat: changed files as a list or a folder tree, every change inside with ✓ / ✗, and Accept all / Reject all in the title bar.
- **Open file** at the top of the review tab opens the real file if you want to edit it by hand.

| Key           | Action                                      |
| ------------- | ------------------------------------------- |
| `⌥Y` / `⌥N`   | Accept / Reject the change under the cursor |
| `⇧⌥Y` / `⇧⌥N` | Accept / Reject the whole file              |
| `⌥J`          | Next change, then next file                 |
| `⌘Z`          | Undo the last Accept / Reject               |

The interface is in Russian for now.

## How it works

- Before Claude's first edit of a file, the hook saves the original into `~/.claude-review/`. The extension compares the file with that copy; when everything is accepted or rejected, the copy is deleted.
- For terminal commands the hook remembers modified files of the git repositories the command touches (the current folder and absolute paths in the command), and takes originals of clean files from git.
- A file shows up only if it lies inside a folder open in this VS Code window.
- Nothing is sent anywhere: everything stays on your machine.

## Limitations

- Your own edits to a file that is under review are shown as Claude's.
- Syntax highlighting in the review tab can drift when a change cuts a multi-line string or comment — the file itself is fine.
- Terminal edits are tracked only inside git repositories.

## Uninstall

Run **Diff Inline: отключить от Claude Code**, then uninstall the extension and delete `~/.claude-review`.

## Disclaimer

This is an independent, unofficial project. It is not affiliated with, endorsed, sponsored or approved by Anthropic PBC or Anysphere Inc. Claude and Claude Code are trademarks of Anthropic PBC. Cursor is a trademark of Anysphere Inc. The names are used only to describe what the extension works with.

## License

[MIT](LICENSE)

---

## На русском

Ревью правок [Claude Code](https://www.anthropic.com/claude-code) прямо в VS Code, как в Cursor. Claude меняет файлы, ты открываешь файл и видишь изменения на месте — старое красным, новое зелёным — и на каждую правку жмёшь **Accept** или **Reject**.

> **Неофициальное расширение.** Не связано с Anthropic и Anysphere и не одобрено ими. См. [Оговорку](#оговорка).

### Требования

- **Node.js 18+ — обязательно.** Хук, через который расширение узнаёт о правках Claude, запускается командой `node …`. `node` должен быть доступен в терминале, где работает Claude Code. Без него расширение ничего не увидит.
- **Claude Code** — CLI или расширение для VS Code.
- **VS Code 1.100+.**
- git — по желанию: нужен только для ревью правок, которые Claude делает через терминал (`sed`, скрипты).

### Начало работы

1. Установи расширение.
2. При первом запуске оно спросит **«Подключить Diff Inline к Claude Code?»** — нажми **Подключить**. В `~/.claude/settings.json` добавятся четыре записи хуков (копия исходного файла сохранится как `settings.json.before-diff-inline`). Остальные настройки и хуки не трогаются.
3. Если Claude Code уже запущен — открой в нём `/hooks` или перезапусти, чтобы он перечитал настройки.
4. Попроси Claude что-нибудь поменять. Когда он закончит, всплывёт уведомление со сводкой — жми **Смотреть**.

Подключить и отключить можно в любой момент из палитры команд: **Diff Inline: подключить к Claude Code** / **Diff Inline: отключить от Claude Code**.

### Как пользоваться

- **Вкладка ревью** открывается вместо файла с правками: старые строки красным, новые зелёным, изменённые слова ярче. Под каждой правкой — зелёная **Accept** и красная **Reject**.
- **Accept** оставляет правку. **Reject** возвращает старые строки в файл на диске.
- **Отмена.** `⌘Z` возвращает последний Accept или Reject вместе с кнопками — даже после перезагрузки окна.
- **Список «Правки Claude»** рядом с чатом Claude Code: файлы списком или деревом папок, внутри каждая правка с ✓ / ✗, в заголовке — принять всё / отклонить всё.
- **«Открыть файл»** вверху вкладки ревью открывает сам файл, если хочешь поправить руками.

| Клавиши       | Действие                                |
| ------------- | --------------------------------------- |
| `⌥Y` / `⌥N`   | Принять / отклонить правку под курсором |
| `⇧⌥Y` / `⇧⌥N` | Принять / отклонить весь файл           |
| `⌥J`          | Следующая правка, потом следующий файл  |
| `⌘Z`          | Отменить последний Accept / Reject      |

### Как это устроено

- Перед первой правкой файла хук сохраняет исходник в `~/.claude-review/`. Расширение сравнивает файл с этой копией; когда всё принято или отклонено, копия удаляется.
- Для команд в терминале хук запоминает изменённые файлы git-репозиториев, которые задевает команда, а исходники чистых файлов берёт из git.
- Файл показывается, только если он лежит в папке, открытой в этом окне VS Code.
- Ничего никуда не отправляется — всё остаётся на твоём компьютере.

### Ограничения

- Твои собственные правки в файле, который на ревью, показываются как правки Claude.
- Раскраска во вкладке ревью может «поплыть», если правка задевает многострочную строку или комментарий — сам файл при этом в порядке.
- Правки через терминал отслеживаются только в git-репозиториях.

### Удаление

Выполни **Diff Inline: отключить от Claude Code**, удали расширение и папку `~/.claude-review`.

### Оговорка

Это независимый неофициальный проект. Он не связан с Anthropic PBC и Anysphere Inc., не одобрен, не спонсирован и не согласован ими. Claude и Claude Code — товарные знаки Anthropic PBC. Cursor — товарный знак Anysphere Inc. Названия используются только чтобы описать, с чем работает расширение.
