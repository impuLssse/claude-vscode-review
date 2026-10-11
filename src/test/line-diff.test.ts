import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LineDiff } from "../line-diff";

describe("LineDiff.compute", () => {
  const diff = new LineDiff();

  it("одинаковый текст — кусков нет", () => {
    assert.deepEqual(diff.compute(["a", "b"], ["a", "b"]), []);
  });

  it("замена строки в середине", () => {
    assert.deepEqual(diff.compute(["a", "b", "c"], ["a", "B", "c"]), [
      { oldStart: 1, newStart: 1, oldLines: ["b"], newLines: ["B"] },
    ]);
  });

  it("вставка и удаление — отдельные куски на своих местах", () => {
    assert.deepEqual(diff.compute(["a", "b", "c", "d"], ["a", "x", "b", "d"]), [
      { oldStart: 1, newStart: 1, oldLines: [], newLines: ["x"] },
      { oldStart: 2, newStart: 3, oldLines: ["c"], newLines: [] },
    ]);
  });

  it("новый файл — один кусок из одних новых строк", () => {
    assert.deepEqual(diff.compute([], ["a", ""]), [
      { oldStart: 0, newStart: 0, oldLines: [], newLines: ["a", ""] },
    ]);
  });
});

describe("LineDiff.changedColumns", () => {
  const diff = new LineDiff();

  it("число меняется целиком, а не по цифрам", () => {
    const old = "  idleTimeoutMillis: toPositiveInt(env, 15000),";
    const next = "  idleTimeoutMillis: toPositiveInt(env, 30000),";
    const columns = diff.changedColumns(old, next)!;
    assert.equal(old.slice(columns.oldStart, columns.oldEnd), "15000");
    assert.equal(next.slice(columns.newStart, columns.newEnd), "30000");
  });

  it("вставка внутри скобок — старая часть пустая", () => {
    assert.deepEqual(diff.changedColumns("foo()", "foo(x)"), {
      oldStart: 4,
      oldEnd: 4,
      newStart: 4,
      newEnd: 5,
    });
  });

  it("совсем разные строки — подсвечивать нечего", () => {
    assert.equal(
      diff.changedColumns("  const a = 1;", "  return b;"),
      undefined,
    );
  });

  it("кириллица считается словом", () => {
    const columns = diff.changedColumns("// было тут", "// стало тут")!;
    assert.equal(
      "// стало тут".slice(columns.newStart, columns.newEnd),
      "стало",
    );
  });
});
