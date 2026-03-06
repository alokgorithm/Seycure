import { useState, useEffect, useCallback } from 'react';
import { Trash2, RotateCcw, Brain, Shield, Eye, Smartphone } from 'lucide-react';
import {
    loadCorrections,
    loadAllAppLayouts,
    deleteCorrection,
    deleteAppLayout,
    resetAllLearning,
    type CorrectionRule,
    type AppLayout,
} from '@/hooks/usePrivacyLearning';

export function LearnedRulesSettings() {
    const [corrections, setCorrections] = useState<CorrectionRule[]>([]);
    const [appLayouts, setAppLayouts] = useState<AppLayout[]>([]);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        setLoading(true);
        const [corr, layouts] = await Promise.all([
            loadCorrections(),
            loadAllAppLayouts(),
        ]);
        setCorrections(corr);
        setAppLayouts(layouts);
        setLoading(false);
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const handleDeleteRule = async (id: string) => {
        await deleteCorrection(id);
        await refresh();
    };

    const handleResetApp = async (appName: string) => {
        await deleteAppLayout(appName);
        await refresh();
    };

    const handleResetAll = async () => {
        if (!confirm('This will erase all learned privacy rules. Continue?')) return;
        await resetAllLearning();
        await refresh();
    };

    const alwaysBlur = corrections.filter(c => c.type === 'always_blur');
    const neverBlur = corrections.filter(c => c.type === 'never_blur');
    const hasAny = corrections.length > 0 || appLayouts.length > 0;

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="w-6 h-6 border-2 border-t-primary-blue border-white/20 rounded-full animate-spin-slow" />
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center gap-2 mb-2">
                <Brain className="w-5 h-5 text-purple-400" />
                <h3 className="font-sans text-sm font-semibold text-text-primary">
                    Learned Privacy Rules
                </h3>
            </div>

            {!hasAny ? (
                <div className="bg-card-bg border border-border-subtle rounded-xl p-6 text-center">
                    <Brain className="w-8 h-8 text-text-secondary mx-auto mb-2 opacity-50" />
                    <p className="font-sans text-sm text-text-secondary">
                        No learned rules yet
                    </p>
                    <p className="font-sans text-xs text-text-secondary mt-1">
                        Scan and edit screenshots to teach Seycure your preferences
                    </p>
                </div>
            ) : (
                <>
                    {/* Always Blur Section */}
                    {alwaysBlur.length > 0 && (
                        <div className="bg-card-bg border border-border-subtle rounded-xl overflow-hidden">
                            <div className="px-4 py-2.5 border-b border-border-subtle flex items-center gap-2">
                                <Shield className="w-4 h-4 text-red-400" />
                                <span className="font-sans text-xs font-semibold text-text-primary uppercase tracking-wider">
                                    Always Blur ({alwaysBlur.length})
                                </span>
                            </div>
                            {alwaysBlur.map(rule => (
                                <div
                                    key={rule.id}
                                    className="flex items-center justify-between px-4 py-3 border-b border-border-subtle last:border-b-0"
                                >
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        <span className="text-red-400 text-base">🔒</span>
                                        <div className="min-w-0">
                                            <p className="font-sans text-sm text-text-primary truncate">
                                                {rule.label}
                                            </p>
                                            <p className="font-mono text-[10px] text-text-secondary truncate">
                                                {rule.pattern}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleDeleteRule(rule.id)}
                                        className="p-1.5 rounded-lg hover:bg-red-500/10 text-text-secondary hover:text-red-400 transition-colors shrink-0"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Never Blur Section */}
                    {neverBlur.length > 0 && (
                        <div className="bg-card-bg border border-border-subtle rounded-xl overflow-hidden">
                            <div className="px-4 py-2.5 border-b border-border-subtle flex items-center gap-2">
                                <Eye className="w-4 h-4 text-green-400" />
                                <span className="font-sans text-xs font-semibold text-text-primary uppercase tracking-wider">
                                    Never Blur ({neverBlur.length})
                                </span>
                            </div>
                            {neverBlur.map(rule => (
                                <div
                                    key={rule.id}
                                    className="flex items-center justify-between px-4 py-3 border-b border-border-subtle last:border-b-0"
                                >
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        <span className="text-green-400 text-base">🔢</span>
                                        <div className="min-w-0">
                                            <p className="font-sans text-sm text-text-primary truncate">
                                                {rule.label}
                                            </p>
                                            <p className="font-mono text-[10px] text-text-secondary truncate">
                                                {rule.pattern}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleDeleteRule(rule.id)}
                                        className="p-1.5 rounded-lg hover:bg-red-500/10 text-text-secondary hover:text-red-400 transition-colors shrink-0"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Memorized App Layouts */}
                    {appLayouts.length > 0 && (
                        <div className="bg-card-bg border border-border-subtle rounded-xl overflow-hidden">
                            <div className="px-4 py-2.5 border-b border-border-subtle flex items-center gap-2">
                                <Smartphone className="w-4 h-4 text-blue-400" />
                                <span className="font-sans text-xs font-semibold text-text-primary uppercase tracking-wider">
                                    App Layouts Memorized ({appLayouts.length})
                                </span>
                            </div>
                            {appLayouts.map(layout => (
                                <div
                                    key={layout.appName}
                                    className="flex items-center justify-between px-4 py-3 border-b border-border-subtle last:border-b-0"
                                >
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        <span className="text-blue-400 text-base">📱</span>
                                        <div className="min-w-0">
                                            <p className="font-sans text-sm text-text-primary">
                                                {layout.appName}
                                            </p>
                                            <p className="font-sans text-[10px] text-text-secondary">
                                                {layout.totalScans} scan{layout.totalScans !== 1 ? 's' : ''} · {layout.rows.length} region{layout.rows.length !== 1 ? 's' : ''}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => handleResetApp(layout.appName)}
                                        className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-blue-500/10 text-text-secondary hover:text-blue-400 transition-colors text-xs shrink-0"
                                    >
                                        <RotateCcw className="w-3 h-3" />
                                        Reset
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Reset All */}
                    <button
                        onClick={handleResetAll}
                        className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-red-500/20 bg-red-500/5 text-red-400 font-sans text-xs font-medium hover:bg-red-500/10 transition-colors"
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                        Reset All Learned Rules
                    </button>
                </>
            )}
        </div>
    );
}
