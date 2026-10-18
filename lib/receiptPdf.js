const PDFDocument = require('pdfkit');
const { fmtDate, monthLabel } = require('./dates');

// The built-in PDF fonts have no rupee glyph, so receipts print "Rs." instead.
const money = (n, currency) => `${currency === '₹' ? 'Rs.' : currency} ${Number(n).toLocaleString('en-IN')}`;

function buildReceiptPdf(receipt, settings, stream) {
  const doc = new PDFDocument({ size: 'A5', margin: 36, info: { Title: `Receipt ${receipt.receipt_no}` } });
  doc.pipe(stream);
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const cur = settings.currency;

  doc.font('Helvetica-Bold').fontSize(16).text(settings.center_name, { align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor('#555');
  if (settings.center_address) doc.text(settings.center_address, { align: 'center' });
  if (settings.center_phone) doc.text(`Phone: ${settings.center_phone}`, { align: 'center' });
  doc.moveDown(0.6).fillColor('#000').font('Helvetica-Bold').fontSize(12).text('FEE RECEIPT', { align: 'center' });
  doc.moveTo(left, doc.y + 4).lineTo(left + width, doc.y + 4).strokeColor('#999').stroke();
  doc.moveDown(0.8);

  const row = (label, value) => {
    const y = doc.y;
    doc.font('Helvetica').fontSize(10).fillColor('#555').text(label, left, y, { width: 110 });
    doc.font('Helvetica-Bold').fillColor('#000').text(String(value), left + 110, y, { width: width - 110 });
  };
  row('Receipt No', receipt.receipt_no);
  row('Date', fmtDate(receipt.paid_on));
  row('Student', receipt.student_name);
  row('Class', `Class ${receipt.grade}`);
  if (receipt.guardian_name) row('Guardian', receipt.guardian_name);
  row('Payment method', receipt.method);

  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(10).text('Fees paid for', left);
  doc.moveDown(0.3);
  for (const m of receipt.months) {
    const y = doc.y;
    doc.font('Helvetica').fontSize(10).text(monthLabel(m.month), left, y, { width: width - 90 });
    doc.text(money(m.amount, cur), left, y, { width: width, align: 'right' });
  }

  doc.moveDown(0.5);
  doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#999').stroke();
  doc.moveDown(0.5);
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(12).text('Total received', left, y);
  doc.text(money(receipt.amount, cur), left, y, { width, align: 'right' });
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(10).fillColor('#555');
  doc.text(`Pending balance after this payment: ${money(receipt.balance_after, cur)}`, left);
  if (receipt.note) doc.text(`Note: ${receipt.note}`);

  if (receipt.status === 'void') {
    doc.save().rotate(-25, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.font('Helvetica-Bold').fontSize(70).fillColor('#d33').opacity(0.25)
      .text('VOID', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center' });
    doc.restore();
  }

  doc.opacity(1).font('Helvetica').fontSize(8).fillColor('#888')
    .text('This is a computer generated receipt.', left, doc.page.height - 56, { width, align: 'center' });
  doc.end();
}

module.exports = { buildReceiptPdf };
