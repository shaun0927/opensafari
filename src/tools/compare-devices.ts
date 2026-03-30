import { MCPServer } from '../mcp-server';
import { VisualDiffEngine, PairwiseComparisonMatrix } from '../comparison/visual-diff';
import { DOMDiffEngine, DOMDiffResult, DOMSnapshot, DOM_SNAPSHOT_SCRIPT } from '../comparison/dom-diff';

let capturer: any = null;
let batchExecutor: any = null;

export function setCompareDevicesCapture(c: any): void { capturer = c; }
export function setCompareDevicesBatchExecutor(b: any): void { batchExecutor = b; }

/**
 * Build a text summary of visual comparison results.
 */
function buildVisualSummary(matrix: PairwiseComparisonMatrix): string {
  const lines: string[] = [
    `## Visual Comparison Results`,
    '',
    `**Devices:** ${matrix.devices.join(', ')}`,
    `**Threshold:** ${(matrix.threshold * 100).toFixed(1)}%`,
    `**Total pairs:** ${matrix.results.length}`,
    `**Flagged pairs:** ${matrix.flaggedPairs.length}`,
    '',
  ];

  // Similarity matrix
  lines.push('### Pairwise Similarity');
  lines.push('');
  for (const result of matrix.results) {
    const status = result.similarity >= matrix.threshold ? 'PASS' : 'FAIL';
    lines.push(
      `- ${result.deviceA} vs ${result.deviceB}: ${(result.similarity * 100).toFixed(1)}% [${status}]`
    );
  }

  if (matrix.flaggedPairs.length > 0) {
    lines.push('');
    lines.push('### Flagged Pairs (below threshold)');
    lines.push('');
    for (const pair of matrix.flaggedPairs) {
      lines.push(`**${pair.deviceA} vs ${pair.deviceB}** — ${(pair.similarity * 100).toFixed(1)}% similarity`);
      lines.push(`  - Diff pixels: ${pair.diffPixelCount} / ${pair.totalPixels} (${pair.diffPercentage.toFixed(2)}%)`);
      lines.push(`  - Diff regions: ${pair.diffRegions.length}`);
      for (const region of pair.diffRegions) {
        lines.push(`    - Region at (${region.x}, ${region.y}) size ${region.width}x${region.height}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Build a text summary of DOM comparison results.
 */
function buildDOMSummary(domResults: DOMDiffResult[]): string {
  const lines: string[] = [
    '',
    '## DOM Structural Comparison',
    '',
  ];

  for (const result of domResults) {
    lines.push(`### ${result.deviceA} vs ${result.deviceB}`);
    lines.push(result.summary);
    lines.push('');

    if (result.differences.length > 0) {
      const highSev = result.differences.filter(d => d.severity === 'high');
      const medSev = result.differences.filter(d => d.severity === 'medium');
      const lowSev = result.differences.filter(d => d.severity === 'low');

      if (highSev.length > 0) {
        lines.push('**High severity:**');
        for (const diff of highSev) {
          lines.push(`- [${diff.type}] ${diff.description}`);
        }
      }
      if (medSev.length > 0) {
        lines.push('**Medium severity:**');
        for (const diff of medSev) {
          lines.push(`- [${diff.type}] ${diff.description}`);
        }
      }
      if (lowSev.length > 0) {
        lines.push('**Low severity:**');
        for (const diff of lowSev) {
          lines.push(`- [${diff.type}] ${diff.description}`);
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function registerCompareDevicesTool(server: MCPServer): void {
  server.registerTool(
    {
      name: 'compare_devices',
      description:
        'Compare the same page across multiple iOS simulators using pixel-level visual diff and structural DOM diff. ' +
        'Returns a similarity matrix, flagged pairs below threshold, diff overlay images, and DOM structural differences.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string',
            description: 'URL to load and compare across all devices',
          },
          devices: {
            type: 'array',
            items: { type: 'string' },
            description: 'Device names to compare (defaults to all booted simulators)',
          },
          threshold: {
            type: 'number',
            description: 'Minimum similarity threshold (0-1, default 0.95). Pairs below this are flagged.',
          },
          includeDOM: {
            type: 'boolean',
            description: 'Include structural DOM comparison (default true)',
          },
        },
        required: ['url'],
      },
    },
    async (_sessionId: string, params: Record<string, unknown>) => {
      if (!capturer) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Cross-viewport capture not initialized. Boot simulators first.' }],
          isError: true,
        };
      }

      const url = params.url as string;
      const threshold = (params.threshold as number | undefined) ?? 0.95;
      const includeDOM = (params.includeDOM as boolean | undefined) ?? true;

      try {
        // Step 1: Capture screenshots on all devices
        const captures = await capturer.capture(url);

        if (!captures || captures.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'Error: No captures returned. Are any simulators booted?' }],
            isError: true,
          };
        }

        // Filter by requested devices if specified
        let filteredCaptures = captures;
        const requestedDevices = params.devices as string[] | undefined;
        if (requestedDevices && requestedDevices.length > 0) {
          filteredCaptures = captures.filter((c: any) =>
            requestedDevices.some(d => c.device.toLowerCase().includes(d.toLowerCase()))
          );
          if (filteredCaptures.length === 0) {
            return {
              content: [{
                type: 'text' as const,
                text: `Error: None of the requested devices [${requestedDevices.join(', ')}] matched booted simulators. Available: ${captures.map((c: any) => c.device).join(', ')}`,
              }],
              isError: true,
            };
          }
        }

        if (filteredCaptures.length < 2) {
          return {
            content: [{
              type: 'text' as const,
              text: `Need at least 2 devices for comparison, but only ${filteredCaptures.length} available: ${filteredCaptures.map((c: any) => c.device).join(', ')}`,
            }],
            isError: true,
          };
        }

        // Step 2: Run visual diff
        const visualEngine = new VisualDiffEngine();
        const screenshots = filteredCaptures
          .filter((c: any) => c.screenshot && !c.error)
          .map((c: any) => ({ device: c.device, imageBase64: c.screenshot }));

        if (screenshots.length < 2) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: Only ${screenshots.length} device(s) returned valid screenshots. Need at least 2 for comparison.`,
            }],
            isError: true,
          };
        }

        const matrix = await visualEngine.compareAll(screenshots, {
          similarityThreshold: threshold,
          generateDiffImage: true,
        });

        // Step 3: Optionally run DOM diff
        let domResults: DOMDiffResult[] | null = null;
        if (includeDOM && batchExecutor) {
          try {
            const batchResults = await batchExecutor.batchExecute(DOM_SNAPSHOT_SCRIPT);

            // Build DOM snapshots from batch results
            let domSnapshots: DOMSnapshot[] = batchResults
              .filter((r: any) => r.result && !r.error)
              .map((r: any) => ({
                device: r.device,
                viewport: r.result.viewport ?? r.viewport,
                elements: r.result.elements ?? [],
              }));

            // Filter by requested devices if specified
            if (requestedDevices && requestedDevices.length > 0) {
              domSnapshots = domSnapshots.filter((s: DOMSnapshot) =>
                requestedDevices.some(d => s.device.toLowerCase().includes(d.toLowerCase()))
              );
            }

            if (domSnapshots.length >= 2) {
              const domEngine = new DOMDiffEngine();
              domResults = domEngine.compareAll(domSnapshots);
            }
          } catch (domErr) {
            console.error('[compare_devices] DOM snapshot failed:', domErr);
            // Continue without DOM diff - visual diff is still valuable
          }
        }

        // Step 4: Build MCP response content
        const content: Array<{ type: 'text' | 'image'; text?: string; data?: string; mimeType?: string }> = [];

        // Text summary
        const summary = buildVisualSummary(matrix);
        const domSummary = domResults ? buildDOMSummary(domResults) : '';
        content.push({
          type: 'text' as const,
          text: `# Cross-Device Comparison Report\n\n**URL:** ${url}\n**Compared:** ${matrix.devices.length} devices\n\n${summary}${domSummary}`,
        });

        // Diff overlay images for flagged pairs
        for (const pair of matrix.flaggedPairs) {
          if (pair.diffImageBase64) {
            content.push({
              type: 'text' as const,
              text: `--- Diff overlay: ${pair.deviceA} vs ${pair.deviceB} (${(pair.similarity * 100).toFixed(1)}% similar) ---`,
            });
            content.push({
              type: 'image' as const,
              data: pair.diffImageBase64,
              mimeType: 'image/png',
            });
          }
        }

        return { content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[compare_devices] Error:', message);
        return {
          content: [{ type: 'text' as const, text: `Error during cross-device comparison: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
