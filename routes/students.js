const express = require('express');
const { db } = require('../db');
const { ensureDues, pendingDues, pendingTotal } = require('../lib/fees');
const { today, monthOf, isMonth } = require('../lib/dates');
const { GRADES, parseGrade } = require('../lib/grade');
const { fmtStudentNo } = require('../lib/studentId');

const router = express.Router();

// Classes offered in dropdowns: the visible ones, plus the student's current class even if it was hidden later.
const classes = (keepId = 0) =>
  db.prepare('SELECT * FROM classes WHERE active = 1 OR id = ? ORDER BY grade, division').all(keepId);

const nextStudentNo = () => db.prepare('SELECT COALESCE(MAX(student_no), 0) + 1 AS n FROM students').get().n;

// A blank Student ID means "assign the next number"; a typed one must be a positive number nobody else has.
function parseStudent(body, excludeId = 0) {
  const cls = Number(body.class_id);
  const name = String(body.name || '').trim();
  const joinMonth = isMonth(body.join_month) ? body.join_month : monthOf(today());
  const errors = [];
  if (!name) errors.push('Name is required.');
  if (!db.prepare('SELECT 1 FROM classes WHERE id = ?').get(cls)) errors.push('Pick a class.');
  const studentNoField = String(body.student_no ?? '').trim();
  let studentNo = null;
  if (studentNoField !== '') {
    if (!/^\d{1,9}$/.test(studentNoField) || Number(studentNoField) < 1) {
      errors.push('Student ID must be a number, like 0007.');
    } else {
      studentNo = Number(studentNoField);
      const taken = db.prepare('SELECT name FROM students WHERE student_no = ? AND id != ?').get(studentNo, excludeId);
      if (taken) errors.push(`Student ID ${fmtStudentNo(studentNo)} is already used by ${taken.name}.`);
    }
  }
  return {
    errors,
    studentNoField,
    values: {
      student_no: studentNo,
      name,
      guardian_name: String(body.guardian_name || '').trim(),
      phone: String(body.phone || '').replace(/[^\d+]/g, ''),
      class_id: cls,
      join_month: joinMonth,
      notes: String(body.notes || '').trim(),
      status: ['active', 'left', 'graduated'].includes(body.status) ? body.status : 'active',
    },
  };
}

router.get('/students', (req, res) => {
  ensureDues();
  const q = String(req.query.q || '').trim();
  const term = q.replace(/^#/, '');
  const grade = parseGrade(req.query.grade);
  const show = req.query.show === 'all' ? 'all' : 'active';
  const month = monthOf(today());
  const rows = db
    .prepare(
      `SELECT s.id, s.student_no, s.name, s.phone, s.status, c.grade, c.division,
              COALESCE((SELECT SUM(balance) FROM due_balance b WHERE b.student_id = s.id AND b.month <= ?), 0) AS pending
       FROM students s JOIN classes c ON c.id = s.class_id
       WHERE (? = 'all' OR s.status = 'active') AND (? IS NULL OR c.grade = ?) AND (? = '' OR s.name LIKE '%' || ? || '%' OR printf('%04d', s.student_no) LIKE '%' || ? || '%')
       ORDER BY c.grade, c.division, s.name`
    )
    .all(month, show, grade, grade, term, term, term);
  res.render('students', { rows, grades: GRADES, q, grade, show });
});

router.get('/students/new', (req, res) => {
  res.render('student_form', {
    student: { join_month: monthOf(today()), class_id: Number(req.query.class_id) || '' },
    studentNoField: fmtStudentNo(nextStudentNo()),
    classes: classes(),
    errors: [],
    isNew: true,
  });
});

router.post('/students/new', (req, res) => {
  const { errors, values, studentNoField } = parseStudent(req.body);
  if (errors.length) {
    return res.status(400).render('student_form', { student: values, studentNoField, classes: classes(), errors, isNew: true });
  }
  const id = db
    .prepare(
      `INSERT INTO students (student_no, name, guardian_name, phone, class_id, join_month, notes)
       VALUES (COALESCE(@student_no, (SELECT COALESCE(MAX(student_no), 0) + 1 FROM students)), @name, @guardian_name, @phone, @class_id, @join_month, @notes)`
    )
    .run(values).lastInsertRowid;
  ensureDues(id);
  req.session.flash = 'Student added.';
  res.redirect(`/students/${id}`);
});

router.get('/students/:id', (req, res) => {
  const student = db
    .prepare('SELECT s.*, c.grade, c.division, c.monthly_fee FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?')
    .get(req.params.id);
  if (!student) return res.status(404).render('error', { message: 'Student not found.' });
  ensureDues(student.id);

  const payments = db
    .prepare('SELECT * FROM payments WHERE student_id = ? ORDER BY paid_on DESC, id DESC')
    .all(student.id);
  const months = db
    .prepare('SELECT * FROM due_balance WHERE student_id = ? AND month <= ? ORDER BY month DESC')
    .all(student.id, monthOf(today()));
  const att = db
    .prepare('SELECT status, COUNT(*) AS n FROM attendance WHERE student_id = ? AND date >= ? GROUP BY status')
    .all(student.id, `${monthOf(today())}-01`);
  const attendance = { present: 0, absent: 0, late: 0 };
  for (const r of att) attendance[r.status] = r.n;

  res.render('student', {
    student,
    payments,
    months,
    pending: pendingTotal(student.id),
    pendingMonths: pendingDues(student.id),
    attendance,
  });
});

router.get('/students/:id/edit', (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!student) return res.status(404).render('error', { message: 'Student not found.' });
  res.render('student_form', { student, studentNoField: fmtStudentNo(student.student_no), classes: classes(student.class_id), errors: [], isNew: false });
});

router.post('/students/:id/edit', (req, res) => {
  const existing = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).render('error', { message: 'Student not found.' });
  const { errors, values, studentNoField } = parseStudent(req.body, existing.id);
  if (errors.length) {
    return res
      .status(400)
      .render('student_form', { student: { ...values, id: existing.id }, studentNoField, classes: classes(existing.class_id), errors, isNew: false });
  }
  db.prepare(
    `UPDATE students SET student_no=COALESCE(@student_no, student_no), name=@name, guardian_name=@guardian_name, phone=@phone, class_id=@class_id,
     join_month=@join_month, notes=@notes, status=@status WHERE id=@id`
  ).run({ ...values, id: existing.id });
  ensureDues(existing.id);
  req.session.flash = 'Student updated.';
  res.redirect(`/students/${existing.id}`);
});

// Used by the quick-collect search box.
router.get('/api/students', (req, res) => {
  const term = String(req.query.q || '').trim().replace(/^#/, '');
  const grade = parseGrade(req.query.grade);
  const month = monthOf(today());
  const rows = db
    .prepare(
      `SELECT s.id, s.student_no, s.name, c.grade, c.division,
              COALESCE((SELECT SUM(balance) FROM due_balance b WHERE b.student_id = s.id AND b.month <= ?), 0) AS pending
       FROM students s JOIN classes c ON c.id = s.class_id
       WHERE s.status = 'active' AND (s.name LIKE '%' || ? || '%' OR printf('%04d', s.student_no) LIKE '%' || ? || '%') AND (? IS NULL OR c.grade = ?)
       ORDER BY s.name LIMIT 30`
    )
    .all(month, term, term, grade, grade);
  res.json(rows);
});

module.exports = router;
