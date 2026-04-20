import React, { useState } from 'react';
import { Line } from 'react-chartjs-2';
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';

import { formatDateLabel, formatLongDate, formatNumber, sortHistory } from '../lib/formatters';

ChartJS.register(
  CategoryScale,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip
);

const RANGE_OPTIONS = [
  { id: '7d', label: '7D', days: 7 },
  { id: '30d', label: '30D', days: 30 },
  { id: '90d', label: '90D', days: 90 },
  { id: '180d', label: '180D', days: 180 },
  { id: '365d', label: '1Y', days: 365 },
  { id: 'all', label: 'All time' },
];

export default function TrendChart(props) {
  const [activeRange, setActiveRange] = useState(props.defaultRange || '30d');
  const orderedHistory = sortHistory(props.historyData);
  const selectedRange = RANGE_OPTIONS.find(function findRange(option) {
    return option.id === activeRange;
  });
  const cutoff = selectedRange && selectedRange.days
    ? Date.now() - selectedRange.days * 24 * 60 * 60 * 1000
    : null;
  const filteredHistory = orderedHistory.filter(function keepEntry(entry) {
    return !cutoff || new Date(entry.date).getTime() >= cutoff;
  });

  if (!filteredHistory.length) {
    return (
      <section className="panel panel--chart">
        <div className="panel__header">
          <div>
            <p className="eyebrow">{props.eyebrow || 'Trend'}</p>
          </div>
        </div>
        <div className="state-block">Trend history is not available right now.</div>
      </section>
    );
  }

  const chartData = {
    labels: filteredHistory.map(function mapLabels(entry) {
      return formatDateLabel(entry.date, activeRange);
    }),
    datasets: [
      {
        borderColor: '#1e78ff',
        backgroundColor: 'rgba(30, 120, 255, 0.14)',
        borderWidth: 3,
        data: filteredHistory.map(function mapValues(entry) {
          return Number(entry.users);
        }),
        fill: true,
        pointBackgroundColor: '#14b8a6',
        pointBorderColor: '#ffffff',
        pointBorderWidth: 2,
        pointHoverRadius: 6,
        pointRadius: filteredHistory.length > 60 ? 0 : 3,
        tension: 0.32,
      },
    ],
  };

  const chartOptions = {
    maintainAspectRatio: false,
    interaction: {
      intersect: false,
      mode: 'index',
    },
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
            return `${formatNumber(context.parsed.y)} nodes`;
          },
          title: function titleCallback(items) {
            const item = filteredHistory[items[0].dataIndex];
            return formatLongDate(item.date);
          },
        },
        displayColors: false,
        titleColor: '#17253f',
        bodyColor: '#63748d',
      },
    },
    scales: {
      x: {
        grid: {
          color: 'rgba(44, 74, 117, 0.08)',
        },
        ticks: {
          autoSkip: true,
          color: '#74839a',
          maxRotation: 0,
        },
      },
      y: {
        grid: {
          color: 'rgba(44, 74, 117, 0.08)',
        },
        ticks: {
          color: '#74839a',
          callback: function tickFormatter(value) {
            return formatNumber(value);
          },
        },
      },
    },
  };

  return (
    <section className="panel panel--chart">
      <div className="panel__header panel__header--stack">
        <div>
          <p className="eyebrow">{props.eyebrow || 'Trend'}</p>
        </div>
        <div className="range-switcher" aria-label="Node count history range">
          {RANGE_OPTIONS.map(function renderRange(option) {
            return (
              <button
                key={option.id}
                type="button"
                className={
                  option.id === activeRange
                    ? 'range-switcher__button is-active'
                    : 'range-switcher__button'
                }
                onClick={function handleRangeChange() {
                  setActiveRange(option.id);
                }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="chart-canvas">
        <Line data={chartData} options={chartOptions} />
      </div>
    </section>
  );
}
