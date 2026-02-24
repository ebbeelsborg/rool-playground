import * as pdfjsLib from "pdfjs-dist";
// @ts-expect-error - Vite handles ?url imports
import workerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export async function extractTextFromPdf(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item: { str?: string }) => item.str ?? "").join(" ");
    fullText += pageText + "\n";
  }
  return fullText.trim();
}
