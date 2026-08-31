import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

export class LocalDocumentStorage {
  constructor(directory = '.data/knowledge') {
    this.directory = directory;
  }

  async save(filename, text) {
    await mkdir(this.directory, { recursive: true });
    const key = `${randomUUID()}-${filename.replace(/[^a-z0-9._-]/gi, '_')}`;
    await writeFile(join(this.directory, key), text);
    return key;
  }
}

export class S3DocumentStorage {
  constructor({ region, endpoint, credentials, bucket }) {
    this.bucket = bucket;
    this.client = new S3Client({ region, endpoint, credentials });
  }

  async save(filename, text) {
    const key = `${randomUUID()}-${filename.replace(/[^a-z0-9._-]/gi, '_')}`;
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: text,
      ContentType: 'text/plain',
    }));
    return key;
  }

  async load(key) {
    const { Body } = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
    return Body.transformToString();
  }
}
