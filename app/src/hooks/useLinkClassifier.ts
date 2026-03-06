export type SiteCategory =
    | 'gambling' | 'adult' | 'file-download'
    | 'crypto' | 'gaming' | 'pharma'
    | 'shopping' | 'news' | 'education'
    | 'social' | 'government' | 'blog'
    | 'chat' | 'search' | 'streaming'
    | 'finance' | 'tech' | 'unknown';

export interface CategoryResult {
    category: SiteCategory;
    label: string;           // human label: "Gambling", "Education", etc.
    icon: string;           // emoji
    riskLevel: 'danger' | 'caution' | 'low' | 'trusted' | 'neutral';
    filterType: 'block' | 'warn' | 'info' | 'none';
    trustDelta: number;           // added to domain trust score (-20 to +10)
    signal: 'tld' | 'domain-keyword' | 'title-keyword' | 'known-domain' | 'none';
}

// ── Category metadata ────────────────────────────────────────────────────────
const CATEGORY_META: Record<SiteCategory, Omit<CategoryResult, 'category' | 'signal'>> = {
    gambling: { label: 'Gambling', icon: '🎰', riskLevel: 'danger', filterType: 'block', trustDelta: -25 },
    adult: { label: 'Adult Content', icon: '🔞', riskLevel: 'danger', filterType: 'block', trustDelta: -20 },
    'file-download': { label: 'File Download', icon: '⬇️', riskLevel: 'danger', filterType: 'block', trustDelta: -15 },
    crypto: { label: 'Cryptocurrency', icon: '💰', riskLevel: 'caution', filterType: 'warn', trustDelta: -10 },
    gaming: { label: 'Gaming', icon: '🎮', riskLevel: 'caution', filterType: 'warn', trustDelta: -5 },
    pharma: { label: 'Pharma / Health', icon: '💊', riskLevel: 'caution', filterType: 'warn', trustDelta: -10 },
    shopping: { label: 'Shopping', icon: '🛍️', riskLevel: 'low', filterType: 'info', trustDelta: 0 },
    news: { label: 'News / Media', icon: '📰', riskLevel: 'low', filterType: 'info', trustDelta: 0 },
    education: { label: 'Education', icon: '🎓', riskLevel: 'low', filterType: 'info', trustDelta: +5 },
    social: { label: 'Social Media', icon: '👤', riskLevel: 'low', filterType: 'info', trustDelta: 0 },
    government: { label: 'Government', icon: '🏛️', riskLevel: 'trusted', filterType: 'none', trustDelta: +10 },
    blog: { label: 'Blog / Content', icon: '✍️', riskLevel: 'neutral', filterType: 'none', trustDelta: 0 },
    chat: { label: 'Chat / Messaging', icon: '💬', riskLevel: 'neutral', filterType: 'none', trustDelta: 0 },
    search: { label: 'Search Engine', icon: '🔍', riskLevel: 'trusted', filterType: 'none', trustDelta: +5 },
    streaming: { label: 'Streaming', icon: '🎬', riskLevel: 'low', filterType: 'info', trustDelta: 0 },
    finance: { label: 'Finance / Banking', icon: '🏦', riskLevel: 'low', filterType: 'info', trustDelta: +5 },
    tech: { label: 'Technology', icon: '💻', riskLevel: 'low', filterType: 'none', trustDelta: 0 },
    unknown: { label: 'Unknown', icon: '❓', riskLevel: 'neutral', filterType: 'none', trustDelta: 0 },
};

// ── Signal 1: TLD classification ─────────────────────────────────────────────
const TLD_MAP: Record<string, SiteCategory> = {
    // Education
    '.edu': 'education', '.ac.uk': 'education', '.ac.in': 'education',
    '.edu.au': 'education', '.edu.in': 'education',
    // Government
    '.gov': 'government', '.gov.in': 'government', '.gov.uk': 'government',
    '.gov.au': 'government', '.nic.in': 'government',
    // Gambling
    '.bet': 'gambling', '.casino': 'gambling', '.poker': 'gambling',
    '.bingo': 'gambling', '.lottery': 'gambling',
    // Shopping
    '.shop': 'shopping', '.store': 'shopping', '.market': 'shopping',
    // Crypto
    '.crypto': 'crypto', '.nft': 'crypto', '.blockchain': 'crypto',
    // News
    '.news': 'news', '.press': 'news', '.media': 'news',
    // Blog
    '.blog': 'blog',
};

// ── Signal 2: Domain keyword classification ──────────────────────────────────
// Each entry: [keyword[], category] — checked against hostname
const DOMAIN_RULES: [string[], SiteCategory][] = [
    // Gambling — highest priority (dangerous)
    [['casino', 'poker', 'bet365', 'betway', '888casino', 'roulette', 'slots',
        'gambling', 'lottery', 'lotto', 'sportsbet', 'betfair', 'draftkings',
        'fanduel', 'betmgm', 'playwin', '1xbet', 'parimatch'], 'gambling'],
    // Adult
    [['xxx', 'porn', 'adult', 'nude', 'sexy', 'nsfw', 'onlyfans', 'xvideo',
        'xhamster', 'brazzers', 'redtube'], 'adult'],
    // Crypto / Web3
    [['crypto', 'bitcoin', 'ethereum', 'binance', 'coinbase', 'metamask',
        'blockchain', 'defi', 'nft', 'web3', 'wallet', 'solana', 'dex',
        'uniswap', 'opensea'], 'crypto'],
    // File download sites
    [['download', 'crack', 'warez', 'torrent', 'pirate', 'nulled',
        'apkpure', 'apkmirror', 'softonic', 'filehippo'], 'file-download'],
    // Social media
    [['facebook', 'instagram', 'twitter', 'tiktok', 'snapchat', 'linkedin',
        'pinterest', 'reddit', 'tumblr', 'threads', 'mastodon'], 'social'],
    // Education
    [['coursera', 'udemy', 'edx', 'khanacademy', 'wikipedia', 'university',
        'college', 'school', 'academy', 'tutorial', 'learn', 'duolingo'], 'education'],
    // Shopping
    [['amazon', 'ebay', 'flipkart', 'myntra', 'meesho', 'snapdeal', 'aliexpress',
        'shopify', 'etsy', 'walmart', 'shop', 'store', 'cart', 'buy'], 'shopping'],
    // News
    [['news', 'times', 'tribune', 'herald', 'bbc', 'cnn', 'ndtv', 'thehindu',
        'reuters', 'bloomberg', 'guardian', 'post', 'daily'], 'news'],
    // Gaming
    [['steam', 'epicgames', 'roblox', 'minecraft', 'playstation', 'xbox',
        'twitch', 'ign', 'gamespot', 'gaming', 'gamer', 'esport'], 'gaming'],
    // Pharma
    [['pharma', 'drugstore', 'pharmacy', 'medicine', 'drugs', 'pills',
        'rx', 'prescription'], 'pharma'],
    // Chat / Messaging
    [['whatsapp', 'telegram', 'discord', 'slack', 'signal', 'chat',
        'messenger', 'wechat', 'line'], 'chat'],
    // Blog / Content
    [['blog', 'medium', 'substack', 'wordpress', 'blogger', 'ghost',
        'hashnode', 'dev.to'], 'blog'],
    // Streaming
    [['netflix', 'primevideo', 'hotstar', 'hulu', 'disneyplus', 'hbomax',
        'peacock', 'crunchyroll', 'spotify', 'jiosaavn', 'gaana', 'wynk',
        'sonyliv', 'zee5', 'voot', 'mxplayer', 'jiocinema'], 'streaming'],
    // Finance / Banking
    [['bank', 'paytm', 'phonepe', 'gpay', 'razorpay', 'stripe', 'paypal',
        'visa', 'mastercard', 'hdfc', 'icici', 'sbi', 'axis', 'kotak',
        'mutual', 'zerodha', 'groww', 'upstox', 'angel'], 'finance'],
    // Technology
    [['microsoft', 'apple', 'google', 'samsung', 'nvidia', 'intel', 'amd',
        'adobe', 'oracle', 'ibm', 'cisco', 'dell', 'hp', 'lenovo'], 'tech'],
    // Search engines
    [['bing', 'yahoo', 'duckduckgo', 'startpage', 'ecosia', 'brave'], 'search'],
];

// ── Signal 3: Page title keyword classification ──────────────────────────────
const TITLE_RULES: [string[], SiteCategory][] = [
    [['casino', 'bet', 'poker', 'roulette', 'slot', 'gambling', 'lottery', 'jackpot'], 'gambling'],
    [['porn', 'xxx', 'adult', 'nude', 'sex', 'nsfw'], 'adult'],
    [['bitcoin', 'crypto', 'ethereum', 'nft', 'defi', 'blockchain', 'web3'], 'crypto'],
    [['download', 'free download', 'crack', 'keygen', 'torrent'], 'file-download'],
    [['shop', 'cart', 'buy', 'price', 'checkout', 'order', 'store'], 'shopping'],
    [['course', 'learn', 'tutorial', 'university', 'lecture', 'education'], 'education'],
    [['news', 'breaking', 'headline', 'report', 'journalist'], 'news'],
    [['game', 'gaming', 'play now', 'esports', 'gamer'], 'gaming'],
    [['pharmacy', 'medication', 'prescription', 'drug', 'medicine'], 'pharma'],
];

// ── Signal 4: 50 known high-traffic domains ──────────────────────────────────
const KNOWN_DOMAINS: Record<string, SiteCategory> = {
    // Search
    'google.com': 'search', 'bing.com': 'search', 'duckduckgo.com': 'search',
    'yahoo.com': 'search', 'baidu.com': 'search',
    // Social
    'youtube.com': 'social', 'facebook.com': 'social',
    'instagram.com': 'social', 'twitter.com': 'social', 'x.com': 'social',
    'linkedin.com': 'social', 'reddit.com': 'social', 'tiktok.com': 'social',
    'pinterest.com': 'social', 'snapchat.com': 'social', 'threads.net': 'social',
    // Shopping
    'amazon.com': 'shopping', 'amazon.in': 'shopping', 'flipkart.com': 'shopping',
    'ebay.com': 'shopping', 'myntra.com': 'shopping', 'meesho.com': 'shopping',
    'aliexpress.com': 'shopping', 'walmart.com': 'shopping', 'etsy.com': 'shopping',
    // Education
    'wikipedia.org': 'education', 'coursera.org': 'education',
    'udemy.com': 'education', 'khanacademy.org': 'education',
    // News
    'bbc.com': 'news', 'cnn.com': 'news', 'ndtv.com': 'news',
    'thehindu.com': 'news', 'timesofindia.com': 'news',
    'reuters.com': 'news', 'bloomberg.com': 'news',
    // Crypto  
    'binance.com': 'crypto', 'coinbase.com': 'crypto',
    'opensea.io': 'crypto', 'metamask.io': 'crypto',
    // Blog / Content
    'github.com': 'tech', 'medium.com': 'blog', 'substack.com': 'blog',
    'stackoverflow.com': 'tech',
    // Chat
    'whatsapp.com': 'chat', 'telegram.org': 'chat', 'discord.com': 'chat',
    // Gaming
    'steam.com': 'gaming', 'epicgames.com': 'gaming', 'roblox.com': 'gaming',
    'twitch.tv': 'streaming',
    // Gambling
    'betway.com': 'gambling', 'bet365.com': 'gambling', '888casino.com': 'gambling',
    'betfair.com': 'gambling', 'draftkings.com': 'gambling', 'fanduel.com': 'gambling',
    '1xbet.com': 'gambling', 'parimatch.com': 'gambling', 'unibet.com': 'gambling',
    'pokerstars.com': 'gambling', 'williamhill.com': 'gambling',
    'dream11.com': 'gambling', 'my11circle.com': 'gambling',
    // Streaming
    'netflix.com': 'streaming', 'hotstar.com': 'streaming', 'primevideo.com': 'streaming',
    'disneyplus.com': 'streaming', 'hulu.com': 'streaming', 'spotify.com': 'streaming',
    'zee5.com': 'streaming', 'sonyliv.com': 'streaming', 'jiocinema.com': 'streaming',
    // Finance
    'paytm.com': 'finance', 'phonepe.com': 'finance', 'razorpay.com': 'finance',
    'paypal.com': 'finance', 'zerodha.com': 'finance', 'groww.in': 'finance',
    // Technology
    'microsoft.com': 'tech', 'apple.com': 'tech', 'adobe.com': 'tech',
    'nvidia.com': 'tech', 'samsung.com': 'tech',
};

export function classifyLink(
    domain: string,
    pageTitle: string = ''
): CategoryResult {
    const domainLower = domain.toLowerCase().replace(/^www\./, '');
    const titleLower = pageTitle.toLowerCase();

    const make = (cat: SiteCategory, signal: CategoryResult['signal']): CategoryResult =>
        ({ category: cat, signal, ...CATEGORY_META[cat] });

    for (const [tld, cat] of Object.entries(TLD_MAP)) {
        if (domainLower.endsWith(tld)) return make(cat, 'tld');
    }

    for (const [keywords, cat] of DOMAIN_RULES) {
        if (keywords.some(kw => domainLower.includes(kw)))
            return make(cat, 'domain-keyword');
    }

    if (titleLower.length > 0) {
        for (const [keywords, cat] of TITLE_RULES) {
            if (keywords.some(kw => titleLower.includes(kw)))
                return make(cat, 'title-keyword');
        }
    }

    const known = KNOWN_DOMAINS[domainLower];
    if (known) return make(known, 'known-domain');

    return make('unknown', 'none');
}
