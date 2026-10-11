import * as path from "path";
import * as vscode from "vscode";
import { execFile } from "child_process";
import { ClaudeSettings } from "./claude-settings";

/**
 * Первый запуск: без хука расширение не видит правок Claude, поэтому предлагаем подключиться одной кнопкой.
 * Хук обновляется вместе с расширением; подключение и отключение — командами
 */
export class HookSetup {
  constructor(
    private readonly settings: ClaudeSettings,
    private readonly context: vscode.ExtensionContext,
  ) {}

  register(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand("claudeReview.connectHook", () =>
        this.connect(),
      ),
      vscode.commands.registerCommand("claudeReview.disconnectHook", () =>
        this.disconnect(),
      ),
    );
    try {
      this.settings.copyHook(
        path.join(this.context.extensionPath, "hook", "review-hook.js"),
      );
      if (
        this.settings.isConnected() ||
        this.context.globalState.get("claudeReview.hookDeclined")
      )
        return;
    } catch (error) {
      vscode.window.showErrorMessage(
        `Diff Inline: ${(error as Error).message}`,
      );
      return;
    }
    this.offer();
  }

  private async offer(): Promise<void> {
    const answer = await vscode.window.showInformationMessage(
      "Подключить Diff Inline к Claude Code? Расширение добавит хуки в ~/.claude/settings.json — без них оно не видит правок Claude.",
      "Подключить",
      "Не сейчас",
      "Больше не спрашивать",
    );
    if (answer === "Подключить") await this.connect();
    if (answer === "Больше не спрашивать")
      await this.context.globalState.update("claudeReview.hookDeclined", true);
  }

  private async connect(): Promise<void> {
    try {
      this.settings.connect();
    } catch (error) {
      vscode.window.showErrorMessage(
        `Diff Inline: ${(error as Error).message}`,
      );
      return;
    }
    vscode.window.showInformationMessage(
      "Diff Inline подключён к Claude Code. Если Claude Code уже запущен — открой /hooks или перезапусти его, чтобы он перечитал настройки.",
    );
    // хук запускается командой node — без Node.js в PATH он молча не сработает
    execFile("node", ["--version"], (error) => {
      if (error) {
        vscode.window.showWarningMessage(
          "Diff Inline: Node.js не найден. Хук запускается командой node — установи Node.js 18+ и проверь, что `node` есть в терминале.",
        );
      }
    });
  }

  private disconnect(): void {
    try {
      this.settings.disconnect();
      vscode.window.showInformationMessage(
        "Diff Inline отключён от Claude Code: его хуки убраны из ~/.claude/settings.json.",
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Diff Inline: ${(error as Error).message}`,
      );
    }
  }
}
