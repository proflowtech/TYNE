/**
 * Durable encrypted AXIOM / Validate & Review report vault on the developer machine.
 * Lives under ~/.tyne/ (outside the extension install dir) so history survives
 * update / disable / uninstall+reinstall. Not a replacement for cloud insert —
 * local reliability layer for the history list.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { TyneValidateReviewResult } from './validateReviewTypes';

const VAULT_DIR_NAME = 'axiom-reports';
const KEY_FILE_NAME = 'axiom-reports.key';
const ENC_EXT = '.json.enc';
const MAX_REPORTS = 100;
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

export interface AxiomReportVaultOptions {
  /** Override root (~/.tyne) for tests. */
  rootDir?: string;
}

function defaultRoot(): string {
  return path.join(os.homedir(), '.tyne');
}

function safeId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || `report_${Date.now()}`;
}

function ensureReportId(result: TyneValidateReviewResult): TyneValidateReviewResult {
  if (result.id && String(result.id).trim()) return result;
  const id = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `local_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  return { ...result, id };
}

export class AxiomReportVault {
  private readonly rootDir: string;
  private keyCache: Buffer | null = null;

  constructor(options: AxiomReportVaultOptions = {}) {
    this.rootDir = options.rootDir || defaultRoot();
  }

  vaultDir(): string {
    return path.join(this.rootDir, VAULT_DIR_NAME);
  }

  keyPath(): string {
    return path.join(this.rootDir, KEY_FILE_NAME);
  }

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.vaultDir(), { recursive: true });
  }

  private async loadOrCreateKey(): Promise<Buffer> {
    if (this.keyCache) return this.keyCache;
    await this.ensureDirs();
    const keyPath = this.keyPath();
    try {
      const raw = await fs.readFile(keyPath);
      if (raw.length === KEY_LENGTH) {
        this.keyCache = raw;
        return raw;
      }
    } catch {
      // create below
    }
    const key = crypto.randomBytes(KEY_LENGTH);
    await fs.writeFile(keyPath, key, { mode: 0o600 });
    try {
      await fs.chmod(keyPath, 0o600);
    } catch {
      // Windows may ignore mode
    }
    this.keyCache = key;
    return key;
  }

  private encrypt(plaintext: string, key: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // layout: iv(12) | tag(16) | ciphertext
    return Buffer.concat([iv, tag, enc]);
  }

  private decrypt(blob: Buffer, key: Buffer): string {
    if (blob.length < IV_LENGTH + 16 + 1) {
      throw new Error('ciphertext too short');
    }
    const iv = blob.subarray(0, IV_LENGTH);
    const tag = blob.subarray(IV_LENGTH, IV_LENGTH + 16);
    const data = blob.subarray(IV_LENGTH + 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  async saveReport(result: TyneValidateReviewResult): Promise<TyneValidateReviewResult> {
    const withId = ensureReportId(result);
    if (!withId.createdAt) {
      (withId as TyneValidateReviewResult).createdAt = new Date().toISOString();
    }
    const key = await this.loadOrCreateKey();
    await this.ensureDirs();
    const file = path.join(this.vaultDir(), `${safeId(String(withId.id))}${ENC_EXT}`);
    const payload = JSON.stringify(withId);
    await fs.writeFile(file, this.encrypt(payload, key), { mode: 0o600 });
    await this.trimToMax();
    return withId;
  }

  async getReport(id: string): Promise<TyneValidateReviewResult | null> {
    const key = await this.loadOrCreateKey();
    const file = path.join(this.vaultDir(), `${safeId(id)}${ENC_EXT}`);
    try {
      const blob = await fs.readFile(file);
      const parsed = JSON.parse(this.decrypt(blob, key)) as TyneValidateReviewResult;
      return parsed?.id ? parsed : null;
    } catch {
      return null;
    }
  }

  async listReports(limit = 50): Promise<TyneValidateReviewResult[]> {
    await this.ensureDirs();
    let names: string[] = [];
    try {
      names = (await fs.readdir(this.vaultDir())).filter(n => n.endsWith(ENC_EXT));
    } catch {
      return [];
    }
    const key = await this.loadOrCreateKey();
    const reports: TyneValidateReviewResult[] = [];
    for (const name of names) {
      try {
        const blob = await fs.readFile(path.join(this.vaultDir(), name));
        const parsed = JSON.parse(this.decrypt(blob, key)) as TyneValidateReviewResult;
        if (parsed && typeof parsed === 'object' && parsed.id) {
          reports.push(parsed);
        }
      } catch {
        // skip corrupt / wrong-key files
      }
    }
    reports.sort((a, b) => {
      const ta = Date.parse(String(a.createdAt || '')) || 0;
      const tb = Date.parse(String(b.createdAt || '')) || 0;
      return tb - ta;
    });
    return reports.slice(0, Math.max(1, limit));
  }

  private async trimToMax(): Promise<void> {
    let names: string[] = [];
    try {
      names = (await fs.readdir(this.vaultDir())).filter(n => n.endsWith(ENC_EXT));
    } catch {
      return;
    }
    if (names.length <= MAX_REPORTS) return;
    const withMtime: Array<{ name: string; mtime: number }> = [];
    for (const name of names) {
      try {
        const st = await fs.stat(path.join(this.vaultDir(), name));
        withMtime.push({ name, mtime: st.mtimeMs });
      } catch {
        withMtime.push({ name, mtime: 0 });
      }
    }
    withMtime.sort((a, b) => b.mtime - a.mtime);
    for (const drop of withMtime.slice(MAX_REPORTS)) {
      try {
        await fs.unlink(path.join(this.vaultDir(), drop.name));
      } catch {
        // ignore
      }
    }
  }
}

let defaultVault: AxiomReportVault | null = null;

export function getAxiomReportVault(options?: AxiomReportVaultOptions): AxiomReportVault {
  if (options?.rootDir) return new AxiomReportVault(options);
  if (!defaultVault) defaultVault = new AxiomReportVault();
  return defaultVault;
}

/** Merge local + cloud by id; newer createdAt wins; sort desc; limit. */
export function mergeAxiomReports(
  local: TyneValidateReviewResult[],
  cloud: TyneValidateReviewResult[],
  limit = 50,
): TyneValidateReviewResult[] {
  const byId = new Map<string, TyneValidateReviewResult>();
  const ingest = (list: TyneValidateReviewResult[]) => {
    for (const r of list || []) {
      if (!r || !r.id) continue;
      const id = String(r.id);
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, r);
        continue;
      }
      const tNew = Date.parse(String(r.createdAt || '')) || 0;
      const tOld = Date.parse(String(prev.createdAt || '')) || 0;
      if (tNew >= tOld) byId.set(id, r);
    }
  };
  // Local first so unsigned-in history is present; cloud may refresh same ids.
  ingest(local);
  ingest(cloud);
  return [...byId.values()]
    .sort((a, b) => {
      const ta = Date.parse(String(a.createdAt || '')) || 0;
      const tb = Date.parse(String(b.createdAt || '')) || 0;
      return tb - ta;
    })
    .slice(0, Math.max(1, limit));
}
