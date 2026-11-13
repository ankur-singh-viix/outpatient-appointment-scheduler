import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CYCLE_MS, LABEL_FULL, hintFor, labelFor, shouldCycle, startCycle } from './launcher-label';

const running = { reducedMotion: false, hovered: false, focused: false, tabHidden: false };

describe('hintFor: the short text by role', () => {
  it('says what a patient can do', () => expect(hintFor('PATIENT')).toBe('Book or cancel appointments'));
  it('says what a doctor can do', () => expect(hintFor('DOCTOR')).toBe('Manage your schedule'));
});

describe('labelFor: what is shown', () => {
  it('shows the full name, or the role hint while cycling', () => {
    expect(labelFor({ role: 'PATIENT', showHint: false, cycling: true })).toEqual({ text: 'Care Assistant', isHint: false });
    expect(labelFor({ role: 'PATIENT', showHint: true, cycling: true })).toEqual({ text: 'Book or cancel appointments', isHint: true });
    expect(labelFor({ role: 'DOCTOR', showHint: true, cycling: true })).toEqual({ text: 'Manage your schedule', isHint: true });
  });

  it('always shows the full name when not cycling, even if the hint was on a moment ago', () => {
    for (const role of ['PATIENT', 'DOCTOR'] as const) expect(labelFor({ role, showHint: true, cycling: false })).toEqual({ text: LABEL_FULL, isHint: false });
  });
});

describe('shouldCycle: when the label moves', () => {
  it('cycles when nothing stops it', () => expect(shouldCycle(running)).toBe(true));
  it('pauses on hover', () => expect(shouldCycle({ ...running, hovered: true })).toBe(false));
  it('pauses on keyboard focus', () => expect(shouldCycle({ ...running, focused: true })).toBe(false));
  it('stops under reduced motion', () => expect(shouldCycle({ ...running, reducedMotion: true })).toBe(false));
  it('stops while the tab is hidden', () => expect(shouldCycle({ ...running, tabHidden: true })).toBe(false));
});

describe('startCycle: the timing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('toggles about every 4 seconds: full label, then hint, then back', () => {
    let showHint = false;
    const seen: string[] = [];
    const stop = startCycle(() => {
      showHint = !showHint;
      seen.push(labelFor({ role: 'PATIENT', showHint, cycling: true }).text);
    });
    expect(CYCLE_MS).toBe(4000);
    vi.advanceTimersByTime(3999);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    vi.advanceTimersByTime(4000);
    vi.advanceTimersByTime(4000);
    expect(seen).toEqual(['Book or cancel appointments', 'Care Assistant', 'Book or cancel appointments']);
    stop();
  });

  it('stops for good when asked (as on hover, focus, reduced motion or a hidden tab)', () => {
    const toggle = vi.fn();
    const stop = startCycle(toggle);
    vi.advanceTimersByTime(8000);
    expect(toggle).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(20_000);
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it('pausing and resuming the way the launcher does: hover freezes it on the full label, leaving starts a fresh cycle', () => {
    let showHint = false;
    const flip = () => (showHint = !showHint);
    let stop = startCycle(flip);
    vi.advanceTimersByTime(4000); // the hint is showing
    expect(labelFor({ role: 'DOCTOR', showHint, cycling: true }).text).toBe('Manage your schedule');
    stop(); // pointer enters
    expect(labelFor({ role: 'DOCTOR', showHint, cycling: shouldCycle({ ...running, hovered: true }) }).text).toBe('Care Assistant');
    vi.advanceTimersByTime(30_000);
    showHint = false; // pointer leaves: back to the full label
    stop = startCycle(flip);
    vi.advanceTimersByTime(3999);
    expect(labelFor({ role: 'DOCTOR', showHint, cycling: true }).text).toBe('Care Assistant');
    stop();
  });

  it('accepts replaced timers', () => {
    const set = vi.fn(() => 7);
    const clear = vi.fn();
    const stop = startCycle(() => undefined, 1234, { set, clear });
    expect(set).toHaveBeenCalledWith(expect.any(Function), 1234);
    stop();
    expect(clear).toHaveBeenCalledWith(7);
  });
});
