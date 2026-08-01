"use client";

/**
 * AppShell — the outer chrome for every Voia screen.
 *
 * Owns three cross-cutting concerns:
 *  1. The active language (English / Español), mirrored into the vault draft
 *     whenever the vault happens to be unlocked.
 *  2. The explicit Lock control, which drops the in-memory vault key.
 *  3. The standing privacy banner, so the data-egress rules are always visible.
 *
 * It also exports the small hooks every other client component needs
 * (`useLanguage`, `useLocalProfile`, `useOnline`) so those helpers live in one
 * place instead of being re-implemented per screen.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { localProfile, touch, type LocalProfileState } from "@/lib/client/local-profile";
import type { Language } from "@/lib/shared/types";

/* ------------------------------------------------------------------ */
/* Language context                                                    */
/* ------------------------------------------------------------------ */

type LanguageContextValue = {
  language: Language;
  setLanguage: (next: Language) => void;
};

const LanguageContext = createContext<LanguageContextValue>({
  language: "en",
  setLanguage: () => {},
});

/** Active language plus a setter that also persists to the vault when unlocked. */
export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext);
}

/* ------------------------------------------------------------------ */
/* Local profile binding                                               */
/* ------------------------------------------------------------------ */

/** Server render has no vault: always the neutral loading snapshot. */
const serverSnapshot: LocalProfileState = {
  status: "loading",
  data: null,
  phoneHint: null,
  error: null,
};

export function useLocalProfile(): LocalProfileState {
  return useSyncExternalStore(
    localProfile.subscribe,
    localProfile.getSnapshot,
    () => serverSnapshot,
  );
}

/* ------------------------------------------------------------------ */
/* Connectivity                                                        */
/* ------------------------------------------------------------------ */

/** `navigator.onLine` with live `online` / `offline` updates. SSR-safe. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") return;
    const update = () => setOnline(navigator.onLine !== false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return online;
}

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

/**
 * The privacy banner. The English string is contractual product copy and is
 * rendered verbatim.
 */
const PRIVACY_BANNER: Record<Language, string> = {
  en: "Your profile and booking history are stored on this device. Data leaves this device only when you request an OTP, use AI assistance, search public providers, send an SMS receipt, or approve a booking request to a hospital.",
  es: "Su perfil y su historial de reservas se guardan en este dispositivo. Los datos salen de este dispositivo solo cuando solicita un código de verificación, usa la asistencia de IA, busca centros públicos, envía un recibo por SMS o aprueba una solicitud de cita a un hospital.",
};

const COPY = {
  en: {
    brandTagline: "by CoinOrigin",
    controls: "Session and language",
    languageLabel: "Language",
    english: "English",
    spanish: "Español",
    lock: "Lock",
    lockHint: "Lock this device's data",
    locked: "Locked",
    privacyHeading: "Privacy",
    offline: "You are offline. Local booking answers still save on this device; anything that needs the network will wait.",
    footerNote:
      "Voia is an appointment-booking assistant only — not a doctor, symptom checker, screener, or emergency service. In an emergency call your local emergency number.",
    footerLinks: "About this prototype",
  },
  es: {
    brandTagline: "por CoinOrigin",
    controls: "Sesión e idioma",
    languageLabel: "Idioma",
    english: "English",
    spanish: "Español",
    lock: "Bloquear",
    lockHint: "Bloquear los datos de este dispositivo",
    locked: "Bloqueado",
    privacyHeading: "Privacidad",
    offline: "Está sin conexión. Sus respuestas se guardan en este dispositivo; lo que necesite red esperará.",
    footerNote:
      "Voia es únicamente un asistente para solicitar citas: no es un médico, verificador de síntomas, examen de detección ni servicio de emergencia. En una emergencia llame a su número local de emergencias.",
    footerLinks: "Acerca de este prototipo",
  },
} as const;

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

export function AppShell({ children }: { children: ReactNode }) {
  const profile = useLocalProfile();
  const online = useOnline();
  const [language, setLanguageState] = useState<Language>("en");

  const vaultLanguage = profile.data?.draft.language ?? null;

  // Adopt the vault's language once it becomes readable.
  useEffect(() => {
    if (!vaultLanguage) return;
    setLanguageState((current) => (current === vaultLanguage ? current : vaultLanguage));
  }, [vaultLanguage]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    touch();
    setLanguageState(next);
    if (localProfile.getSnapshot().status !== "unlocked") return;
    void localProfile
      .update((current) => ({ ...current, draft: { ...current.draft, language: next } }))
      .catch(() => {
        // The in-memory language still switches; nothing else to surface.
      });
  }, []);

  const copy = COPY[language];
  const unlocked = profile.status === "unlocked";

  return (
    <LanguageContext.Provider value={{ language, setLanguage }}>
      <header className="site-header voia-header">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 5.5 12 19l8-13.5"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span>
            <strong>Voia</strong>
            <small>{copy.brandTagline}</small>
          </span>
        </span>

        <nav aria-label={copy.controls} className="voia-header-controls">
          <span className="language-select">
            <label htmlFor="voia-language">{copy.languageLabel}</label>
            <select
              id="voia-language"
              name="voia-language"
              value={language}
              onChange={(event) => setLanguage(event.target.value === "es" ? "es" : "en")}
            >
              <option value="en">{copy.english}</option>
              <option value="es">{copy.spanish}</option>
            </select>
          </span>

          <button
            type="button"
            onClick={() => localProfile.lock()}
            disabled={!unlocked}
            title={copy.lockHint}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect
                x="4.5"
                y="10.5"
                width="15"
                height="10"
                rx="2.5"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <path
                d="M8 10.5V8a4 4 0 1 1 8 0v2.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
            {unlocked ? copy.lock : copy.locked}
          </button>
        </nav>
      </header>

      <p className="prototype-banner voia-privacy-banner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 3.5 19 6v5.5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6l7-2.5Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </svg>
        <span>
          <span className="sr-only">{copy.privacyHeading}: </span>
          {PRIVACY_BANNER[language]}
        </span>
      </p>

      {!online ? (
        <p className="voia-offline-bar" role="status">
          {copy.offline}
        </p>
      ) : null}

      <main id="voia-main">{children}</main>

      <footer>
        <span className="brand footer-brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 5.5 12 19l8-13.5"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span>
            <strong>Voia</strong>
            <small>{copy.brandTagline}</small>
          </span>
        </span>
        <p>{copy.footerNote}</p>
        <div>
          <a href="#what-leaves-your-device">{copy.footerLinks}</a>
        </div>
      </footer>
    </LanguageContext.Provider>
  );
}

export default AppShell;
