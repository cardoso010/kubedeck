import { useEffect, useId, useRef, type ReactNode } from "react";

interface Props {
  /** Extra classes for the dialog box (`modal-wide`, `modal-large`, …). */
  className?: string;
  /** Accessible name; by default the dialog's first heading. */
  label?: string;
  /** Escape and a click outside call it; null for dialogs that must be closed by their buttons. */
  onClose: (() => void) | null;
  children: ReactNode;
}

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog: announced as one, focus moves in on open (to `[autofocus]` or the first
 * control), Tab stays inside, Escape and a click outside close it, and focus goes back to
 * where it was on close.
 */
export default function Modal({ className = "", label, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const headingId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!label) {
      const heading = dialog.querySelector("h1, h2, h3");
      if (heading) {
        heading.id ||= headingId;
        dialog.setAttribute("aria-labelledby", heading.id);
      }
    }
    (dialog.querySelector<HTMLElement>("[autofocus]") ?? dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog).focus();
    return () => previous?.focus();
  }, [label, headingId]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The YAML editors inside some dialogs use Escape (close a suggestion) and Tab (indent).
    if (e.defaultPrevented || (e.target as HTMLElement).closest(".monaco-editor")) return;
    if (e.key === "Escape" && onClose) {
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab" && ref.current) {
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div ref={ref} className={`modal ${className}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>
  );
}
