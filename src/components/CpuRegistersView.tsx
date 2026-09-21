import React from 'react';
import { CpuState, MIPS_REGISTER_NAMES } from '../types';

interface CpuRegistersViewProps {
  cpuState: CpuState;
  ips: number;
  isPaused?: boolean;
}

export const CpuRegistersView: React.FC<CpuRegistersViewProps> = React.memo(({ cpuState, ips, isPaused }) => {
  const formatHex = (val: number) => (val >>> 0).toString(16).padStart(8, '0').toUpperCase();

  return (
    <div id="cpu-registers-panel" className="bg-zinc-900 border border-zinc-800 rounded p-3 flex flex-col gap-2 font-mono text-xs">
      {/* Pointers header */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-zinc-800 text-zinc-300">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-zinc-200">CPU Registers (App Debug Panel)</span>
          {isPaused && (
            <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 uppercase font-semibold tracking-wider">
              PAUSED
            </span>
          )}
        </div>
        <div className="text-[11px] text-zinc-400 flex items-center gap-3">
          <span>IPS: <strong className="text-zinc-200">{isPaused ? 0 : ips.toLocaleString()}</strong></span>
          <span>Cycles: <strong className="text-zinc-200">{cpuState.cycles.toLocaleString()}</strong></span>
        </div>
      </div>

      {/* Main Special Registers */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
        <div className="p-1.5 bg-zinc-950 border border-zinc-800 rounded">
          <div className="text-zinc-400">PC</div>
          <div className="font-bold text-zinc-100 tracking-wider">0x{formatHex(cpuState.pc)}</div>
        </div>
        <div className="p-1.5 bg-zinc-950 border border-zinc-800 rounded">
          <div className="text-zinc-400">Next PC</div>
          <div className="text-zinc-300 tracking-wider">0x{formatHex(cpuState.nextPc)}</div>
        </div>
        <div className="p-1.5 bg-zinc-950 border border-zinc-800 rounded">
          <div className="text-zinc-400">HI</div>
          <div className="text-zinc-300 tracking-wider">0x{formatHex(cpuState.hi)}</div>
        </div>
        <div className="p-1.5 bg-zinc-950 border border-zinc-800 rounded">
          <div className="text-zinc-400">LO</div>
          <div className="text-zinc-300 tracking-wider">0x{formatHex(cpuState.lo)}</div>
        </div>
      </div>

      {/* COP0 summary */}
      <div className="p-1.5 bg-zinc-950 border border-zinc-800 rounded text-[11px] flex flex-wrap items-center gap-x-4 gap-y-1 text-zinc-400">
        <span>SR: <strong className="text-zinc-200">0x{formatHex(cpuState.sr)}</strong></span>
        <span>Cause: <strong className="text-zinc-200">0x{formatHex(cpuState.cause)}</strong></span>
        <span>EPC: <strong className="text-zinc-200">0x{formatHex(cpuState.epc)}</strong></span>
      </div>

      {/* General Purpose Registers */}
      <div>
        <div className="text-[10px] text-zinc-400 uppercase tracking-wider mb-1">General Purpose ($r0 – $r31)</div>
        <div className="grid grid-cols-4 sm:grid-cols-8 gap-1 p-1 bg-zinc-950 rounded border border-zinc-800 text-[11px]">
          {Array.from(cpuState.regs).map((val: number, idx: number) => {
            const name = MIPS_REGISTER_NAMES[idx];
            const isNonZero = val !== 0;
            return (
              <div
                key={idx}
                className={`p-1 rounded border text-center ${
                  isNonZero
                    ? 'bg-zinc-800 border-zinc-700 text-zinc-100'
                    : 'bg-zinc-900/60 border-zinc-800 text-zinc-500'
                }`}
              >
                <div className="text-[9px] text-zinc-400">{name}</div>
                <div className="font-mono text-[10px] truncate">{formatHex(val)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
