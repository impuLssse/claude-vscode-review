import * as vscode from "vscode";
import { LineDiff } from "./line-diff";
import { ChangesTree } from "./changes-tree";
import { BaselineStore } from "./baseline-store";
import { ReviewService } from "./review-service";
import { ReviewController } from "./review-controller";

export function activate(context: vscode.ExtensionContext): void {
  const store = new BaselineStore();
  new ReviewController(
    new ChangesTree(),
    store,
    context.workspaceState,
    new ReviewService(new LineDiff(), store),
  ).register(context);
}
