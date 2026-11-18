// Durability spike for node:sqlite in rollback-journal mode.
// Usage: node scripts/sqlite-spike.mjs <directory>
// A child process writes committed rows and is killed mid-run; the parent then reopens the
// database and checks that every acknowledged row survived and the file is intact.
/* global process, console, setTimeout */
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const dir = process.argv[2];
const mode = process.argv[3];
if (!dir) throw new Error('usage: sqlite-spike.mjs <directory>');
const file = join(dir, 'spike.db');

function open() {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS ops(id INTEGER PRIMARY KEY, state TEXT NOT NULL)');
  return db;
}

if (mode === 'writer') {
  const db = open();
  const insert = db.prepare('INSERT INTO ops(state) VALUES (?)');
  for (;;) {
    const { lastInsertRowid } = insert.run('pending');
    process.stdout.write(`${lastInsertRowid}\n`);
  }
}

mkdirSync(dir, { recursive: true });
rmSync(file, { force: true });
let failures = 0;
let acknowledged = 0;
for (let round = 1; round <= 3; round++) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', process.argv[1], dir, 'writer'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let last = 0;
  child.stdout.on('data', (chunk) => {
    const lines = String(chunk).trim().split('\n');
    last = Number(lines[lines.length - 1]);
  });
  await new Promise((r) => setTimeout(r, 1500));
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  const db = open();
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const count = db.prepare('SELECT COUNT(*) AS n FROM ops').get().n;
  db.close();
  const ok = integrity === 'ok' && count >= last && count >= acknowledged;
  acknowledged = count;
  if (!ok) failures++;
  console.log(`round ${round}: integrity=${integrity} rows=${count} lastAcknowledged=${last} ${ok ? 'PASS' : 'FAIL'}`);
}
console.log(failures === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
process.exit(failures === 0 ? 0 : 1);
