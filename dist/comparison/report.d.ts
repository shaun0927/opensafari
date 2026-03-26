import { ViewportCapture } from './cross-viewport';
export declare function generateMarkdownReport(captures: ViewportCapture[], url: string): string;
export interface MCPContent {
    type: 'text' | 'image';
    text?: string;
    data?: string;
    mimeType?: string;
}
export declare function formatForClaudeVision(captures: ViewportCapture[]): MCPContent[];
//# sourceMappingURL=report.d.ts.map