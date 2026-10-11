/** Кусок правки: строки oldLines исходника (с oldStart) заменены на newLines текущего файла (с newStart) */
export interface Hunk {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
}

/** Изменённое место внутри пары строк: [oldStart, oldEnd) в старой и [newStart, newEnd) в новой */
export interface ChangedColumns {
  oldEnd: number;
  newEnd: number;
  oldStart: number;
  newStart: number;
}

export class LineDiff {
  /**
   * Где именно отличаются две строки: общее начало и конец отрезаются, границы расширяются до целых слов —
   * «15000 → 30000», а не «15 → 30». Если в общей части нет ни одного слова (только отступ и знаки),
   * строки разные целиком — подсвечивать внутри нечего
   */
  changedColumns(oldLine: string, newLine: string): ChangedColumns | undefined {
    const word = /[\p{L}\p{N}_]/u;
    let start = 0;
    while (
      start < oldLine.length &&
      start < newLine.length &&
      oldLine[start] === newLine[start]
    )
      start++;
    let oldEnd = oldLine.length;
    let newEnd = newLine.length;
    while (
      oldEnd > start &&
      newEnd > start &&
      oldLine[oldEnd - 1] === newLine[newEnd - 1]
    ) {
      oldEnd--;
      newEnd--;
    }
    if (start === oldEnd && start === newEnd) return undefined;
    while (
      start > 0 &&
      word.test(oldLine[start - 1]) &&
      (word.test(oldLine[start] ?? "") || word.test(newLine[start] ?? ""))
    )
      start--;
    while (
      oldEnd < oldLine.length &&
      word.test(oldLine[oldEnd]) &&
      (word.test(oldLine[oldEnd - 1] ?? "") ||
        word.test(newLine[newEnd - 1] ?? ""))
    ) {
      oldEnd++;
      newEnd++;
    }
    if (!word.test(oldLine.slice(0, start) + oldLine.slice(oldEnd)))
      return undefined;
    return { oldStart: start, oldEnd, newStart: start, newEnd };
  }

  /**
   * Построчный дифф через LCS. Общее начало и конец отрезаются заранее, поэтому таблица
   * строится только по изменённой середине; если середина огромная — считаем её одним куском
   */
  compute(oldLines: string[], newLines: string[]): Hunk[] {
    let start = 0;
    while (
      start < oldLines.length &&
      start < newLines.length &&
      oldLines[start] === newLines[start]
    )
      start++;
    let oldEnd = oldLines.length;
    let newEnd = newLines.length;
    while (
      oldEnd > start &&
      newEnd > start &&
      oldLines[oldEnd - 1] === newLines[newEnd - 1]
    ) {
      oldEnd--;
      newEnd--;
    }
    const a = oldLines.slice(start, oldEnd);
    const b = newLines.slice(start, newEnd);
    if (!a.length && !b.length) return [];
    if (a.length * b.length > 25_000_000)
      return [{ oldStart: start, newStart: start, oldLines: a, newLines: b }];

    // lcs[i * width + j] — длина общей подпоследовательности для a[i..] и b[j..]
    const width = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i * width + j] =
          a[i] === b[j]
            ? lcs[(i + 1) * width + j + 1] + 1
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }

    const hunks: Hunk[] = [];
    let current: Hunk | undefined;
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        current = undefined;
        i++;
        j++;
        continue;
      }
      if (!current) {
        current = {
          oldStart: start + i,
          newStart: start + j,
          oldLines: [],
          newLines: [],
        };
        hunks.push(current);
      }
      if (
        i < a.length &&
        (j === b.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])
      )
        current.oldLines.push(a[i++]);
      else current.newLines.push(b[j++]);
    }
    return hunks;
  }
}
