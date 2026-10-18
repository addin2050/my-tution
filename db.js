const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { today, monthOf } = require('./lib/dates');

// DB_PATH points at the database file; DATA_DIR (legacy) points at a folder that holds tuition.db.
const dbPath = process.env.DB_PATH || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'tuition.db');
const dataDir = path.dirname(dbPath);
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','teacher'))
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  grade INTEGER NOT NULL,
  division TEXT NOT NULL,
  monthly_fee INTEGER NOT NULL DEFAULT 2500,
  UNIQUE (grade, division)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  guardian_name TEXT,
  phone TEXT,
  class_id INTEGER NOT NULL REFERENCES classes(id),
  join_month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','left','graduated')),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id, status);

CREATE TABLE IF NOT EXISTS dues (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  month TEXT NOT NULL,
  amount INTEGER NOT NULL,
  UNIQUE (student_id, month)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  student_id INTEGER NOT NULL REFERENCES students(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  method TEXT NOT NULL,
  paid_on TEXT NOT NULL,
  note TEXT,
  balance_after INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','void')),
  void_reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_paid_on ON payments(paid_on);
CREATE INDEX IF NOT EXISTS idx_payments_student ON payments(student_id);

CREATE TABLE IF NOT EXISTS allocations (
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  due_id INTEGER NOT NULL REFERENCES dues(id),
  amount INTEGER NOT NULL,
  PRIMARY KEY (payment_id, due_id)
);
CREATE INDEX IF NOT EXISTS idx_alloc_due ON allocations(due_id);

CREATE TABLE IF NOT EXISTS attendance (
  student_id INTEGER NOT NULL REFERENCES students(id),
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present','absent','late')),
  PRIMARY KEY (student_id, date)
);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);

CREATE TABLE IF NOT EXISTS no_class (
  class_id INTEGER NOT NULL REFERENCES classes(id),
  date TEXT NOT NULL,
  PRIMARY KEY (class_id, date)
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE VIEW IF NOT EXISTS due_balance AS
SELECT d.id, d.student_id, d.month, d.amount,
       COALESCE((SELECT SUM(a.amount) FROM allocations a
                 JOIN payments p ON p.id = a.payment_id AND p.status = 'valid'
                 WHERE a.due_id = d.id), 0) AS paid,
       d.amount - COALESCE((SELECT SUM(a.amount) FROM allocations a
                 JOIN payments p ON p.id = a.payment_id AND p.status = 'valid'
                 WHERE a.due_id = d.id), 0) AS balance
FROM dues d;
`);

const DEFAULT_SETTINGS = {
  center_name: 'Tuition Center',
  center_address: '',
  center_phone: '',
  tagline: '',
  about_text: '',
  currency: '₹',
  academic_start: `${monthOf(today()).slice(0, 4)}-04`,
  receipt_seq: '0',
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

// Student IDs: 4-digit numbers handed out in order. Older databases get theirs from the existing student order.
if (!db.prepare("SELECT 1 FROM pragma_table_info('students') WHERE name = 'student_no'").get()) {
  db.exec('ALTER TABLE students ADD COLUMN student_no INTEGER');
}
db.transaction(() => {
  let next = db.prepare('SELECT COALESCE(MAX(student_no), 0) AS m FROM students').get().m;
  const set = db.prepare('UPDATE students SET student_no = ? WHERE id = ?');
  for (const s of db.prepare('SELECT id FROM students WHERE student_no IS NULL ORDER BY id').all()) set.run(++next, s.id);
})();
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_students_no ON students(student_no)');

// Older databases predate the ability to hide a class.
if (!db.prepare("SELECT 1 FROM pragma_table_info('classes') WHERE name = 'active'").get()) {
  db.exec('ALTER TABLE classes ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
}

// Divisions were dropped: one class per grade. Databases that still have 1A, 1B ... are merged into a
// single class per grade, moving their students and no-class days across and keeping the first one's fee.
db.transaction(() => {
  for (const { grade } of db.prepare('SELECT DISTINCT grade FROM classes').all()) {
    const rows = db.prepare("SELECT id, active FROM classes WHERE grade = ? ORDER BY (division = '') DESC, id").all(grade);
    const [keep, ...others] = rows;
    for (const o of others) {
      db.prepare('UPDATE students SET class_id = ? WHERE class_id = ?').run(keep.id, o.id);
      db.prepare('INSERT OR IGNORE INTO no_class (class_id, date) SELECT ?, date FROM no_class WHERE class_id = ?').run(keep.id, o.id);
      db.prepare('DELETE FROM no_class WHERE class_id = ?').run(o.id);
      db.prepare('DELETE FROM classes WHERE id = ?').run(o.id);
    }
    const anyActive = rows.some((r) => r.active) ? 1 : 0;
    db.prepare("UPDATE classes SET division = '', active = ? WHERE id = ?").run(anyActive, keep.id);
  }
  const ins = db.prepare("INSERT OR IGNORE INTO classes (grade, division) VALUES (?, '')");
  for (let g = 1; g <= 10; g++) ins.run(g);
})();

if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  const username = process.env.ADMIN_USER || 'admin';
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('hex');
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(
    username,
    bcrypt.hashSync(password, 10)
  );
  console.log(`Created admin user "${username}"${generated ? ` with password: ${password}` : ''}`);
  if (generated) console.log('Change this password after your first login (Settings).');
}

const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
const setSetting = (key, value) =>
  db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
const allSettings = () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));

module.exports = { db, getSetting, setSetting, allSettings, dataDir };
