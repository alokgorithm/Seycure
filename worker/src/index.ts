// ══════════════════════════════════════════════════════════════════════════════
//  Seycure — Safe Browsing Proxy Worker (4-Layer Architecture)
//
//  Layer 1: KV Cache        — Safe=6h TTL, Unsafe=1h TTL
//  Layer 2: Coalescing      — concurrent requests for same URL share one Promise
//  Layer 3: Batch API       — 50ms collection window → single Google API call
//  Layer 4: Rate Limiting   — 100 req/min per IP sliding window
// ══════════════════════════════════════════════════════════════════════════════

export interface Env {
    GOOGLE_SAFE_BROWSING_API_KEY: string;
    GSB_CACHE: KVNamespace;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface SafeBrowsingResult {
    safe: boolean;
    threats: string[];
}

interface CachedResult extends SafeBrowsingResult {
    cachedAt: number;
}

interface CheckResponse extends SafeBrowsingResult {
    source: 'cache' | 'live';
}

// ── CORS Headers ──────────────────────────────────────────────────────────────

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
};

// ── Layer 4: Rate Limiter (in-memory sliding window) ──────────────────────────
// 100 requests per minute per IP. Resets when isolate recycles.

const RATE_LIMIT = 100;
const RATE_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
    const now = Date.now();
    let timestamps = rateLimitMap.get(ip);

    if (!timestamps) {
        timestamps = [];
        rateLimitMap.set(ip, timestamps);
    }

    // Prune entries older than the window
    const cutoff = now - RATE_WINDOW_MS;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
        timestamps.shift();
    }

    if (timestamps.length >= RATE_LIMIT) {
        return true; // over limit
    }

    timestamps.push(now);
    return false;
}

// Periodic cleanup to prevent memory leak (every 5 minutes)
let lastCleanup = Date.now();
function cleanupRateLimits() {
    const now = Date.now();
    if (now - lastCleanup < 300_000) return;
    lastCleanup = now;
    const cutoff = now - RATE_WINDOW_MS;
    for (const [ip, timestamps] of rateLimitMap) {
        const filtered = timestamps.filter(t => t >= cutoff);
        if (filtered.length === 0) rateLimitMap.delete(ip);
        else rateLimitMap.set(ip, filtered);
    }
}

// ── Layer 2: Request Coalescing (in-memory per-URL promise sharing) ───────────
// If 500 users request the same URL at once, only ONE Google API call fires.

const inflightMap = new Map<string, Promise<SafeBrowsingResult>>();

// ── Layer 3: Batch API (50ms window, up to 500 URLs) ──────────────────────────
// Collects URLs arriving within a short window, then sends a single batched
// Google Safe Browsing API request.

const BATCH_WINDOW_MS = 50;
const MAX_BATCH_SIZE = 500;

interface BatchEntry {
    url: string;
    resolve: (result: SafeBrowsingResult) => void;
    reject: (error: Error) => void;
}

let pendingBatch: BatchEntry[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

function enqueueBatch(url: string, env: Env): Promise<SafeBrowsingResult> {
    return new Promise<SafeBrowsingResult>((resolve, reject) => {
        pendingBatch.push({ url, resolve, reject });

        // Flush immediately if batch is full
        if (pendingBatch.length >= MAX_BATCH_SIZE) {
            flushBatch(env);
            return;
        }

        // Start timer for the batch window
        if (!batchTimer) {
            batchTimer = setTimeout(() => flushBatch(env), BATCH_WINDOW_MS);
        }
    });
}

async function flushBatch(env: Env) {
    if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
    }

    if (pendingBatch.length === 0) return;

    // Grab current batch and reset
    const batch = [...pendingBatch];
    pendingBatch = [];

    const urls = batch.map(b => b.url);

    try {
        const results = await callGoogleSafeBrowsingBatch(urls, env.GOOGLE_SAFE_BROWSING_API_KEY);

        // Distribute results back to each waiting request
        batch.forEach((entry, _i) => {
            const threats = results.get(entry.url) || [];
            entry.resolve({
                safe: threats.length === 0,
                threats,
            });
        });
    } catch (error) {
        // On failure, reject all waiting requests
        batch.forEach(entry => {
            entry.reject(error instanceof Error ? error : new Error(String(error)));
        });
    }
}

// ── Google Safe Browsing API — Batch call ─────────────────────────────────────

async function callGoogleSafeBrowsingBatch(
    urls: string[],
    apiKey: string
): Promise<Map<string, string[]>> {
    const googleApiUrl = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`;

    const body = {
        client: { clientId: 'seycure', clientVersion: '2.1.0' },
        threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: urls.map(url => ({ url })),
        },
    };

    const response = await fetch(googleApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown');
        throw new Error(`Google API error: ${response.status} ${response.statusText} — ${errorBody}`);
    }

    const data = await response.json() as {
        matches?: Array<{ threat: { url: string }; threatType: string }>;
    };

    // Build a map: URL → threat types
    const resultMap = new Map<string, string[]>();
    if (data.matches) {
        for (const match of data.matches) {
            const existing = resultMap.get(match.threat.url) || [];
            existing.push(match.threatType);
            resultMap.set(match.threat.url, existing);
        }
    }

    return resultMap;
}

// ── Layer 1: KV Cache key helper ──────────────────────────────────────────────

async function hashUrl(url: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(url.toLowerCase().trim());
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// ── Core check pipeline: Cache → Coalesce → Batch → Cache write ──────────────

async function checkUrl(url: string, env: Env): Promise<CheckResponse> {
    const cacheKey = `gsb:${await hashUrl(url)}`;

    // ── Layer 1: Check KV cache ───────────────────────────────────────────────
    try {
        const cached = await env.GSB_CACHE.get(cacheKey, { type: 'json' }) as CachedResult | null;
        if (cached) {
            return { safe: cached.safe, threats: cached.threats, source: 'cache' };
        }
    } catch {
        // KV read failure — proceed to live check
    }

    // ── Layer 2: Check inflight coalescing map ────────────────────────────────
    const existing = inflightMap.get(url);
    if (existing) {
        const result = await existing;
        return { ...result, source: 'live' };
    }

    // ── Layer 3: Enqueue into batch and coalesce ──────────────────────────────
    const promise = enqueueBatch(url, env);
    inflightMap.set(url, promise);

    try {
        const result = await promise;

        // ── Layer 1: Write result to KV cache ─────────────────────────────────
        const ttl = result.safe ? 21600 : 3600; // Safe=6h, Unsafe=1h
        const cacheValue: CachedResult = { ...result, cachedAt: Date.now() };
        try {
            await env.GSB_CACHE.put(cacheKey, JSON.stringify(cacheValue), {
                expirationTtl: ttl,
            });
        } catch {
            // KV write failure — non-critical, continue
        }

        return { ...result, source: 'live' };
    } finally {
        inflightMap.delete(url);
    }
}

// ── URL safety guard ─────────────────────────────────────────────────────────
// /resolve and /title fetch a URL the caller supplies, so without this the
// Worker is a confused deputy: it sits inside Cloudflare's network and would
// happily fetch link-local metadata or an internal host on request.
// Allow only http(s) to a public hostname.

const PRIVATE_HOST = /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?f[cde])/i;

function assertFetchableUrl(raw: string): URL {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('Malformed URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only http and https are supported');
    }
    if (PRIVATE_HOST.test(parsed.hostname) || !parsed.hostname.includes('.')) {
        throw new Error('Refusing to fetch a private or non-public host');
    }
    return parsed;
}

// ── Endpoint helper: follow a redirect chain ─────────────────────────────────
// Replaces the client's use of api.allorigins.win for unwrapping short links.

interface ResolveResult {
    finalUrl: string;
    chain: { url: string; status: number }[];
}

const MAX_HOPS = 10;

async function resolveUrl(target: string): Promise<ResolveResult> {
    assertFetchableUrl(target);

    const chain: { url: string; status: number }[] = [];
    let currentUrl = target;

    for (let hop = 0; hop <= MAX_HOPS; hop++) {
        const res = await fetch(currentUrl, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(8000),
        });
        chain.push({ url: currentUrl, status: res.status });

        const location = res.headers.get('location');
        if (![301, 302, 303, 307, 308].includes(res.status) || !location) break;

        currentUrl = new URL(location, currentUrl).toString();
        assertFetchableUrl(currentUrl); // a redirect must not walk us inward
    }

    return { finalUrl: currentUrl, chain };
}

// ── Endpoint helper: page metadata ───────────────────────────────────────────
// Replaces the client's use of api.allorigins.win/get for reading a page title,
// description and login-form shape. Extraction happens here so the app never
// receives raw third-party HTML.

interface TitleResult {
    title: string;
    description: string;
    hasLoginForm: boolean;
    finalUrl: string;
}

// Enough for <head> on any sane page, small enough to bound cost and memory.
const MAX_HTML_BYTES = 512 * 1024;

function decodeEntities(text: string): string {
    return text
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

function firstMatch(html: string, patterns: RegExp[]): string {
    for (const re of patterns) {
        const m = html.match(re);
        if (m?.[1]) return decodeEntities(m[1].trim());
    }
    return '';
}

async function readCapped(res: Response, limit: number): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return '';

    const decoder = new TextDecoder();
    let out = '';
    let total = 0;

    while (total < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        out += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    return out;
}

async function fetchTitle(target: string): Promise<TitleResult> {
    assertFetchableUrl(target);

    const res = await fetch(target, {
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
        headers: {
            // Some sites serve a stub to unknown agents; ask for HTML plainly.
            'Accept': 'text/html,application/xhtml+xml',
            'User-Agent': 'Mozilla/5.0 (compatible; SeycureLinkShield/1.0)',
        },
    });

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('html')) {
        return { title: '', description: '', hasLoginForm: false, finalUrl: res.url || target };
    }

    const html = await readCapped(res, MAX_HTML_BYTES);

    const title = firstMatch(html, [
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
        /<title[^>]*>([^<]+)</i,
    ]);
    const description = firstMatch(html, [
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    ]);

    const hasPasswordField = /<input[^>]+type=["']?password["']?/i.test(html);
    const hasEmailField = /<input[^>]+(type=["']?email["']?|name=["'][^"']*(email|user)[^"']*["'])/i.test(html);

    return {
        title,
        description,
        hasLoginForm: hasPasswordField && hasEmailField,
        finalUrl: res.url || target,
    };
}

// ── Generic KV read-through cache for the two metadata endpoints ─────────────

async function cached<T extends object>(
    env: Env,
    prefix: string,
    key: string,
    ttl: number,
    produce: () => Promise<T>
): Promise<T & { source: 'cache' | 'live' }> {
    const cacheKey = `${prefix}:${await hashUrl(key)}`;

    try {
        const hit = await env.GSB_CACHE.get(cacheKey, { type: 'json' }) as T | null;
        if (hit) return { ...hit, source: 'cache' as const };
    } catch {
        // KV read failure - fall through to a live fetch
    }

    const fresh = await produce();

    try {
        await env.GSB_CACHE.put(cacheKey, JSON.stringify(fresh), { expirationTtl: ttl });
    } catch {
        // KV write failure - non-critical
    }

    return { ...fresh, source: 'live' as const };
}

// ══════════════════════════════════════════════════════════════════════════════
//  Main Worker Export
// ══════════════════════════════════════════════════════════════════════════════

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // ── CORS preflight ────────────────────────────────────────────────────
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        // ── Layer 4: Rate limiting ────────────────────────────────────────────
        const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
        cleanupRateLimits();

        if (isRateLimited(clientIP)) {
            return Response.json(
                { error: 'Rate limit exceeded', retryAfter: 60 },
                { status: 429, headers: corsHeaders }
            );
        }

        // ── Endpoint: GET /check?url=<target> ─────────────────────────────────
        // New simplified endpoint used by the frontend.
        // Returns: { safe: boolean, threats: string[], source: "cache"|"live" }
        if (url.pathname === '/check' && request.method === 'GET') {
            const targetUrl = url.searchParams.get('url');
            if (!targetUrl) {
                return Response.json(
                    { error: 'Missing ?url= parameter' },
                    { status: 400, headers: corsHeaders }
                );
            }

            try {
                const result = await checkUrl(targetUrl, env);
                return Response.json(result, { headers: corsHeaders });
            } catch (e: any) {
                return Response.json(
                    { error: 'Check failed', details: e.message },
                    { status: 502, headers: corsHeaders }
                );
            }
        }

        // ── Endpoint: GET /redirects?url=<target> ─────────────────────────────
        // Redirect chain tracer (unchanged)
        if (url.pathname === '/redirects' && request.method === 'GET') {
            const targetUrl = url.searchParams.get('url');
            if (!targetUrl) {
                return Response.json({ error: 'url param missing' }, { status: 400, headers: corsHeaders });
            }

            try {
                const chain: { url: string; status: number }[] = [];
                let currentUrl = targetUrl;
                let hops = 0;

                while (hops < 10) {
                    const res = await fetch(currentUrl, { method: 'HEAD', redirect: 'manual' });
                    chain.push({ url: currentUrl, status: res.status });

                    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.has('location')) {
                        currentUrl = res.headers.get('location')!;
                        if (currentUrl.startsWith('/')) {
                            const base = new URL(chain[chain.length - 1].url);
                            currentUrl = base.origin + currentUrl;
                        }
                        hops++;
                    } else {
                        break;
                    }
                }
                return Response.json({ chain }, { headers: corsHeaders });
            } catch (e: any) {
                return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
            }
        }

        // ── Endpoint: GET /resolve?url=<target> ───────────────────────────────
        // Unwraps a shortened link. Returns { finalUrl, chain, source }.
        if (url.pathname === '/resolve' && request.method === 'GET') {
            const targetUrl = url.searchParams.get('url');
            if (!targetUrl) {
                return Response.json({ error: 'Missing ?url= parameter' }, { status: 400, headers: corsHeaders });
            }

            try {
                const result = await cached(env, 'resolve', targetUrl, 21600, () => resolveUrl(targetUrl));
                return Response.json(result, { headers: corsHeaders });
            } catch (e: any) {
                return Response.json({ error: 'Resolve failed', details: e.message }, { status: 502, headers: corsHeaders });
            }
        }

        // ── Endpoint: GET /title?url=<target> ─────────────────────────────────
        // Page title, description and login-form shape. Extraction happens here
        // so the app never handles raw third-party HTML.
        if (url.pathname === '/title' && request.method === 'GET') {
            const targetUrl = url.searchParams.get('url');
            if (!targetUrl) {
                return Response.json({ error: 'Missing ?url= parameter' }, { status: 400, headers: corsHeaders });
            }

            try {
                const result = await cached(env, 'title', targetUrl, 21600, () => fetchTitle(targetUrl));
                return Response.json(result, { headers: corsHeaders });
            } catch (e: any) {
                return Response.json({ error: 'Title fetch failed', details: e.message }, { status: 502, headers: corsHeaders });
            }
        }

        // ── Endpoint: POST / (legacy raw Safe Browsing proxy) ─────────────────
        // Kept for backward compatibility
        if (request.method === 'POST') {
            try {
                const body: any = await request.json();
                const targetUrl = body?.client?.clientId ? body.threatInfo?.threatEntries?.[0]?.url : null;
                if (!targetUrl) throw new Error('Invalid request body');

                const googleApiUrl = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${env.GOOGLE_SAFE_BROWSING_API_KEY}`;
                const response = await fetch(googleApiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });

                const data = await response.json();
                return Response.json(data, { headers: corsHeaders });
            } catch (e: any) {
                return Response.json(
                    { error: 'Proxy error', details: e.message },
                    { status: 500, headers: corsHeaders }
                );
            }
        }

        // ── Endpoint: GET /stats ──────────────────────────────────────────────
        // Simple health check + statistics
        if (url.pathname === '/stats' && request.method === 'GET') {
            return Response.json({
                status: 'healthy',
                rateLimitEntries: rateLimitMap.size,
                inflightRequests: inflightMap.size,
                pendingBatchSize: pendingBatch.length,
            }, { headers: corsHeaders });
        }

        return Response.json(
            { error: 'Not found', endpoints: ['GET /check?url=', 'GET /resolve?url=', 'GET /title?url=', 'GET /redirects?url=', 'GET /stats', 'POST /'] },
            { status: 404, headers: corsHeaders }
        );
    },
};
