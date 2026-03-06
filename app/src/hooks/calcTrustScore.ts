import { type CategoryResult } from './useLinkClassifier';

export interface TrustScoreResult {
    score: number;          // 0–100
    band: 'high-risk' | 'caution' | 'reputable';
    signals: TrustSignal[];   // shown in UI breakdown
}

export interface TrustSignal {
    label: string;
    points: number;   // positive = good, negative = bad
    detail: string;   // short explanation for UI
}

export interface TrustInputs {
    fullUrl: string;          // complete original URL
    domain: string;          // hostname only, no www
    ageInDays: number | null;   // from RDAP, null if unavailable
    isHttps: boolean;
    isThreat: boolean;         // from Google Safe Browsing
    category: CategoryResult | null;
}

// ── Trusted domain list — these earn the +35 known-domain bonus ──────────────
const TRUSTED_DOMAINS = new Set([
    // Search / tech
    'google.com', 'google.co.in', 'googleapis.com', 'youtube.com',
    'microsoft.com', 'apple.com', 'github.com', 'stackoverflow.com',
    // Shopping (India + global)
    'amazon.com', 'amazon.in', 'flipkart.com', 'myntra.com',
    'meesho.com', 'snapdeal.com', 'ebay.com', 'etsy.com',
    // Social
    'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
    'linkedin.com', 'reddit.com', 'tiktok.com', 'whatsapp.com',
    // News
    'bbc.com', 'cnn.com', 'ndtv.com', 'thehindu.com',
    'timesofindia.com', 'hindustantimes.com', 'reuters.com',
    // Education
    'wikipedia.org', 'coursera.org', 'udemy.com', 'khanacademy.org',
    // Finance / payments
    'paytm.com', 'phonepe.com', 'gpay.app', 'razorpay.com',
    'paypal.com', 'stripe.com',
    // Government (India)
    'gov.in', 'nic.in', 'india.gov.in', 'irctc.co.in',
]);

// ── Suspicious TLDs ───────────────────────────────────────────────────────────
const SUSPICIOUS_TLDS = [
    '.tk', '.ml', '.ga', '.cf', '.gq', '.xyz', '.top', '.buzz',
    '.cc', '.work', '.date', '.racing', '.download', '.stream',
    '.loan', '.bid', '.win', '.gdn', '.party', '.accountant',
];

// ── Standard TLDs (earn small positive) ──────────────────────────────────────
const STANDARD_TLDS = [
    '.com', '.org', '.net', '.edu', '.gov', '.in',
    '.co.in', '.co.uk', '.com.au', '.io', '.dev',
];

// ── Redirect parameter names ──────────────────────────────────────────────────
const REDIRECT_PARAMS = [
    'f', 'url', 'redirect', 'redirect_url', 'dest', 'destination',
    'goto', 'go', 'next', 'return', 'returnurl', 'target',
    'link', 'out', 'u', 'to',
];

// ── Gambling keywords ─────────────────────────────────────────────────────────
const GAMBLING_KEYWORDS = [
    'casino', 'poker', 'lottery', 'lotto', 'bet', 'slots',
    'gambling', 'roulette', 'jackpot', 'winbet', 'playwin',
];

// ── Shannon entropy — measures domain randomness ──────────────────────────────
function shannonEntropy(str: string): number {
    const freq: Record<string, number> = {};
    for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
    return Object.values(freq).reduce((sum, count) => {
        const p = count / str.length;
        return sum - p * Math.log2(p);
    }, 0);
}

// ── Extract redirect destination URL from query params ────────────────────────
function extractRedirectDest(urlObj: URL): string | null {
    for (const param of REDIRECT_PARAMS) {
        const val = urlObj.searchParams.get(param);
        if (val && (val.startsWith('http') || val.startsWith('/'))) return val;
    }
    return null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN FUNCTION — replaces calcTrustScore()
// ══════════════════════════════════════════════════════════════════════════════
export function calcTrustScore(inputs: TrustInputs): TrustScoreResult {
    const { fullUrl, domain, ageInDays, isHttps, isThreat, category } = inputs;
    const signals: TrustSignal[] = [];
    let score = 0;   // starts at 0 — must be earned

    // ── INSTANT ZERO — confirmed threat ─────────────────────────────────────────
    if (isThreat) {
        return {
            score: 0, band: 'high-risk', signals: [{
                label: 'Confirmed threat', points: -100,
                detail: 'Google Safe Browsing flagged this URL'
            }]
        };
    }

    let urlObj: URL | null = null;
    try { urlObj = new URL(fullUrl); } catch { /* invalid URL */ }

    const domainClean = domain.replace(/^www\./, '').toLowerCase();

    // ── POSITIVE SIGNALS ─────────────────────────────────────────────────────────

    // 1. Known reputable domain (+35) — biggest single positive signal
    const isKnown = [...TRUSTED_DOMAINS].some(d =>
        domainClean === d || domainClean.endsWith('.' + d)
    );
    if (isKnown) {
        score += 35;
        signals.push({ label: 'Known reputable domain', points: 35, detail: 'In trusted domain list' });
    }

    // 2. Domain age tiers (RDAP) — single best predictor of legitimacy
    if (ageInDays !== null) {
        if (ageInDays >= 1825) {           // > 5 years
            score += 25;
            signals.push({ label: 'Domain age: 5+ years', points: 25, detail: `${Math.floor(ageInDays / 365)} years old` });
        } else if (ageInDays >= 730) {      // 2–5 years
            score += 20;
            signals.push({ label: 'Domain age: 2–5 years', points: 20, detail: `${Math.floor(ageInDays / 365)} years old` });
        } else if (ageInDays >= 180) {     // 6 months – 2 years
            score += 10;
            signals.push({ label: 'Domain age: 6mo–2yr', points: 10, detail: `${Math.floor(ageInDays / 30)} months old` });
        } else if (ageInDays >= 30) {      // 1–6 months: neutral
            signals.push({ label: 'Domain age: 1–6 months', points: 0, detail: 'Young domain' });
        }
        // < 30 days handled in negatives below
    }

    // 3. HTTPS — worth much less than before (+8 not +40)
    if (isHttps) {
        score += 8;
        signals.push({ label: 'HTTPS', points: 8, detail: 'Encrypted connection' });
    }

    // 4. Low domain entropy (+8) — real brand names are low entropy words
    const hostnameOnly = domainClean.split('.')[0];
    const entropy = shannonEntropy(hostnameOnly);
    if (entropy < 3.5 && hostnameOnly.length >= 4) {
        score += 8;
        signals.push({ label: 'Domain name readable', points: 8, detail: 'Low character entropy — looks like a real name' });
    }

    // 5. Standard TLD (+5)
    if (STANDARD_TLDS.some(t => domainClean.endsWith(t))) {
        score += 5;
        signals.push({ label: 'Standard TLD', points: 5, detail: 'Common trusted top-level domain' });
    }

    // 6. No redirect params (+5)
    const redirectDest = urlObj ? extractRedirectDest(urlObj) : null;
    if (!redirectDest && urlObj) {
        score += 5;
        signals.push({ label: 'No redirect parameters', points: 5, detail: 'URL goes directly to destination' });
    }

    // 7. Edu/Gov category bonus (+5)
    if (category?.category === 'education' || category?.category === 'government') {
        score += 5;
        signals.push({ label: `${category.label} category`, points: 5, detail: 'Trusted site category' });
    }

    // ── NEGATIVE SIGNALS ─────────────────────────────────────────────────────────

    // 8. IP address as hostname (-30)
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(domain)) {
        score -= 30;
        signals.push({ label: 'IP address URL', points: -30, detail: 'Using raw IP instead of domain name' });
    }

    // 9. Open redirector detected (-30)
    if (redirectDest) {
        score -= 30;
        signals.push({ label: 'Open redirector', points: -30, detail: `Redirects to: ${redirectDest.slice(0, 50)}...` });

        // 9b. If redirect destination has suspicious TLD (-20 extra)
        try {
            const destDomain = new URL(redirectDest.startsWith('http') ? redirectDest : 'https:' + redirectDest).hostname;
            if (SUSPICIOUS_TLDS.some(t => destDomain.endsWith(t))) {
                score -= 20;
                signals.push({ label: 'Redirect dest suspicious TLD', points: -20, detail: `Destination: ${destDomain}` });
            }
        } catch { /* ignore parse errors */ }
    }

    // 10. High domain entropy — random-looking domain (-25)
    if (entropy >= 4.0) {
        score -= 25;
        signals.push({ label: 'Random-looking domain', points: -25, detail: `"${hostnameOnly}" looks machine-generated` });
    }

    // 11. Numeric/mixed subdomain (-15) — pgv3, cdn7, r4d
    if (urlObj) {
        const parts = urlObj.hostname.split('.');
        if (parts.length >= 3) {
            const sub = parts[0];
            if (/^[a-z]{0,4}\d+[a-z0-9]*$/i.test(sub) && sub !== 'www' && sub !== 'mail') {
                score -= 15;
                signals.push({ label: 'Numeric subdomain', points: -15, detail: `"${sub}" looks machine-assigned` });
            }
        }
    }

    // 12. Suspicious TLD (-15)
    if (!isKnown && SUSPICIOUS_TLDS.some(t => domainClean.endsWith(t))) {
        score -= 15;
        signals.push({ label: 'Suspicious TLD', points: -15, detail: 'High-abuse top-level domain' });
    }

    // 13. Very new domain (-20) or no RDAP data (−5 mild penalty)
    if (ageInDays !== null && ageInDays < 30) {
        score -= 20;
        signals.push({ label: 'Very new domain', points: -20, detail: `Only ${ageInDays} days old` });
    } else if (ageInDays === null && !isKnown) {
        score -= 5;
        signals.push({ label: 'Domain age unknown', points: -5, detail: 'No RDAP registration data' });
    }

    // 14. Multiple hyphens in domain (-12) — "new-delhi-king", "free-money-now"
    const hyphenCount = (domainClean.split('.')[0].match(/-/g) || []).length;
    if (hyphenCount >= 2) {
        score -= 12;
        signals.push({ label: 'Multiple hyphens in domain', points: -12, detail: 'Common brand-impersonation pattern' });
    }

    // 15. Gambling/suspicious keywords in domain (-15)
    if (GAMBLING_KEYWORDS.some(kw => domainClean.includes(kw))) {
        score -= 15;
        signals.push({ label: 'Suspicious domain keyword', points: -15, detail: 'Gambling/scam-related word in domain' });
    }

    // 16. URL length > 300 chars (-15)
    if (fullUrl.length > 300) {
        score -= 15;
        signals.push({ label: 'Extremely long URL', points: -15, detail: `${fullUrl.length} chars — typical of redirect chains` });
    }

    // 17. Excessive query params ≥ 5 (-10)
    if (urlObj && urlObj.searchParams.size >= 5) {
        score -= 10;
        signals.push({ label: 'Many query parameters', points: -10, detail: `${urlObj.searchParams.size} params — tracking/redirect indicator` });
    }

    // ── Category trust delta (from classifier) ───────────────────────────────────
    if (category && category.trustDelta !== 0) {
        score += category.trustDelta;
        signals.push({
            label: `Category: ${category.label}`,
            points: category.trustDelta,
            detail: category.trustDelta > 0 ? 'Trusted site type' : 'Higher-risk site type'
        });
    }

    // ── Clamp and band ───────────────────────────────────────────────────────────
    const finalScore = Math.max(0, Math.min(100, Math.round(score)));
    const band = finalScore >= 65 ? 'reputable' : finalScore >= 35 ? 'caution' : 'high-risk';

    return { score: finalScore, band, signals };
}
