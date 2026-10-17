import React, { useEffect, useId, useRef } from 'react';

export default function VotingDialog({ title, onClose, children }) {
  const titleId = useId();
  const panel = useRef(null);
  const close = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    close.current?.focus();
    const keydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const controls = Array.from(panel.current?.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]') || []).filter((element) => !element.closest('[hidden]'));
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="vote-modal__backdrop" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <section className="vote-modal pali-vote" ref={panel}>
      <header className="vote-modal__header"><h2 id={titleId} className="vote-modal__title">{title}</h2><button ref={close} type="button" className="vote-modal__close" aria-label="Close vote dialog" onClick={onClose}>×</button></header>
      <div className="vote-modal__body">{children}</div>
    </section>
  </div>;
}
