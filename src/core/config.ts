import { tryRead } from "./parsers/fsUtil.js";
import { DISCOVERY_CEILING } from "./parsers/walk.js";

/**
 * Optional per-repo configuration.
 *
 * Without it, SERVICE.md is whatever the built-in sections produce, which
 * means a team wanting to track "the on-call rota lives in ops/rota.yml" has
 * to fork the tool. A config file lets them declare that section — and get
 * drift detection on it — without touching the source.
 *
 * Everything here is validated rather than trusted: ids end up inside the
 * HTML comment markers that drive both drift detection and notes carry-over,
 * so a malformed one would corrupt the document rather than merely look wrong.
 */

export const CONFIG_FILENAME = "handoverkit.config.json";

/** Same charset the notes markers accept — an id outside it can't round-trip. */
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const ALLOWED_KEYS = ["sections", "exclude", "order", "scanLimit"];
const ALLOWED_SECTION_KEYS = ["id", "title", "sources", "body"];

export interface CustomSectionConfig {
  id: string;
  title: string;
  /** Repo-relative files or directories whose changes should stale this section. */
  sources: string[];
  /** Static markdown. Omit it and the section is just a tracked notes block. */
  body?: string;
}

export interface HandoverConfig {
  sections: CustomSectionConfig[];
  /** Built-in section ids to leave out. */
  exclude: string[];
  /** Section ids to pull to the front, in this order. Others keep their order. */
  order?: string[];
  /**
   * How many source files the scanning sections may read. Raising it widens
   * both the TODO scan and the dependency graph, at the cost of a longer
   * `sources=` list in SERVICE.md.
   */
  scanLimit?: number;
}

export const EMPTY_CONFIG: HandoverConfig = { sections: [], exclude: [] };

export async function loadConfig(repoRoot: string, configPath?: string): Promise<HandoverConfig> {
  const filename = configPath ?? CONFIG_FILENAME;
  const raw = await tryRead(repoRoot, filename);
  if (raw === undefined) {
    // An explicitly requested config that isn't there is a mistake worth
    // reporting; the default one simply being absent is the normal case.
    if (configPath) throw new Error(`Config file not found: ${configPath}`);
    return EMPTY_CONFIG;
  }
  return parseConfig(raw, filename);
}

export function parseConfig(raw: string, filename = CONFIG_FILENAME): HandoverConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${filename} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${filename} must contain a JSON object.`);
  }
  rejectUnknownKeys(parsed, ALLOWED_KEYS, filename);

  const sections = parseSections(parsed.sections, filename);
  const exclude = parseStringArray(parsed.exclude, `${filename}: "exclude"`) ?? [];
  const order = parseStringArray(parsed.order, `${filename}: "order"`);
  const scanLimit = parseScanLimit(parsed.scanLimit, `${filename}: "scanLimit"`);

  return {
    sections,
    exclude,
    ...(order ? { order } : {}),
    ...(scanLimit !== undefined ? { scanLimit } : {}),
  };
}

function parseScanLimit(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${where} must be a positive whole number.`);
  }
  if (value > DISCOVERY_CEILING) {
    throw new Error(`${where} must be at most ${DISCOVERY_CEILING}, the most files handover-kit will enumerate.`);
  }
  return value;
}

function parseSections(value: unknown, filename: string): CustomSectionConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${filename}: "sections" must be an array.`);

  const seen = new Set<string>();
  return value.map((entry, index) => {
    const where = `${filename}: sections[${index}]`;
    if (!isRecord(entry)) throw new Error(`${where} must be an object.`);
    rejectUnknownKeys(entry, ALLOWED_SECTION_KEYS, where);

    const id = requireString(entry.id, `${where}.id`);
    if (!ID_PATTERN.test(id)) {
      throw new Error(`${where}.id must contain only letters, digits, dot, dash or underscore (got "${id}").`);
    }
    if (seen.has(id)) throw new Error(`${where}.id duplicates an earlier section id ("${id}").`);
    seen.add(id);

    const title = requireString(entry.title, `${where}.title`);
    if (title.includes("\n")) throw new Error(`${where}.title must be a single line.`);

    const sources = parseStringArray(entry.sources, `${where}.sources`);
    if (!sources || sources.length === 0) {
      throw new Error(`${where}.sources must list at least one file or directory to track.`);
    }
    for (const source of sources) {
      assertRepoRelative(source, `${where}.sources`);
    }

    const body = entry.body === undefined ? undefined : requireString(entry.body, `${where}.body`);
    return body === undefined ? { id, title, sources } : { id, title, sources, body };
  });
}

/**
 * Sources are hashed by resolving them against the repo root, so an absolute
 * path or a `..` segment would read outside the repository being documented.
 */
function assertRepoRelative(source: string, where: string): void {
  if (source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source)) {
    throw new Error(`${where} must be repo-relative, not absolute (got "${source}").`);
  }
  if (source.split(/[\\/]/).includes("..")) {
    throw new Error(`${where} must stay inside the repo — "${source}" escapes it with "..".`);
  }
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new Error(`${where}: unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}. Allowed: ${allowed.join(", ")}.`);
  }
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where} must be a non-empty string.`);
  }
  return value.trim();
}

function parseStringArray(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
    throw new Error(`${where} must be an array of non-empty strings.`);
  }
  return value.map((v) => (v as string).trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
