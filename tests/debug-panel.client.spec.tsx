import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DebugPanel, type DebugPanelProps } from '../src/client/DebugPanel.tsx'
import { debugRuntime, type DebugPanelFace, type DebugRuntimeState } from '../src/client/debugRuntime.ts'
import { en } from '../src/client/locales.ts'
import { DEFAULT_STREAM_DEBUG_TUNING } from '../src/settings.ts'

afterEach(() => {
  cleanup()
  debugRuntime.resetRuntime()
  vi.restoreAllMocks()
})

function state(overrides: Partial<DebugRuntimeState> = {}): DebugRuntimeState {
  return {
    available: true,
    enabled: true,
    tuningEnabled: false,
    writable: true,
    dirty: false,
    status: 'ready',
    tuning: DEFAULT_STREAM_DEBUG_TUNING,
    metrics: {
      fps: 58,
      frameMs: 17.2,
      fpsDegraded: false,
      streamActive: true,
      streamBacklog: 18,
      streamSpeedCps: 146,
      streamTargetChars: 240,
      streamDisplayedChars: 222,
      followActive: true,
      followLagPx: 12.5,
      followVelocityPxPerSec: 84,
      followReservePx: 20,
      followCapacityPx: 42,
      followRevealScale: 0.86,
      followFollowing: true,
      followConstrained: false,
      scrollTop: 840,
      scrollHeight: 1400,
      clientHeight: 560,
      lastUpdatedMs: 100,
    },
    ...overrides,
  }
}

function setup(overrides: Partial<DebugRuntimeState> = {}) {
  const store = createSnapshotStore(state(overrides))
  const face: DebugPanelFace = {
    hooks: { debugRuntime: store },
    edit: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
    reset: vi.fn(),
  }
  const props = {
    ...face,
    t: (key: keyof typeof en) => en[key],
    useDebugRuntime: (selector: (snapshot: DebugRuntimeState) => unknown) => selector(store.getSnapshot()),
  } as unknown as DebugPanelProps
  const view = render(<DebugPanel {...props} />)
  return {
    face,
    view,
    setState: (next: Partial<DebugRuntimeState>) => {
      store.set({ ...store.getSnapshot(), ...next })
      view.rerender(<DebugPanel {...props} />)
    },
  }
}

describe('render diagnostics panel', () => {
  it.each([false, true])('applies saved physical tuning independently of HUD=%s', hud => {
    const tuning = { ...DEFAULT_STREAM_DEBUG_TUNING, cadenceClamp: 5, maxRevealCps: 220 }
    debugRuntime.syncSettings({ available: true, enabled: hud, tuningEnabled: true,
      writable: true, dirty: false, status: 'ready', tuning })
    expect(debugRuntime.activeTuning()).toEqual(tuning)
    expect(debugRuntime.isEnabled()).toBe(hud)
    debugRuntime.edit({ debugEnabled: false })
    expect(debugRuntime.activeTuning()).toEqual(tuning)
    debugRuntime.edit({ debugTuningEnabled: false })
    expect(debugRuntime.activeTuning()).toEqual(DEFAULT_STREAM_DEBUG_TUNING)
    expect(debugRuntime.tuning()).toEqual(tuning)
    debugRuntime.edit({ debugEnabled: true })
    expect(debugRuntime.activeTuning()).toEqual(DEFAULT_STREAM_DEBUG_TUNING)
  })

  it('publishes a cadence-only settings update and keeps explicit tuning off', () => {
    const input = { available: true, enabled: false, tuningEnabled: true,
      writable: true, dirty: false, status: 'ready' as const }
    debugRuntime.syncSettings({ ...input, tuning: DEFAULT_STREAM_DEBUG_TUNING })
    debugRuntime.syncSettings({ ...input, tuning: { ...DEFAULT_STREAM_DEBUG_TUNING, cadenceClamp: 5 } })
    expect(debugRuntime.activeTuning().cadenceClamp).toBe(5)
    debugRuntime.syncSettings({ ...input, enabled: true, tuningEnabled: false })
    expect(debugRuntime.activeTuning().cadenceClamp).toBe(4)
    debugRuntime.syncSettings({ ...input, available: false })
    expect(debugRuntime.activeTuning()).toEqual(DEFAULT_STREAM_DEBUG_TUNING)
  })

  it('clears stale measurements whenever diagnostics are toggled or a source stops', () => {
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    debugRuntime.syncSettings({
      enabled: true,
      writable: true,
      dirty: false,
      status: 'ready',
      tuning: DEFAULT_STREAM_DEBUG_TUNING,
    })
    const metric = {
      backlog: 24,
      speedCps: 180,
      targetChars: 120,
      displayedChars: 96,
      active: true,
    }

    debugRuntime.reportStream('reply', metric)
    expect(debugRuntime.getSnapshot().metrics).toMatchObject({ streamActive: true, streamBacklog: 24 })

    // Removal must publish immediately even inside the normal 80ms throttle.
    debugRuntime.reportStream('reply', null)
    expect(debugRuntime.getSnapshot().metrics).toMatchObject({ streamActive: false, streamBacklog: 0 })

    debugRuntime.reportStream('reply', metric)
    debugRuntime.edit({ debugEnabled: false })
    debugRuntime.edit({ debugEnabled: true })
    expect(debugRuntime.getSnapshot().metrics).toMatchObject({
      streamActive: false,
      streamBacklog: 0,
      lastUpdatedMs: null,
    })

    debugRuntime.reportFps(28, 35.7, true)
    debugRuntime.clearFps()
    expect(debugRuntime.getSnapshot().metrics).toMatchObject({
      fps: null,
      frameMs: null,
      fpsDegraded: false,
    })
  })

  it('shows live stream and follow measurements in the chat-side panel', () => {
    setup()

    expect(screen.getByRole('complementary', { name: en.debugPanelTitle })).toBeTruthy()
    expect(screen.getByText('58')).toBeTruthy()
    expect(screen.getByText('18')).toBeTruthy()
    expect(screen.getByText('222 / 240')).toBeTruthy()
    expect(screen.getByText(en.debugFollowing)).toBeTruthy()
  })

  it('does not expose diagnostics when the Host lacks the debug RPC', () => {
    setup({ available: false, enabled: false })

    expect(screen.queryByRole('complementary', { name: en.debugPanelTitle })).toBeNull()
    expect(screen.queryByRole('button', { name: en.debugPanelToggle })).toBeNull()
  })

  it('edits tuning live and exposes save, discard, and reset actions', () => {
    const { face } = setup({ dirty: true })
    const revealSlider = screen.getByRole('slider', { name: en.debugRevealMultiplier })

    fireEvent.change(revealSlider, { target: { value: '1.5' } })
    expect(face.edit).toHaveBeenCalledWith({
      debugTuning: { ...DEFAULT_STREAM_DEBUG_TUNING, revealScale: 1.5 },
    })

    fireEvent.click(screen.getByRole('button', { name: en.debugReset }))
    fireEvent.click(screen.getByRole('button', { name: en.debugDiscard }))
    fireEvent.click(screen.getByRole('button', { name: en.debugSave }))
    expect(face.reset).toHaveBeenCalledOnce()
    expect(face.discard).toHaveBeenCalledOnce()
    expect(face.save).toHaveBeenCalledOnce()
  })

  it('explains each tuning control and disables diagnostics when the panel is closed', () => {
    const { face, setState } = setup()
    const info = screen.getAllByRole('button', { name: en.debugRevealMultiplier })[0]
    if (info === undefined) throw new Error('reveal multiplier info button was not rendered')
    expect(info.getAttribute('title')).toContain(en.debugTipRevealMultiplier)

    fireEvent.click(screen.getByRole('button', { name: en.debugPanelClose }))
    expect(face.edit).toHaveBeenCalledWith({ debugEnabled: false })
    expect(face.save).toHaveBeenCalledOnce()
    setState({ enabled: false })
    expect(screen.queryByRole('complementary', { name: en.debugPanelTitle })).toBeNull()
    expect(screen.queryByRole('button', { name: en.debugPanelToggle })).toBeNull()
  })

  it('removes the panel trigger when diagnostics are disabled', () => {
    const { setState } = setup()
    fireEvent.click(screen.getByRole('button', { name: en.debugPanelClose }))
    setState({ enabled: false })
    expect(screen.queryByRole('complementary', { name: en.debugPanelTitle })).toBeNull()
    expect(screen.queryByRole('button', { name: en.debugPanelToggle })).toBeNull()
  })

  it('disables close while settings are temporarily unwritable', () => {
    const { face } = setup({ writable: false })
    const close = screen.getByRole('button', { name: en.debugPanelClose })

    expect(close.getAttribute('disabled')).not.toBeNull()
    fireEvent.click(close)

    expect(face.edit).not.toHaveBeenCalled()
    expect(face.save).not.toHaveBeenCalled()
    expect(screen.getByRole('complementary', { name: en.debugPanelTitle })).toBeTruthy()
  })

  it('does not render a trigger when diagnostics are disabled', () => {
    const { face } = setup({ enabled: false })
    expect(face.edit).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: en.debugPanelToggle })).toBeNull()
  })
})
