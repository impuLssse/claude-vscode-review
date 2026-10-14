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

  /**
   * Сохранить отредактированную вкладку ревью в файл: красные строки и кнопки выбрасываются, остальное пишется как набрано.
   * Строки кнопок — опоры: между соседними лежат неизменённые строки, красные и зелёные куска. Красные ищутся в этом отрезке
   * целиком; если вхождений несколько — берётся то, что ближе к прежнему месту. Кнопок стало не столько, сколько кусков,
   * или красных строк в отрезке нет — их правили, тогда файл не трогаем и возвращаем false
   */
  saveEdited(review: Review, shownLines: string[]): boolean {
    const buttons = (
      ReviewService.acceptLabel +
      ReviewService.buttonsGap +
      ReviewService.rejectLabel
    ).trim();
    const anchors = shownLines.flatMap((line, i) =>
      line.trim() === buttons ? [i] : [],
    );
    if (anchors.length !== review.blocks.length) return false;
    const lines: string[] = [];
    let start = 0;
    let mergedStart = 0;
    for (const [i, { hunk, redLine, buttonsLine }] of review.blocks.entries()) {
      const segment = shownLines.slice(start, anchors[i]);
      const red = hunk.oldLines;
      // сколько было неизменённых строк до красных и зелёных после них
      const before = redLine - mergedStart;
      const after = buttonsLine - redLine - red.length;
      let found = -1;
      let foundShift = Infinity;
      for (let p = 0; p + red.length <= segment.length; p++) {
        if (red.some((line, j) => segment[p + j] !== line)) continue;
        const shift = Math.min(
          Math.abs(p - before),
          Math.abs(segment.length - p - red.length - after),
        );
        if (shift >= foundShift) continue;
        found = p;
        foundShift = shift;
      }
      if (found === -1) return false;
      lines.push(
        ...segment.slice(0, found),
        ...segment.slice(found + red.length),
      );
      start = anchors[i] + 1;
      mergedStart = buttonsLine + 1;
    }
    this.writeFile(review, [...lines, ...shownLines.slice(start)]);
    return true;
  }

  /**
   * Раскраска по смыслу (семантические токены) настоящего файла, перенесённая на строки вкладки ревью.
   * Строки сопоставляются диффом, поэтому перенос верен и пока вкладку правят; красные строки и кнопки
   * в настоящем файле не встречаются и остаются с обычной раскраской. Токен — пять чисел:
   * сдвиг строки, сдвиг колонки (от прошлого токена на той же строке), длина, тип, модификаторы
   */
  shownTokens(
    realLines: string[],
    shownLines: string[],
    tokens: Uint32Array,
  ): Uint32Array {
    const shownLine = this.sameLines(realLines, shownLines);

    const data: number[] = [];
    let line = 0;
    let column = 0;
    let lastLine = 0;
    let lastColumn = 0;
    for (let i = 0; i < tokens.length; i += 5) {
      line += tokens[i];
      column = tokens[i] ? tokens[i + 1] : column + tokens[i + 1];
      const target = shownLine.get(line);
      if (target === undefined) continue;
      data.push(
        target - lastLine,
        target === lastLine ? column - lastColumn : column,
        tokens[i + 2],
        tokens[i + 3],
        tokens[i + 4],
      );
      lastLine = target;
      lastColumn = column;
    }
    return new Uint32Array(data);
  }

  /**
   * Одинаковые строки двух текстов по диффу: номер строки в from → номер в to. Так вкладка ревью и настоящий файл
   * сопоставляются и пока вкладку правят; красных строк и кнопок в настоящем файле нет — их в карте тоже нет
   */
  sameLines(fromLines: string[], toLines: string[]): Map<number, number> {
    const lines = new Map<number, number>();
    let from = 0;
    let to = 0;
    const end: Hunk = {
      oldStart: fromLines.length,
      newStart: toLines.length,
      oldLines: [],
      newLines: [],
    };
    for (const hunk of [...this.diff.compute(fromLines, toLines), end]) {
      while (from < hunk.oldStart) lines.set(from++, to++);
      from += hunk.oldLines.length;
      to += hunk.newLines.length;
    }
    return lines;
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
