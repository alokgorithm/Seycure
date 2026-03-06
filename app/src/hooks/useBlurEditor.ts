import { useState, useRef, useCallback } from 'react';
import type { ScreenshotFinding } from './useMLKitOCR';

// ── Types ───────────────────────────────────────────────────────────────────

export interface BlurRegion {
    id: string;
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

export function renderToCanvas(
    canvas: HTMLCanvasElement,
    image: HTMLImageElement,
    regions: BlurRegion[]
) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    // Draw the full image first
    ctx.drawImage(image, 0, 0);

    // Filter regions that actually need blurring
    const blurRegions = regions.filter(r => r.action !== 'info');

    // Apply blur to each matching region
    for (const region of blurRegions) {
        ctx.save();

        // Create clipping path for the region
        ctx.beginPath();
        ctx.rect(region.x, region.y, region.width, region.height);
        ctx.clip();

        // Apply blur filter and redraw the source pixels within the clip
        ctx.filter = 'blur(18px)';
        ctx.drawImage(image, 0, 0);

        ctx.restore();
    }

    // Reset filter
    ctx.filter = 'none';
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useBlurEditor(initialFindings: ScreenshotFinding[] = []) {
    const [regions, setRegions] = useState<BlurRegion[]>(() =>
        findingsToBlurRegions(initialFindings)
    );
    const [mode, setMode] = useState<EditorMode>('add');
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
        autoCount,
        manualCount,
        undoStack,
        initFromFindings,
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
