export interface Env {
    GOOGLE_SAFE_BROWSING_API_KEY: string;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // Cors handling
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                },
            });
        }

        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json',
        };

        // Feature: Redirect Chain Tracer
        if (url.pathname === '/redirects') {
            const targetUrl = url.searchParams.get('url');
            if (!targetUrl) return Response.json({ error: 'url param missing' }, { status: 400, headers: corsHeaders });

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

        // Default Feature: Safe Browsing
        try {
            if (request.method !== 'POST') {
                return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
            }

            const body: any = await request.json();
            const targetUrl = body?.client?.clientId ? body.threatInfo.threatEntries[0].url : null;
            if (!targetUrl) throw new Error('Invalid URL');

            const googleApiUrl = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${env.GOOGLE_SAFE_BROWSING_API_KEY}`;

            const response = await fetch(googleApiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            const data = await response.json();
            return Response.json(data, { headers: corsHeaders });
        } catch (e: any) {
            return Response.json({ error: 'Proxy error', details: e.message }, { status: 500, headers: corsHeaders });
        }
    },
};
