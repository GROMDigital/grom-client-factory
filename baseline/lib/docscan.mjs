// Shared document + claims-sidecar scan, used by validate.mjs (which reports)
// and conformance_fix.mjs (which repairs). One source of truth on purpose:
// on 2026-07-28 the validator and the fixers disagreed about where sidecars
// live, the validator called five real sidecars orphans, and three fixer agents
// DELETED them. Twenty-five fill tokens went with them. If these two tools ever
// scan different file sets again, that happens again.
import fs from "node:fs";
import path from "node:path";

export const AUTHORED_EXT = /\.(md|html)$/i;

export const dirsIn = (p) =>
  fs.existsSync(p)
    ? fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];

export const walk = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter((d) => d.isFile())
        .map((d) => path.join(d.parentPath ?? d.path, d.name))
    : [];

// Docs at the client-folder root are authored deliverables like any other:
// go-live-checklist.md and post-launch-onboarding.md live there by registry
// decree (doc index section 11, "Fixed client-root path"). The validator used
// to walk design/, lp/ and build/ only, so those two were never scanned and
// their sidecars looked orphaned BY CONSTRUCTION. Non-recursive, and .md/.html
// only, so client-manifest.json and the strategy/ and captures/ trees stay out.
export const rootDocs = (root) =>
  fs.existsSync(root)
    ? fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isFile() && AUTHORED_EXT.test(d.name))
        .map((d) => path.join(root, d.name))
    : [];

// Every file the text scans cover, in one place.
export const scannedFiles = (root) => [
  ...rootDocs(root),
  ...walk(path.join(root, "design")),
  ...walk(path.join(root, "lp")),
  ...walk(path.join(root, "build")),
];

export const isClaimsPath = (root, f) =>
  path.relative(root, f).split(path.sep).includes("claims");

// Both places a claims sidecar has ever legitimately been written. Agents wrote
// to design/claims/ and to build/<runDate>/claims/ in the same run; the
// validator only knew the second. Reading both is what stops a real sidecar
// being reported as guarding nothing.
export const claimsDirs = (root) => {
  const out = [];
  for (const d of dirsIn(path.join(root, "build"))) {
    const c = path.join(root, "build", d, "claims");
    if (fs.existsSync(c)) out.push(c);
  }
  const designClaims = path.join(root, "design", "claims");
  if (fs.existsSync(designClaims)) out.push(designClaims);
  return out;
};

// Where a NEW sidecar should be written: the latest build run's claims dir.
// Existing sidecars are never moved. Moving files is how work gets lost, and
// the validator now reads both locations anyway.
export const canonicalClaimsDir = (root) => {
  const runs = dirsIn(path.join(root, "build")).sort();
  if (runs.length) return path.join(root, "build", runs[runs.length - 1], "claims");
  return path.join(root, "design", "claims");
};

export const bareToken = (t) => String(t).replace(/^\{\{|\}\}$/g, "").trim();

// A fill token is {{FILL_SNAKE_CASE}} in capitals, digits and underscores.
// Anything else inside {{FILL_...}} braces is malformed, EXCEPT prose that is
// visibly describing the pattern rather than being an instance of it. The fill
// guide's own explanatory text says "every {{FILL_*}} in this build"; that is
// documentation, it is not a token, and flagging it burned a fixer agent on
// three consecutive runs with a violation no fixer could ever clear.
export const PATTERN_LITERAL = /^\{\{FILL_(\*|\.\.\.|<[A-Za-z_]+>)\}\}$/;
export const MALFORMED_TOKEN = /\{\{FILL_(?![A-Z0-9_]+\}\})[^}]*\}\}/g;
export const REAL_TOKEN = /\{\{(FILL_[A-Z0-9_]+)\}\}/g;

// Scans the WHOLE line, not just its first match. A single non-global match
// meant one pattern literal early in a line hid every real malformed token
// after it, and the file guaranteed to put both on one line is the fill guide's
// own explanatory text, which is the exact file the exemption was added for.
export const malformedTokenOn = (line) => {
  for (const m of line.matchAll(MALFORMED_TOKEN)) {
    if (!PATTERN_LITERAL.test(m[0])) return m[0];
  }
  return null;
};

// key -> { files: [abs paths], tokens: Set }. The key is the basename without
// extension, which is also the claims sidecar's basename.
export const docTokenIndex = (root) => {
  const index = new Map();
  for (const f of scannedFiles(root)) {
    if (!AUTHORED_EXT.test(f) || isClaimsPath(root, f)) continue;
    const key = path.basename(f).replace(AUTHORED_EXT, "");
    const entry = index.get(key) ?? { files: [], tokens: new Set() };
    entry.files.push(f);
    for (const m of fs.readFileSync(f, "utf8").matchAll(REAL_TOKEN)) entry.tokens.add(m[1]);
    index.set(key, entry);
  }
  return index;
};

// A sidecar named `build-overview.json` beside a doc named
// `00-build-overview.md` is a numbering drift, not an orphan. This resolves it
// so the repair is a rename rather than a guess. Exactly one candidate or
// nothing: an ambiguous match is left alone and reported.
export const resolveOrphanKey = (key, index) => {
  const strip = (k) => k.replace(/^\d{2}[a-z]?-/, "");
  const candidates = [...index.keys()].filter((k) => k === key || strip(k) === strip(key));
  return candidates.length === 1 ? candidates[0] : null;
};
