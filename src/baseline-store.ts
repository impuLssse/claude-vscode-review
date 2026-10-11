import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

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

/** Папка ~/.claude-review: по JSON на каждый файл, который Claude поменял и который ещё не отревьюен */
export class BaselineStore {
  private readonly dir = path.join(os.homedir(), '.claude-review');
  private cache = new Map<string, BaselineEntry>();

  /** Все исходники вместе с mtime JSON — опрос раз в секунду не перечитывает файлы, которые не менялись */
  list(): BaselineEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    const cache = new Map<string, BaselineEntry>();
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const mtimeMs = fs.statSync(file).mtimeMs;
        const cached = this.cache.get(file);
        const entry = cached?.mtimeMs === mtimeMs ? cached : { mtimeMs, baseline: JSON.parse(fs.readFileSync(file, 'utf8')) };
        cache.set(file, entry);
      } catch {
        // файл удалили между readdir и чтением
      }
    }
    this.cache = cache;
    return [...cache.values()];
  }

  read(filePath: string): BaselineEntry | undefined {
    const file = this.fileFor(filePath);
    try {
      return { mtimeMs: fs.statSync(file).mtimeMs, baseline: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      return undefined;
    }
  }

  write(baseline: Baseline): void {
    const file = this.fileFor(baseline.path);
    fs.writeFileSync(file + '.tmp', JSON.stringify(baseline));
    fs.renameSync(file + '.tmp', file);
  }

  delete(filePath: string): void {
    fs.rmSync(this.fileFor(filePath), { force: true });
  }

  /** Имя JSON — sha1 абсолютного пути, так же считает хук */
  private fileFor(filePath: string): string {
    return path.join(this.dir, crypto.createHash('sha1').update(filePath).digest('hex') + '.json');
  }
}
