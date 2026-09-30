import { describe, expect, it } from 'vitest';
import { auditSeedManifest } from './audit.js';
import { catalogSeedV1 } from './catalog-v1.js';
import { phase06CorpusV1 } from './phase06-corpus.js';
import { phase06QueryEvaluationV1 } from './phase06-evaluation.js';

describe('curated seed provenance', () => {
  it('passes the deterministic provenance and scope audit', () => {
    const result = auditSeedManifest();
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ valid: true, providerCount: 12, claimCount: 24 });
    expect(result.manifestHash).toHaveLength(64);
  });

  it('rejects publisher evidence relabeled as independent', () => {
    const manifest = structuredClone(catalogSeedV1);
    manifest.providers[0]!.claims[0]!.evidence.independence = 'independent';
    expect(auditSeedManifest(manifest).errors.join(' ')).toMatch(/launders publisher evidence/i);
  });

  it('retains the named self-dogfood candidates as source-backed proposed knowledge', () => {
    const expected = [
      'build-web-apps',
      'chisle',
      'codex-hooks',
      'codex-skills',
      'codex-subagents',
      'composio',
      'gitnexus',
      'litellm-gateway',
      'openai-agents-sdk',
      'ponytail',
      'reticle',
      'superpowers',
    ];
    const selected = phase06CorpusV1.filter((record) => expected.includes(record.key));
    expect(selected.map((record) => record.key).sort()).toEqual(expected);
    expect(new Set(phase06CorpusV1.map((record) => record.key)).size).toBe(phase06CorpusV1.length);
    expect(selected.every((record) => record.sourceUrl.startsWith('https://'))).toBe(true);
  });

  it('freezes a balanced, non-circular query evaluation set', () => {
    expect(phase06QueryEvaluationV1).toHaveLength(50);
    expect(new Set(phase06QueryEvaluationV1.map((item) => item.id)).size).toBe(50);
    expect(phase06QueryEvaluationV1.filter((item) => item.split === 'development')).toHaveLength(
      30,
    );
    expect(phase06QueryEvaluationV1.filter((item) => item.split === 'held_out')).toHaveLength(20);
    expect(
      phase06QueryEvaluationV1.every((item) => item.labelProducer === 'agent_proxy_2026-09-29'),
    ).toBe(true);
    expect(
      phase06QueryEvaluationV1.every(
        (item) =>
          item.acceptableCandidates.filter((candidate) =>
            item.prohibitedCandidates.includes(candidate),
          ).length === 0,
      ),
    ).toBe(true);
    expect(
      phase06QueryEvaluationV1.filter(
        (item) => item.expectedCoverage === 'outside_maintained_coverage',
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('casts a representative context-engineering net without upgrading leads to reviewed facts', () => {
    const contextLandscape = [
      'aider-repo-map',
      'agentpack',
      'caveman',
      'codex-context-compaction',
      'codex-memory-intelligence',
      'command-compressor-agent',
      'context-compress',
      'llmlingua',
      'openai-prompt-caching',
      'repomix',
      'rtk',
      'tokf',
    ];
    expect(phase06CorpusV1).toHaveLength(49);
    expect(
      phase06CorpusV1
        .filter((record) => contextLandscape.includes(record.key))
        .map(({ key }) => key),
    ).toHaveLength(contextLandscape.length);
  });
});
