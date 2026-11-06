import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface PrintFrameProps {
  /** Iframe title (also the print job's document title). */
  title: string;
  isOpen: boolean;
  /** Called once after print() returns (or fails). The parent should then set isOpen=false. */
  onDone: () => void;
  children: ReactNode;
}

/**
 * Prints `children` through a hidden same-origin iframe (C4 receipts). No src (about:blank), sandboxed without
 * allow-scripts; the host page's stylesheets are cloned in so the kit/tokens apply. Prints once per opening.
 */
export function PrintFrame({ title, isOpen, onDone, children }: PrintFrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const printed = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;

  const attach = () => {
    const doc = frame.current?.contentDocument;
    if (!doc || doc.body === body) return;
    doc.title = title;
    for (const s of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) doc.head.appendChild(s.cloneNode(true));
    setBody(doc.body);
  };

  useEffect(() => {
    if (!isOpen) {
      printed.current = false;
      setBody(null);
      return;
    }
    attach();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !body || printed.current) return;
    // ponytail: one macrotask for layout; add an image-load wait if receipts ever carry images.
    const t = setTimeout(() => {
      printed.current = true;
      try {
        frame.current?.contentWindow?.focus();
        frame.current?.contentWindow?.print();
      } catch {
        // printer/dialog failure must not leave the caller stuck
      } finally {
        done.current();
      }
    }, 0);
    return () => clearTimeout(t);
  }, [isOpen, body]);

  if (!isOpen) return null;
  return (
    <>
      <iframe
        ref={frame}
        title={title}
        aria-hidden="true"
        tabIndex={-1}
        sandbox="allow-same-origin allow-modals"
        className="lims-printframe"
        onLoad={attach}
      />
      {body ? createPortal(children, body) : null}
    </>
  );
}
