import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// nav.tsx is a React client module that imports the session hooks, so these tests read its NAV table as text instead of running it.
const source = readFileSync(new URL('../components/nav.tsx', import.meta.url), 'utf8');
const table = source.slice(source.indexOf('const NAV'), source.indexOf('/** The workspace navigation'));

function itemsOf(role: string): { href: string; label: string }[] {
  const start = table.indexOf(`  ${role}: [`);
  const after = table.slice(start + 1);
  const next = after.search(/\n {2}[A-Z]+: \[|\n\};/);
  const block = table.slice(start, next === -1 ? undefined : start + 1 + next);
  return [...block.matchAll(/href: '([^']+)', label: '([^']+)'/g)].map((match) => ({ href: match[1], label: match[2] }));
}

describe('workspace navigation', () => {
  it('has no Assistant item for patients or doctors: the floating launcher is the way in', () => {
    for (const role of ['PATIENT', 'DOCTOR']) {
      const items = itemsOf(role);
      expect(items.length).toBeGreaterThan(0);
      expect(items.map((item) => item.href)).not.toContain('/assistant');
      expect(items.map((item) => item.label)).not.toContain('Assistant');
    }
    expect(table).not.toMatch(/href: '\/assistant'/);
  });

  it('leaves every other patient item as it was, in order', () => {
    expect(itemsOf('PATIENT')).toEqual([
      { href: '/', label: 'Find Doctors' },
      { href: '/appointments', label: 'My Appointments' },
      { href: '/payments', label: 'Payments & Receipts' },
      { href: '/notifications', label: 'Notifications' },
      { href: '/profile', label: 'My Profile' },
    ]);
  });

  it('leaves every other doctor item as it was, in order', () => {
    expect(itemsOf('DOCTOR')).toEqual([
      { href: '/doctor', label: 'Dashboard' },
      { href: '/doctor/appointments', label: 'Appointments' },
      { href: '/doctor/availability', label: 'Availability' },
      { href: '/doctor/profile', label: 'Profile' },
    ]);
  });

  it('does not touch the admin and receptionist navigation', () => {
    expect(itemsOf('ADMIN')).toEqual([{ href: '/admin/receptionists', label: 'Receptionists' }]);
    expect(itemsOf('RECEPTIONIST')).toEqual([{ href: '/reception', label: 'Front desk' }]);
  });
});
