import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '../contracts.js';

interface Envelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface EncryptedBufferOptions {
  directory: string;
  key?: Uint8Array;
  keyEnv?: string;
  env?: NodeJS.ProcessEnv;
}

export class EncryptedBuffer {
  private readonly key: Buffer;
  private initialized?: Promise<void>;

  public constructor(public readonly directory: string, options: Omit<EncryptedBufferOptions, 'directory'> = {}) {
    this.key = resolveKey(options);
  }

  public async write(relativePath: string, value: unknown): Promise<number> {
    await this.initialize();
    const target = this.resolve(relativePath);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const body = this.encrypt(path.basename(target), value);
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      await chmod(target, 0o600);
      await fsyncDirectory(path.dirname(target));
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return Buffer.byteLength(body);
  }

  public async read<T>(relativePath: string): Promise<T | undefined> {
    await this.initialize();
    const target = this.resolve(relativePath);
    let body: Buffer;
    try {
      body = await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return this.decrypt<T>(path.basename(target), body);
  }

  public async remove(relativePath: string): Promise<void> {
    await this.initialize();
    const target = this.resolve(relativePath);
    try {
      await unlink(target);
      await fsyncDirectory(path.dirname(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  public async list(relativeDirectory: string): Promise<string[]> {
    await this.initialize();
    const target = this.resolve(relativeDirectory);
    try {
      return (await readdir(target, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.enc'))
        .map((entry) => path.posix.join(relativeDirectory, entry.name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  public async size(relativePath: string): Promise<number> {
    try {
      return (await stat(this.resolve(relativePath))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  public async usage(): Promise<number> {
    await this.initialize();
    return directorySize(this.directory);
  }

  private initialize(): Promise<void> {
    this.initialized ??= mkdir(this.directory, { recursive: true, mode: 0o700 })
      .then(() => chmod(this.directory, 0o700));
    return this.initialized;
  }

  private resolve(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new DomainError('invalid_buffer_path', 'Buffer path must be relative.', 500);
    }
    const target = path.resolve(this.directory, relativePath);
    const relative = path.relative(this.directory, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new DomainError('invalid_buffer_path', 'Buffer path escaped its directory.', 500);
    }
    return target;
  }

  private encrypt(aad: string, value: unknown): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const plaintext = Buffer.from(JSON.stringify(value));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: Envelope = {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    return Buffer.from(JSON.stringify(envelope));
  }

  private decrypt<T>(aad: string, body: Buffer): T {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(body.toString('utf8')) as Envelope;
      if (envelope.version !== 1 || typeof envelope.iv !== 'string'
        || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') {
        throw new Error('invalid envelope');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8')) as T;
    } catch {
      throw new DomainError('outage_buffer_corrupt', 'Encrypted outage data could not be authenticated.', 500);
    }
  }
}

function resolveKey(options: Omit<EncryptedBufferOptions, 'directory'>): Buffer {
  if (options.key) {
    const key = Buffer.from(options.key);
    if (key.length !== 32) throw new Error('Outage encryption key must be exactly 32 bytes.');
    return key;
  }
  const envName = options.keyEnv ?? 'KIANCODE_OUTAGE_KEY';
  const encoded = (options.env ?? process.env)[envName];
  if (!encoded) throw new Error(`Missing outage encryption key environment variable ${envName}.`);
  const isHex = /^[a-f0-9]{64}$/i.test(encoded);
  if (!isHex && !/^[A-Za-z0-9+/]{43}=$|^[A-Za-z0-9+/]{42}==$/.test(encoded)) {
    throw new Error('Outage encryption key must be 64 hexadecimal characters or canonical base64.');
  }
  const key = isHex ? Buffer.from(encoded, 'hex') : Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('Outage encryption key must decode to exactly 32 bytes.');
  return key;
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    await handle.close();
  }
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}
