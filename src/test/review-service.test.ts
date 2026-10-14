import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { LineDiff } from "../line-diff";
import { BaselineStore } from "../baseline-store";
import { ReviewService } from "../review-service";

/** Временные HOME (там ~/.claude-review) и файл для ревью — у каждого теста свои */
class Sandbox {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-"));
  readonly file = path.join(this.root, "file.ts");
  readonly store: BaselineStore;
  readonly service: ReviewService;

  constructor(baseline: string | undefined, current: string) {
    process.env.HOME = this.root;
    this.store = new BaselineStore();
    this.service = new ReviewService(new LineDiff(), this.store);
    this.store.write({
      path: this.file,
      created: baseline === undefined,
      content: baseline ?? "",
    });
    fs.writeFileSync(this.file, current);
  }

  read(): string {
    return fs.readFileSync(this.file, "utf8");
  }
}

describe("ReviewService", () => {
  let box: Sandbox;
  beforeEach(() => {
    box = new Sandbox("a\n  x = 1\nc\nd\ne\nf\n", "a\n  x = 2\nc\nd\nf\nG\n");
  });

  it("вкладка ревью: старые строки, новые, строка кнопок с отступом куска", () => {
    const review = box.service.load(box.file)!;
    const buttons =
      "  " +
      ReviewService.acceptLabel +
      ReviewService.buttonsGap +
      ReviewService.rejectLabel;
    assert.deepEqual(review.mergedLines.slice(0, 4), [
      "a",
      "  x = 1",
      "  x = 2",
      buttons,
    ]);
    assert.deepEqual(
      review.blocks.map(
        ({ redLine, greenLine, buttonsLine, buttonsColumn }) => [
          redLine,
          greenLine,
          buttonsLine,
          buttonsColumn,
        ],
      ),
      [
        [1, 2, 3, 2],
        [6, 7, 7, 0],
        [9, 9, 10, 0],
      ],
    );
  });

  it("изменённое слово подсвечено в старой и новой строке", () => {
    const [first] = box.service.load(box.file)!.blocks;
    assert.deepEqual(first.inline, [
      { line: 1, start: 6, end: 7, removed: true },
      { line: 2, start: 6, end: 7, removed: false },
    ]);
  });

  it("строка файла → строка вкладки → обратно та же строка", () => {
    const review = box.service.load(box.file)!;
    review.currentLines.forEach((_, line) =>
      assert.equal(
        box.service.realLineFor(
          review,
          box.service.mergedLineFor(review, line),
        ),
        line,
      ),
    );
  });

  it("Accept куска: файл не трогается, кусок уходит из ревью", () => {
    const before = box.read();
    const review = box.service.load(box.file)!;
    box.service.acceptHunk(review, review.blocks[0]);
    assert.equal(box.read(), before);
    assert.equal(box.service.load(box.file)!.blocks.length, 2);
  });

  it("Reject куска: в файл возвращаются старые строки", () => {
    const review = box.service.load(box.file)!;
    box.service.rejectHunk(review, review.blocks[1]);
    assert.equal(box.read(), "a\n  x = 2\nc\nd\ne\nf\nG\n");
  });

  it("Reject всего файла: исходник на месте, снимок удалён", () => {
    box.service.rejectFile(box.service.load(box.file)!);
    assert.equal(box.read(), "a\n  x = 1\nc\nd\ne\nf\n");
    assert.equal(box.store.read(box.file), undefined);
  });

  it("Accept всего файла: снимок удалён, файл как есть", () => {
    box.service.acceptFile(box.service.load(box.file)!);
    assert.equal(box.read(), "a\n  x = 2\nc\nd\nf\nG\n");
    assert.equal(box.service.load(box.file), undefined);
  });

  it("снимок до Reject и восстановление — всё как было", () => {
    const state = box.service.snapshot(box.file);
    box.service.rejectFile(box.service.load(box.file)!);
    box.service.restore(box.file, state);
    assert.deepEqual(box.service.snapshot(box.file), state);
  });

  it("сохранение вкладки: красные строки и кнопки выброшены, свои правки в файле", () => {
    const review = box.service.load(box.file)!;
    const shown = [...review.mergedLines];
    shown[2] = "  x = 3";
    shown.splice(5, 0, "new");
    assert.equal(box.service.saveEdited(review, shown), true);
    assert.equal(box.read(), "a\n  x = 3\nc\nnew\nd\nf\nG\n");
  });

  it("сохранение вкладки с правленой красной строкой — файл не трогается", () => {
    const before = box.read();
    const review = box.service.load(box.file)!;
    const shown = [...review.mergedLines];
    shown[1] = "  x = 100";
    assert.equal(box.service.saveEdited(review, shown), false);
    assert.equal(box.read(), before);
  });

  it("сохранение вкладки: удалённая пустая строка рядом с такой же красной", () => {
    const blank = new Sandbox("a\n\nb\n", "a\n\n\nB\n");
    const review = blank.service.load(blank.file)!;
    const shown = [...review.mergedLines];
    shown.splice(1, 1);
    assert.equal(blank.service.saveEdited(review, shown), true);
    assert.equal(blank.read(), "a\n\nB\n");
  });

  it("раскраска файла переносится на его строки во вкладке ревью", () => {
    const review = box.service.load(box.file)!;
    const tokens = new Uint32Array([1, 2, 1, 0, 0, 3, 0, 1, 7, 1]);
    assert.deepEqual(
      [
        ...box.service.shownTokens(
          review.currentLines,
          review.mergedLines,
          tokens,
        ),
      ],
      [2, 2, 1, 0, 0, 6, 0, 1, 7, 1],
    );
  });

  it("Reject нового файла удаляет его", () => {
    const created = new Sandbox(undefined, "hello\n");
    created.service.rejectFile(created.service.load(created.file)!);
    assert.equal(fs.existsSync(created.file), false);
  });

  it("файл совпал со снимком после правки — снимок не нужен", () => {
    const same = new Sandbox("x\n", "x\n");
    const past = new Date(Date.now() - 10_000);
    fs.utimesSync(
      path.join(
        same.root,
        ".claude-review",
        fs.readdirSync(path.join(same.root, ".claude-review"))[0],
      ),
      past,
      past,
    );
    assert.equal(same.service.load(same.file), undefined);
    assert.equal(same.store.read(same.file), undefined);
  });

  it("файл не менялся после снимка — Claude ждёт разрешения, снимок остаётся", () => {
    const pending = new Sandbox("x\n", "x\n");
    const past = new Date(Date.now() - 10_000);
    fs.utimesSync(pending.file, past, past);
    assert.equal(pending.service.load(pending.file), undefined);
    assert.notEqual(pending.store.read(pending.file), undefined);
  });
});
