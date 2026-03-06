import { useEffect, useRef, useState, useCallback } from 'react';
import { X, Undo2, RotateCcw, Plus, Minus, Download, Share2 } from 'lucide-react';
import { useBlurEditor, renderToCanvas } from '@/hooks/useBlurEditor';
import { useNativeShare } from '@/hooks/useNativeShare';
import { Filesystem, Directory } from '@capacitor/filesystem';
import type { ScreenshotFinding } from '@/hooks/useMLKitOCR';
import {
    saveCorrection,
    saveAppLayout,
    textToPattern,
    type AppLayoutRow,
} from '@/hooks/usePrivacyLearning';

interface BlurEditorModalProps {
    open: boolean;
    onClose: () => void;
    imageBase64: string;
    findings: ScreenshotFinding[];
    appContext?: string | null;
}

export function BlurEditorModal({ open, onClose, imageBase64, findings, appContext }: BlurEditorModalProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imageRef = useRef<HTMLImageElement | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [imageLoaded, setImageLoaded] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);
    const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

    const { shareFile } = useNativeShare();

    const {
        regions,
        mode,
        setMode,
        autoCount,
        manualCount,
        initFromFindings,
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
    useEffect(() => {
        if (!open || !imageBase64) return;

        const img = new Image();
        img.onload = () => {
            imageRef.current = img;
            setImageLoaded(true);
            initFromFindings(findings);
        };
        img.src = `data:image/png;base64,${imageBase64}`;

        return () => {
            setImageLoaded(false);
            setSaved(false);
        };
    }, [open, imageBase64, findings, initFromFindings]);

    // ── Re-render canvas when regions change ───────────────────────────────
    useEffect(() => {
        if (!imageLoaded || !canvasRef.current || !imageRef.current) return;
        renderToCanvas(canvasRef.current, imageRef.current, regions);
    }, [imageLoaded, regions]);

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

            await Filesystem.writeFile({
                path: `Documents/${fileName}`,
                data: base64,
                directory: Directory.ExternalStorage,
                recursive: true,
            });

            // Persist learning on successful save
            await persistLearning();

            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (error) {
            console.error('Save error:', error);
            // Fallback: trigger download in browser
            if (canvasRef.current) {
                const link = document.createElement('a');
                link.download = `seycure_blurred_${Date.now()}.png`;
                link.href = canvasRef.current.toDataURL('image/png');
                link.click();
                await persistLearning();
                setSaved(true);
                setTimeout(() => setSaved(false), 3000);
            }
        } finally {
            setSaving(false);
        }
    }, [exportBlurred, persistLearning]);

    // ── Share ──────────────────────────────────────────────────────────────
    const handleShare = useCallback(async () => {
        if (!canvasRef.current) return;
        const base64 = exportBlurred(canvasRef.current);
        await shareFile('seycure_blurred.png', base64, 'image/png', 'Share blurred screenshot');
        await persistLearning();
    }, [exportBlurred, shareFile, persistLearning]);

    if (!open) return null;

    // Calculate drag overlay rect for visual feedback
    const dragRect = dragStart && dragCurrent && mode === 'add' ? {
        left: Math.min(dragStart.x, dragCurrent.x),
        top: Math.min(dragStart.y, dragCurrent.y),
        width: Math.abs(dragCurrent.x - dragStart.x),
        height: Math.abs(dragCurrent.y - dragStart.y),
    } : null;

    return (
        <div className="fixed inset-0 z-[100] bg-black/95 flex flex-col animate-modalIn">
            {/* ── Top Toolbar ─────────────────────────────────────────────────── */}
            <div className="flex items-center justify-between px-4 py-3 bg-black/80 border-b border-white/10">
                <div className="flex items-center gap-3">
                    <button
                        onClick={onClose}
                        className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                    >
                        <X className="w-5 h-5 text-white" />
                    </button>
                    <h2 className="font-sans text-sm font-semibold text-white">Blur Editor</h2>
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

            {/* ── Canvas Area ─────────────────────────────────────────────────── */}
            <div
                ref={containerRef}
                className="flex-1 overflow-auto flex items-center justify-center p-4 relative"
                style={{ touchAction: 'none' }}
            >
                {imageLoaded ? (
                    <div className="relative inline-block max-w-full max-h-full">
                        <canvas
                            ref={canvasRef}
                            className="max-w-full max-h-[calc(100vh-180px)] object-contain rounded-lg"
                            style={{ cursor: mode === 'add' ? 'crosshair' : 'pointer' }}
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
                                {/* We don't blur, but we show a little badge to indicate we saw it and deemed it safe */}
                                <div className="absolute -top-5 right-0 bg-black/60 text-[10px] text-green-400 font-mono px-1 rounded whitespace-nowrap">
                                    Safe Ref
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

            {/* ── Bottom Toolbar ───────────────────────────────────────────────── */}
            <div className="flex items-center justify-between px-4 py-3 bg-black/80 border-t border-white/10">
                {/* Mode toggle */}
                <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1">
                    <button
                        onClick={() => setMode('add')}
                        className={`flex items-center gap-1.5 px-3 py-2 rounded-md font-sans text-xs font-medium transition-all ${mode === 'add'
                            ? 'bg-primary-blue text-white shadow-glow'
                            : 'text-white/60 hover:text-white'
                            }`}
                    >
                        <Plus className="w-3.5 h-3.5" />
                        Add Blur
                    </button>
                    <button
                        onClick={() => setMode('remove')}
                        className={`flex items-center gap-1.5 px-3 py-2 rounded-md font-sans text-xs font-medium transition-all ${mode === 'remove'
                            ? 'bg-red-500 text-white'
                            : 'text-white/60 hover:text-white'
                            }`}
                    >
                        <Minus className="w-3.5 h-3.5" />
                        Remove
                    </button>
                </div>

                {/* Save / Share */}
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className={`flex items-center gap-1.5 px-4 py-2 rounded-lg font-sans text-xs font-medium transition-all ${saved
                            ? 'bg-green-500 text-white'
                            : 'bg-white/10 text-white hover:bg-white/20'
                            }`}
                    >
                        <Download className="w-3.5 h-3.5" />
                        {saving ? 'Saving...' : saved ? 'Saved ✓' : 'Save'}
                    </button>
                    <button
                        onClick={handleShare}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary-blue text-white font-sans text-xs font-medium hover:bg-primary-blue/90 transition-colors"
                    >
                        <Share2 className="w-3.5 h-3.5" />
                        Share
                    </button>
                </div>
            </div>

            {/* ── Saved notification ──────────────────────────────────────────── */}
            {saved && (
                <div className="absolute bottom-20 left-1/2 -translate-x-1/2 px-4 py-2 bg-green-500/90 text-white text-sm font-sans font-medium rounded-full animate-fadeUp">
                    ✓ Saved to Documents
                </div>
            )}
        </div>
    );
}
