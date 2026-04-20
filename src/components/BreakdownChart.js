import React from 'react';
import { Doughnut } from 'react-chartjs-2';
import { ArcElement, Chart as ChartJS, Legend, Tooltip } from 'chart.js';

import { formatNumber } from '../lib/formatters';

ChartJS.register(ArcElement, Legend, Tooltip);

export default function BreakdownChart(props) {
  const chartData = {
    labels: props.items.map(function mapLabels(item) {
      return item.label;
    }),
    datasets: [
      {
        backgroundColor: props.items.map(function mapColors(item) {
          return item.color;
        }),
        borderColor: props.items.map(function mapBorderColors() {
          return '#ffffff';
        }),
        borderWidth: 5,
        data: props.items.map(function mapValues(item) {
          return item.value;
        }),
        hoverOffset: 6,
      },
    ],
  };

  const chartOptions = {
    cutout: '76%',
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        backgroundColor: '#ffffff',
        borderColor: 'rgba(44, 74, 117, 0.14)',
        borderWidth: 1,
        callbacks: {
          label: function labelCallback(context) {
            const item = props.items[context.dataIndex];
            return `${item.label}: ${item.valueLabel || formatNumber(item.value)}`;
          },
        },
        displayColors: false,
        titleColor: '#17253f',
        bodyColor: '#63748d',
      },
    },
  };

  return (
    <section className="panel breakdown-panel">
      <div className="panel__header">
        <div>
          <p className="eyebrow">{props.eyebrow || 'Breakdown'}</p>
        </div>
      </div>
      <div className="breakdown-panel__chart">
        <Doughnut data={chartData} options={chartOptions} />
        <div className="breakdown-panel__center">
          <strong>{props.centerValue}</strong>
          <span>{props.centerLabel}</span>
        </div>
      </div>
      <ul className="breakdown-panel__legend">
        {props.items.map(function renderItem(item) {
          return (
            <li key={item.label}>
              <span className="legend-swatch" style={{ backgroundColor: item.color }} />
              <div>
                <strong>{item.label}</strong>
                <span>{item.valueLabel || formatNumber(item.value)}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
