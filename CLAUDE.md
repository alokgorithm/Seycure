# Seycure — Project Context for Claude Code

This is the single source of truth for this repository. Read it fully before
writing any code. If a request conflicts with "Locked decisions", say so rather
than silently complying.

---

## 1. Who and what

**App:** Seycure — a privacy utility for Android.
**Brand:** ArkQube (the owner's independent development brand).
**Owner:** Alok Nath, solo developer, final-year MCA student at NIT Kurukshetra.
**Play Console account:** individual, owned by `arkqube@gmail.com`.
**Package name:** `com.arkqube.seycure`. Renamed from `com.arkqube.clrlink` on
2026-09-08, before any release. It is permanent once published — do not change it.
**Licence:** proprietary, all rights reserved.

**Owner's capacity: about 5 hours per week.** This is the hardest constraint in
the project. Every proposal should be judged against it. Prefer the boring,
maintainable option over the clever one. Break work into chunks that can be
reviewed in under an hour.

## 2. Current state

The app is at **v2.4 and has never been published**. It works but has never
faced Play review, real users, or a store listing. Three modes exist:

| Mode | What it does | Status |
|---|---|---|
| **Privacy Blur** | On-device ML Kit OCR finds sensitive text in screenshots (emails, phones, IDs, bank details), auto-blurs it. Manual blur editor. Learns always-blur / never-blur rules. | The product — see §4 |
| **Media Scrubber** | Strips EXIF from images, metadata from PDF and DOCX, locally. Anonymous export and rename. | Bundled feature |
| **Link Shield** | Unwraps shortened URLs, strips 30+ tracker params, classifies links into 13 categories, computes a 15-signal trust score, optional Google Safe Browsing check. QR scanning via camera or gallery. | Bundled feature |

Before starting Phase 0, verify how complete each mode actually is on a physical
device. The README is more polished than the commit history; do not assume
anything works until you have seen it run.

## 3. Technical stack

**Frontend:** React 18, TypeScript, Vite 7, shadcn/ui + vanilla CSS, Lucide icons.
**Libraries:** `exifr` (EXIF), `html5-qrcode` (QR + WebRTC zoom), `pdf-lib` (PDF
metadata), `jszip` (DOCX metadata).
**Native bridge:** Capacitor v6 — `@capacitor/share`, `@capacitor/filesystem`,
`@capacitor/app`, `@capacitor/preferences`. Google ML Kit for on-device OCR.
**Backend (optional):** Cloudflare Worker as an edge proxy for Google Safe
Browsing, with KV cache, request coalescing, batching, and per-IP rate limiting.

**Repo layout:**

```
app/           React + Vite frontend, with app/android/ as the Capacitor project
worker/        Cloudflare Worker (wrangler)
```

**Build commands:**

```bash
cd app && npm install --legacy-peer-deps
npm run dev                    # web dev server
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug
```

Test on a **physical Android 13+ device**. Emulators will mislead you on camera,
file chooser, and OCR behaviour.

## 4. Product positioning — this is the most important section

The app currently presents as a three-mode privacy toolkit. **That is the single
biggest problem with it commercially.** Play Store search rewards one clear job;
a toolkit ranks for nothing and competes against dedicated apps in three
categories at once, losing all three.

**Privacy Blur is the product.** Everyone who posts a screenshot to Reddit, X,
WhatsApp, or a support ticket has this problem repeatedly. Every competing "blur
photo" app makes the user drag rectangles manually. Seycure finds the phone
numbers and emails and IDs by itself. That automatic detection is the entire
marketing story and the only real differentiator in the app.

Media Scrubber and Link Shield stay in the app. They add value, help retention,
and earn goodwill in reviews. They never lead the title, icon, or first
screenshot.

**Target search queries:** blur screenshot · censor screenshot · hide personal
information photo · redact image · remove exif data · photo metadata remover.

## 5. Business context

**Revenue goal:** ₹5,000/month by month 4, ₹30,000–40,000/month by month 12.

**Model:** one-time **Pro unlock at $4.99** (nets about ₹370 after Google's 15%),
plus rewarded video only. No subscription.

Reasoning: ad revenue scales with monthly actives, and a utility like this has
weak retention — people scrub metadata occasionally, not daily. A one-time unlock
scales with *new installs* instead, so a user who buys on day one and never
returns has still paid in full. It also converts better on impulse, has zero
churn, and suits a privacy audience that is hostile to subscriptions.

**Distribution:** Play Store search only. No ad budget. Every feature should be
judged by whether it helps us rank for a keyword or protects our star rating.

**Free tier:** manual blur unlimited · auto-detect 3 images/day · basic patterns
(email, phone) · single-file metadata stripping · Link Shield · QR scanning.

**Pro:** unlimited auto-detect · batch processing · full pattern set · learned
rules · PDF and DOCX scrubbing.

## 6. Locked decisions

Do not revisit these without asking the owner first.

1. **Privacy Blur leads.** The other modes are secondary.
2. **One-time $4.99 unlock. No subscription.**
3. **Rewarded video only.** No interstitials, no banners. A privacy app showing
   tracking ads gets destroyed in reviews.
4. **No broad media permissions, ever.** See §7.
5. **No analytics beyond crash reporting.** No Firebase Analytics, no Amplitude,
   no event telemetry. Policy and brand decision both.
6. **No third-party billing SDK.** Use the Play Billing Library directly, not
   RevenueCat. RevenueCat receives device identifiers and purchase data, which
   would have to be declared in Data Safety and contradicts the app's pitch.
7. **No new outbound network dependencies.** Anything leaving the device goes
   through our own Cloudflare Worker.
8. **On-device first.** Images and documents never leave the device. This is the
   product promise and it is not negotiable for a feature's convenience.

## 7. Policy constraints — violating these gets the app suspended

**Media permissions.** Google's Photo & Video Permissions policy bars
`READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` for apps needing only one-time or
infrequent access to user-selected files. Seycure picks a file, processes it,
done — exactly the barred pattern. The app currently declares
`READ_MEDIA_IMAGES` and `READ_EXTERNAL_STORAGE`. **Both must go.**

**Permission audit — done 2026-09-08, do not re-run.** The merged debug manifest
(`app/android/app/build/intermediates/merged_manifest/debug/`) declares exactly
seven permissions. Provenance, from the manifest-merger blame report:

| Permission | Where it comes from | Verdict |
|---|---|---|
| `INTERNET` | our manifest | keep |
| `CAMERA` | our manifest | keep |
| `READ_MEDIA_IMAGES` | our manifest, line 6 | **delete** |
| `READ_EXTERNAL_STORAGE` (`maxSdkVersion=32`) | our manifest, line 7 | **delete** |
| `WRITE_EXTERNAL_STORAGE` (`maxSdkVersion=28`) | our manifest, line 8 | **delete** |
| `ACCESS_NETWORK_STATE` | `transport-backend-cct:2.3.3`, via ML Kit | keep, see below |
| `<applicationId>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | androidx, derived from `applicationId` | keep |

The finding that matters: **no Capacitor plugin declares any permission at all.**
`@capacitor/android`, `app`, `filesystem`, `preferences`, `share` and
`capacitor-cordova-android-plugins` all ship manifests with zero
`uses-permission` entries. All three offending permissions are hand-written in
our own `AndroidManifest.xml`, so deleting those three lines removes them from
the merged manifest. **No `tools:node="remove"` is needed anywhere.**

`ACCESS_NETWORK_STATE` is injected by
`com.google.android.datatransport:transport-backend-cct:2.3.3` (also merged from
`transport-runtime:2.2.6`), which arrives with ML Kit text recognition. It is a
*normal* permission, not a dangerous one: it triggers no runtime prompt, is not
covered by the Photo & Video Permissions policy, and cannot be stripped without
risking ML Kit's telemetry transport. **It stays.**

So the final permission set is **`CAMERA`, `INTERNET` and `ACCESS_NETWORK_STATE`**,
plus the self-scoped androidx receiver permission. This supersedes the earlier
"`CAMERA` and `INTERNET` only" target, which predated the audit and was wrong
about what ML Kit drags in. Do not try to remove `ACCESS_NETWORK_STATE`.

Preferred replacement for the media access: a plain
`<input type="file" accept="image/*">` in the WebView, which routes to the system
chooser and needs **no permission at all**. Fallback: a Capacitor plugin using the
Android Photo Picker (`ACTION_PICK_IMAGES`).

**Billing.** One-time purchases must be **non-consumable**. Acknowledge every
purchase within 72 hours or Google auto-refunds it and revokes access — this is
the most common billing bug in first apps. A visible **Restore Purchases** button
in Settings is required; its absence is a common rejection reason.

No login is needed. Play ties the purchase to the user's Google account plus the
package name. On launch and on every resume, call `queryPurchases()` and unlock
if the product is owned. Cache the entitlement in Preferences so the app works
offline, but re-verify on resume so refunds re-lock correctly.

**Data Safety form.** Declare that URLs submitted to Link Shield go to our Worker
and to Google Safe Browsing, and that `rdap.org` receives domain lookups. Declare
that images and documents never leave the device. Being caught under-declaring is
far worse than declaring accurately.

**Other requirements:** privacy policy at a public URL, content rating
questionnaire, target API level 35, signed app bundle.

## 8. Quality bar

Star rating drives search ranking, ranking drives installs, installs drive
revenue. So rating is the business metric, not a vanity one.

- Auto-detection must complete in **under 2 seconds** after file selection.
- Crash-free sessions ≥ 99.5%. Wrap file and camera paths defensively.
- Never show an ad before the user's first successful blur.
- Rating prompt fires after the **third** successful blur, never earlier.
- Detection stays **strict by default**. A false positive costs one tap; a false
  negative leaks someone's Aadhaar number into a public tweet and earns a
  one-star review that is completely deserved.

## 9. Build phases

Work in order. Do not start a phase until the previous one passes on a real
device. One phase per branch.

**Phase 0 — Policy blockers.** ~~Audit permissions across the repo and the merged
manifest~~ — **done, see §7; no plugin injects anything, all three offending
permissions are ours to delete.** Replace
media access with the system file chooser. Fix output saving to need no storage
permission (app-specific storage plus share sheet, or MediaStore into Downloads).
Move the `allorigins.win` dependency into our own Worker as `/resolve` and
`/title` endpoints reusing the existing cache and rate limiting. Add Crashlytics
only. *Acceptance: merged manifest has only `CAMERA`, `INTERNET` and the ML Kit
`ACCESS_NETWORK_STATE` (see §7); all three modes work end to end; no request goes
anywhere except our Worker and rdap.org.*

**Phase 1 — Reposition around Privacy Blur.** App opens directly into Privacy
Blur with a visible "Pick a screenshot" action; other modes become secondary
tabs. Run OCR and detection immediately on import with no extra tap. Show a count
("Found 4 sensitive items") — that sentence is the product. Make every detection
individually toggleable plus a blur-all action. Add a redaction style toggle:
blur, pixelate, solid black bar. Verify patterns against real Indian and
international formats: email, phone with and without country code, Aadhaar-style
12-digit, PAN, credit card, IBAN, IFSC, address, DOB, IP, tracking numbers.
*Acceptance: detections appear in under 2 seconds, all three redaction styles
export correctly, manual editor still works.*

**Phase 2 — Free/Pro gating.** Daily quota in `@capacitor/preferences` as
`{ date, count }`, reset on date change, local device date, no server. Play
Billing directly with product `seycure_pro`, non-consumable. Acknowledge on
purchase. Query on launch and resume. Restore button in Settings. Paywall fires
only when a free user hits the quota or taps a Pro feature — never on launch,
never before a successful blur. *Acceptance: fresh install gets 3 auto-detects
then the paywall; test purchase unlocks; entitlement survives restart; restore
works on a second device with the same Google account.*

**Phase 3 — Rewarded ads.** `@capacitor-community/admob`, rewarded video only,
offered alongside Pro when the quota is hit. Grants exactly 3 more uses. The ad
SDK must not initialise at all for Pro users.

**Phase 4 — Store readiness.** Title (30 chars): `Blur Screenshot: Hide Info`.
Short description (80): `Auto-detect and blur emails, phone numbers and IDs in
your screenshots.` Eight screenshots, first three carrying the argument:
before/after with detections found, the "Found 4 sensitive items" state, the
three redaction styles. Then batch mode, metadata stripping, Link Shield,
on-device promise, Pro unlock. Privacy policy hosted. Data Safety completed.
Content rating done.

**Phase 5 — Closed testing.** Individual accounts must run a closed test with 12
testers for 14 continuous days before production access. Owner task, runs in
parallel with Phases 0–4.

**Phase 6 — Post-launch.** Ship every 3–4 weeks; Play ranking rewards recency.
Month 2: fixes from first reviews, listing localised into 8 languages. Month 4:
**share-sheet integration** so users can send a screenshot into Seycure from any
app — this is the highest-value item on the roadmap because it turns Seycure from
an app you remember to open into a step in a workflow, which is the only real
retention lever available. Month 7: video redaction or face blurring. Month 10:
whatever reviews are asking for.

## 10. Working agreement

- Before writing code for a task, list the files you intend to touch.
- One phase per branch, small commits.
- Explain any new dependency before adding it; keep the list minimal.
- Flag anything touching a Play policy immediately, even if not asked.
- Prefer readable code over clever code.
- If a task will take the owner more than an hour to review, split it.
- Do not add features that are not in this document without asking.

## 11. Owner's blocking tasks (not Claude Code's)

1. Play Console account and identity verification — **in progress**
2. `arkqube.github.io` for the privacy policy and landing page
3. Recruit 12 closed testers
4. AdMob account, app ID, rewarded ad unit ID
5. Physical Android 13+ test device
6. Decide on a public address for the developer profile (monetised individual
   accounts display the owner's full legal address publicly)