"use client";

/**
 * LocalProfileGate — the whole auth / vault lifecycle.
 *
 * Flow, in order, for a device with no vault:
 *   phone (E.164) -> request OTP -> enter code -> verify
 *   -> privacy explanation + consents -> create unlock PIN -> vault created.
 *
 * For a device that already holds a vault:
 *   show the phone hint -> NEW phone OTP -> code + PIN -> unlock.
 *
 * PRIVACY / SAFETY RULES ENFORCED HERE:
 *  - The OTP value is never displayed, echoed, hinted at, or logged. The code
 *    input is write-only from the patient's side.
 *  - Errors are generic. We never distinguish "wrong PIN" from "no record".
 *  - Nothing is written outside the encrypted vault: no localStorage, no
 *    sessionStorage, no cookies.
 */

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { localProfile, touch, type LocalProfileState } from "@/lib/client/local-profile";
import { EMPTY_CONSENT, type ConsentState, type Language } from "@/lib/shared/types";
import { useLanguage, useOnline } from "./AppShell";

/** The server never has a vault, so it always renders the loading skeleton. */
const initialServerSnapshot: LocalProfileState = {
  status: "loading",
  data: null,
  phoneHint: null,
  error: null,
};

const E164 = /^\+[1-9]\d{6,14}$/;
const OTP_CODE = /^\d{4,10}$/;
const PIN_RULE = /^\d{6,}$/;

type NewVaultStep = "phone" | "code" | "privacy" | "pin";
type UnlockStep = "phone" | "verify";

const COPY = {
  en: {
    loading: "Preparing this device…",
    setupHeading: "Set up Voia on this device",
    setupIntro:
      "Voia keeps your booking details in an encrypted store inside this browser. Start by verifying the phone number a clinic would call.",
    phoneLabel: "Mobile phone number",
    phoneHelp: "International format, for example +12125551234.",
    phoneInvalid: "Enter a phone number in international format, e.g. +12125551234.",
    sendCode: "Send verification code",
    sending: "Sending…",
    codeHeading: "Enter your verification code",
    codeIntro:
      "We sent a code by text message. Voia never sees, stores, or displays that code — type it below.",
    codeLabel: "Verification code",
    codeHelp: "Numbers only, as they appear in your text message.",
    codeInvalid: "Enter the numeric code from your text message.",
    verify: "Verify",
    verifying: "Verifying…",
    resend: "Send a new code",
    changeNumber: "Use a different number",
    privacyHeading: "Before we save anything",
    privacyIntro:
      "You decide what Voia may do. Each choice below is separate and you can change it at any time from Privacy controls.",
    storedHeading: "Stored on this device only",
    storedItems: [
      "Your answers to the booking questions.",
      "Your booking history and what was sent for each request.",
      "Your consent choices.",
    ],
    leavesHeading: "Leaves this device only when you ask",
    leavesItems: [
      "A phone number, to send a verification code.",
      "Non-identifying booking state, if you turn on AI assistance.",
      "A specialty and coarse city, to search public provider listings.",
      "The booking packet you review and approve, sent to the hospital you pick.",
    ],
    consentCare: "Save my booking information in this device's encrypted store.",
    consentCareRequired: "Required — Voia cannot work without it.",
    consentCareHelp: "Nothing is uploaded to a Voia server. There is no Voia account.",
    consentAi: "Let Voia use Google's AI service to phrase the booking questions.",
    consentAiHelp:
      "Only non-identifying booking state is sent. Your health concern, name, phone, email, date of birth, and insurance details are never sent.",
    consentSms: "Send me a generic text message receipt when a request is sent.",
    consentSmsHelp: "The message contains no health details.",
    consentRequiredError: "Care-data consent is required to continue.",
    continue: "Continue",
    pinHeading: "Create an unlock PIN",
    pinIntro:
      "The PIN encrypts this device's store. It is never sent anywhere and is never stored — only you know it.",
    pinLabel: "Unlock PIN",
    pinHelp: "At least 6 digits.",
    pinConfirmLabel: "Confirm unlock PIN",
    pinInvalid: "Use at least 6 digits.",
    pinMismatch: "The two PINs do not match.",
    createVault: "Create my local store",
    creating: "Creating…",
    irreversible:
      "Warning: this is irreversible by design. If you clear this browser's site data or forget your PIN, the records on this device cannot be recovered — not by you and not by us.",
    lockedHeading: "Unlock this device",
    lockedIntro:
      "Your records are on this device, encrypted. Unlocking needs a fresh verification code and your PIN.",
    hintLabel: "Phone on file",
    unlock: "Unlock",
    unlocking: "Unlocking…",
    genericUnlock: "Unable to unlock. Check the code and PIN and try again.",
    genericSend: "We could not send a verification code right now. Please try again.",
    genericVerify: "That did not work. Please request a new code and try again.",
    genericCreate: "We could not set up local storage in this browser.",
    offline: "You are offline. Verification needs a network connection.",
    step: "Step",
    of: "of",
  },
  es: {
    loading: "Preparando este dispositivo…",
    setupHeading: "Configure Voia en este dispositivo",
    setupIntro:
      "Voia guarda sus datos de reserva cifrados dentro de este navegador. Comience verificando el teléfono al que llamaría una clínica.",
    phoneLabel: "Número de teléfono móvil",
    phoneHelp: "Formato internacional, por ejemplo +12125551234.",
    phoneInvalid: "Ingrese un teléfono en formato internacional, p. ej. +12125551234.",
    sendCode: "Enviar código de verificación",
    sending: "Enviando…",
    codeHeading: "Ingrese su código de verificación",
    codeIntro:
      "Enviamos un código por mensaje de texto. Voia nunca ve, guarda ni muestra ese código: escríbalo abajo.",
    codeLabel: "Código de verificación",
    codeHelp: "Solo números, como aparecen en su mensaje.",
    codeInvalid: "Ingrese el código numérico de su mensaje de texto.",
    verify: "Verificar",
    verifying: "Verificando…",
    resend: "Enviar un código nuevo",
    changeNumber: "Usar otro número",
    privacyHeading: "Antes de guardar nada",
    privacyIntro:
      "Usted decide qué puede hacer Voia. Cada opción es independiente y puede cambiarla en Controles de privacidad.",
    storedHeading: "Guardado solo en este dispositivo",
    storedItems: [
      "Sus respuestas a las preguntas de la reserva.",
      "Su historial de solicitudes y qué se envió en cada una.",
      "Sus decisiones de consentimiento.",
    ],
    leavesHeading: "Sale de este dispositivo solo si usted lo pide",
    leavesItems: [
      "Un número de teléfono, para enviar un código de verificación.",
      "Estado de reserva no identificable, si activa la asistencia de IA.",
      "Una especialidad y una ciudad aproximada, para buscar centros públicos.",
      "El paquete de reserva que usted revisa y aprueba, enviado al hospital que elija.",
    ],
    consentCare: "Guardar mi información de reserva cifrada en este dispositivo.",
    consentCareRequired: "Obligatorio: Voia no funciona sin esto.",
    consentCareHelp: "Nada se sube a un servidor de Voia. No existe una cuenta de Voia.",
    consentAi: "Permitir que Voia use el servicio de IA de Google para redactar las preguntas.",
    consentAiHelp:
      "Solo se envía estado de reserva no identificable. Su motivo de consulta, nombre, teléfono, correo, fecha de nacimiento y datos del seguro nunca se envían.",
    consentSms: "Enviarme un recibo genérico por mensaje de texto cuando se envíe una solicitud.",
    consentSmsHelp: "El mensaje no contiene detalles de salud.",
    consentRequiredError: "El consentimiento de datos de atención es obligatorio para continuar.",
    continue: "Continuar",
    pinHeading: "Cree un PIN de desbloqueo",
    pinIntro:
      "El PIN cifra el almacén de este dispositivo. Nunca se envía ni se guarda: solo usted lo conoce.",
    pinLabel: "PIN de desbloqueo",
    pinHelp: "Al menos 6 dígitos.",
    pinConfirmLabel: "Confirme el PIN",
    pinInvalid: "Use al menos 6 dígitos.",
    pinMismatch: "Los dos PIN no coinciden.",
    createVault: "Crear mi almacén local",
    creating: "Creando…",
    irreversible:
      "Advertencia: esto es irreversible por diseño. Si borra los datos del sitio en este navegador u olvida su PIN, los registros de este dispositivo no se pueden recuperar, ni por usted ni por nosotros.",
    lockedHeading: "Desbloquee este dispositivo",
    lockedIntro:
      "Sus registros están cifrados en este dispositivo. Para desbloquear necesita un código nuevo y su PIN.",
    hintLabel: "Teléfono registrado",
    unlock: "Desbloquear",
    unlocking: "Desbloqueando…",
    genericUnlock: "No se pudo desbloquear. Revise el código y el PIN e inténtelo de nuevo.",
    genericSend: "No pudimos enviar un código ahora mismo. Inténtelo de nuevo.",
    genericVerify: "No funcionó. Solicite un código nuevo e inténtelo otra vez.",
    genericCreate: "No pudimos configurar el almacenamiento local en este navegador.",
    offline: "Está sin conexión. La verificación necesita conexión de red.",
    step: "Paso",
    of: "de",
  },
} as const;

type Copy = (typeof COPY)[Language];

/** POST a JSON body and reduce every failure to a single generic message. */
async function postJson(path: string, body: unknown, fallbackMessage: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new Error(fallbackMessage);
  }
  if (!response.ok) {
    // Server messages are product-authored and never echo submitted values,
    // but we still fall back to our own generic copy if anything is missing.
    let message = fallbackMessage;
    try {
      const parsed: unknown = await response.json();
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { error?: unknown }).error === "string"
      ) {
        message = (parsed as { error: string }).error;
      }
    } catch {
      // Keep the generic message.
    }
    throw new Error(message);
  }
}

function GateShell({
  heading,
  intro,
  progress,
  children,
}: {
  heading: string;
  intro?: string;
  progress?: string;
  children: ReactNode;
}) {
  return (
    <section className="voia-gate" aria-labelledby="voia-gate-heading">
      <div className="voia-gate-card">
        {progress ? <p className="eyebrow">{progress}</p> : null}
        <h3 id="voia-gate-heading">{heading}</h3>
        {intro ? <p className="voia-gate-intro">{intro}</p> : null}
        {children}
      </div>
    </section>
  );
}

function Skeleton({ label }: { label: string }) {
  return (
    <section className="voia-gate" aria-labelledby="voia-gate-heading">
      <div className="voia-gate-card" aria-busy="true">
        <h3 id="voia-gate-heading">{label}</h3>
        <div className="voia-skeleton-stack" aria-hidden="true">
          <span className="voia-skeleton-line" />
          <span className="voia-skeleton-line short" />
          <span className="voia-skeleton-line" />
        </div>
        <p className="voia-status-line" role="status">
          {label}
        </p>
      </div>
    </section>
  );
}

export function LocalProfileGate({ children }: { children: ReactNode }) {
  const profile = useSyncExternalStore(
    localProfile.subscribe,
    localProfile.getSnapshot,
    () => initialServerSnapshot,
  );
  const { language } = useLanguage();
  const online = useOnline();
  const copy: Copy = COPY[language];

  const [newVaultStep, setNewVaultStep] = useState<NewVaultStep>("phone");
  const [unlockStep, setUnlockStep] = useState<UnlockStep>("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [consent, setConsent] = useState<ConsentState>({ ...EMPTY_CONSENT, careData: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void localProfile.init();
  }, []);

  const phoneValid = useMemo(() => E164.test(phone.trim()), [phone]);
  const codeValid = useMemo(() => OTP_CODE.test(code.trim()), [code]);
  const pinValid = useMemo(() => PIN_RULE.test(pin), [pin]);

  function reset(): void {
    setCode("");
    setPin("");
    setPinConfirm("");
    setError(null);
    setNotice(null);
  }

  async function sendCode(nextStep: () => void): Promise<void> {
    touch();
    setError(null);
    setNotice(null);
    if (!phoneValid) {
      setError(copy.phoneInvalid);
      return;
    }
    if (!online) {
      setError(copy.offline);
      return;
    }
    setBusy(true);
    try {
      await postJson("/api/auth/request-otp", { phone: phone.trim() }, copy.genericSend);
      setCode("");
      nextStep();
      setNotice(copy.codeIntro);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : copy.genericSend);
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode(): Promise<boolean> {
    if (!codeValid) {
      setError(copy.codeInvalid);
      return false;
    }
    if (!online) {
      setError(copy.offline);
      return false;
    }
    await postJson(
      "/api/auth/verify-otp",
      { phone: phone.trim(), code: code.trim() },
      copy.genericVerify,
    );
    return true;
  }

  /* ---------------- unlocked ---------------- */

  if (profile.status === "unlocked") {
    return <>{children}</>;
  }

  /* ---------------- loading ---------------- */

  if (profile.status === "loading") {
    return <Skeleton label={copy.loading} />;
  }

  /* ---------------- locked ---------------- */

  if (profile.status === "locked") {
    const hint = profile.phoneHint ? `•••• ${profile.phoneHint}` : "••••";

    return (
      <GateShell heading={copy.lockedHeading} intro={copy.lockedIntro}>
        <p className="voia-hint-row">
          <span>{copy.hintLabel}</span>
          <strong aria-label={`${copy.hintLabel} ${hint}`}>{hint}</strong>
        </p>

        <form
          className="registration-form"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            touch();
            if (unlockStep === "phone") {
              void sendCode(() => setUnlockStep("verify"));
              return;
            }
            setError(null);
            if (!pinValid) {
              setError(copy.pinInvalid);
              return;
            }
            setBusy(true);
            void (async () => {
              try {
                await verifyCode();
                await localProfile.unlock(pin);
                reset();
                setUnlockStep("phone");
              } catch {
                setError(copy.genericUnlock);
                setPin("");
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          <p className="field">
            <label htmlFor="voia-unlock-phone">{copy.phoneLabel}</label>
            <input
              id="voia-unlock-phone"
              name="voia-unlock-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+12125551234"
              value={phone}
              aria-describedby="voia-unlock-phone-help"
              aria-invalid={phone.length > 0 && !phoneValid}
              onChange={(event) => {
                touch();
                setPhone(event.target.value);
              }}
              disabled={busy}
            />
            <small id="voia-unlock-phone-help">{copy.phoneHelp}</small>
          </p>

          {unlockStep === "verify" ? (
            <>
              <p className="field">
                <label htmlFor="voia-unlock-code">{copy.codeLabel}</label>
                <input
                  id="voia-unlock-code"
                  name="voia-unlock-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  aria-describedby="voia-unlock-code-help"
                  aria-invalid={code.length > 0 && !codeValid}
                  onChange={(event) => {
                    touch();
                    setCode(event.target.value.replace(/\D+/g, ""));
                  }}
                  disabled={busy}
                />
                <small id="voia-unlock-code-help">{copy.codeHelp}</small>
              </p>

              <p className="field">
                <label htmlFor="voia-unlock-pin">{copy.pinLabel}</label>
                <input
                  id="voia-unlock-pin"
                  name="voia-unlock-pin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="current-password"
                  value={pin}
                  aria-describedby="voia-unlock-pin-help"
                  aria-invalid={pin.length > 0 && !pinValid}
                  onChange={(event) => {
                    touch();
                    setPin(event.target.value.replace(/\D+/g, ""));
                  }}
                  disabled={busy}
                />
                <small id="voia-unlock-pin-help">{copy.pinHelp}</small>
              </p>
            </>
          ) : null}

          {error ? (
            <span className="form-error" role="alert">
              {error}
            </span>
          ) : null}

          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? (
              <>
                <span className="button-spinner light" aria-hidden="true" />
                {unlockStep === "phone" ? copy.sending : copy.unlocking}
              </>
            ) : unlockStep === "phone" ? (
              copy.sendCode
            ) : (
              copy.unlock
            )}
          </button>

          {unlockStep === "verify" ? (
            <button
              type="button"
              className="text-button"
              onClick={() => void sendCode(() => setUnlockStep("verify"))}
              disabled={busy}
            >
              {copy.resend}
            </button>
          ) : null}
        </form>

        <p className="voia-warning" role="note">
          {copy.irreversible}
        </p>
      </GateShell>
    );
  }

  /* ---------------- no vault ---------------- */

  const stepIndex = { phone: 1, code: 2, privacy: 3, pin: 4 }[newVaultStep];
  const progress = `${copy.step} ${stepIndex} ${copy.of} 4`;

  if (newVaultStep === "phone") {
    return (
      <GateShell heading={copy.setupHeading} intro={copy.setupIntro} progress={progress}>
        <form
          className="registration-form"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void sendCode(() => setNewVaultStep("code"));
          }}
        >
          <p className="field">
            <label htmlFor="voia-phone">{copy.phoneLabel}</label>
            <input
              id="voia-phone"
              name="voia-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+12125551234"
              value={phone}
              aria-describedby="voia-phone-help"
              aria-invalid={phone.length > 0 && !phoneValid}
              onChange={(event) => {
                touch();
                setPhone(event.target.value);
              }}
              disabled={busy}
            />
            <small id="voia-phone-help">{copy.phoneHelp}</small>
          </p>

          {error ? (
            <span className="form-error" role="alert">
              {error}
            </span>
          ) : null}

          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? (
              <>
                <span className="button-spinner light" aria-hidden="true" />
                {copy.sending}
              </>
            ) : (
              copy.sendCode
            )}
          </button>
        </form>
      </GateShell>
    );
  }

  if (newVaultStep === "code") {
    return (
      <GateShell heading={copy.codeHeading} intro={copy.codeIntro} progress={progress}>
        <form
          className="registration-form"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            touch();
            setError(null);
            setBusy(true);
            void (async () => {
              try {
                await verifyCode();
                setNotice(null);
                setNewVaultStep("privacy");
              } catch (verifyError) {
                setError(verifyError instanceof Error ? verifyError.message : copy.genericVerify);
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          <p className="field">
            <label htmlFor="voia-code">{copy.codeLabel}</label>
            <input
              id="voia-code"
              name="voia-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              aria-describedby="voia-code-help"
              aria-invalid={code.length > 0 && !codeValid}
              onChange={(event) => {
                touch();
                setCode(event.target.value.replace(/\D+/g, ""));
              }}
              disabled={busy}
            />
            <small id="voia-code-help">{copy.codeHelp}</small>
          </p>

          {error ? (
            <span className="form-error" role="alert">
              {error}
            </span>
          ) : null}

          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? (
              <>
                <span className="button-spinner light" aria-hidden="true" />
                {copy.verifying}
              </>
            ) : (
              copy.verify
            )}
          </button>

          <span className="voia-button-row">
            <button
              type="button"
              className="text-button"
              onClick={() => void sendCode(() => setNewVaultStep("code"))}
              disabled={busy}
            >
              {copy.resend}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                touch();
                reset();
                setNewVaultStep("phone");
              }}
              disabled={busy}
            >
              {copy.changeNumber}
            </button>
          </span>
        </form>
        {notice ? (
          <p className="voia-status-line" role="status">
            {notice}
          </p>
        ) : null}
      </GateShell>
    );
  }

  if (newVaultStep === "privacy") {
    return (
      <GateShell heading={copy.privacyHeading} intro={copy.privacyIntro} progress={progress}>
        <div className="voia-privacy-grid">
          <section aria-labelledby="voia-stored-heading">
            <h4 id="voia-stored-heading">{copy.storedHeading}</h4>
            <ul>
              {copy.storedItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="voia-leaves-heading">
            <h4 id="voia-leaves-heading">{copy.leavesHeading}</h4>
            <ul>
              {copy.leavesItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        </div>

        <form
          className="registration-form"
          onSubmit={(event) => {
            event.preventDefault();
            touch();
            if (!consent.careData) {
              setError(copy.consentRequiredError);
              return;
            }
            setError(null);
            setNewVaultStep("pin");
          }}
        >
          <fieldset className="consent-panel">
            <legend className="sr-only">{copy.privacyHeading}</legend>

            <label htmlFor="voia-consent-care">
              <input
                id="voia-consent-care"
                name="voia-consent-care"
                type="checkbox"
                checked={consent.careData}
                onChange={(event) => {
                  touch();
                  setConsent((current) => ({ ...current, careData: event.target.checked }));
                }}
              />
              <span>
                <strong>{copy.consentCare}</strong> {copy.consentCareRequired}
                <br />
                {copy.consentCareHelp}
              </span>
            </label>

            <label htmlFor="voia-consent-ai">
              <input
                id="voia-consent-ai"
                name="voia-consent-ai"
                type="checkbox"
                checked={consent.googleAi}
                onChange={(event) => {
                  touch();
                  setConsent((current) => ({ ...current, googleAi: event.target.checked }));
                }}
              />
              <span>
                <strong>{copy.consentAi}</strong>
                <br />
                {copy.consentAiHelp}
              </span>
            </label>

            <label htmlFor="voia-consent-sms">
              <input
                id="voia-consent-sms"
                name="voia-consent-sms"
                type="checkbox"
                checked={consent.smsReceipt}
                onChange={(event) => {
                  touch();
                  setConsent((current) => ({ ...current, smsReceipt: event.target.checked }));
                }}
              />
              <span>
                <strong>{copy.consentSms}</strong>
                <br />
                {copy.consentSmsHelp}
              </span>
            </label>
          </fieldset>

          {error ? (
            <span className="form-error" role="alert">
              {error}
            </span>
          ) : null}

          <button type="submit" className="primary-button">
            {copy.continue}
          </button>
        </form>

        <p className="voia-warning" role="note">
          {copy.irreversible}
        </p>
      </GateShell>
    );
  }

  return (
    <GateShell heading={copy.pinHeading} intro={copy.pinIntro} progress={progress}>
      <form
        className="registration-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          touch();
          setError(null);
          if (!pinValid) {
            setError(copy.pinInvalid);
            return;
          }
          if (pin !== pinConfirm) {
            setError(copy.pinMismatch);
            return;
          }
          setBusy(true);
          void (async () => {
            try {
              await localProfile.create(phone.trim(), pin, consent, language);
              reset();
            } catch {
              setError(copy.genericCreate);
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <p className="field">
          <label htmlFor="voia-pin">{copy.pinLabel}</label>
          <input
            id="voia-pin"
            name="voia-pin"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={pin}
            aria-describedby="voia-pin-help"
            aria-invalid={pin.length > 0 && !pinValid}
            onChange={(event) => {
              touch();
              setPin(event.target.value.replace(/\D+/g, ""));
            }}
            disabled={busy}
          />
          <small id="voia-pin-help">{copy.pinHelp}</small>
        </p>

        <p className="field">
          <label htmlFor="voia-pin-confirm">{copy.pinConfirmLabel}</label>
          <input
            id="voia-pin-confirm"
            name="voia-pin-confirm"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={pinConfirm}
            aria-invalid={pinConfirm.length > 0 && pinConfirm !== pin}
            onChange={(event) => {
              touch();
              setPinConfirm(event.target.value.replace(/\D+/g, ""));
            }}
            disabled={busy}
          />
        </p>

        {error ? (
          <span className="form-error" role="alert">
            {error}
          </span>
        ) : null}

        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? (
            <>
              <span className="button-spinner light" aria-hidden="true" />
              {copy.creating}
            </>
          ) : (
            copy.createVault
          )}
        </button>
      </form>

      <p className="voia-warning" role="note">
        {copy.irreversible}
      </p>
    </GateShell>
  );
}

export default LocalProfileGate;
