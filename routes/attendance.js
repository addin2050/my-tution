const express = require('express');
const { db } = require('../db');
const { today, isDate, monthOf } = require('../lib/dates');

const router = express.Router();
const STATUSES = ['present', 'absent', 'late'];

const classes = () => db.prepare('SELECT * FROM classes ORDER BY grade, division').all();

router.get('/attendance', (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : today();
  const classId = Number(req.query.class_id) || null;
  let students = [];
  let noClass = false;
  let marked = false;
  if (classId) {
    students = db
      .prepare(
        `SELECT s.id, s.name, a.status AS saved FROM students s
         LEFT JOIN attendance a ON a.student_id = s.id AND a.date = ?
         WHERE s.class_id = ? AND s.status = 'active' ORDER BY s.name`
      )
      .all(date, classId);
    marked = students.some((s) => s.saved);
    noClass = !!db.prepare('SELECT 1 FROM no_class WHERE class_id = ? AND date = ?').get(classId, date);
  }
  res.render('attendance', { classes: classes(), classId, date, students, noClass, marked });
});

router.post('/attendance', (req, res) => {
  const date = isDate(req.body.date) ? req.body.date : today();
  const classId = Number(req.body.class_id);
  if (date > today()) {
    req.session.flash = 'Cannot mark attendance for a future date.';
    return res.redirect(`/attendance?class_id=${classId}&date=${date}`);
  }
  const students = db.prepare("SELECT id FROM students WHERE class_id = ? AND status = 'active'").all(classId);
  const noClass = req.body.no_class === '1';

  db.transaction(() => {
    const del = db.prepare('DELETE FROM attendance WHERE student_id = ? AND date = ?');
    const ins = db.prepare('INSERT INTO attendance (student_id, date, status) VALUES (?, ?, ?)');
    db.prepare('DELETE FROM no_class WHERE class_id = ? AND date = ?').run(classId, date);
    if (noClass) {
      db.prepare('INSERT INTO no_class (class_id, date) VALUES (?, ?)').run(classId, date);
      for (const s of students) del.run(s.id, date);
      return;
    }
    for (const s of students) {
      const status = STATUSES.includes(req.body[`s_${s.id}`]) ? req.body[`s_${s.id}`] : 'present';
      del.run(s.id, date);
      ins.run(s.id, date, status);
    }
  })();

  req.session.flash = noClass ? 'Saved as a no-class day.' : 'Attendance saved.';
  res.redirect(`/attendance?class_id=${classId}&date=${date}`);
});

// Month summary for a class: percentage present per student (excludes no-class days).
router.get('/attendance/summary', (req, res) => {
  const classId = Number(req.query.class_id) || null;
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : monthOf(today());
  let rows = [];
  if (classId) {
    rows = db
      .prepare(
        `SELECT s.id, s.name,
                SUM(a.status = 'present') AS present, SUM(a.status = 'late') AS late,
                SUM(a.status = 'absent') AS absent, COUNT(a.date) AS days
         FROM students s
         LEFT JOIN attendance a ON a.student_id = s.id AND substr(a.date,1,7) = ?
         WHERE s.class_id = ? AND s.status = 'active' GROUP BY s.id ORDER BY s.name`
      )
      .all(month, classId);
  }
  res.render('attendance_summary', { classes: classes(), classId, month, rows });
});

module.exports = router;
