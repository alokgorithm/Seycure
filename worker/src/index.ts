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
            { error: 'Not found', endpoints: ['GET /check?url=', 'GET /redirects?url=', 'GET /stats', 'POST /'] },
            { status: 404, headers: corsHeaders }
        );
    },
};
