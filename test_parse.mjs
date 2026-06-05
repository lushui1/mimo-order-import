import * as XLSX from "xlsx";
import { readFileSync } from "fs";

const buffer = readFileSync("D:/Download/GoogleDownload/demos/湖南仓.xlsx");
const workbook = XLSX.read(buffer, { type: "buffer" });
console.log("Sheets:", workbook.SheetNames);
for (const sname of workbook.SheetNames) {
  const ws = workbook.Sheets[sname];
  const ref = ws["!ref"];
  if (!ref) continue;
  const range = XLSX.utils.decode_range(ref);
  console.log(`\n=== Sheet: ${sname} ===`);
  for (let r = range.s.r; r <= Math.min(range.s.r + 2, range.e.r); r++) {
    const vals = [];
    for (let c = range.s.c; c <= Math.min(range.s.c + 5, range.e.c); c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (cell) vals.push(`${c}:${cell.v}`);
    }
    console.log(`Row ${r}: ${vals.join(" | ")}`);
  }
}
