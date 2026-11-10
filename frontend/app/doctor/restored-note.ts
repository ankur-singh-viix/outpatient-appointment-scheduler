/**
 * What to tell the doctor when widening their hours (extending a session, adding one, lifting a date exception) brought booked
 * appointments that were waiting for a new time back inside the hours. Those patients need nothing more, and a message that has
 * not been sent yet is withdrawn.
 */
export function restoredNote(count: number | undefined): string {
  if (!count) return '';
  return count === 1
    ? ' 1 appointment that was waiting for a new time is back inside your hours, so its patient does not need to do anything.'
    : ` ${count} appointments that were waiting for a new time are back inside your hours, so their patients do not need to do anything.`;
}
