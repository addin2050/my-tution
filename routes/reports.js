const express = require('express');
const { db, allSettings } = require('../db');
const { csvBuffer, xlsxBuffer, pdfStream, fileStem } = require('../lib/reportExport');
const { ensureDues } = require('../lib/fees');
const { resolveRange, PRESETS, addDays, parse, fmt } = require('../lib/dates');

const router = express.Router();

function loadReport(query) {
  const range = resolveRange(query.range, query.from, query.to);
  const classId = Number(query.class_id) || null;
  const params = [range.from, range.to, classId, classId];
  const where = `p.status = 'valid' AND p.paid_on BETWEEN ? AND ? AND (? IS NULL OR s.class_id = ?)`;
  const base = 'FROM payments p JOIN students s ON s.id = p.student_id JOIN classes c ON c.id = s.class_id';

  const totals = db.prepare(`SELECT COALESCE(SUM(p.amount),0) AS total, COUNT(*) AS count ${base} WHERE ${where}`).get(...params);
  const byMethod = db
    .prepare(`SELECT p.method, SUM(p.amount) AS total, COUNT(*) AS count ${base} WHERE ${where} GROUP BY p.method ORDER BY total DESC`)
    .all(...params);
  const byClass = db
    .prepare(
      `SELECT c.grade, c.division, SUM(p.amount) AS total, COUNT(*) AS count ${base} WHERE ${where}
       GROUP BY c.id ORDER BY c.grade, c.division`
    )
    .all(...params);
  const daily = db
    .prepare(`SELECT p.paid_on AS day, SUM(p.amount) AS total ${base} WHERE ${where} GROUP BY p.paid_on`)
    .all(...params);
  const payments = db
    .prepare(
      `SELECT p.id, p.receipt_no, p.amount, p.method, p.paid_on, s.id AS student_id, s.name, c.grade, c.division
       ${base} WHERE ${where} ORDER BY p.paid_on DESC, p.id DESC`
    )
    .all(...params);
  const voided = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(p.amount),0) AS total ${base}
       WHERE p.status = 'void' AND p.paid_on BETWEEN ? AND ? AND (? IS NULL OR s.class_id = ?)`
    )
    .get(...params);

  // Fill days with no payments so the chart axis is continuous (capped to keep long ranges readable).
  const byDay = new Map(daily.map((d) => [d.day, d.total]));
  const series = [];
  const spanDays = Math.round((parse(range.to) - parse(range.from)) / 86400000) + 1;
  if (spanDays <= 62) {
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) series.push({ day: d, total: byDay.get(d) || 0 });
  } else {
    for (const d of daily.sort((a, b) => a.day.localeCompare(b.day))) series.push({ day: d.day, total: d.total });
  }

  return { range, classId, totals, byMethod, byClass, series, payments, voided };
}

router.get('/reports', (req, res) => {
  ensureDues();
  const classes = db.prepare('SELECT * FROM classes ORDER BY grade, division').all();
  const report = loadReport(req.query);
  res.render('reports', { ...report, classes, presets: PRESETS, maxDay: Math.max(1, ...report.series.map((s) => s.total)) });
});

const EXPORT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

router.get('/reports/export.:format', async (req, res, next) => {
  const type = EXPORT_TYPES[req.params.format];
  if (!type) return next();
  const report = loadReport(req.query);
  const settings = allSettings();
  const cls = report.classId && db.prepare('SELECT grade, division FROM classes WHERE id = ?').get(report.classId);
  const classLabel = cls ? `${cls.grade}${cls.division}` : 'All classes';
  res.set({
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${fileStem(report.range)}.${req.params.format}"`,
  });
  if (req.params.format === 'pdf') return pdfStream(report, settings, classLabel, res);
  res.send(req.params.format === 'csv' ? csvBuffer(report) : await xlsxBuffer(report, settings, classLabel));
});

module.exports = router;
