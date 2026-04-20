import React from 'react';

export default function DefinitionGrid(props) {
  const className = props.className ? `definition-grid ${props.className}` : 'definition-grid';

  return (
    <div className={className}>
      {props.items.map(function renderItem(item) {
        return (
          <div key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        );
      })}
    </div>
  );
}
