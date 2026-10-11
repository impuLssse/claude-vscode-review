#!/usr/bin/env node
// PreToolUse-хук Claude Code (Edit / Write / MultiEdit): перед первой правкой файла
// кладёт его исходную версию в ~/.claude-review — с ней расширение сравнивает файл на ревью.
// Хук никогда не блокирует Claude: любая ошибка — тихий выход с кодом 0.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const filePath = path.resolve(input.cwd ?? process.cwd(), input.tool_input?.file_path ?? '');
  const dir = path.join(os.homedir(), '.claude-review');
  const target = path.join(dir, crypto.createHash('sha1').update(filePath).digest('hex') + '.json');

  // Память и настройки самого Claude ревьюить не нужно; исходник уже снят — значит, файл правится не первый раз
  const skip = !input.tool_input?.file_path || filePath.startsWith(path.join(os.homedir(), '.claude')) || fs.existsSync(target);
  const created = !skip && !fs.existsSync(filePath);
  if (!skip && (created || fs.statSync(filePath).size < 5_000_000)) {
    const content = created ? '' : fs.readFileSync(filePath, 'utf8');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target + '.tmp', JSON.stringify({ path: filePath, created, content }));
    fs.renameSync(target + '.tmp', target);
  }
} catch {
  // снимок не получился — правка всё равно пройдёт, просто без ревью
}
