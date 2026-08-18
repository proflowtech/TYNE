/**
 * Retrieval index over function fingerprints.
 *
 * Semantic comparison is far too expensive to run all-pairs: a 2k-function
 * repo is 2M comparisons per review. The index turns that into a candidate
 * lookup — typically a few dozen comparisons per changed function — using
 * three complementary probes:
 *
 *   1. shapeHash bucket   — exact structural twins (renamed copies), O(1).
 *   2. rare API tokens    — functions sharing an unusual callee/literal.
 *   3. rare name concepts — functions sharing domain vocabulary.
 *
 * Probes 2 and 3 select by *rarity*, not frequency. Probing `prop:length`
 * would return the whole repo and cost more than it saves; probing
 * `call:createHmac` returns the three functions that actually matter. This is
 * the same instinct as IDF weighting in the scorer, applied to retrieval.
 *
 * The index is deliberately a plain in-memory structure with no VS Code or fs
 * dependency: today it is filled from the review's file window, and a
 * persistent workspace-wide index can fill the identical interface later
 * without touching the detector or the scorer.
 */

import type { FunctionFingerprint } from './fingerprint';
import type { IdfSource } from './similarity';

export interface CandidateOptions {
  /** Hard cap on returned candidates (cost control). */
  limit?: number;
  /** Exclude candidates from these files (e.g. the changed side itself). */
  excludeFiles?: Set<string>;
  /** Only consider tokens rarer than this share of the corpus as probes. */
  rarityCeiling?: number;
}

const DEFAULT_LIMIT = 60;
const DEFAULT_RARITY_CEILING = 0.12;
const PROBE_TOKENS_PER_KIND = 8;

export class FingerprintIndex implements IdfSource {
  private readonly byId = new Map<string, FunctionFingerprint>();
  private readonly byShapeHash = new Map<string, Set<string>>();
  private readonly byApiToken = new Map<string, Set<string>>();
  private readonly byNameToken = new Map<string, Set<string>>();
  /** Document frequency across both vocabularies — feeds IDF weighting. */
  private readonly df = new Map<string, number>();
  /** Method names declared on interfaces/abstract classes anywhere in scope. */
  private readonly contractNames = new Set<string>();

  get size(): number {
    return this.byId.size;
  }

  /**
   * Register interface/abstract method names. Same-named implementations of
   * these are expected to resemble each other, so the detector must not read
   * that resemblance as duplication.
   */
  addContractNames(names: Iterable<string>): void {
    for (const name of names) this.contractNames.add(name);
  }

  isContractName(name: string): boolean {
    return this.contractNames.has(name);
  }

  get totalDocs(): number {
    return this.byId.size;
  }

  documentFrequency(token: string): number {
    return this.df.get(token) || 0;
  }

  add(fp: FunctionFingerprint): void {
    if (this.byId.has(fp.id)) return;
    this.byId.set(fp.id, fp);

    bucket(this.byShapeHash, fp.shapeHash).add(fp.id);
    for (const token of fp.apiTokens.keys()) {
      bucket(this.byApiToken, token).add(fp.id);
      this.df.set(token, (this.df.get(token) || 0) + 1);
    }
    for (const token of fp.nameTokens.keys()) {
      bucket(this.byNameToken, token).add(fp.id);
      this.df.set(token, (this.df.get(token) || 0) + 1);
    }
  }

  addAll(fps: Iterable<FunctionFingerprint>): void {
    for (const fp of fps) this.add(fp);
  }

  get(id: string): FunctionFingerprint | undefined {
    return this.byId.get(id);
  }

  all(): FunctionFingerprint[] {
    return [...this.byId.values()];
  }

  /**
   * Candidates worth scoring against `query`, ordered by how many independent
   * probes selected them. Multi-probe agreement is a cheap prior: a function
   * that shares both a rare callee *and* domain vocabulary is far likelier to
   * survive scoring than one that shares either alone.
   */
  candidatesFor(query: FunctionFingerprint, options: CandidateOptions = {}): FunctionFingerprint[] {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const ceiling = options.rarityCeiling ?? DEFAULT_RARITY_CEILING;
    const maxDf = Math.max(2, Math.floor(this.totalDocs * ceiling));
    const hits = new Map<string, number>();

    const record = (ids: Set<string> | undefined, weight: number) => {
      if (!ids) return;
      for (const id of ids) {
        if (id === query.id) continue;
        hits.set(id, (hits.get(id) || 0) + weight);
      }
    };

    // Probe 1 — exact structural twins. Always worth 3: a shape-hash collision
    // is near-conclusive on its own.
    record(this.byShapeHash.get(query.shapeHash), 3);

    // Probes 2 & 3 — rarest tokens first.
    for (const token of this.rarestTokens(query.apiTokens.keys(), maxDf)) {
      record(this.byApiToken.get(token), 2);
    }
    for (const token of this.rarestTokens(query.nameTokens.keys(), maxDf)) {
      record(this.byNameToken.get(token), 1);
    }

    const exclude = options.excludeFiles;
    return [...hits.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => this.byId.get(id))
      .filter((fp): fp is FunctionFingerprint => {
        if (!fp) return false;
        if (exclude?.has(fp.file)) return false;
        return true;
      })
      .slice(0, limit);
  }

  private rarestTokens(tokens: Iterable<string>, maxDf: number): string[] {
    const scored: Array<{ token: string; df: number }> = [];
    for (const token of tokens) {
      const df = this.df.get(token) || 0;
      if (df === 0 || df > maxDf) continue;
      scored.push({ token, df });
    }
    scored.sort((a, b) => a.df - b.df);
    return scored.slice(0, PROBE_TOKENS_PER_KIND).map(s => s.token);
  }
}

function bucket(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  return set;
}
