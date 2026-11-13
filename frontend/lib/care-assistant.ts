import type { Role } from './types';

/** Pages where the floating assistant button would be in the way or pointless: the assistant itself, and signing in or setting up. */
const HIDDEN_ON = ['/assistant', '/login', '/signup', '/onboarding', '/invite', '/continue'];

const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** Only signed-in doctors and patients get the launcher, and not on the pages above. Receptionists, admins and signed-out visitors never do. */
export function launcherVisible(role: Role | null | undefined, pathname: string): boolean {
  if (role !== 'DOCTOR' && role !== 'PATIENT') return false;
  return !HIDDEN_ON.some((prefix) => isUnder(pathname, prefix));
}

/** The one-line hint shown beside the button, by role. */
export function launcherTip(role: Role): string {
  return role === 'DOCTOR'
    ? 'Manage your schedule: cancel or move appointments, add hours, block a day.'
    : 'Book, reschedule or cancel appointments, check payments and refunds.';
}

export const TIP_KEY = 'careslot.launcher.tip';

type TipStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Whether the hint should be shown now, and if so remembers (for this browser session only) that it has been. Storage can be missing or
 * throw (private windows, blocked site data): then the hint simply shows, and the caller keeps its own in-memory note so it shows once.
 */
export function takeTip(storage: TipStorage | null): boolean {
  try {
    if (storage?.getItem(TIP_KEY)) return false;
    storage?.setItem(TIP_KEY, '1');
  } catch {
    /* not remembered: shown this once */
  }
  return true;
}

/** The sentence under the chat box, by role: what the assistant can do, that actions need a button press, and that it is not medical advice. */
export function assistantFooterText(role: Role): string {
  const can =
    role === 'DOCTOR'
      ? 'It can look things up and prepare a cancellation, a move, extra hours or a blocked day'
      : 'It can look things up and prepare a booking, a reschedule or a cancellation';
  return `${can}, but nothing happens until you press Confirm on the card; saying “yes” does not confirm. It is not medical advice.`;
}
