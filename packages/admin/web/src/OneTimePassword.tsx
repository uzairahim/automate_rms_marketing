import { useEffect, useState } from "react";
import type { IssuedCredential } from "./api.js";

/**
 * A generated password, shown the only time it will ever be shown.
 *
 * Everything here is in service of one thing: that the operator does not close
 * this before saving it. It says so in plain words rather than in a hint, it
 * offers a copy action so there is a one-click way to comply, and dismissing it
 * is an explicit act rather than something that happens on the next click
 * elsewhere. The password itself is selectable text, so a browser without
 * clipboard permission still leaves a way to get it out.
 *
 * `role="alert"` because this is the rare case where interrupting a screen
 * reader is right: the information is unrecoverable, and an operator who misses
 * being told so has cost their Client a login.
 */
export function OneTimePassword({
  credential,
  onDismiss,
}: {
  credential: IssuedCredential;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // A new credential is a new reveal — reset the copy state, or the second
  // password shown would arrive already claiming to have been copied.
  useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
  }, [credential.password]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(credential.password);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      // No clipboard permission, or an insecure context. Say so rather than
      // reporting success — the operator would otherwise paste the wrong thing
      // into the message that hands over an unrecoverable credential.
      setCopyFailed(true);
    }
  }

  return (
    <div className="reveal" role="alert">
      <p className="reveal-title">Password for {credential.user.email}</p>

      <div className="reveal-row">
        {/* `user-select: all` makes one click select the whole thing — the
            fallback for every browser where the copy button cannot work. */}
        <code className="reveal-secret">{credential.password}</code>
        <button type="button" className="button" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <p className="reveal-warning">
        This is the only time this password will be shown. It is not stored and cannot
        be retrieved later — save it now and pass it to the User directly. If it is
        lost, reset the password to issue a new one.
      </p>

      {copyFailed && (
        <p className="reveal-warning">
          Could not reach the clipboard. Select the password above and copy it manually.
        </p>
      )}

      <button type="button" className="linkbutton" onClick={onDismiss}>
        I have saved it — dismiss
      </button>
    </div>
  );
}
