/** Кусок правки: строки oldLines исходника (с oldStart) заменены на newLines текущего файла (с newStart) */
export interface Hunk {
  oldStart: number;
  newStart: number;
  oldLines: string[];
  newLines: string[];
}

export class LineDiff {
  /**
   * Построчный дифф через LCS. Общее начало и конец отрезаются заранее, поэтому таблица
   * строится только по изменённой середине; если середина огромная — считаем её одним куском
   */
  compute(oldLines: string[], newLines: string[]): Hunk[] {
    let start = 0;
    while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
    let oldEnd = oldLines.length;
    let newEnd = newLines.length;
    while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    const a = oldLines.slice(start, oldEnd);
    const b = newLines.slice(start, newEnd);
    if (!a.length && !b.length) return [];
    if (a.length * b.length > 25_000_000) return [{ oldStart: start, newStart: start, oldLines: a, newLines: b }];

    // lcs[i * width + j] — длина общей подпоследовательности для a[i..] и b[j..]
    const width = b.length + 1;
    const lcs = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
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
        current = { oldStart: start + i, newStart: start + j, oldLines: [], newLines: [] };
        hunks.push(current);
      }
      if (i < a.length && (j === b.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) current.oldLines.push(a[i++]);
      else current.newLines.push(b[j++]);
    }
    return hunks;
  }
}
