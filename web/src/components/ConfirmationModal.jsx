import { useEffect } from "react";
import "./ConfirmationModal.css";

function ConfirmationModal({ open, title, message, confirmLabel, onConfirm, onCancel }) {
  useEffect(() => {
    if (!open) return undefined;

    const closeOnEscape = (event) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="confirmation-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirmation-modal-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="confirmation-modal__window" onMouseDown={(event) => event.stopPropagation()}>
        <h2 id="confirmation-modal-title">{title}</h2>
        <p>{message}</p>
        <div className="confirmation-modal__actions">
          <button type="button" className="confirmation-modal__confirm" onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button type="button" className="confirmation-modal__cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmationModal;