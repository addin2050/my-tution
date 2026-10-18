const express = require('express');
const { db } = require('../db');
const { today, addDays, isDate, parse } = require('../lib/dates');

// Lesson plans: teachers and admins write them per class and date; students see the visible ones for their class.
const router = express.Router();

const DEFAULT_SUBJECTS = ['Maths', 'Science', 'English', 'Social Science', 'Hindi', 'Computer'];
const WHEN = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['upcoming', 'Upcoming'],
  ['past', 'Past'],
  ['all', 'All'],
];

const classes = () => db.prepare('SELECT id, grade FROM classes WHERE active = 1 ORDER BY grade').all();
const subjects = () => [
  ...new Set([
    ...DEFAULT_SUBJECTS,
    ...db.prepare("SELECT DISTINCT subject FROM lesson_plans WHERE subject <> '' ORDER BY subject").all().map((r) => r.subject),
  ]),
];

// Inclusive [from, to] date limits for a filter; null means "no limit on that side".
function whenRange(when) {
  const t = today();
  switch (when) {
    case 'today':
      return [t, t];
    case 'upcoming':
      return [t, null];
    case 'past':
      return [null, addDays(t, -1)];
    case 'all':
      return [null, null];
    default: {
      const monday = addDays(t, -((parse(t).getDay() + 6) % 7)); // weeks run Monday to Sunday
      return [monday, addDays(monday, 6)];
    }
  }
}

function parsePlan(body) {
  const errors = [];
  const classId = Number(body.class_id);
  if (!db.prepare('SELECT 1 FROM classes WHERE id = ?').get(classId)) errors.push('Pick a class.');
  const planDate = isDate(body.plan_date) ? body.plan_date : null;
  if (!planDate) errors.push('Pick a valid date.');
  const title = String(body.title || '').trim();
  if (!title) errors.push('Give the lesson a title.');
  // Only web links are allowed, so a link can never run script when a student taps it.
  const link = String(body.link || '').trim();
  if (link && !/^https?:\/\/[^\s]+$/i.test(link)) errors.push('The link must start with http:// or https://');
  return {
    errors,
    values: {
      class_id: classId,
      plan_date: planDate || String(body.plan_date || ''),
      subject: String(body.subject || '').trim().slice(0, 40),
      title: title.slice(0, 120),
      details: String(body.details || '').trim().slice(0, 4000),
      homework: String(body.homework || '').trim().slice(0, 2000),
      link: link.slice(0, 500),
      visible: body.visible === '1' ? 1 : 0,
    },
  };
}

const form = (res, status, extra) =>
  res.status(status).render('lesson_form', { classes: classes(), subjects: subjects(), errors: [], ...extra });

router.get('/lessons', (req, res) => {
  const when = WHEN.some(([k]) => k === req.query.when) ? req.query.when : 'week';
  const classId = Number(req.query.class_id) || null;
  const [from, to] = whenRange(when);
  const user = req.session.user;
  const rows = db
    .prepare(
      `SELECT l.*, c.grade, u.username AS author FROM lesson_plans l
       JOIN classes c ON c.id = l.class_id LEFT JOIN users u ON u.id = l.created_by
       WHERE (? IS NULL OR l.class_id = ?) AND (? IS NULL OR l.plan_date >= ?) AND (? IS NULL OR l.plan_date <= ?)
       ORDER BY l.plan_date ${when === 'past' || when === 'all' ? 'DESC' : 'ASC'}, c.grade, l.subject, l.id LIMIT 200`
    )
    .all(classId, classId, from, from, to, to);
  for (const r of rows) r.canDelete = user.role === 'admin' || r.created_by === user.id;
  res.render('lessons', { rows, classes: classes(), classId, when, whenOptions: WHEN });
});

router.get('/lessons/new', (req, res) => {
  // "Copy" starts a new plan from an existing one, so the same lesson can go to another class or day.
  const src = req.query.copy ? db.prepare('SELECT * FROM lesson_plans WHERE id = ?').get(req.query.copy) : null;
  const plan = src
    ? { ...src, plan_date: today(), id: undefined }
    : { class_id: Number(req.query.class_id) || '', plan_date: isDate(req.query.date) ? req.query.date : today(), visible: 1 };
  form(res, 200, { plan, isNew: true });
});

router.post('/lessons/new', (req, res) => {
  const { errors, values } = parsePlan(req.body);
  if (errors.length) return form(res, 400, { plan: values, errors, isNew: true });
  db.prepare(
    `INSERT INTO lesson_plans (class_id, plan_date, subject, title, details, homework, link, visible, created_by)
     VALUES (@class_id, @plan_date, @subject, @title, @details, @homework, @link, @visible, @created_by)`
  ).run({ ...values, created_by: req.session.user.id });
  req.session.flash = 'Lesson plan saved.';
  res.redirect(`/lessons?class_id=${values.class_id}&when=all`);
});

router.get('/lessons/:id/edit', (req, res) => {
  const plan = db.prepare('SELECT * FROM lesson_plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).render('error', { message: 'Lesson plan not found.' });
  form(res, 200, { plan, isNew: false });
});

router.post('/lessons/:id/edit', (req, res) => {
  const existing = db.prepare('SELECT id FROM lesson_plans WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).render('error', { message: 'Lesson plan not found.' });
  const { errors, values } = parsePlan(req.body);
  if (errors.length) return form(res, 400, { plan: { ...values, id: existing.id }, errors, isNew: false });
  db.prepare(
    `UPDATE lesson_plans SET class_id=@class_id, plan_date=@plan_date, subject=@subject, title=@title, details=@details,
     homework=@homework, link=@link, visible=@visible, updated_at=datetime('now') WHERE id=@id`
  ).run({ ...values, id: existing.id });
  req.session.flash = 'Lesson plan updated.';
  res.redirect(`/lessons?class_id=${values.class_id}&when=all`);
});

// Everyone on staff can edit a plan (teachers cover for each other); deleting is for its author or an admin.
router.post('/lessons/:id/delete', (req, res) => {
  const plan = db.prepare('SELECT id, created_by FROM lesson_plans WHERE id = ?').get(req.params.id);
  const user = req.session.user;
  if (!plan) {
    req.session.flash = 'That lesson plan no longer exists.';
  } else if (user.role !== 'admin' && plan.created_by !== user.id) {
    req.session.flash = 'Only the teacher who wrote this plan, or an admin, can delete it.';
  } else {
    db.prepare('DELETE FROM lesson_plans WHERE id = ?').run(plan.id);
    req.session.flash = 'Lesson plan deleted.';
  }
  res.redirect('/lessons?when=all');
});

module.exports = router;
