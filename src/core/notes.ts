/**
 * Hand-written notes that survive regeneration.
 *
 * Everything else in SERVICE.md is derived from source files, so `generate`
 * can rewrite it freely. Prose is different: the reason a service is the way
 * it is, who to call at 3am, which migration is load-bearing — none of that
 * is recoverable from the filesystem, and overwriting it is unrecoverable
 * damage to the document.
 *
 * So each section carries a marked block. `generate` reads the previous
 * SERVICE.md, lifts the text out of those blocks, and writes it back into
 * the new one verbatim. The markers are HTML comments, so they're invisible
 * in every markdown renderer.
 *
 * Notes are deliberately NOT part of a section's hash: the hash tracks the
 * *source files*, and editing your own prose should never mark a section as
 * drifted.
 */

export const NOTES_PLACEHOLDER =
  "_No hand-written notes yet — anything you write between these two markers survives `handoverkit generate`._";

const startMarker = (id: string) => `<!-- handoverkit:notes:start id=${id} -->`;
const endMarker = (id: string) => `<!-- handoverkit:notes:end id=${id} -->`;

// The id is restricted to identifier characters rather than \S so it can't run
// into the closing "-->" of its own comment.
const ID = "[A-Za-z0-9._-]+";

// The closing marker has to carry the *same* id (\1), not just any id. Without
// that backreference, deleting one section's end marker lets its start pair
// with the next section's end — swallowing everything in between as "notes"
// and blaming the wrong section in the error message.
const NOTES_BLOCK_RE = new RegExp(
  `<!--\\s*handoverkit:notes:start\\s+id=(${ID})\\s*-->` +
    `\\r?\\n?([\\s\\S]*?)\\r?\\n?[ \\t]*` +
    `<!--\\s*handoverkit:notes:end\\s+id=\\1\\s*-->`,
  "g"
);

const NOTES_START_RE = new RegExp(`<!--\\s*handoverkit:notes:start\\s+id=(${ID})\\s*-->`, "g");

/** Renders a section's notes block, falling back to the placeholder when empty. */
export function renderNotesBlock(id: string, body: string): string {
  const content = body.trim() || NOTES_PLACEHOLDER;
  return `${startMarker(id)}\n${content}\n${endMarker(id)}`;
}

/**
 * Lifts every notes block out of an existing SERVICE.md, keyed by section id.
 *
 * Throws if a block was opened but never closed by a marker with a matching
 * id. That case is ambiguous — we can't tell where the prose ends — and
 * guessing would mean silently dropping text somebody typed. Refusing to
 * regenerate is the recoverable failure.
 *
 * Duplicate ids (usually a copy-paste) are joined rather than resolved, so no
 * text is lost; the next `generate` collapses them into one block.
 */
export function extractNotes(serviceMd: string): Map<string, string> {
  const byId = new Map<string, string>();

  NOTES_BLOCK_RE.lastIndex = 0;
  const closed = new Set<number>();
  for (const match of serviceMd.matchAll(NOTES_BLOCK_RE)) {
    const [, id, body] = match;
    if (match.index !== undefined) closed.add(match.index);
    const existing = byId.get(id);
    const trimmed = body.trim();
    byId.set(id, existing ? `${existing}\n\n${trimmed}`.trim() : trimmed);
  }

  NOTES_START_RE.lastIndex = 0;
  for (const start of serviceMd.matchAll(NOTES_START_RE)) {
    if (start.index !== undefined && !closed.has(start.index)) {
      throw new Error(
        `SERVICE.md has a notes block that was opened but never closed (id=${start[1]}). ` +
          `Restore its "handoverkit:notes:end" comment with the same id — or delete the start marker ` +
          `if you don't want that block — then run generate again. ` +
          `Refusing to regenerate rather than discard your notes.`
      );
    }
  }

  return byId;
}

/** True when a block holds nothing a human actually wrote. */
export function isEmptyNotes(body: string): boolean {
  const trimmed = body.trim();
  return trimmed === "" || trimmed === NOTES_PLACEHOLDER;
}

/** How many sections carry real prose — used for the CLI's confirmation line. */
export function countHandWrittenNotes(serviceMd: string): number {
  return [...extractNotes(serviceMd).values()].filter((body) => !isEmptyNotes(body)).length;
}
