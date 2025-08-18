// lib/extract.js - Robust text extraction for multiple file types
import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import * as mammoth from "mammoth";

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

// Simplified PDF extraction without pdfjs fallback for now
async function extractWithPdfjs(buf) {
  // For now, just return empty string - we'll rely on pdf-parse
  return "";
}

export async function extractCanonicalText(buf, filename = "file") {
  const ext = path.extname(filename || "").toLowerCase();
  const ENABLE_OCR = process.env.ENABLE_OCR === "1";
  const OCR_LANGS = process.env.OCR_LANGS || "eng";

  try {
    if (ext === ".pdf") {
      let text = canonicalize((await pdfParse(buf))?.text || "");
      let q = quality(text);

      if (q.len < 200 || q.ratio < 0.2) {
        const t2 = await extractWithPdfjs(buf);
        const q2 = quality(t2);
        if (q2.len > q.len) { text = t2; q = q2; }
      }

      // OCR disabled for now - would need ocrmypdf installation
      // if (ENABLE_OCR && (q.len < 200 || q.ratio < 0.2)) {
      //   const ocrBuf = await ocrWithOcrmypdf(buf, OCR_LANGS);
      //   const t3 = canonicalize((await pdfParse(ocrBuf))?.text || "");
      //   const q3 = quality(t3);
      //   if (q3.len > q.len) { text = t3; q = q3; }
      // }

      if (q.len < 200 || q.ratio < 0.2) return "";
      return text;
    }

    if (ext === ".docx") {
      const out = await mammoth.extractRawText({ buffer: buf });
      return canonicalize(out?.value || "");
    }

    if (ext === ".txt") {
      return canonicalize(buf.toString("utf8"));
    }

    const guess = canonicalize(buf.toString("utf8"));
    const q = quality(guess);
    return (q.len < 200 || /^%PDF-/.test(guess)) ? "" : guess;

  } catch (e) {
    if (process.env.DEBUG_EXTRACT === "1") console.error("[extract] error:", e);
    return "";
  }
}
