/**
 * Sensitive-text detection patterns.
 *
 * Kept free of React, Capacitor and DOM imports so the same code that runs in
 * the app can be exercised by `npm run verify:patterns` in plain Node.
 */

export type OCRSeverity = 'critical' | 'high' | 'medium';
export type OCRAction = 'blur' | 'info';

export interface PatternMatch {
    type: string;
    value: string;
    redacted: string;
    severity: OCRSeverity;
    action: OCRAction;
    /**
     * Whether `type` is a claim we can stand behind. False means the label was
     * softened to GENERIC_NUMBER_TYPE. It never affects `action` - see the note
     * on resolveNumericType.
     */
    confident: boolean;
}

export interface OCRPattern {
    type: string;
    severity: OCRSeverity;
    action: OCRAction;
    regex: RegExp;
    redact: (match: string) => string;
    /** Only trigger when the surrounding text or the block itself matches. */
    contextRequired?: RegExp;
    /** Extra check on a candidate before it is accepted. */
    validate?: (match: string) => boolean;
    /** Digit-count bounds applied to the raw match. */
    minDigits?: number;
    maxDigits?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function digitsOf(text: string): string {
    return text.replace(/\D/g, '');
}

/** True when the match is nothing but digits and separators. */
function isNumericOnly(text: string): boolean {
    return /^[\d\s.\-()+]+$/.test(text);
}

/**
 * True for strings shaped like a date. Dates and phone numbers look alike
 * once the separators are stripped, so the phone patterns use this to step
 * aside and let the date patterns decide.
 */
function isDateLike(text: string): boolean {
    return /^\s*\d{1,4}[/\-.]\d{1,2}[/\-.]\d{2,4}\s*$/.test(text);
}

/** True for a dotted quad, which the phone patterns would otherwise swallow. */
function isIpLike(text: string): boolean {
    return /^\s*\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\s*$/.test(text);
}

export function redactGeneric(text: string): string {
    const digits = digitsOf(text);
    if (digits.length >= 4) return `***${digits.slice(-4)}`;
    return '****';
}

/** Expected total IBAN length per country. Used to reject look-alikes. */
const IBAN_LENGTHS: Record<string, number> = {
    AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
    BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28,
    EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
    GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
    IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20,
    LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30,
    NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22,
    SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23,
    TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

/** Structural check only: known country prefix and the right length. */
export function isIbanShaped(raw: string): boolean {
    const iban = raw.replace(/[\s-]/g, '').toUpperCase();
    const expected = IBAN_LENGTHS[iban.slice(0, 2)];
    return expected !== undefined && iban.length === expected;
}

/** Structural check plus the ISO 13616 mod-97 checksum. */
export function isValidIban(raw: string): boolean {
    if (!isIbanShaped(raw)) return false;
    const iban = raw.replace(/[\s-]/g, '').toUpperCase();
    const rearranged = iban.slice(4) + iban.slice(0, 4);

    let remainder = 0;
    for (const char of rearranged) {
        const chunk = char >= 'A' && char <= 'Z'
            ? String(char.charCodeAt(0) - 55)
            : char;
        for (const digit of chunk) {
            remainder = (remainder * 10 + Number(digit)) % 97;
        }
    }
    return remainder === 1;
}

// ── Aadhaar validation ──────────────────────────────────────────────────────

// Verhoeff multiplication, permutation and inverse tables. UIDAI numbers carry
// a Verhoeff check digit, which is what separates a real Aadhaar from any
// other twelve digits - a UPI transaction id, an order number, a meter
// reading. Without this check the shape alone is nearly meaningless.
const VERHOEFF_D = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const VERHOEFF_P = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff check over a digit string, checksum digit included. */
export function isValidVerhoeff(digits: string): boolean {
    if (!/^\d+$/.test(digits)) return false;

    let c = 0;
    const reversed = digits.split('').reverse();
    for (let i = 0; i < reversed.length; i++) {
        c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(reversed[i])]];
    }
    return c === 0;
}

/**
 * True only for twelve digits that could actually be issued as an Aadhaar:
 * UIDAI never allocates a number starting 0 or 1, and the last digit is a
 * Verhoeff checksum over the other eleven.
 */
export function isValidAadhaar(raw: string): boolean {
    const digits = digitsOf(raw);
    if (digits.length !== 12) return false;
    if (digits[0] === '0' || digits[0] === '1') return false;
    return isValidVerhoeff(digits);
}

// ── Label confidence ────────────────────────────────────────────────────────

/**
 * Shown whenever we are sure something is sensitive but not sure what it is.
 * A wrong confident label is worse than an honest vague one: it teaches the
 * user to distrust every label we print.
 */
export const GENERIC_NUMBER_TYPE = 'Sensitive Number';

/** Nearby wording that names a payment or order reference. */
const TRANSACTION_CONTEXT =
    /(transaction\s*(id|no|ref)|txn\s*(id|no)?|\butr\b|reference\s*(no|id|number)|\bref\s*(no|id)\b|order\s*(id|no)|payment\s*(id|ref)|upi\s*(ref|id|transaction)|receipt\s*no|invoice\s*no)/i;

/** Nearby wording that names an Aadhaar, including the Devanagari spelling. */
const AADHAAR_CONTEXT = /(aadhaar|aadhar|आधार|\buid\b|\buidai\b)/i;

/**
 * Decides what to call a numeric match.
 *
 * Precedence, highest first:
 *   1. Transaction wording nearby - the reported failure was a twelve-digit
 *      UPI reference confidently labelled "Aadhaar Number", and the words
 *      around it said exactly what it was.
 *   2. A number that passes Aadhaar validation.
 *   3. Anything else numeric - generic label.
 *
 * Aadhaar wording nearby is a strong hint but is not on its own enough to
 * print "Aadhaar Number": OCR mangles digits, so a genuine card can fail the
 * checksum, and a confident wrong label is the thing being fixed here. Such a
 * match still blurs, just under the generic name.
 *
 * This never touches `action`. Uncertainty changes what we call something, not
 * whether we hide it.
 */
export function resolveNumericType(
    value: string,
    fallbackType: string,
    context: string = ''
): { type: string; confident: boolean } {
    const digits = digitsOf(value);
    const haystack = `${context} ${value}`;

    if (TRANSACTION_CONTEXT.test(haystack)) {
        return { type: 'Transaction ID', confident: true };
    }

    if (digits.length === 12) {
        if (isValidAadhaar(digits)) {
            return { type: 'Aadhaar Number', confident: true };
        }
        return { type: GENERIC_NUMBER_TYPE, confident: false };
    }

    if (AADHAAR_CONTEXT.test(haystack) && isValidAadhaar(digits)) {
        return { type: 'Aadhaar Number', confident: true };
    }

    return { type: fallbackType, confident: true };
}

// ── Context-aware number classification ─────────────────────────────────────

/**
 * Classify a bare number using the text around it.
 * The default is to blur: a false positive costs one tap, a false negative
 * leaks an ID into a public post.
 */
export function classifyNumberContext(
    text: string,
    context: string
): { type: string; action: OCRAction } | null {
    const cleanDigits = digitsOf(text);

    // 10-digit numbers
    if (cleanDigits.length === 10) {
        // Only skip on strong travel/order context. Tracking numbers are NOT
        // safe: they expose delivery status and address to anyone who looks
        // them up, so they fall through to the blur branch below.
        if (/(pnr|booking\s*id|order\s*id|flight|seat)/i.test(context)) {
            return { type: 'Reference ID', action: 'info' };
        }
        return { type: 'Phone Number', action: 'blur' };
    }

    // 11-digit numbers
    if (cleanDigits.length === 11) {
        if (/(ifsc|branch)/i.test(context)) {
            return { type: 'IFSC Code', action: 'blur' };
        }
        return { type: GENERIC_NUMBER_TYPE, action: 'blur' };
    }

    // 12-digit numbers. Aadhaar-shaped, but so is a UPI reference, so the name
    // has to be earned by the checksum or by the wording around it.
    if (cleanDigits.length === 12) {
        const { type } = resolveNumericType(cleanDigits, GENERIC_NUMBER_TYPE, context);
        return { type, action: 'blur' };
    }

    // 13-19 digit numbers
    if (cleanDigits.length >= 13 && cleanDigits.length <= 19) {
        if (/(account|acct|a\/c|card|credit|debit|bank)/i.test(context)) {
            return { type: 'Account / Card Number', action: 'blur' };
        }
        if (/(transaction\s*id|txn\s*id|order\s*no|receipt\s*no|invoice\s*no)/i.test(context)) {
            return { type: 'Transaction ID', action: 'info' };
        }
        return { type: GENERIC_NUMBER_TYPE, action: 'blur' };
    }

    return null;
}

// ── Built-in pattern rules ──────────────────────────────────────────────────

export const OCR_PATTERNS: OCRPattern[] = [
    // ── Cards ──────────────────────────────────────────────────────────
    // Kept first: a space-grouped 16-digit card also satisfies the Aadhaar
    // shape, and the card label is the more useful one to show the user.
    {
        type: 'Credit/Debit Card',
        severity: 'critical',
        action: 'blur',
        // Deliberately no Luhn check: an OCR misread would fail the checksum
        // and leave a real card number unblurred.
        regex: /\b(?:4\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}|5[1-5]\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}|3[47]\d{2}[\s-]?\d{6}[\s-]?\d{5}|(?:60|65|81|82)\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/g,
        redact: (m) => `****-****-****-${digitsOf(m).slice(-4)}`,
    },

    // ── Identity Documents ─────────────────────────────────────────────
    {
        type: 'Aadhaar Number',
        severity: 'critical',
        action: 'blur',
        regex: /\b\d{4}\s?\d{4}\s?\d{4}\b/g,
        redact: (m) => `XXXX XXXX ${digitsOf(m).slice(-4)}`,
    },
    {
        type: 'PAN Card Number',
        severity: 'critical',
        action: 'blur',
        regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
        redact: (m) => `${m.slice(0, 2)}***${m.slice(5, 8)}*${m.slice(-1)}`,
    },
    {
        type: 'Passport Number',
        severity: 'critical',
        action: 'blur',
        regex: /\b[A-Z][0-9]{7}\b/g,
        redact: (m) => `${m.slice(0, 2)}*****${m.slice(-1)}`,
        contextRequired: /passport|travel|visa|immigration|mrz/i,
    },
    {
        type: 'Voter ID / EPIC',
        severity: 'critical',
        action: 'blur',
        regex: /\b[A-Z]{3}\d{7}\b/g,
        redact: (m) => `${m.slice(0, 3)}****${m.slice(-3)}`,
        contextRequired: /voter|epic|election|electoral/i,
    },
    {
        type: 'Driving License',
        severity: 'critical',
        action: 'blur',
        regex: /\b[A-Z]{2}[0-9]{2}\s?[0-9]{4}\s?[0-9]{7}\b/g,
        redact: (m) => `${m.slice(0, 4)}*******${m.slice(-3)}`,
    },

    // ── Financial ──────────────────────────────────────────────────────
    {
        type: 'IBAN',
        severity: 'critical',
        action: 'blur',
        regex: /\b[A-Z]{2}\d{2}[\s-]?(?:[A-Z0-9]{4}[\s-]?){2,7}[A-Z0-9]{1,4}\b/g,
        redact: (m) => {
            const iban = m.replace(/[\s-]/g, '');
            return `${iban.slice(0, 4)} **** ${iban.slice(-4)}`;
        },
        validate: isValidIban,
    },
    {
        type: 'IBAN (labelled)',
        severity: 'critical',
        action: 'blur',
        // Accepts a mis-OCR'd checksum when the label makes the intent clear.
        regex: /\b[A-Z]{2}\d{2}[\s-]?(?:[A-Z0-9]{4}[\s-]?){2,7}[A-Z0-9]{1,4}\b/g,
        redact: (m) => {
            const iban = m.replace(/[\s-]/g, '');
            return `${iban.slice(0, 4)} **** ${iban.slice(-4)}`;
        },
        contextRequired: /\biban\b|\bswift\b|\bbic\b|wire\s*transfer/i,
        validate: isIbanShaped,
    },
    {
        type: 'UPI / Payment ID',
        severity: 'critical',
        action: 'blur',
        regex: /\b[a-zA-Z0-9._-]+@(?:[a-zA-Z]{2,}(?:bank|upi|apl|axl|okhdfcbank|okaxis|okicici|oksbi|paytm|ybl|ibl|fbl|axisbank|sbi|hdfcbank|icici|kotak|unionbank|boi|cnrb|pnb|canara|bob|dbs|federal|indus|kvb|rbl|tjsb|ujjivan|aubank|jio|slice|fi|cred|amazon|gpay|phonepe|bharatpe))\b/gi,
        redact: (m) => `***@${m.split('@')[1]}`,
    },
    {
        type: 'IFSC Code',
        severity: 'high',
        action: 'blur',
        regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
        redact: (m) => `${m.slice(0, 4)}0******`,
    },
    {
        type: 'Bank Account Number',
        severity: 'critical',
        action: 'blur',
        regex: /\b\d{9,18}\b/g,
        redact: (m) => `*****${m.slice(-4)}`,
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

    // ── Network ────────────────────────────────────────────────────────
    // Ahead of the phone patterns: a dotted quad such as 103.21.244.10 also
    // reads as a ten-digit phone number, and "IP Address" is the right label.
    {
        type: 'IP Address',
        severity: 'medium',
        action: 'blur',
        // Exactly four octets, and not part of a longer dotted run such as a
        // version string like 10.0.19041.1.
        regex: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(?![\d.])/g,
        redact: () => '***.***.***.***',
    },

    // ── Contact Information ────────────────────────────────────────────
    {
        type: 'Email Address',
        severity: 'high',
        action: 'blur',
        regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
        redact: (m) => {
            const [user, domain] = m.split('@');
            return `${user.slice(0, 2)}***@${domain}`;
        },
    },
    {
        type: 'Phone Number',
        severity: 'high',
        action: 'blur',
        // With country code: +91 98765 43210, +1 (415) 555-2671, +44 20 7946 0958
        regex: /(?<![\d/])\+\d{1,3}[\s.-]?(?:\(\d{1,5}\)|\d{1,5})?[\s.-]?\d{2,5}[\s.-]?\d{2,6}(?:[\s.-]?\d{2,6})?(?![\d/])/g,
        redact: (m) => `***${digitsOf(m).slice(-4)}`,
        minDigits: 8,
        maxDigits: 15,
    },
    {
        type: 'Phone Number',
        severity: 'high',
        action: 'blur',
        // Without country code: 9876543210, 98765 43210, 020 7946 0958,
        // (415) 555-2671. Greedy on trailing groups so a 12-digit Aadhaar run
        // is swallowed whole and then rejected by maxDigits rather than
        // matching its first ten digits.
        regex: /(?<![\d/.-])(?:\(\d{2,5}\)|0\d{2,4})?[\s.-]?\d{3,6}(?:[\s.-]?\d{2,6})+(?![\d/.-])/g,
        redact: (m) => `***${digitsOf(m).slice(-4)}`,
        validate: (m) => !isDateLike(m) && !isIpLike(m),
        minDigits: 8,
        maxDigits: 11,
    },
    {
        type: 'Phone (with label)',
        severity: 'high',
        action: 'blur',
        regex: /\b(?:ph|phone|mobile|mob|cell|tel|contact|call|whatsapp|wa)[\s.:#+~-]+\+?[\d\s()-]{7,15}/gi,
        redact: (m) => `***${digitsOf(m).slice(-4)}`,
    },

    // ── Shipping ───────────────────────────────────────────────────────
    {
        type: 'Tracking Number',
        severity: 'medium',
        action: 'blur',
        // UPS (1Z...) and the UPU S10 postal format (RR123456789IN).
        regex: /\b(?:1Z[0-9A-HJ-NP-Z]{16}|[A-Z]{2}\d{9}[A-Z]{2})\b/g,
        redact: (m) => `${m.slice(0, 2)}********${m.slice(-2)}`,
    },
    {
        type: 'Tracking Number (labelled)',
        severity: 'medium',
        action: 'blur',
        regex: /\b(?:tracking|awb|consignment|shipment|waybill|docket)(?:\s*(?:no|num|number|id))?[\s.:#-]+[A-Z0-9][A-Z0-9-]{6,24}/gi,
        redact: (m) => {
            const label = m.match(/^[a-zA-Z\s.:#-]+/)?.[0] ?? '';
            return `${label}*****`;
        },
    },

    // ── Personal Information ───────────────────────────────────────────
    {
        type: 'Date of Birth',
        severity: 'high',
        action: 'blur',
        regex: /\b(?:\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2})\b/g,
        redact: () => '**/**/****',
        contextRequired: /dob|d\.o\.b|date\s*of\s*birth|birth\s*date|born|birthday|age/i,
    },
    {
        type: 'Date (Sensitive)',
        severity: 'medium',
        action: 'blur',
        regex: /\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/g,
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
        // A separator is required so "Passengers: 2" does not match.
        regex: /\b(?:password|passwd|pwd|pass)[\s.:=~-]+\S+/gi,
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
    {
        type: 'Named Field',
        severity: 'high',
        action: 'blur',
        regex: /\b(?:user\s*name|name|father(?:'s)?\s*name|mother(?:'s)?\s*name|husband(?:'s)?\s*name|spouse|guardian|s\/o|d\/o|w\/o|c\/o)[\s.:=~-]+[a-zA-Z\s.]{2,40}/gi,
        redact: (m) => {
            const label = m.match(/^[a-zA-Z/'()\s]+[\s.:=~-]+/)?.[0] ?? '';
            return `${label}[REDACTED]`;
        },
    },
    {
        type: 'Enrollment / Registration No',
        severity: 'high',
        action: 'blur',
        regex: /\b(?:enrollment|enrolment|registration|reg|roll|admission|application|reference|ref|sr|serial|sl|case|file|policy|claim|member|employee|emp|id)[\s.:=#-]*(?:no|num|number)?[\s.:=#-]+[A-Z0-9][A-Z0-9\-/]{3,19}/gi,
        redact: (m) => {
            const label = m.match(/^[a-zA-Z\s.:=#/-]+/)?.[0] ?? '';
            return `${label}*****`;
        },
    },
];

// ── Matching ────────────────────────────────────────────────────────────────

/**
 * Run every pattern over one OCR text block.
 *
 * `context` is the text of the neighbouring blocks; patterns that declare
 * `contextRequired` only fire when it (or the block itself) matches.
 */
export function matchPatterns(blockText: string, context: string = ''): PatternMatch[] {
    const matches: PatternMatch[] = [];
    const seen = new Set<string>();

    for (const pattern of OCR_PATTERNS) {
        if (pattern.contextRequired
            && !pattern.contextRequired.test(context)
            && !pattern.contextRequired.test(blockText)) {
            continue;
        }

        pattern.regex.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = pattern.regex.exec(blockText)) !== null) {
            const value = match[0];
            if (value === '') {
                pattern.regex.lastIndex++;
                continue;
            }

            const cleanValue = value.replace(/[-.\s]/g, '');
            if (seen.has(cleanValue) || seen.has(value)) continue;

            // Drop bare short numbers ("Order #1234") unless the pattern asked
            // for context. Non-numeric matches such as emails are unaffected.
            const digits = digitsOf(value);
            if (isNumericOnly(value) && digits.length <= 4 && !pattern.contextRequired) continue;

            if (pattern.minDigits !== undefined && digits.length < pattern.minDigits) continue;
            if (pattern.maxDigits !== undefined && digits.length > pattern.maxDigits) continue;
            if (pattern.validate && !pattern.validate(value)) continue;

            seen.add(cleanValue);
            seen.add(value);

            // Numeric matches get their label re-decided; a shape alone cannot
            // tell an Aadhaar from a transaction reference. Structural matches
            // such as email, PAN, IFSC and IBAN keep the pattern's own name,
            // because their format is specific enough to stand behind.
            const { type, confident } = isNumericOnly(value)
                ? resolveNumericType(value, pattern.type, context)
                : { type: pattern.type, confident: true };

            matches.push({
                type,
                value,
                redacted: pattern.redact(value),
                severity: pattern.severity,
                action: pattern.action,
                confident,
            });
        }
    }

    return matches;
}
