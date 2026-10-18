const express = require('express');
const { db, allSettings } = require('../db');
const { ensureDues, pendingDues, pendingTotal, collectPayment, voidPayment, getReceipt } = require('../lib/fees');
const { buildReceiptPdf } = require('../lib/receiptPdf');
const { today, monthOf, isDate, monthLabel } = require('../lib/dates');
const { GRADES, parseGrade } = require('../lib/grade');

const router = express.Router();
const METHODS = ['Cash', 'UPI', 'Card', 'Bank transfer', 'Cheque'];

// Indian 10-digit numbers get the 91 prefix; anything else is used as given.
function whatsappLink(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const full = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${full}?text=${encodeURIComponent(text)}`;
}

router.get('/collect', (req, res) => {
  res.render('collect_search', { grades: GRADES });
});

router.get('/collect/:studentId', (req, res) => {
  const student = db
    .prepare('SELECT s.*, c.grade, c.division, c.monthly_fee FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?')
    .get(req.params.studentId);
  if (!student) return res.status(404).render('error', { message: 'Student not found.' });
  ensureDues(student.id);
  res.render('collect', {
    student,
    pendingMonths: pendingDues(student.id),
    pending: pendingTotal(student.id),
    methods: METHODS,
    error: null,
    form: { paid_on: today(), method: 'Cash' },
  });
});

router.post('/collect/:studentId', (req, res) => {
  const student = db
    .prepare('SELECT s.*, c.grade, c.division, c.monthly_fee FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?')
    .get(req.params.studentId);
  if (!student) return res.status(404).render('error', { message: 'Student not found.' });

  const amount = Number(req.body.amount);
  const form = {
    amount: req.body.amount,
    method: METHODS.includes(req.body.method) ? req.body.method : 'Cash',
    paid_on: isDate(req.body.paid_on) ? req.body.paid_on : today(),
    note: String(req.body.note || '').trim().slice(0, 200),
  };
  const fail = (error) =>
    res.status(400).render('collect', {
      student,
      pendingMonths: pendingDues(student.id),
      pending: pendingTotal(student.id),
      methods: METHODS,
      error,
      form,
    });

  if (!Number.isInteger(amount) || amount <= 0) return fail('Enter a whole-number amount greater than zero.');
  if (form.paid_on > today()) return fail('Payment date cannot be in the future.');

  try {
    const id = collectPayment({
      studentId: student.id,
      amount,
      method: form.method,
      paidOn: form.paid_on,
      note: form.note,
      userId: req.session.user.id,
    });
    res.redirect(`/receipts/${id}`);
  } catch (e) {
    fail(e.message);
  }
});

router.get('/receipts/:id', (req, res) => {
  const receipt = getReceipt(req.params.id);
  if (!receipt) return res.status(404).render('error', { message: 'Receipt not found.' });
  const months = receipt.months.map((m) => monthLabel(m.month)).join(', ');
  const wa = whatsappLink(
    receipt.phone,
    `Fee received: ${res.locals.fmtMoney(receipt.amount)} for ${receipt.student_name} (${months}). Receipt ${receipt.receipt_no}. Thank you - ${res.locals.settings.center_name}`
  );
  res.render('receipt', { receipt, wa });
});

router.get('/receipts/:id/pdf', (req, res) => {
  const receipt = getReceipt(req.params.id);
  if (!receipt) return res.status(404).render('error', { message: 'Receipt not found.' });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${receipt.receipt_no}.pdf"`,
  });
  buildReceiptPdf(receipt, allSettings(), res);
});

router.post('/receipts/:id/void', (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  if (!reason) {
    req.session.flash = 'Give a reason to void a receipt.';
    return res.redirect(`/receipts/${req.params.id}`);
  }
  const changed = voidPayment(req.params.id, reason);
  req.session.flash = changed ? 'Receipt voided. The fees are pending again.' : 'Receipt was already void.';
  res.redirect(`/receipts/${req.params.id}`);
});

// Everyone with an outstanding balance, with a one-tap WhatsApp reminder.
router.get('/pending', (req, res) => {
  ensureDues();
  const grade = parseGrade(req.query.grade);
  const month = monthOf(today());
  const rows = db
    .prepare(
      `SELECT s.id, s.student_no, s.name, s.guardian_name, s.phone, c.grade, c.division,
              SUM(b.balance) AS pending, COUNT(*) AS months, MIN(b.month) AS oldest
       FROM due_balance b JOIN students s ON s.id = b.student_id JOIN classes c ON c.id = s.class_id
       WHERE b.month <= ? AND b.balance > 0 AND s.status = 'active' AND (? IS NULL OR c.grade = ?)
       GROUP BY s.id ORDER BY c.grade, c.division, s.name`
    )
    .all(month, grade, grade);
  const { settings, fmtMoney } = res.locals;
  for (const r of rows) {
    r.wa = whatsappLink(
      r.phone,
      `Dear ${r.guardian_name || 'Parent'}, this is a reminder from ${settings.center_name}: ${r.name}'s tuition fee of ${fmtMoney(r.pending)} (${r.months} month${r.months > 1 ? 's' : ''}, since ${monthLabel(r.oldest)}) is pending. Kindly pay at your earliest convenience. Thank you.`
    );
  }
  const total = rows.reduce((s, r) => s + r.pending, 0);
  res.render('pending', { rows, total, grades: GRADES, grade });
});

module.exports = router;
