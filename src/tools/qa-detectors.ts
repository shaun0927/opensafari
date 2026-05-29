import { MCPServer, getWebKitClient } from '../mcp-server';
import { ErrorCode, respondWithStructuredError } from '../errors';

export function registerQADetectorTools(server: MCPServer): void {
  const detectors = [
    { name: 'qa_auto_zoom', desc: 'Detect inputs triggering iOS auto-zoom', mod: 'auto-zoom', fn: 'detectAutoZoom' },
    { name: 'qa_touch_targets', desc: 'Find elements below 44x44px', mod: 'touch-targets', fn: 'detectTouchTargets' },
    { name: 'qa_hover_only', desc: 'Find hover-only interactions', mod: 'hover-only', fn: 'detectHoverOnly' },
    { name: 'qa_input_type', desc: 'Validate input type/inputMode', mod: 'input-type', fn: 'detectInputType' },
    { name: 'qa_safe_area', desc: 'Check content behind notch', mod: 'safe-area', fn: 'detectSafeArea' },
    { name: 'qa_keyboard_overlap', desc: 'Detect fixed elements hidden by keyboard', mod: 'keyboard-overlap', fn: 'detectKeyboardOverlap' },
    { name: 'qa_horizontal_overflow', desc: 'Find horizontal scroll causes', mod: 'horizontal-overflow', fn: 'detectHorizontalOverflow' },
    { name: 'qa_100vh', desc: 'Detect 100vh inconsistency', mod: 'vh100', fn: 'detect100vh' },
    { name: 'qa_fixed_stacking', desc: 'Find z-index conflicts', mod: 'fixed-stacking', fn: 'detectFixedStacking' },
    { name: 'qa_scroll_lock', desc: 'Verify body scroll restored', mod: 'scroll-lock', fn: 'detectScrollLock' },
    { name: 'qa_dark_mode', desc: 'Compare light vs dark mode', mod: 'dark-mode', fn: 'detectDarkMode' },
    { name: 'qa_orientation', desc: 'Check layout on rotation', mod: 'orientation', fn: 'detectOrientation' },
    { name: 'qa_pwa_meta', desc: 'Validate PWA meta tags', mod: 'pwa-meta', fn: 'detectPwaMeta' },
  ];

  for (const det of detectors) {
    server.registerTool(
      {
        name: det.name,
        description: det.desc,
        inputSchema: { type: 'object' as const, properties: {} },
      },
      async (_sessionId: string, _params: Record<string, unknown>) => {
        const client = getWebKitClient();
        if (!client) return respondWithStructuredError(ErrorCode.BACKEND_NOT_CONNECTED, 'Safari not connected');
        try {
          // Dynamic import for the detector
          const mod = await import(`../qa/detectors/${det.mod}.js`);
          const result = await mod[det.fn](client);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return respondWithStructuredError(ErrorCode.APP_STATE_UNKNOWN, `Error running ${det.name}: ${message}`);
        }
      },
    );
  }
}
