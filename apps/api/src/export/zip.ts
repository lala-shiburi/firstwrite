import type { Writable } from 'node:stream';

const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[n] = c >>> 0;
}

export function computeCrc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]!;
    c = (c >>> 8) ^ CRC32_TABLE[(c ^ byte) & 0xff]!;
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface CentralDirectoryEntry {
  nameBuf: Buffer;
  crc: number;
  size: number;
  offset: number;
}

function writeChunkWithBackpressure(stream: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Sanitizes an archive entry filename to prevent zip-slip (`..`, leading `/`, or backslashes).
 */
export function sanitizeZipEntryPath(entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized
    .split('/')
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
  if (segments.length === 0) {
    throw new Error('Invalid ZIP entry path');
  }
  return segments.join('/');
}

/**
 * Streaming ZIP writer (PKZIP 2.0 `STORE` method with UTF-8 flag `0x0800`).
 * Writes each file's Local File Header + content immediately to the target `Writable` stream
 * so file contents are never accumulated in memory. Only compact Central Directory metadata
 * (~60 bytes per file) is retained until `finalize()`.
 */
export class ZipStreamWriter {
  private readonly stream: Writable;
  private readonly entries: CentralDirectoryEntry[] = [];
  private offset = 0;

  constructor(stream: Writable) {
    this.stream = stream;
  }

  public async appendFile(rawPath: string, content: string | Buffer): Promise<void> {
    const safePath = sanitizeZipEntryPath(rawPath);
    const nameBuf = Buffer.from(safePath, 'utf8');
    const dataBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const crc = computeCrc32(dataBuf);
    const size = dataBuf.length;
    const localHeaderOffset = this.offset;

    // Local file header (30 bytes + filename length)
    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0); // Local file header signature
    lfh.writeUInt16LE(20, 4); // Version needed to extract (2.0)
    lfh.writeUInt16LE(0x0800, 6); // General purpose bit flag (Bit 11: UTF-8 filename)
    lfh.writeUInt16LE(0, 8); // Compression method: 0 (STORE)
    lfh.writeUInt16LE(0x0000, 10); // Last mod file time
    lfh.writeUInt16LE(0x5d70, 12); // Last mod file date
    lfh.writeUInt32LE(crc, 14); // CRC-32
    lfh.writeUInt32LE(size, 18); // Compressed size
    lfh.writeUInt32LE(size, 22); // Uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26); // File name length
    lfh.writeUInt16LE(0, 28); // Extra field length
    nameBuf.copy(lfh, 30);

    await writeChunkWithBackpressure(this.stream, lfh);
    await writeChunkWithBackpressure(this.stream, dataBuf);

    this.offset += lfh.length + size;
    this.entries.push({
      nameBuf,
      crc,
      size,
      offset: localHeaderOffset,
    });
  }

  public async finalize(): Promise<void> {
    const cdStartOffset = this.offset;
    let cdTotalBytes = 0;

    for (const entry of this.entries) {
      const cdh = Buffer.alloc(46 + entry.nameBuf.length);
      cdh.writeUInt32LE(0x02014b50, 0); // Central directory file header signature
      cdh.writeUInt16LE(20, 4); // Version made by
      cdh.writeUInt16LE(20, 6); // Version needed to extract
      cdh.writeUInt16LE(0x0800, 8); // General purpose bit flag (UTF-8)
      cdh.writeUInt16LE(0, 10); // Compression method (STORE)
      cdh.writeUInt16LE(0x0000, 12); // Last mod file time
      cdh.writeUInt16LE(0x5d70, 14); // Last mod file date
      cdh.writeUInt32LE(entry.crc, 16); // CRC-32
      cdh.writeUInt32LE(entry.size, 20); // Compressed size
      cdh.writeUInt32LE(entry.size, 24); // Uncompressed size
      cdh.writeUInt16LE(entry.nameBuf.length, 28); // File name length
      cdh.writeUInt16LE(0, 30); // Extra field length
      cdh.writeUInt16LE(0, 32); // File comment length
      cdh.writeUInt16LE(0, 34); // Disk number start
      cdh.writeUInt16LE(0, 36); // Internal file attributes
      cdh.writeUInt32LE(0, 38); // External file attributes
      cdh.writeUInt32LE(entry.offset, 42); // Relative offset of local header
      entry.nameBuf.copy(cdh, 46);

      await writeChunkWithBackpressure(this.stream, cdh);
      cdTotalBytes += cdh.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // End of central directory signature
    eocd.writeUInt16LE(0, 4); // Number of this disk
    eocd.writeUInt16LE(0, 6); // Disk where central directory starts
    eocd.writeUInt16LE(this.entries.length, 8); // Number of central directory records on this disk
    eocd.writeUInt16LE(this.entries.length, 10); // Total number of central directory records
    eocd.writeUInt32LE(cdTotalBytes, 12); // Size of central directory (bytes)
    eocd.writeUInt32LE(cdStartOffset, 16); // Offset of start of central directory
    eocd.writeUInt16LE(0, 20); // Comment length

    await writeChunkWithBackpressure(this.stream, eocd);
  }
}

export interface ParsedZipEntry {
  filename: string;
  content: string;
}

/**
 * Parses a ZIP buffer produced by `ZipStreamWriter` (used in tests to verify streamed archive structure and contents).
 */
export function parseZipBuffer(zipBuf: Buffer): ParsedZipEntry[] {
  const results: ParsedZipEntry[] = [];
  let cursor = 0;

  while (cursor + 4 <= zipBuf.length) {
    const sig = zipBuf.readUInt32LE(cursor);
    if (sig !== 0x04034b50) {
      break;
    }
    const crcExpected = zipBuf.readUInt32LE(cursor + 14);
    const compressedSize = zipBuf.readUInt32LE(cursor + 18);
    const nameLen = zipBuf.readUInt16LE(cursor + 26);
    const extraLen = zipBuf.readUInt16LE(cursor + 28);

    const nameStart = cursor + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + compressedSize;

    const filename = zipBuf.subarray(nameStart, nameStart + nameLen).toString('utf8');
    const dataSlice = zipBuf.subarray(dataStart, dataEnd);
    const crcActual = computeCrc32(dataSlice);
    if (crcActual !== crcExpected) {
      throw new Error(`CRC32 mismatch for ${filename}`);
    }

    results.push({
      filename,
      content: dataSlice.toString('utf8'),
    });

    cursor = dataEnd;
  }

  return results;
}
