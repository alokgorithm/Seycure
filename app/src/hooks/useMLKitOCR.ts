import { registerPlugin } from '@capacitor/core';
import {
    loadCorrections,
    loadAppLayout,
    detectAppContext,
    type CorrectionRule,
} from './usePrivacyLearning';
import {
    classifyNumberContext,
    matchPatterns,
    redactGeneric,
    type OCRAction,
    type OCRSeverity,
} from '@/lib/detectionPatterns';

export type { OCRAction, OCRSeverity };

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

export interface ScreenshotFinding {
    /** Stable within one analysis run; used as the React key and toggle key. */
    id: string;
    type: string;
    value: string;
    redacted: string;
    severity: OCRSeverity;
    action: OCRAction;
    bbox: { x: number; y: number; width: number; height: number };
}

let findingIdCounter = 0;
function nextFindingId(): string {
    return `finding-${++findingIdCounter}`;
}

// ── Context Helpers ─────────────────────────────────────────────────────────

function getBlockContext(target: MLKitTextBlock, allBlocks: MLKitTextBlock[]): string {
    const contextBlocks = allBlocks.filter(b => {
        if (b === target) return false;

        const isAbove = b.bbox.y + b.bbox.height <= target.bbox.y + (target.bbox.height * 0.5);
        const isSameRowLeft = Math.abs(b.bbox.y - target.bbox.y) < target.bbox.height
            && b.bbox.x + b.bbox.width < target.bbox.x + (target.bbox.width * 0.5);
        const isSameRowRight = Math.abs(b.bbox.y - target.bbox.y) < target.bbox.height
            && b.bbox.x > target.bbox.x;

        return isAbove || isSameRowLeft || isSameRowRight;
    });

    contextBlocks.sort((a, b) => {
        const distA = Math.pow(target.bbox.x - (a.bbox.x + a.bbox.width), 2) + Math.pow(target.bbox.y - (a.bbox.y + a.bbox.height), 2);
        const distB = Math.pow(target.bbox.x - (b.bbox.x + b.bbox.width), 2) + Math.pow(target.bbox.y - (b.bbox.y + b.bbox.height), 2);
        return distA - distB;
    });

    return contextBlocks.slice(0, 5).map(b => b.text).join(' ').toLowerCase();
}

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
    const seenBboxes = new Set<string>();
    let detectedApp: string | null = null;

    // Helper to avoid duplicate bboxes overlapping
    const bboxKey = (b: { x: number; y: number; width: number; height: number }) =>
        `${Math.round(b.x)}_${Math.round(b.y)}_${Math.round(b.width)}_${Math.round(b.height)}`;

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
            if (!text || text.length < 2) continue;

            const normY = block.bbox.y / imgH;

            // ── Priority 1: User said NEVER blur this ──────────────────
            const matchedNever = matchCorrection(text, neverBlur);
            if (matchedNever) {
                seenValues.add(text);
                continue;
            }

            // ── Priority 2: User said ALWAYS blur this ─────────────────
            const matchedAlways = matchCorrection(text, alwaysBlur);
            if (matchedAlways) {
                seenValues.add(text);
                const key = bboxKey(block.bbox);
                if (!seenBboxes.has(key)) {
                    seenBboxes.add(key);
                    findings.push({
                        id: nextFindingId(),
                        type: `🧠 ${matchedAlways.label}`,
                        value: text,
                        redacted: redactGeneric(text),
                        severity: 'high',
                        action: 'blur',
                        bbox: block.bbox,
                    });
                }
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
                        const key = bboxKey(block.bbox);
                        if (!seenBboxes.has(key)) {
                            seenBboxes.add(key);
                            findings.push({
                                id: nextFindingId(),
                                type: `🧠 ${matchedRow.label}`,
                                value: text,
                                redacted: redactGeneric(text),
                                severity: 'high',
                                action: 'blur',
                                bbox: block.bbox,
                            });
                        }
                    }
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

                    const key = bboxKey(block.bbox);
                    if (!seenBboxes.has(key)) {
                        seenBboxes.add(key);
                        findings.push({
                            id: nextFindingId(),
                            type: classification.type,
                            value: text,
                            redacted,
                            // classifyNumberContext only ever blurs now, so
                            // this no longer varies.
                            severity: 'high',
                            action: classification.action,
                            bbox: block.bbox,
                        });
                    }
                }
            }
        }

        // ── Priority 4b: Built-in regex patterns ───────────────────────
        for (const block of result.blocks) {
            const context = getBlockContext(block, result.blocks);

            for (const match of matchPatterns(block.text, context)) {
                const cleanValue = match.value.replace(/[-.\s]/g, '');
                if (seenValues.has(cleanValue) || seenValues.has(match.value)) continue;

                seenValues.add(cleanValue);
                seenValues.add(match.value);

                const key = bboxKey(block.bbox);
                if (seenBboxes.has(key)) continue;
                seenBboxes.add(key);

                findings.push({
                    id: nextFindingId(),
                    type: match.type,
                    value: match.value,
                    redacted: match.redacted,
                    severity: match.severity,
                    action: match.action,
                    bbox: block.bbox,
                });
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
