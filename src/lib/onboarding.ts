// First-run onboarding state — a single "completed" flag in localStorage plus
// a tiny same-tab request channel so the settings screen can ask the app
// shell to re-open the wizard (the overlay lives in app.tsx, above all views).

import { loadMyArticles } from "./articleStore";

const DONE_KEY = "tc-news:onboarding-done";

export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    // Storage unavailable — treat as done so the wizard can't loop forever.
    return true;
  }
}

export function markOnboardingDone(): void {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    // Non-fatal; worst case the wizard shows again next launch.
  }
}

/**
 * Whether the wizard should open on launch: only on a genuinely fresh
 * install. An existing install (articles already generated, or app/provider
 * settings already saved, but no flag — i.e. a user from before onboarding
 * shipped) is marked done silently so they're never interrupted.
 */
export function shouldShowOnboarding(): boolean {
  if (isOnboardingDone()) return false;
  try {
    if (loadMyArticles().length > 0) {
      markOnboardingDone();
      return false;
    }
    if (
      localStorage.getItem("tc-news:app-settings") !== null ||
      localStorage.getItem("tc-news:provider-settings") !== null
    ) {
      markOnboardingDone();
      return false;
    }
  } catch {
    // Storage unavailable — treat as done so the wizard can't loop forever.
    return false;
  }
  return true;
}

// --- Re-open requests (settings screen -> app shell) ------------------------

const listeners = new Set<() => void>();

/** App shell subscribes once; returns an unsubscribe fn. */
export function subscribeOnboardingRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Asks the app shell to open the onboarding wizard (e.g. from settings). */
export function requestOnboarding(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn("onboarding: listener threw", error);
    }
  }
}
