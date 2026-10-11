import * as os from "os";
import * as fs from "fs";
import * as path from "path";

/** Одна запись хука в ~/.claude/settings.json: событие → [{ matcher, hooks: [{ type, command }] }] */
interface HookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
}

/**
 * Подключение расширения к Claude Code: копия хука в постоянном месте (~/.claude-review/hook — путь не меняется
 * при обновлении расширения) и четыре записи в ~/.claude/settings.json. Чужие настройки и чужие хуки не трогаются
 */
export class ClaudeSettings {
  /** Свои записи узнаём по имени скрипта — так находятся и записи со старым путём */
  private static readonly marker = "review-hook.js";
  /** Перед правкой, после команды в терминале (успешной и упавшей), в конце ответа */
  private static readonly events: [string, string | undefined][] = [
    ["PreToolUse", "Edit|Write|MultiEdit|Bash"],
    ["PostToolUse", "Bash"],
    ["PostToolUseFailure", "Bash"],
    ["Stop", undefined],
  ];

  constructor(
    readonly settingsFile = path.join(os.homedir(), ".claude", "settings.json"),
    readonly hookFile = path.join(
      os.homedir(),
      ".claude-review",
      "hook",
      "review-hook.js",
    ),
  ) {}

  /** Положить свежую копию хука из расширения — после обновления расширения хук обновится сам */
  copyHook(source: string): void {
    const content = fs.readFileSync(source, "utf8");
    if (
      fs.existsSync(this.hookFile) &&
      fs.readFileSync(this.hookFile, "utf8") === content
    )
      return;
    fs.mkdirSync(path.dirname(this.hookFile), { recursive: true });
    fs.writeFileSync(this.hookFile, content);
  }

  /** Подключено, если на каждое из четырёх событий есть наша запись — с любым путём к скрипту */
  isConnected(): boolean {
    const hooks = this.read().hooks ?? {};
    return ClaudeSettings.events.every(([event]) =>
      (hooks[event] ?? []).some((group) => this.isOurs(group)),
    );
  }

  /**
   * Дописать свои записи (старые свои — заменить). Перед первой записью кладёт рядом копию настроек
   * settings.json.before-diff-inline. Если файл не JSON — бросает ошибку и ничего не пишет
   */
  connect(): void {
    const settings = this.read();
    const backup = this.settingsFile + ".before-diff-inline";
    if (fs.existsSync(this.settingsFile) && !fs.existsSync(backup))
      fs.copyFileSync(this.settingsFile, backup);
    const hooks = this.withoutOurs(settings.hooks ?? {});
    const command = `node "${this.hookFile}"`;
    for (const [event, matcher] of ClaudeSettings.events) {
      hooks[event] = [
        ...(hooks[event] ?? []),
        {
          ...(matcher && { matcher }),
          hooks: [{ type: "command", command, timeout: 10 }],
        },
      ];
    }
    this.write({ ...settings, hooks });
  }

  /** Убрать свои записи; пустые события и пустой hooks тоже убираются */
  disconnect(): void {
    const settings = this.read();
    const hooks = this.withoutOurs(settings.hooks ?? {});
    if (Object.keys(hooks).length) settings.hooks = hooks;
    else delete settings.hooks;
    this.write(settings);
  }

  private isOurs(group: HookGroup): boolean {
    return (group.hooks ?? []).some(({ command }) =>
      command?.includes(ClaudeSettings.marker),
    );
  }

  private withoutOurs(
    hooks: Record<string, HookGroup[]>,
  ): Record<string, HookGroup[]> {
    const result: Record<string, HookGroup[]> = {};
    for (const [event, groups] of Object.entries(hooks)) {
      const kept = groups.filter((group) => !this.isOurs(group));
      if (kept.length) result[event] = kept;
    }
    return result;
  }

  private read(): {
    hooks?: Record<string, HookGroup[]>;
    [key: string]: unknown;
  } {
    if (!fs.existsSync(this.settingsFile)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.settingsFile, "utf8"));
    } catch {
      throw new Error(
        `${this.settingsFile} — не JSON, править его автоматически небезопасно`,
      );
    }
  }

  private write(settings: object): void {
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    fs.writeFileSync(
      this.settingsFile,
      JSON.stringify(settings, null, 2) + "\n",
    );
  }
}
