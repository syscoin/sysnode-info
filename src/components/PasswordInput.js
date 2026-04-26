import React, { forwardRef, useState } from 'react';

const PasswordInput = forwardRef(function PasswordInput(
  { className = 'auth-input', ...props },
  ref
) {
  const [visible, setVisible] = useState(false);
  const label = visible ? 'Hide password' : 'Show password';

  return (
    <div className="password-input">
      <input
        {...props}
        ref={ref}
        className={className}
        type={visible ? 'text' : 'password'}
      />
      <button
        type="button"
        className="password-input__toggle"
        aria-label={label}
        aria-pressed={visible}
        title={label}
        onClick={() => setVisible((v) => !v)}
      >
        <svg
          aria-hidden="true"
          focusable="false"
          viewBox="0 0 24 24"
          width="20"
          height="20"
        >
          {visible ? (
            <>
              <path d="M3 3l18 18" />
              <path d="M10.6 10.7a2 2 0 0 0 2.7 2.7" />
              <path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c5.3 0 8.5 4.7 9.3 6.2a1.5 1.5 0 0 1 0 1.6 17 17 0 0 1-2.2 3" />
              <path d="M6.2 6.4a16.2 16.2 0 0 0-3.5 4.8 1.5 1.5 0 0 0 0 1.6C3.5 14.3 6.7 19 12 19a9.5 9.5 0 0 0 4-.9" />
            </>
          ) : (
            <>
              <path d="M2.7 11.2C3.5 9.7 6.7 5 12 5s8.5 4.7 9.3 6.2a1.5 1.5 0 0 1 0 1.6C20.5 14.3 17.3 19 12 19s-8.5-4.7-9.3-6.2a1.5 1.5 0 0 1 0-1.6Z" />
              <circle cx="12" cy="12" r="3" />
            </>
          )}
        </svg>
      </button>
    </div>
  );
});

export default PasswordInput;
