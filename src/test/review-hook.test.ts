import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { beforeEach, describe, it } from "node:test";

/** Временный HOME и git-репозиторий; хук запускается так же, как его запускает Claude Code — JSON на stdin */
class HookSandbox {
  readonly home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-hook-"));
  readonly repo = path.join(this.home, "repo");

  constructor() {
    fs.mkdirSync(this.repo);
    this.git("init", "-q");
  }

  run(input: object): void {
    const hook = path.join(__dirname, "..", "..", "hook", "review-hook.js");
    execFileSync("node", [hook], {
      input: JSON.stringify({ session_id: "s1", cwd: this.repo, ...input }),
      env: { ...process.env, HOME: this.home },
    });
  }

  git(...args: string[]): void {
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
      { cwd: this.repo },
    );
  }

  write(name: string, content: string): string {
    fs.writeFileSync(path.join(this.repo, name), content);
    return path.join(this.repo, name);
  }

  baseline(
    filePath: string,
  ): { created: boolean; content: string } | undefined {
    const file = path.join(
      this.home,
      ".claude-review",
      crypto.createHash("sha1").update(filePath).digest("hex") + ".json",
    );
    return fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : undefined;
  }
}

describe("хук: Edit / Write и конец ответа", () => {
  let box: HookSandbox;
  beforeEach(() => {
    box = new HookSandbox();
  });

  it("снимок берётся перед первой правкой и потом не перезаписывается", () => {
    const file = box.write("a.ts", "one\n");
    box.run({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: file },
    });
    box.write("a.ts", "two\n");
    box.run({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: file },
    });
    assert.deepEqual(box.baseline(file), {
      path: file,
      created: false,
      content: "one\n",
    });
  });

  it("новый файл — снимок с created", () => {
    const file = path.join(box.repo, "new.ts");
    box.run({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: file },
    });
    assert.equal(box.baseline(file)?.created, true);
  });

  it("конец ответа: в finished.json попадают тронутые файлы, список ответа очищается", () => {
    const file = box.write("a.ts", "one\n");
    box.run({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: file },
    });
    box.run({ hook_event_name: "Stop" });
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(box.home, ".claude-review", "finished.json"),
          "utf8",
        ),
      ).files,
      [file],
    );
    assert.equal(
      fs.existsSync(path.join(box.home, ".claude-review", "turns", "s1.json")),
      false,
    );
  });
});

describe("хук: правки через терминал", () => {
  it("исходник — из git для чистых файлов и запомненный для уже изменённых", () => {
    const box = new HookSandbox();
    const clean = box.write("clean.ts", "clean v1\n");
    const dirty = box.write("dirty.ts", "dirty v1\n");
    const removed = box.write("removed.ts", "removed v1\n");
    const untouched = box.write("untouched.ts", "untouched v1\n");
    box.git("add", "-A");
    box.git("commit", "-qm", "init");
    box.write("dirty.ts", "dirty v2 (правка пользователя)\n");
    box.write("untouched.ts", "untouched v2 (правка пользователя)\n");

    box.run({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "t1",
      tool_input: { command: "sed -i '' s/v/V/ *.ts" },
    });
    box.write("clean.ts", "clean V1\n");
    box.write("dirty.ts", "dirty V2\n");
    const created = box.write("created.ts", "created\n");
    fs.rmSync(removed);
    box.run({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "t1",
      tool_input: { command: "" },
    });

    assert.deepEqual(box.baseline(clean), {
      path: clean,
      created: false,
      content: "clean v1\n",
    });
    assert.deepEqual(box.baseline(dirty), {
      path: dirty,
      created: false,
      content: "dirty v2 (правка пользователя)\n",
    });
    assert.deepEqual(box.baseline(created), {
      path: created,
      created: true,
      content: "",
    });
    assert.deepEqual(box.baseline(removed), {
      path: removed,
      created: false,
      content: "removed v1\n",
    });
    assert.equal(box.baseline(untouched), undefined);
  });

  it("репозиторий из пути в команде, а не из текущей папки", () => {
    const box = new HookSandbox();
    const file = box.write("a.ts", "v1\n");
    box.git("add", "-A");
    box.git("commit", "-qm", "init");
    const command = { command: `cd ${box.repo} && echo v2 > a.ts` };
    box.run({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "t2",
      cwd: box.home,
      tool_input: command,
    });
    box.write("a.ts", "v2\n");
    box.run({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "t2",
      cwd: box.home,
      tool_input: command,
    });
    assert.equal(box.baseline(file)?.content, "v1\n");
  });
});
