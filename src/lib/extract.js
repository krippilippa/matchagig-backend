// lib/extract.js - Robust text extraction for multiple file types
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import pdfParse from "pdf-parse/lib/pdf-parse.js";

// Suppress pdf-parse font warnings to reduce console spam
const originalWarn = console.warn;
console.warn = function(...args) {
  const msg = args[0];
  if (typeof msg === 'string' && (
    msg.includes('Warning: Ran out of space in font private use area') ||
    msg.includes('Warning: TT: undefined function') ||
    msg.includes('Warning: Indexing all PDF objects') ||
    msg.includes('Warning: TT: invalid function id')
  )) {
    return; // Suppress these specific font warnings
  }
  originalWarn.apply(console, args);
};

// Suppress pdf-parse console.log spam too
const originalLog = console.log;
console.log = function(...args) {
  const msg = args[0];
  if (typeof msg === 'string' && (
    msg.includes('Warning: Ran out of space in font private use area') ||
    msg.includes('Warning: TT: undefined function') ||
    msg.includes('Warning: Indexing all PDF objects') ||
    msg.includes('Warning: TT: invalid function id')
  )) {
    return; // Suppress these specific font warnings
  }
  originalLog.apply(console, args);
};

function canonicalize(raw = "") {
  return (raw || "")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/-\n/g, "") // de-hyphenate wraps
    .trim();
}

function quality(t = "") {
  const len = t.length;
  const letters = (t.match(/[A-Za-zÀ-ÖØ-öø-ÿ0-9]/g) || []).length;
  return { len, ratio: len ? letters / len : 0 };
}

// Optional OCR via ocrmypdf
async function ocrWithOcrmypdf(buf, langs = "eng") {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ocr-"));
  const inPath = path.join(tmp, "in.pdf");
  const outPath = path.join(tmp, "out.pdf");
  await fs.writeFile(inPath, buf);
  
  const run = (cmd, args) => new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: "ignore" });
    p.on("close", code => code === 0 ? res() : rej(new Error(`${cmd} exit ${code}`)));
  });
  
  try {
    await run("ocrmypdf", ["--force-ocr","--skip-text","--rotate-pages","--deskew","--language",langs,inPath,outPath]);
  } catch {
    await run("docker", ["run","--rm","-v",`${tmp}:/work`,"ghcr.io/ocrmypdf/ocrmypdf:latest", "--force-ocr","--skip-text","--rotate-pages","--deskew","--language",langs,"/work/in.pdf","/work/out.pdf"]);
  }
  
  const outBuf = await fs.readFile(outPath);
  await fs.rm(tmp, { recursive:true, force:true });
  return outBuf;
}

export async function extractCanonicalText(buf, filename = "file") {
  const ext = path.extname(filename || "").toLowerCase();
  const ENABLE_OCR = process.env.ENABLE_OCR === "1";
  const OCR_LANGS = process.env.OCR_LANGS || "eng";
  
  try {
    if (ext === ".pdf") {
      let text = "";
      let q = { len: 0, ratio: 0 };
      
      // Try pdf-parse only (removed problematic pdfjs-dist fallback)
      try {
        const pdfData = await pdfParse(buf);
        text = canonicalize(pdfData?.text || "");
        q = quality(text);
      } catch (e) {
        console.warn(`pdf-parse failed for ${filename}: ${e.message}`);
      }
      
      // If still poor quality and OCR is enabled, try OCR
      if (ENABLE_OCR && (q.len < 200 || q.ratio < 0.2)) {
        try {
          const ocrBuf = await ocrWithOcrmypdf(buf, OCR_LANGS);
          const t3 = canonicalize((await pdfParse(ocrBuf))?.text || "");
          const q3 = quality(t3);
          if (q3.len > q.len) {
            text = t3;
            q = q3;
          }
        } catch (ocrError) {
          console.warn(`OCR failed for ${filename}: ${ocrError.message}`);
        }
      }
      
      if (q.len < 200 || q.ratio < 0.2) return "";
      return text;
    }
    
    if (ext === ".docx") {
      try {
        const mammoth = await import("mammoth");
        const out = await mammoth.extractRawText({ buffer: buf });
        return canonicalize(out?.value || "");
      } catch (e) {
        console.warn(`mammoth failed for ${filename}: ${e.message}`);
        return "";
      }
    }
    
    if (ext === ".txt") {
      return canonicalize(buf.toString("utf8"));
    }
    
    // Guess based on content
    const guess = canonicalize(buf.toString("utf8"));
    const q = quality(guess);
    return (q.len < 200 || /^%PDF-/.test(guess)) ? "" : guess;
    
  } catch (e) {
    if (process.env.DEBUG_EXTRACT === "1") console.error("[extract] error:", e);
    return "";
  }
}
