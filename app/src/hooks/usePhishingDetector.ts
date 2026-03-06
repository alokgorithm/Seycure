export interface PhishingSignal {
    type: string;
    message: string;
    severity: 'critical' | 'high' | 'medium';
}

const LOOKALIKE_CHARS: Record<string, string> = {
    // Latin lookalikes
    'o': '0', '0': 'o',
    'l': '1', '1': 'l', 'I': 'l',
    'rn': 'm',  // "rn" side by side looks like "m"
    'vv': 'w',
    // Unicode homoglyphs
    'а': 'a',  // Cyrillic 'а' vs Latin 'a'
    'е': 'e',  // Cyrillic 'е' vs Latin 'e'
    'о': 'o',  // Cyrillic 'о' vs Latin 'o'
    'р': 'p',  // Cyrillic 'р' vs Latin 'p'
    'с': 'c',  // Cyrillic 'с' vs Latin 'c'
};

const TOP_BRANDS = [
    'paypal', 'google', 'facebook', 'apple', 'microsoft',
    'amazon', 'netflix', 'instagram', 'whatsapp', 'twitter',
    'linkedin', 'dropbox', 'gmail', 'outlook', 'bankofamerica',
    'chase', 'wellsfargo', 'hdfc', 'sbi', 'icici',
    'flipkart', 'zomato', 'swiggy', 'paytm', 'phonepe'
];

const PHISHING_PATTERNS = [
    /secure.*login/i,
    /login.*secure/i,
    /verify.*account/i,
    /account.*verify/i,
    /confirm.*identity/i,
    /update.*payment/i,
    /signin.*auth/i,
    /\.tk$|\.ml$|\.ga$|\.cf$|\.gq$/,  // Free TLDs abused for phishing
];

const PHISHING_KEYWORDS_IN_PATH = [
    'login', 'signin', 'verify', 'secure',
    'account', 'update', 'confirm', 'banking'
];

// --- 1. Homograph / Character Substitution Attack ---
function normalizeForComparison(domain: string): string {
    let normalized = domain.toLowerCase();
    Object.entries(LOOKALIKE_CHARS).forEach(([fake, real]) => {
        normalized = normalized.replaceAll(fake, real);
    });
    return normalized;
}

function checkHomograph(domain: string): PhishingSignal | null {
    const normalized = normalizeForComparison(domain);
    if (normalized !== domain.toLowerCase()) {
        // Check if the normalized version matches a brand
        const base = normalized.replace(/^www\./, '').split('.')[0];
        if (TOP_BRANDS.includes(base)) {
            return {
                type: 'HOMOGRAPH_ATTACK',
                message: `Looks like "${base}.com" but uses confusing characters`,
                severity: 'critical'
            };
        }
    }
    return null;
}

// --- 2. Brand Impersonation in Domain ---
function detectBrandInSubdomain(url: string, registeredDomain: string): PhishingSignal | null {
    try {
        const hostname = new URL(url).hostname;
        // We get registeredDomain from App.tsx normally, but we can do a simple heuristic if it's missing
        const parts = hostname.split('.');
        const actualRegDomain = registeredDomain || parts.slice(-2).join('.');
        const subdomains = hostname.replace('.' + actualRegDomain, '');

        for (const brand of TOP_BRANDS) {
            if (subdomains.includes(brand) && !actualRegDomain.includes(brand)) {
                return {
                    type: 'BRAND_IN_SUBDOMAIN',
                    message: `"${brand}" used in subdomain — real ${brand}.com is different`,
                    severity: 'critical'
                };
            }
        }
    } catch {
        // Invalid URL
    }
    return null;
}

// --- 3. Lookalike Domain Similarity (Levenshtein Distance) ---
function levenshtein(a: string, b: string): number {
    const matrix = Array.from({ length: b.length + 1 },
        (_, i) => [i, ...Array(a.length).fill(0)]
    );
    for (let j = 1; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            matrix[i][j] = b[i - 1] === a[j - 1]
                ? matrix[i - 1][j - 1]
                : Math.min(matrix[i - 1][j - 1], matrix[i - 1][j], matrix[i][j - 1]) + 1;
        }
    }
    return matrix[b.length][a.length];
}

function checkLookalikeDomain(domain: string): PhishingSignal | null {
    const base = domain.replace(/^www\./, '').split('.')[0].toLowerCase();

    for (const brand of TOP_BRANDS) {
        if (base === brand) continue; // Exact match is fine (it's the real site)

        // Don't flag super short domains that might legitimately overlap
        if (base.length < 4 || brand.length < 4) continue;

        const distance = levenshtein(base, brand);

        // Only flag if it's 1 char off AND it's a long enough brand name to be suspicious
        if (distance === 1 && brand.length >= 5) {
            return {
                type: 'LOOKALIKE_DOMAIN',
                message: `"${domain}" is 1 character away from "${brand}.com"`,
                severity: 'critical'
            };
        }
    }
    return null;
}

// --- 4. Suspicious Keyword Patterns ---
function checkSuspiciousKeywords(urlStr: string): PhishingSignal | null {
    try {
        const url = new URL(urlStr);
        let matches = 0;
        const reasons: string[] = [];

        // Check full URL against regex patterns
        for (const pattern of PHISHING_PATTERNS) {
            if (pattern.test(urlStr)) {
                matches++;
                if (pattern.source.includes('login') || pattern.source.includes('secure')) {
                    reasons.push('secure login pattern');
                } else if (pattern.source.includes('verify') || pattern.source.includes('update')) {
                    reasons.push('account verification pattern');
                } else if (url.hostname.match(/\.tk$|\.ml$|\.ga$|\.cf$|\.gq$/)) {
                    reasons.push('free/abused TLD');
                }
            }
        }

        // Check path for keywords
        const path = url.pathname.toLowerCase();
        for (const keyword of PHISHING_KEYWORDS_IN_PATH) {
            if (path.includes(`/${keyword}`) || path.includes(`-${keyword}`)) {
                matches++;
                if (!reasons.includes('suspicious path keyword')) reasons.push(`'${keyword}' in path`);
            }
        }

        if (matches >= 2) {
            return {
                type: 'SUSPICIOUS_KEYWORDS',
                message: `URL contains multiple phishing markers: ${reasons.join(', ')}`,
                severity: 'high'
            };
        }
    } catch {
        // ignore
    }
    return null;
}

// --- 6. Domain Mismatch in Page Content ---
// Check if the fetched page title claims to be a top brand, but the domain isn't
function checkDomainMismatch(domain: string, pageTitle: string): PhishingSignal | null {
    if (!pageTitle) return null;
    const titleLow = pageTitle.toLowerCase();

    for (const brand of TOP_BRANDS) {
        if (titleLow.includes(brand)) {
            // The word appears in the title. Does the domain match?
            if (!domain.toLowerCase().includes(brand.toLowerCase())) {
                const brandCapitalized = brand.charAt(0).toUpperCase() + brand.slice(1);
                return {
                    type: 'DOMAIN_MISMATCH',
                    message: `Page claims to be "${brandCapitalized}" but domain is "${domain}"`,
                    severity: 'critical'
                };
            }
        }
    }
    return null;
}

// --- 7. Missing HTTPS ---
function checkInsecureProtocol(url: string, otherSignalsFound: boolean): PhishingSignal | null {
    if (url.startsWith('http://') && otherSignalsFound) {
        return {
            type: 'NO_HTTPS',
            message: 'This page has no encryption — never enter passwords here',
            severity: 'critical'
        };
    }
    return null;
}


// --- Main Export ---
export function checkPhishingSignals(
    url: string,
    domain: string,
    registeredDomain: string,
    pageTitle: string,
    hasLoginForm: boolean = false
): PhishingSignal[] {
    const signals: PhishingSignal[] = [];

    const homograph = checkHomograph(domain);
    if (homograph) signals.push(homograph);

    const brandSubdomain = detectBrandInSubdomain(url, registeredDomain);
    if (brandSubdomain) signals.push(brandSubdomain);

    const lookalike = checkLookalikeDomain(domain);
    if (lookalike) signals.push(lookalike);

    const keywords = checkSuspiciousKeywords(url);
    if (keywords) signals.push(keywords);

    const mismatch = checkDomainMismatch(domain, pageTitle);
    if (mismatch) signals.push(mismatch);

    // If we have a login form on a page that triggered ANY other signal, it's definitively phishing
    if (hasLoginForm && signals.length > 0) {
        signals.push({
            type: 'LOGIN_FORM_ON_SUSPICIOUS_DOMAIN',
            message: 'Login form detected on a suspicious domain',
            severity: 'critical'
        });
    }

    // Only flag HTTP if it's already looking like a login/phishing page
    // (A random HTTP blog is fine, an HTTP "paypal login" is terrible)
    const insecure = checkInsecureProtocol(url, signals.length > 0 || hasLoginForm);
    if (insecure) signals.push(insecure);

    return signals;
}
