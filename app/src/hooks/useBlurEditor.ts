import { useState, useRef, useCallback } from 'react';
import type { ScreenshotFinding } from './useMLKitOCR';

// ── Types ───────────────────────────────────────────────────────────────────

export interface BlurRegion {
    id: string;
    /**
     * The detection this region came from, for 'auto' regions only. Toggling a
     * finding has to find its region without touching the manual ones, and the
     * region's own id is generated, so it cannot be used for that.
     */
    findingId?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    source: 'auto' | 'manual';
    action: 'blur' | 'info';
    /** Original text value from OCR (for learning) */
    value?: string;
    /** Original type label from OCR (for learning) */
    typeLabel?: string;
}

export type EditorMode = 'add' | 'remove';

/** How a redacted region is painted over. */
export type RedactionStyle = 'blur' | 'pixelate' | 'black';

export const REDACTION_STYLES: { id: RedactionStyle; label: string }[] = [
    { id: 'blur', label: 'Blur' },
    { id: 'pixelate', label: 'Pixelate' },
    { id: 'black', label: 'Black bar' },
];

export interface BlurEditorState {
    regions: BlurRegion[];
    mode: EditorMode;
    undoStack: BlurRegion[][];
    autoCount: number;
    manualCount: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

let regionIdCounter = 0;
function nextId(): string {
    return `blur-${++regionIdCounter}-${Date.now()}`;
}

export function findingsToBlurRegions(findings: ScreenshotFinding[]): BlurRegion[] {
    return findings
        .filter(f => f.bbox && f.bbox.width > 0 && f.bbox.height > 0)
        .map(f => ({
            id: nextId(),
            findingId: f.id,
            x: f.bbox.x,
            y: f.bbox.y,
            width: f.bbox.width,
            height: f.bbox.height,
            source: 'auto' as const,
            action: f.action || 'blur',
            value: f.value,
            typeLabel: f.type,
        }));
}

// ── Canvas Rendering ────────────────────────────────────────────────────────

interface PixelRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Snap a region to whole pixels inside the canvas, or null if it falls outside. */
function clampRegion(region: BlurRegion, maxWidth: number, maxHeight: number): PixelRect | null {
    const x = Math.max(0, Math.floor(region.x));
    const y = Math.max(0, Math.floor(region.y));
    const width = Math.min(Math.ceil(region.width), maxWidth - x);
    const height = Math.min(Math.ceil(region.height), maxHeight - y);
    if (width <= 0 || height <= 0) return null;
    return { x, y, width, height };
}

function paintBlur(ctx: CanvasRenderingContext2D, image: HTMLImageElement, rect: PixelRect) {
    // Scale the radius with the region so a one-line phone number is as
    // unreadable as a full address block.
    const radius = Math.min(40, Math.max(10, Math.round(Math.min(rect.width, rect.height) * 0.6)));

    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
    ctx.clip();
    ctx.filter = `blur(${radius}px)`;
    ctx.drawImage(image, 0, 0);
}

function paintPixelate(ctx: CanvasRenderingContext2D, image: HTMLImageElement, rect: PixelRect) {
    // Downscale the region so each block is about a quarter of its short side,
    // then blow it back up with smoothing off.
    const blockSize = Math.max(3, Math.round(Math.min(rect.width, rect.height) / 4));
    const smallWidth = Math.max(1, Math.round(rect.width / blockSize));
    const smallHeight = Math.max(1, Math.round(rect.height / blockSize));

    const scratch = document.createElement('canvas');
    scratch.width = smallWidth;
    scratch.height = smallHeight;

    const scratchCtx = scratch.getContext('2d');
    if (!scratchCtx) return;

    scratchCtx.drawImage(
        image,
        rect.x, rect.y, rect.width, rect.height,
        0, 0, smallWidth, smallHeight
    );

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
        scratch,
        0, 0, smallWidth, smallHeight,
        rect.x, rect.y, rect.width, rect.height
    );
}

function paintBlackBar(ctx: CanvasRenderingContext2D, rect: PixelRect) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
}

export function renderToCanvas(
    canvas: HTMLCanvasElement,
    image: HTMLImageElement,
    regions: BlurRegion[],
    style: RedactionStyle = 'blur'
) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    // Draw the full image first
    ctx.filter = 'none';
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, 0, 0);

    // Regions marked 'info' were seen and judged safe, so they stay readable
    for (const region of regions.filter(r => r.action !== 'info')) {
        const rect = clampRegion(region, canvas.width, canvas.height);
        if (!rect) continue;

        ctx.save();
        if (style === 'blur') paintBlur(ctx, image, rect);
        else if (style === 'pixelate') paintPixelate(ctx, image, rect);
        else paintBlackBar(ctx, rect);
        ctx.restore();
    }

    // Reset filter
    ctx.filter = 'none';
    ctx.imageSmoothingEnabled = true;
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useBlurEditor(initialFindings: ScreenshotFinding[] = []) {
    const [regions, setRegions] = useState<BlurRegion[]>(() =>
        findingsToBlurRegions(initialFindings)
    );
    const [mode, setMode] = useState<EditorMode>('add');
    const [style, setStyle] = useState<RedactionStyle>('blur');
    const [undoStack, setUndoStack] = useState<BlurRegion[][]>([]);

    // Track user corrections for learning
    const [removedAutoRegions, setRemovedAutoRegions] = useState<BlurRegion[]>([]);
    const [addedManualRegions, setAddedManualRegions] = useState<BlurRegion[]>([]);

    // Track drag state
    const dragStartRef = useRef<{ x: number; y: number } | null>(null);
    const isDraggingRef = useRef(false);

    // ── Region counts ──────────────────────────────────────────────────────
    const autoCount = regions.filter(r => r.source === 'auto').length;
    const manualCount = regions.filter(r => r.source === 'manual').length;

    // ── Push to undo stack ─────────────────────────────────────────────────
    const pushUndo = useCallback((currentRegions: BlurRegion[]) => {
        setUndoStack(prev => [...prev, [...currentRegions]]);
    }, []);

    // ── Initialize from findings ───────────────────────────────────────────
    const initFromFindings = useCallback((findings: ScreenshotFinding[]) => {
        const newRegions = findingsToBlurRegions(findings);
        setRegions(newRegions);
        setUndoStack([]);
    }, []);

    /**
     * Re-applies each finding's blur/info action to the region it produced,
     * leaving manual regions and the undo stack alone.
     *
     * This exists because the obvious alternative - calling initFromFindings
     * whenever the findings prop changes - rebuilds the whole region list, so
     * toggling one detection would silently discard every box the user had
     * drawn by hand.
     */
    const syncAutoActions = useCallback((findings: ScreenshotFinding[]) => {
        const actionById = new Map(findings.map(f => [f.id, f.action || 'blur']));

        setRegions(prev => {
            let changed = false;
            const next = prev.map(region => {
                if (region.source !== 'auto' || !region.findingId) return region;
                const action = actionById.get(region.findingId);
                if (!action || action === region.action) return region;
                changed = true;
                return { ...region, action };
            });
            return changed ? next : prev;
        });
    }, []);

    // ── Add a manual region ────────────────────────────────────────────────
    const addRegion = useCallback((x: number, y: number, width: number, height: number) => {
        if (width < 5 || height < 5) return; // Too small to be intentional

        const newRegion: BlurRegion = {
            id: nextId(),
            x: Math.min(x, x + width),
            y: Math.min(y, y + height),
            width: Math.abs(width),
            height: Math.abs(height),
            source: 'manual',
            action: 'blur',
        };

        setRegions(prev => {
            pushUndo(prev);
            return [...prev, newRegion];
        });

        // Track for learning
        setAddedManualRegions(p => [...p, newRegion]);
    }, [pushUndo]);

    // ── Remove a region by ID ──────────────────────────────────────────────
    const removeRegion = useCallback((regionId: string) => {
        setRegions(prev => {
            pushUndo(prev);
            const removed = prev.find(r => r.id === regionId);
            // If it was an auto-detected region, track it for learning
            if (removed && removed.source === 'auto') {
                setRemovedAutoRegions(p => [...p, removed]);
            }
            return prev.filter(r => r.id !== regionId);
        });
    }, [pushUndo]);

    // ── Find region at point (for tap-to-remove) ──────────────────────────
    const findRegionAtPoint = useCallback((px: number, py: number): BlurRegion | null => {
        // Search in reverse order (top-most first)
        for (let i = regions.length - 1; i >= 0; i--) {
            const r = regions[i];
            if (px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height) {
                return r;
            }
        }
        return null;
    }, [regions]);

    // ── Pointer event handlers ─────────────────────────────────────────────
    const handlePointerDown = useCallback((
        canvasX: number,
        canvasY: number
    ) => {
        // Always check for tap-to-remove first (regardless of mode)
        const hitRegion = findRegionAtPoint(canvasX, canvasY);

        if (hitRegion) {
            // Tap on existing region → remove it
            removeRegion(hitRegion.id);
            isDraggingRef.current = false;
            dragStartRef.current = null;
            return;
        }

        if (mode === 'add') {
            dragStartRef.current = { x: canvasX, y: canvasY };
            isDraggingRef.current = true;
        }
    }, [mode, findRegionAtPoint, removeRegion]);

    const handlePointerUp = useCallback((
        canvasX: number,
        canvasY: number
    ) => {
        if (isDraggingRef.current && dragStartRef.current && mode === 'add') {
            const start = dragStartRef.current;
            const width = canvasX - start.x;
            const height = canvasY - start.y;
            addRegion(start.x, start.y, width, height);
        }
        isDraggingRef.current = false;
        dragStartRef.current = null;
    }, [mode, addRegion]);

    const getDragRect = useCallback((): { x: number; y: number; width: number; height: number } | null => {
        if (!isDraggingRef.current || !dragStartRef.current) return null;
        return {
            x: dragStartRef.current.x,
            y: dragStartRef.current.y,
            width: 0,
            height: 0,
        };
    }, []);

    // ── Undo ───────────────────────────────────────────────────────────────
    const undo = useCallback(() => {
        setUndoStack(prev => {
            if (prev.length === 0) return prev;
            const newStack = [...prev];
            const lastState = newStack.pop()!;
            setRegions(lastState);
            return newStack;
        });
    }, []);

    // ── Reset to auto-only ─────────────────────────────────────────────────
    const resetToAuto = useCallback(() => {
        pushUndo(regions);
        setRegions(prev => prev.filter(r => r.source === 'auto'));
    }, [regions, pushUndo]);

    // ── Export blurred image as base64 ─────────────────────────────────────
    const exportBlurred = useCallback((canvas: HTMLCanvasElement): string => {
        return canvas.toDataURL('image/png').split(',')[1];
    }, []);

    return {
        regions,
        mode,
        setMode,
        style,
        setStyle,
        autoCount,
        manualCount,
        undoStack,
        initFromFindings,
        syncAutoActions,
        addRegion,
        removeRegion,
        handlePointerDown,
        handlePointerUp,
        getDragRect,
        undo,
        resetToAuto,
        exportBlurred,
        renderToCanvas,
        canUndo: undoStack.length > 0,
        removedAutoRegions,
        addedManualRegions,
    };
}
