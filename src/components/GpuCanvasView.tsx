import React, { useRef, useEffect } from 'react';
import { Gpu } from '../emulator/gpu';
import { GpuState, EmulationStatus } from '../types';

interface GpuCanvasViewProps {
  gpu: Gpu;
  gpuState: GpuState;
  scanlines: boolean;
  status: EmulationStatus;
  lastError: string | null;
  hasBiosLoaded?: boolean;
  onOpenLoadBios?: () => void;
  onOpenMountDisc?: () => void;
  hasDiscLoaded?: boolean;
  discName?: string;
}

export const GpuCanvasView: React.FC<GpuCanvasViewProps> = ({
  gpu,
  scanlines,
  status,
  lastError,
  hasBiosLoaded = false,
  onOpenLoadBios,
  onOpenMountDisc,
  hasDiscLoaded = false,
  discName,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    gpu.targetCanvasCtx = ctx;

    const doRender = () => {
      const activeW = gpu.width || 640;
      const activeH = gpu.height || 480;
      if (canvas.width !== activeW || canvas.height !== activeH) {
        canvas.width = activeW;
        canvas.height = activeH;
      }
      gpu.renderToCanvas(
        ctx,
        canvas.width,
        canvas.height,
        scanlines,
        hasBiosLoaded && (status === 'running' || status === 'paused'),
        lastError
      );
    };

    doRender();
    gpu.onFrame = doRender;

    return () => {
      if (gpu.onFrame === doRender) {
        gpu.onFrame = undefined;
      }
    };
  }, [gpu, scanlines, status, lastError, hasBiosLoaded]);

  return (
    <div
      id="ps1-monitor-frame"
      className="relative flex items-center justify-center p-2 sm:p-3 rounded-sm bg-gradient-to-b from-[#1c1c22] to-[#101014] border-t-2 border-l-2 border-zinc-500 border-b-2 border-r-2 border-black shadow-2xl h-full max-h-full max-w-full"
    >
      <div className="relative aspect-[4/3] h-full max-h-full max-w-full w-auto bg-black border border-zinc-800 rounded-xs overflow-hidden shadow-inner flex items-center justify-center">
        <canvas
          id="ps1-gpu-canvas"
          ref={canvasRef}
          width={gpu.width || 640}
          height={gpu.height || 480}
          className="w-full h-full object-contain"
          style={{ imageRendering: 'pixelated' }}
        />

        {/* When No BIOS Loaded: Display Authentic LLE Prompt */}
        {!hasBiosLoaded && (
          <div
            id="no-bios-prompt-overlay"
            className="absolute inset-0 bg-black/90 flex flex-col items-center justify-center p-6 text-center font-mono select-none z-30"
          >
            <div className="w-12 h-12 mb-3 rounded-full bg-blue-950 border border-blue-500 flex items-center justify-center text-blue-300 text-xl font-bold shadow-lg">
              PS
            </div>
            <h2 className="text-zinc-100 text-sm sm:text-base font-bold tracking-wide uppercase mb-1">
              PlayStation 1 LLE
            </h2>
            <p className="text-amber-400 text-xs sm:text-sm font-semibold max-w-sm mb-2">
              Please load a 512KB PS1 BIOS ROM to begin.
            </p>
            <p className="text-zinc-400 text-[11px] max-w-xs mb-4">
              (SCPH-1001.bin, SCPH-7001.bin, etc. — exactly 524,288 bytes)
            </p>

            {onOpenLoadBios && (
              <button
                id="prompt-load-bios-btn"
                onClick={onOpenLoadBios}
                className="px-4 py-2 bg-gradient-to-b from-blue-700 to-blue-900 hover:from-blue-600 hover:to-blue-800 text-white font-bold text-xs rounded-sm border-t border-l border-blue-400 border-b border-r border-blue-950 shadow-lg active:translate-y-px transition-transform flex items-center gap-1.5"
              >
                <span>📂 LOAD BIOS ROM (512KB)</span>
              </button>
            )}

            <div className="mt-4 text-[10px] text-zinc-500 max-w-xs">
              Once loaded, your authentic BIOS is automatically preserved in browser storage across sessions.
            </div>
          </div>
        )}

        {/* CRT Glass Reflection & Scanlines Overlay */}
        {scanlines && (
          <div
            className="absolute inset-0 pointer-events-none opacity-25"
            style={{
              backgroundImage:
                'linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.4) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.03), rgba(0, 255, 0, 0.01), rgba(0, 0, 255, 0.03))',
              backgroundSize: '100% 3px, 6px 100%',
            }}
          />
        )}
      </div>
    </div>
  );
};
