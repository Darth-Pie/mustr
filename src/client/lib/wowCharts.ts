/**
 * The Leveling page's two charts, drawn with Chart.js. This is the only file that
 * imports chart.js, and only the lazily loaded Leveling page imports it, so no
 * other route pays for the library. Only the pieces used are registered.
 *
 * Colours come from the theme's CSS variables, so the charts follow light/dark.
 * Clicking a name in the legend hides or shows that character (Chart.js default).
 */

import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartConfiguration,
} from 'chart.js';
import type { Bucketed } from './wowSeries';

Chart.register(LineController, LineElement, PointElement, BarController, BarElement, CategoryScale, LinearScale, Legend, Tooltip);

export interface LineStyle {
  characterId: number;
  label: string;
  color: string;
  dash: number[];
}

/** Dash patterns for characters that share a class colour, in turn. */
export const DASHES: number[][] = [[], [6, 4], [2, 3], [10, 3, 2, 3]];

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function baseOptions(stacked: boolean): ChartConfiguration['options'] {
  const muted = cssVar('--color-muted');
  const grid = cssVar('--color-border');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: cssVar('--color-text'), boxWidth: 10, boxHeight: 10, usePointStyle: true } },
      tooltip: {
        backgroundColor: cssVar('--color-surface'),
        borderColor: grid,
        borderWidth: 1,
        titleColor: cssVar('--color-text'),
        bodyColor: cssVar('--color-text'),
      },
    },
    scales: {
      x: { stacked, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 12 }, grid: { color: grid } },
      y: { stacked, ticks: { color: muted, precision: 0 }, grid: { color: grid } },
    },
  };
}

function lineData(data: Bucketed, styles: LineStyle[]) {
  return {
    labels: data.labels,
    datasets: styles.map((st) => ({
      label: st.label,
      data: data.lines.find((l) => l.characterId === st.characterId)?.levels ?? [],
      borderColor: st.color,
      backgroundColor: st.color,
      borderWidth: 2,
      borderDash: st.dash,
      pointRadius: 0,
      pointHoverRadius: 4,
      stepped: true as const,
      spanGaps: false,
    })),
  };
}

function barData(data: Bucketed, styles: LineStyle[]) {
  return {
    labels: data.labels,
    datasets: styles
      .map((st) => ({ st, gained: data.lines.find((l) => l.characterId === st.characterId)?.gained ?? [] }))
      .filter(({ gained }) => gained.some((g) => g > 0))
      .map(({ st, gained }) => ({ label: st.label, data: gained, backgroundColor: st.color, borderRadius: 2 })),
  };
}

export function renderLevelCharts(
  line: HTMLCanvasElement,
  bars: HTMLCanvasElement,
  data: Bucketed,
  styles: LineStyle[],
): { update(data: Bucketed): void; destroy(): void } {
  const lineChart = new Chart(line, { type: 'line', data: lineData(data, styles), options: baseOptions(false) });
  const barChart = new Chart(bars, { type: 'bar', data: barData(data, styles), options: baseOptions(true) });
  return {
    update(next) {
      lineChart.data = lineData(next, styles);
      barChart.data = barData(next, styles);
      lineChart.update();
      barChart.update();
    },
    destroy() {
      lineChart.destroy();
      barChart.destroy();
    },
  };
}
