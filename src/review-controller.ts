import {
  FileState,
  Review,
  ReviewBlock,
  ReviewService,
} from "./review-service";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { BaselineStore } from "./baseline-store";
import { ChangeNode, ChangesTree } from "./changes-tree";

/** Одно действие Accept / Reject: состояние до — для отката, после — чтобы не откатить поверх чужих правок */
interface UndoStep {
  index: number;
  after: FileState;
  before: FileState;
}

/**
 * Вкладка ревью вместо самого файла: когда открываешь файл с правками Claude, она встаёт на место его вкладки.
 * В ней текст файла, где над новыми строками (зелёные) вклеены старые (красные), а над каждым куском — Accept / Reject.
 * Вкладка только для чтения, поэтому автосохранение и TypeScript её не трогают; на диск пишет только Reject
 */
export class ReviewController
  implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider
{
  private static readonly scheme = "claude-review";

  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  readonly onDidChangeCodeLenses = this.lensesChanged.event;

  /** Ревью всех файлов с правками по последнему опросу — для списка правок, строки состояния и перехода к следующему файлу */
  private readonly reviews = new Map<string, Review>();
  /** Что сейчас показано во вкладках ревью — по этому рисуются подсветка и кнопки и выполняются Accept / Reject */
  private readonly rendered = new Map<string, Review>();
  /** Индекс куска, на который поставить курсор после Accept / Reject, когда вкладка перерисуется */
  private readonly focusIndex = new Map<string, number>();
  /** Файлы, открытые «как есть» кнопкой «Открыть файл», — их не подменяем, пока ревью файла не закончится */
  private readonly suppressed = new Set<string>();
  /** История Accept / Reject по файлам — Cmd+Z снимает с неё последнее действие; живёт в workspaceState и переживает перезагрузку окна */
  private readonly undoSteps: Map<string, UndoStep[]>;
  /** mtime finished.json, по которому уже показали уведомление «Claude закончил» */
  private finishedMtime: number;
  /** mtime исходника и файла на прошлом опросе — по ним видно, что пора перерисовать */
  private signatures = new Map<string, string>();

  private readonly statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor(
      "editorOverviewRuler.addedForeground",
    ),
  });
  private readonly removed = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor(
      "editorOverviewRuler.deletedForeground",
    ),
  });
  private readonly removedWords = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
  });
  private readonly addedWords = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
  });
  private readonly acceptButton = vscode.window.createTextEditorDecorationType({
    cursor: "pointer",
    color: "#ffffff",
    fontWeight: "bold",
    borderRadius: "4px",
    backgroundColor: "#2ea043",
  });
  private readonly rejectButton = vscode.window.createTextEditorDecorationType({
    cursor: "pointer",
    color: "#ffffff",
    fontWeight: "bold",
    borderRadius: "4px",
    backgroundColor: "#da3633",
  });

  constructor(
    private readonly tree: ChangesTree,
    private readonly store: BaselineStore,
    private readonly memento: vscode.Memento,
    private readonly service: ReviewService,
  ) {
    this.undoSteps = new Map(
      Object.entries(
        memento.get<Record<string, UndoStep[]>>("claudeReview.undo", {}),
      ),
    );
    // уведомление только о новых ответах Claude — не о том, что закончилось до открытия окна
    this.finishedMtime = store.readFinished()?.mtimeMs ?? 0;
  }

  register(context: vscode.ExtensionContext): void {
    const scheme = ReviewController.scheme;
    const timer = setInterval(() => this.poll(), 1000);
    this.statusBar.command = "claudeReview.list";
    this.statusBar.tooltip = "Файлы с непросмотренными правками Claude";
    context.subscriptions.push(
      this.added,
      this.removed,
      this.changed,
      this.statusBar,
      this.addedWords,
      this.removedWords,
      this.acceptButton,
      this.rejectButton,
      this.lensesChanged,
      { dispose: () => clearInterval(timer) },
      vscode.languages.registerCodeLensProvider({ scheme }, this),
      vscode.workspace.registerTextDocumentContentProvider(scheme, this),
      vscode.commands.registerCommand("claudeReview.next", () => this.next()),
      vscode.commands.registerCommand("claudeReview.undo", () => this.undo()),
      // Cmd+S во вкладке ревью: VS Code не знает, куда сохранять виртуальный документ, и открыл бы «Сохранить как»
      vscode.commands.registerCommand("claudeReview.save", () =>
        vscode.window.setStatusBarMessage(
          "Вкладка ревью: сохранять нечего — файл на диске уже актуален",
          2500,
        ),
      ),
      vscode.commands.registerCommand("claudeReview.list", () => this.list()),
      vscode.commands.registerCommand("claudeReview.acceptAll", () =>
        this.acceptAll(),
      ),
      vscode.commands.registerCommand("claudeReview.rejectAll", () =>
        this.rejectAll(),
      ),
      vscode.commands.registerCommand(
        "claudeReview.openFile",
        (filePath?: string) => this.openFile(filePath),
      ),
      vscode.commands.registerCommand(
        "claudeReview.show",
        (filePath: string, index: number) => this.showReview(filePath, index),
      ),
      // из CodeLens приходят (путь, индекс), из списка правок — строка списка целиком
      vscode.commands.registerCommand(
        "claudeReview.acceptFile",
        (target?: string | ChangeNode) =>
          this.acceptFile(this.targetPath(target)),
      ),
      vscode.commands.registerCommand(
        "claudeReview.rejectFile",
        (target?: string | ChangeNode) =>
          this.rejectFile(this.targetPath(target)),
      ),
      vscode.commands.registerCommand(
        "claudeReview.acceptHunk",
        (target?: string | ChangeNode, index?: number) =>
          this.acceptHunk(
            this.targetPath(target),
            typeof target === "object" ? target.index : index,
          ),
      ),
      vscode.commands.registerCommand(
        "claudeReview.rejectHunk",
        (target?: string | ChangeNode, index?: number) =>
          this.rejectHunk(
            this.targetPath(target),
            typeof target === "object" ? target.index : index,
          ),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        this.swapToReview(editor),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) =>
        this.revealInExplorer(editor),
      ),
      vscode.window.onDidChangeVisibleTextEditors((editors) =>
        editors.forEach((editor) => this.decorate(editor)),
      ),
      vscode.window.onDidChangeTextEditorSelection((event) =>
        this.onButtonClick(event),
      ),
      vscode.workspace.onDidChangeTextDocument(({ document }) =>
        this.onReviewChanged(document),
      ),
      // начал печатать в самом файле — Cmd+Z снова обычная отмена набора, а не откат ревью
      vscode.workspace.onDidChangeTextDocument(
        ({ document }) =>
          document.isDirty && this.dropUndo(document.uri.fsPath),
      ),
    );
    this.tree.register(context);
    this.updateUndoContext();
    this.poll();
    this.swapToReview(vscode.window.activeTextEditor);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const filePath = uri.fsPath;
    const review = this.service.load(filePath);
    if (!review) {
      this.rendered.delete(filePath);
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    }
    this.rendered.set(filePath, review);
    return review.mergedLines.join("\n");
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const review = this.rendered.get(document.uri.fsPath);
    if (!review) return [];
    // кнопки отдельных кусков — цветные строки в самом тексте, тут только действия над всем файлом
    const top = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(top, {
        title: `Claude: правок ${review.blocks.length}`,
        command: "",
      }),
      new vscode.CodeLens(top, {
        title: "✓ Принять весь файл ⇧⌥Y",
        command: "claudeReview.acceptFile",
        arguments: [review.path],
      }),
      new vscode.CodeLens(top, {
        title: "✗ Отклонить весь файл ⇧⌥N",
        command: "claudeReview.rejectFile",
        arguments: [review.path],
      }),
      new vscode.CodeLens(top, {
        title: "Открыть файл",
        command: "claudeReview.openFile",
        arguments: [review.path],
      }),
    ];
  }

  private acceptHunk(filePath?: string, index?: number): void {
    const target = this.targetBlock(filePath, index);
    if (!target) return;
    this.recordUndo(target.review.path, target.index, () =>
      this.service.acceptHunk(target.review, target.block),
    );
  }

  private rejectHunk(filePath?: string, index?: number): void {
    const target = this.targetBlock(filePath, index);
    if (!target || this.realFileDirty(target.review.path)) return;
    this.recordUndo(target.review.path, target.index, () =>
      this.service.rejectHunk(target.review, target.block),
    );
  }

  private acceptFile(filePath?: string): void {
    const review = this.targetReview(filePath);
    if (!review) return;
    this.recordUndo(review.path, 0, () => this.service.acceptFile(review));
  }

  private async rejectFile(filePath?: string): Promise<void> {
    const review = this.targetReview(filePath);
    if (!review || this.realFileDirty(review.path)) return;
    const name = path.basename(review.path);
    const answer = await vscode.window.showWarningMessage(
      `Отклонить все правки Claude в ${name} (${review.blocks.length})?`,
      { modal: true },
      "Отклонить",
    );
    if (answer !== "Отклонить") return;
    this.recordUndo(review.path, 0, () => this.service.rejectFile(review));
  }

  /** Принять всё во всех файлах; Cmd+Z в каждом файле потом откатывает его отдельно */
  private acceptAll(): void {
    for (const review of [...this.reviews.values()])
      this.recordUndo(review.path, 0, () => this.service.acceptFile(review));
  }

  private async rejectAll(): Promise<void> {
    const reviews = [...this.reviews.values()];
    if (
      !reviews.length ||
      reviews.some(({ path: filePath }) => this.realFileDirty(filePath))
    )
      return;
    const answer = await vscode.window.showWarningMessage(
      `Отклонить все правки Claude в ${reviews.length} файлах?`,
      { modal: true },
      "Отклонить",
    );
    if (answer !== "Отклонить") return;
    for (const review of reviews)
      this.recordUndo(review.path, 0, () => this.service.rejectFile(review));
  }

  private targetPath(target?: string | ChangeNode): string | undefined {
    return typeof target === "object" ? target.filePath : target;
  }

  /** Выполнить Accept / Reject и запомнить состояние до и после — для Cmd+Z */
  private recordUndo(
    filePath: string,
    index: number,
    action: () => void,
  ): void {
    const before = this.service.snapshot(filePath);
    action();
    const steps = [
      ...(this.undoSteps.get(filePath) ?? []),
      { index, before, after: this.service.snapshot(filePath) },
    ];
    this.undoSteps.set(filePath, steps.slice(-50));
    this.updateUndoContext();
    this.refresh(filePath, index);
  }

  /**
   * Cmd+Z: вернуть последний Accept / Reject файла вместе с вопросом. Работает и во вкладке ревью,
   * и в самом файле, если вкладка уже превратилась в него. Если файл с тех пор менялся — откат не делаем, чтобы не затереть
   */
  private undo(): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const step = uri ? this.undoSteps.get(uri.fsPath)?.at(-1) : undefined;
    if (!uri || !step) return;
    const filePath = uri.fsPath;
    if (
      JSON.stringify(this.service.snapshot(filePath)) !==
      JSON.stringify(step.after)
    ) {
      this.dropUndo(filePath);
      vscode.window.showWarningMessage(
        `${path.basename(filePath)} поменялся после Accept / Reject — откатить уже нельзя`,
      );
      return;
    }
    this.undoSteps.get(filePath)!.pop();
    this.updateUndoContext();
    this.service.restore(filePath, step.before);
    this.suppressed.delete(filePath);
    this.refresh(filePath, step.index);
  }

  private dropUndo(filePath: string): void {
    if (!this.undoSteps.delete(filePath)) return;
    this.updateUndoContext();
  }

  /** Сохранить историю отмены и обновить файлы, где Cmd+Z откатывает ревью, — для when-условия клавиши в package.json */
  private updateUndoContext(): void {
    const resources = [...this.undoSteps.entries()]
      .filter(([, steps]) => steps.length)
      .map(([filePath]) => vscode.Uri.file(filePath).toString());
    this.memento.update(
      "claudeReview.undo",
      Object.fromEntries(this.undoSteps),
    );
    vscode.commands.executeCommand(
      "setContext",
      "claudeReview.undoResources",
      resources,
    );
  }

  /** Claude закончил ответ и что-то поменял — уведомление со сводкой и кнопкой «Смотреть» на первый файл */
  private async notifyFinished(files: string[]): Promise<void> {
    const reviews = [...new Set(files)]
      .sort()
      .flatMap((filePath) => this.reviews.get(filePath) ?? []);
    if (!reviews.length) return;
    const blocks = reviews.flatMap(({ blocks }) => blocks);
    const added = blocks.reduce(
      (sum, { hunk }) => sum + hunk.newLines.length,
      0,
    );
    const removed = blocks.reduce(
      (sum, { hunk }) => sum + hunk.oldLines.length,
      0,
    );
    const answer = await vscode.window.showInformationMessage(
      `Claude закончил: правки в файлах — ${reviews.length} (+${added} −${removed})`,
      "Смотреть",
    );
    if (answer) await this.showReview(reviews[0].path);
  }

  /** Кнопки — это текст в строке под куском: клик мышью ставит туда курсор, по колонке видно, какая нажата */
  private onButtonClick({
    textEditor,
    selections,
    kind,
  }: vscode.TextEditorSelectionChangeEvent): void {
    const [selection] = selections;
    const filePath = textEditor.document.uri.fsPath;
    if (
      kind !== vscode.TextEditorSelectionChangeKind.Mouse ||
      !selection.isEmpty ||
      textEditor.document.uri.scheme !== ReviewController.scheme
    )
      return;
    const index =
      this.rendered
        .get(filePath)
        ?.blocks.findIndex(
          ({ buttonsLine }) => buttonsLine === selection.active.line,
        ) ?? -1;
    if (index === -1) return;
    const { accept, reject } = this.buttonRanges(
      this.rendered.get(filePath)!.blocks[index],
    );
    if (accept.contains(selection.active)) this.acceptHunk(filePath, index);
    else if (reject.contains(selection.active))
      this.rejectHunk(filePath, index);
  }

  private buttonRanges({ buttonsLine, buttonsColumn }: ReviewBlock): {
    accept: vscode.Range;
    reject: vscode.Range;
  } {
    const acceptEnd = buttonsColumn + ReviewService.acceptLabel.length;
    const rejectStart = acceptEnd + ReviewService.buttonsGap.length;
    return {
      accept: new vscode.Range(
        buttonsLine,
        buttonsColumn,
        buttonsLine,
        acceptEnd,
      ),
      reject: new vscode.Range(
        buttonsLine,
        rejectStart,
        buttonsLine,
        rejectStart + ReviewService.rejectLabel.length,
      ),
    };
  }

  /** Кусок под кнопкой из CodeLens, а с клавиатуры — под курсором или ближайший ниже */
  private targetBlock(
    filePath?: string,
    index?: number,
  ): { review: Review; block: ReviewBlock; index: number } | undefined {
    const review = this.targetReview(filePath);
    if (!review) return undefined;
    const line = vscode.window.activeTextEditor?.selection.active.line ?? 0;
    const inside = review.blocks.findIndex(
      ({ redLine, buttonsLine }) => line >= redLine && line <= buttonsLine,
    );
    const below = review.blocks.findIndex(({ redLine }) => redLine > line);
    const position =
      index ??
      (inside !== -1
        ? inside
        : below !== -1
          ? below
          : review.blocks.length - 1);
    return { review, index: position, block: review.blocks[position] };
  }

  /**
   * Свежее ревью файла — только если на диске ничего не поменялось с того, что видно во вкладке ревью
   * (или в списке правок, если вкладка не открыта); иначе всё перерисовывается
   */
  private targetReview(filePath = this.activeReviewPath()): Review | undefined {
    const shown = filePath
      ? (this.rendered.get(filePath) ?? this.reviews.get(filePath))
      : undefined;
    if (!filePath || !shown) return undefined;
    const fresh = this.service.load(filePath);
    if (fresh && fresh.mergedLines.join("\n") === shown.mergedLines.join("\n"))
      return fresh;
    this.refresh(filePath);
    vscode.window.showWarningMessage(
      "Файл поменялся, пока шло ревью, — вкладка обновлена, глянь ещё раз",
    );
    return undefined;
  }

  /** Reject пишет файл на диск; несохранённые правки в открытом файле он бы затёр */
  private realFileDirty(filePath: string): boolean {
    const dirty = vscode.workspace.textDocuments.some(
      ({ uri, isDirty }) =>
        uri.scheme === "file" && uri.fsPath === filePath && isDirty,
    );
    if (dirty)
      vscode.window.showWarningMessage(
        `Сначала сохрани ${path.basename(filePath)} — в нём есть несохранённые изменения`,
      );
    return dirty;
  }

  private refresh(filePath: string, focusIndex?: number): void {
    if (focusIndex !== undefined) this.focusIndex.set(filePath, focusIndex);
    this.changed.fire(this.reviewUri(filePath));
    this.poll();
  }

  /** Следующий кусок ниже курсора, а если в файле их больше нет — следующий файл с правками */
  private async next(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const current = this.activeReviewPath();
    const review = current ? this.rendered.get(current) : undefined;
    const block = review?.blocks.find(
      ({ redLine }) => redLine > (editor?.selection.active.line ?? 0),
    );
    if (editor && block) return this.reveal(editor, block);
    const paths = [...this.reviews.keys()].sort();
    if (!paths.length)
      return void vscode.window.showInformationMessage(
        "Непросмотренных правок Claude нет",
      );
    await this.showReview(
      paths[(paths.indexOf(current ?? "") + 1) % paths.length],
    );
  }

  private async list(): Promise<void> {
    const items = [...this.reviews.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([filePath, { blocks }]) => ({
        filePath,
        label: vscode.workspace.asRelativePath(filePath),
        description: `правок: ${blocks.length}`,
      }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Файлы с правками Claude",
    });
    if (picked) await this.showReview(picked.filePath);
  }

  /** Открыть вкладку ревью на куске index — из списка правок, перехода ⌥J и списка файлов */
  private async showReview(filePath: string, index = 0): Promise<void> {
    this.suppressed.delete(filePath);
    const blocks = this.service.load(filePath)?.blocks ?? [];
    const line = blocks[Math.min(index, blocks.length - 1)]?.redLine ?? 0;
    await this.openReview(
      filePath,
      vscode.window.activeTextEditor?.viewColumn,
      true,
      line,
    );
  }

  /** Открыть сам файл вместо ревью — например, чтобы поправить руками; курсор встаёт на ту же строку */
  private async openFile(filePath = this.activeReviewPath()): Promise<void> {
    if (!filePath) return;
    this.suppressed.add(filePath);
    const editor = vscode.window.activeTextEditor;
    const review = this.rendered.get(filePath);
    const fromReview =
      editor?.document.uri.toString() === this.reviewUri(filePath).toString();
    const position = new vscode.Position(
      review && editor && fromReview
        ? this.service.realLineFor(review, editor.selection.active.line)
        : 0,
      0,
    );
    await vscode.window.showTextDocument(vscode.Uri.file(filePath), {
      viewColumn: editor?.viewColumn,
      selection: new vscode.Range(position, position),
    });
    await this.closeTabs(this.reviewUri(filePath), editor?.viewColumn);
  }

  /** Открыли файл, в котором есть правки Claude, — на место его вкладки встаёт вкладка ревью */
  private async swapToReview(
    editor: vscode.TextEditor | undefined,
  ): Promise<void> {
    if (
      !editor ||
      editor.document.uri.scheme !== "file" ||
      editor.document.isDirty
    )
      return;
    const filePath = editor.document.uri.fsPath;
    if (this.suppressed.has(filePath) || !this.inWorkspace(filePath)) return;
    const review = this.service.load(filePath);
    if (!review) return;
    const { uri, languageId } = editor.document;
    const preview = this.tabsFor(uri).some(
      (tab) => tab.isPreview && tab.group.viewColumn === editor.viewColumn,
    );
    await this.openReview(
      filePath,
      editor.viewColumn,
      preview,
      this.service.mergedLineFor(review, editor.selection.active.line),
      languageId,
    );
    await this.closeTabs(uri, editor.viewColumn);
  }

  private async openReview(
    filePath: string,
    viewColumn: vscode.ViewColumn | undefined,
    preview: boolean,
    line: number,
    languageId?: string,
  ): Promise<void> {
    const uri = this.reviewUri(filePath);
    let document = await vscode.workspace.openTextDocument(uri);
    const realLanguage =
      languageId ??
      (fs.existsSync(filePath)
        ? (await vscode.workspace.openTextDocument(vscode.Uri.file(filePath)))
            .languageId
        : undefined);
    // язык-двойник из syntaxes/: та же раскраска, но TypeScript и линтеры не подчёркивают вклеенные старые строки и кнопки
    const language = (await vscode.languages.getLanguages()).includes(
      `claude-review-${realLanguage}`,
    )
      ? `claude-review-${realLanguage}`
      : realLanguage;
    if (language && document.languageId !== language)
      document = await vscode.languages.setTextDocumentLanguage(
        document,
        language,
      );
    const position = new vscode.Position(line, 0);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn,
      preview,
      selection: new vscode.Range(position, position),
    });
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
    this.decorate(editor);
    // документ мог остаться открытым со старым текстом — пусть перечитается
    this.changed.fire(uri);
  }

  /** Правок в файле не осталось — вкладки ревью закрываются, на месте активной открывается сам файл */
  private async closeReview(filePath: string): Promise<void> {
    const uri = this.reviewUri(filePath);
    const active = fs.existsSync(filePath)
      ? this.tabsFor(uri).filter((tab) => tab.isActive)
      : [];
    for (const { group, isPreview } of active) {
      const editor = vscode.window.visibleTextEditors.find(
        (e) =>
          e.document.uri.toString() === uri.toString() &&
          e.viewColumn === group.viewColumn,
      );
      const position = new vscode.Position(
        editor?.selection.active.line ?? 0,
        0,
      );
      await vscode.window.showTextDocument(vscode.Uri.file(filePath), {
        preview: isPreview,
        viewColumn: group.viewColumn,
        preserveFocus: !group.isActive,
        selection: new vscode.Range(position, position),
      });
    }
    await this.closeTabs(uri);
  }

  /**
   * Проводник сам подсвечивает только настоящие файлы, а у вкладки ревью адрес claude-review:/… —
   * поэтому показываем в нём настоящий файл и возвращаем фокус в редактор. Уважает выключенный explorer.autoReveal
   */
  private async revealInExplorer(
    editor: vscode.TextEditor | undefined,
  ): Promise<void> {
    const uri = editor?.document.uri;
    if (uri?.scheme !== ReviewController.scheme || !fs.existsSync(uri.fsPath))
      return;
    if (
      vscode.workspace.getConfiguration("explorer").get("autoReveal") === false
    )
      return;
    await vscode.commands.executeCommand(
      "revealInExplorer",
      vscode.Uri.file(uri.fsPath),
    );
    await vscode.commands.executeCommand(
      "workbench.action.focusActiveEditorGroup",
    );
  }

  private onReviewChanged(document: vscode.TextDocument): void {
    if (document.uri.scheme !== ReviewController.scheme) return;
    vscode.window.visibleTextEditors
      .filter((editor) => editor.document === document)
      .forEach((editor) => this.decorate(editor));
    this.lensesChanged.fire();
    if (!this.rendered.has(document.uri.fsPath))
      this.closeReview(document.uri.fsPath);
  }

  private decorate(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== ReviewController.scheme) return;
    const filePath = editor.document.uri.fsPath;
    const blocks = this.rendered.get(filePath)?.blocks ?? [];
    const red = blocks
      .filter(({ hunk }) => hunk.oldLines.length)
      .map(
        ({ redLine, greenLine }) =>
          new vscode.Range(redLine, 0, greenLine - 1, 0),
      );
    const green = blocks
      .filter(({ hunk }) => hunk.newLines.length)
      .map(
        ({ hunk, greenLine }) =>
          new vscode.Range(
            greenLine,
            0,
            greenLine + hunk.newLines.length - 1,
            0,
          ),
      );
    const buttons = blocks.map((block) => this.buttonRanges(block));
    editor.setDecorations(this.removed, red);
    editor.setDecorations(this.added, green);
    const words = blocks.flatMap(({ inline }) => inline);
    editor.setDecorations(
      this.removedWords,
      words
        .filter(({ removed }) => removed)
        .map(
          ({ line, start, end }) => new vscode.Range(line, start, line, end),
        ),
    );
    editor.setDecorations(
      this.addedWords,
      words
        .filter(({ removed }) => !removed)
        .map(
          ({ line, start, end }) => new vscode.Range(line, start, line, end),
        ),
    );
    editor.setDecorations(
      this.acceptButton,
      buttons.map(({ accept }) => accept),
    );
    editor.setDecorations(
      this.rejectButton,
      buttons.map(({ reject }) => reject),
    );

    const index = this.focusIndex.get(filePath);
    if (
      index === undefined ||
      !blocks.length ||
      vscode.window.activeTextEditor?.document !== editor.document
    )
      return;
    this.focusIndex.delete(filePath);
    this.reveal(editor, blocks[Math.min(index, blocks.length - 1)]);
  }

  private reveal(editor: vscode.TextEditor, block: ReviewBlock): void {
    const position = new vscode.Position(block.redLine, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  /**
   * Раз в секунду: какие файлы рабочей папки ждут ревью и не поменялись ли они или их исходники.
   * Изменившиеся вкладки ревью перерисовываются; если Claude правит файл, который сейчас открыт, — он сразу подменяется ревью
   */
  private poll(): void {
    const signatures = new Map<string, string>();
    for (const { mtimeMs, baseline } of this.store.list()) {
      if (!this.inWorkspace(baseline.path)) continue;
      const stat = fs.statSync(baseline.path, { throwIfNoEntry: false });
      signatures.set(
        baseline.path,
        `${mtimeMs}:${stat?.mtimeMs}:${stat?.size}`,
      );
    }
    const active = vscode.window.activeTextEditor;
    const changedPaths = [
      ...new Set([...signatures.keys(), ...this.signatures.keys()]),
    ].filter(
      (filePath) => signatures.get(filePath) !== this.signatures.get(filePath),
    );
    for (const filePath of changedPaths) {
      const review = signatures.has(filePath)
        ? this.service.load(filePath)
        : undefined;
      if (review) this.reviews.set(filePath, review);
      else {
        this.reviews.delete(filePath);
        this.suppressed.delete(filePath);
      }
      this.changed.fire(this.reviewUri(filePath));
      if (
        active?.document.uri.scheme === "file" &&
        active.document.uri.fsPath === filePath
      )
        this.swapToReview(active);
    }
    this.signatures = signatures;
    if (changedPaths.length) this.tree.update(this.reviews);
    const finished = this.store.readFinished();
    if (finished && finished.mtimeMs !== this.finishedMtime) {
      this.finishedMtime = finished.mtimeMs;
      this.notifyFinished(finished.files);
    }
    this.statusBar.text = `$(diff) Claude: ${this.reviews.size}`;
    if (this.reviews.size) this.statusBar.show();
    else this.statusBar.hide();
  }

  private async closeTabs(
    uri: vscode.Uri,
    viewColumn?: vscode.ViewColumn,
  ): Promise<void> {
    const tabs = this.tabsFor(uri).filter(
      (tab) => viewColumn === undefined || tab.group.viewColumn === viewColumn,
    );
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }

  private tabsFor(uri: vscode.Uri): vscode.Tab[] {
    return vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString() === uri.toString(),
      );
  }

  private activeReviewPath(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === ReviewController.scheme ? uri.fsPath : undefined;
  }

  private inWorkspace(filePath: string): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some((folder) =>
      filePath.startsWith(folder.uri.fsPath + path.sep),
    );
  }

  private reviewUri(filePath: string): vscode.Uri {
    return vscode.Uri.file(filePath).with({ scheme: ReviewController.scheme });
  }
}
