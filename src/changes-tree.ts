import * as path from 'path';
import * as vscode from 'vscode';
import { Review } from './review-service';

/** Строка списка правок: папка (folderLabel), файл целиком или один его кусок (index) */
export interface ChangeNode {
  index?: number;
  filePath: string;
  folderLabel?: string;
}

/**
 * Секция «Правки Claude» в боковой панели под чатом Claude Code: файлы с правками списком или деревом папок,
 * внутри — куски; у каждой строки ✓ / ✗, клик открывает вкладку ревью на этом месте.
 * Имена файлов красятся как в JetBrains: синий — изменён, зелёный — новый, красный — удалён
 */
export class ChangesTree implements vscode.TreeDataProvider<ChangeNode>, vscode.FileDecorationProvider {
  /** Метка в resourceUri строк файлов — чтобы цвет имени был только в этом списке, а не в проводнике */
  private static readonly query = 'claude-review';

  private readonly changed = new vscode.EventEmitter<void>();
  private readonly decorationsChanged = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;

  private treeMode = false;
  private reviews = new Map<string, Review>();
  private readonly views: vscode.TreeView<ChangeNode>[] = [];

  /** Секция объявлена дважды: Claude Code живёт либо во второй боковой панели, либо в первой — в зависимости от версии VS Code */
  register(context: vscode.ExtensionContext): void {
    for (const id of ['claudeReview.changes', 'claudeReview.changesSidebar']) {
      this.views.push(vscode.window.createTreeView(id, { treeDataProvider: this }));
    }
    context.subscriptions.push(
      this.changed,
      this.decorationsChanged,
      ...this.views,
      vscode.window.registerFileDecorationProvider(this),
      vscode.commands.registerCommand('claudeReview.viewAsTree', () => this.setTreeMode(context, true)),
      vscode.commands.registerCommand('claudeReview.viewAsList', () => this.setTreeMode(context, false)),
    );
    this.setTreeMode(context, context.globalState.get('claudeReview.treeMode', false));
    this.update(this.reviews);
  }

  update(reviews: Map<string, Review>): void {
    this.reviews = reviews;
    for (const view of this.views) {
      view.badge = reviews.size ? { value: reviews.size, tooltip: `Файлов с правками Claude: ${reviews.size}` } : undefined;
      view.message = reviews.size ? undefined : 'Непросмотренных правок нет';
    }
    this.changed.fire();
    this.decorationsChanged.fire(undefined);
  }

  getChildren(node?: ChangeNode): ChangeNode[] {
    if (node?.folderLabel !== undefined) return this.childrenOf(node.filePath);
    if (node) return node.index === undefined ? (this.reviews.get(node.filePath)?.blocks.map((_, index) => ({ index, filePath: node.filePath })) ?? []) : [];
    if (!this.treeMode) return [...this.reviews.keys()].sort().map((filePath) => ({ filePath }));
    // дерево: при одной рабочей папке сразу её содержимое, при нескольких — сами рабочие папки
    const roots = [...new Set([...this.reviews.keys()].map((filePath) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))!.uri.fsPath))].sort();
    return roots.length === 1 ? this.childrenOf(roots[0]) : roots.map((root) => ({ filePath: root, folderLabel: path.basename(root) }));
  }

  getTreeItem({ filePath, index, folderLabel }: ChangeNode): vscode.TreeItem {
    if (folderLabel !== undefined) {
      const item = new vscode.TreeItem(folderLabel, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `folder:${filePath}`;
      item.resourceUri = vscode.Uri.file(filePath);
      item.iconPath = vscode.ThemeIcon.Folder;
      return item;
    }

    const blocks = this.reviews.get(filePath)?.blocks ?? [];
    if (index === undefined) {
      const added = blocks.reduce((sum, { hunk }) => sum + hunk.newLines.length, 0);
      const removed = blocks.reduce((sum, { hunk }) => sum + hunk.oldLines.length, 0);
      const counts = `+${added} −${removed}`;
      // ThemeIcon.File берёт иконку файла из темы по resourceUri; без неё свёрнутую строку тема рисует папкой
      const item = new vscode.TreeItem(vscode.Uri.file(filePath).with({ query: ChangesTree.query }), vscode.TreeItemCollapsibleState.Collapsed);
      item.id = filePath;
      item.contextValue = 'file';
      item.iconPath = vscode.ThemeIcon.File;
      item.description = this.treeMode ? counts : `${counts} · ${path.dirname(vscode.workspace.asRelativePath(filePath))}`;
      item.command = { title: 'Открыть ревью', command: 'claudeReview.show', arguments: [filePath, 0] };
      return item;
    }

    const { hunk } = blocks[index];
    const firstLine = [...hunk.newLines, ...hunk.oldLines].find((line) => line.trim())?.trim();
    const [icon, color] = !hunk.oldLines.length
      ? ['add', 'editorGutter.addedBackground']
      : !hunk.newLines.length
        ? ['remove', 'editorGutter.deletedBackground']
        : ['edit', 'editorGutter.modifiedBackground'];
    const item = new vscode.TreeItem(firstLine ?? '(пустые строки)');
    item.id = `${filePath}#${index}`;
    item.contextValue = 'hunk';
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.description = `стр. ${hunk.newStart + 1} · +${hunk.newLines.length} −${hunk.oldLines.length}`;
    item.command = { title: 'Открыть ревью', command: 'claudeReview.show', arguments: [filePath, index] };
    return item;
  }

  /** Цвет имени файла: новый — зелёный, удалённый — красный, остальные — синий */
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const review = uri.query === ChangesTree.query ? this.reviews.get(uri.fsPath) : undefined;
    if (!review) return undefined;
    if (review.baseline.created) return new vscode.FileDecoration(undefined, 'Новый файл', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
    if (!review.currentLines.length) return new vscode.FileDecoration(undefined, 'Файл удалён', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
    return new vscode.FileDecoration(undefined, 'Файл изменён', new vscode.ThemeColor('editorGutter.modifiedBackground'));
  }

  private setTreeMode(context: vscode.ExtensionContext, treeMode: boolean): void {
    this.treeMode = treeMode;
    context.globalState.update('claudeReview.treeMode', treeMode);
    vscode.commands.executeCommand('setContext', 'claudeReview.treeMode', treeMode);
    this.changed.fire();
  }

  /** Подпапки и файлы папки dir; цепочка папок без своих файлов склеивается в одну строку — src/modules/http */
  private childrenOf(dir: string): ChangeNode[] {
    const { dirs, files } = this.entriesOf(dir);
    const folders = dirs.map((sub) => {
      let end = sub;
      for (let inner = this.entriesOf(end); !inner.files.length && inner.dirs.length === 1; inner = this.entriesOf(end)) end = inner.dirs[0];
      return { filePath: end, folderLabel: path.relative(dir, end) };
    });
    return [...folders, ...files.map((filePath) => ({ filePath }))];
  }

  private entriesOf(dir: string): { dirs: string[]; files: string[] } {
    const inside = [...this.reviews.keys()].filter((filePath) => filePath.startsWith(dir + path.sep));
    const nested = inside.filter((filePath) => path.dirname(filePath) !== dir);
    return {
      files: inside.filter((filePath) => path.dirname(filePath) === dir).sort(),
      dirs: [...new Set(nested.map((filePath) => path.join(dir, path.relative(dir, filePath).split(path.sep)[0])))].sort(),
    };
  }
}
