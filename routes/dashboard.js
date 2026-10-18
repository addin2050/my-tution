const express = require('express');
const { db } = require('../db');
const { ensureDues } = require('../lib/fees');
const { today, monthOf } = require('../lib/dates');

const router = express.Router();

router.get('/', (req, res) => {
  ensureDues();
  const t = today();
  const month = monthOf(t);

  const sum = (sql, ...args) => db.prepare(sql).get(...args).v;
  const stats = {
    collectedMonth: sum(
      "SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE status='valid' AND substr(paid_on,1,7)=?",
      month
    ),
    collectedToday: sum("SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE status='valid' AND paid_on=?", t),
    billedMonth: sum('SELECT COALESCE(SUM(amount),0) AS v FROM dues WHERE month=?', month),
    pending: sum('SELECT COALESCE(SUM(balance),0) AS v FROM due_balance WHERE month<=?', month),
    students: sum("SELECT COUNT(*) AS v FROM students WHERE status='active'"),
  };

  const attendance = db
    .prepare(
      `SELECT a.status, COUNT(*) AS n FROM attendance a JOIN students s ON s.id = a.student_id
       WHERE a.date = ? AND s.status = 'active' GROUP BY a.status`
    )
    .all(t);
  const att = { present: 0, absent: 0, late: 0 };
  for (const r of attendance) att[r.status] = r.n;
  att.classesMarked = db
    .prepare(
      `SELECT COUNT(DISTINCT s.class_id) AS n FROM attendance a JOIN students s ON s.id = a.student_id WHERE a.date = ?`
    )
    .get(t).n;

  const defaulters = db
    .prepare(
      `SELECT s.id, s.name, c.grade, c.division, SUM(b.balance) AS pending, COUNT(*) AS months
       FROM due_balance b JOIN students s ON s.id = b.student_id JOIN classes c ON c.id = s.class_id
       WHERE b.month <= ? AND b.balance > 0 AND s.status = 'active'
       GROUP BY s.id ORDER BY pending DESC, months DESC LIMIT 5`
    )
    .all(month);

  const recent = db
    .prepare(
      `SELECT p.id, p.receipt_no, p.amount, p.paid_on, p.status, s.name, c.grade, c.division
       FROM payments p JOIN students s ON s.id = p.student_id JOIN classes c ON c.id = s.class_id
       ORDER BY p.id DESC LIMIT 6`
    )
    .all();

  res.render('dashboard', { stats, att, defaulters, recent, month });
});

module.exports = router;
