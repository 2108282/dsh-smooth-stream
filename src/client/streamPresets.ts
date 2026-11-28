export type StreamSmoothingPreset = 'realtime' | 'balanced' | 'silky'

export interface StreamSmoothingPresetConfig {
  readonly activeInputWindowMs: number
  readonly defaultCps: number
  readonly emaAlpha: number
  readonly flushCps: number
  readonly largeAppendChars: number
  readonly maxActiveCps: number
  readonly maxCps: number
  readonly maxFlushCps: number
  readonly minCps: number
  readonly settleAfterMs: number
  readonly settleDrainMaxMs: number
  readonly settleDrainMinMs: number
  readonly targetBufferMs: number
}

export const PRESET_CONFIG: Record<StreamSmoothingPreset, StreamSmoothingPresetConfig> = {
  balanced: {
    activeInputWindowMs: 220,
    defaultCps: 110,
    emaAlpha: 0.38,
    flushCps: 260,
    largeAppendChars: 140,
    maxActiveCps: 420,
    maxCps: 320,
    maxFlushCps: 560,
    minCps: 28,
    settleAfterMs: 260,
    settleDrainMaxMs: 380,
    settleDrainMinMs: 100,
    targetBufferMs: 32,
  },
  realtime: {
    activeInputWindowMs: 140,
    defaultCps: 120,
    emaAlpha: 0.45,
    flushCps: 240,
    largeAppendChars: 180,
    maxActiveCps: 480,
    maxCps: 320,
    maxFlushCps: 640,
    minCps: 32,
    settleAfterMs: 200,
    settleDrainMaxMs: 280,
    settleDrainMinMs: 100,
    targetBufferMs: 24,
  },
  silky: {
    activeInputWindowMs: 280,
    defaultCps: 64,
    emaAlpha: 0.28,
    flushCps: 140,
    largeAppendChars: 100,
    maxActiveCps: 280,
    maxCps: 180,
    maxFlushCps: 400,
    minCps: 20,
    settleAfterMs: 360,
    settleDrainMaxMs: 520,
    settleDrainMinMs: 160,
    targetBufferMs: 56,
  },
}
