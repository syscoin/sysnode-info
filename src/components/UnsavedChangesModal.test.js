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
});
