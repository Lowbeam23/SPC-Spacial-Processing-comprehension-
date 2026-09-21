import React, { useState, useRef } from 'react';
import { BiosInfo, EmulationStatus, ExecutionMode } from '../types';

interface BiosDropzoneProps {
  biosInfo: BiosInfo | null;
  status: EmulationStatus;
  mode: ExecutionMode;
  speedMultiplier: number;
  onBiosDrop: (file: File) => void;
  onLoadBuiltin: () => void;
  onRun: () => void;
  onPause: () => void;
  onStep: () => void;
  onReset: () => void;
  onModeChange: (mode: ExecutionMode) => void;
  onSpeedChange: (speed: number) => void;
}

export const BiosDropzone: React.FC<BiosDropzoneProps> = ({
  biosInfo,
  status,
  mode,
  speedMultiplier,
  onBiosDrop,
  onLoadBuiltin,
  onRun,
  onPause,
  onStep,
  onReset,
  onModeChange,
  onSpeedChange,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onBiosDrop(e.dataTransfer.files[0]);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onBiosDrop(e.target.files[0]);
    }
  };

  return (
    <div id="bios-control-panel" className="flex flex-col gap-2 font-mono text-xs">
      {/* ROM / BIOS Dropzone */}
      <div
        id="bios-dropzone"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`p-3 rounded border text-center cursor-pointer transition-colors ${
          isDragging
            ? 'border-zinc-400 bg-zinc-800'
            : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".bin,.rom,.img,.bios,*"
          className="hidden"
          onChange={handleFileInput}
        />

        <div className="text-zinc-200 font-semibold mb-1">
          {biosInfo ? biosInfo.name : 'Load PS1 BIOS / ROM'}
        </div>
        <div className="text-[11px] text-zinc-400">
          {biosInfo ? (
            <span>
              {(biosInfo.size / 1024).toFixed(0)} KB • {biosInfo.versionString}
            </span>
          ) : (
            'Drop BIOS binary here or click to browse'
          )}
        </div>
        {biosInfo && (
          <div className="text-[10px] text-zinc-500 mt-1">Checksum: {biosInfo.checksum}</div>
        )}
      </div>

      {/* Primary Execution Controls */}
      <div className="p-3 rounded bg-zinc-900 border border-zinc-800 flex flex-col gap-2.5">
        <div className="flex items-center justify-between text-zinc-300">
          <span className="font-semibold">Execution Control</span>
          <span className="text-[11px] uppercase text-zinc-400">Status: {status}</span>
        </div>

        {/* Buttons: Run, Step, Pause, Reset */}
        <div className="grid grid-cols-4 gap-1.5">
          {status === 'running' ? (
            <button
              id="pause-bios-btn"
              onClick={onPause}
              className="col-span-2 py-1.5 px-3 rounded bg-amber-700 hover:bg-amber-600 text-white font-semibold text-xs transition-colors"
            >
              Pause
            </button>
          ) : (
            <button
              id="run-bios-btn"
              onClick={onRun}
              className="col-span-2 py-1.5 px-3 rounded bg-zinc-100 hover:bg-white text-zinc-950 font-semibold text-xs transition-colors"
            >
              Run BIOS
            </button>
          )}

          <button
            id="step-bios-btn"
            onClick={onStep}
            className="py-1.5 px-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs border border-zinc-700 transition-colors"
          >
            Step
          </button>

          <button
            id="reset-bios-btn"
            onClick={onReset}
            className="py-1.5 px-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs border border-zinc-700 transition-colors"
          >
            Reset
          </button>
        </div>

        {/* Recompilation Mode Selector */}
        <div className="pt-2 border-t border-zinc-800 flex flex-col gap-1">
          <div className="text-zinc-400 text-[11px]">Execution Engine:</div>
          <div className="grid grid-cols-3 gap-1">
            {(['hybrid', 'jit', 'interpreter'] as ExecutionMode[]).map((m) => (
              <button
                key={m}
                id={`mode-${m}-btn`}
                onClick={() => onModeChange(m)}
                className={`py-1 px-1.5 rounded text-[11px] font-mono border transition-colors ${
                  mode === m
                    ? 'bg-zinc-200 text-zinc-900 border-zinc-200 font-bold'
                    : 'bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                }`}
              >
                {m === 'hybrid' ? 'Hybrid' : m === 'jit' ? 'JIT Blocks' : 'Line-by-Line'}
              </button>
            ))}
          </div>
        </div>

        {/* Speed and ROM switch */}
        <div className="pt-2 border-t border-zinc-800 flex items-center justify-between text-[11px] text-zinc-400">
          <div className="flex items-center gap-1.5">
            <span>Clock:</span>
            <select
              id="clock-speed-select"
              value={speedMultiplier}
              onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
              className="bg-zinc-950 border border-zinc-800 text-zinc-200 rounded px-1.5 py-0.5"
            >
              <option value="0.25">0.25x</option>
              <option value="0.5">0.5x</option>
              <option value="1.0">1.0x (33.8 MHz)</option>
              <option value="2.0">2.0x</option>
              <option value="5.0">5.0x</option>
            </select>
          </div>

          <button
            id="load-builtin-rom-btn"
            onClick={onLoadBuiltin}
            className="text-zinc-400 hover:text-zinc-200 underline cursor-pointer"
          >
            Load Diagnostic ROM
          </button>
        </div>
      </div>
    </div>
  );
};
