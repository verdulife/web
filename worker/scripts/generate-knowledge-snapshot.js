// Generates deterministic (path-sorted) index + snapshot JSON from knowledge/*.md
// into worker/src/generated/. Plain Node ESM, no dependencies.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const knowledgeRoot = path.resolve(scriptDir, "../../knowledge");
const outputDir = path.resolve(scriptDir, "../src/generated");

/** Recursively collect every .md file under a directory, in readdir order. */
function collectMarkdown(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectMarkdown(full));
    } else if (entry.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

/** Relative Unix-style path from the knowledge root, extension stripped. */
function relativeKnowledgePath(file) {
  const relative = path.relative(knowledgeRoot, file);
  const unix = relative.split(path.sep).join("/");
  return unix.replace(/\.md$/, "");
}

/** Parse the frontmatter block between the first pair of "---" lines. */
function parseFrontmatter(source) {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return null;

  const fields = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[match[1]] = value;
  }
  return { fields, body: lines.slice(end + 1).join("\n") };
}

/** Remove HTML comments (review notes such as <!-- DUDA: ... -->). */
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

const entries = [];
const documents = [];
let skipped = 0;

for (const file of collectMarkdown(knowledgeRoot)) {
  const parsed = parseFrontmatter(readFileSync(file, "utf8"));
  if (!parsed) {
    skipped += 1;
    continue;
  }
  const { fields, body } = parsed;
  const id = fields.id;
  // Exclude the index document entirely: it is not retrievable via
  // get_knowledge_document and its metadata never reaches the model index.
  if (!id || id === "index") {
    skipped += 1;
    continue;
  }
  const pathValue = relativeKnowledgePath(file);
  const title = fields.title ?? "";
  const description = fields.description ?? "";
  const kind = fields.kind ?? "";

  entries.push({ id, path: pathValue, kind, title, description });
  documents.push({
    id,
    title,
    description,
    content: stripHtmlComments(body).trim(),
  });
}

entries.sort((a, b) => a.path.localeCompare(b.path));
// Documents carry no path; sort by id for deterministic output.
documents.sort((a, b) => a.id.localeCompare(b.id));

mkdirSync(outputDir, { recursive: true });
const indexPath = path.join(outputDir, "knowledge-index.json");
const snapshotPath = path.join(outputDir, "knowledge-snapshot.json");
writeFileSync(indexPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
writeFileSync(snapshotPath, `${JSON.stringify({ documents }, null, 2)}\n`, "utf8");

console.log(
  `knowledge snapshot: ${entries.length} entries, ${documents.length} documents, ${skipped} skipped ` +
    `(index.md / missing frontmatter) -> ${indexPath} and ${snapshotPath}`,
);