import React from 'react';

export default function DataState(props) {
  if (!props.error && !props.loading) {
    return null;
  }

  return (
    <>
      {props.error ? <div className="notice notice--warning">{props.error}</div> : null}
      {props.loading ? <div className="state-block">{props.loadingMessage}</div> : null}
    </>
  );
}
