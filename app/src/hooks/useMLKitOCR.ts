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

/**
 * Classify a number based on its surrounding context.
 * NOW: Default is to BLUR (sensitive). Only mark as 'info' if STRONG safe context.
 */
function classifyNumberContext(text: string, context: string): { type: string, action: OCRAction } | null {
    const cleanDigits = text.replace(/\D/g, '');

    // 10-digit numbers
    if (cleanDigits.length === 10) {
        // Only skip if VERY strong transaction/order context
        if (/(pnr|booking\s*id|order\s*id|tracking|shipment|flight|seat)/i.test(context)) {
            return { type: 'Reference ID', action: 'info' };
        }
        // Everything else: treat as phone number (blur it)
        return { type: 'Phone Number', action: 'blur' };
    }

    // 11-digit numbers
    if (cleanDigits.length === 11) {
        if (/(ifsc|branch)/i.test(context)) {
            return { type: 'IFSC Code', action: 'blur' };
        }
        return { type: 'Account / ID Number', action: 'blur' };
    }

    // 12-digit numbers — very likely Aadhaar or sensitive
    if (cleanDigits.length === 12) {
        return { type: 'Aadhaar / 12-Digit ID', action: 'blur' };
    }

    // 13-19 digit numbers
    if (cleanDigits.length >= 13 && cleanDigits.length <= 19) {
        if (/(account|acct|a\/c|card|credit|debit|bank)/i.test(context)) {
            return { type: 'Account / Card Number', action: 'blur' };
        }
        // Only mark safe if very specific order/transaction context
        if (/(transaction\s*id|txn\s*id|order\s*no|receipt\s*no|invoice\s*no)/i.test(context)) {
            return { type: 'Transaction ID', action: 'info' };
        }
        // Default: blur it — could be bank account, card, etc.
        return { type: 'Long Number (Sensitive)', action: 'blur' };
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
    contextRequired?: RegExp; // Only trigger if context matches
}

const OCR_PATTERNS: OCRPattern[] = [
    // ── Identity Documents ─────────────────────────────────────────────
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
        type: 'Passport Number',
        severity: 'critical',
        action: 'blur',
        regex: /\b[A-Z][0-9]{7}\b/g,
        redact: (m: string) => `${m.slice(0, 2)}*****${m.slice(-1)}`,
        contextRequired: /passport|travel|visa|immigration|mrz/i,
    },
    {
        type: 'Voter ID / EPIC',
        severity: 'critical',
        action: 'blur',
        regex: /\b[A-Z]{3}\d{7}\b/g,
        redact: (m: string) => `${m.slice(0, 3)}****${m.slice(-3)}`,
        contextRequired: /voter|epic|election|electoral/i,
    },
    {
        type: 'Driving License',
        severity: 'critical',
        action: 'blur',
        regex: /\b[A-Z]{2}[0-9]{2}\s?[0-9]{4}\s?[0-9]{7}\b/g,
        redact: (m: string) => `${m.slice(0, 4)}*******${m.slice(-3)}`,
    },

    // ── Financial ──────────────────────────────────────────────────────
    {
        type: 'Credit/Debit Card',
        severity: 'critical',
        action: 'blur',
        regex: /\b(?:4\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}|5[1-5]\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}|3[47]\d{2}[\s-]?\d{6}[\s-]?\d{5}|(?:60|65|81|82)\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g,
        redact: (m: string) => {
            const num = m.replace(/[\s-]/g, '');
            return `****-****-****-${num.slice(-4)}`;
        },
    },
    {
        type: 'UPI / Payment ID',
        severity: 'critical',
        action: 'blur',
        regex: /\b[a-zA-Z0-9._-]+@(?:[a-zA-Z]{2,}(?:bank|upi|apl|axl|okhdfcbank|okaxis|okicici|oksbi|paytm|ybl|ibl|fbl|axisbank|sbi|hdfcbank|icici|kotak|unionbank|boi|cnrb|pnb|canara|bob|dbs|federal|indus|kvb|rbl|tjsb|ujjivan|aubank|jio|slice|fi|cred|amazon|gpay|phonepe|bharatpe))\b/gi,
        redact: (m: string) => {
            const parts = m.split('@');
            return `***@${parts[1]}`;
        },
    },
    {
        type: 'IFSC Code',
        severity: 'high',
        action: 'blur',
        regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
        redact: (m: string) => `${m.slice(0, 4)}0******`,
    },
    {
        type: 'Bank Account Number',
        severity: 'critical',
        action: 'blur',
        regex: /\b\d{9,18}\b/g,
        redact: (m: string) => `*****${m.slice(-4)}`,
        contextRequired: /account|acct|a\/c|bank|savings|current|deposit/i,
    },
    {
        type: 'CVV / CVC',
        severity: 'critical',
        action: 'blur',
        regex: /\b\d{3,4}\b/g,
        redact: () => '***',
        contextRequired: /cvv|cvc|security\s*code|card\s*verification/i,
    },

    // ── Contact Information ────────────────────────────────────────────
    {
        type: 'Email Address',
        severity: 'high',
        action: 'blur',
        regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
        redact: (m: string) => {
            const [user, domain] = m.split('@');
            return `${user.slice(0, 2)}***@${domain}`;
        },
    },
    {
        type: 'Phone Number',
        severity: 'high',
        action: 'blur',
        regex: /(?:\+91[\s-]?)?(?:\(?0?\d{2,5}\)?[\s-]?)?\d{5,6}[\s-]?\d{4,5}\b/g,
        redact: (m: string) => {
            const digits = m.replace(/\D/g, '');
            if (digits.length < 7) return m; // too short, not a phone
            return `***${digits.slice(-4)}`;
        },
    },
    {
        type: 'Phone (with label)',
        severity: 'high',
        action: 'blur',
        regex: /(?:(?:ph|phone|mobile|mob|cell|tel|contact|call|whatsapp|wa)[\s.:#+~-]*)\+?[\d\s()-]{7,15}/gi,
        redact: (m: string) => {
            const digits = m.replace(/\D/g, '');
            return `***${digits.slice(-4)}`;
        },
    },

    // ── Personal Information ───────────────────────────────────────────
    {
        type: 'Date of Birth',
        severity: 'high',
        action: 'blur',
        regex: /\b(?:\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2})\b/g,
        redact: () => '**/**/****',
        contextRequired: /dob|d\.o\.b|date\s*of\s*birth|birth\s*date|born|birthday|age/i,
    },
    {
        type: 'Date (Sensitive)',
        severity: 'medium',
        action: 'blur',
        regex: /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/g,
        redact: () => '**/**/****',
        contextRequired: /expiry|exp|valid|issue|issued|validity/i,
    },
    {
        type: 'PIN Code',
        severity: 'high',
        action: 'blur',
        regex: /\b\d{4,6}\b/g,
        redact: () => '****',
        contextRequired: /pin|passcode|otp|code|mpin|upi\s*pin|atm\s*pin|security/i,
    },
    {
        type: 'Password',
        severity: 'critical',
        action: 'blur',
        regex: /(?:(?:password|passwd|pwd|pass)[\s.:=~-]*)\S+/gi,
        redact: () => 'Password: ********',
    },
    {
        type: 'Address',
        severity: 'high',
        action: 'blur',
        regex: /\b(?:house|flat|plot|door|bldg|building|floor|street|road|lane|nagar|colony|sector|block|village|vill|dist|district|taluk|tehsil|mandal|po|post\s*office)[\s.:,#-]*[a-zA-Z0-9\s,.-]{5,60}/gi,
        redact: () => '[Address Redacted]',
    },

    // ── Form-Aware Labeled Fields ──────────────────────────────────────
    // These catch "Label: Value" patterns common in forms and documents
    {
        type: 'Named Field',
        severity: 'high',
        action: 'blur',
        regex: /(?:(?:name|father(?:'s)?\s*name|mother(?:'s)?\s*name|husband(?:'s)?\s*name|spouse|guardian|s\/o|d\/o|w\/o|c\/o)[\s.:=~-]+)[a-zA-Z\s.]{2,40}/gi,
        redact: (m: string) => {
            const label = m.match(/^[a-zA-Z/'()\s]+[\s.:=~-]+/)?.[0] || '';
            return `${label}[REDACTED]`;
        },
    },
    {
        type: 'Enrollment / Registration No',
        severity: 'high',
        action: 'blur',
        regex: /(?:(?:enrollment|enrolment|registration|reg|roll|admission|application|reference|ref|sr|serial|sl|case|file|policy|claim|member|employee|emp|id)[\s.:=#-]*(?:no|num|number)?[\s.:=#-]*)[A-Z0-9\-/]{4,20}/gi,
        redact: (m: string) => {
            const label = m.match(/^[a-zA-Z\s.:=#/-]+/)?.[0] || '';
            return `${label}*****`;
        },
    },
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
        }

        // ── Priority 4b: Built-in regex patterns ───────────────────────
        for (const block of result.blocks) {
            const blockText = block.text;
            const context = getBlockContext(block, result.blocks);

            for (const pattern of OCR_PATTERNS) {
                // If pattern needs context, check context first
                if (pattern.contextRequired && !pattern.contextRequired.test(context) && !pattern.contextRequired.test(blockText)) {
                    continue;
                }

                pattern.regex.lastIndex = 0;
                let match: RegExpExecArray | null;

                while ((match = pattern.regex.exec(blockText)) !== null) {
                    const value = match[0];
                    const cleanValue = value.replace(/[-.\s]/g, '');

                    if (seenValues.has(cleanValue) || seenValues.has(value)) continue;

                    // Skip very short matches (3-4 digits) unless they have context
                    if (cleanValue.replace(/\D/g, '').length <= 4 && !pattern.contextRequired) continue;

                    // For phone regex — require minimum 7 digits
                    if (pattern.type === 'Phone Number') {
                        const digits = cleanValue.replace(/\D/g, '');
                        if (digits.length < 7) continue;
                    }

                    seenValues.add(cleanValue);
                    seenValues.add(value);

                    const key = bboxKey(block.bbox);
                    if (!seenBboxes.has(key)) {
                        seenBboxes.add(key);
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
