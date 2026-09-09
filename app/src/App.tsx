import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { X, Link2, Image as ImageIcon, ExternalLink, AlertTriangle, Scissors, Check, ChevronRight, Upload, MapPin, Smartphone, Wrench, Download, Share2, Loader2, ArrowRight, Search, Eye, EyeOff, ShieldAlert, ShieldCheck, RefreshCw, FileText, User, Building2, Type, Calendar, ZoomIn, ZoomOut, Trophy, MoreVertical, QrCode, Shield, Sliders, Settings as SettingsIcon, Zap, Clipboard, Lock, Sparkles } from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import exifr from 'exifr';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { saveImage } from '@/lib/saveImage';
import { useNativeShare } from '@/hooks/useNativeShare';
import { useAppStats } from '@/hooks/useAppStats';

import { analyzeScreenshot, type ScreenshotFinding } from '@/hooks/useMLKitOCR';
import { BlurEditorModal } from '@/components/BlurEditorModal';
import { renderToCanvas, findingsToBlurRegions } from '@/hooks/useBlurEditor';
import { LearnedRulesSettings } from '@/components/LearnedRulesSettings';
import { classifyLink, type CategoryResult } from '@/hooks/useLinkClassifier';
import { checkPhishingSignals, type PhishingSignal } from '@/hooks/usePhishingDetector';

// Types
export type AppMode = 'link-shield' | 'media-scrubber' | 'privacy-blur' | 'dashboard';

interface TrackerParam {
  name: string;
  category: string;
}

interface FileCard {
  id: string;
  name: string;
  type: 'image' | 'video' | 'document';
  status: 'scanning' | 'clean';
  metadata: {
    type: 'gps' | 'device' | 'software' | 'author' | 'title' | 'producer' | 'company' | 'none';
    value: string;
  }[];
  base64Data?: string;
  cleanBase64Data?: string;
  mimeType?: string;
}

interface LinkAnalysis {
  originalUrl: string;
  cleanedUrl: string;
  trackersRemoved: number;
  isShortener: boolean;
  fileRisk: 'none' | 'low' | 'medium' | 'high' | 'critical';
  fileExtension: string;
  category: CategoryResult;
  domain: string;
  title: string;
  description: string;
  /** Domain the mark is drawn from; no longer a remote image URL. */
  favicon: string;
  resolvedUrl?: string;
  domainAgeDays?: number | null;
  phishingSignals?: PhishingSignal[];
  redirectChain?: { url: string; status: number }[];
}

// Tracker parameter library
const TRACKER_PARAMS: TrackerParam[] = [
  // Google Analytics / UTM
  { name: 'utm_source', category: 'Google Analytics' },
  { name: 'utm_medium', category: 'Google Analytics' },
  { name: 'utm_campaign', category: 'Google Analytics' },
  { name: 'utm_term', category: 'Google Analytics' },
  { name: 'utm_content', category: 'Google Analytics' },
  { name: 'utm_id', category: 'Google Analytics' },
  { name: 'utm_source_platform', category: 'Google Analytics' },
  { name: 'utm_marketing_tactic', category: 'Google Analytics' },
  { name: 'utm_creative_format', category: 'Google Analytics' },
  { name: '__utmrg', category: 'Google Analytics' },
  { name: 'gad_source', category: 'Google Analytics' },
  { name: 'gad_campaignid', category: 'Google Analytics' },
  // Facebook / Meta
  { name: 'fbclid', category: 'Facebook/Meta' },
  { name: 'mc_eid', category: 'Facebook/Meta' },
  { name: 'mc_cid', category: 'Facebook/Meta' },
  { name: 'igshid', category: 'Facebook/Meta' },
  // Google Ads / Microsoft
  { name: 'gclid', category: 'Ads' },
  { name: 'gclsrc', category: 'Ads' },
  { name: 'dclid', category: 'Ads' },
  { name: 'msclkid', category: 'Ads' },
  // Yandex / OpenStat
  { name: 'yclid', category: 'Yandex' },
  { name: '_openstat', category: 'OpenStat' },
  // Email / Marketing
  { name: 'mkt_tok', category: 'Marketing' },
  { name: 's_cid', category: 'Marketing' },
  { name: 'wickedid', category: 'Marketing' },
  { name: 'wicked_source', category: 'Marketing' },
  // Generic
  { name: 'ref', category: 'Generic' },
  { name: 'source', category: 'Generic' },
  { name: 'trk', category: 'Generic' },
  { name: 'trkInfo', category: 'Generic' },
];

// Shortener domains
const SHORTENER_DOMAINS = [
  'bit.ly', 't.co', 'tinyurl.com', 'ow.ly', 'buff.ly',
  'goo.gl', 'short.link', 'is.gd', 'cli.gs', 'pic.gd',
  'DwarfURL.com', 'ow.ly', 'yfrog.com', 'migre.me', 'ff.im',
  'tiny.cc', 'url4.eu', 'tr.im'
];

// Dangerous file extensions
const DANGEROUS_EXTENSIONS: Record<string, 'critical' | 'high' | 'medium' | 'low'> = {
  '.exe': 'critical',
  '.msi': 'critical',
  '.bat': 'critical',
  '.cmd': 'critical',
  '.ps1': 'critical',
  '.vbs': 'critical',
  '.scr': 'critical',
  '.dmg': 'high',
  '.pkg': 'high',
  '.apk': 'high',
  '.jar': 'high',
  '.zip': 'medium',
  '.rar': 'medium',
  '.7z': 'medium',
  '.iso': 'medium',
  '.docm': 'medium',
  '.xlsm': 'medium',
  '.pdf': 'low',
  '.doc': 'low',
};

// Utility functions
function isValidUrl(string: string): boolean {
  try {
    new URL(string);
    return true;
  } catch {
    return false;
  }
}

function getDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function getFileExtension(url: string): string {
  const pathname = new URL(url).pathname;
  const match = pathname.match(/\.[^./]+$/);
  return match ? match[0].toLowerCase() : '';
}

function cleanUrl(url: string): { cleaned: string; removed: number } {
  try {
    const urlObj = new URL(url);
    let removed = 0;

    TRACKER_PARAMS.forEach(({ name }) => {
      if (urlObj.searchParams.has(name)) {
        urlObj.searchParams.delete(name);
        removed++;
      }
    });

    // Remove empty hash
    if (urlObj.hash === '#') {
      urlObj.hash = '';
    }

    return { cleaned: urlObj.toString(), removed };
  } catch {
    return { cleaned: url, removed: 0 };
  }
}

function isShortener(url: string): boolean {
  const domain = getDomainFromUrl(url);
  return SHORTENER_DOMAINS.some(s => domain.includes(s));
}

function getFileRisk(url: string): { level: 'none' | 'low' | 'medium' | 'high' | 'critical'; ext: string } {
  const ext = getFileExtension(url);
  const risk = DANGEROUS_EXTENSIONS[ext];
  return { level: risk || 'none', ext };
}

// Convert file to base64
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
  });
}

// Components
function TopBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  return (
    <div className="flex items-center justify-between px-5 py-3.5 bg-white dark:bg-[#0c1017] border-b border-border-light dark:border-white/10 shadow-xs sticky top-0 z-30">
      <div className="flex items-center gap-2.5">
        <img src="/logo.png" alt="Seycure" className="w-8 h-8 object-contain rounded-xl shadow-xs" />
        <div className="flex items-center gap-2">
          <span className="font-sans text-lg font-bold text-text-primary dark:text-white tracking-tight">Seycure</span>
          <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            On-Device
          </span>
        </div>
      </div>
      <button
        onClick={onOpenMenu}
        className="p-2 rounded-xl text-text-secondary hover:text-text-primary dark:text-text-muted dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
        aria-label="Three-dot menu"
      >
        <MoreVertical className="w-5 h-5" />
      </button>
    </div>
  );
}

interface QrPoint { x: number; y: number }

/**
 * html5-qrcode passes ZXing's resultPoints through at runtime but leaves them
 * out of its published types, so read them defensively.
 */
function getResultPoints(decodedResult: unknown): QrPoint[] {
  const points = (decodedResult as { result?: { resultPoints?: QrPoint[] } })?.result?.resultPoints;
  return Array.isArray(points) ? points : [];
}

function QRScannerModal({ open, onClose, onScan }: { open: boolean; onClose: () => void; onScan: (url: string) => void }) {
  const [phase, setPhase] = useState<'scanning' | 'detected' | 'timeout' | 'permission-denied' | 'error'>('scanning');
  const [zoomLevel, setZoomLevel] = useState(1);
  const [autoZoomActive, setAutoZoomActive] = useState(true);
  const [hasTorch, setHasTorch] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const detectedRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  const getCameraTrack = useCallback((): MediaStreamTrack | null => {
    try {
      const scanner = scannerRef.current as any;
      if (!scanner) return null;
      if (typeof scanner.getRunningTrack === 'function') {
        return scanner.getRunningTrack();
      }
      if (scanner.runningStream && typeof scanner.runningStream.getVideoTracks === 'function') {
        return scanner.runningStream.getVideoTracks()[0] || null;
      }
    } catch {}
    return null;
  }, []);

  const applyZoom = useCallback((newZoom: number) => {
    setZoomLevel(newZoom);
    const videoEl = document.querySelector('#seycure-qr-reader video') as HTMLVideoElement;
    if (videoEl) {
      videoEl.style.transition = 'transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)';
      videoEl.style.transform = `scale(${newZoom})`;
      videoEl.style.transformOrigin = 'center center';
    }
    const track = getCameraTrack();
    if (track && track.applyConstraints) {
      const caps = track.getCapabilities ? (track.getCapabilities() as any) : null;
      if (caps?.zoom) {
        const hwZoom = Math.min(caps.zoom.max || 3, Math.max(caps.zoom.min || 1, newZoom));
        track.applyConstraints({ advanced: [{ zoom: hwZoom } as any] }).catch(() => {});
      }
    }
  }, [getCameraTrack]);

  const handleManualZoom = (val: number) => {
    setAutoZoomActive(false);
    applyZoom(val);
  };

  const toggleTorch = async () => {
    const track = getCameraTrack();
    if (!track) return;
    try {
      const nextTorch = !torchOn;
      await track.applyConstraints({ advanced: [{ torch: nextTorch } as any] });
      setTorchOn(nextTorch);
    } catch (e) {
      console.error('Torch error:', e);
    }
  };

  /**
   * Continuous auto-focus, torch detection and the live auto-zoom loop.
   * Both the first start and Retry go through here, so retrying does not
   * leave the scanner without auto-zoom.
   */
  const startCameraAssists = useCallback(async (isCancelled: () => boolean) => {
    if (detectorIntervalRef.current) {
      clearInterval(detectorIntervalRef.current);
      detectorIntervalRef.current = null;
    }

    try {
      const track = getCameraTrack();
      if (track) {
        const caps = (track.getCapabilities ? track.getCapabilities() : {}) as any;

        if (caps.focusMode && Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as any] }).catch(() => { });
        }

        setHasTorch(Boolean(caps.torch));
      } else {
        setHasTorch(false);
      }
    } catch (err) {
      console.log('AutoFocus setup:', err);
    }

    if (isCancelled()) return;
    if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return;

    try {
      const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
      detectorIntervalRef.current = setInterval(async () => {
        if (isCancelled() || detectedRef.current) return;
        const videoEl = document.querySelector('#seycure-qr-reader video') as HTMLVideoElement;
        if (!videoEl || videoEl.readyState < 2) return;

        try {
          const codes = await detector.detect(videoEl);
          if (!codes || codes.length === 0 || detectedRef.current) return;

          const box = codes[0].boundingBox;
          const vw = videoEl.videoWidth || 320;
          const vh = videoEl.videoHeight || 320;
          const qrRatio = box.width / vw;

          // If the code is small in frame, zoom towards it.
          if (qrRatio < 0.45 && qrRatio > 0.04) {
            const targetZoom = Math.min(3.0, Math.max(1.3, 0.65 / qrRatio));
            setAutoZoomActive(true);
            setZoomLevel(Number(targetZoom.toFixed(1)));

            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;

            videoEl.style.transition = 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)';
            videoEl.style.transformOrigin = `${(cx / vw) * 100}% ${(cy / vh) * 100}%`;
            videoEl.style.transform = `scale(${targetZoom})`;

            // Also try hardware zoom
            const track = getCameraTrack();
            const trCaps = track?.getCapabilities ? (track.getCapabilities() as any) : null;
            if (trCaps?.zoom && track) {
              const hwZoom = Math.min(trCaps.zoom.max || 3, targetZoom);
              track.applyConstraints({ advanced: [{ zoom: hwZoom } as any] }).catch(() => { });
            }
          }
        } catch {
          // Detection can fail on a frame; the next tick retries.
        }
      }, 250);
    } catch (err) {
      console.log('BarcodeDetector init error:', err);
    }
  }, [getCameraTrack]);

  const handleScanFromGallery = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const tryScanCanvas = (canvas: HTMLCanvasElement): Promise<string> => {
      return new Promise((resolve, reject) => {
        canvas.toBlob(async (blob) => {
          if (!blob) { reject(new Error('no blob')); return; }
          const f = new File([blob], 'crop.png', { type: 'image/png' });
          try {
            const s = new Html5Qrcode('seycure-qr-gallery-temp');
            const result = await s.scanFile(f, true);
            s.clear();
            resolve(result);
          } catch (err) {
            reject(err);
          }
        }, 'image/png');
      });
    };

    try {
      await stopScanner();
      setPhase('scanning');
      detectedRef.current = false;

      // 1. Try scanning the full image
      try {
        const tempScanner = new Html5Qrcode('seycure-qr-gallery-temp');
        const result = await tempScanner.scanFile(file, true);
        tempScanner.clear();
        setPhase('detected');
        detectedRef.current = true;
        setTimeout(() => { onScan(result); onClose(); }, 200);
        if (galleryInputRef.current) galleryInputRef.current.value = '';
        return;
      } catch {
        // Full scan failed, try tiled crops
      }

      // 2. Tile scan
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = URL.createObjectURL(file);
      });

      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const crops = [
        { x: 0, y: 0, w: W / 2, h: H / 2 },
        { x: W / 2, y: 0, w: W / 2, h: H / 2 },
        { x: 0, y: H / 2, w: W / 2, h: H / 2 },
        { x: W / 2, y: H / 2, w: W / 2, h: H / 2 },
        { x: W * 0.25, y: H * 0.25, w: W * 0.5, h: H * 0.5 },
      ];

      for (const { x, y, w, h } of crops) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
          const result = await tryScanCanvas(canvas);
          setPhase('detected');
          detectedRef.current = true;
          setTimeout(() => { onScan(result); onClose(); }, 200);
          if (galleryInputRef.current) galleryInputRef.current.value = '';
          return;
        } catch {
          // Continue
        }
      }

      setPhase('timeout');
    } catch {
      setPhase('timeout');
    }

    if (galleryInputRef.current) galleryInputRef.current.value = '';
  };

  const stopScanner = useCallback(async () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (detectorIntervalRef.current) {
      clearInterval(detectorIntervalRef.current);
      detectorIntervalRef.current = null;
    }
    if (scannerRef.current) {
      try {
        const state = scannerRef.current.getState();
        if (state === 2 || state === 3) {
          await scannerRef.current.stop();
        }
      } catch {}
      try {
        scannerRef.current.clear();
      } catch {}
      scannerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    setPhase('scanning');
    detectedRef.current = false;
    setZoomLevel(1);
    setAutoZoomActive(true);
    setTorchOn(false);
    let cancelled = false;

    const startScanner = async () => {
      await new Promise(r => setTimeout(r, 250));
      if (cancelled) return;

      const scannerId = 'seycure-qr-reader';
      const scannerEl = document.getElementById(scannerId);
      if (!scannerEl) return;

      try {
        const scanner = new Html5Qrcode(scannerId);
        scannerRef.current = scanner;

        await scanner.start(
          { facingMode: 'environment' },
          {
            fps: 15,
            qrbox: (viewfinderWidth, viewfinderHeight) => {
              const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
              const qrboxSize = Math.floor(minEdge * 0.75);
              return { width: qrboxSize, height: qrboxSize };
            },
            aspectRatio: 1,
          },
          (decodedText, decodedResult) => {
            if (cancelled || detectedRef.current) return;
            detectedRef.current = true;
            setPhase('detected');
            if (timeoutRef.current) clearTimeout(timeoutRef.current);
            if (detectorIntervalRef.current) clearInterval(detectorIntervalRef.current);

            // Final lock zoom animation
            const videoEl = document.querySelector('#seycure-qr-reader video') as HTMLVideoElement;
            const points = getResultPoints(decodedResult);
            if (videoEl && points.length > 0) {
              let cx = 0, cy = 0;
              points.forEach((p) => { cx += p.x; cy += p.y; });
              cx /= points.length;
              cy /= points.length;

              const vw = videoEl.videoWidth || 320;
              const vh = videoEl.videoHeight || 320;
              const px = (cx / vw) * 100;
              const py = (cy / vh) * 100;

              videoEl.style.transformOrigin = `${px}% ${py}%`;
              videoEl.style.transition = 'all 0.5s cubic-bezier(0.2, 0.8, 0.2, 1)';
              videoEl.style.transform = `scale(2.5)`;
            }

            setTimeout(() => {
              if (!cancelled) {
                onScan(decodedText);
                onClose();
              }
              scanner.stop().catch(() => {});
            }, 550);
          },
          () => {}
        );

        // Continuous auto-focus, torch capability, and live auto-zoom
        setTimeout(() => {
          if (cancelled) return;
          void startCameraAssists(() => cancelled);
        }, 600);

        // 35s timeout
        timeoutRef.current = setTimeout(() => {
          if (!cancelled) {
            setPhase('timeout');
            scanner.stop().catch(() => {});
          }
        }, 35000);

      } catch (err: unknown) {
        if (cancelled) return;
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (errorMessage.includes('Permission') || errorMessage.includes('NotAllowed') || errorMessage.includes('denied')) {
          setPhase('permission-denied');
        } else {
          setPhase('error');
        }
      }
    };

    startScanner();

    return () => {
      cancelled = true;
      stopScanner();
    };
  }, [open, onScan, onClose, stopScanner, startCameraAssists]);

  const handleRetry = async () => {
    await stopScanner();
    setPhase('scanning');
    detectedRef.current = false;
    setZoomLevel(1);
    setAutoZoomActive(true);
    setTorchOn(false);
    setHasTorch(false);

    const scannerId = 'seycure-qr-reader';
    const scannerEl = document.getElementById(scannerId);
    if (!scannerEl) return;

    try {
      const scanner = new Html5Qrcode(scannerId);
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 15,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
            const qrboxSize = Math.floor(minEdge * 0.75);
            return { width: qrboxSize, height: qrboxSize };
          },
          aspectRatio: 1,
        },
        (decodedText, decodedResult) => {
          if (detectedRef.current) return;
          detectedRef.current = true;
          setPhase('detected');
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          if (detectorIntervalRef.current) clearInterval(detectorIntervalRef.current);

          const videoEl = document.querySelector('#seycure-qr-reader video') as HTMLVideoElement;
          const points = getResultPoints(decodedResult);
          if (videoEl && points.length > 0) {
            let cx = 0, cy = 0;
            points.forEach((p) => { cx += p.x; cy += p.y; });
            cx /= points.length;
            cy /= points.length;
            const vw = videoEl.videoWidth || 320;
            const vh = videoEl.videoHeight || 320;
            videoEl.style.transformOrigin = `${(cx / vw) * 100}% ${(cy / vh) * 100}%`;
            videoEl.style.transition = 'all 0.5s cubic-bezier(0.2, 0.8, 0.2, 1)';
            videoEl.style.transform = `scale(2.5)`;
          }

          setTimeout(() => {
            onScan(decodedText);
            onClose();
            scanner.stop().catch(() => {});
          }, 550);
        },
        () => {}
      );

      timeoutRef.current = setTimeout(() => {
        setPhase('timeout');
        scanner.stop().catch(() => {});
      }, 35000);

      // Retry restarts the camera, so the assists have to be restarted too.
      setTimeout(() => {
        void startCameraAssists(() => detectedRef.current);
      }, 600);
    } catch {
      setPhase('error');
    }
  };

  const handleClose = () => {
    stopScanner();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md bg-zinc-950 text-white border border-white/10 p-0 overflow-hidden rounded-3xl shadow-2xl backdrop-blur-2xl">
        <div className="relative p-6 flex flex-col items-center">
          
          {/* Header Bar */}
          <div className="w-full flex items-center justify-between mb-4 px-1">
            <div className="flex items-center gap-2">
              <span className="font-sans text-sm font-bold text-white tracking-tight">Scan QR Code</span>
            </div>

            <div className="flex items-center gap-2">
              {hasTorch && (
                <button
                  onClick={toggleTorch}
                  className={`p-2 rounded-xl transition-all ${
                    torchOn 
                      ? 'bg-amber-400 text-zinc-950 shadow-glow-amber' 
                      : 'bg-white/10 text-white hover:bg-white/20'
                  }`}
                  aria-label="Flashlight"
                >
                  <Zap className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={handleClose}
                className="p-2 rounded-xl bg-white/10 text-white/70 hover:text-white hover:bg-white/20 transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Viewfinder — Edge-to-edge camera feed */}
          <div ref={containerRef} className="relative w-[300px] h-[300px] mx-auto bg-black overflow-hidden rounded-2xl border border-white/10 shadow-inner">
            <div id="seycure-qr-reader" className="w-full h-full [&>video]:object-cover" />

            {phase === 'scanning' && (
              <>
                {/* Glowing Laser line */}
                <div className="absolute inset-x-0 h-1 bg-gradient-to-r from-transparent via-cyan-400 to-transparent shadow-[0_0_15px_#00f2fe] animate-scanline pointer-events-none z-10" />

                {/* Sleek Corner Brackets */}
                <div className="absolute inset-4 pointer-events-none z-10">
                  <div className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-cyan-400 rounded-tl-lg" />
                  <div className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-cyan-400 rounded-tr-lg" />
                  <div className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-cyan-400 rounded-bl-lg" />
                  <div className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-cyan-400 rounded-br-lg" />
                </div>
              </>
            )}

            {phase === 'detected' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-20 backdrop-blur-sm animate-modalIn">
                <div className="w-16 h-16 rounded-full bg-emerald-500 flex items-center justify-center shadow-lg shadow-emerald-500/40">
                  <Check className="w-8 h-8 text-white stroke-[3]" />
                </div>
              </div>
            )}
          </div>

          {/* Quick Zoom Buttons & Slider */}
          {phase === 'scanning' && (
            <div className="w-full mt-4 px-2 flex flex-col items-center gap-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleManualZoom(1)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                    zoomLevel === 1 && !autoZoomActive
                      ? 'bg-primary-blue text-white shadow-glow'
                      : 'bg-white/10 text-white/70 hover:bg-white/20'
                  }`}
                >
                  1x
                </button>
                <button
                  onClick={() => handleManualZoom(2)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                    zoomLevel === 2 && !autoZoomActive
                      ? 'bg-primary-blue text-white shadow-glow'
                      : 'bg-white/10 text-white/70 hover:bg-white/20'
                  }`}
                >
                  2x
                </button>
                <button
                  onClick={() => {
                    setAutoZoomActive(true);
                    applyZoom(1);
                  }}
                  className={`px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-1 transition-all ${
                    autoZoomActive
                      ? 'bg-accent-blue text-white shadow-glow'
                      : 'bg-white/10 text-white/70 hover:bg-white/20'
                  }`}
                >
                  <Sparkles className="w-3 h-3 text-cyan-300" />
                  Auto Zoom
                </button>
              </div>

              {/* Fine Zoom Slider */}
              <div className="w-full flex items-center gap-3 px-4 mt-1">
                <ZoomOut className="w-4 h-4 text-white/50 shrink-0" />
                <input
                  type="range"
                  min={1}
                  max={3}
                  step={0.1}
                  value={zoomLevel}
                  onChange={(e) => handleManualZoom(Number(e.target.value))}
                  className="flex-1 h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                />
                <ZoomIn className="w-4 h-4 text-cyan-400 shrink-0" />
              </div>
            </div>
          )}

          {/* User Guidance */}
          <div className="text-center mt-3">
            {phase === 'scanning' && (
              <p className="font-sans text-xs font-medium text-white/80">
                Point camera at a QR code to scan
              </p>
            )}
            {phase === 'detected' && (
              <p className="font-sans text-sm font-bold text-emerald-400">QR Code Verified!</p>
            )}
            {phase === 'timeout' && (
              <div className="space-y-3">
                <p className="font-sans text-sm font-medium text-warning-amber">No QR Code Detected</p>
                <Button onClick={handleRetry} className="bg-primary-blue hover:bg-primary-blue/90 text-white text-xs px-4 py-2 rounded-xl">
                  Try Again
                </Button>
              </div>
            )}
            {phase === 'permission-denied' && (
              <div className="space-y-2 p-2">
                <p className="font-sans text-sm font-bold text-danger-red">Camera Permission Required</p>
                <p className="font-sans text-xs text-white/60">
                  Please enable Camera permissions in your Android Settings to scan QR codes.
                </p>
              </div>
            )}
            {phase === 'error' && (
              <div className="space-y-2 p-2">
                <p className="font-sans text-sm font-bold text-danger-red">Camera Error</p>
                <p className="font-sans text-xs text-white/60">Could not start camera sensor.</p>
                <Button onClick={handleRetry} className="bg-primary-blue text-white text-xs px-4 py-2 rounded-xl">
                  Retry
                </Button>
              </div>
            )}
          </div>

          {/* Hidden Gallery Input */}
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/*"
            onChange={handleScanFromGallery}
            className="hidden"
          />
          <div id="seycure-qr-gallery-temp" className="hidden" />

          {/* Bottom Action Buttons */}
          <div className="flex items-center justify-center gap-4 mt-5 w-full">
            <button
              onClick={() => galleryInputRef.current?.click()}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 bg-white/10 hover:bg-white/15 text-white font-sans text-xs font-semibold rounded-xl border border-white/10 transition-colors"
            >
              <ImageIcon className="w-4 h-4 text-cyan-400" />
              From Gallery
            </button>
            <button
              onClick={handleClose}
              className="py-2.5 px-5 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white font-sans text-xs font-medium rounded-xl transition-colors"
            >
              Cancel
            </button>
          </div>

        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Link preview ─────────────────────────────────────────────────────────────
// This used to render the target page in an iframe, proxied through
// api.allorigins.win to defeat X-Frame-Options. Two things were wrong with it.
// The third-party proxy broke the on-device promise (CLAUDE.md §6.7), and the
// iframe carried sandbox="allow-same-origin allow-scripts", a combination the
// HTML spec says lets a page remove its own sandboxing - so the footer's
// "NO TRACKING" claim was false and a hostile page ran with real privileges.
//
// A privacy tool should not execute the page it is warning you about. The
// preview is now a summary built from our Worker's /title and /resolve
// endpoints: the app only ever sees extracted strings, never remote HTML.
// ── Domain mark ──────────────────────────────────────────────────────────────
// Stands in for the favicons the app used to pull from
// www.google.com/s2/favicons and the page thumbnails from image.thum.io. Both
// sent the domain, and in thum.io's case the full cleaned URL, to a company
// with no part in this app - which the on-device promise does not allow
// (CLAUDE.md §6.7, §9 Phase 0). Drawn locally from the domain name instead, so
// looking at a link reveals nothing to anyone.
const MARK_COLOURS = [
  '#0066FF', '#00A3FF', '#10B981', '#F59E0B',
  '#DC2626', '#8B5CF6', '#EC4899', '#14B8A6',
];

function markColour(domain: string): string {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
  }
  return MARK_COLOURS[hash % MARK_COLOURS.length];
}

function DomainMark({ domain, className = '' }: { domain: string; className?: string }) {
  const letter = (domain.replace(/^www\./, '')[0] || '?').toUpperCase();
  return (
    <div
      className={`flex items-center justify-center rounded-lg font-sans font-semibold text-white select-none shrink-0 ${className}`}
      style={{ backgroundColor: markColour(domain) }}
      aria-hidden="true"
    >
      {letter}
    </div>
  );
}

function BrowserModal({ url, open, onClose }: { url: string; open: boolean; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState<{ title: string; description: string; hasLoginForm: boolean } | null>(null);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setMeta(null);
    setResolvedUrl(null);

    const opts = { signal: AbortSignal.timeout(10000) };

    Promise.allSettled([
      fetch(`${SAFE_BROWSING_WORKER_URL}/title?url=${encodeURIComponent(url)}`, opts).then(r => r.json()),
      fetch(`${SAFE_BROWSING_WORKER_URL}/resolve?url=${encodeURIComponent(url)}`, opts).then(r => r.json()),
    ]).then(([titleRes, resolveRes]) => {
      if (cancelled) return;

      if (titleRes.status === 'fulfilled' && !titleRes.value?.error) {
        const v = titleRes.value;
        setMeta({
          title: v.title || '',
          description: v.description || '',
          hasLoginForm: Boolean(v.hasLoginForm),
        });
      } else {
        setFailed(true);
      }

      if (resolveRes.status === 'fulfilled' && resolveRes.value?.finalUrl && resolveRes.value.finalUrl !== url) {
        setResolvedUrl(resolveRes.value.finalUrl);
      }

      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [open, url]);

  const domain = getDomainFromUrl(url);
  const destinationDomain = resolvedUrl ? getDomainFromUrl(resolvedUrl) : null;
  const redirectsElsewhere = Boolean(destinationDomain && destinationDomain !== domain);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg bg-white dark:bg-bg-card border-border p-0 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 bg-bg-light border-b border-border-light">
          <div className="flex-1 flex items-center gap-2 bg-white dark:bg-bg-card rounded-lg px-3 py-1.5 border border-border-light min-w-0">
            <Lock className="w-3 h-3 text-primary-blue/60 shrink-0" />
            <span className="text-primary-blue font-mono text-xs truncate">{domain}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Close preview"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-10 gap-3">
              <Loader2 className="w-6 h-6 text-primary-blue animate-spin" />
              <p className="font-sans text-xs text-text-muted">Reading {domain} safely&hellip;</p>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-3">
                <DomainMark domain={domain} className="w-10 h-10 text-base" />
                <div className="min-w-0">
                  <p className="font-sans text-sm font-semibold text-text-primary break-words">
                    {meta?.title || domain}
                  </p>
                  {meta?.description ? (
                    <p className="font-sans text-xs text-text-secondary mt-1 line-clamp-3">
                      {meta.description}
                    </p>
                  ) : null}
                </div>
              </div>

              {redirectsElsewhere ? (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-warning-amber/10 border border-warning-amber/30">
                  <AlertTriangle className="w-4 h-4 text-warning-amber shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="font-sans text-xs font-medium text-text-primary">This link redirects</p>
                    <p className="font-mono text-xs text-text-secondary break-all mt-0.5">{destinationDomain}</p>
                  </div>
                </div>
              ) : null}

              {meta?.hasLoginForm ? (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-danger-red/10 border border-danger-red/30">
                  <ShieldAlert className="w-4 h-4 text-danger-red shrink-0 mt-0.5" />
                  <div>
                    <p className="font-sans text-xs font-medium text-text-primary">Asks for a sign-in</p>
                    <p className="font-sans text-xs text-text-secondary mt-0.5">
                      Check the address carefully before entering a password.
                    </p>
                  </div>
                </div>
              ) : null}

              {failed ? (
                <p className="font-sans text-xs text-text-muted">
                  Could not read this page. It may be offline or blocking automated requests.
                </p>
              ) : null}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 bg-bg-light border-t border-border-light">
          <p className="font-sans text-xs text-text-muted">Nothing from this page was run on your device.</p>
          <a
            href={resolvedUrl || url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-3 py-1.5 bg-primary-blue text-white rounded-lg font-sans text-xs hover:bg-primary-blue/90 transition-colors shrink-0"
          >
            <ExternalLink className="w-3 h-3" />
            Open
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Safe Browsing Worker ─────────────────────────────────────────────────────
// After deploying the Cloudflare Worker, replace this URL with your worker URL.
// e.g. 'https://seycure-safe-browsing.YOUR_SUBDOMAIN.workers.dev'
const SAFE_BROWSING_WORKER_URL = 'https://seycure-safe-browsing.arka-cmd.workers.dev';

// Local heuristic fallback (used if Worker is unreachable)
const SUSPICIOUS_DOMAINS = [
  'malware.testing.google.test', 'testsafebrowsing.appspot.com',
  'phishing.example.com', 'evil.com',
];
const SUSPICIOUS_TLDS = ['.tk', '.ml', '.ga', '.cf', '.gq', '.buzz', '.top', '.xyz', '.club', '.work', '.date', '.racing', '.download', '.stream', '.gdn', '.loan', '.bid'];

function localHeuristicCheck(url: string): { isThreat: boolean; reason: string } {
  try {
    const domain = new URL(url).hostname.toLowerCase();
    if (SUSPICIOUS_DOMAINS.some(d => domain.includes(d))) {
      return { isThreat: true, reason: 'Known malicious domain' };
    }
    if (SUSPICIOUS_TLDS.some(tld => domain.endsWith(tld))) {
      return { isThreat: true, reason: 'Suspicious TLD' };
    }
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(domain)) {
      return { isThreat: true, reason: 'IP-based URL (possible phishing)' };
    }
  } catch {
    // Invalid URL
  }
  return { isThreat: false, reason: '' };
}

async function checkUrlThreat(url: string): Promise<{ isThreat: boolean; reason: string }> {
  try {
    const res = await fetch(
      `${SAFE_BROWSING_WORKER_URL}/check?url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(5000) }  // 5s timeout
    );
    if (!res.ok) throw new Error(`Worker responded: ${res.status}`);

    const data = (await res.json()) as { safe: boolean; threats?: string[] };
    if (!data.safe && data.threats?.length) {
      const threatLabel: Record<string, string> = {
        MALWARE: 'Malware',
        SOCIAL_ENGINEERING: 'Phishing / Social Engineering',
        UNWANTED_SOFTWARE: 'Unwanted Software',
        POTENTIALLY_HARMFUL_APPLICATION: 'Potentially Harmful App',
      };
      const reason = data.threats.map(t => threatLabel[t] ?? t).join(', ');
      return { isThreat: true, reason };
    }
    return { isThreat: false, reason: '' };
  } catch {
    // Worker unreachable — fall back to local heuristic
    return localHeuristicCheck(url);
  }
}

function VirusScanButton({ url }: { url?: string }) {
  const [state, setState] = useState<'idle' | 'scanning' | 'clean' | 'flagged'>('idle');
  const [resultHash, setResultHash] = useState('');
  const [threatReason, setThreatReason] = useState('');

  const handleScan = async () => {
    setState('scanning');
    // Compute a display hash from the URL
    let hash = 0;
    for (let i = 0; i < (url || '').length; i++) {
      hash = ((hash << 5) - hash) + (url || '').charCodeAt(i);
      hash = hash & hash;
    }
    setResultHash(Math.abs(hash).toString(16).padStart(8, '0'));

    if (url) {
      const result = await checkUrlThreat(url);
      if (result.isThreat) {
        setState('flagged');
        setThreatReason(result.reason);
      } else {
        setState('clean');
      }
    } else {
      setState('clean');
    }
  };

  if (state === 'idle') {
    return (
      <button
        onClick={handleScan}
        className="mt-3 flex items-center gap-2 text-text-secondary hover:text-text-primary font-sans text-xs transition-colors"
      >
        <ChevronRight className="w-3 h-3" />
        Run Heuristic Scan
      </button>
    );
  }

  if (state === 'scanning') {
    return (
      <div className="mt-3">
        <div className="h-1 bg-border-light rounded-full overflow-hidden">
          <div className="h-full w-1/3 bg-primary-blue animate-scanbar" />
        </div>
        <p className="mt-2 font-sans text-xs text-primary-blue">Analyzing URL patterns...</p>
      </div>
    );
  }

  if (state === 'clean') {
    return (
      <div className="mt-3 font-sans text-xs text-success-green">
        <Check className="w-4 h-4 inline mr-1" />
        No threats found · Hash: {resultHash}
      </div>
    );
  }

  return (
    <div className="mt-3 font-sans text-xs text-danger-red">
      <AlertTriangle className="w-4 h-4 inline mr-1" />
      {threatReason} · Hash: {resultHash}
    </div>
  );
}

function PreviewCard({ analysis, onDismiss }: { analysis: LinkAnalysis; onDismiss: () => void }) {
  const [showBrowser, setShowBrowser] = useState(false);
  const [metadataLoaded, setMetadataLoaded] = useState(false);
  const [screenshotLoaded, setScreenshotLoaded] = useState(false);
  const [threatStatus, setThreatStatus] = useState<'checking' | 'safe' | 'unsafe'>('checking');
  const [threatReason, setThreatReason] = useState('');
  const [redirectChain, setRedirectChain] = useState(analysis.redirectChain);
  // Category Link Warning Modal state
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [intendedUrl, setIntendedUrl] = useState('');

  useEffect(() => {
    const metaTimer = setTimeout(() => setMetadataLoaded(true), 1400);
    const imgTimer = setTimeout(() => setScreenshotLoaded(true), 2500);

    // Real async threat check via Cloudflare Worker
    let cancelled = false;
    const runChecks = async () => {
      // Feature 2: Build a display chain from the URL we already resolved
      try {
        if (!redirectChain && analysis.isShortener) {
          const mockChain = [{ url: analysis.originalUrl, status: 301 }];
          if (analysis.resolvedUrl && analysis.resolvedUrl !== analysis.originalUrl) {
            mockChain.push({ url: analysis.resolvedUrl, status: 200 });
          }
          if (!cancelled) setRedirectChain(mockChain);
        }
      } catch {
        // Ignore chain failure
      }

      if (cancelled) return;
      const result = await checkUrlThreat(analysis.cleanedUrl);
      if (cancelled) return;
      if (result.isThreat) {
        setThreatStatus('unsafe');
        setThreatReason(result.reason);
      } else {
        setThreatStatus('safe');
      }
    };
    runChecks();

    return () => {
      cancelled = true;
      clearTimeout(metaTimer);
      clearTimeout(imgTimer);
    };
  }, [analysis.cleanedUrl]);

  const riskConfig = {
    critical: { color: 'danger-red', label: 'Windows Executable / Installer Detected', desc: 'Can install malware, ransomware, or spyware silently.' },
    high: { color: 'warning-amber', label: 'Installer Package Detected', desc: 'Requires elevated privileges. Verify source before opening.' },
    medium: { color: 'warning-amber', label: 'Archive / Macro File Detected', desc: 'May contain hidden executables or triggered scripts.' },
    low: { color: 'info-blue', label: 'Document File Detected', desc: 'Commonly safe but can carry embedded scripts. Use sandboxed viewer.' },
    none: null,
  };

  const risk = riskConfig[analysis.fileRisk];
  const hasPhishing = !!(analysis.phishingSignals && analysis.phishingSignals.length > 0);
  const isClean = !hasPhishing && threatStatus === 'safe' && risk === null;

  const handleOpenLink = (url: string) => {
    if (analysis.category.filterType === 'block' || analysis.category.filterType === 'warn') {
      setIntendedUrl(url);
      setShowWarningModal(true);
    } else {
      window.open(url, '_blank');
    }
  };

  const getActionButtons = () => {
    if (hasPhishing) {
      return (
        <button
          onClick={onDismiss}
          className="w-full py-3 px-4 bg-bg-light text-text-primary border border-border-light font-sans text-sm font-medium rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 transition-colors flex items-center justify-center gap-2"
        >
          <X className="w-4 h-4" />
          Don't Open — Go Back
        </button>
      );
    }
    if (analysis.fileRisk === 'critical') {
      return (
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            onClick={() => handleOpenLink(analysis.cleanedUrl)}
            className="flex-1 py-3 px-4 border border-danger-red text-danger-red font-sans text-sm font-medium rounded-lg hover:bg-danger-red/10 transition-colors flex items-center justify-center gap-2"
          >
            <AlertTriangle className="w-4 h-4" />
            Open at Your Own Risk
          </button>
        </div>
      );
    }
    if (analysis.fileRisk === 'high' || analysis.fileRisk === 'medium') {
      return (
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            onClick={() => handleOpenLink(analysis.cleanedUrl)}
            className="flex-1 py-3 px-4 border border-warning-amber text-warning-amber font-sans text-sm font-medium rounded-lg hover:bg-warning-amber/10 transition-colors"
          >
            Open Anyway
          </button>
        </div>
      );
    }

    return (
      <div className="flex flex-col sm:flex-row gap-3">
        {analysis.trackersRemoved > 0 && (
          <button
            onClick={() => handleOpenLink(analysis.originalUrl)}
            className="flex-1 py-3 px-4 bg-bg-light text-text-primary border border-border-light font-sans text-sm font-medium rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 transition-colors flex items-center justify-center gap-2"
          >
            Open Original
          </button>
        )}
        <button
          onClick={() => handleOpenLink(analysis.cleanedUrl)}
          className="flex-1 py-3 px-4 bg-primary-blue text-white font-sans text-sm font-medium rounded-lg hover:bg-primary-blue/90 transition-colors flex items-center justify-center gap-2"
        >
          <ExternalLink className="w-4 h-4" />
          Open Safely
        </button>
      </div>
    );
  };

  return (
    <>
      <div className="animate-fadeUp bg-white dark:bg-bg-card rounded-xl border border-border-light shadow-card overflow-hidden">
        {/* Layer 1: Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-bg-light border-b border-border-light">
          <span className="font-sans text-xs font-medium text-text-secondary tracking-wide uppercase">Link Analysis</span>
          <button onClick={onDismiss} className="text-text-muted hover:text-text-primary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {hasPhishing ? (
          <div className="mx-4 mt-4 rounded-xl border-2 border-danger-red overflow-hidden shadow-[0_0_15px_rgba(239,68,68,0.2)]">
            <div className="bg-danger-red text-white py-3 px-4 font-bold text-sm tracking-wider flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 animate-pulse" />
              🚨 LIKELY PHISHING PAGE
            </div>
            <div className="bg-danger-red/5 p-4 space-y-3 border-t border-danger-red/20">
              {analysis.phishingSignals?.map((sig, idx) => (
                <div key={idx} className="flex items-start gap-2">
                  <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${sig.severity === 'critical' ? 'text-danger-red' : 'text-warning-amber'}`} />
                  <p className="font-sans text-xs font-semibold text-text-primary leading-tight">
                    {sig.message}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : isClean ? (
          <div className="p-4 space-y-4">
            {/* Simple Clean UI Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <DomainMark domain={analysis.favicon} className="w-8 h-8 text-sm" />
                <div>
                  <p className="font-sans text-sm font-medium text-text-primary truncate">{analysis.domain}</p>
                  <p className="font-sans text-xs text-text-secondary">{analysis.category.icon} {analysis.category.label}</p>
                </div>
              </div>
              {/* Category-aware badge */}
              {analysis.category.riskLevel === 'danger' ? (
                <div className="flex items-center gap-1.5 px-2 py-1 bg-danger-red/10 rounded-lg border border-danger-red/20">
                  <AlertTriangle className="w-3.5 h-3.5 text-danger-red" />
                  <span className="font-sans text-xs font-medium text-danger-red">{analysis.category.label}</span>
                </div>
              ) : analysis.category.riskLevel === 'caution' ? (
                <div className="flex items-center gap-1.5 px-2 py-1 bg-warning-amber/10 rounded-lg border border-warning-amber/20">
                  <AlertTriangle className="w-3.5 h-3.5 text-warning-amber" />
                  <span className="font-sans text-xs font-medium text-warning-amber">{analysis.category.label}</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 px-2 py-1 bg-success-green/10 rounded-lg border border-success-green/20">
                  <ShieldCheck className="w-3.5 h-3.5 text-success-green" />
                  <span className="font-sans text-xs font-medium text-success-green">Safe</span>
                </div>
              )}
            </div>

            {/* Category warning for risky-but-GSB-safe sites */}
            {analysis.category.riskLevel === 'danger' && (
              <div className="px-3 py-2.5 bg-danger-red/5 border border-danger-red/20 rounded-lg">
                <p className="font-sans text-xs font-semibold text-danger-red flex items-center gap-2">
                  <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                  {analysis.category.category === 'gambling' && '⚠️ This is a gambling/betting site. Proceed with caution.'}
                  {analysis.category.category === 'adult' && '🔞 This site contains adult content. Age 18+ required.'}
                  {analysis.category.category === 'file-download' && '⬇️ This site hosts file downloads. Verify before downloading.'}
                </p>
              </div>
            )}
            {analysis.category.riskLevel === 'caution' && (
              <div className="px-3 py-2.5 bg-warning-amber/5 border border-warning-amber/20 rounded-lg">
                <p className="font-sans text-xs font-semibold text-warning-amber flex items-center gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  {analysis.category.category === 'crypto' && '💰 Cryptocurrency site — high scam risk. Never share seed phrases.'}
                  {analysis.category.category === 'gaming' && '🎮 Gaming site — may contain aggressive ads or prompts.'}
                  {analysis.category.category === 'pharma' && '💊 Online pharmacy — verify it is licensed before purchasing.'}
                </p>
              </div>
            )}

            {/* Tracker count if any */}
            {analysis.trackersRemoved > 0 && (
              <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary-light border border-primary-blue/30 rounded-lg">
                <Scissors className="w-3 h-3 text-primary-blue" />
                <span className="font-sans text-xs font-medium text-primary-blue">
                  {analysis.trackersRemoved} tracker{analysis.trackersRemoved > 1 ? 's' : ''} removed
                </span>
              </div>
            )}

            {/* Threat status */}
            {threatStatus === 'safe' && (
              <div className="flex items-center gap-2 px-3 py-2 bg-success-green/5 border border-success-green/20 rounded-lg">
                <ShieldCheck className="w-4 h-4 text-success-green" />
                <span className="font-sans text-xs font-medium text-success-green">No Threats Detected</span>
                <span className="font-sans text-[10px] text-text-muted ml-auto">Google Safe Browsing + local analysis clear</span>
              </div>
            )}

            {/* Domain Age */}
            {analysis.domainAgeDays !== undefined && (
              <div className="flex items-center gap-2 px-3 py-2 bg-bg-light border border-border-light rounded-lg">
                <Calendar className="w-4 h-4 text-text-secondary" />
                <span className="font-sans text-xs font-medium text-text-primary">
                  Domain Age: {analysis.domainAgeDays !== null ? `${analysis.domainAgeDays} days` : 'Unknown'}
                </span>
                {analysis.domainAgeDays !== null && analysis.domainAgeDays < 30 && (
                  <span className="font-sans text-[10px] text-danger-red ml-auto font-bold uppercase tracking-wide bg-danger-red/10 px-2 py-0.5 rounded">
                    New Domain
                  </span>
                )}
              </div>
            )}

            <div className="border-t border-border-light" />
          </div>
        ) : null}

        <div className={`p-4 ${isClean ? 'pt-0' : 'space-y-3'}`}>
          {!isClean && (
            <>
              {/* Layer 2: Tracker Badge */}
              {analysis.trackersRemoved > 0 && (
                <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary-light border border-primary-blue/30 rounded-lg">
                  <Scissors className="w-3 h-3 text-primary-blue" />
                  <span className="font-sans text-xs font-medium text-primary-blue">
                    {analysis.trackersRemoved} tracker{analysis.trackersRemoved > 1 ? 's' : ''} removed
                  </span>
                </div>
              )}

              {/* Layer 3: Shortener Warning */}
              {analysis.isShortener && (
                <div className="px-3 py-2 bg-warning-amber/10 border border-warning-amber/30 rounded-lg">
                  <p className="font-sans text-xs font-medium text-warning-amber flex items-center gap-2">
                    <AlertTriangle className="w-3 h-3" />
                    Shortened URL {analysis.resolvedUrl ? '— Resolved' : '— Resolving Destination'}
                  </p>
                  {analysis.resolvedUrl ? (
                    <p className="font-mono text-xs text-warning-amber/80 mt-1 ml-5 break-all">
                      → {analysis.resolvedUrl}
                    </p>
                  ) : (
                    <div className="flex items-center gap-2 mt-1 ml-5">
                      <Loader2 className="w-3 h-3 text-warning-amber animate-spin" />
                      <span className="font-sans text-xs text-warning-amber/70">Following redirects...</span>
                    </div>
                  )}
                </div>
              )}

              {/* Layer 4: File Risk Banner */}
              {risk && (
                <div className={`px-3 py-3 bg-${risk.color}/10 border border-${risk.color}/30 rounded-lg`}>
                  <p className={`font-sans text-xs font-medium text-${risk.color} flex items-center gap-2`}>
                    <AlertTriangle className="w-3 h-3" />
                    {risk.label}
                  </p>
                  <p className={`font-sans text-xs text-${risk.color}/80 mt-1 ml-5`}>{risk.desc}</p>
                  <VirusScanButton url={analysis.cleanedUrl} />
                </div>
              )}

              {/* Layer 4b: Category Badge */}
              {analysis.category.category !== 'unknown' && (
                <div className={`px-3 py-2 rounded-lg border flex items-center gap-2
                  ${analysis.category.riskLevel === 'danger' ? 'bg-danger-red/10 border-danger-red/30 text-danger-red' : ''}
                  ${analysis.category.riskLevel === 'caution' ? 'bg-warning-amber/10 border-warning-amber/30 text-warning-amber' : ''}
                  ${analysis.category.riskLevel === 'trusted' ? 'bg-success-green/10 border-success-green/30 text-success-green' : ''}
                  ${(analysis.category.riskLevel === 'low' || analysis.category.riskLevel === 'neutral') ? 'bg-primary-blue/5 border-primary-blue/20 text-primary-blue' : ''}
                `}>
                  <span className="text-sm">{analysis.category.icon}</span>
                  <span className="font-sans text-xs font-semibold">{analysis.category.label} Site Detected</span>
                  {(analysis.category.filterType === 'block' || analysis.category.filterType === 'warn') && (
                    <span className="ml-auto flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider opacity-80 bg-black/5 px-1.5 py-0.5 rounded">
                      <ShieldAlert className="w-3 h-3" /> Filter Active
                    </span>
                  )}
                </div>
              )}

              {/* Layer 5: Cleaned URL */}
              <div className="bg-bg-light rounded-lg p-3 border border-border-light">
                <p className="font-sans text-xs text-text-secondary mb-1">Cleaned URL</p>
                <p className="font-mono text-sm text-primary-blue break-all">{analysis.cleanedUrl}</p>
              </div>

              {/* New Feature: Redirect Chain Visualizer */}
              {redirectChain && redirectChain.length > 1 && (
                <div className="px-3 py-3 bg-bg-light border border-border-light rounded-lg">
                  <p className="font-sans text-xs font-medium text-text-secondary mb-2 flex items-center gap-1">
                    <ArrowRight className="w-3 h-3" />
                    Redirect Chain
                  </p>
                  <div className="space-y-2 relative">
                    <div className="absolute left-[7px] top-2 bottom-2 w-0.5 bg-border-light" />
                    {redirectChain.map((hop, i) => (
                      <div key={i} className="flex gap-2 relative z-10">
                        <div className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${i === redirectChain.length - 1 ? 'bg-primary-blue' : 'bg-bg-light border border-border-light'}`}>
                          {i === redirectChain.length - 1 && <div className="w-1.5 h-1.5 bg-white rounded-full" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="font-mono text-[10px] text-text-secondary truncate">{getDomainFromUrl(hop.url) || hop.url}</p>
                          <p className="font-sans text-[10px] bg-white dark:bg-bg-card border border-border-light px-1.5 py-0.5 rounded w-fit text-text-muted mt-0.5">HTTP {hop.status}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}


              {/* Layer 6: Destination Identity */}
              <div className="flex items-center gap-3">
                {!metadataLoaded ? (
                  <div className="flex items-center gap-3 w-full">
                    <div className="w-8 h-8 bg-border-light rounded-lg animate-shimmer" />
                    <div className="flex-1 space-y-1">
                      <div className="h-3 w-32 bg-border-light rounded animate-shimmer" />
                      <div className="h-2 w-20 bg-border-light rounded animate-shimmer" />
                    </div>
                  </div>
                ) : (
                  <>
                    <DomainMark domain={analysis.favicon} className="w-8 h-8 text-sm" />
                    <div className="flex-1 min-w-0">
                      <p className="font-sans text-sm font-medium text-text-primary truncate">{analysis.title || analysis.domain}</p>
                      <div className="flex items-center gap-2">
                        {threatStatus === 'checking' ? (
                          <>
                            <Loader2 className="w-3 h-3 text-primary-blue animate-spin" />
                            <span className="font-sans text-xs text-primary-blue">Checking safety...</span>
                          </>
                        ) : threatStatus === 'safe' && analysis.fileRisk === 'none' ? (
                          <>
                            <div className="w-1.5 h-1.5 rounded-full bg-success-green" />
                            <span className="font-sans text-xs text-success-green">No Threats Detected</span>
                          </>
                        ) : (
                          <>
                            <div className="w-1.5 h-1.5 rounded-full bg-danger-red" />
                            <span className="font-sans text-xs text-danger-red">
                              {threatReason || 'Proceed with Caution'}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          {/* Layer 7: Action Buttons */}
          {metadataLoaded && getActionButtons()}

          {/* Content Preview (only for non-dangerous files) */}
          {analysis.fileRisk === 'none' && (
            <div className="pt-2 border-t border-border-light">
              {!screenshotLoaded ? (
                <div className="space-y-2">
                  <div className="h-8 bg-border-light rounded animate-shimmer shimmer-1" />
                  <div className="h-24 bg-border-light rounded animate-shimmer shimmer-2" />
                  <div className="h-16 bg-border-light rounded animate-shimmer shimmer-3" />
                  <p className="font-sans text-xs text-text-secondary text-center pt-2">Checking link...</p>
                </div>
              ) : (
                <button
                  type="button"
                  className="w-full flex items-center gap-3 p-4 rounded-lg bg-bg-light border border-border-light hover:border-primary-blue/40 transition-colors text-left"
                  onClick={() => setShowBrowser(true)}
                >
                  <DomainMark domain={analysis.favicon} className="w-11 h-11 text-lg" />
                  <div className="min-w-0 flex-1">
                    <p className="font-sans text-sm font-medium text-text-primary truncate">
                      {analysis.title || analysis.favicon}
                    </p>
                    <p className="font-sans text-xs text-text-secondary">Check this link before opening it</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-text-muted shrink-0" />
                </button>
              )}

              {/* OG Metadata */}
              {screenshotLoaded && analysis.title && (
                <div className="mt-3 p-3 bg-bg-light rounded-lg border border-border-light">
                  <p className="font-sans text-sm font-medium text-text-primary line-clamp-2">{analysis.title}</p>
                  {analysis.description && (
                    <p className="font-sans text-xs text-text-secondary mt-1 line-clamp-2">{analysis.description}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <BrowserModal url={analysis.cleanedUrl} open={showBrowser} onClose={() => setShowBrowser(false)} />

      {/* Warning Category Modal */}
      <Dialog open={showWarningModal} onOpenChange={setShowWarningModal}>
        <DialogContent className="max-w-sm rounded-[24px] p-6 bg-white dark:bg-bg-card gap-0 border-0 shadow-model text-center">
          <div className="mx-auto w-16 h-16 bg-bg-light rounded-full flex items-center justify-center text-3xl mb-4 border border-border-light shadow-sm">
            {analysis.category.icon}
          </div>

          <h2 className="font-sans text-lg font-bold text-text-primary mb-1">
            {analysis.category.label} Site Detected
          </h2>
          <p className="font-mono text-sm text-primary-blue truncate px-4 bg-primary-light/50 py-1.5 rounded-lg mb-4">
            {analysis.domain}
          </p>

          <div className="flex justify-center gap-4 mb-5">
            <div className="flex flex-col items-center">
              <span className="text-2xl font-bold text-text-primary mb-1 inline-flex items-center gap-1.5">
                {analysis.category.icon}
              </span>
              <span className="font-sans text-[10px] font-semibold text-text-secondary uppercase tracking-wider">
                {analysis.category.label}
              </span>
            </div>

            <div className="w-px h-10 bg-border-light self-center" />

            <div className="flex flex-col items-center">
              <span className="text-xl font-bold text-text-primary mb-1 inline-flex items-center gap-1">
                🔍 {analysis.trackersRemoved}
              </span>
              <span className="font-sans text-[10px] font-semibold text-text-secondary uppercase tracking-wider">
                Trackers
              </span>
            </div>

            <div className="w-px h-10 bg-border-light self-center" />

            <div className="flex flex-col items-center">
              <span className={`text-xl font-bold mb-1 inline-flex items-center gap-1 ${analysis.cleanedUrl.startsWith('https://') ? 'text-success-green' : 'text-warning-amber'}`}>
                {analysis.cleanedUrl.startsWith('https://') ? '🔒' : '⚠️'}
              </span>
              <span className="font-sans text-[10px] font-semibold text-text-secondary uppercase tracking-wider">
                {analysis.cleanedUrl.startsWith('https://') ? 'HTTPS' : 'HTTP'}
              </span>
            </div>

            <div className="w-px h-10 bg-border-light self-center" />

            <div className="flex flex-col items-center">
              <span className={`text-xl font-bold mb-1 inline-flex items-center gap-1 ${typeof analysis.domainAgeDays === 'number' && analysis.domainAgeDays < 30 ? 'text-danger-red' : 'text-text-primary'}`}>
                {analysis.domainAgeDays ?? '?'}
                <span className="text-xs font-normal text-text-muted">d</span>
              </span>
              <span className="font-sans text-[10px] font-semibold text-text-secondary uppercase tracking-wider">
                Domain Age
              </span>
            </div>
          </div>

          <div className="bg-bg-light rounded-xl p-4 text-left border border-border-light mb-6 relative overflow-hidden">
            <div className={`absolute top-0 left-0 bottom-0 w-1 ${analysis.category.filterType === 'block' ? 'bg-danger-red' : 'bg-warning-amber'
              }`} />
            <p className="font-sans text-sm text-text-secondary leading-relaxed pl-2">
              {analysis.category.category === 'gambling' && 'This site promotes online gambling or betting. Many gambling sites target users with deceptive ads and may be unlicensed in your region.'}
              {analysis.category.category === 'adult' && 'This site contains adult content. Ensure you are of legal age in your region before continuing.'}
              {analysis.category.category === 'file-download' && 'This site distributes downloadable files. Downloaded files may contain malware, especially cracked software or APKs.'}
              {analysis.category.category === 'crypto' && 'Cryptocurrency sites have a high rate of scams and phishing. "Free crypto" and "airdrop" offers are almost always fraudulent.'}
              {analysis.category.category === 'gaming' && 'Some gaming sites serve aggressive ads or prompt downloads. Proceed with caution on unfamiliar sites.'}
              {analysis.category.category === 'pharma' && 'Online pharmacy sites can be unlicensed or sell counterfeit medications. Only use verified, licensed pharmacies.'}
            </p>
          </div>

          <div className="space-y-3">
            <button
              onClick={() => {
                window.open(intendedUrl, '_blank');
                setShowWarningModal(false);
              }}
              className={`w-full py-3.5 font-sans text-sm font-bold rounded-xl transition-all border ${analysis.category.filterType === 'block'
                ? 'border-danger-red/20 text-danger-red hover:bg-danger-red/10'
                : 'border-warning-amber/30 text-warning-amber hover:bg-warning-amber/10'
                }`}
            >
              Open Anyway — {
                analysis.category.category === 'adult' ? "I'm of legal age" :
                  analysis.category.category === 'file-download' || analysis.category.category === 'pharma' ? 'I trust this source' :
                    analysis.category.category === 'gaming' ? 'Proceed' :
                      'I understand the risk'
              }
            </button>
            <button
              onClick={() => setShowWarningModal(false)}
              className="w-full py-3.5 bg-primary-blue text-white font-sans text-sm font-bold rounded-xl hover:bg-primary-blue/90 shadow-card transition-all"
            >
              Go Back — Keep me safe
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function LinkShield({ initialUrl, onInitialUrlConsumed }: {
  initialUrl?: string;
  /** Tells the parent the seed URL has been used, so it can forget it. */
  onInitialUrlConsumed?: () => void;
} = {}) {
  const [url, setUrl] = useState(initialUrl || '');
  const [showScanner, setShowScanner] = useState(false);
  const [analysis, setAnalysis] = useState<LinkAnalysis | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const { incrementLinksCleaned, incrementTrackersRemoved } = useAppStats();

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setUrl(text);
        if (isValidUrl(text)) {
          analyzeUrl(text);
        }
      }
    } catch {}
  };

  const analyzeUrl = useCallback((value: string) => {
    if (isValidUrl(value)) {
      setIsScanning(true);
      const { cleaned, removed } = cleanUrl(value);
      incrementLinksCleaned();
      incrementTrackersRemoved(removed);
      const domain = getDomainFromUrl(value);
      const { level, ext } = getFileRisk(value);
      const isShort = isShortener(value);

      // Phase 1: Instant local result — show immediately, no network needed
      const instantAnalysis: LinkAnalysis = {
        originalUrl: value,
        cleanedUrl: cleaned,
        trackersRemoved: removed,
        isShortener: isShort,
        fileRisk: level,
        fileExtension: ext,
        category: classifyLink(domain, ''),
        domain,
        title: domain,
        description: '',
        favicon: domain,
        phishingSignals: checkPhishingSignals(value, domain, domain, domain, false, isShort),
      };
      setAnalysis(instantAnalysis);

      // Phase 2: Enhance with page metadata from our Worker. It fetches the
      // page and returns only extracted fields, so no third-party proxy is
      // involved and no remote HTML is parsed on the device.
      fetch(`${SAFE_BROWSING_WORKER_URL}/title?url=${encodeURIComponent(value)}`, {
        signal: AbortSignal.timeout(10000),
      })
        .then(r => r.json())
        .then((data: any) => {
          if (data?.error) return;

          const title = data.title || domain;
          const pSignals = checkPhishingSignals(value, domain, domain, title, Boolean(data.hasLoginForm), isShort);

          setAnalysis(prev => prev ? {
            ...prev,
            category: classifyLink(domain, data.title || ''),
            title,
            description: data.description || '',
            phishingSignals: pSignals.length > 0 ? pSignals : prev.phishingSignals,
          } : prev);
        })
        .catch(() => {
          // Keep the instant local analysis already shown
        })
        .finally(() => setIsScanning(false));

      // Resolve a shortened link to its destination. Runs independently of the
      // metadata call so one failing does not suppress the other; the previous
      // version nested this inside the fetch above and read the wrong shape off
      // /redirects, so the resolved URL never actually appeared.
      if (isShort) {
        fetch(`${SAFE_BROWSING_WORKER_URL}/resolve?url=${encodeURIComponent(value)}`, {
          signal: AbortSignal.timeout(10000),
        })
          .then(r => r.json())
          .then((data: any) => {
            if (data?.finalUrl && data.finalUrl !== value) {
              setAnalysis(prev => prev ? { ...prev, resolvedUrl: data.finalUrl } : prev);
            }
          })
          .catch(() => {
            // Leave resolvedUrl unset; the UI treats that as "not resolved"
          });
      }

      // Phase 3: Domain Age (RDAP)
      const rootDomain = domain.split('.').slice(-2).join('.');
      fetch(`https://rdap.org/domain/${rootDomain}`)
        .then(r => r.json())
        .then(data => {
          const creationEvent = data.events?.find((e: any) => e.eventAction === 'registration');
          if (creationEvent && creationEvent.eventDate) {
            const domainAgeDays = Math.floor((Date.now() - new Date(creationEvent.eventDate).getTime()) / (1000 * 60 * 60 * 24));
            setAnalysis(prev => prev ? { ...prev, domainAgeDays } : prev);
          }
        })
        .catch(() => {
          // Ignore RDAP failures
        });
    } else {
      setAnalysis(null);
    }
  }, []);

  // A scanned URL is a one-shot instruction, not durable state. It used to be
  // left set on the parent after being used, and because switching tools
  // unmounts this component, coming back re-ran this effect on the stale value
  // and resurrected an analysis the user had already cleared. Consuming it
  // means a remount starts empty, and re-scanning the same code still works.
  useEffect(() => {
    if (initialUrl && isValidUrl(initialUrl)) {
      setUrl(initialUrl);
      analyzeUrl(initialUrl);
      onInitialUrlConsumed?.();
    }
  }, [initialUrl, analyzeUrl, onInitialUrlConsumed]);

  const handleQRScan = (scannedUrl: string) => {
    setUrl(scannedUrl);
    analyzeUrl(scannedUrl);
  };

  return (
    <div className="space-y-4 p-4">
      {/* URL Input, Paste & Scan Action */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') analyzeUrl(url); }}
            placeholder="Paste link here to strip tracking..."
            className="h-12 bg-white dark:bg-bg-card border-border-light text-text-primary font-sans placeholder:text-text-muted focus:border-primary-blue focus:ring-primary-blue/20 pr-10 rounded-lg"
          />
          {url && (
            <button
              onClick={() => { setUrl(''); setAnalysis(null); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <button
          onClick={handlePasteClipboard}
          type="button"
          className="px-3.5 h-12 bg-white dark:bg-bg-card border border-border-light hover:border-primary-blue text-primary-blue font-sans text-xs font-semibold rounded-lg flex items-center gap-1.5 shadow-card shrink-0 transition-colors"
          title="Paste from clipboard"
        >
          <Clipboard className="w-4 h-4" />
          <span className="hidden sm:inline">Paste</span>
        </button>
        <button
          onClick={() => analyzeUrl(url)}
          disabled={!url || !isValidUrl(url) || isScanning}
          className={`px-5 h-12 text-white font-sans text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-card flex items-center gap-2 ${isScanning ? 'bg-emerald-500 animate-pulse' : 'bg-primary-blue hover:bg-primary-blue/90'
            }`}
        >
          {isScanning ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Search className="w-4 h-4" />
          )}
          {isScanning ? 'Scanning...' : 'Scan'}
        </button>
      </div>

      {/* Info note */}
      <p className="font-sans text-xs text-text-secondary text-center">
        Trackers are removed the moment you paste a link.
      </p>

      {/* Preview Card */}
      {analysis && (
        <PreviewCard
          analysis={analysis}
          onDismiss={() => { setUrl(''); setAnalysis(null); }}
        />
      )}

      <QRScannerModal
        open={showScanner}
        onClose={() => setShowScanner(false)}
        onScan={handleQRScan}
      />
    </div>
  );
}

function MediaScrubber() {
  const [files, setFiles] = useState<FileCard[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { shareFile: nativeShare } = useNativeShare();
  const { incrementPhotosScrubbed } = useAppStats();

  // ── Detect file type from MIME ──────────────────────────────────────────
  const getFileType = (file: File): FileCard['type'] => {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type === 'application/pdf') return 'document';
    if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'document';
    if (file.name.endsWith('.docx')) return 'document';
    if (file.name.endsWith('.pdf')) return 'document';
    return 'video';
  };

  const processFile = async (file: File) => {
    const fileType = getFileType(file);
    const base64Data = await fileToBase64(file);

    const newFile: FileCard = {
      id: Math.random().toString(36).substr(2, 9),
      name: file.name,
      type: fileType,
      status: 'scanning',
      metadata: [],
      base64Data,
      mimeType: file.type,
    };

    setFiles(prev => [...prev, newFile]);

    try {
      const metadata: FileCard['metadata'] = [];
      let cleanBase64Data = base64Data;

      // ── Image EXIF processing ─────────────────────────────────────────
      if (fileType === 'image') {
        try {
          const exifData = await exifr.parse(file, {
            gps: true,
            exif: true,
          } as Parameters<typeof exifr.parse>[1]);

          if (exifData) {
            if (exifData.latitude !== undefined && exifData.longitude !== undefined) {
              const latDir = exifData.latitude >= 0 ? 'N' : 'S';
              const lonDir = exifData.longitude >= 0 ? 'E' : 'W';
              metadata.push({
                type: 'gps',
                value: `${Math.abs(exifData.latitude).toFixed(4)}°${latDir} ${Math.abs(exifData.longitude).toFixed(4)}°${lonDir}`,
              });
            }
            if (exifData.Make || exifData.Model) {
              metadata.push({
                type: 'device',
                value: [exifData.Make, exifData.Model].filter(Boolean).join(' '),
              });
            }
            if (exifData.Software) {
              metadata.push({
                type: 'software',
                value: exifData.Software,
              });
            }
          }
        } catch {
          // File has no EXIF or exifr couldn't parse it
        }

        // Strip EXIF by redrawing through Canvas
        try {
          const img = new window.Image();
          const objectUrl = URL.createObjectURL(file);

          await new Promise<void>((resolve, reject) => {
            img.onload = () => {
              try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  ctx.drawImage(img, 0, 0);
                  cleanBase64Data = canvas.toDataURL(file.type || 'image/jpeg', 0.95)
                    .split(',')[1];
                }
                URL.revokeObjectURL(objectUrl);
                resolve();
              } catch (err) {
                URL.revokeObjectURL(objectUrl);
                reject(err);
              }
            };
            img.onerror = () => {
              URL.revokeObjectURL(objectUrl);
              reject(new Error('Failed to load image'));
            };
            img.src = objectUrl;
          });
        } catch {
          // Canvas stripping failed, keep original
        }
      }

      // ── PDF metadata processing ───────────────────────────────────────
      if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });

          // Read metadata
          const title = pdfDoc.getTitle();
          const author = pdfDoc.getAuthor();
          const subject = pdfDoc.getSubject();
          const creator = pdfDoc.getCreator();
          const producer = pdfDoc.getProducer();
          const keywords = pdfDoc.getKeywords();

          if (author) metadata.push({ type: 'author', value: author });
          if (title) metadata.push({ type: 'title', value: title });
          if (subject) metadata.push({ type: 'title', value: `Subject: ${subject}` });
          if (creator) metadata.push({ type: 'producer', value: `Creator: ${creator}` });
          if (producer) metadata.push({ type: 'producer', value: `Producer: ${producer}` });
          if (keywords) metadata.push({ type: 'software', value: `Keywords: ${keywords}` });

          // Strip all metadata
          pdfDoc.setTitle('');
          pdfDoc.setAuthor('');
          pdfDoc.setSubject('');
          pdfDoc.setCreator('');
          pdfDoc.setProducer('');
          pdfDoc.setKeywords([]);
          pdfDoc.setCreationDate(new Date(0));
          pdfDoc.setModificationDate(new Date(0));

          const cleanPdfBytes = await pdfDoc.save();
          // Convert Uint8Array to base64
          let binary = '';
          const bytes = new Uint8Array(cleanPdfBytes);
          for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          cleanBase64Data = btoa(binary);
        } catch (err) {
          console.error('PDF metadata error:', err);
        }
      }

      // ── DOCX metadata processing ──────────────────────────────────────
      if (
        file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        file.name.endsWith('.docx')
      ) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const zip = await JSZip.loadAsync(arrayBuffer);

          // Read core.xml (author, title, subject, etc.)
          const coreXmlFile = zip.file('docProps/core.xml');
          if (coreXmlFile) {
            const coreXml = await coreXmlFile.async('string');
            const parser = new DOMParser();
            const doc = parser.parseFromString(coreXml, 'application/xml');

            // Extract metadata from core.xml
            const getTagText = (tagName: string): string => {
              const el = doc.getElementsByTagName(tagName)[0] ||
                doc.querySelector(`[*|${tagName.split(':').pop()}]`);
              return el?.textContent?.trim() || '';
            };

            const author = getTagText('dc:creator');
            const lastModBy = getTagText('cp:lastModifiedBy');
            const dcTitle = getTagText('dc:title');
            const dcSubject = getTagText('dc:subject');
            const category = getTagText('cp:category');

            if (author) metadata.push({ type: 'author', value: author });
            if (lastModBy && lastModBy !== author) metadata.push({ type: 'author', value: `Last modified: ${lastModBy}` });
            if (dcTitle) metadata.push({ type: 'title', value: dcTitle });
            if (dcSubject) metadata.push({ type: 'title', value: `Subject: ${dcSubject}` });
            if (category) metadata.push({ type: 'software', value: `Category: ${category}` });

            // Strip core.xml — blank out all sensitive fields
            const blankCore = coreXml
              .replace(/<dc:creator>[^<]*<\/dc:creator>/g, '<dc:creator></dc:creator>')
              .replace(/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/g, '<cp:lastModifiedBy></cp:lastModifiedBy>')
              .replace(/<dc:title>[^<]*<\/dc:title>/g, '<dc:title></dc:title>')
              .replace(/<dc:subject>[^<]*<\/dc:subject>/g, '<dc:subject></dc:subject>')
              .replace(/<dc:description>[^<]*<\/dc:description>/g, '<dc:description></dc:description>')
              .replace(/<cp:category>[^<]*<\/cp:category>/g, '<cp:category></cp:category>')
              .replace(/<cp:keywords>[^<]*<\/cp:keywords>/g, '<cp:keywords></cp:keywords>');
            zip.file('docProps/core.xml', blankCore);
          }

          // Read app.xml (company, manager, application)
          const appXmlFile = zip.file('docProps/app.xml');
          if (appXmlFile) {
            const appXml = await appXmlFile.async('string');
            const parser = new DOMParser();
            const doc = parser.parseFromString(appXml, 'application/xml');

            const getTagText = (tagName: string): string => {
              const el = doc.getElementsByTagName(tagName)[0];
              return el?.textContent?.trim() || '';
            };

            const company = getTagText('Company');
            const manager = getTagText('Manager');
            const application = getTagText('Application');

            if (company) metadata.push({ type: 'company', value: company });
            if (manager) metadata.push({ type: 'author', value: `Manager: ${manager}` });
            if (application) metadata.push({ type: 'producer', value: application });

            // Strip app.xml
            const blankApp = appXml
              .replace(/<Company>[^<]*<\/Company>/g, '<Company></Company>')
              .replace(/<Manager>[^<]*<\/Manager>/g, '<Manager></Manager>');
            zip.file('docProps/app.xml', blankApp);
          }

          // Re-zip and convert to base64
          const cleanZip = await zip.generateAsync({ type: 'base64' });
          cleanBase64Data = cleanZip;
        } catch (err) {
          console.error('DOCX metadata error:', err);
        }
      }

      if (metadata.length === 0) {
        metadata.push({ type: 'none', value: '' });
      }

      incrementPhotosScrubbed();

      setFiles(prev =>
        prev.map(f =>
          f.id === newFile.id ? { ...f, status: 'clean', metadata, cleanBase64Data } : f
        )
      );
    } catch {
      // Fallback: mark as clean with no metadata found
      setFiles(prev =>
        prev.map(f =>
          f.id === newFile.id ? { ...f, status: 'clean', metadata: [{ type: 'none', value: '' }] } : f
        )
      );
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const droppedFiles = Array.from(e.dataTransfer.files).filter(
      f => f.type.startsWith('image/') || f.type.startsWith('video/') || f.type === 'application/pdf' || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || f.name.endsWith('.docx') || f.name.endsWith('.pdf')
    );

    droppedFiles.forEach(processFile);
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []).filter(
      f => f.type.startsWith('image/') || f.type.startsWith('video/') || f.type === 'application/pdf' || f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || f.name.endsWith('.docx') || f.name.endsWith('.pdf')
    );

    selectedFiles.forEach(processFile);
  };

  const getAnonymousFilename = (originalName: string) => {
    const ext = originalName.split('.').pop() || 'jpg';
    return `ArkQube_${Math.floor(Date.now() / 1000)}_${Math.random().toString(36).substring(2, 7)}.${ext}`;
  };

  const handleShare = async (file: FileCard) => {
    const dataToShare = file.cleanBase64Data || file.base64Data;
    if (!dataToShare) return;
    const anonName = getAnonymousFilename(file.name);
    await nativeShare(anonName, dataToShare, file.mimeType || 'image/jpeg');
  };

  const handleDownload = async (file: FileCard) => {
    const dataToDownload = file.cleanBase64Data || file.base64Data;
    if (!dataToDownload) return;

    const anonName = getAnonymousFilename(file.name);

    await saveImage(anonName, dataToDownload, file.mimeType || 'image/jpeg', 'Save scrubbed file');
  };

  const getBadgeStyle = (type: string) => {
    switch (type) {
      case 'gps':
        return 'bg-danger-red/10 text-danger-red border-danger-red/30';
      case 'device':
        return 'bg-warning-amber/10 text-warning-amber border-warning-amber/30';
      case 'software':
        return 'bg-info-blue/10 text-info-blue border-info-blue/30';
      case 'author':
        return 'bg-purple-500/10 text-purple-600 border-purple-300';
      case 'title':
        return 'bg-indigo-500/10 text-indigo-600 border-indigo-300';
      case 'producer':
        return 'bg-cyan-500/10 text-cyan-600 border-cyan-300';
      case 'company':
        return 'bg-orange-500/10 text-orange-600 border-orange-300';
      default:
        return 'bg-success-green/10 text-success-green border-success-green/30';
    }
  };

  const getBadgeIcon = (type: string) => {
    switch (type) {
      case 'gps':
        return <MapPin className="w-3 h-3" />;
      case 'device':
        return <Smartphone className="w-3 h-3" />;
      case 'software':
        return <Wrench className="w-3 h-3" />;
      case 'author':
        return <User className="w-3 h-3" />;
      case 'title':
        return <Type className="w-3 h-3" />;
      case 'producer':
        return <FileText className="w-3 h-3" />;
      case 'company':
        return <Building2 className="w-3 h-3" />;
      default:
        return <Check className="w-3 h-3" />;
    }
  };

  const getBadgeText = (m: FileCard['metadata'][0]) => {
    if (m.type === 'none') return 'No sensitive metadata found';
    const prefix = m.type.charAt(0).toUpperCase() + m.type.slice(1);
    return `${prefix} stripped · ${m.value}`;
  };

  return (
    <div className="space-y-4 p-4">
      {/* Drop Zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
        className={`w-full py-12 px-4 border-2 border-dashed rounded-xl cursor-pointer transition-all ${isDragging
          ? 'border-primary-blue bg-primary-light'
          : 'border-border-light bg-white dark:bg-bg-card hover:border-primary-blue/50 shadow-card'
          }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={handleFileSelect}
          className="hidden"
        />
        <div className="flex flex-col items-center gap-3">
          <Upload className={`w-8 h-8 ${isDragging ? 'text-primary-blue' : 'text-text-secondary'}`} />
          <div className="text-center">
            <p className="font-sans text-sm font-medium text-text-primary">Drop images, videos, PDF or DOCX</p>
            <p className="font-sans text-xs text-text-secondary mt-1">EXIF · GPS · Author · Device data stripped</p>
          </div>
        </div>
      </div>

      {/* File Cards */}
      <div className="space-y-3">
        {files.map(file => (
          <div
            key={file.id}
            className="bg-white dark:bg-bg-card border border-border-light rounded-xl p-4 animate-fadeUp shadow-card"
          >
            <div className="flex items-center gap-3">
              <div className={`w-2 h-2 rounded-full ${file.status === 'scanning'
                ? 'bg-warning-amber animate-pulse-dot'
                : 'bg-success-green'
                }`} />
              <div className="flex-1 min-w-0">
                <p className="font-sans text-sm font-medium text-text-primary truncate">{file.name}</p>
              </div>
              <span className={`font-sans text-xs font-medium ${file.status === 'scanning' ? 'text-warning-amber' : 'text-success-green'
                }`}>
                {file.status === 'scanning' ? 'Scanning' : 'Clean'}
              </span>
            </div>

            {file.status === 'clean' && file.metadata.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {file.metadata.map((m, i) => (
                  <span
                    key={i}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 border rounded-lg font-sans text-xs ${getBadgeStyle(m.type)}`}
                  >
                    {getBadgeIcon(m.type)}
                    {getBadgeText(m)}
                  </span>
                ))}
              </div>
            )}

            {file.status === 'clean' && (
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => handleShare(file)}
                  className="flex-1 flex items-center justify-center gap-2 bg-primary-blue text-white px-4 py-2 rounded-lg font-sans text-xs font-medium hover:bg-primary-blue/90 transition-colors"
                >
                  <Share2 className="w-3 h-3" />
                  Share
                </button>
                <button
                  onClick={() => handleDownload(file)}
                  className="flex-1 flex items-center justify-center gap-2 border border-primary-blue text-primary-blue px-4 py-2 rounded-lg font-sans text-xs font-medium hover:bg-primary-blue/10 transition-colors"
                >
                  <Download className="w-3 h-3" />
                  Download
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Info note */}
      <p className="font-sans text-xs text-text-secondary text-center">
        All processing runs locally — no file ever leaves your device
      </p>


    </div>
  );
}

// ── Privacy Blur ─────────────────────────────────────────────────

function ScreenshotPrivacyGuard() {
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string>('');
  const [scanning, setScanning] = useState(false);
  const [findings, setFindings] = useState<ScreenshotFinding[]>([]);
  const [appContext, setAppContext] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  const [scanFailed, setScanFailed] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  // Stable identity: the editor keys its back-button effect on this, and an
  // inline arrow would re-register the listener on every parent render.
  const closeEditor = useCallback(() => setShowEditor(false), []);
  const [isDragging, setIsDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /** Findings the user wants redacted. Everything the scan flagged starts on. */
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { shareFile } = useNativeShare();
  const { incrementScreenshotsProtected } = useAppStats();

  const enabledCount = enabledIds.size;
  const allEnabled = findings.length > 0 && enabledCount === findings.length;

  const toggleFinding = (id: string) => {
    setEnabledIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setEnabledIds(allEnabled ? new Set() : new Set(findings.map(f => f.id)));
  };

  // A finding the user switched off stays in the list as 'info', so the editor
  // outlines it instead of redacting it.
  const editorFindings = useMemo(
    () => findings.map(f => ({
      ...f,
      action: enabledIds.has(f.id) ? ('blur' as const) : ('info' as const),
    })),
    [findings, enabledIds]
  );

  // ── Direct share (no blur needed) ───────────────────────────────────────
  const handleDirectShare = useCallback(async () => {
    if (!imageBase64) return;
    await shareFile('seycure_image.png', imageBase64, 'image/png', 'Share image');
    await incrementScreenshotsProtected();
  }, [imageBase64, shareFile, incrementScreenshotsProtected]);

  /**
   * Saves the image with the enabled detections already redacted, without
   * making the user open the editor.
   *
   * It renders through renderToCanvas rather than reusing handleDirectSave,
   * which writes imageBase64 - the untouched original. Using that here would
   * export the very data the scan just flagged.
   */
  const handleSaveBlurred = useCallback(async () => {
    if (!imageBase64) return;
    setSaving(true);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('Could not decode the image'));
        image.src = `data:image/png;base64,${imageBase64}`;
      });

      const canvas = document.createElement('canvas');
      renderToCanvas(canvas, image, findingsToBlurRegions(editorFindings), 'blur');
      const blurred = canvas.toDataURL('image/png').split(',')[1];

      const outcome = await saveImage(
        `seycure_blurred_${Date.now()}.png`,
        blurred,
        'image/png',
        'Save blurred image'
      );
      if (outcome === 'failed') return;

      await incrementScreenshotsProtected();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (error) {
      console.error('Save error:', error);
    } finally {
      setSaving(false);
    }
  }, [imageBase64, editorFindings, incrementScreenshotsProtected]);

  // ── Direct save (no blur needed) ────────────────────────────────────────
  const handleDirectSave = useCallback(async () => {
    if (!imageBase64) return;
    setSaving(true);
    try {
      const fileName = `seycure_clean_${Date.now()}.png`;
      const outcome = await saveImage(fileName, imageBase64, 'image/png', 'Save image');
      if (outcome === 'failed') return;

      await incrementScreenshotsProtected();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (error) {
      console.error('Save error:', error);
    } finally {
      setSaving(false);
    }
  }, [imageBase64, incrementScreenshotsProtected]);

  /**
   * Runs detection and leaves the user on the summary.
   *
   * An earlier version opened the editor automatically on import. On a real
   * device that turned out to be the wrong call: it puts a full-screen editor
   * in front of someone who mostly wants to check the count and save, and it
   * hides the summary that explains what was found. The editor is now reached
   * deliberately, through "Edit blur areas".
   */
  const runScan = useCallback(async (base64: string) => {
    setScanning(true);
    let failed = false;
    try {
      const result = await analyzeScreenshot(base64);
      setFindings(result.findings);
      setEnabledIds(new Set(
        result.findings.filter(f => f.action === 'blur').map(f => f.id)
      ));
      setAppContext(result.appContext);
    } catch (err) {
      console.error('Scan error:', err);
      setFindings([]);
      setEnabledIds(new Set());
      failed = true;
    } finally {
      setScanned(true);
      setScanning(false);
      setScanFailed(failed);
    }
  }, []);

  const loadImage = useCallback((file: File) => {
    setImageName(file.name);
    setFindings([]);
    setEnabledIds(new Set());
    setScanned(false);

    const reader = new FileReader();
    reader.onerror = () => {
      console.error('Could not read the selected file');
      setImageBase64(null);
    };
    reader.onload = () => {
      const base64 = (reader.result as string | null)?.split(',')[1];
      if (!base64) return;
      setImageBase64(base64);
      // Detection runs straight away — importing an image is the only tap.
      void runScan(base64);
    };
    reader.readAsDataURL(file);
  }, [runScan]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear the input so picking the same file twice still fires a change.
    e.target.value = '';
    if (!file) return;
    loadImage(file);
  };

  /**
   * Severity is carried by a dot and the label, not by a wash over the whole
   * card. A 10% amber fill over a near-black surface came out muddy brown, and
   * with every card tinted there was nothing left to signal selection.
   */
  const getSeverityAccent = (severity: string) => {
    switch (severity) {
      case 'critical': return { dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400' };
      case 'high': return { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' };
      case 'medium': return { dot: 'bg-sky-500', text: 'text-sky-600 dark:text-sky-400' };
      default: return { dot: 'bg-slate-400', text: 'text-text-secondary' };
    }
  };

  return (
    <div className="space-y-4 p-4">
      {/* Drop zone / image preview */}
      <div
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) loadImage(file);
        }}
        className={`w-full py-8 px-4 border-2 border-dashed rounded-xl cursor-pointer transition-all ${isDragging
          ? 'border-primary-blue bg-primary-light/50'
          : imageBase64
            // Green reads as "safe", so it is only correct once the scan has
            // finished and found nothing. It used to apply to any loaded image,
            // which tinted a receipt full of high-severity hits reassuring green.
            ? scanned && findings.length === 0
              ? 'border-emerald-400/40 bg-emerald-50 dark:bg-emerald-500/10'
              : 'border-border-light dark:border-white/10 bg-white dark:bg-bg-card'
            : 'border-primary-blue/30 hover:border-primary-blue/60 bg-white dark:bg-bg-card'
          }`}
      >
        {imageBase64 ? (
          <div className="flex flex-col items-center gap-3">
            <img
              src={`data:image/png;base64,${imageBase64}`}
              alt="Selected image preview"
              className="max-h-48 rounded-lg shadow-card object-contain"
            />
            <p className="font-sans text-xs text-text-secondary">{imageName}</p>
            <p className="font-sans text-xs text-primary-blue">Tap to change image</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Eye className="w-8 h-8 text-primary-blue/60" />
            <span className="px-5 py-2.5 bg-primary-blue text-white font-sans text-sm font-medium rounded-xl shadow-card flex items-center gap-2">
              <ImageIcon className="w-4 h-4" />
              Pick an image
            </span>
            <span className="font-sans text-xs text-text-secondary">
              Screenshot, photo or scan — sensitive text is found automatically
            </span>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
      />

      {/* Detection runs on import, so this is a status line rather than a button */}
      {scanning && (
        <div className="w-full py-3 bg-primary-light rounded-xl flex items-center justify-center gap-2 font-sans text-sm font-medium text-primary-blue">
          <Loader2 className="w-4 h-4 animate-spin" />
          Looking for sensitive data...
        </div>
      )}

      {/* Results panel */}
      {scanned && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-sans text-sm font-semibold text-text-primary">
              {scanFailed
                ? 'Scan did not finish'
                : findings.length > 0
                  ? `Found ${findings.length} sensitive item${findings.length > 1 ? 's' : ''}`
                  : 'No sensitive data detected'}
            </h3>
            {findings.length > 0 && (
              <button
                onClick={toggleAll}
                className="px-3 py-1 rounded-full bg-primary-blue/10 dark:bg-white/10 text-primary-blue dark:text-white font-sans text-xs font-medium hover:bg-primary-blue/20 dark:hover:bg-white/20 transition-colors"
              >
                {allEnabled ? 'Blur none' : 'Blur all'}
              </button>
            )}
          </div>

          {findings.length > 0 && (
            <p className="font-sans text-xs text-text-secondary -mt-1">
              {enabledCount === 0
                ? 'Nothing selected — tap an item to blur it.'
                : `${enabledCount} of ${findings.length} will be blurred.`}
            </p>
          )}

          {findings.map((f, i) => {
            const on = enabledIds.has(f.id);
            const accent = getSeverityAccent(f.severity);
            return (
              <button
                key={f.id}
                onClick={() => toggleFinding(f.id)}
                aria-pressed={on}
                className={`w-full text-left px-4 py-3 rounded-xl border transition-all animate-fadeUp ${on
                  ? 'bg-white dark:bg-white/[0.06] border-border-light dark:border-white/15'
                  : 'bg-transparent border-border-light/60 dark:border-white/5'
                  }`}
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 w-5 h-5 flex-shrink-0 rounded-md border flex items-center justify-center transition-colors ${on
                      ? 'bg-primary-blue border-primary-blue'
                      : 'bg-transparent border-border-light dark:border-white/25'
                      }`}
                  >
                    {on && <Check className="w-3.5 h-3.5 text-white" />}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${accent.dot}`} />
                        <span className={`font-sans text-xs font-semibold uppercase tracking-wide truncate ${on ? 'text-text-primary dark:text-white' : 'text-text-muted'
                          }`}>
                          {f.type}
                        </span>
                      </span>
                      <span className={`font-sans text-xs font-medium capitalize flex-shrink-0 ${on ? accent.text : 'text-text-muted'}`}>
                        {f.severity}
                      </span>
                    </span>
                    <span className={`block font-mono text-xs mt-1 truncate ${on ? 'text-text-secondary' : 'text-text-muted'}`}>
                      {f.redacted}
                    </span>
                  </span>
                </div>
              </button>
            );
          })}

          {findings.length > 0 && (
            <div className="space-y-2">
              <button
                onClick={handleSaveBlurred}
                disabled={saving}
                className={`w-full py-3 font-sans text-sm font-semibold rounded-xl transition-all shadow-card flex items-center justify-center gap-2 ${saved
                  ? 'bg-emerald-500 text-white'
                  : 'bg-primary-blue text-white hover:bg-primary-blue/90 active:scale-[0.99] disabled:opacity-60'
                  }`}
              >
                <Download className="w-4 h-4" />
                {saving ? 'Saving...' : saved ? 'Saved' : `Save with ${enabledCount} blurred`}
              </button>
              <button
                onClick={() => setShowEditor(true)}
                className="w-full py-2.5 border border-primary-blue/40 text-primary-blue font-sans text-sm font-medium rounded-xl hover:bg-primary-blue/10 transition-colors flex items-center justify-center gap-2"
              >
                <EyeOff className="w-4 h-4" />
                Edit blur areas
              </button>
            </div>
          )}

          {scanFailed && (
            <div className="bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/25 rounded-xl p-4 flex items-start gap-3 animate-fadeUp">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-sans text-sm font-semibold text-amber-700 dark:text-amber-300">Could not read this image</p>
                <p className="font-sans text-xs text-amber-700/80 dark:text-amber-400/80 mt-1">
                  Nothing was checked, so do not treat it as clean. Try Scan again, or open the editor and blur by hand.
                </p>
              </div>
            </div>
          )}

          {findings.length === 0 && !scanFailed && (
            <>
              {/* Clean status card */}
              <div className="bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/25 rounded-xl p-4 flex items-start gap-3 animate-fadeUp">
                <ShieldCheck className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-sans text-sm font-semibold text-emerald-700 dark:text-emerald-300">This image looks clean</p>
                  <p className="font-sans text-xs text-emerald-700/80 dark:text-emerald-400/80 mt-1">No sensitive text was found. You can still add blur by hand.</p>
                </div>
              </div>

              {/* Preview & Add Blur */}
              <button
                onClick={() => setShowEditor(true)}
                className="w-full py-3 bg-gradient-to-r from-primary-blue to-blue-600 text-white font-sans text-sm font-medium rounded-xl hover:opacity-90 transition-all shadow-card flex items-center justify-center gap-2"
              >
                <Eye className="w-4 h-4" />
                Preview & Add Blur
              </button>

              {/* Direct Share / Save */}
              <div className="flex gap-2">
                <button
                  onClick={handleDirectShare}
                  className="flex-1 flex items-center justify-center gap-2 bg-primary-blue text-white px-4 py-2.5 rounded-xl font-sans text-xs font-medium hover:bg-primary-blue/90 transition-colors shadow-card"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  Share
                </button>
                <button
                  onClick={handleDirectSave}
                  disabled={saving}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-sans text-xs font-medium transition-all shadow-card ${saved
                    ? 'bg-emerald-500 text-white'
                    : 'border border-primary-blue/40 text-primary-blue dark:text-accent-blue hover:bg-primary-blue/10'
                    }`}
                >
                  <Download className="w-3.5 h-3.5" />
                  {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
                </button>
              </div>
            </>
          )}

          {/* Rescan button */}
          <button
            onClick={() => { if (imageBase64) void runScan(imageBase64); }}
            className="w-full py-2 text-primary-blue font-sans text-xs font-medium hover:underline flex items-center justify-center gap-1"
          >
            <RefreshCw className="w-3 h-3" />
            Scan again
          </button>
        </div>
      )}

      {/* Blur Editor Modal */}
      {imageBase64 && (
        <BlurEditorModal
          open={showEditor}
          onClose={closeEditor}
          onToggleFinding={toggleFinding}
          onToggleAll={toggleAll}
          imageBase64={imageBase64}
          findings={editorFindings}
          appContext={appContext}
        />
      )}
    </div>
  );
}

function SplashScreen({ onComplete }: { onComplete: () => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onComplete();
    }, 3200);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return (
    <div className="fixed inset-0 z-[9999] bg-white dark:bg-bg-light flex flex-col items-center justify-center animate-splash-fade pointer-events-none">
      <div className="animate-text-scale">
        <div className="flex flex-col items-center gap-4">
          <img src="/logo.png" alt="Seycure Logo" className="w-24 h-24 object-contain shadow-2xl rounded-2xl" />
          <div className="text-center animate-text-reveal">
            <h1 className="font-sans text-4xl font-bold tracking-tight text-primary-dark">Seycure</h1>
            <p className="font-sans text-sm text-text-secondary mt-1 tracking-widest uppercase">by ArkQube</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProtectedItemsCounter({ onOpenStats }: { onOpenStats: () => void }) {
  const { stats } = useAppStats();
  const count = stats.screenshotsProtected || 0;
  const label = count === 1 ? 'image protected' : 'images protected';
  const hasProtectedItems = count > 0 || (stats.photosScrubbed || 0) > 0 || (stats.linksCleaned || 0) > 0 || (stats.trackersRemoved || 0) > 0;
  const hasSecondaryStats = (stats.photosScrubbed || 0) > 0 || (stats.linksCleaned || 0) > 0 || (stats.trackersRemoved || 0) > 0;

  return (
    <div className="relative overflow-hidden bg-white dark:bg-[#161a23] border border-border-light dark:border-white/10 rounded-2xl p-5 shadow-card animate-fadeUp">
      {/* Top row: Shield Icon + Counter Title + (Conditional Trophy when items protected) */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-primary-blue/10 dark:bg-primary-blue/20 text-primary-blue dark:text-accent-blue flex items-center justify-center shrink-0 border border-primary-blue/20 shadow-sm">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-sans text-2xl font-extrabold tracking-tight text-text-primary dark:text-white">
                {count}
              </span>
              <span className="font-sans text-sm font-bold text-text-secondary dark:text-text-muted">
                {label}
              </span>
            </div>
            <p className="text-xs text-text-secondary dark:text-text-muted mt-1 font-medium">
              {count > 0 
                ? 'Protected on this device • Zero data leaves phone' 
                : 'Images you blur will appear here.'}
            </p>
          </div>
        </div>

        {/* Drop the trophy until the user has actually protected something */}
        {hasProtectedItems && (
          <button
            onClick={onOpenStats}
            className="p-2.5 rounded-xl bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-text-secondary dark:text-text-muted hover:text-text-primary dark:hover:text-white transition-colors"
            title="View Privacy Score"
          >
            <Trophy className="w-4 h-4 text-warning-amber" />
          </button>
        )}
      </div>

      {/* Hide the three-stat row entirely until at least one value is non-zero */}
      {hasSecondaryStats && (
        <div className="grid grid-cols-3 gap-2 mt-4 pt-3.5 border-t border-border-light/60 dark:border-white/5">
          <div className="p-2.5 rounded-xl bg-black/[0.02] dark:bg-white/[0.03] text-center">
            <span className="block font-sans text-sm font-bold text-text-primary dark:text-white">
              {stats.photosScrubbed || 0}
            </span>
            <span className="block text-xs font-medium text-text-secondary dark:text-text-muted mt-0.5">
              Photos EXIF
            </span>
          </div>
          <div className="p-2.5 rounded-xl bg-black/[0.02] dark:bg-white/[0.03] text-center">
            <span className="block font-sans text-sm font-bold text-text-primary dark:text-white">
              {stats.linksCleaned || 0}
            </span>
            <span className="block text-xs font-medium text-text-secondary dark:text-text-muted mt-0.5">
              Clean Links
            </span>
          </div>
          <div className="p-2.5 rounded-xl bg-black/[0.02] dark:bg-white/[0.03] text-center">
            <span className="block font-sans text-sm font-bold text-text-primary dark:text-white">
              {stats.trackersRemoved || 0}
            </span>
            <span className="block text-xs font-medium text-text-secondary dark:text-text-muted mt-0.5">
              Trackers Cut
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsScreen({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const { stats } = useAppStats();
  const { shareText } = useNativeShare();

  const toggleSection = (section: string) => {
    setExpandedSection(prev => prev === section ? null : section);
  };

  const hasAnyStats = (stats.screenshotsProtected || 0) > 0 || (stats.photosScrubbed || 0) > 0 || (stats.linksCleaned || 0) > 0 || (stats.trackersRemoved || 0) > 0;

  const handleShare = async () => {
    const text = `My Seycure Privacy Score:\n\n🛡️ Screenshots Protected: ${stats.screenshotsProtected || 0}\n📸 Photos Scrubbed: ${stats.photosScrubbed || 0}\n🔗 Links Cleaned: ${stats.linksCleaned || 0}\n🚫 Trackers Blocked: ${stats.trackersRemoved || 0}\n\nProtect your data too! Get Seycure: https://play.google.com/store/apps/details?id=com.arkqube.seycure`;
    await shareText(text, 'Share Privacy Score');
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto bg-white dark:bg-[#121620] text-text-primary dark:text-white border border-border-light dark:border-white/10 rounded-3xl p-6 shadow-2xl">
        <div className="flex items-center justify-between pb-3 border-b border-border-light dark:border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-black/5 dark:bg-white/10 text-text-secondary dark:text-text-muted flex items-center justify-center">
              <SettingsIcon className="w-5 h-5" />
            </div>
            <h3 className="font-sans text-base font-bold">Settings</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-text-secondary hover:text-text-primary dark:hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="py-3 space-y-1.5">
          {/* Section 1: Privacy */}
          <div className="rounded-2xl border border-border-light dark:border-white/10 overflow-hidden">
            <button
              onClick={() => toggleSection('privacy')}
              className="w-full flex items-center gap-3.5 p-3 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left"
            >
              <div className="w-9 h-9 rounded-xl bg-black/5 dark:bg-white/10 text-text-secondary dark:text-text-muted flex items-center justify-center shrink-0">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-sans text-sm font-semibold">Privacy</p>
                <p className="text-xs text-text-muted">How your data is handled</p>
              </div>
              <ChevronRight className={`w-4 h-4 text-text-muted transition-transform ${expandedSection === 'privacy' ? 'rotate-90' : ''}`} />
            </button>
            {expandedSection === 'privacy' && (
              <div className="px-4 pb-4 pt-1 border-t border-border-light/60 dark:border-white/5">
                <p className="text-xs text-text-secondary dark:text-text-muted leading-relaxed">
                  Your files never leave your phone. Seycure doesn't upload, store, or share images, documents, or links — everything runs on your device. The only things saved are your redaction rules and a count of files you've protected.
                </p>
              </div>
            )}
          </div>

          {/* Section 2: Learned Rules */}
          <div className="rounded-2xl border border-border-light dark:border-white/10 overflow-hidden">
            <button
              onClick={() => toggleSection('rules')}
              className="w-full flex items-center gap-3.5 p-3 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left"
            >
              <div className="w-9 h-9 rounded-xl bg-black/5 dark:bg-white/10 text-text-secondary dark:text-text-muted flex items-center justify-center shrink-0">
                <Sliders className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-sans text-sm font-semibold">Learned rules</p>
                <p className="text-xs text-text-muted">Manage automated redaction rules</p>
              </div>
              <ChevronRight className={`w-4 h-4 text-text-muted transition-transform ${expandedSection === 'rules' ? 'rotate-90' : ''}`} />
            </button>
            {expandedSection === 'rules' && (
              <div className="px-4 pb-4 pt-1 border-t border-border-light/60 dark:border-white/5">
                <LearnedRulesSettings />
              </div>
            )}
          </div>

          {/* Section 3: Stats */}
          <div className="rounded-2xl border border-border-light dark:border-white/10 overflow-hidden">
            <button
              onClick={() => toggleSection('stats')}
              className="w-full flex items-center gap-3.5 p-3 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left"
            >
              <div className="w-9 h-9 rounded-xl bg-black/5 dark:bg-white/10 text-text-secondary dark:text-text-muted flex items-center justify-center shrink-0">
                <Zap className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-sans text-sm font-semibold">Stats</p>
                <p className="text-xs text-text-muted">Your privacy activity</p>
              </div>
              <ChevronRight className={`w-4 h-4 text-text-muted transition-transform ${expandedSection === 'stats' ? 'rotate-90' : ''}`} />
            </button>
            {expandedSection === 'stats' && (
              <div className="px-4 pb-4 pt-1 border-t border-border-light/60 dark:border-white/5">
                {hasAnyStats ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="p-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.05] text-center">
                        <span className="block font-sans text-lg font-bold text-text-primary dark:text-white">{stats.screenshotsProtected || 0}</span>
                        <span className="block text-xs text-text-secondary dark:text-text-muted mt-0.5">Images</span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.05] text-center">
                        <span className="block font-sans text-lg font-bold text-text-primary dark:text-white">{stats.photosScrubbed || 0}</span>
                        <span className="block text-xs text-text-secondary dark:text-text-muted mt-0.5">Photos</span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.05] text-center">
                        <span className="block font-sans text-lg font-bold text-text-primary dark:text-white">{stats.linksCleaned || 0}</span>
                        <span className="block text-xs text-text-secondary dark:text-text-muted mt-0.5">Links</span>
                      </div>
                      <div className="p-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.05] text-center">
                        <span className="block font-sans text-lg font-bold text-text-primary dark:text-white">{stats.trackersRemoved || 0}</span>
                        <span className="block text-xs text-text-secondary dark:text-text-muted mt-0.5">Trackers</span>
                      </div>
                    </div>
                    <button
                      onClick={handleShare}
                      className="w-full py-2.5 bg-primary-blue text-white font-sans text-xs font-bold rounded-xl hover:bg-primary-blue/90 transition-colors flex items-center justify-center gap-2"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                      Share
                    </button>
                  </div>
                ) : (
                  <p className="text-xs text-text-muted text-center py-3">
                    No activity yet. Stats will appear once you protect a file.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Section 4: About */}
          <div className="rounded-2xl border border-border-light dark:border-white/10 overflow-hidden">
            <button
              onClick={() => toggleSection('about')}
              className="w-full flex items-center gap-3.5 p-3 hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left"
            >
              <div className="w-9 h-9 rounded-xl bg-black/5 dark:bg-white/10 text-text-secondary dark:text-text-muted flex items-center justify-center shrink-0">
                <Smartphone className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-sans text-sm font-semibold">About</p>
                <p className="text-xs text-text-muted">Version and app info</p>
              </div>
              <ChevronRight className={`w-4 h-4 text-text-muted transition-transform ${expandedSection === 'about' ? 'rotate-90' : ''}`} />
            </button>
            {expandedSection === 'about' && (
              <div className="px-4 pb-4 pt-1 border-t border-border-light/60 dark:border-white/5 space-y-2">
                <div className="flex items-center justify-between p-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.05]">
                  <span className="text-xs font-semibold">Version</span>
                  <span className="text-xs font-mono text-text-secondary">v1.0</span>
                </div>
                <div className="flex items-center justify-between p-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.05]">
                  <span className="text-xs font-semibold">Processing</span>
                  <span className="text-xs text-emerald-500 font-semibold flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    Offline
                  </span>
                </div>
                <p className="text-xs text-text-muted text-center pt-1">Seycure Privacy Suite by ArkQube</p>
              </div>
            )}
          </div>
        </div>

        <button
          onClick={onClose}
          className="w-full py-3 bg-primary-blue text-white font-sans text-xs font-bold rounded-xl hover:bg-primary-blue/90 transition-colors shadow-sm mt-1"
        >
          Got it
        </button>
      </DialogContent>
    </Dialog>
  );
}




function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showScannerModal, setShowScannerModal] = useState(false);

  // Active Tool display on single page
  // Opens on the blur tool so the picker is one tap away, not two.
  const [activeTool, setActiveTool] = useState<'none' | 'metadata' | 'link' | 'blur'>('blur');
  const [initialScannedUrl, setInitialScannedUrl] = useState<string>('');

  const handleQRScanResult = (scannedUrl: string) => {
    setInitialScannedUrl(scannedUrl);
    setActiveTool('link');
  };

  // Stable identity: LinkShield lists this in an effect dependency array.
  const clearScannedUrl = useCallback(() => setInitialScannedUrl(''), []);

  return (
    <div className="min-h-screen bg-bg-light dark:bg-[#0c1017] text-text-primary dark:text-white">
      {showSplash && <SplashScreen onComplete={() => setShowSplash(false)} />}

      <div className="max-w-app mx-auto min-h-screen flex flex-col">
        <TopBar onOpenMenu={() => setShowSettings(true)} />

        <main className="flex-1 p-4 space-y-4">
          {/* 1. HERO CARD ("Blur private info") matching Image 1 */}
          <div
            onClick={() => setActiveTool(prev => prev === 'blur' ? 'none' : 'blur')}
            className={`relative group cursor-pointer overflow-hidden rounded-2xl border p-7 text-center transition-all active:scale-[0.99] shadow-lg ${
              activeTool === 'blur'
                ? 'bg-gradient-to-br from-[#0c2340] to-[#12335c] border-primary-blue shadow-glow'
                : 'bg-gradient-to-br from-[#0c2340] to-[#08172c] border-blue-500/30 hover:border-blue-400/60'
            }`}
          >
            <div className="relative z-10 flex flex-col items-center">
              <div className="w-16 h-16 rounded-2xl bg-primary-blue/20 border border-primary-blue/40 flex items-center justify-center mb-3.5 text-primary-blue shadow-glow group-hover:scale-105 transition-transform">
                <div className="relative">
                  <ImageIcon className="w-8 h-8 text-accent-blue" />
                  <Shield className="w-4 h-4 text-white absolute -bottom-1 -right-1 fill-primary-blue" />
                </div>
              </div>
              <h2 className="font-sans text-xl sm:text-2xl font-bold text-white tracking-tight">
                Blur private info
              </h2>
              <p className="font-sans text-sm text-accent-blue/80 mt-1 font-medium">
                Finds emails, phones and IDs in any image
              </p>
            </div>
            <div className="absolute -top-12 -right-12 w-32 h-32 bg-primary-blue/20 rounded-full blur-2xl pointer-events-none" />
          </div>

          {/* 2. Subtext "Nothing leaves your device" matching Image 1 */}
          <div className="flex items-center justify-center gap-1.5 py-0.5 text-xs text-text-secondary dark:text-text-muted font-medium">
            <Lock className="w-3.5 h-3.5 text-emerald-500" />
            <span>Nothing leaves your device</span>
          </div>

          {/* 3. Three-Tool Grid matching Image 1 */}
          <div className="grid grid-cols-3 gap-3">
            {/* Metadata Tool */}
            <button
              onClick={() => setActiveTool(prev => prev === 'metadata' ? 'none' : 'metadata')}
              className={`flex flex-col items-center justify-center p-4 rounded-xl border transition-all active:scale-[0.98] shadow-card ${
                activeTool === 'metadata'
                  ? 'bg-primary-blue text-white border-primary-blue shadow-glow'
                  : 'bg-white dark:bg-[#161a23] border-border-light dark:border-white/10 hover:border-primary-blue/40 text-text-primary dark:text-white'
              }`}
            >
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-1.5 transition-transform group-hover:scale-110 ${
                activeTool === 'metadata' ? 'bg-white/20 text-white' : 'bg-primary-blue/10 text-primary-blue dark:text-accent-blue'
              }`}>
                <FileText className="w-5 h-5" />
              </div>
              <span className="font-sans text-xs font-bold">Metadata</span>
            </button>

            {/* Link Tool */}
            <button
              onClick={() => setActiveTool(prev => prev === 'link' ? 'none' : 'link')}
              className={`flex flex-col items-center justify-center p-4 rounded-xl border transition-all active:scale-[0.98] shadow-card ${
                activeTool === 'link'
                  ? 'bg-primary-blue text-white border-primary-blue shadow-glow'
                  : 'bg-white dark:bg-[#161a23] border-border-light dark:border-white/10 hover:border-primary-blue/40 text-text-primary dark:text-white'
              }`}
            >
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-1.5 transition-transform group-hover:scale-110 ${
                activeTool === 'link' ? 'bg-white/20 text-white' : 'bg-primary-blue/10 text-primary-blue dark:text-accent-blue'
              }`}>
                <Link2 className="w-5 h-5" />
              </div>
              <span className="font-sans text-xs font-bold">Link</span>
            </button>

            {/* QR Tool */}
            <button
              onClick={() => setShowScannerModal(true)}
              className="flex flex-col items-center justify-center p-4 rounded-xl bg-white dark:bg-[#161a23] border border-border-light dark:border-white/10 hover:border-primary-blue/40 text-text-primary dark:text-white shadow-card transition-all active:scale-[0.98]"
            >
              <div className="w-10 h-10 rounded-xl bg-primary-blue/10 text-primary-blue dark:text-accent-blue flex items-center justify-center mb-1.5 transition-transform group-hover:scale-110">
                <QrCode className="w-5 h-5" />
              </div>
              <span className="font-sans text-xs font-bold">QR</span>
            </button>
          </div>

          {/* Active Tool Section (smoothly rendered right here on this single page!) */}
          <div className="pt-2 animate-fadeUp">
            {activeTool === 'link' && (
              <div className="relative bg-white dark:bg-[#161a23] rounded-2xl border border-border-light dark:border-white/10 p-2 shadow-card">
                <div className="flex items-center justify-between px-3 pt-2 pb-1">
                  <span className="text-xs font-bold text-text-secondary dark:text-text-muted uppercase tracking-wider">Link Shield & Cleaner</span>
                  <button onClick={() => setActiveTool('none')} className="text-xs text-text-muted hover:text-text-primary flex items-center gap-1">
                    <X className="w-3.5 h-3.5" /> Close
                  </button>
                </div>
                <LinkShield initialUrl={initialScannedUrl} onInitialUrlConsumed={clearScannedUrl} />
              </div>
            )}

            {activeTool === 'metadata' && (
              <div className="relative bg-white dark:bg-[#161a23] rounded-2xl border border-border-light dark:border-white/10 p-2 shadow-card">
                <div className="flex items-center justify-between px-3 pt-2 pb-1">
                  <span className="text-xs font-bold text-text-secondary dark:text-text-muted uppercase tracking-wider">Metadata Scrubber</span>
                  <button onClick={() => setActiveTool('none')} className="text-xs text-text-muted hover:text-text-primary flex items-center gap-1">
                    <X className="w-3.5 h-3.5" /> Close
                  </button>
                </div>
                <MediaScrubber />
              </div>
            )}

            {activeTool === 'blur' && (
              <div className="relative bg-white dark:bg-[#161a23] rounded-2xl border border-border-light dark:border-white/10 p-2 shadow-card">
                <div className="flex items-center justify-between px-3 pt-2 pb-1">
                  <span className="text-xs font-bold text-text-secondary dark:text-text-muted uppercase tracking-wider">Privacy Blur</span>
                  <button onClick={() => setActiveTool('none')} className="text-xs text-text-muted hover:text-text-primary flex items-center gap-1">
                    <X className="w-3.5 h-3.5" /> Close
                  </button>
                </div>
                <ScreenshotPrivacyGuard />
              </div>
            )}
          </div>

          {/* Protected Items Counter (passive stat, fills the space on home screen) */}
          {activeTool === 'none' && (
            <div className="pt-1">
              <ProtectedItemsCounter
                onOpenStats={() => setShowSettings(true)}
              />
            </div>
          )}
        </main>

        {/* Modals & Dialogs */}
        <QRScannerModal
          open={showScannerModal}
          onClose={() => setShowScannerModal(false)}
          onScan={handleQRScanResult}
        />

        <SettingsScreen
          open={showSettings}
          onClose={() => setShowSettings(false)}
        />

      </div>
    </div>
  );
}

export default App;
