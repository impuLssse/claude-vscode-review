import * as fs from "fs";
import { Hunk, LineDiff } from "./line-diff";
import { Baseline, BaselineStore } from "./baseline-store";

/**
 * Кусок правки и его место во вкладке ревью: сначала красные старые строки, за ними зелёные новые,
 * а под ними строка с кнопками Accept / Reject, которые начинаются с колонки buttonsColumn
 */
export interface ReviewBlock {
  hunk: Hunk;
  redLine: number;
  greenLine: number;
  buttonsLine: number;
  buttonsColumn: number;
  inline: InlineChange[];
}

/** Изменённые слова внутри строки вкладки ревью — их фон ярче, чем у всей строки */
export interface InlineChange {
  end: number;
  line: number;
  start: number;
  removed: boolean;
}

/** Состояние файла и его исходника — до и после Accept / Reject, чтобы Cmd+Z мог всё вернуть */
export interface FileState {
  content?: string;
  baseline?: Baseline;
}

export interface Review {
  path: string;
  blocks: ReviewBlock[];
  baseline: Baseline;
  baseLines: string[];
  mergedLines: string[];
  currentLines: string[];
}

export class ReviewService {
  /** Текст кнопок в строке под куском; пробелы по краям — поля зелёной и красной плашки */
  static readonly acceptLabel = "  ✓ Accept  ⌥Y  ";
  static readonly rejectLabel = "  ✗ Reject  ⌥N  ";
  static readonly buttonsGap = "  ";

  constructor(
    private readonly diff: LineDiff,
    private readonly store: BaselineStore,
  ) {}

  /**
   * Ревью файла: исходник против того, что сейчас на диске.
   * Отличий нет и файл менялся после снимка — правки откатили, снимок больше не нужен.
   * Файл не менялся после снимка — Claude ещё ждёт разрешения на правку, снимок оставляем (кроме совсем старых)
   */
  load(filePath: string): Review | undefined {
    const entry = this.store.read(filePath);
    if (!entry) return undefined;
    const { baseline } = entry;
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    const baseLines = baseline.created ? [] : baseline.content.split("\n");
    const currentLines = stat
      ? fs.readFileSync(filePath, "utf8").split("\n")
      : [];
    const hunks = this.diff.compute(baseLines, currentLines);
    if (!hunks.length) {
      if (
        (stat && stat.mtimeMs > entry.mtimeMs) ||
        Date.now() - entry.mtimeMs > 86_400_000
      )
        this.store.delete(filePath);
      return undefined;
    }

    const blocks: ReviewBlock[] = [];
    const mergedLines: string[] = [];
    let cursor = 0;
    for (const hunk of hunks) {
      mergedLines.push(...currentLines.slice(cursor, hunk.newStart));
      const redLine = mergedLines.length;
      mergedLines.push(...hunk.oldLines);
      const greenLine = mergedLines.length;
      mergedLines.push(...hunk.newLines);
      // кнопки — с тем же отступом, что и код куска
      const indent = /^\s*/.exec(
        hunk.newLines[0] ?? hunk.oldLines[0] ?? "",
      )![0];
      const buttonsLine = mergedLines.length;
      mergedLines.push(
        indent +
          ReviewService.acceptLabel +
          ReviewService.buttonsGap +
          ReviewService.rejectLabel,
      );
      blocks.push({
        hunk,
        redLine,
        greenLine,
        buttonsLine,
        buttonsColumn: indent.length,
        inline: this.inlineChanges(hunk, redLine, greenLine),
      });
      cursor = hunk.newStart + hunk.newLines.length;
    }
    mergedLines.push(...currentLines.slice(cursor));
    return {
      path: filePath,
      blocks,
      baseline,
      baseLines,
      mergedLines,
      currentLines,
    };
  }

  /** Принять кусок — он становится частью исходника, файл на диске не меняется */
  acceptHunk(review: Review, block: ReviewBlock): void {
    if (review.blocks.length === 1) return this.store.delete(review.path);
    const { hunk } = block;
    const lines = [
      ...review.baseLines.slice(0, hunk.oldStart),
      ...hunk.newLines,
      ...review.baseLines.slice(hunk.oldStart + hunk.oldLines.length),
    ];
    this.store.write({ ...review.baseline, content: lines.join("\n") });
  }

  /** Отклонить кусок — в файл на диске возвращаются старые строки */
  rejectHunk(review: Review, block: ReviewBlock): void {
    const { hunk } = block;
    this.writeFile(review, [
      ...review.currentLines.slice(0, hunk.newStart),
      ...hunk.oldLines,
      ...review.currentLines.slice(hunk.newStart + hunk.newLines.length),
    ]);
    if (review.blocks.length === 1) this.store.delete(review.path);
  }

  acceptFile(review: Review): void {
    this.store.delete(review.path);
  }

  rejectFile(review: Review): void {
    this.writeFile(review, review.baseLines);
    this.store.delete(review.path);
  }

  /** Строка вкладки ревью для строки настоящего файла — чтобы при подмене вкладки курсор остался на месте */
  mergedLineFor(review: Review, realLine: number): number {
    let shift = 0;
    for (const { hunk } of review.blocks) {
      if (hunk.newStart > realLine) break;
      // строка с кнопками стоит под зелёными строками, поэтому сдвигает только то, что ниже куска
      shift +=
        hunk.oldLines.length +
        (realLine >= hunk.newStart + hunk.newLines.length ? 1 : 0);
    }
    return realLine + shift;
  }

  /** Строка настоящего файла для строки вкладки ревью; красные строки и кнопки ведут на начало своего куска */
  realLineFor(review: Review, mergedLine: number): number {
    let shift = 0;
    for (const { hunk, redLine, greenLine, buttonsLine } of review.blocks) {
      if (mergedLine < redLine) break;
      if (mergedLine < greenLine || mergedLine === buttonsLine)
        return hunk.newStart;
      if (mergedLine < buttonsLine)
        return mergedLine - shift - hunk.oldLines.length;
      shift += hunk.oldLines.length + 1;
    }
    return mergedLine - shift;
  }

  snapshot(filePath: string): FileState {
    return {
      baseline: this.store.read(filePath)?.baseline,
      content: fs.existsSync(filePath)
        ? fs.readFileSync(filePath, "utf8")
        : undefined,
    };
  }

  /** Вернуть файл и исходник к снимку: отсутствие в снимке значит «удалить» */
  restore(filePath: string, state: FileState): void {
    if (state.baseline) this.store.write(state.baseline);
    else this.store.delete(filePath);
    if (state.content === undefined) fs.rmSync(filePath, { force: true });
    else fs.writeFileSync(filePath, state.content);
  }

  /** Старые и новые строки куска сопоставляются по порядку — только когда их поровну, иначе пары неизвестны */
  private inlineChanges(
    hunk: Hunk,
    redLine: number,
    greenLine: number,
  ): InlineChange[] {
    if (hunk.oldLines.length !== hunk.newLines.length) return [];
    return hunk.oldLines.flatMap((oldLine, i) => {
      const columns = this.diff.changedColumns(oldLine, hunk.newLines[i]);
      if (!columns) return [];
      return [
        {
          line: redLine + i,
          start: columns.oldStart,
          end: columns.oldEnd,
          removed: true,
        },
        {
          line: greenLine + i,
          start: columns.newStart,
          end: columns.newEnd,
          removed: false,
        },
      ];
    });
  }

  /** Созданный Claude файл, от которого ничего не осталось, удаляется целиком */
  private writeFile(review: Review, lines: string[]): void {
    if (review.baseline.created && !lines.length)
      return fs.rmSync(review.path, { force: true });
    fs.writeFileSync(review.path, lines.join("\n"));
  }
}
