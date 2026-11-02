import ExcelJS from 'exceljs';
import mammoth from 'mammoth';

// Same extraction rules as site's lib/documentPreview.ts (extractTextForRag),
// but from an in-memory upload instead of a file on disk.

export function kindOf(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  return ['txt', 'docx', 'xlsx'].includes(ext) ? ext : null;
}

export async function extractText(buffer, kind) {
  if (kind === 'txt') {
    return buffer.toString('utf-8').trim();
  }

  if (kind === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const chunks = [];
    for (const sheet of workbook.worksheets) {
      const rows = [];
      sheet.eachRow((row) => {
        const values = Array.isArray(row.values) ? row.values : [];
        rows.push(
          values
            .filter((v) => v !== null && v !== undefined && typeof v !== 'object')
            .map((v) => String(v))
            .join(' | ')
        );
      });
      const text = rows.join('\n');
      if (text.trim()) chunks.push(text);
    }
    return chunks.join('\n\n').trim();
  }

  if (kind === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim();
  }

  return '';
}
