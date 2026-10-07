/**
 * Minimal, dependency-free ZIP extractor built on Node's zlib.
 *
 * Supports the common "Store" (method 0) and "Deflate" (method 8) compression
 * methods, which is all the Playwright CDN and GitHub release zips use.
 *
 * It reads the End Of Central Directory (EOCD) record to find the central
 * directory, walks each central-directory entry, and extracts the entry's data
 * from the local file header. No streaming: whole archive is held in memory
 * (browser archives are tens of MB, which is fine).
 */

import { inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, posix } from "node:path";

const EOCD_SIG = 0x06054b50; // "PK\x05\x06"
const CEN_SIG = 0x02014b50; // "PK\x01\x02"
const LOC_SIG = 0x04034b50; // "PK\x03\x04"

export interface ZipEntry {
  name: string; // archive path (POSIX separators)
  method: number; // 0 = store, 8 = deflate
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Locate and parse the End Of Central Directory record. */
function readEocd(buf: Buffer): { cdOffset: number; cdSize: number; entries: number } {
  // EOCD is at the end, but its comment field (up to 65535 bytes) can trail it.
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return {
        entries: buf.readUInt16LE(i + 10),
        cdSize: buf.readUInt32LE(i + 12),
        cdOffset: buf.readUInt32LE(i + 16),
      };
    }
  }
  throw new Error("zip: End Of Central Directory record not found");
}

/** Walk the central directory and return one ZipEntry per member. */
export function listEntries(buf: Buffer): ZipEntry[] {
  const { cdOffset, entries } = readEocd(buf);
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) {
      throw new Error(`zip: bad central directory signature at offset ${p}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    out.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Extract a single entry's bytes (inflating if needed). */
export function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localHeaderOffset;
  if (buf.readUInt32LE(p) !== LOC_SIG) {
    throw new Error(`zip: bad local header for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`zip: unsupported compression method ${entry.method} for ${entry.name}`);
}

/**
 * Extract every entry into `destDir`, preserving the archive's directory
 * structure. Directory entries (names ending in "/") and empty names are
 * created as directories. Executable bits are not stored in the zip, so
 * `chmodPlusX` lists paths (POSIX) that should receive +x after extraction.
 */
export function extractAll(
  buf: Buffer,
  destDir: string,
  opts: { chmodPlusX?: string[] } = {},
): { files: number; bytes: number } {
  const entries = listEntries(buf);
  const plusX = new Set(opts.chmodPlusX ?? []);
  let files = 0;
  let bytes = 0;

  for (const entry of entries) {
    const rel = entry.name.replace(/\\/g, "/");
    if (!rel || rel.endsWith("/")) {
      mkdirSync(join(destDir, rel), { recursive: true });
      continue;
    }
    // Guard against path traversal in malicious archives.
    const safeRel = posix.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
    const target = join(destDir, safeRel);
    mkdirSync(dirname(target), { recursive: true });
    const data = readEntry(buf, entry);
    writeFileSync(target, data);
    bytes += data.length;
    files++;
    if (plusX.has(rel) || plusX.has(safeRel)) {
      try {
        chmodSync(target, 0o755);
      } catch {
        /* chmod not permitted (e.g. non-POSIX FS) */
      }
    }
  }
  return { files, bytes };
}
