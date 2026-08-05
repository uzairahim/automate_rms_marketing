import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  getBranding,
  isSessionEnded,
  updateBranding,
  type Branding,
  type BrandingPatch,
} from "./api.js";

/**
 * A Client's white-label look — the logo, primary color, and name its own Users
 * see, including on the login screen before any of them has authenticated.
 *
 * Two things shape this screen. First, it edits from what is *live*: the form is
 * filled from the API rather than left blank, so an operator is changing values
 * they can see rather than guessing what is there. Second, every field can be
 * put back, which is why each row carries its own reset beside it — a Client
 * whose name was changed in error is restored to the neutral default without
 * anyone having to invent a replacement.
 *
 * Saving sends only the fields that actually changed. Restating the untouched
 * ones would silently overwrite a change made from another tab, and on this
 * screen that would land on a Client's front page.
 */

/** The form's own copy of the Branding, as strings a field can hold. */
interface Draft {
  appName: string;
  primaryColor: string;
  logoUrl: string;
}

/**
 * What the swatch shows for a value it cannot represent.
 *
 * A `<input type="color">` accepts only `#rrggbb`, and silently substitutes
 * black for anything else — so a half-typed hex in the text field beside it
 * would make the swatch lurch about. It sits on black until the value is a color
 * again, and the API is what refuses the bad value.
 */
const swatchValue = (color: string) => (/^#[0-9a-f]{6}$/i.test(color) ? color : "#000000");

const draftOf = (branding: Branding): Draft => ({
  appName: branding.appName,
  primaryColor: branding.primaryColor,
  // The one field with no default worth typing: an unset logo is an empty field.
  logoUrl: branding.logoUrl ?? "",
});

/**
 * What the draft changes about the loaded Branding, and nothing more.
 *
 * Every value is trimmed before it is compared, because the API trims before it
 * stores: without that, a stray trailing space would send a patch, come back
 * identical, and report "Saved" for a change nothing recorded.
 */
function patchFrom(draft: Draft, loaded: Branding): BrandingPatch {
  const patch: BrandingPatch = {};

  const appName = draft.appName.trim();
  if (appName !== loaded.appName) patch.appName = appName;

  const primaryColor = draft.primaryColor.trim();
  if (primaryColor.toLowerCase() !== loaded.primaryColor) patch.primaryColor = primaryColor;

  const logoUrl = draft.logoUrl.trim();
  if (logoUrl !== (loaded.logoUrl ?? "")) {
    // Emptying the field is how a logo is removed, so it means the same thing as
    // pressing its reset: back to no logo at all.
    patch.logoUrl = logoUrl === "" ? null : logoUrl;
  }
  return patch;
}

export function BrandingSection({
  clientId,
  subdomain,
  onSessionEnded,
}: {
  clientId: string;
  subdomain: string;
  onSessionEnded: () => void;
}) {
  /** What the API last told us this Client looks like. Never local optimism. */
  const [loaded, setLoaded] = useState<Branding | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getBranding(clientId)
      .then((branding) => {
        if (cancelled) return;
        setLoaded(branding);
        setDraft(draftOf(branding));
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (isSessionEnded(err)) onSessionEnded();
        else setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, onSessionEnded]);

  /**
   * Send a patch and adopt whatever Branding comes back as the new truth.
   *
   * Only the fields the patch actually named are re-read from the response.
   * Resetting one row is a single-field patch, and an operator who had already
   * typed a new name into another row would not expect pressing it to throw that
   * away — what they typed is theirs until they save or leave.
   */
  async function apply(patch: BrandingPatch): Promise<void> {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const branding = await updateBranding(clientId, patch);
      const applied = draftOf(branding);
      setLoaded(branding);
      setDraft((current) => {
        if (!current) return applied;
        return {
          appName: patch.appName !== undefined ? applied.appName : current.appName,
          primaryColor:
            patch.primaryColor !== undefined ? applied.primaryColor : current.primaryColor,
          logoUrl: patch.logoUrl !== undefined ? applied.logoUrl : current.logoUrl,
        };
      });
      setSaved(true);
    } catch (err) {
      if (isSessionEnded(err)) return onSessionEnded();
      setError(
        err instanceof ApiError ? err.message : "Could not save the Branding. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent): void {
    event.preventDefault();
    if (!draft || !loaded) return;
    const patch = patchFrom(draft, loaded);
    // Nothing changed: saying so beats a round trip the API would refuse.
    if (Object.keys(patch).length === 0) return setSaved(true);
    void apply(patch);
  }

  const edit = (field: keyof Draft, value: string) => {
    setSaved(false);
    setDraft((current) => (current ? { ...current, [field]: value } : current));
  };

  return (
    <section className="section">
      <h3 className="subsection-title">Branding</h3>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {!error && !draft && <p className="loading">Loading Branding…</p>}

      {draft && (
        <form className="card card-form" onSubmit={save}>
          <div className="field">
            <label htmlFor="app-name">App name</label>
            <div className="field-row">
              <input
                id="app-name"
                value={draft.appName}
                onChange={(e) => edit("appName", e.target.value)}
                disabled={busy}
                maxLength={80}
                required
              />
              {/* Each reset is its own immediate action rather than a value the
                  form holds: there is nothing for the operator to type, and
                  "back to the default" is a decision, not an edit. */}
              <button
                type="button"
                className="linkbutton"
                onClick={() => void apply({ appName: null })}
                disabled={busy}
              >
                Use the default
              </button>
            </div>
            <p className="hint">
              What the app calls itself at {subdomain} — in its header, and on the sign-in
              screen its Users see before they log in.
            </p>
          </div>

          <div className="field">
            <label htmlFor="primary-color">Primary color</label>
            <div className="field-row">
              {/* Two controls over one value: the swatch is how a color is
                  actually chosen, and the text is how a brand's exact hex is
                  pasted in from wherever the Client keeps it. */}
              <input
                type="color"
                className="swatch"
                aria-label="Pick the primary color"
                value={swatchValue(draft.primaryColor)}
                onChange={(e) => edit("primaryColor", e.target.value)}
                disabled={busy}
              />
              <input
                id="primary-color"
                value={draft.primaryColor}
                onChange={(e) => edit("primaryColor", e.target.value)}
                disabled={busy}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="#0f766e"
                required
              />
              <button
                type="button"
                className="linkbutton"
                onClick={() => void apply({ primaryColor: null })}
                disabled={busy}
              >
                Use the default
              </button>
            </div>
            <p className="hint">A #rrggbb hex value. The accent the Client's SPA is built around.</p>
          </div>

          <div className="field">
            <label htmlFor="logo-url">Logo URL</label>
            <div className="field-row">
              <input
                id="logo-url"
                type="url"
                value={draft.logoUrl}
                onChange={(e) => edit("logoUrl", e.target.value)}
                disabled={busy}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://cdn.example.com/logo.png"
              />
              <button
                type="button"
                className="linkbutton"
                onClick={() => void apply({ logoUrl: null })}
                disabled={busy}
              >
                Remove
              </button>
            </div>
            <p className="hint">
              An http(s) URL the Client hosts. Left empty, the app shows its name alone —
              which is the neutral default, and names nobody but the Client.
            </p>
          </div>

          <div className="form-actions">
            <button type="submit" className="button" disabled={busy}>
              {busy ? "Saving…" : "Save Branding"}
            </button>
            {saved && !busy && (
              <span role="status" className="subtle">
                Saved — the Client's next page load shows it.
              </span>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
