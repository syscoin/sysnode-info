import React from 'react';

export default function ExternalButton(props) {
  return (
    <a
      className={props.className}
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {props.children}
    </a>
  );
}
