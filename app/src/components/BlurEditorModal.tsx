import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, Undo2, RotateCcw, Plus, Minus, Download, Share2, Droplets, Grid3x3, Square, ChevronDown, ShieldCheck, Check } from 'lucide-react';
import { App as CapacitorApp } from '@capacitor/app';
import { useBlurEditor, renderToCanvas, REDACTION_STYLES, type RedactionStyle } from '@/hooks/useBlurEditor';
import { useNativeShare } from '@/hooks/useNativeShare';
import { useAppStats } from '@/hooks/useAppStats';
import { saveImage } from '@/lib/saveImage';
import type { ScreenshotFinding } from '@/hooks/useMLKitOCR';
import {
    saveCorrection,
    saveAppLayout,
    textToPattern,
    type AppLayoutRow,
} from '@/hooks/usePrivacyLearning';

const STYLE_ICONS: Record<RedactionStyle, React.ReactNode> = {
    blur: <Droplets className="w-3.5 h-3.5" />,
    pixelate: <Grid3x3 className="w-3.5 h-3.5" />,
    black: <Square className="w-3.5 h-3.5 fill-current" />,
};

interface BlurEditorModalProps {
    open: boolean;
    onClose: () => void;
    imageBase64: string;
    findings: ScreenshotFinding[];
    appContext?: string | null;
    /** Flip one detection between blurred and left alone. */
    onToggleFinding?: (id: string) => void;
    /** Blur every detection, or none of them. */
    onToggleAll?: () => void;
}

const SEVERITY_DOT: Record<string, string> = {
    critical: 'bg-red-400',
    high: 'bg-amber-400',
    medium: 'bg-sky-400',
};

export function BlurEditorModal({ open, onClose, imageBase64, findings, appContext, onToggleFinding, onToggleAll }: BlurEditorModalProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [imageLoaded, setImageLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);
    const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
    const [listOpen, setListOpen] = useState(false);
    /** Findings are seeded once per opening; after that the panel drives them. */
    const seededRef = useRef(false);

    const blurredCount = findings.filter(f => f.action !== 'info').length;

    const { shareFile } = useNativeShare();
    const { incrementScreenshotsProtected } = useAppStats();

    const {
        regions,
        mode,
        setMode,
        style,
        setStyle,
        autoCount,
        manualCount,
        initFromFindings,
        syncAutoActions,
        handlePointerDown,
        handlePointerUp,
        undo,
        resetToAuto,
        exportBlurred,
        canUndo,
        removedAutoRegions,
        addedManualRegions,
    } = useBlurEditor(findings);

    // ── Load image when modal opens ────────────────────────────────────────
    // Deliberately not keyed on `findings`. It is rebuilt by the parent on every
    // toggle, and re-running this would reload the image and rebuild the region
    // list, throwing away every box the user had drawn by hand.
    useEffect(() => {
        if (!open || !imageBase64) return;

        const img = new Image();
        img.onload = () => {
            imageRef.current = img;
            setImageLoaded(true);
        };
        img.src = `data:image/png;base64,${imageBase64}`;

        return () => {
            setImageLoaded(false);
            setSaved(false);
            setListOpen(false);
            seededRef.current = false;
        };
    }, [open, imageBase64]);

    // Seed the regions once per opening, then let toggles update them in place.
    useEffect(() => {
        if (!open || seededRef.current) return;
        seededRef.current = true;
        initFromFindings(findings);
    }, [open, imageBase64, findings, initFromFindings]);

    useEffect(() => {
        if (!open || !seededRef.current) return;
        syncAutoActions(findings);
    }, [open, findings, syncAutoActions]);

    // ── Android hardware back button ───────────────────────────────────────
    useEffect(() => {
        if (!open) return;
        let listenerHandle: { remove: () => void } | null = null;
        CapacitorApp.addListener('backButton', () => {
            onClose();
        }).then(handle => {
            listenerHandle = handle;
        });
        return () => {
            listenerHandle?.remove();
        };
    }, [open, onClose]);

    // ── Lock body scroll when open ─────────────────────────────────────────
    useEffect(() => {
        if (!open) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, [open]);

    // ── Re-render canvas when regions change ───────────────────────────────
    useEffect(() => {
        if (!imageLoaded || !canvasRef.current || !imageRef.current) return;
        renderToCanvas(canvasRef.current, imageRef.current, regions, style);
    }, [imageLoaded, regions, style]);

    // ── Convert screen coordinates to canvas coordinates ───────────────────
    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        if (!canvasRef.current || !containerRef.current) return { x: 0, y: 0 };
        const rect = canvasRef.current.getBoundingClientRect();
        const scaleX = canvasRef.current.width / rect.width;
        const scaleY = canvasRef.current.height / rect.height;
        return {
            x: (clientX - rect.left) * scaleX,
            y: (clientY - rect.top) * scaleY,
        };
    }, []);

    // ── Pointer handlers ───────────────────────────────────────────────────
    const onPointerDown = useCallback((e: React.PointerEvent) => {
        const pos = screenToCanvas(e.clientX, e.clientY);
        setDragStart(pos);
        setDragCurrent(pos);
        handlePointerDown(pos.x, pos.y);
    }, [screenToCanvas, handlePointerDown]);

    const onPointerMove = useCallback((e: React.PointerEvent) => {
        if (!dragStart) return;
        const pos = screenToCanvas(e.clientX, e.clientY);
        setDragCurrent(pos);
    }, [dragStart, screenToCanvas]);

    const onPointerUp = useCallback((e: React.PointerEvent) => {
        if (dragStart) {
            const pos = screenToCanvas(e.clientX, e.clientY);
            handlePointerUp(pos.x, pos.y);
        }
        setDragStart(null);
        setDragCurrent(null);
    }, [dragStart, screenToCanvas, handlePointerUp]);

    // ── Persist learning data ──────────────────────────────────────────────
    const persistLearning = useCallback(async () => {
        try {
            let savedCount = 0;

            // 1. Save never_blur rules (user removed these auto-detected regions)
            for (const removed of removedAutoRegions) {
                if (removed.value) {
                    await saveCorrection({
                        type: 'never_blur',
                        pattern: textToPattern(removed.value),
                        label: removed.typeLabel || 'Removed pattern',
                        context: '',
                    });
                    savedCount++;
                    console.log(`[Learning] Saved never_blur: "${removed.value}" → ${textToPattern(removed.value)}`);
                }
            }

            // 2. Save always_blur rules (user manually added blur boxes)
            //    Cross-reference manual regions with OCR findings to find text underneath
            for (const manual of addedManualRegions) {
                // Find all OCR findings whose bboxes overlap with this manual region
                const overlapping = findings.filter(f => {
                    if (!f.bbox) return false;
                    // Check if bboxes overlap
                    const overlapX = manual.x < f.bbox.x + f.bbox.width && manual.x + manual.width > f.bbox.x;
                    const overlapY = manual.y < f.bbox.y + f.bbox.height && manual.y + manual.height > f.bbox.y;
                    return overlapX && overlapY;
                });

                if (overlapping.length > 0) {
                    // Learn from each overlapping OCR text item
                    for (const found of overlapping) {
                        await saveCorrection({
                            type: 'always_blur',
                            pattern: textToPattern(found.value),
                            label: found.type || 'Manual blur',
                            context: '',
                        });
                        savedCount++;
                        console.log(`[Learning] Saved always_blur: "${found.value}" → ${textToPattern(found.value)}`);
                    }
                } else {
                    // No OCR text found under the manual box — save a spatial rule
                    // by normalizing the position relative to image height
                    if (imageRef.current) {
                        const imgH = imageRef.current.naturalHeight;
                        const normY = (manual.y / imgH).toFixed(3);
                        const spatialPattern = `__spatial_${normY}__`;
                        await saveCorrection({
                            type: 'always_blur',
                            pattern: spatialPattern,
                            label: `Manual region at ${(parseFloat(normY) * 100).toFixed(0)}% height`,
                            context: '',
                        });
                        savedCount++;
                        console.log(`[Learning] Saved spatial always_blur at Y=${normY}`);
                    }
                }
            }

            // 3. Save app layout spatial memory if we know which app this is
            if (appContext && imageRef.current) {
                const imgHeight = imageRef.current.naturalHeight;
                const layoutRows: AppLayoutRow[] = regions
                    .filter(r => r.source === 'auto')
                    .map(r => ({
                        position: r.y / imgHeight,
                        sensitive: r.action === 'blur',
                        label: r.typeLabel || 'detected',
                        confidence: 0.5,
                        scanCount: 1,
                    }));

                if (layoutRows.length > 0) {
                    await saveAppLayout(appContext, layoutRows);
                    console.log(`[Learning] Saved app layout for "${appContext}" with ${layoutRows.length} rows`);
                }
            }

            if (savedCount > 0) {
                console.log(`[Learning] Total rules saved: ${savedCount}`);
            }
        } catch (err) {
            console.error('Failed to persist learning:', err);
        }
    }, [removedAutoRegions, addedManualRegions, appContext, regions, findings]);

    // ── Save to device ─────────────────────────────────────────────────────
    const handleSave = useCallback(async () => {
        if (!canvasRef.current) return;
        setSaving(true);

        try {
            const base64 = exportBlurred(canvasRef.current);
            const fileName = `seycure_blurred_${Date.now()}.png`;

            const outcome = await saveImage(fileName, base64, 'image/png', 'Save blurred image');
            if (outcome === 'cancelled') return;

            // Persist learning on successful save
            await persistLearning();
            await incrementScreenshotsProtected();

            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (error) {
            console.error('Save error:', error);
        } finally {
            setSaving(false);
        }
    }, [exportBlurred, persistLearning, incrementScreenshotsProtected]);

    // ── Share ──────────────────────────────────────────────────────────────
    const handleShare = useCallback(async () => {
        if (!canvasRef.current) return;
        const base64 = exportBlurred(canvasRef.current);
        await shareFile('seycure_blurred.png', base64, 'image/png', 'Share blurred image');
        await persistLearning();
        await incrementScreenshotsProtected();
    }, [exportBlurred, shareFile, persistLearning, incrementScreenshotsProtected]);

    if (!open) return null;

    // Calculate drag overlay rect for visual feedback
    const dragRect = dragStart && dragCurrent && mode === 'add' ? {
        left: Math.min(dragStart.x, dragCurrent.x),
        top: Math.min(dragStart.y, dragCurrent.y),
        width: Math.abs(dragCurrent.x - dragStart.x),
        height: Math.abs(dragCurrent.y - dragStart.y),
    } : null;

    // ── Render via Portal into document.body ───────────────────────────────
    // This ensures the editor covers the ENTIRE screen, bypassing any
    // parent overflow/transform CSS that breaks fixed positioning.
    return createPortal(
        <div
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                width: '100vw',
                height: '100vh',
                zIndex: 99999,
                display: 'flex',
                flexDirection: 'column',
                background: '#000',
            }}
            role="dialog"
            aria-modal="true"
        >
            {/* ── Top Toolbar ─────────────────────────────────────────────────── */}
            <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 bg-black/80 border-b border-white/10">
                <div className="flex items-center gap-2">
                    <button
                        onClick={onClose}
                        className="flex items-center gap-1 pl-1 pr-3 py-2 rounded-lg hover:bg-white/10 active:bg-white/20 transition-colors"
                        aria-label="Go back"
                    >
                        <ChevronLeft className="w-5 h-5 text-white" />
                        <span className="font-sans text-sm font-medium text-white">Back</span>
                    </button>
                    <h2 className="font-sans text-sm font-semibold text-white/70">
                        {findings.length > 0
                            ? `Found ${findings.length} sensitive item${findings.length > 1 ? 's' : ''}`
                            : 'Blur Editor'}
                    </h2>
                </div>

                <div className="flex items-center gap-2">
                    {/* Auto-blur count badge */}
                    {autoCount > 0 && (
                        <span className="px-2.5 py-1 rounded-full bg-primary-blue/20 text-primary-blue text-xs font-medium">
                            {autoCount} auto
                        </span>
                    )}
                    {/* Manual blur count badge */}
                    {manualCount > 0 && (
                        <span className="px-2.5 py-1 rounded-full bg-purple-500/20 text-purple-400 text-xs font-medium">
                            {manualCount} manual
                        </span>
                    )}

                    {/* Undo button */}
                    <button
                        onClick={undo}
                        disabled={!canUndo}
                        className={`p-2 rounded-lg transition-colors ${canUndo ? 'hover:bg-white/10 text-white' : 'text-white/30 cursor-not-allowed'
                            }`}
                    >
                        <Undo2 className="w-4 h-4" />
                    </button>

                    {/* Reset button */}
                    <button
                        onClick={resetToAuto}
                        className="p-2 rounded-lg hover:bg-white/10 text-white/70 hover:text-white transition-colors"
                        title="Reset to auto-detected only"
                    >
                        <RotateCcw className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Nothing found: say so, rather than leaving a bare canvas that looks
                like the scan silently failed. */}
            {findings.length === 0 && (
                <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/20">
                    <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                    <p className="font-sans text-xs text-emerald-300">
                        No sensitive text found. Drag on the image to blur anything by hand.
                    </p>
                </div>
            )}

            {/* ── Canvas Area ─────────────────────────────────────────────────── */}
            <div
                ref={containerRef}
                className="flex-1 min-h-0 overflow-auto flex items-start justify-center p-2 relative"
                style={{ touchAction: 'none' }}
            >
                {imageLoaded ? (
                    <div className="relative inline-block w-full">
                        <canvas
                            ref={canvasRef}
                            className="w-full h-auto object-contain rounded-lg"
                            style={{ cursor: mode === 'add' ? 'crosshair' : 'pointer', display: 'block' }}
                            onPointerDown={onPointerDown}
                            onPointerMove={onPointerMove}
                            onPointerLeave={onPointerUp}
                        />

                        {/* Render informational overlays (boxes around text that wasn't blurred) */}
                        {regions.filter(r => r.action === 'info').map(r => (
                            <div
                                key={r.id}
                                className="absolute border border-green-500/50 bg-green-500/10 pointer-events-none rounded flex items-start justify-end"
                                style={{
                                    left: `${(r.x / (canvasRef.current?.width || 1)) * 100}%`,
                                    top: `${(r.y / (canvasRef.current?.height || 1)) * 100}%`,
                                    width: `${(r.width / (canvasRef.current?.width || 1)) * 100}%`,
                                    height: `${(r.height / (canvasRef.current?.height || 1)) * 100}%`,
                                }}
                            >
                                {/* Outlined, not redacted: either judged safe or switched off by the user */}
                                <div className="absolute -top-5 right-0 bg-black/60 text-[10px] text-green-400 font-mono px-1 rounded whitespace-nowrap">
                                    Not blurred
                                </div>
                            </div>
                        ))}

                        {/* Drag rectangle overlay */}
                        {dragRect && dragRect.width > 5 && dragRect.height > 5 && (
                            <div
                                className="absolute border-2 border-dashed border-primary-blue bg-primary-blue/10 pointer-events-none rounded"
                                style={{
                                    left: `${(dragRect.left / (canvasRef.current?.width || 1)) * 100}%`,
                                    top: `${(dragRect.top / (canvasRef.current?.height || 1)) * 100}%`,
                                    width: `${(dragRect.width / (canvasRef.current?.width || 1)) * 100}%`,
                                    height: `${(dragRect.height / (canvasRef.current?.height || 1)) * 100}%`,
                                }}
                            />
                        )}
                    </div>
                ) : (
                    <div className="flex flex-col items-center gap-3">
                        <div className="w-10 h-10 border-2 border-t-primary-blue border-white/20 rounded-full animate-spin-slow" />
                        <p className="text-white/60 text-sm font-sans">Loading image...</p>
                    </div>
                )}
            </div>

            {/* ── Detections panel ─────────────────────────────────────────────── */}
            {findings.length > 0 && (
                <div className="flex-shrink-0 bg-black/80 border-t border-white/10">
                    {/* Two sibling controls rather than one nested inside the
                        other: a button inside a button is invalid, and screen
                        readers cannot reach the inner one. */}
                    <div className="flex items-center gap-2 px-4 py-2.5">
                        <button
                            onClick={() => setListOpen(v => !v)}
                            aria-expanded={listOpen}
                            className="flex items-center gap-2 -mx-1 px-1 py-0.5 rounded hover:bg-white/[0.06] transition-colors"
                        >
                            <span className="font-sans text-sm font-semibold text-white">
                                {blurredCount} of {findings.length} blurred
                            </span>
                            <ChevronDown
                                className={`w-4 h-4 text-white/40 transition-transform ${listOpen ? 'rotate-180' : ''}`}
                            />
                        </button>
                        <button
                            onClick={() => onToggleAll?.()}
                            className="ml-auto px-3 py-1 rounded-full bg-white/10 text-white font-sans text-xs font-medium hover:bg-white/20 transition-colors"
                        >
                            {blurredCount === findings.length ? 'Blur none' : 'Blur all'}
                        </button>
                    </div>

                    {listOpen && (
                        <div className="max-h-44 overflow-y-auto px-3 pb-3 space-y-1.5">
                            {findings.map(f => {
                                const on = f.action !== 'info';
                                return (
                                    <button
                                        key={f.id}
                                        onClick={() => onToggleFinding?.(f.id)}
                                        aria-pressed={on}
                                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border text-left transition-colors ${on
                                            ? 'bg-white/[0.06] border-white/15'
                                            : 'bg-transparent border-white/5'
                                            }`}
                                    >
                                        <span
                                            className={`w-5 h-5 shrink-0 rounded-md border flex items-center justify-center transition-colors ${on ? 'bg-primary-blue border-primary-blue' : 'border-white/25'
                                                }`}
                                        >
                                            {on && <Check className="w-3.5 h-3.5 text-white" />}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="flex items-center gap-1.5">
                                                <span className={`w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[f.severity] || 'bg-white/40'}`} />
                                                <span className={`font-sans text-xs font-semibold uppercase tracking-wide ${on ? 'text-white' : 'text-white/40'}`}>
                                                    {f.type}
                                                </span>
                                            </span>
                                            <span className={`block font-mono text-xs mt-0.5 truncate ${on ? 'text-white/60' : 'text-white/30'}`}>
                                                {f.redacted}
                                            </span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* ── Bottom Toolbar ───────────────────────────────────────────────── */}
            <div className="flex-shrink-0 bg-black/80 border-t border-white/10 px-3 py-2 flex flex-col gap-2">
                {/* Row 1: Redaction style */}
                <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1 self-start">
                    {REDACTION_STYLES.map(option => (
                        <button
                            key={option.id}
                            onClick={() => setStyle(option.id)}
                            aria-pressed={style === option.id}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-sans text-xs font-medium transition-all ${style === option.id
                                ? 'bg-white text-black'
                                : 'text-white/60 hover:text-white'
                                }`}
                        >
                            {STYLE_ICONS[option.id]}
                            {option.label}
                        </button>
                    ))}
                </div>

                {/* Row 2: Mode toggle */}
                <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1 self-start">
                    <button
                        onClick={() => setMode('add')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-sans text-xs font-medium transition-all ${mode === 'add'
                            ? 'bg-primary-blue text-white'
                            : 'text-white/60 hover:text-white'
                            }`}
                    >
                        <Plus className="w-3.5 h-3.5" />
                        Add Blur
                    </button>
                    <button
                        onClick={() => setMode('remove')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-sans text-xs font-medium transition-all ${mode === 'remove'
                            ? 'bg-red-500 text-white'
                            : 'text-white/60 hover:text-white'
                            }`}
                    >
                        <Minus className="w-3.5 h-3.5" />
                        Remove
                    </button>
                </div>

                {/* Row 3: Save / Share */}
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className={`flex-[2] flex items-center justify-center gap-1.5 py-2.5 rounded-lg font-sans text-sm font-semibold transition-all ${saved
                            ? 'bg-emerald-500 text-white'
                            : 'bg-primary-blue text-white hover:bg-primary-blue/90 active:scale-[0.99]'
                            }`}
                    >
                        <Download className="w-4 h-4" />
                        {saving ? 'Saving...' : saved ? 'Saved' : 'Save image'}
                    </button>
                    <button
                        onClick={handleShare}
                        className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-white/10 text-white font-sans text-sm font-medium hover:bg-white/20 transition-colors"
                    >
                        <Share2 className="w-4 h-4" />
                        Share
                    </button>
                </div>
            </div>

            {/* ── Saved notification ──────────────────────────────────────────── */}
            {saved && (
                <div className="absolute bottom-24 left-1/2 -translate-x-1/2 px-4 py-2 bg-emerald-500/90 text-white text-sm font-sans font-medium rounded-full animate-fadeUp">
                    Saved
                </div>
            )}
        </div>,
        document.body
    );
}
