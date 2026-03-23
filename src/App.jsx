import { useState, useRef, useCallback } from "react";

const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

function loadPdfJs() {
  return new Promise((resolve, reject) => {
    if (window.pdfjsLib) return resolve(window.pdfjsLib);
    const s = document.createElement("script");
    s.src = PDFJS_CDN;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      resolve(window.pdfjsLib);
    };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function extractTextFromPdf(file) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageLines = [];
    let lastY = null;
    for (const item of content.items) {
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 2) {
        pageLines.push("\n");
      }
      pageLines.push(item.str);
      lastY = item.transform[5];
    }
    fullText += pageLines.join(" ") + "\n\n";
  }
  return fullText;
}

async function extractTextFromHtml(file) {
  const raw = await file.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, "text/html");
  doc.querySelectorAll("script, style, noscript, nav, footer, header, iframe").forEach((el) => el.remove());
  return doc.body?.innerText || doc.body?.textContent || "";
}

async function extractTextFromCsv(file) {
  return await file.text();
}

const AI_PROMPT = `You are a specialist data extraction assistant for UK qualifications and training courses.

Your task: extract EVERY course/qualification from the text below. Do not miss any.

For EACH course found, extract these three fields:
1. "title" — The full course or qualification name. Look for patterns like:
   - "Award in ...", "Certificate in ...", "Diploma in ..."
   - "NVQ in ...", "BTEC ...", "City & Guilds ...", "NCFE ...", "Highfield ...", "TQUK ...", "Qualsafe ..."
   - Any named programme, unit, or qualification
   - Phrases near words like "course", "qualification", "award", "programme", "training"
   - Items in lists or tables that look like course names
   - Anything that a training provider or awarding body would list as a course offering
   - Short course names count too (e.g. "First Aid at Work", "Food Safety", "Manual Handling")
   
2. "level" — The level of the qualification. Look for:
   - "Level 1", "Level 2", "Level 3", "Level 4", "Level 5", "Level 6", "Level 7"
   - "Entry Level", "Entry 3"
   - RQF/QCF/NQF levels
   - Degree level, postgraduate, etc.
   - May appear before or after the title, or in a nearby column/field
   
3. "qualNumber" — The regulatory qualification number. Look for:
   - Ofqual format: 3 digits / 4 digits / 1 digit (e.g. "603/1234/5", "601/7890/1")
   - Also written without slashes: "60312345"
   - QAN (Qualification Accreditation Number)
   - Any alphanumeric code that looks like a regulatory reference near the course

IMPORTANT RULES:
- Extract EVERY course you can find — completeness is critical
- If a field cannot be found, use "N/A"
- Be aggressive — if something looks like it could be a course name, include it
- The text may be messy (extracted from PDF/HTML) so look for patterns, not perfect formatting
- Courses might be in tables, lists, paragraphs, headings, or scattered across the text
- Do NOT skip a course just because it lacks a level or qual number
- If the same course appears at multiple levels, list each as a separate entry
- Include short/informal course names too, not just formal qualification titles

Return ONLY a valid JSON array of objects. No markdown, no explanation, no backticks. Just the raw JSON array.
Example: [{"title":"Award in Health and Safety","level":"Level 2","qualNumber":"603/1234/5"}]

TEXT TO EXTRACT FROM:
`;

// Split long text into overlapping chunks so no courses are lost at boundaries
function chunkText(text, maxChars = 12000, overlap = 1500) {
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + maxChars));
    start += maxChars - overlap;
  }
  return chunks;
}

async function extractCoursesFromChunk(chunk) {
  const resp = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-3-haiku-20240307",
      max_tokens: 4000,
      messages: [{ role: "user", content: AI_PROMPT + chunk }],
    }),
  });
  
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse backend response (Status: ${resp.status}). Content: ${text.substring(0, 100)}...`);
  }
  
  if (data.error) throw new Error(data.error.message || "API error");
  const raw = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const cleaned = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

// Deduplicate courses that may appear in overlapping chunks
function deduplicateCourses(courses) {
  const seen = new Set();
  return courses.filter((c) => {
    const key = `${(c.title || "").toLowerCase().trim()}|${(c.level || "").toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function extractCoursesWithAI(text, onChunkProgress) {
  const chunks = chunkText(text);
  const allCourses = [];
  for (let i = 0; i < chunks.length; i++) {
    if (onChunkProgress) onChunkProgress(i + 1, chunks.length);
    const result = await extractCoursesFromChunk(chunks[i]);
    allCourses.push(...result);
  }
  return deduplicateCourses(allCourses);
}

function isPdf(file) {
  return file?.type === "application/pdf" || file?.name?.toLowerCase().endsWith(".pdf");
}
function isHtml(file) {
  return file?.type === "text/html" || /\.(html?|mhtml?)$/i.test(file?.name || "");
}
function isCsv(file) {
  return file?.type === "text/csv" || file?.name?.toLowerCase().endsWith(".csv");
}
function isValid(file) {
  return isPdf(file) || isHtml(file) || isCsv(file);
}

function toCSV(courses, multiFile) {
  const headers = multiFile
    ? ["Source File", "Course Title", "Level", "Qualification Number"]
    : ["Course Title", "Level", "Qualification Number"];
  const esc = (s) => `"${(s || "").replace(/"/g, '""')}"`;
  const rows = courses.map((c) =>
    multiFile
      ? [esc(c.source), esc(c.title), esc(c.level), esc(c.qualNumber)].join(",")
      : [esc(c.title), esc(c.level), esc(c.qualNumber)].join(",")
  );
  return [headers.join(","), ...rows].join("\r\n");
}

function downloadCSV(courses, multiFile) {
  const csv = toCSV(courses, multiFile);
  const dataUri = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
  const link = document.createElement("a");
  link.setAttribute("href", dataUri);
  link.setAttribute("download", "courses_extracted.csv");
  link.setAttribute("target", "_blank");
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

const thStyle = {
  padding: "10px 14px", textAlign: "left", fontWeight: 600, fontSize: 11,
  textTransform: "uppercase", letterSpacing: 0.8, color: "#666",
  borderBottom: "1px solid #e0dfdc", position: "sticky", top: 0, background: "#f0efec",
};

export default function CourseExtractor() {
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState("");
  const [errors, setErrors] = useState([]);
  const [fileNames, setFileNames] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);
  const inputRef = useRef();

  const processFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList).filter(isValid);
    const invalid = Array.from(fileList).filter((f) => !isValid(f));

    if (files.length === 0) {
      setErrors(["No valid PDF, HTML, or CSV files selected."]);
      return;
    }

    const startErrors = invalid.length > 0
      ? [`Skipped ${invalid.length} unsupported file(s): ${invalid.map((f) => f.name).join(", ")}`]
      : [];
    setErrors(startErrors);
    setCourses([]);
    setFileNames(files.map((f) => f.name));
    setLoading(true);
    setProcessed(0);
    setTotal(files.length);

    const allCourses = [];
    const newErrors = [...startErrors];

    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];
      try {
        setStage(`Reading ${file.name}...`);
        setProcessed(idx);
        let text = "";
        if (isPdf(file)) text = await extractTextFromPdf(file);
        else if (isHtml(file)) text = await extractTextFromHtml(file);
        else if (isCsv(file)) text = await extractTextFromCsv(file);

        if (!text.trim()) {
          newErrors.push(`${file.name}: no text could be extracted`);
          continue;
        }
        const onChunk = (current, total) => {
          if (total > 1) {
            setStage(`Extracting from ${file.name} (chunk ${current}/${total})...`);
          } else {
            setStage(`Extracting courses from ${file.name}...`);
          }
        };
        const result = await extractCoursesWithAI(text, onChunk);
        const tagged = result.map((c) => ({ ...c, source: file.name }));
        allCourses.push(...tagged);
        setCourses([...allCourses]);
      } catch (e) {
        newErrors.push(`${file.name}: ${e.message}`);
      }
    }

    setProcessed(files.length);
    setErrors(newErrors);
    setLoading(false);
    setStage("");
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) processFiles(e.dataTransfer.files);
  }, [processFiles]);

  const onFileChange = useCallback((e) => {
    if (e.target.files?.length) processFiles(e.target.files);
    e.target.value = "";
  }, [processFiles]);

  const hasResults = courses.length > 0;
  const multiFile = fileNames.length > 1;

  return (
    <div style={{ minHeight: "100vh", fontFamily: "'DM Sans', 'Segoe UI', sans-serif", background: "var(--bg, #f6f5f2)", color: "var(--text, #1a1a1a)", padding: "32px 16px" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />

      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#e85d26" }} />
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, fontWeight: 500, letterSpacing: 1.5, textTransform: "uppercase", color: "#888" }}>
              PDF / HTML / CSV → Table
            </span>
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, letterSpacing: -0.5 }}>Course Data Extractor</h1>
          <p style={{ color: "#777", marginTop: 6, fontSize: 14, lineHeight: 1.5 }}>
            Upload one or more webpage PDFs, HTML files, or CSV files — extracts Course Titles, Levels & Qualification Numbers.
          </p>
        </div>

        {/* Upload zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? "#e85d26" : "#ccc"}`,
            borderRadius: 12, padding: "44px 24px", textAlign: "center",
            cursor: "pointer", background: dragOver ? "#fef4ef" : "#fff",
            transition: "all 0.2s", marginBottom: 24,
          }}
        >
          <input ref={inputRef} type="file" accept=".pdf,.html,.htm,.mhtml,.csv" multiple onChange={onFileChange} style={{ display: "none" }} />
          <div style={{ fontSize: 36, marginBottom: 8 }}>📄</div>
          <div style={{ fontWeight: 600, fontSize: 15 }}>
            {fileNames.length > 0
              ? `${fileNames.length} file${fileNames.length > 1 ? "s" : ""} selected`
              : "Drop files here or click to browse"}
          </div>
          <div style={{ color: "#999", fontSize: 13, marginTop: 4 }}>
            PDF, HTML, and CSV — select multiple at once
          </div>
        </div>

        {/* Progress */}
        {loading && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <div style={{
                width: 18, height: 18, border: "3px solid #eee",
                borderTopColor: "#e85d26", borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }} />
              <span style={{ fontSize: 14, color: "#555" }}>{stage}</span>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
            {total > 1 && (
              <>
                <div style={{ background: "#eee", borderRadius: 4, height: 6, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", background: "#e85d26", borderRadius: 4,
                    width: `${Math.round((processed / total) * 100)}%`,
                    transition: "width 0.3s ease",
                  }} />
                </div>
                <div style={{ fontSize: 12, color: "#999", marginTop: 4, fontFamily: "'DM Mono', monospace" }}>
                  {processed} / {total} files
                </div>
              </>
            )}
          </div>
        )}

        {/* Warnings */}
        {errors.length > 0 && (
          <div style={{ background: "#fef8ee", border: "1px solid #fbbf24", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#92400e", marginBottom: 16 }}>
            {errors.map((e, i) => <div key={i}>{e}</div>)}
          </div>
        )}

        {/* Results table */}
        {hasResults && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888" }}>
                {courses.length} course{courses.length !== 1 ? "s" : ""} found
                {multiFile ? ` across ${fileNames.length} files` : ""}
              </span>
              <button
                onClick={() => downloadCSV(courses, multiFile)}
                style={{
                  background: "#1a1a1a", color: "#fff", border: "none",
                  borderRadius: 6, padding: "8px 18px", fontSize: 13,
                  fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                }}
              >
                ↓ Download CSV
              </button>
            </div>

            <div style={{ overflowX: "auto", borderRadius: 10, border: "1px solid #e0dfdc", maxHeight: 520, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                <thead>
                  <tr>
                    <th style={thStyle}>#</th>
                    {multiFile && <th style={thStyle}>Source</th>}
                    <th style={thStyle}>Course Title</th>
                    <th style={thStyle}>Level</th>
                    <th style={thStyle}>Qual Number</th>
                  </tr>
                </thead>
                <tbody>
                  {courses.map((c, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#fafaf8" }}>
                      <td style={{ padding: "10px 14px", borderBottom: "1px solid #eee", color: "#aaa", fontFamily: "'DM Mono', monospace", fontSize: 12 }}>{i + 1}</td>
                      {multiFile && (
                        <td style={{ padding: "10px 14px", borderBottom: "1px solid #eee", fontSize: 12, color: "#888", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                            title={c.source}>{c.source}</td>
                      )}
                      <td style={{ padding: "10px 14px", borderBottom: "1px solid #eee", fontWeight: 500 }}>{c.title || "N/A"}</td>
                      <td style={{ padding: "10px 14px", borderBottom: "1px solid #eee" }}>
                        <span style={{
                          display: "inline-block", background: "#f0efec",
                          borderRadius: 4, padding: "2px 8px", fontSize: 12,
                          fontFamily: "'DM Mono', monospace", fontWeight: 500,
                        }}>
                          {c.level || "N/A"}
                        </span>
                      </td>
                      <td style={{ padding: "10px 14px", borderBottom: "1px solid #eee", fontFamily: "'DM Mono', monospace", fontSize: 12.5 }}>{c.qualNumber || "N/A"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && !hasResults && fileNames.length > 0 && errors.length === 0 && (
          <div style={{ textAlign: "center", padding: 32, color: "#888", fontSize: 14 }}>
            No courses found. Try different files.
          </div>
        )}
      </div>
    </div>
  );
}
