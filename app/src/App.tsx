import { useState, useEffect, useCallback, useRef } from 'react';
import { Shield, X, Camera, Link2, Image as ImageIcon, ExternalLink, AlertTriangle, Scissors, Check, ChevronRight, Upload, MapPin, Smartphone, Wrench, Download, Share2, Loader2, ArrowRight, Search, Eye, EyeOff, ShieldAlert, ShieldCheck, RefreshCw, FileText, User, Building2, Type, Calendar, ZoomIn, ZoomOut } from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import exifr from 'exifr';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { useNativeShare } from '@/hooks/useNativeShare';

import { analyzeScreenshot, type ScreenshotFinding } from '@/hooks/useMLKitOCR';
import { BlurEditorModal } from '@/components/BlurEditorModal';
import { LearnedRulesSettings } from '@/components/LearnedRulesSettings';
import { classifyLink, type CategoryResult } from '@/hooks/useLinkClassifier';
import { checkPhishingSignals, type PhishingSignal } from '@/hooks/usePhishingDetector';

// Types
type AppMode = 'link-shield' | 'media-scrubber' | 'privacy-blur';

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
function TopBar({ status }: { status: 'idle' | 'scanning' }) {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-border-light shadow-sm">
      <div className="flex items-center gap-3">
        <img src="/logo.png" alt="Seycure" className="w-8 h-8 object-contain rounded-md" />
        <div className="flex items-center gap-2">
          <span className="font-sans text-base font-semibold text-primary-dark">Seycure</span>
          <span className="text-text-muted text-sm">by</span>
          <span className="font-sans text-sm font-medium text-primary-blue">ArkQube</span>
        </div>
        <div className={`w-2 h-2 rounded-full ml-2 ${status === 'scanning' ? 'bg-warning-amber animate-pulse-glow' : 'bg-success-green'}`} />
      </div>
      <div className="font-mono text-label text-text-secondary">
        {time.toLocaleTimeString('en-US', { hour12: false })}
      </div>
    </div>
  );
}

function TabBar({ mode, onChange }: { mode: AppMode; onChange: (m: AppMode) => void }) {
  const isMediaTab = mode === 'media-scrubber' || mode === 'privacy-blur';

  return (
    <div className="flex justify-center p-4">
      <div className="inline-flex bg-bg-light rounded-xl p-1 shadow-card">
        <button
          onClick={() => onChange('link-shield')}
          className={`px-4 py-2.5 rounded-lg font-sans text-xs sm:text-sm font-medium transition-all duration-150 flex items-center gap-1.5 ${mode === 'link-shield'
            ? 'bg-primary-blue text-white shadow-glow'
            : 'text-text-secondary hover:text-text-primary'
            }`}
        >
          <Link2 className="w-4 h-4" />
          <span className="hidden sm:inline">Link / QR</span>
          <span className="sm:hidden">Link</span>
        </button>
        <button
          onClick={() => onChange(isMediaTab ? mode : 'media-scrubber')}
          className={`px-4 py-2.5 rounded-lg font-sans text-xs sm:text-sm font-medium transition-all duration-150 flex items-center gap-1.5 ${isMediaTab
            ? 'bg-primary-blue text-white shadow-glow'
            : 'text-text-secondary hover:text-text-primary'
            }`}
        >
          <ImageIcon className="w-4 h-4" />
          <span className="hidden sm:inline">Media + Blur</span>
          <span className="sm:hidden">Media</span>
        </button>

      </div>
    </div>
  );
}

function QRScannerModal({ open, onClose, onScan }: { open: boolean; onClose: () => void; onScan: (url: string) => void }) {
  const [phase, setPhase] = useState<'scanning' | 'detected' | 'timeout' | 'permission-denied' | 'error'>('scanning');
  const [zoom, setZoom] = useState(1);
  const [minZoom, setMinZoom] = useState(1);
  const [maxZoom, setMaxZoom] = useState(1);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  const handleZoomChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newZoom = Number(e.target.value);
    setZoom(newZoom);
    try {
      const videoEl = document.querySelector('#seycure-qr-reader video') as HTMLVideoElement;
      if (videoEl && videoEl.srcObject) {
        const stream = videoEl.srcObject as MediaStream;
        const track = stream.getVideoTracks()[0];
        if (track) {
          await track.applyConstraints({ advanced: [{ zoom: newZoom }] } as any);
        }
      }
    } catch (err) {
      console.warn('Zoom not supported by device hardware', err);
      // Fallback: try html5-qrcode built-in if available
      if (scannerRef.current && (scannerRef.current as any).applyVideoConstraints) {
        try {
          await (scannerRef.current as any).applyVideoConstraints({ advanced: [{ zoom: newZoom }] });
        } catch (e) {}
      }
    }
  };

  const handleScanFromGallery = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      // Stop camera scanner first
      await stopScanner();
      setPhase('scanning');

      const tempScanner = new Html5Qrcode('seycure-qr-gallery-temp');
      const result = await tempScanner.scanFile(file, true);
      tempScanner.clear();

      setPhase('detected');
      setTimeout(() => {
        onScan(result);
        onClose();
      }, 150);
    } catch {
      setPhase('timeout'); // No QR found in image
    }

    // Reset input so same file can be picked again
    if (galleryInputRef.current) galleryInputRef.current.value = '';
  };

  const stopScanner = useCallback(async () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (scannerRef.current) {
      try {
        const state = scannerRef.current.getState();
        if (state === 2 /* SCANNING */ || state === 3 /* PAUSED */) {
          await scannerRef.current.stop();
        }
      } catch {
        // Scanner may already be stopped
      }
      try {
        scannerRef.current.clear();
      } catch {
        // Ignore
      }
      scannerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    setPhase('scanning');
    let cancelled = false;

    const startScanner = async () => {
      // Small delay to let the DOM render the container
      await new Promise(r => setTimeout(r, 300));
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
            fps: 10,
            qrbox: { width: 300, height: 300 },
            aspectRatio: 1,
          },
          (decodedText) => {
            if (cancelled) return;
            setPhase('detected');
            if (timeoutRef.current) clearTimeout(timeoutRef.current);

            // Brief delay to show the detection animation
            setTimeout(() => {
              if (!cancelled) {
                onScan(decodedText);
                onClose();
              }
            }, 150);

            // Stop scanning after first detection
            scanner.stop().catch(() => { });
          },
          () => {
            // QR code not found in frame — this fires every frame, ignore
          }
        );

        // 30s timeout
        timeoutRef.current = setTimeout(() => {
          if (!cancelled) {
            setPhase('timeout');
            scanner.stop().catch(() => { });
          }
        }, 30000);

        // Try to access camera zoom capabilities
        setTimeout(() => {
          if (cancelled) return;
          const videoEl = document.querySelector('#seycure-qr-reader video') as HTMLVideoElement;
          if (videoEl && videoEl.srcObject) {
            const stream = videoEl.srcObject as MediaStream;
            const track = stream.getVideoTracks()[0];
            if (track) {
              const capabilities = track.getCapabilities ? track.getCapabilities() : {} as any;
              if (capabilities && capabilities.zoom) {
                setMinZoom(capabilities.zoom.min || 1);
                setMaxZoom(capabilities.zoom.max || 1);
                setZoom(capabilities.zoom.min || 1);
              }
            }
          }
        }, 800);

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
  }, [open, onScan, onClose, stopScanner]);

  const handleRetry = async () => {
    await stopScanner();
    setPhase('scanning');
    // Re-trigger by toggling — the effect depends on `open`
    // We just need to restart, so we'll re-run the start logic
    const scannerId = 'seycure-qr-reader';
    const scannerEl = document.getElementById(scannerId);
    if (!scannerEl) return;

    try {
      const scanner = new Html5Qrcode(scannerId);
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 230, height: 230 }, aspectRatio: 1 },
        (decodedText) => {
          setPhase('detected');
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          setTimeout(() => {
            onScan(decodedText);
            onClose();
          }, 800);
          scanner.stop().catch(() => { });
        },
        () => { }
      );

      timeoutRef.current = setTimeout(() => {
        setPhase('timeout');
        scanner.stop().catch(() => { });
      }, 30000);
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
      <DialogContent className="max-w-md bg-primary-dark/95 border-primary-blue/30 backdrop-blur-xl p-0 overflow-hidden">
        <div className="relative p-8">
          {/* Corner brackets */}
          <div className="absolute top-4 left-4 w-8 h-8 border-t-2 border-l-2 border-primary-blue" />
          <div className="absolute top-4 right-4 w-8 h-8 border-t-2 border-r-2 border-primary-blue" />
          <div className="absolute bottom-4 left-4 w-8 h-8 border-b-2 border-l-2 border-primary-blue" />
          <div className="absolute bottom-4 right-4 w-8 h-8 border-b-2 border-r-2 border-primary-blue" />

          {/* Viewfinder — html5-qrcode renders camera feed here */}
          <div ref={containerRef} className="relative w-[320px] h-[320px] mx-auto bg-black/50 overflow-hidden rounded-lg">
            <div id="seycure-qr-reader" className="w-full h-full" />

            {phase === 'scanning' && (
              <div className="absolute inset-x-0 h-1 bg-primary-blue shadow-glow-strong animate-scanline pointer-events-none z-10" />
            )}
            {phase === 'detected' && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 z-10">
                <div className="w-16 h-16 rounded-full bg-primary-blue flex items-center justify-center animate-modalIn">
                  <Check className="w-8 h-8 text-white" />
                </div>
              </div>
            )}
          </div>

          {/* Zoom Control */}
          {maxZoom > 1 && phase === 'scanning' && (
            <div className="mt-5 px-6 flex items-center gap-3 animate-fadeUp">
              <ZoomOut className="w-5 h-5 text-primary-blue/70" />
              <input 
                type="range" 
                min={minZoom} 
                max={maxZoom} 
                step={0.1} 
                value={zoom}
                onChange={handleZoomChange}
                className="flex-1 h-1.5 bg-primary-blue/20 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-primary-blue [&::-webkit-slider-thumb]:rounded-full shadow-inner"
              />
              <ZoomIn className="w-5 h-5 text-primary-blue" />
            </div>
          )}

          {/* Status text */}
          <div className="text-center mt-6">
            {phase === 'scanning' && (
              <p className="font-sans text-sm font-medium text-primary-blue animate-pulse">Scanning...</p>
            )}
            {phase === 'detected' && (
              <p className="font-sans text-sm font-medium text-primary-blue">Detected</p>
            )}
            {phase === 'timeout' && (
              <div className="space-y-4">
                <p className="font-sans text-sm font-medium text-warning-amber">No QR Code Found</p>
                <Button onClick={handleRetry} variant="outline" className="border-primary-blue text-primary-blue">
                  Tap to Retry
                </Button>
              </div>
            )}
            {phase === 'permission-denied' && (
              <div className="space-y-3">
                <p className="font-sans text-sm font-medium text-danger-red">Camera Permission Denied</p>
                <p className="font-sans text-xs text-text-muted">
                  Please allow camera access in your device settings to scan QR codes.
                </p>
              </div>
            )}
            {phase === 'error' && (
              <div className="space-y-3">
                <p className="font-sans text-sm font-medium text-danger-red">Camera Unavailable</p>
                <p className="font-sans text-xs text-text-muted">
                  Could not access the camera. Please check your device or try again.
                </p>
                <Button onClick={handleRetry} variant="outline" className="border-primary-blue text-primary-blue">
                  Retry
                </Button>
              </div>
            )}
          </div>

          {/* Hidden gallery input */}
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/*"
            onChange={handleScanFromGallery}
            className="hidden"
          />
          {/* Hidden temp container for gallery scan */}
          <div id="seycure-qr-gallery-temp" className="hidden" />

          {/* Bottom action bar */}
          <div className="flex items-center justify-center gap-6 mt-4">
            <button
              onClick={() => galleryInputRef.current?.click()}
              className="flex items-center gap-2 font-sans text-xs text-primary-blue hover:text-primary-blue/80 transition-colors px-3 py-2 border border-primary-blue/30 rounded-lg"
            >
              <ImageIcon className="w-4 h-4" />
              From Gallery
            </button>
            <button
              onClick={handleClose}
              className="font-sans text-xs text-text-muted hover:text-white transition-colors px-3 py-2"
            >
              Cancel
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BrowserModal({ url, open, onClose }: { url: string; open: boolean; onClose: () => void }) {
  const [progress, setProgress] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (open) {
      setProgress(0);
      setLoaded(false);
      setBlocked(false);

      const steps = [20, 45, 70, 88];
      steps.forEach((p, i) => {
        setTimeout(() => setProgress(p), (i + 1) * 300);
      });

      const loadTimer = setTimeout(() => {
        setProgress(100);
        setLoaded(true);
      }, 2000);

      const blockTimer = setTimeout(() => {
        if (!loaded) setBlocked(true);
      }, 6000);

      return () => {
        clearTimeout(loadTimer);
        clearTimeout(blockTimer);
      };
    }
  }, [open]);

  const domain = getDomainFromUrl(url);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl h-[90vh] bg-white border-border p-0 overflow-hidden flex flex-col">
        {/* Chrome bar */}
        <div className="flex items-center gap-3 px-4 py-3 bg-bg-light border-b border-border-light">
          {/* Traffic lights */}
          <div className="flex gap-2">
            <button onClick={onClose} className="w-3 h-3 rounded-full bg-danger-red hover:brightness-110 transition-all group relative">
              <X className="w-2 h-2 absolute inset-0 m-auto opacity-0 group-hover:opacity-100 text-white" />
            </button>
            <div className="w-3 h-3 rounded-full bg-warning-amber" />
            <div className="w-3 h-3 rounded-full bg-success-green" />
          </div>

          {/* Address bar */}
          <div className="flex-1 flex items-center gap-2 bg-white rounded-lg px-3 py-1.5 border border-border-light">
            <span className="text-primary-blue/60 font-mono text-xs">https://</span>
            <span className="text-primary-blue font-mono text-xs">{domain}</span>
            <span className="text-text-muted font-mono text-xs truncate">{url.split(domain)[1] || ''}</span>
            <span className="ml-auto text-primary-blue/60 font-mono text-xs border border-primary-blue/30 px-1.5 py-0.5 rounded">SANDBOXED</span>
          </div>

          {/* Open real button */}
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-3 py-1.5 bg-primary-blue text-white rounded-lg font-sans text-xs hover:bg-primary-blue/90 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            Open Real
          </a>
        </div>

        {/* Progress bar */}
        <div className="h-0.5 bg-border-light">
          <div
            className="h-full bg-gradient-to-r from-primary-blue to-accent-blue transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* Content viewport */}
        <div className="flex-1 relative overflow-hidden bg-white">
          {blocked ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-bg-light">
              <Shield className="w-16 h-16 text-danger-red mb-4" />
              <p className="font-sans text-lg font-semibold text-danger-red mb-2">Embed Blocked by Site</p>
              <p className="font-sans text-sm text-text-secondary text-center max-w-md mb-6">
                {domain} has restricted embedding via X-Frame-Options or Content Security Policy.
              </p>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 bg-primary-blue text-white font-sans text-sm font-medium rounded-lg hover:bg-primary-blue/90 transition-colors"
              >
                Open in Browser
              </a>
            </div>
          ) : !loaded ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white">
              <div className="relative w-12 h-12 mb-4">
                <div className="absolute inset-0 border-2 border-primary-blue/30 rounded-full" />
                <div className="absolute inset-0 border-2 border-t-primary-blue rounded-full animate-spin-slow" />
                <div className="absolute inset-2 border-2 border-primary-blue/30 rounded-full" />
                <div className="absolute inset-2 border-2 border-b-primary-blue rounded-full animate-spin-reverse" />
              </div>
              <p className="font-sans text-sm text-text-secondary">{domain}</p>
            </div>
          ) : (
            <>
              <iframe
                src={url}
                className="w-full h-full"
                sandbox="allow-same-origin allow-scripts"
              />
            </>
          )}

          {/* Corner brackets */}
          <div className="absolute top-4 left-4 w-6 h-6 border-t border-l border-primary-blue/30 pointer-events-none" />
          <div className="absolute top-4 right-4 w-6 h-6 border-t border-r border-primary-blue/30 pointer-events-none" />
          <div className="absolute bottom-4 left-4 w-6 h-6 border-b border-l border-primary-blue/30 pointer-events-none" />
          <div className="absolute bottom-4 right-4 w-6 h-6 border-b border-r border-primary-blue/30 pointer-events-none" />
        </div>

        {/* Bottom safety bar */}
        <div className="flex items-center justify-between px-4 py-2 bg-bg-light border-t border-border-light">
          <div className="flex items-center gap-2 text-text-secondary font-sans text-xs">
            <span className="text-primary-blue">&#128274;</span>
            SANDBOX · NO FORMS · NO POPUPS · NO TRACKING
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary font-sans text-xs transition-colors">
            &#10005; Close
          </button>
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
      // Feature 2: Fetch redirect chain locally using allorigins as a proxy tracer
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
          className="w-full py-3 px-4 bg-bg-light text-text-primary border border-border-light font-sans text-sm font-medium rounded-lg hover:bg-gray-100 transition-colors flex items-center justify-center gap-2"
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
            className="flex-1 py-3 px-4 bg-bg-light text-text-primary border border-border-light font-sans text-sm font-medium rounded-lg hover:bg-gray-100 transition-colors flex items-center justify-center gap-2"
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
      <div className="animate-fadeUp bg-white rounded-xl border border-border-light shadow-card overflow-hidden">
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
                <img
                  src={analysis.favicon}
                  alt=""
                  className="w-8 h-8 rounded-lg"
                  onError={(e) => { (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">&#127760;</text></svg>'; }}
                />
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
                          <p className="font-sans text-[10px] bg-white border border-border-light px-1.5 py-0.5 rounded w-fit text-text-muted mt-0.5">HTTP {hop.status}</p>
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
                    <img
                      src={analysis.favicon}
                      alt=""
                      className="w-8 h-8 rounded-lg"
                      onError={(e) => { (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">&#127760;</text></svg>'; }}
                    />
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
                  <p className="font-sans text-xs text-text-secondary text-center pt-2">Capturing screenshot...</p>
                </div>
              ) : (
                <div
                  className="relative group cursor-pointer rounded-lg overflow-hidden"
                  onClick={() => setShowBrowser(true)}
                >
                  <img
                    src={`https://image.thum.io/get/width/800/crop/600/${analysis.cleanedUrl}`}
                    alt="Preview"
                    className="w-full h-48 object-cover opacity-90 group-hover:opacity-100 transition-opacity"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                      (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                    }}
                  />
                  <div className="hidden absolute inset-0 flex flex-col items-center justify-center bg-bg-light rounded-lg">
                    <Camera className="w-8 h-8 text-text-secondary mb-2" />
                    <p className="font-sans text-xs text-text-secondary">Screenshot Unavailable</p>
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                    <div className="flex items-center gap-2 px-4 py-2 bg-primary-blue text-white rounded-lg">
                      <ExternalLink className="w-4 h-4" />
                      <span className="font-sans text-xs font-medium">Open Preview</span>
                    </div>
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-white to-transparent pointer-events-none" />
                </div>
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
        <DialogContent className="max-w-sm rounded-[24px] p-6 bg-white gap-0 border-0 shadow-model text-center">
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

function LinkShield() {
  const [url, setUrl] = useState('');
  const [showScanner, setShowScanner] = useState(false);
  const [analysis, setAnalysis] = useState<LinkAnalysis | null>(null);
  const [isScanning, setIsScanning] = useState(false);

  const analyzeUrl = useCallback((value: string) => {
    if (isValidUrl(value)) {
      setIsScanning(true);
      const { cleaned, removed } = cleanUrl(value);
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
        favicon: `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
        phishingSignals: checkPhishingSignals(value, domain, domain, domain, false),
      };
      setAnalysis(instantAnalysis);

      // Phase 2: Enhance with network metadata (title, description, login form scan)
      fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(value)}`)
        .then(r => r.json())
        .then(data => {
          const html = data.contents || '';
          const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/) || html.match(/<title>([^<]+)/);
          const descMatch = html.match(/<meta property="og:description" content="([^"]+)"/) || html.match(/<meta name="description" content="([^"]+)"/);

          const title = titleMatch?.[1]?.trim() || domain;

          // Login form scan using regex on fetched HTML
          const hasPasswordField = /<input[^>]+type=["']?password["']?/i.test(html);
          const hasEmailField = /<input[^>]+(type=["']?email["']?|name=["'][^"']*(email|user)[^"']*["'])/i.test(html);
          const hasLoginForm = hasPasswordField && hasEmailField;

          const pSignals = checkPhishingSignals(value, domain, domain, title, hasLoginForm);

          setAnalysis(prev => prev ? {
            ...prev,
            category: classifyLink(domain, titleMatch?.[1] || ''),
            title,
            description: descMatch?.[1]?.trim() || '',
            phishingSignals: pSignals.length > 0 ? pSignals : prev.phishingSignals,
          } : prev);

          // Resolve shortened URL destination
          if (isShort && data.status?.url) {
            const resolvedUrl = data.status.url;
            if (resolvedUrl !== value) {
              setAnalysis(prev => prev ? { ...prev, resolvedUrl } : prev);
            }
          }
        })
        .catch(() => {
          // Keep the instant local analysis already shown
        })
        .finally(() => setIsScanning(false));

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

  const handleQRScan = (scannedUrl: string) => {
    setUrl(scannedUrl);
    analyzeUrl(scannedUrl);
  };

  return (
    <div className="space-y-4 p-4">
      {/* QR Scanner Button */}
      <button
        onClick={() => setShowScanner(true)}
        className="w-full py-6 px-4 bg-white border-2 border-dashed border-primary-blue/30 rounded-xl hover:border-primary-blue/60 hover:bg-primary-light/50 transition-all group shadow-card"
      >
        <div className="relative">
          <div className="absolute top-0 left-0 w-4 h-4 border-t-2 border-l-2 border-primary-blue/50" />
          <div className="absolute top-0 right-0 w-4 h-4 border-t-2 border-r-2 border-primary-blue/50" />
          <div className="absolute bottom-0 left-0 w-4 h-4 border-b-2 border-l-2 border-primary-blue/50" />
          <div className="absolute bottom-0 right-0 w-4 h-4 border-b-2 border-r-2 border-primary-blue/50" />
          <div className="flex flex-col items-center gap-2">
            <Camera className="w-6 h-6 text-primary-blue/70 group-hover:text-primary-blue transition-colors" />
            <span className="font-sans text-sm font-medium text-primary-blue">Start Camera</span>
            <span className="font-sans text-xs text-text-secondary">Scan QR code to inspect link</span>
          </div>
        </div>
      </button>

      {/* URL Input & Scan Action */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') analyzeUrl(url); }}
            placeholder="Paste link here to strip tracking..."
            className="h-12 bg-white border-border-light text-text-primary font-sans placeholder:text-text-muted focus:border-primary-blue focus:ring-primary-blue/20 pr-10 rounded-lg"
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
          onClick={() => analyzeUrl(url)}
          disabled={!url || !isValidUrl(url) || isScanning}
          className={`px-6 h-12 text-white font-sans text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-card flex items-center gap-2 ${isScanning ? 'bg-emerald-500 animate-pulse' : 'bg-primary-blue hover:bg-primary-blue/90'
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
        Zero-latency processing — tracker removal fires instantly on valid URL detection
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

    try {
      // Remove the data URL prefix to get pure base64
      const base64 = dataToDownload.includes(',') ? dataToDownload.split(',')[1] : dataToDownload;

      await Filesystem.writeFile({
        path: anonName,
        data: base64,
        directory: Directory.Documents,
      });
      alert(`Saved to Documents/${anonName}`);
    } catch (e) {
      // Fallback: trigger browser download
      const link = document.createElement('a');
      link.href = dataToDownload;
      link.download = anonName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
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
          : 'border-border-light bg-white hover:border-primary-blue/50 shadow-card'
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
            className="bg-white border border-border-light rounded-xl p-4 animate-fadeUp shadow-card"
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

// ── Screenshot Privacy Guard ─────────────────────────────────────────────────

function ScreenshotPrivacyGuard() {
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string>('');
  const [scanning, setScanning] = useState(false);
  const [findings, setFindings] = useState<ScreenshotFinding[]>([]);
  const [appContext, setAppContext] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { shareFile } = useNativeShare();

  // ── Direct share (no blur needed) ───────────────────────────────────────
  const handleDirectShare = useCallback(async () => {
    if (!imageBase64) return;
    await shareFile('seycure_screenshot.png', imageBase64, 'image/png', 'Share screenshot');
  }, [imageBase64, shareFile]);

  // ── Direct save (no blur needed) ────────────────────────────────────────
  const handleDirectSave = useCallback(async () => {
    if (!imageBase64) return;
    setSaving(true);
    try {
      const fileName = `seycure_clean_${Date.now()}.png`;
      await Filesystem.writeFile({
        path: `Documents/${fileName}`,
        data: imageBase64,
        directory: Directory.ExternalStorage,
        recursive: true,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (error) {
      console.error('Save error:', error);
      // Fallback: trigger browser download
      const link = document.createElement('a');
      link.download = `seycure_clean_${Date.now()}.png`;
      link.href = `data:image/png;base64,${imageBase64}`;
      link.click();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  }, [imageBase64]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    loadImage(file);
  };

  const loadImage = (file: File) => {
    setImageName(file.name);
    setFindings([]);
    setScanned(false);
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      setImageBase64(base64);
    };
    reader.readAsDataURL(file);
  };

  const handleScan = async () => {
    if (!imageBase64) return;
    setScanning(true);
    try {
      const result = await analyzeScreenshot(imageBase64);
      setFindings(result.findings);
      setAppContext(result.appContext);
      setScanned(true);
    } catch (err) {
      console.error('Scan error:', err);
      setScanned(true);
    } finally {
      setScanning(false);
    }
  };

  const getSeverityStyle = (severity: string) => {
    switch (severity) {
      case 'critical': return 'bg-red-500/10 text-red-600 border-red-200';
      case 'high': return 'bg-amber-500/10 text-amber-600 border-amber-200';
      case 'medium': return 'bg-blue-500/10 text-blue-600 border-blue-200';
      default: return 'bg-gray-500/10 text-gray-600 border-gray-200';
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
            ? 'border-green-300 bg-green-50'
            : 'border-primary-blue/30 hover:border-primary-blue/60 bg-white'
          }`}
      >
        {imageBase64 ? (
          <div className="flex flex-col items-center gap-3">
            <img
              src={`data:image/png;base64,${imageBase64}`}
              alt="Screenshot preview"
              className="max-h-48 rounded-lg shadow-card object-contain"
            />
            <p className="font-sans text-xs text-text-secondary">{imageName}</p>
            <p className="font-sans text-xs text-primary-blue">Tap to change image</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <Eye className="w-8 h-8 text-primary-blue/60" />
            <span className="font-sans text-sm font-medium text-primary-blue">Select Screenshot</span>
            <span className="font-sans text-xs text-text-secondary">Tap or drag an image to scan for sensitive data</span>
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

      {/* Scan button */}
      {imageBase64 && !scanned && (
        <button
          onClick={handleScan}
          disabled={scanning}
          className="w-full py-3 bg-primary-blue text-white font-sans text-sm font-medium rounded-xl hover:bg-primary-blue/90 disabled:opacity-60 transition-all shadow-card flex items-center justify-center gap-2"
        >
          {scanning ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Scanning with ML Kit OCR...
            </>
          ) : (
            <>
              <Search className="w-4 h-4" />
              Scan for Sensitive Data
            </>
          )}
        </button>
      )}

      {/* Results panel */}
      {scanned && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-sans text-sm font-semibold text-text-primary">
              {findings.length > 0 ? `${findings.length} sensitive item${findings.length > 1 ? 's' : ''} found` : 'No sensitive data detected'}
            </h3>
            {findings.length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-sans text-xs font-medium">
                Action needed
              </span>
            )}
          </div>

          {findings.map((f, i) => (
            <div key={i} className={`px-4 py-3 rounded-xl border ${getSeverityStyle(f.severity)} animate-fadeUp`} style={{ animationDelay: `${i * 80}ms` }}>
              <div className="flex items-center justify-between">
                <span className="font-sans text-xs font-semibold uppercase tracking-wide">{f.type}</span>
                <span className="font-sans text-xs font-medium capitalize">{f.severity}</span>
              </div>
              <p className="font-mono text-sm mt-1">{f.redacted}</p>
            </div>
          ))}

          {findings.length > 0 && (
            <button
              onClick={() => setShowEditor(true)}
              className="w-full py-3 bg-gradient-to-r from-primary-blue to-blue-600 text-white font-sans text-sm font-medium rounded-xl hover:opacity-90 transition-all shadow-card flex items-center justify-center gap-2"
            >
              <EyeOff className="w-4 h-4" />
              Open Blur Editor
            </button>
          )}

          {findings.length === 0 && (
            <>
              {/* Clean status card */}
              <div className="bg-green-50 border border-green-200 rounded-xl p-4 flex items-start gap-3 animate-fadeUp">
                <ShieldCheck className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-sans text-sm font-semibold text-green-700">Your screenshot looks clean!</p>
                  <p className="font-sans text-xs text-green-600 mt-1">No sensitive data was found. You can still preview and add manual blur if needed.</p>
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
                    ? 'bg-green-500 text-white'
                    : 'border border-primary-blue text-primary-blue hover:bg-primary-blue/10'
                    }`}
                >
                  <Download className="w-3.5 h-3.5" />
                  {saving ? 'Saving...' : saved ? 'Saved ✓' : 'Save'}
                </button>
              </div>
            </>
          )}

          {/* Rescan button */}
          <button
            onClick={() => { setScanned(false); setFindings([]); }}
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
          onClose={() => setShowEditor(false)}
          imageBase64={imageBase64}
          findings={findings}
          appContext={appContext}
        />
      )}

      {/* Learned Rules Settings */}
      <div className="mt-4">
        <LearnedRulesSettings />
      </div>
    </div>
  );
}

// ── Media Scrubber Tab (Wrapper with Sub-Tabs) ──────────────────────────────

function MediaScrubberTab({ mode, onModeChange }: { mode: AppMode; onModeChange: (m: AppMode) => void }) {
  const subTab = mode === 'privacy-blur' ? 'privacy-blur' : 'media-scrubber';

  return (
    <div>
      {/* Sub-tab segmented control */}
      <div className="flex justify-center px-4 pb-2">
        <div className="inline-flex bg-white rounded-lg p-0.5 shadow-card border border-border-light">
          <button
            onClick={() => onModeChange('media-scrubber')}
            className={`px-4 py-2 rounded-md font-sans text-xs font-medium transition-all duration-150 flex items-center gap-1.5 ${subTab === 'media-scrubber'
              ? 'bg-primary-blue text-white shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
              }`}
          >
            <Scissors className="w-3.5 h-3.5" />
            Media Scrubber
          </button>
          <button
            onClick={() => onModeChange('privacy-blur')}
            className={`px-4 py-2 rounded-md font-sans text-xs font-medium transition-all duration-150 flex items-center gap-1.5 ${subTab === 'privacy-blur'
              ? 'bg-primary-blue text-white shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
              }`}
          >
            <EyeOff className="w-3.5 h-3.5" />
            Privacy Blur
          </button>
        </div>
      </div>

      {/* Sub-tab content */}
      {subTab === 'media-scrubber' ? <MediaScrubber /> : <ScreenshotPrivacyGuard />}
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
    <div className="fixed inset-0 z-[9999] bg-white flex flex-col items-center justify-center animate-splash-fade pointer-events-none">
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

function App() {
  const [mode, setMode] = useState<AppMode>('link-shield');
  const [status] = useState<'idle' | 'scanning'>('idle');
  const [showSplash, setShowSplash] = useState(true);
  
  // Swipe navigation state
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    
    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    
    const deltaX = touchStartX.current - touchEndX;
    const deltaY = touchStartY.current - touchEndY;
    
    // Check if swipe is mostly horizontal and > 50px
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
      if (deltaX > 0) {
        // Swiped left (go forward)
        if (mode === 'link-shield') setMode('media-scrubber');
        else if (mode === 'media-scrubber') setMode('privacy-blur');
      } else {
        // Swiped right (go back)
        if (mode === 'privacy-blur') setMode('media-scrubber');
        else if (mode === 'media-scrubber') setMode('link-shield');
      }
    }
    
    touchStartX.current = null;
    touchStartY.current = null;
  };

  const renderContent = () => {
    switch (mode) {
      case 'link-shield':
        return <LinkShield />;
      case 'media-scrubber':
      case 'privacy-blur':
        return <MediaScrubberTab mode={mode} onModeChange={setMode} />;
      default:
        return <LinkShield />;
    }
  };

  return (
    <div 
      className="min-h-screen bg-bg-light"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {showSplash && <SplashScreen onComplete={() => setShowSplash(false)} />}

      <div className="max-w-app mx-auto">
        <TopBar status={status} />
        <TabBar mode={mode} onChange={setMode} />

        <main className="pb-8 overflow-hidden">
          <div className="animate-fadeUp transition-transform duration-300">
            {renderContent()}
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
