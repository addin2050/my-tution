// Adds (or removes) sample students, payments and attendance for trying the app out.
//   node scripts/seed-sample.js            add samples (skips if already added)
//   node scripts/seed-sample.js --remove   delete everything this script added
// Uses the same database as the app (DB_PATH, default ./data/tuition.db). Sample students have notes = 'SAMPLE'.
const { db } = require('../db');
const { ensureDues, pendingTotal, collectPayment } = require('../lib/fees');
const { today, addDays, parse } = require('../lib/dates');

const MARK = 'SAMPLE';

if (process.argv.includes('--remove')) {
  db.transaction(() => {
    const ids = "SELECT id FROM students WHERE notes = 'SAMPLE'";
    db.exec(`DELETE FROM allocations WHERE payment_id IN (SELECT id FROM payments WHERE student_id IN (${ids}))`);
    db.exec(`DELETE FROM payments WHERE student_id IN (${ids})`);
    db.exec(`DELETE FROM dues WHERE student_id IN (${ids})`);
    db.exec(`DELETE FROM attendance WHERE student_id IN (${ids})`);
    const n = db.prepare("DELETE FROM students WHERE notes = 'SAMPLE'").run().changes;
    console.log(`Removed ${n} sample students and their fees, payments and attendance.`);
  })();
  process.exit(0);
}

if (db.prepare("SELECT COUNT(*) AS n FROM students WHERE notes = ?").get(MARK).n > 0) {
  console.log('Sample students already exist. Run with --remove first to start over.');
  process.exit(0);
}

// Small deterministic generator so every run produces the same data.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const first = ['Aarav', 'Diya', 'Vihaan', 'Ananya', 'Arjun', 'Isha', 'Rohan', 'Meera', 'Kabir', 'Saanvi', 'Aditya', 'Riya', 'Karthik', 'Nisha', 'Rahul', 'Priya', 'Dev', 'Tara', 'Neel', 'Kavya', 'Yash', 'Anika', 'Om', 'Sneha', 'Ishaan', 'Pooja', 'Varun', 'Lakshmi', 'Harsh', 'Divya', 'Nikhil', 'Aisha', 'Siddharth', 'Mira', 'Tanvi', 'Reyansh'];
const last = ['Nair', 'Menon', 'Sharma', 'Iyer', 'Pillai', 'Kumar', 'Reddy', 'Das', 'Joseph', 'Thomas', 'Varma', 'Shetty', 'Kurian', 'Rao', 'Patel'];
const guardians = ['Mr. Nair', 'Mrs. Menon', 'Mr. Sharma', 'Mrs. Iyer', 'Mr. Pillai', 'Mrs. Kumar', 'Mr. Reddy', 'Mrs. Das'];

const classes = db.prepare('SELECT id, grade, monthly_fee FROM classes WHERE active = 1 ORDER BY grade').all();
const adminId = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get().id;
const t = today();
const month = t.slice(0, 7);
const start = db.prepare("SELECT value FROM settings WHERE key = 'academic_start'").get().value;

const insStudent = db.prepare(
  'INSERT INTO students (student_no, name, guardian_name, phone, class_id, join_month, notes) VALUES ((SELECT COALESCE(MAX(student_no), 0) + 1 FROM students), ?, ?, ?, ?, ?, ?)'
);
const studentIds = [];
let phone = 9000000000;
let nameIdx = 0;
db.transaction(() => {
  for (const c of classes) {
    const count = 3 + Math.floor(rand() * 3); // 3-5 per class
    for (let i = 0; i < count; i++) {
      const name = `${first[nameIdx++ % first.length]} ${pick(last)}`;
      // Most joined at the start of the year; a few joined later this year.
      const join = rand() < 0.8 ? start : `${month.slice(0, 5)}${String(Math.max(Number(month.slice(5)) - 1, 1)).padStart(2, '0')}`;
      const id = insStudent.run(name, pick(guardians), String(++phone), c.id, join < start ? start : join, MARK).lastInsertRowid;
      studentIds.push({ id, fee: c.monthly_fee });
    }
  }
})();
ensureDues();

// Payments: some paid up to date, some partly paid, some in advance, some nothing.
let payments = 0;
for (const s of studentIds) {
  const roll = rand();
  const pending = pendingTotal(s.id);
  if (pending <= 0) continue;
  const daysAgo = Math.floor(rand() * 20);
  const paidOn = addDays(t, -daysAgo);
  const method = pick(['Cash', 'Cash', 'UPI', 'UPI', 'Card']);
  let amount = 0;
  if (roll < 0.35) amount = pending; // fully paid
  else if (roll < 0.55) amount = Math.min(pending, s.fee * (1 + Math.floor(rand() * 3))); // a few months
  else if (roll < 0.65) amount = pending + s.fee; // paid one month in advance
  // else: pays nothing (pending)
  if (amount > 0) {
    collectPayment({ studentId: s.id, amount, method, paidOn, note: null, userId: adminId });
    payments++;
  }
}

// Attendance for the last 6 weekdays, with ~8% absent and ~4% late.
const insAtt = db.prepare('INSERT OR REPLACE INTO attendance (student_id, date, status) VALUES (?, ?, ?)');
let days = 0;
const markedDays = [];
for (let d = t; days < 6; d = addDays(d, -1)) {
  const dow = parse(d).getDay();
  if (dow === 0 || dow === 6) continue;
  markedDays.push(d);
  days++;
}
db.transaction(() => {
  for (const d of markedDays) {
    for (const s of studentIds) {
      const r = rand();
      insAtt.run(s.id, d, r < 0.08 ? 'absent' : r < 0.12 ? 'late' : 'present');
    }
  }
})();

const pendingAll = db.prepare('SELECT COALESCE(SUM(balance),0) AS v FROM due_balance WHERE month <= ?').get(month).v;
console.log(`Added ${studentIds.length} sample students across ${classes.length} classes, ${payments} payments, attendance for ${markedDays.length} days.`);
console.log(`Total pending now: ${pendingAll}. Remove them any time with: node scripts/seed-sample.js --remove`);
