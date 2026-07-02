import "./env";
import { promises as fs, createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Blob storage seam for attachments — same idea as the Provisioner seam: the rest of the
// backend only sees this interface, so swapping local disk for S3 (when the runtime moves off
// this box) is a drop-in. Keys are S3-shaped ("attachments/<uuid>") so objects can be copied
// over 1:1 at migration time.

export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  stream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  // Every stored key (GC sweep: catches files whose DB rows were removed by FK cascades).
  listKeys(prefix: string): Promise<string[]>;
}

// Local-disk implementation. Root defaults to <repo>/data/attachments (gitignored);
// override with ATTACHMENTS_DIR. A key maps to a file path under the root.
class LocalDiskStorage implements Storage {
  private readonly root: string;

  constructor() {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../");
    this.root = process.env.ATTACHMENTS_DIR ?? path.join(repoRoot, "data");
  }

  // Resolve a key inside the root, refusing traversal ("../") out of it.
  private pathFor(key: string): string {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error(`invalid storage key: ${key}`);
    }
    return p;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.pathFor(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
  }

  async stream(key: string): Promise<Readable> {
    const p = this.pathFor(key);
    await fs.access(p); // throw now (404able) rather than as a stream error mid-response
    return createReadStream(p);
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  async listKeys(prefix: string): Promise<string[]> {
    const dir = this.pathFor(prefix);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return []; // nothing stored yet
    }
    return names.map((n) => `${prefix}/${n}`);
  }
}

export const storage: Storage = new LocalDiskStorage();
