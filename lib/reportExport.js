const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { fmtDate } = require('./dates');

const periodLabel = (range) =>
  range.from === range.to ? fmtDate(range.from) : `${fmtDate(range.from)} – ${fmtDate(range.to)}`;

const fileStem = (range) => `payments_${range.from}_to_${range.to}`;

function csvBuffer({ payments }) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Receipt', 'Date', 'Student', 'Class', 'Method', 'Amount'].join(',')];
  for (const p of payments) {
    lines.push([p.receipt_no, p.paid_on, esc(p.name), `Class ${p.grade}`, esc(p.method), p.amount].join(','));
  }
  return Buffer.from('﻿' + lines.join('\n'));
}

async function xlsxBuffer(report, settings, classLabel) {
  const { range, totals, byMethod, byClass, payments } = report;
  const wb = new ExcelJS.Workbook();
  wb.creator = settings.center_name;
  const moneyFmt = '#,##0';
  const head = (row) => {
    row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5A3FD0' } };
  };

  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ width: 24 }, { width: 16 }, { width: 12 }];
  sum.addRow([settings.center_name]).font = { bold: true, size: 14 };
  sum.addRow(['Fee collection report']);
  sum.addRow(['Period', periodLabel(range)]);
  sum.addRow(['Class', classLabel]);
  sum.addRow([]);
  sum.addRow(['Total collected', totals.total]).getCell(2).numFmt = moneyFmt;
  sum.addRow(['Payments', totals.count]);
  sum.addRow([]);
  head(sum.addRow(['Method', 'Amount', 'Payments']));
  for (const m of byMethod) sum.addRow([m.method, m.total, m.count]).getCell(2).numFmt = moneyFmt;
  sum.addRow([]);
  head(sum.addRow(['Class', 'Amount', 'Payments']));
  for (const c of byClass) sum.addRow([`Class ${c.grade}`, c.total, c.count]).getCell(2).numFmt = moneyFmt;

  const ws = wb.addWorksheet('Payments', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Receipt', key: 'receipt', width: 12 },
    { header: 'Date', key: 'date', width: 13 },
    { header: 'Student', key: 'student', width: 28 },
    { header: 'Class', key: 'cls', width: 8 },
    { header: 'Method', key: 'method', width: 15 },
    { header: 'Amount', key: 'amount', width: 12 },
  ];
  head(ws.getRow(1));
  for (const p of payments) {
    ws.addRow({
      receipt: p.receipt_no,
      date: new Date(`${p.paid_on}T00:00:00`),
      student: p.name,
      cls: `Class ${p.grade}`,
      method: p.method,
      amount: p.amount,
    });
  }
  ws.getColumn('date').numFmt = 'dd-mmm-yyyy';
  ws.getColumn('amount').numFmt = moneyFmt;
  if (payments.length) {
    const total = ws.addRow({ student: 'Total', amount: { formula: `SUM(F2:F${payments.length + 1})`, result: totals.total } });
    total.font = { bold: true };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function pdfStream(report, settings, classLabel, stream) {
  const { range, totals, byMethod, payments } = report;
  const cur = settings.currency === '₹' ? 'Rs.' : settings.currency;
  const money = (n) => `${cur} ${Number(n).toLocaleString('en-IN')}`;
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: 'Fee collection report' } });
  doc.pipe(stream);
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;

  doc.font('Helvetica-Bold').fontSize(16).text(settings.center_name);
  doc.font('Helvetica').fontSize(11).fillColor('#555').text('Fee collection report');
  doc.fontSize(10).text(`Period: ${periodLabel(range)}   |   Class: ${classLabel}`);
  doc.moveDown(0.8).fillColor('#000');

  doc.font('Helvetica-Bold').fontSize(12).text(`Total collected: ${money(totals.total)}   (${totals.count} payment${totals.count === 1 ? '' : 's'})`);
  if (byMethod.length) {
    doc.font('Helvetica').fontSize(10).fillColor('#555')
      .text(byMethod.map((m) => `${m.method}: ${money(m.total)}`).join('   |   '));
  }
  doc.moveDown(0.8).fillColor('#000');

  const cols = [
    { label: 'Receipt', x: 0, w: 70 },
    { label: 'Date', x: 70, w: 80 },
    { label: 'Student', x: 150, w: 190 },
    { label: 'Class', x: 340, w: 45 },
    { label: 'Method', x: 385, w: 70 },
    { label: 'Amount', x: 455, w: width - 455, align: 'right' },
  ];
  const drawHeader = () => {
    const y = doc.y;
    doc.rect(left, y - 3, width, 18).fill('#5a3fd0');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9);
    for (const c of cols) doc.text(c.label, left + c.x + 3, y + 1, { width: c.w - 6, align: c.align || 'left', lineBreak: false });
    doc.fillColor('#000').y = y + 20;
  };

  drawHeader();
  doc.font('Helvetica').fontSize(9);
  payments.forEach((p, i) => {
    if (doc.y + 16 > bottom()) {
      doc.addPage();
      drawHeader();
      doc.font('Helvetica').fontSize(9);
    }
    const y = doc.y;
    if (i % 2) doc.rect(left, y - 2, width, 15).fill('#f1effd').fillColor('#000');
    const cells = [p.receipt_no, fmtDate(p.paid_on), p.name, `Class ${p.grade}`, p.method, money(p.amount)];
    cols.forEach((c, k) => doc.text(cells[k], left + c.x + 3, y, { width: c.w - 6, align: c.align || 'left', lineBreak: false, ellipsis: true }));
    doc.y = y + 15;
  });
  if (!payments.length) doc.text('No payments in this period.', left);
  else {
    if (doc.y + 24 > bottom()) doc.addPage();
    doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor('#999').stroke();
    doc.font('Helvetica-Bold').fontSize(10).text(`Total  ${money(totals.total)}`, left, doc.y + 8, { width, align: 'right' });
  }

  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // otherwise writing in the footer area adds a blank page
    doc.font('Helvetica').fontSize(8).fillColor('#888')
      .text(`Page ${i + 1} of ${pages.count}`, left, doc.page.height - 30, { width, align: 'center', lineBreak: false });
  }
  doc.end();
}

module.exports = { csvBuffer, xlsxBuffer, pdfStream, fileStem };
