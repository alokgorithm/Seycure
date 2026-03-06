import { registerPlugin } from '@capacitor/core';
import {
    loadCorrections,
    loadAppLayout,
    detectAppContext,
    type CorrectionRule,
} from './usePrivacyLearning';

// ── Native Plugin Interface ─────────────────────────────────────────────────

export interface MLKitTextBlock {
    text: string;
    bbox: { x: number; y: number; width: number; height: number };
}

interface MLKitTextResult {
    text: string;
    blocks: MLKitTextBlock[];
}

interface MLKitTextPlugin {
    analyzeImage(options: { base64: string }): Promise<MLKitTextResult>;
}

const MLKitText = registerPlugin<MLKitTextPlugin>('MLKitText');

// ── OCR Detection Types ─────────────────────────────────────────────────────

export type OCRSeverity = 'critical' | 'high' | 'medium';
export type OCRAction = 'blur' | 'info';

export interface ScreenshotFinding {
    type: string;
    value: string;
    redacted: string;
    severity: OCRSeverity;
    action: OCRAction;
    bbox: { x: number; y: number; width: number; height: number };
}

// ── Context Helpers ─────────────────────────────────────────────────────────

function getBlockContext(target: MLKitTextBlock, allBlocks: MLKitTextBlock[]): string {
    const contextBlocks = allBlocks.filter(b => {
        if (b === target) return false;

        const isAbove = b.bbox.y + b.bbox.height <= target.bbox.y + (target.bbox.height * 0.5);
        const isSameRowLeft = Math.abs(b.bbox.y - target.bbox.y) < target.bbox.height
            && b.bbox.x + b.bbox.width < target.bbox.x + (target.bbox.width * 0.5);

        return isAbove || isSameRowLeft;
    });

    contextBlocks.sort((a, b) => {
        const distA = Math.pow(target.bbox.x - (a.bbox.x + a.bbox.width), 2) + Math.pow(target.bbox.y - (a.bbox.y + a.bbox.height), 2);
        const distB = Math.pow(target.bbox.x - (b.bbox.x + b.bbox.width), 2) + Math.pow(target.bbox.y - (b.bbox.y + b.bbox.height), 2);
        return distA - distB;
    });

    return contextBlocks.slice(0, 3).map(b => b.text).join(' ').toLowerCase();
}

function classifyNumberContext(text: string, context: string): { type: string, action: OCRAction } | null {
    if (/^\d{10}$/.test(text.replace(/\D/g, ''))) {
        if (/(phone|mobile|call|contact|tel|no|\+91)/i.test(context)) {
            return { type: 'Phone Number', action: 'blur' };
        }
        if (/(pnr|transaction|txn|order|ref|invoice|id)/i.test(context)) {
            return { type: 'Reference / Order ID', action: 'info' };
        }
        return { type: 'Possible Phone', action: 'blur' };
    }

    if (/^\d{11,19}$/.test(text.replace(/\D/g, ''))) {
        if (/(account|acct|a\/c|card|credit|debit)/i.test(context)) {
            return { type: 'Account / Card Number', action: 'blur' };
        }
        if (/(transaction|txn|order|ref|invoice|id|receipt)/i.test(context)) {
            return { type: 'Transaction ID', action: 'info' };
        }
        return { type: 'Reference Number', action: 'info' };
    }

    return null;
}

// ── Built-in Pattern Rules ──────────────────────────────────────────────────

interface OCRPattern {
    type: string;
    severity: OCRSeverity;
    action: OCRAction;
    regex: RegExp;
    redact: (match: string) => string;
}

const OCR_PATTERNS: OCRPattern[] = [
    {
        type: 'Aadhaar Number',
        severity: 'critical',
        action: 'blur',
        regex: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
        redact: (m: string) => {
            const digits = m.replace(/\s/g, '');
            return `XXXX XXXX ${digits.slice(-4)}`;
        },
    },
    {
        type: 'PAN Card Number',
        severity: 'critical',
        action: 'blur',
        regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
        redact: (m: string) => `${m.slice(0, 2)}***${m.slice(5, 8)}*${m.slice(-1)}`,
    },
    {
        type: 'Credit/Debit Card Number',
        severity: 'critical',
        action: 'blur',
        regex: /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|(?:60|65|81|82)\d{14})\b/g,
        redact: (m: string) => {
            const num = m.replace(/[ -]/g, '');
            return `****-****-****-${num.slice(-4)}`;
        },
    },
    {
        type: 'UPI / Payment ID',
        severity: 'critical',
        action: 'blur',
        regex: /\b[a-zA-Z0-9._-]+@[a-zA-Z]{2,}(bank|upi|apl|axl|okhdfcbank|okaxis|okicici|oksbi|paytm|ybl|ibl)\b/gi,
        redact: (m: string) => {
            const parts = m.split('@');
            return `***@${parts[1]}`;
        },
    },
    {
        type: 'Email Address',
        severity: 'high',
        action: 'blur',
        regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
        redact: (m: string) => {
            const [user, domain] = m.split('@');
            return `${user.slice(0, 2)}***@${domain}`;
        },
    }
];

// ── Analysis Function (with Learning) ───────────────────────────────────────

export interface AnalysisResult {
    findings: ScreenshotFinding[];
    appContext: string | null;
    imageHeight: number;
}

export async function analyzeScreenshot(
    base64: string,
    imageHeight?: number
): Promise<AnalysisResult> {
    const findings: ScreenshotFinding[] = [];
    const seenValues = new Set<string>();
    let detectedApp: string | null = null;

    try {
        const result = await MLKitText.analyzeImage({ base64 });

        if (!result || !result.blocks || result.blocks.length === 0) {
            return { findings, appContext: null, imageHeight: imageHeight || 0 };
        }

        // Load learned data
        const corrections = await loadCorrections();
        const neverBlur = corrections.filter(c => c.type === 'never_blur');
        const alwaysBlur = corrections.filter(c => c.type === 'always_blur');

        // Detect which app this screenshot is from
        detectedApp = detectAppContext(result.blocks.map(b => b.text));
        const appLayout = await loadAppLayout(detectedApp);

        // Calculate image height from blocks if not provided
        const imgH = imageHeight || Math.max(...result.blocks.map(
            b => b.bbox.y + b.bbox.height
        ), 1);

        for (const block of result.blocks) {
            const text = block.text.trim();
            if (!text) continue;

            const normY = block.bbox.y / imgH;

            // ── Priority 1: User said NEVER blur this ──────────────────
            const matchedNever = matchCorrection(text, neverBlur);
            if (matchedNever) {
                // Don't add to findings at all — completely skip
                seenValues.add(text);
                continue;
            }

            // ── Priority 2: User said ALWAYS blur this ─────────────────
            const matchedAlways = matchCorrection(text, alwaysBlur);
            if (matchedAlways) {
                seenValues.add(text);
                findings.push({
                    type: `🧠 ${matchedAlways.label}`,
                    value: text,
                    redacted: redactGeneric(text),
                    severity: 'high',
                    action: 'blur',
                    bbox: block.bbox,
                });
                continue;
            }

            // ── Priority 3: App layout spatial memory ──────────────────
            if (appLayout) {
                const matchedRow = appLayout.rows.find(
                    r => Math.abs(r.position - normY) < 0.05 && r.confidence > 0.75
                );
                if (matchedRow) {
                    seenValues.add(text);
                    if (matchedRow.sensitive) {
                        findings.push({
                            type: `🧠 ${matchedRow.label}`,
                            value: text,
                            redacted: redactGeneric(text),
                            severity: 'high',
                            action: 'blur',
                            bbox: block.bbox,
                        });
                    }
                    // If not sensitive, skip silently (learned safe zone)
                    continue;
                }
            }
        }

        // ── Priority 4: Context-aware number classification ────────────
        for (const block of result.blocks) {
            const text = block.text.trim();
            const cleanText = text.replace(/[-.\s]/g, '');

            if (seenValues.has(text) || seenValues.has(cleanText)) continue;

            if (/^\+?\d{10,19}$/.test(cleanText)) {
                const context = getBlockContext(block, result.blocks);
                const classification = classifyNumberContext(cleanText, context);

                if (classification) {
                    seenValues.add(cleanText);
                    seenValues.add(text);

                    let redacted = '';
                    if (classification.action === 'blur') {
                        redacted = cleanText.length <= 12
                            ? `***${cleanText.slice(-4)}`
                            : `****-****-${cleanText.slice(-4)}`;
                    } else {
                        redacted = `...${cleanText.slice(-4)}`;
                    }

                    findings.push({
                        type: classification.type,
                        value: text,
                        redacted,
                        severity: classification.action === 'info' ? 'medium' : 'high',
                        action: classification.action,
                        bbox: block.bbox,
                    });
                }
            }
        }

        // ── Priority 4b: Built-in regex patterns ───────────────────────
        for (const block of result.blocks) {
            const blockText = block.text;

            for (const pattern of OCR_PATTERNS) {
                pattern.regex.lastIndex = 0;
                let match: RegExpExecArray | null;

                while ((match = pattern.regex.exec(blockText)) !== null) {
                    const value = match[0];
                    const cleanValue = value.replace(/[-.\s]/g, '');

                    if (seenValues.has(cleanValue) || seenValues.has(value)) continue;
                    seenValues.add(cleanValue);
                    seenValues.add(value);

                    findings.push({
                        type: pattern.type,
                        value,
                        redacted: pattern.redact(value),
                        severity: pattern.severity,
                        action: pattern.action,
                        bbox: block.bbox,
                    });
                }
            }
        }
    } catch (error) {
        console.error('ML Kit OCR error:', error);
        console.warn('ML Kit plugin not available. OCR requires a native Android build.');
    }

    // Sort: Blur Critical -> Blur High -> Info
    const orderScore = (f: ScreenshotFinding) => {
        let score = f.action === 'blur' ? 0 : 100;
        if (f.severity === 'critical') score += 1;
        else if (f.severity === 'high') score += 2;
        else score += 3;
        return score;
    };
    findings.sort((a, b) => orderScore(a) - orderScore(b));

    return { findings, appContext: detectedApp, imageHeight: imageHeight || 0 };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function matchCorrection(text: string, rules: CorrectionRule[]): CorrectionRule | null {
    for (const rule of rules) {
        try {
            if (new RegExp(rule.pattern).test(text)) return rule;
        } catch {
            // Invalid regex, skip
        }
    }
    return null;
}

function redactGeneric(text: string): string {
    const digits = text.replace(/\D/g, '');
    if (digits.length >= 4) return `***${digits.slice(-4)}`;
    return '****';
}

export { OCR_PATTERNS };

