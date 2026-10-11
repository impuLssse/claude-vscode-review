#!/usr/bin/env node
/**
 * Хук Claude Code для расширения Claude Review — одна точка на все события:
 * - PreToolUse Edit / Write / MultiEdit — перед первой правкой файла кладёт его исходную версию в ~/.claude-review;
 * - PreToolUse Bash — запоминает содержимое уже изменённых файлов в git-репозиториях, которые задевает команда;
 * - PostToolUse / PostToolUseFailure Bash — для файлов, которые поменяла команда, пишет исходную версию:
 *   запомненную перед командой или, если файл до неё был чистым, версию из git;
 * - Stop — Claude закончил ответ: пишет список тронутых за ответ файлов, расширение показывает уведомление.
 * Хук никогда не мешает Claude: любая ошибка — тихий выход с кодом 0
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

class ReviewHook {
  constructor(input) {
    this.input = input;
    this.dir = path.join(os.homedir(), ".claude-review");
  }

  run() {
    const {
      tool_name: tool,
      tool_input: toolInput,
      hook_event_name: event,
    } = this.input;
    if (event === "Stop") return this.finishTurn();
    if (tool !== "Bash")
      return (
        toolInput?.file_path &&
        this.snapshotFile(
          path.resolve(this.input.cwd ?? process.cwd(), toolInput.file_path),
        )
      );
    if (event === "PreToolUse") return this.rememberDirty();
    return this.snapshotChanged();
  }

  /** Edit / Write: снимок только перед первой правкой — дальше исходником остаётся самая первая версия */
  snapshotFile(filePath) {
    // память и настройки самого Claude ревьюить не нужно
    if (filePath.startsWith(path.join(os.homedir(), ".claude") + path.sep))
      return;
    this.touch([filePath]);
    if (fs.existsSync(this.baselineFile(filePath))) return;
    const created = !fs.existsSync(filePath);
    const content = created ? "" : this.readText(filePath);
    if (content !== false)
      this.writeJson(this.baselineFile(filePath), {
        path: filePath,
        created,
        content,
      });
  }

  /** Bash, до команды: содержимое уже изменённых файлов (false — бинарный или огромный, null — файла нет) */
  rememberDirty() {
    const state = {};
    for (const root of this.gitRoots()) {
      state[root] = {};
      for (const rel of this.dirtyFiles(root)) {
        const abs = path.join(root, rel);
        state[root][rel] = fs.existsSync(abs) ? this.readText(abs) : null;
      }
    }
    this.writeJson(this.pendingFile(), state);
  }

  /** Bash, после команды: что поменялось по сравнению с запомненным или с git — то и уходит на ревью */
  snapshotChanged() {
    const state = this.readJson(this.pendingFile());
    fs.rmSync(this.pendingFile(), { force: true });
    if (!state) return;
    const changed = [];
    for (const [root, before] of Object.entries(state)) {
      for (const rel of new Set([
        ...Object.keys(before),
        ...this.dirtyFiles(root),
      ])) {
        const abs = path.join(root, rel);
        // до команды файл был чистым — значит, его прежнее содержимое лежит в git
        const old = rel in before ? before[rel] : this.indexText(root, rel);
        const now = fs.existsSync(abs) ? this.readText(abs) : null;
        if (old === false || now === false || old === now) continue;
        changed.push(abs);
        if (!fs.existsSync(this.baselineFile(abs)))
          this.writeJson(this.baselineFile(abs), {
            path: abs,
            created: old === null,
            content: old ?? "",
          });
      }
    }
    this.touch(changed);
  }

  /** Конец ответа Claude: файлы, тронутые за ответ, — расширение покажет по ним уведомление */
  finishTurn() {
    const files = this.readJson(this.turnFile()) ?? [];
    fs.rmSync(this.turnFile(), { force: true });
    if (files.length)
      this.writeJson(path.join(this.dir, "finished.json"), {
        at: Date.now(),
        files,
      });
  }

  touch(files) {
    if (!files.length) return;
    this.writeJson(this.turnFile(), [
      ...new Set([...(this.readJson(this.turnFile()) ?? []), ...files]),
    ]);
  }

  /** Репозитории, которые задевает команда: текущая папка и абсолютные пути из текста команды */
  gitRoots() {
    const home = os.homedir();
    const mentioned = [
      ...(this.input.tool_input?.command ?? "").matchAll(
        /(?:^|[\s'"=])((?:~|\/)[^\s'";|&<>()]*)/g,
      ),
    ].map(([, p]) => p.replace(/^~/, home));
    const roots = new Set();
    for (const candidate of [
      this.input.cwd ?? process.cwd(),
      ...mentioned,
    ].slice(0, 10)) {
      let dir = candidate;
      while (!fs.existsSync(dir)) dir = path.dirname(dir);
      if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
      try {
        // --show-cdup, а не --show-toplevel: тот раскрывает симлинки (/var → /private/var), и пути снимков разъехались бы с путями расширения
        const up = execFileSync("git", ["rev-parse", "--show-cdup"], {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        roots.add(path.resolve(dir, up));
      } catch {
        // не git — правки через терминал здесь не отследить
      }
    }
    return [...roots].filter((root) => root !== home);
  }

  /** Изменённые, новые и удалённые файлы репозитория по git status (при переименовании — оба пути) */
  dirtyFiles(root) {
    const output = execFileSync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 },
    );
    const tokens = output.split("\0").filter(Boolean);
    const files = [];
    for (let i = 0; i < tokens.length && files.length < 500; i++) {
      files.push(tokens[i].slice(3));
      if ("RC".includes(tokens[i][0])) files.push(tokens[++i]);
    }
    return files.filter(
      (rel) =>
        !fs.existsSync(path.join(root, rel)) ||
        fs.statSync(path.join(root, rel)).isFile(),
    );
  }

  /** Версия файла из индекса git; null — в git его нет */
  indexText(root, rel) {
    try {
      const content = execFileSync("git", ["show", `:${rel}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 << 20,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return content.includes("\0") ? false : content;
    } catch {
      return null;
    }
  }

  /** Текст файла; false — бинарный или больше 5 МБ, такие не ревьюим */
  readText(filePath) {
    if (fs.statSync(filePath).size > 5_000_000) return false;
    const content = fs.readFileSync(filePath, "utf8");
    return content.includes("\0") ? false : content;
  }

  readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  }

  writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(value));
    fs.renameSync(file + ".tmp", file);
  }

  /** Имя снимка — sha1 абсолютного пути, так же считает расширение */
  baselineFile(filePath) {
    return path.join(
      this.dir,
      crypto.createHash("sha1").update(filePath).digest("hex") + ".json",
    );
  }

  /** Состояние между Pre и Post одной команды; параллельные команды различаются по tool_use_id */
  pendingFile() {
    return path.join(
      this.dir,
      "bash",
      `${this.input.tool_use_id ?? this.input.session_id}.json`,
    );
  }

  turnFile() {
    return path.join(this.dir, "turns", `${this.input.session_id}.json`);
  }
}

try {
  new ReviewHook(JSON.parse(fs.readFileSync(0, "utf8"))).run();
} catch {
  // снимок не получился — Claude работает дальше, просто без ревью этой правки
}
