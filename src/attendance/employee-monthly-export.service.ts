import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { EmployeeMonthlyService } from './employee-monthly.service';

type Report = Awaited<ReturnType<EmployeeMonthlyService['getMonth']>>;
const BLUE = '135BEE';
const DARK = '17294C';
const PALE = 'EEF4FF';
const WEEKEND = 'DFEAFF';
const HOLIDAY = 'FFF0D4';
const monthDisplay = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB',
  { month: 'long', year: 'numeric', timeZone: 'UTC' });
const statusBg = (type: string) => type === 'WEEKEND' ? WEEKEND : type === 'HOLIDAY' ? HOLIDAY : 'FFFFFF';
const clock = (day: Report['days'][number], seq: number, field: 'punchIn' | 'punchOut') =>
  day.sessions.find(s => s.shiftOrder === seq)?.[field] || '—';

@Injectable()
export class EmployeeMonthlyExportService {
  async export(report: Report, format: string) {
    if (!['xlsx', 'pdf'].includes(format)) throw new BadRequestException('Choose xlsx or pdf');
    const safeName = report.employee.name.replace(/[^a-z0-9-]/gi, '_').slice(0, 55);
    const filename = `AttendEase_${safeName}_${report.month}.${format}`;
    if (format === 'xlsx') {
      return { filename, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        buffer: await this.excel(report) };
    }
    return { filename, mime: 'application/pdf', buffer: await this.pdf(report) };
  }

  private async excel(report: Report): Promise<Buffer> {
    // A single, share-ready worksheet: no frozen panes, split lines, or filter buttons.
    // The PDF export below remains independent and unchanged.
    const wb = new ExcelJS.Workbook();
    wb.creator = 'AttendEase';
    wb.subject = 'Employee monthly attendance report';
    wb.title = `AttendEase - ${report.employee.name} - ${monthDisplay(report.month)}`;
    wb.created = new Date();

    const ws = wb.addWorksheet('Attendance', {
      views: [{ state: 'normal', showGridLines: false, zoomScale: 90 }],
    });
    const shiftCount = Math.max(1, report.maxShift);
    const headers = [
      'Date', 'Day',
      ...Array.from({ length: shiftCount }, (_, i) =>
        shiftCount === 1 ? ['Punch In', 'Punch Out'] :
          [`Shift ${i + 1} Punch In`, `Shift ${i + 1} Punch Out`]).flat(),
      'Working Hours', 'Status / Day Type', 'Remarks',
    ];
    const lastCol = headers.length;
    const halfway = Math.floor(lastCol / 2);
    const HEADER_ROW = 13;
    const FIRST_DATA_ROW = HEADER_ROW + 1;
    const LAST_DATA_ROW = HEADER_ROW + report.days.length;

    ws.columns = headers.map((_, index) => ({
      key: `column${index + 1}`,
      width: index === 0 ? 19 : index === 1 ? 11 :
        index === lastCol - 3 ? 18 : index === lastCol - 2 ? 23 :
        index === lastCol - 1 ? 38 : 21,
    }));
    ws.properties.defaultRowHeight = 23;

    const styleBand = (rowIndex: number, text: string, bg: string, fg: string,
      size: number, height: number) => {
      ws.mergeCells(rowIndex, 1, rowIndex, lastCol);
      const row = ws.getRow(rowIndex);
      row.height = height;
      for (let col = 1; col <= lastCol; col++) {
        row.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${bg}` } };
      }
      const cell = row.getCell(1);
      cell.value = text;
      cell.font = { name: 'Aptos', bold: true, size, color: { argb: `FF${fg}` } };
      cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
    };

    styleBand(1, 'AttendEase', BLUE, 'FFFFFF', 21, 42);
    styleBand(2, 'EMPLOYEE ATTENDANCE REPORT  /  ' + monthDisplay(report.month), DARK, 'FFFFFF', 12, 31);
    ws.getRow(3).height = 14;

    const infoRow = (rowIndex: number, left: string, right: string) => {
      ws.mergeCells(rowIndex, 1, rowIndex, halfway);
      ws.mergeCells(rowIndex, halfway + 1, rowIndex, lastCol);
      const row = ws.getRow(rowIndex);
      row.height = 30;
      for (let col = 1; col <= lastCol; col++) {
        row.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${PALE}` } };
      }
      for (const [column, label] of [[1, left], [halfway + 1, right]] as const) {
        const cell = row.getCell(column);
        cell.value = label;
        cell.font = { name: 'Aptos', size: 11, bold: true, color: { argb: `FF${DARK}` } };
        cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
      }
    };

    infoRow(4, `Employee: ${report.employee.name}`, `Employee Code: ${report.employee.employeeCode}`);
    infoRow(5, `Department: ${report.employee.department || 'Not assigned'}`,
      `Designation: ${report.employee.designation || 'Not specified'}`);
    infoRow(6, `Work Location: ${report.employee.workLocation || 'Not assigned'}`,
      `Device: ${report.device.status === 'NOT_REGISTERED' ? 'Not registered' : report.device.name || 'Not specified'}`);
    infoRow(7, `Month: ${monthDisplay(report.month)}`, `Assigned Shifts: ${shiftCount}`);
    ws.getRow(8).height = 12;

    styleBand(9,
      `PRESENT  ${report.summary.present}     LATE  ${report.summary.late}     ABSENT  ${report.summary.absent}` +
      `     WEEKEND  ${report.summary.weekend}     HOLIDAY  ${report.summary.holiday}`,
      'DCEAFF', BLUE, 11, 35);
    styleBand(10, 'WEEKENDS: light blue rows     |     HOLIDAYS: light amber rows',
      'F4F7FC', '526581', 10, 25);
    ws.getRow(11).height = 10;
    ws.getRow(12).height = 8;

    // No leading `undefined` here. ExcelJS arrays map their first item to column A.
    // Previously `[undefined, ...headers]` shifted headings into B while data began in A.
    const header = ws.getRow(HEADER_ROW);
    header.values = headers;
    header.height = 38;
    for (let col = 1; col <= lastCol; col++) {
      const cell = header.getCell(col);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${BLUE}` } };
      cell.font = { name: 'Aptos', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.alignment = { horizontal: col === lastCol ? 'left' : 'center',
        vertical: 'middle', wrapText: true, indent: col === lastCol ? 1 : 0 };
      cell.border = { bottom: { style: 'medium', color: { argb: 'FF1048BF' } } };
    }

    const statusStyle = (status: string): { bg: string; fg: string } => {
      switch (status) {
        case 'WEEKEND': return { bg: 'CDE0FF', fg: '1554B8' };
        case 'HOLIDAY': return { bg: 'FFE2AE', fg: '985500' };
        case 'PRESENT': return { bg: 'D8F7E2', fg: '166534' };
        case 'LATE': return { bg: 'FFF0BF', fg: '92400E' };
        case 'ABSENT': return { bg: 'FEE2E2', fg: 'B91C1C' };
        default: return { bg: 'EEF2F7', fg: '475569' };
      }
    };

    report.days.forEach((day, index) => {
      const row = ws.getRow(FIRST_DATA_ROW + index);
      row.height = 27;
      const values = [
        new Date(`${day.date}T00:00:00.000Z`), day.weekday,
        ...Array.from({ length: shiftCount }, (_, i) => [
          clock(day, i + 1, 'punchIn'), clock(day, i + 1, 'punchOut'),
        ]).flat(),
        day.workingHours, day.status.replaceAll('_', ' '), day.note || '—',
      ];
      row.values = values;
      const rowBg = day.dayType === 'WEEKEND' ? WEEKEND :
        day.dayType === 'HOLIDAY' ? HOLIDAY : index % 2 === 0 ? 'FFFFFF' : 'F7FAFF';
      for (let col = 1; col <= lastCol; col++) {
        const cell = row.getCell(col);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${rowBg}` } };
        cell.font = { name: 'Aptos', size: 10, color: { argb: `FF${DARK}` },
          bold: col === 1 };
        cell.alignment = { horizontal: col === lastCol ? 'left' : 'center',
          vertical: 'middle', wrapText: true, indent: col === lastCol ? 1 : 0 };
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFDCE5F3' } } };
      }
      row.getCell(1).numFmt = 'dd mmm yyyy';
      const statusCell = row.getCell(lastCol - 1);
      const badge = statusStyle(day.status);
      statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${badge.bg}` } };
      statusCell.font = { name: 'Aptos', size: 10, bold: true, color: { argb: `FF${badge.fg}` } };
    });

    const footerRow = LAST_DATA_ROW + 2;
    ws.getRow(LAST_DATA_ROW + 1).height = 13;
    styleBand(footerRow,
      `Generated by AttendEase  |  ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
      'F4F7FC', '526581', 10, 30);

    // Presentable when opened or printed: no frozen divider and no filter arrows.
    // Landscape printing spans additional pages vertically rather than shrinking a month to illegible text.
    ws.pageSetup = {
      paperSize: 9, // A4
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      printTitlesRow: `${HEADER_ROW}:${HEADER_ROW}`,
      printArea: `A1:${ws.getColumn(lastCol).letter}${footerRow}`,
      margins: { left: 0.25, right: 0.25, top: 0.45, bottom: 0.45,
        header: 0.18, footer: 0.18 },
    };
    ws.headerFooter.oddFooter = '&LAttendEase  |  Employee Attendance&CConfidential&RPage &P of &N';
    const bytes = await wb.xlsx.writeBuffer();
    return Buffer.from(bytes);
  }

  private pdf(report: Report): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32, autoFirstPage: false,
        info: { Title: `AttendEase Monthly Attendance - ${report.employee.name}`, Author: 'AttendEase' } });
      const buffers: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => buffers.push(chunk));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      const pageW = 842, margin = 32, available = pageW - margin * 2;
      const groups = Array.from({ length: Math.ceil(report.maxShift / 2) }, (_, i) => i * 2 + 1);
      groups.forEach((start, part) => {
        doc.addPage();
        doc.rect(0, 0, pageW, 8).fill(`#${BLUE}`);
        doc.fillColor(`#${BLUE}`).font('Helvetica-Bold').fontSize(19).text('AttendEase', margin, 23);
        doc.fillColor(`#${DARK}`).fontSize(16).text('Employee Attendance Report', margin, 25,
            { width: available, align: 'center', lineBreak: false });
        doc.font('Helvetica').fontSize(10).fillColor('#425877');
        doc.text(`Employee Name: ${report.employee.name}  |  Employee Code: ${report.employee.employeeCode}  |  Month: ${monthDisplay(report.month)}`, margin, 66,
            { width: available, lineBreak: false, ellipsis: true });
        doc.text(`Department: ${report.employee.department || 'Not assigned'}    Device: ${report.device.name || 'Not registered'}`, margin, 82);
        doc.text(`Present: ${report.summary.present}   Late: ${report.summary.late}   Absent: ${report.summary.absent}   Weekend: ${report.summary.weekend}   Holiday: ${report.summary.holiday}`, margin, 104);
        doc.fontSize(8).fillColor('#64748B').text(`Shift columns ${start}–${Math.min(start + 1, report.maxShift)} of ${report.maxShift}`, margin, 123);
        const shown = [start, start + 1].filter(i => i <= report.maxShift);
        // Keep shift columns readable alongside Working Hours on landscape A4.
        const widths = shown.length === 2
          ? [85, 38, 96, 96, 96, 96, 82, 92, 0]
          : [100, 50, 118, 118, 83, 120, 0];
        widths[widths.length - 1] = available - widths.slice(0, -1).reduce((a, b) => a + b, 0);
        const headers = ['Date', 'Day', ...shown.flatMap(i => report.maxShift === 1 ? ['Punch In', 'Punch Out'] : [`Shift ${i} In`, `Shift ${i} Out`]), 'Working Hours', 'Status', 'Remarks'];
        const x = [margin]; widths.forEach(w => x.push(x.at(-1)! + w));
        const headerY = 143, h = 11;
        doc.rect(margin, headerY, available, 24).fill(`#${BLUE}`);
        doc.font('Helvetica-Bold').fillColor('white').fontSize(8);
        headers.forEach((label, i) => doc.text(label, x[i] + 4, headerY + 8, { width: widths[i] - 8, lineBreak: false }));
        report.days.forEach((day, rowIndex) => {
          const y = headerY + 24 + rowIndex * h;
          const bg = statusBg(day.dayType);
          doc.rect(margin, y, available, h).fill(`#${bg}`);
          doc.strokeColor('#E3EAF5').lineWidth(0.25).moveTo(margin, y + h).lineTo(margin + available, y + h).stroke();
          const values = [day.date, day.weekday, ...shown.flatMap(i => [clock(day, i, 'punchIn'), clock(day, i, 'punchOut')]),
            day.workingHours, day.status.replaceAll('_', ' '), day.note || ''];
          doc.font('Helvetica').fontSize(7).fillColor(`#${DARK}`);
          values.forEach((value, i) => doc.text(String(value), x[i] + 4, y + 2.5,
            { width: widths[i] - 8, height: h - 2, ellipsis: true, lineBreak: false }));
        });
        const bottom = headerY + 24 + report.days.length * h + 16;
        doc.font('Helvetica').fontSize(8).fillColor('#607399')
          .text('Weekend rows: light blue   |   Holiday rows: light amber. Markings are employee-specific.', margin, bottom);
        doc.text(`Generated by AttendEase  |  Page ${part + 1} of ${groups.length}`, margin, 548);
      });
      doc.end();
    });
  }
}
