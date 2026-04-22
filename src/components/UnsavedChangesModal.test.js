import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

import UnsavedChangesModal from './UnsavedChangesModal';

function renderModal(props = {}) {
  const handlers = {
    onSave: jest.fn(),
    onDiscard: jest.fn(),
    onCancel: jest.fn(),
  };
  const utils = render(
    <UnsavedChangesModal
      open={true}
      saving={false}
      error={null}
      {...handlers}
      {...props}
    />
  );
  return { ...utils, ...handlers };
}

describe('UnsavedChangesModal', () => {
  test('renders nothing when open=false', () => {
    const { queryByTestId } = render(
      <UnsavedChangesModal
        open={false}
        onSave={() => {}}
        onDiscard={() => {}}
        onCancel={() => {}}
      />
    );
    expect(queryByTestId('unsaved-modal')).toBeNull();
  });

  test('renders the three actions with correct semantics', () => {
    renderModal();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('unsaved-modal-save')).toBeInTheDocument();
    expect(screen.getByTestId('unsaved-modal-discard')).toBeInTheDocument();
    expect(screen.getByTestId('unsaved-modal-cancel')).toBeInTheDocument();
  });

  test('primary "Save to drafts" receives focus on open', () => {
    renderModal();
    expect(screen.getByTestId('unsaved-modal-save')).toHaveFocus();
  });

  test('clicking Save fires onSave (not onDiscard / onCancel)', () => {
    const { onSave, onDiscard, onCancel } = renderModal();
    fireEvent.click(screen.getByTestId('unsaved-modal-save'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('clicking Discard fires only onDiscard', () => {
    const { onSave, onDiscard, onCancel } = renderModal();
    fireEvent.click(screen.getByTestId('unsaved-modal-discard'));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('clicking Cancel fires only onCancel', () => {
    const { onSave, onDiscard, onCancel } = renderModal();
    fireEvent.click(screen.getByTestId('unsaved-modal-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  test('Escape key triggers Cancel', () => {
    const { onCancel } = renderModal();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('Escape key is swallowed while saving', () => {
    const { onCancel } = renderModal({ saving: true });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('clicking the overlay (outside the panel) fires Cancel', () => {
    const { onCancel } = renderModal();
    fireEvent.click(screen.getByTestId('unsaved-modal'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('clicking inside the panel does NOT fire Cancel', () => {
    const { onCancel } = renderModal();
    fireEvent.click(screen.getByText(/Save this draft/i));
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('saving=true disables all actions and shows "Saving…"', () => {
    renderModal({ saving: true });
    expect(screen.getByTestId('unsaved-modal-save')).toBeDisabled();
    expect(screen.getByTestId('unsaved-modal-save')).toHaveTextContent(/Saving/i);
    expect(screen.getByTestId('unsaved-modal-discard')).toBeDisabled();
    expect(screen.getByTestId('unsaved-modal-cancel')).toBeDisabled();
  });

  test('error prop is rendered in an alert region', () => {
    renderModal({ error: 'Save failed — try again.' });
    expect(screen.getByTestId('unsaved-modal-error')).toHaveTextContent(
      'Save failed — try again.'
    );
    expect(screen.getByTestId('unsaved-modal-error')).toHaveAttribute(
      'role',
      'alert'
    );
  });

  // Codex PR8 round 14 P2: Tab / Shift+Tab must be trapped within
  // the modal so keyboard users cannot escape to background
  // controls while an unsaved-changes decision is still pending.
  // We simulate the browser's Tab behavior manually (JSDOM doesn't
  // actually advance focus on a keydown event) by asserting that
  // preventDefault() is called on the wrapping boundaries.
  describe('keyboard focus trap', () => {
    test('Shift+Tab on the first focusable wraps backward to the last', () => {
      renderModal();
      const save = screen.getByTestId('unsaved-modal-save');
      const cancel = screen.getByTestId('unsaved-modal-cancel');
      // Save has focus on mount (verified by earlier test).
      expect(save).toHaveFocus();
      // Press Shift+Tab. The trap must preventDefault AND move
      // focus to Cancel (the last focusable).
      const e = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      const prevented = !window.dispatchEvent(e);
      expect(prevented).toBe(true);
      expect(cancel).toHaveFocus();
    });

    test('Tab on the last focusable wraps forward to the first', () => {
      renderModal();
      const save = screen.getByTestId('unsaved-modal-save');
      const cancel = screen.getByTestId('unsaved-modal-cancel');
      cancel.focus();
      expect(cancel).toHaveFocus();
      const e = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: false,
        bubbles: true,
        cancelable: true,
      });
      const prevented = !window.dispatchEvent(e);
      expect(prevented).toBe(true);
      expect(save).toHaveFocus();
    });

    test(
      'Tab from outside the panel is pulled back to the primary action',
      () => {
        // Render a background focusable BEFORE the modal so it is
        // DOM-prior and could otherwise steal focus.
        const bg = document.createElement('button');
        bg.id = 'bg-focusable';
        bg.textContent = 'outside';
        document.body.prepend(bg);
        try {
          renderModal();
          // Move focus outside the modal deliberately.
          bg.focus();
          expect(document.activeElement).toBe(bg);
          // Tab — trap must preventDefault AND pull focus back to
          // the first focusable inside the panel (Save).
          const e = new KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
          });
          const prevented = !window.dispatchEvent(e);
          expect(prevented).toBe(true);
          expect(screen.getByTestId('unsaved-modal-save')).toHaveFocus();
        } finally {
          bg.remove();
        }
      }
    );

    test('non-Tab keys are not intercepted by the trap', () => {
      renderModal();
      const save = screen.getByTestId('unsaved-modal-save');
      expect(save).toHaveFocus();
      const e = new KeyboardEvent('keydown', {
        key: 'a',
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(e);
      // Focus did not change (trap only cares about Tab).
      expect(save).toHaveFocus();
    });
  });
});
