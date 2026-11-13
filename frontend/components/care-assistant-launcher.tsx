'use client';

import { SparklesIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { launcherTip, launcherVisible, takeTip } from '@/lib/care-assistant';
import { LABEL_FULL, hintFor, labelFor, shouldCycle, startCycle } from '@/lib/launcher-label';
import { useHydrated, useSession } from '@/lib/session';

/**
 * A floating button, bottom right, that takes a signed-in doctor or patient to the assistant from any page (it is the only way in).
 * It shows on the pages the rules in lib/care-assistant allow, says what the assistant can do in a hint once per browser session, and
 * is a plain link: it does nothing but navigate. A slowly turning gradient ring surrounds a solid teal button; the label alternates
 * with a short hint for the person's role (lib/launcher-label). Everything moves only for people who have not asked their system for
 * reduced motion, and stops while the tab is hidden.
 */
export function CareAssistantLauncher() {
  // usePathname suspends on dynamic routes, so it needs a boundary of its own.
  return (
    <Suspense fallback={null}>
      <Launcher />
    </Suspense>
  );
}

/*
 * Styles live here, scoped by the care-* class names. Only transform-like properties (translate, scale), opacity, the --care-angle
 * variable and the label's width are animated, and the button is fixed-position, so nothing on the page shifts. Where @property is not
 * supported the variable cannot animate, so the ring is simply a still gradient.
 * The dock sits at z-index 30: above page content, below the dialogs (z-40 backdrop, z-50 popup).
 */
const RING = 'conic-gradient(from var(--care-angle), #4285f4, #9b72f2, #f06ac6, #fbbc04, #14b8a6, #4285f4)';
const STYLES = `
@property --care-angle { syntax: '<angle>'; inherits: true; initial-value: 0deg; }
@keyframes careSpin { to { --care-angle: 360deg; } }
@keyframes careIn { from { opacity: 0; translate: 0 14px; } }

.care-dock { position: fixed; z-index: 30; right: max(1rem, env(safe-area-inset-right)); bottom: max(1rem, env(safe-area-inset-bottom)); display: flex; flex-direction: column; align-items: flex-end; gap: .5rem; pointer-events: none; }
@media (min-width: 640px) { .care-dock { right: max(1.5rem, env(safe-area-inset-right)); bottom: max(1.5rem, env(safe-area-inset-bottom)); } }

.care-launcher { --care-angle: 0deg; position: relative; isolation: isolate; display: inline-flex; padding: 2px; border-radius: 9999px; color: #fff; text-decoration: none; outline: none; pointer-events: auto;
  background: ${RING};
  animation: careIn .5s ease-out .8s backwards, careSpin 6s linear infinite;
  transition: translate .2s ease, scale .15s ease; }
.care-launcher[data-paused='true'] { animation-play-state: paused, paused; }
.care-launcher::before { content: ''; position: absolute; inset: -5px; z-index: -1; border-radius: inherit; background: ${RING}; filter: blur(14px); opacity: .32; transition: opacity .25s ease; }
.care-launcher:hover { translate: 0 -2px; }
.care-launcher:hover::before { opacity: .55; }
.care-launcher:active { scale: .96; }
/* Distinct from the gradient ring: a dark outline on a white band, visible on light and dark pages. */
.care-launcher:focus-visible { outline: 3px solid #111827; outline-offset: 4px; box-shadow: 0 0 0 7px #fff; }

.care-launcher-inner { position: relative; display: flex; align-items: center; justify-content: center; gap: .5rem; width: 2.75rem; height: 2.75rem; border-radius: 9999px; background: #00796b; font-size: .875rem; font-weight: 600; line-height: 1.25rem; white-space: nowrap; }
.care-launcher-label { display: none; position: relative; height: 1.25rem; overflow: hidden; transition: width .5s ease; }
.care-launcher-label > span { position: absolute; top: 0; left: 0; transition: opacity .35s ease; }
.care-launcher-hint { opacity: 0; }
.care-launcher-label[data-hint='true'] .care-launcher-hint { opacity: 1; }
.care-launcher-label[data-hint='true'] .care-launcher-full { opacity: 0; }
@media (min-width: 640px) {
  .care-launcher-inner { width: auto; padding: 0 1rem 0 .85rem; }
  .care-launcher-label { display: block; }
}

@media (prefers-reduced-motion: reduce) {
  .care-launcher { animation: none; transition: none; }
  .care-launcher::before, .care-launcher-label, .care-launcher-label > span { transition: none; }
  .care-launcher:hover, .care-launcher:active { translate: none; scale: none; }
}`;

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const subscribeMotion = (notify: () => void) => {
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};
const subscribeVisibility = (notify: () => void) => {
  document.addEventListener('visibilitychange', notify);
  return () => document.removeEventListener('visibilitychange', notify);
};

function Launcher() {
  const hydrated = useHydrated();
  const session = useSession();
  const pathname = usePathname();
  const [tip, setTip] = useState(false);
  const shown = useRef(false); // in memory too, so a browser without session storage still shows the hint only once
  const role = session?.user.role;
  const visible = hydrated && launcherVisible(role, pathname);

  // What decides whether the label cycles: the person's motion preference, the pointer, keyboard focus, and whether the tab is on screen.
  const reducedMotion = useSyncExternalStore(subscribeMotion, () => window.matchMedia(REDUCED_MOTION).matches, () => false);
  const tabHidden = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === 'hidden', () => false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const cycling = shouldCycle({ reducedMotion, hovered, focused, tabHidden });
  const label = labelFor({ role: role === 'DOCTOR' ? 'DOCTOR' : 'PATIENT', showHint, cycling });

  const wrap = useRef<HTMLSpanElement>(null);
  const full = useRef<HTMLSpanElement>(null);
  const hint = useRef<HTMLSpanElement>(null);
  const measured = useRef(false);

  useEffect(() => {
    if (!visible || !cycling) return;
    return startCycle(() => setShowHint((current) => !current));
  }, [visible, cycling]);

  // The label's box is as wide as the text showing, and its width transitions between the two. Measured from the text itself.
  useEffect(() => {
    const box = wrap.current;
    const text = label.isHint ? hint.current : full.current;
    if (!box || !text) return;
    const fit = () => {
      box.style.width = `${text.offsetWidth}px`;
    };
    if (!measured.current) {
      box.style.transition = 'none'; // the first measurement is set, not animated
      fit();
      void box.offsetWidth;
      box.style.transition = '';
      measured.current = true;
    } else {
      fit();
    }
    let current = true;
    void document.fonts?.ready.then(() => current && fit());
    return () => {
      current = false;
    };
  }, [label.isHint, visible]);

  useEffect(() => {
    if (!visible || shown.current) return;
    const open = setTimeout(() => {
      shown.current = true;
      let storage: Storage | null = null;
      try {
        storage = window.sessionStorage;
      } catch {
        storage = null;
      }
      if (takeTip(storage)) setTip(true);
    }, 1800);
    return () => clearTimeout(open);
  }, [visible]);

  useEffect(() => {
    if (!tip) return;
    const close = setTimeout(() => setTip(false), 9000);
    return () => clearTimeout(close);
  }, [tip]);

  if (!visible || !role) return null;

  return (
    <div className="care-dock">
      <style>{STYLES}</style>
      {tip && (
        <div role="status" className="pointer-events-auto relative max-w-[min(16rem,calc(100vw-2rem))] rounded-xl border bg-card p-3 pr-8 text-sm text-foreground shadow-lg">
          {launcherTip(role)}
          <button
            type="button"
            aria-label="Dismiss this hint"
            onClick={() => setTip(false)}
            className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
      <Link
        href="/assistant"
        // A fixed name: the changing text below is for the eye only, so a screen reader never hears it change.
        aria-label="Open Care Assistant"
        title={LABEL_FULL}
        data-paused={tabHidden}
        onClick={() => setTip(false)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => {
          setHovered(false);
          setShowHint(false);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          setShowHint(false);
        }}
        className="care-launcher"
      >
        <span className="care-launcher-inner">
          <SparklesIcon className="size-5 shrink-0" aria-hidden />
          <span ref={wrap} className="care-launcher-label" data-hint={label.isHint} aria-hidden>
            <span ref={full} className="care-launcher-full">
              {LABEL_FULL}
            </span>
            <span ref={hint} className="care-launcher-hint">
              {hintFor(role)}
            </span>
          </span>
        </span>
      </Link>
    </div>
  );
}
