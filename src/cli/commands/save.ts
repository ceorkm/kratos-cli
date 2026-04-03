import { getScopedMemoryDb, type CLIContext } from '../core.js';
import { Output } from '../output.js';

export async function saveCommand(ctx: CLIContext, text: string, opts: {
  tags?: string;
  paths?: string;
  importance?: string;
  compress?: boolean;
  json?: boolean;
  global?: boolean;
}): Promise<void> {
  const memoryDb = getScopedMemoryDb(ctx, opts);
  const scope = memoryDb.getScope();
  const tags = opts.tags ? opts.tags.split(',').map(t => t.trim()) : [];
  const paths = opts.paths ? opts.paths.split(',').map(p => p.trim()) : [];
  const importance = opts.importance ? parseInt(opts.importance, 10) : 3;

  let summary = text.substring(0, 200);
  let fullText = text;
  const piiDetector = await ctx.getPIIDetector();
  const scanResult = piiDetector.detect(text);

  // If compress flag is set, use rule-based compression (pure logic, no AI)
  if (opts.compress) {
    try {
      const { createCompressor } = await import('../../compression/factory.js');
      const compressor = createCompressor();
      const result = await compressor.compress(text);
      summary = result.summary;
      Output.dim(`Compressed: ${result.original_length} → ${result.compressed_length} chars (${Math.round(result.compression_ratio * 100)}% reduction)`);
    } catch {
      Output.warn('Compression failed, using raw text');
    }
  }

  const result = memoryDb.save({
    summary,
    text: fullText,
    tags,
    paths,
    importance,
  });

  const id = (result as any).id;

  if (opts.json) {
    Output.json({
      ok: true,
      id,
      scope,
      project: ctx.project.name,
      summary,
      text: fullText,
      tags,
      paths,
      importance,
      compressed: !!opts.compress,
      warning: scanResult.hasPII || scanResult.hasSecrets ? {
        has_pii: scanResult.hasPII,
        has_secrets: scanResult.hasSecrets,
        findings: scanResult.findings,
      } : null,
    });
    return;
  }

  if (scanResult.hasPII || scanResult.hasSecrets) {
    const warningMessage = scope === 'global'
      ? 'PII or secrets detected. Global memories are visible across ALL projects. Saving anyway.'
      : 'PII or secrets detected in memory text. Saving anyway.';
    Output.warn(warningMessage);
    for (const finding of scanResult.findings) {
      Output.dim(`  - ${finding.pattern} (${finding.type}, confidence: ${finding.confidence}) -> ${finding.redacted}`);
    }
  }

  Output.success(`Memory saved: ${id}`);
  Output.dim(`${scope === 'global' ? 'Scope: global' : `Project: ${ctx.project.name}`} | Tags: ${tags.join(', ') || 'none'} | Importance: ${importance}`);
}
