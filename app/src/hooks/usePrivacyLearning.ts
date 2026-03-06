import { Preferences } from '@capacitor/preferences';

// ── Types ───────────────────────────────────────────────────────────────────

export interface CorrectionRule {
    id: string;
    type: 'never_blur' | 'always_blur';
    pattern: string;       // regex-safe pattern derived from the text
    label: string;         // human-readable label shown in settings
    context: string;       // surrounding context text (for debugging)
    createdAt: number;
}

export interface AppLayoutRow {
    position: number;      // normalized Y (0-1)
    sensitive: boolean;
    label: string;
    confidence: number;    // 0-1, grows with repeated scans
    scanCount: number;
}

export interface AppLayout {
    appName: string;
    rows: AppLayoutRow[];
    totalScans: number;
    lastScanned: number;
}

// ── Storage Keys ────────────────────────────────────────────────────────────

const CORRECTIONS_KEY = 'privacy_corrections';
const APP_LAYOUTS_KEY = 'privacy_app_layouts';

// ── Correction Rules ────────────────────────────────────────────────────────

export async function loadCorrections(): Promise<CorrectionRule[]> {
    try {
        const { value } = await Preferences.get({ key: CORRECTIONS_KEY });
        return value ? JSON.parse(value) : [];
    } catch {
        return [];
    }
}

export async function saveCorrection(rule: Omit<CorrectionRule, 'id' | 'createdAt'>): Promise<void> {
    const corrections = await loadCorrections();

    // Deduplicate: don't add if same pattern+type already exists
    const exists = corrections.some(
        c => c.pattern === rule.pattern && c.type === rule.type
    );
    if (exists) return;

    corrections.push({
        ...rule,
        id: `cr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        createdAt: Date.now(),
    });

    await Preferences.set({
        key: CORRECTIONS_KEY,
        value: JSON.stringify(corrections),
    });
}

export async function deleteCorrection(id: string): Promise<void> {
    const corrections = await loadCorrections();
    const filtered = corrections.filter(c => c.id !== id);
    await Preferences.set({
        key: CORRECTIONS_KEY,
        value: JSON.stringify(filtered),
    });
}

// ── App Layout Memory ───────────────────────────────────────────────────────

export async function loadAllAppLayouts(): Promise<AppLayout[]> {
    try {
        const { value } = await Preferences.get({ key: APP_LAYOUTS_KEY });
        return value ? JSON.parse(value) : [];
    } catch {
        return [];
    }
}

export async function loadAppLayout(appName: string | null): Promise<AppLayout | null> {
    if (!appName) return null;
    const layouts = await loadAllAppLayouts();
    return layouts.find(l => l.appName === appName) || null;
}

export async function saveAppLayout(
    appName: string,
    rows: AppLayoutRow[]
): Promise<void> {
    const layouts = await loadAllAppLayouts();
    const existingIdx = layouts.findIndex(l => l.appName === appName);

    if (existingIdx >= 0) {
        const existing = layouts[existingIdx];
        // Merge rows: update confidence for known positions, add new ones
        const mergedRows = mergeLayoutRows(existing.rows, rows);
        layouts[existingIdx] = {
            ...existing,
            rows: mergedRows,
            totalScans: existing.totalScans + 1,
            lastScanned: Date.now(),
        };
    } else {
        layouts.push({
            appName,
            rows,
            totalScans: 1,
            lastScanned: Date.now(),
        });
    }

    await Preferences.set({
        key: APP_LAYOUTS_KEY,
        value: JSON.stringify(layouts),
    });
}

function mergeLayoutRows(
    existing: AppLayoutRow[],
    incoming: AppLayoutRow[]
): AppLayoutRow[] {
    const merged = [...existing];

    for (const inc of incoming) {
        const match = merged.find(
            m => Math.abs(m.position - inc.position) < 0.05
        );

        if (match) {
            // Reinforce confidence
            match.scanCount += 1;
            match.confidence = Math.min(
                0.5 + (match.scanCount / 20),
                1.0
            );
            // If the latest scan disagrees, reduce confidence
            if (match.sensitive !== inc.sensitive) {
                match.confidence = Math.max(match.confidence - 0.15, 0.3);
            }
        } else {
            merged.push({
                ...inc,
                scanCount: 1,
                confidence: 0.5,
            });
        }
    }

    return merged;
}

export async function deleteAppLayout(appName: string): Promise<void> {
    const layouts = await loadAllAppLayouts();
    const filtered = layouts.filter(l => l.appName !== appName);
    await Preferences.set({
        key: APP_LAYOUTS_KEY,
        value: JSON.stringify(filtered),
    });
}

// ── App Context Detection ───────────────────────────────────────────────────

const APP_ANCHORS: Record<string, string[]> = {
    'Google Pay': ['google pay', 'gpay', 'paid to', 'received from', 'upi transaction'],
    'PhonePe': ['phonepe', 'phone pe', 'paid via phonepe'],
    'Paytm': ['paytm', 'paytm payments'],
    'Swiggy': ['swiggy', 'order placed', 'delivery partner'],
    'Zomato': ['zomato', 'order id', 'delivery by'],
    'Amazon': ['amazon', 'order placed', 'arriving'],
    'Flipkart': ['flipkart', 'order confirmed'],
    'IRCTC': ['irctc', 'indian railways', 'pnr', 'train no'],
    'WhatsApp': ['whatsapp', 'end-to-end encrypted'],
    'Bank SMS': ['credited', 'debited', 'a/c', 'avl bal'],
};

export function detectAppContext(
    blockTexts: string[]
): string | null {
    const fullText = blockTexts.join(' ').toLowerCase();

    for (const [appName, anchors] of Object.entries(APP_ANCHORS)) {
        const matchCount = anchors.filter(a => fullText.includes(a)).length;
        if (matchCount >= 1) return appName;
    }

    return null;
}

// ── Text-to-Pattern Conversion ──────────────────────────────────────────────

/**
 * Convert a raw text value into a safe regex pattern.
 * e.g. "9876543210" → "\\d{10}"
 * e.g. "EMP-12345"  → "[A-Z]+-\\d{5}"
 */
export function textToPattern(text: string): string {
    const trimmed = text.trim();

    // Pure digits
    if (/^\d+$/.test(trimmed)) {
        return `\\d{${trimmed.length}}`;
    }

    // Alphanumeric with dashes/dots (like employee IDs, reference codes)
    if (/^[A-Za-z0-9._-]+$/.test(trimmed)) {
        return trimmed
            .replace(/[A-Z]+/g, '[A-Z]+')
            .replace(/[a-z]+/g, '[a-z]+')
            .replace(/\d+/g, (m) => `\\d{${m.length}}`)
            .replace(/[._-]/g, (m) => `\\${m}`);
    }

    // Spaced digit groups (like Aadhaar: "1234 5678 9012")
    if (/^[\d\s]+$/.test(trimmed)) {
        return trimmed.replace(/\d+/g, (m) => `\\d{${m.length}}`).replace(/\s+/g, '\\s+');
    }

    // Fallback: escape for literal match
    return trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Reset All ───────────────────────────────────────────────────────────────

export async function resetAllLearning(): Promise<void> {
    await Preferences.remove({ key: CORRECTIONS_KEY });
    await Preferences.remove({ key: APP_LAYOUTS_KEY });
}
