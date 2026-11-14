import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FileContext } from "@/lib/council";

export const runtime = "nodejs";

const MAX_FILE_SIZE = 8 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_LENGTH = 40_000;
// Default to python3 on PATH; override with PDF_PYTHON_BIN when the
// interpreter (with pypdf installed) lives elsewhere.
const DEFAULT_PYTHON = "python3";
const PYTHON = process.env.PDF_PYTHON_BIN?.trim() || DEFAULT_PYTHON;
const execFileAsync = promisify(execFile);

const supported = {
  pdf: ["application/pdf"],
  txt: ["text/plain"],
  md: ["text/markdown", "text/plain"],
} as const;

function fileType(file: File): FileContext["fileType"] | null {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension !== "pdf" && extension !== "txt" && extension !== "md") return null;
  if (file.type && !supported[extension].includes(file.type as never)) return null;
  return extension;
}

async function extractPdf(buffer: Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "ai-council-pdf-"));
  const input = join(directory, "upload.pdf");
  try {
    await writeFile(input, buffer);
    const script = "import sys\nfrom pypdf import PdfReader\nreader = PdfReader(sys.argv[1])\nprint('\\n'.join((page.extract_text() or '') for page in reader.pages))";
    const { stdout } = await execFileAsync(PYTHON, ["-c", script, input], { maxBuffer: 2 * 1024 * 1024, timeout: 15_000 });
    return stdout.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function trimText(text: string) {
  if (text.length <= MAX_EXTRACTED_TEXT_LENGTH) return { extractedText: text, truncated: false };
  return { extractedText: text.slice(0, MAX_EXTRACTED_TEXT_LENGTH), truncated: true };
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "请选择一个文件。" }, { status: 400 });
  const type = fileType(file);
  if (!type) return NextResponse.json({ error: "仅支持 PDF、TXT 和 Markdown 文件。" }, { status: 400 });
  if (!file.size || file.size > MAX_FILE_SIZE) return NextResponse.json({ error: "文件为空或超过 8 MB 限制。" }, { status: 400 });

  try {
    const rawText = type === "pdf" ? await extractPdf(Buffer.from(await file.arrayBuffer())) : await file.text();
    if (!rawText.trim()) {
      const warning = type === "pdf" ? "当前版本无法读取扫描版 PDF，需要 OCR 能力。" : "文件中没有可读取的文本。";
      const fileContext: FileContext = { fileName: file.name, fileType: type, fileSize: file.size, extractedText: "", truncated: false, extractionWarning: warning };
      return NextResponse.json({ fileContext });
    }
    const { extractedText, truncated } = trimText(rawText);
    const fileContext: FileContext = { fileName: file.name, fileType: type, fileSize: file.size, extractedText, truncated, extractionWarning: truncated ? "文档文本已截断，结论可能不完整。" : null };
    return NextResponse.json({ fileContext });
  } catch {
    const fileContext: FileContext = { fileName: file.name, fileType: type, fileSize: file.size, extractedText: "", truncated: false, extractionWarning: type === "pdf" ? "当前版本无法读取扫描版 PDF，需要 OCR 能力。" : "文件解析失败，请重新上传。" };
    return NextResponse.json({ fileContext });
  }
}
