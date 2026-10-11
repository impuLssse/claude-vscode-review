import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { ClaudeSettings } from "../claude-settings";

describe("ClaudeSettings", () => {
  let dir: string;
  let settings: ClaudeSettings;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-settings-"));
    file = path.join(dir, ".claude", "settings.json");
    settings = new ClaudeSettings(
      file,
      path.join(dir, "hook", "review-hook.js"),
    );
  });

  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const save = (value: object) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };

  it("нет файла настроек — создаётся с четырьмя записями", () => {
    settings.connect();
    assert.deepEqual(Object.keys(read().hooks), [
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "Stop",
    ]);
    assert.equal(read().hooks.Stop[0].matcher, undefined);
    assert.equal(settings.isConnected(), true);
  });

  it("чужие настройки и чужие хуки остаются на месте", () => {
    const foreign = {
      matcher: "Write",
      hooks: [{ type: "command", command: "prettier --write" }],
    };
    save({ model: "opus", hooks: { PostToolUse: [foreign] } });
    settings.connect();
    assert.equal(read().model, "opus");
    assert.deepEqual(read().hooks.PostToolUse[0], foreign);
    assert.equal(read().hooks.PostToolUse.length, 2);
  });

  it("повторное подключение и старый путь к хуку — без дублей", () => {
    save({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "node /old/place/review-hook.js" },
            ],
          },
        ],
      },
    });
    settings.connect();
    settings.connect();
    assert.equal(read().hooks.Stop.length, 1);
    assert.ok(
      read().hooks.Stop[0].hooks[0].command.includes(path.join(dir, "hook")),
    );
  });

  it("отключение убирает только свои записи и пустые события", () => {
    const foreign = {
      matcher: "Write",
      hooks: [{ type: "command", command: "prettier --write" }],
    };
    save({ hooks: { PostToolUse: [foreign] } });
    settings.connect();
    settings.disconnect();
    assert.deepEqual(read().hooks, { PostToolUse: [foreign] });
    assert.equal(settings.isConnected(), false);
  });

  it("отключение последних хуков убирает и сам hooks", () => {
    settings.connect();
    settings.disconnect();
    assert.equal(read().hooks, undefined);
  });

  it("перед первой записью — копия исходных настроек", () => {
    save({ model: "opus" });
    settings.connect();
    save({ model: "sonnet" });
    settings.connect();
    assert.deepEqual(
      JSON.parse(fs.readFileSync(file + ".before-diff-inline", "utf8")),
      { model: "opus" },
    );
  });

  it("сломанный JSON — ошибка, файл не трогается", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ // комментарий\n}");
    assert.throws(() => settings.connect(), /не JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ // комментарий\n}");
  });

  it("копия хука обновляется, когда поменялся исходник", () => {
    const source = path.join(dir, "source.js");
    fs.writeFileSync(source, "v1");
    settings.copyHook(source);
    fs.writeFileSync(source, "v2");
    settings.copyHook(source);
    assert.equal(fs.readFileSync(settings.hookFile, "utf8"), "v2");
  });
});
