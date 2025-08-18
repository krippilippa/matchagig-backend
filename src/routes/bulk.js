// routes/bulk.js - Minimal test route for PDF text extraction
import { toFile } from 'openai';

export default async function bulkRoutes(app) {
  // Simple test route - upload PDF and extract text
  app.post("/v1/bulk-test", async (req, reply) => {
    try {
      console.log('🔍 Testing PDF text extraction...');
      
      // Read a single file part in a blocking-safe way (same as upload.js)
      const filePart = await req.file();
      if (!filePart) {
        return reply.code(400).send({ 
          error: "No file uploaded",
          message: "Upload a PDF file" 
        });
      }

      console.log(`📁 Filename: ${filePart.filename}`);
      console.log(`📏 File size: ${filePart.file.bytesRead} bytes`);
      
      // Convert the file to buffer (same as upload.js)
      const buf = await filePart.toBuffer();
      console.log(`📏 Buffer size: ${buf.length} bytes`);
      
      // Try to extract text with better error handling
      let text = '';
      try {
        const pdf = (await import('pdf-parse/lib/pdf-parse.js')).default;
        const pdfData = await pdf(buf);
        text = pdfData.text || '';
        console.log(`📝 Extracted text length: ${text.length}`);
        console.log(`📝 Text preview: ${text.substring(0, 200)}...`);
      } catch (pdfError) {
        console.error('❌ PDF parsing failed:', pdfError.message);
        
        // Try alternative approach - check if it's a valid PDF first
        if (buf.length < 4 || buf.toString('ascii', 0, 4) !== '%PDF') {
          return reply.code(400).send({
            error: "Invalid PDF file",
            message: "File does not appear to be a valid PDF"
          });
        }
        
        // If it's a valid PDF but parsing failed, return error with details
        return reply.code(500).send({
          error: "PDF parsing failed",
          message: pdfError.message,
          details: "The PDF file appears valid but could not be parsed. This might be due to encryption, corruption, or unsupported PDF features."
        });
      }
      
      return reply.send({
        success: true,
        filename: filePart.filename,
        textLength: text.length,
        preview: text.substring(0, 500),
        fullText: text
      });
      
    } catch (e) {
      console.error('❌ PDF extraction failed:', e.message);
      return reply.code(500).send({ 
        error: "PDF extraction failed",
        message: e.message 
      });
    }
  });
}
