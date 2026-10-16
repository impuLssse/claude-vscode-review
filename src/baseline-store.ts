import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/** Исходная версия файла до первой правки Claude — её пишет hook/snapshot.js */
export interface Baseline {
  path: string;
  created: boolean;
  content: string;
}

export interface BaselineEntry {
  mtimeMs: number;
  baseline: Baseline;
}

/** Сигнал хука на Stop: Claude закончил ответ, files — что он трогал за этот ответ */
export interface FinishedTurn {
  mtimeMs: number;
  files: string[];
}

/**
 * Папка ~/.claude-review: по JSON на каждый файл, который Claude поменял и который ещё не отревьюен
 * (имя — sha1 пути), плюс finished.json от хука на конец ответа
 */
export class BaselineStore {
  private readonly dir = path.join(os.homedir(), ".claude-review");
  private cache = new Map<string, BaselineEntry>();

  /** Все исходники вместе с mtime JSON — опрос раз в секунду не перечитывает файлы, которые не менялись */
  list(): BaselineEntry[] {
    let names: string[];
    try {
      names = fs
        .readdirSync(this.dir)
        .filter((name) => /^[0-9a-f]{40}\.json$/.test(name));
    } catch {
      return [];
    }
    const cache = new Map<string, BaselineEntry>();
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const mtimeMs = fs.statSync(file).mtimeMs;
        const cached = this.cache.get(file);
        const entry =
          cached?.mtimeMs === mtimeMs
            ? cached
            : { mtimeMs, baseline: JSON.parse(fs.readFileSync(file, "utf8")) };
        cache.set(file, entry);
      } catch {
        // файл удалили между readdir и чтением
      }
    }
    this.cache = cache;
    return [...cache.values()];
  }

  /** Исходник одного файла; JSON перечитывается, только если поменялся его mtime — load зовут на каждое переключение вкладки */
  read(filePath: string): BaselineEntry | undefined {
    const file = this.fileFor(filePath);
    try {
      const mtimeMs = fs.statSync(file).mtimeMs;
      const cached = this.cache.get(file);
      if (cached?.mtimeMs === mtimeMs) return cached;
      const entry = {
        mtimeMs,
        baseline: JSON.parse(fs.readFileSync(file, "utf8")),
      };
      this.cache.set(file, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  write(baseline: Baseline): void {
    const file = this.fileFor(baseline.path);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(baseline));
    fs.renameSync(file + ".tmp", file);
  }

  delete(filePath: string): void {
    fs.rmSync(this.fileFor(filePath), { force: true });
  }

  readFinished(): FinishedTurn | undefined {
    const file = path.join(this.dir, "finished.json");
    try {
      return {
        mtimeMs: fs.statSync(file).mtimeMs,
        files: JSON.parse(fs.readFileSync(file, "utf8")).files,
      };
    } catch {
      return undefined;
    }
  }

  /** Имя JSON — sha1 абсолютного пути, так же считает хук */
  private fileFor(filePath: string): string {
    return path.join(
      this.dir,
      crypto.createHash("sha1").update(filePath).digest("hex") + ".json",
    );
  }
}
