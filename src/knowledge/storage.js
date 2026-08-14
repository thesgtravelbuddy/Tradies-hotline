import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export class LocalDocumentStorage { constructor(directory = '.data/knowledge') { this.directory = directory; } async save(filename, text) { await mkdir(this.directory, { recursive: true }); const key = `${randomUUID()}-${filename.replace(/[^a-z0-9._-]/gi, '_')}`; await writeFile(join(this.directory, key), text); return key; } }
