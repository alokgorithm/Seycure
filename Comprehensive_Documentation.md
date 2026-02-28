# Seycure: Exhaustive Technical & Architectural Documentation

## 1. Executive Summary & Purpose
Seycure is a strictly privacy-first, hybrid mobile application (built using React, Vite, and Capacitor) designed to protect users against malicious URLs and privacy-compromising media metadata.

Instead of relying on a centralized proprietary backend (which incurs costs and privacy risks), Seycure is designed as a **Decentralized Verification Engine**. It relies entirely on native edge capabilities, open CORS proxies (`allorigins.win`), public registries (`rdap.org`), and a serverless secret vault (Cloudflare Workers) to execute its features safely and at zero cost.

---

## 2. Complete Technology Stack
### Frontend ⚛️
* **Core Framework:** React 18, utilizing functional components and hooks (`useState`, `useEffect`, `useCallback`, `useRef`).
* **Language:** TypeScript 5.
* **Bundler & Build Tool:** Vite (offering ultra-fast HMR in dev and Rollup in production).
* **Styling Engine:** Tailwind CSS 3 combined with a custom headless UI component architecture (Shadcn UI).
* **Iconography:** `lucide-react` (SVG-based reactive icons).

### Native Bridge & Mobile Enablers (Capacitor) 📱
* **Runtime:** Capacitor v6.
* **Target OS:** Android (Target SDK 34, Min SDK 22).
* **Native Plugins Used:**
  * `@capacitor/share`: Intercepts web `navigator.share` events and bridges them to the native Android `Intent.ACTION_SEND` Share Sheet.
  * `@capacitor/filesystem`: Bridges JavaScript `Blob`/`Base64` data to native physical storage (saving exported media to Android's `Directory.Documents`).

### Backend (Serverless Cloudflare Worker) ☁️
* **Platform:** Cloudflare Workers (`ark-cmd.workers.dev`).
* **Purpose:** The frontend React bundle cannot securely store the `GOOGLE_SAFE_BROWSING_API_KEY`. The worker acts as an encrypted proxy edge function.

---

## 3. High-Level System Architecture Flow

```mermaid
flowchart TD
    %% Core Client Application
    App[📱 Seycure React App\nRuns inside Capacitor WebView]
    
    %% Mode 1: Link Shield Cluster
    subgraph LinkShield [Link Shield: Threat & Trust Engine]
        InputURL{User URL Input\n(Paste or QR)}
        CleanEngine[URL Cleaning Engine\nStrips ?utm_, ?fbclid]
        LocalHeuristics[Local Regex Heuristics\nChecks IPs, Suspicious TLDs]
        
        RDAPProxy[rdap.org API\nPublic Bootstrap Registry]
        CORSProxy[allorigins.win\nRedirect Follower Proxy]
        CFWorker[Cloudflare Worker\nEdge Secret Vault]
        GoogleSafeBrowsing[(Google Safe Browsing DB)]
        
        InputURL --> CleanEngine
        CleanEngine --> LocalHeuristics
        
        %% API Branches
        LocalHeuristics -->|Request WHOIS/Age| RDAPProxy
        LocalHeuristics -->|Follow Redirect Chain| CORSProxy
        LocalHeuristics -->|Request Threat Scan| CFWorker
        
        CFWorker -->|Encrypted POST auth| GoogleSafeBrowsing
    end
    
    %% Mode 2: Media Scrubber Cluster
    subgraph MediaScrubber [Media Scrubber: Privacy Engine]
        InputMedia{User Media Input\n(Capacitor File Picker)}
        ExifParser[exifr Library\nDeep Array Buffer Scan]
        CanvasSanitizer[HTML5 Canvas\nHardware-Accelerated Pixel Redraw]
        Anonymizer[Anon Generator\nArkQube_UUID renaming]
        
        FileSystem[Capacitor FileSystem\nSaves to /Documents]
        ShareSheet[Capacitor Share\nSends to WhatsApp/Insta]
        
        InputMedia --> ExifParser
        ExifParser -->|Flags GPS/Device Data| CanvasSanitizer
        CanvasSanitizer -->|Outputs Cleaned Base64| Anonymizer
        Anonymizer --> FileSystem
        Anonymizer --> ShareSheet
    end

    App --> LinkShield
    App --> MediaScrubber
```

---

## 4. Complete File & Folder Structure

```text
a:\DEV\clrlink\
├── README.md                      (Primary User Documentation)
│
├── worker/                        (Serverless Edge Proxy)
│   ├── package.json               (Worker dependencies)
│   ├── wrangler.toml              (Cloudflare config, binds to clrlink-safe-browsing)
│   └── src/
│       └── index.ts               (Handles /redirects CORS tracing, and Safe Browsing POSTs)
│
└── app/                           (Main Hybrid Client Application)
    ├── package.json               (React & Capacitor dependencies)
    ├── vite.config.ts             (Vite bundler configuration)
    ├── tailwind.config.js         (Shadcn UI & Tailwind color schemas)
    ├── capacitor.config.ts        (Capacitor init, sets app id `com.arkqube.clrlink`)
    ├── index.html                 (Root entrypoint, disables pinch-to-zoom)
    │
    ├── android/                   (Native Android Studio Project)
    │   ├── build.gradle           (Root gradle config)
    │   ├── variables.gradle       (SDK versions: targetSdkVersion 34)
    │   └── app/
    │       ├── build.gradle       (App-level config: minifyEnabled true)
    │       ├── proguard-rules.pro (Capacitor keep rules for minification)
    │       └── src/main/
    │           ├── AndroidManifest.xml (Hardware Permissions: Camera, Storage)
    │           └── res/
    │               ├── values/styles.xml (Android 12+ Animated Splash Definitions)
    │               └── drawable/splash.xml (Pure white native launch background)
    │
    ├── public/
    │   └── arkqube-logo.png       (Static image assets)
    │
    └── src/                       (React Source Root)
        ├── main.tsx               (React DOM setup and StrictMode)
        ├── App.tsx                (The Monolithic Core UI, Routing, & Logic File)
        ├── index.css              (Global CSS & custom @keyframes like `.animate-splash-fade`)
        │
        ├── hooks/
        │   └── useNativeShare.ts  (Capacitor native share capability modular hook)
        │
        ├── lib/
        │   └── utils.ts           (Tailwind clsx/tailwind-merge utilities)
        │
        └── components/ui/         (Shadcn Headless UI Components)
            ├── button.tsx         (Styled interactive buttons)
            ├── dialog.tsx         (Radix UI powered modals for QR Scanner & sandboxed Browser)
            ├── input.tsx          (Main URL extraction text field)
            └── ... (Other primitive generic UI elements)
```

---

## 5. Exhaustive Workflow Breakdown (Step-by-Step)

### 5.1 Link Shield (`LinkShield` Component in `App.tsx`)
The `LinkShield` is responsible for parsing strings and analyzing technical threat vectors.

**State Management:**
* `url`: User's raw input string.
* `analysis`: A complete `LinkAnalysis` object containing the cleaned URL, shortener status, file risk, trust metrics, etc.

**Execution Flow (`analyzeUrl`):**
1. **Cleaning (`cleanUrl`):** Iterates over an array of known tracking parameters (`TRACKER_PARAMS` e.g., `utm_source`, `fbclid`). Applies `URL.searchParams.delete()` to strip the payload.
2. **File Risk Parsing (`getFileRisk`):** Matches the URL's trailing `.ext` against a `DANGEROUS_EXTENSIONS` dictionary (e.g., `.exe` = critical, `.zip` = medium).
3. **Local Domain Validation:** 
   * Compares the hostname to `SUSPICIOUS_TLDS` (e.g., `.tk`, `.loan`). 
   * Detects explicit IP addresses masquerading as domains (e.g., `192.168.1.1`).
   * Verifies the presence of `https://`.
4. **Metadata Extraction:** Fires a `fetch` request to `api.allorigins.win`. Uses this proxy to securely download the target site's `<head>` attributes. Uses Regex to scrape `<meta property="og:title">` and descriptions to assemble a preview card dynamically.
5. **Shortener Redirect Follower:** If the domain matches `SHORTENER_DOMAINS` (e.g., `bit.ly`), the `allorigins.win` payload returns the *final destination* of the HTTP 301/302 redirect chain in a property called `status.url`. This prevents the user from being blindly redirected to a payload.
6. **Domain Trust Analyzer (RDAP Integration):**
   * Calls `https://rdap.org/domain/<domain>`.
   * Loops through the JSON response `events` searching for `eventAction === 'registration'` to mathematically compute the `domainAgeDays`.
   * Scrapes the `roles: ['registrar']` object to extract the legal Registrar Name.
   * Computes a local `trustScore` out of 100 based on age (<30 days gets penalized), HTTPs, and TLDs.
7. **Cloudflare Worker Safe Browsing Request (`checkUrlThreat`):**
   * Pre-fetches `https://clrlink-safe-browsing.arka-cmd.workers.dev/check?url=<url>`.
   * The Worker proxies this securely to Google's API.
   * Modifies the UI state to display either `Safe` or `MALWARE / SOCIAL_ENGINEERING`.
8. **Sandboxed Browser (`BrowserModal`):** If the user clicks "Open Safely", the `cleanedUrl` is rendered inside an `<iframe>` wrapped with the severely restricted `sandbox="allow-same-origin allow-scripts"` attribute.

### 5.2 Media Scrubber (`MediaScrubber` Component in `App.tsx`)
The `MediaScrubber` destroys hidden EXIF metadata specifically designed to identify users.

**State Management:**
* `files`: An array of `FileCard` interfaces tracking the upload, scanning phase, extracted metadata, and the cleaned Base64 byte array.

**Execution Flow (`processFile`):**
1. **File Ingestion:** The user triggers a native Android file picker via an invisible `<input type="file">`.
2. **Analysis (`exifr.parse`):** Uses the `exifr` module to parse the exact binary ArrayBuffer of the uploaded file natively in the browser memory. Specifically extracts `latitude`, `longitude`, `Make`, `Model`, and `Software` tags to display a warning badge about what data the file contained.
3. **Sanitization (The HTML5 Canvas Hack):**
   * Loads the original file into an isolated `Image()` object `URL.createObjectURL(file)`.
   * Creates a programmatic `<canvas>` sized exactly to the image's `naturalWidth/naturalHeight`.
   * Excutes `ctx.drawImage(img, 0, 0)`.
   * Calls `canvas.toDataURL('image/jpeg', 0.95)`.
   * **Why this works:** The Canvas API interacts strictly with flat RGBA pixel data. When it exports the string, it physically cannot carry over the EXIF header boundaries from the original file buffer. The metadata is permanently deleted.
4. **Export Automation (`handleDownload` / `handleShare`):**
   * Uses `getAnonymousFilename()` to rename `IMG_20231024_153022.jpg` to a generic ID like `ArkQube_1702830_x9a2.jpg`.
   * Pipes the cleaned Base64 string directly into `@capacitor/filesystem` to silently write to `Directory.Documents`, or routes it to `@capacitor/share` to pop open the Android OS intent sharing menu.

### 5.3 Hardware QR Code Scanner (`QRScannerModal`)
* Initializes the `Html5Qrcode` camera singleton. 
* Uses internal timeout loops (30s) and handles `Permission Denied` exceptions if the user restricts the Android Camera API. 
* Supports a "From Gallery" feature where it accepts a static image and runs the decoding algorithm mathematically on the static pixels without needing the physical camera module.

### 5.4 Application Root & Splash Lifecycle (`App` & `SplashScreen`)
1. Capacitor boots up, loading the native Android 12+ Splash Screen (Which is deliberately set to pure `#FFFFFF` white).
2. The WebView executes JavaScript, rendering the `<SplashScreen />` React Component overlay.
3. A custom CSS animation (`@keyframes splashFadeOut`, `textScale`, `textReveal`) orchestrates a 3-second animated text presentation ("Seycure by ArkQube").
4. The React state flips `showSplash` to false, yielding the user heavily to the primary `ModeToggle` (Link Shield or Media Scrubber).

---

## 6. Security Posture & Permissions Rationale
* **`android.permission.CAMERA`:** Exclusively triggered by explicit user interaction with the "Start Camera" QR button.
* **`android.permission.READ_MEDIA_IMAGES` (API 33+):** Scoped access heavily restricted strictly to Visual Media (Images/Videos) for EXIF analysis.
* **`android.permission.READ_EXTERNAL_STORAGE / WRITE_EXTERNAL_STORAGE`:** Necessary fallback permutations for supporting the Capacitor FileSystem on Android SDKs below 32 (Android 12).
* **Network Isolation:** No user payloads (images, user web history, specific input strings) are stored on any backend database. The external fetch calls are strictly transient GET/HEAD requests to public anonymizing CORS gateways.
