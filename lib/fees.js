const { db, getSetting, setSetting } = require('../db');
const { today, monthOf, addMonths } = require('./dates');

const MAX_ADVANCE_MONTHS = 24;

// Creates any missing monthly dues from max(join month, academic start) up to the current month.
// Idempotent: existing dues keep the fee they were created with, so fee changes only affect new months.
function ensureDues(studentId) {
  const start = getSetting('academic_start');
  const current = monthOf(today());
  const students = db
    .prepare(
      `SELECT s.id, s.join_month, c.monthly_fee FROM students s JOIN classes c ON c.id = s.class_id
       WHERE s.status = 'active' ${studentId ? 'AND s.id = ?' : ''}`
    )
    .all(...(studentId ? [studentId] : []));
  const ins = db.prepare('INSERT OR IGNORE INTO dues (student_id, month, amount) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const s of students) {
      let m = s.join_month > start ? s.join_month : start;
      for (; m <= current; m = addMonths(m, 1)) ins.run(s.id, m, s.monthly_fee);
    }
  })();
}

// Months up to and including the current month that still have a balance.
function pendingDues(studentId) {
  return db
    .prepare('SELECT * FROM due_balance WHERE student_id = ? AND month <= ? AND balance > 0 ORDER BY month')
    .all(studentId, monthOf(today()));
}

function pendingTotal(studentId) {
  return db
    .prepare('SELECT COALESCE(SUM(balance), 0) AS t FROM due_balance WHERE student_id = ? AND month <= ?')
    .get(studentId, monthOf(today())).t;
}

// Allocates the payment to the oldest unpaid months first; any excess pays upcoming months in advance.
function collectPayment({ studentId, amount, method, paidOn, note, userId }) {
  return db.transaction(() => {
    const student = db
      .prepare('SELECT s.id, c.monthly_fee FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?')
      .get(studentId);
    if (!student) throw new Error('Student not found');

    const seq = Number(getSetting('receipt_seq')) + 1;
    setSetting('receipt_seq', seq);
    const receiptNo = `R-${String(seq).padStart(6, '0')}`;
    const paymentId = db
      .prepare(
        `INSERT INTO payments (receipt_no, student_id, amount, method, paid_on, note, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(receiptNo, studentId, amount, method, paidOn, note || null, userId).lastInsertRowid;

    const alloc = db.prepare('INSERT INTO allocations (payment_id, due_id, amount) VALUES (?, ?, ?)');
    let remaining = amount;
    const open = db
      .prepare('SELECT id, balance FROM due_balance WHERE student_id = ? AND balance > 0 ORDER BY month')
      .all(studentId);
    for (const d of open) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, d.balance);
      alloc.run(paymentId, d.id, take);
      remaining -= take;
    }

    if (remaining > 0) {
      const last = db.prepare('SELECT MAX(month) AS m FROM dues WHERE student_id = ?').get(studentId).m;
      const current = monthOf(today());
      let month = last && last >= current ? addMonths(last, 1) : current;
      const insDue = db.prepare('INSERT OR IGNORE INTO dues (student_id, month, amount) VALUES (?, ?, ?)');
      for (let i = 0; remaining > 0; i++, month = addMonths(month, 1)) {
        if (i >= MAX_ADVANCE_MONTHS) throw new Error('Amount is too large: it exceeds 24 months of advance fees');
        insDue.run(studentId, month, student.monthly_fee);
        const due = db.prepare('SELECT id, balance FROM due_balance WHERE student_id = ? AND month = ?').get(studentId, month);
        if (due.balance <= 0) continue;
        const take = Math.min(remaining, due.balance);
        alloc.run(paymentId, due.id, take);
        remaining -= take;
      }
    }

    db.prepare('UPDATE payments SET balance_after = ? WHERE id = ?').run(pendingTotal(studentId), paymentId);
    return paymentId;
  })();
}

function voidPayment(paymentId, reason) {
  return db
    .prepare("UPDATE payments SET status = 'void', void_reason = ? WHERE id = ? AND status = 'valid'")
    .run(reason || null, paymentId).changes;
}

function getReceipt(paymentId) {
  const p = db
    .prepare(
      `SELECT p.*, s.name AS student_name, s.guardian_name, s.phone, c.grade, c.division, u.username AS collected_by
       FROM payments p JOIN students s ON s.id = p.student_id JOIN classes c ON c.id = s.class_id
       LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?`
    )
    .get(paymentId);
  if (!p) return null;
  p.months = db
    .prepare(
      `SELECT d.month, a.amount FROM allocations a JOIN dues d ON d.id = a.due_id
       WHERE a.payment_id = ? ORDER BY d.month`
    )
    .all(paymentId);
  return p;
}

module.exports = { ensureDues, pendingDues, pendingTotal, collectPayment, voidPayment, getReceipt };
