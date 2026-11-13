import type { Role } from './types';

/** The launcher's name, and the label it always returns to. */
export const LABEL_FULL = 'Care Assistant';

/** How long each label stays before the next one slides in. */
export const CYCLE_MS = 4000;

/** The short hint the label alternates with, by role. */
export function hintFor(role: Role): string {
  return role === 'DOCTOR' ? 'Manage your schedule' : 'Book or cancel appointments';
}

/**
 * The text to show right now. The hint only ever appears while the label is actually cycling: under reduced motion, while the pointer
 * or keyboard focus is on the button, or while the tab is hidden, it is always the full "Care Assistant".
 */
export function labelFor(input: { role: Role; showHint: boolean; cycling: boolean }): { text: string; isHint: boolean } {
  const isHint = input.cycling && input.showHint;
  return { text: isHint ? hintFor(input.role) : LABEL_FULL, isHint };
}

/** Whether the label should be cycling: never for people who asked for less motion, never while hovered or focused, never in a hidden tab. */
export function shouldCycle(state: { reducedMotion: boolean; hovered: boolean; focused: boolean; tabHidden: boolean }): boolean {
  return !state.reducedMotion && !state.hovered && !state.focused && !state.tabHidden;
}

interface Timers {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

/** Calls `toggle` every `ms` until the returned function is called. Timers can be replaced in a test. */
export function startCycle(toggle: () => void, ms: number = CYCLE_MS, timers?: Timers): () => void {
  const set = timers?.set ?? ((callback: () => void, delay: number) => setInterval(callback, delay));
  const clear = timers?.clear ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const handle = set(toggle, ms);
  return () => clear(handle);
}
