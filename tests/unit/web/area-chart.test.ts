import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// By relative path: the '@studio-pulse/ui' entry also loads stylesheets and assets.
import { AreaChart } from '../../../packages/ui/src/charts';
import type { AreaChartProps, AreaDatum } from '../../../packages/ui/src/charts';

const HOUR = 3_600_000;
const HEIGHT = 168; // the default plot height
const AXIS_LEFT = 44; // the y-axis gutter shared with ColumnChart

function point(index: number, value: number): AreaDatum {
  return {
    key: `2026-11-${String(index + 1).padStart(2, '0')}`,
    label: String(index + 1),
    value,
    tooltip: {
      title: `Nov ${index + 1}`,
      rows: [
        { id: 'active', label: 'Active', value: `${value / HOUR}h`, color: 'var(--sp-series-3)' },
        { id: 'idle', label: 'Idle', value: '5m' },
      ],
    },
  };
}

const WEEK = [1, 3, 0, 2, 1.5, 0, 0.5].map((hours, index) => point(index, hours * HOUR));

function render(props: Partial<AreaChartProps> & { data: AreaChartProps['data'] }): string {
  return renderToStaticMarkup(createElement(AreaChart, { width: 480, 'aria-label': 'Active time by day', ...props }));
}

/** Every element of one tag as its opening tag's text. */
const tags = (html: string, tag: string) => html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? [];
const attribute = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const root = (html: string) => tags(html, 'div')[0] ?? '';
const texts = (html: string) => [...html.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((match) => ({ attrs: match[1] ?? '', text: match[2] ?? '' }));
const labels = (html: string, className: string) =>
  texts(html)
    .filter((text) => text.attrs.includes(`class="${className}"`))
    .map((text) => text.text);

describe('AreaChart with data', () => {
  const html = render({ data: WEEK });

  it('is one labelled, focusable group; the drawing itself is hidden from assistive technology', () => {
    expect(attribute(root(html), 'class')).toBe('sp-area');
    expect(attribute(root(html), 'role')).toBe('group');
    expect(attribute(root(html), 'aria-label')).toBe('Active time by day. Use the arrow keys to step through the points.');
    expect(attribute(root(html), 'tabindex')).toBe('0');
    expect(attribute(root(html), 'data-empty')).toBeNull();
    expect(attribute(root(html), 'data-stale')).toBeNull();
    const svgs = tags(html, 'svg');
    expect(svgs).toHaveLength(1);
    expect(attribute(svgs[0] ?? '', 'aria-hidden')).toBe('true');
    expect(attribute(svgs[0] ?? '', 'width')).toBe('480');
    // A polite live region for the focused point's readout, silent until a point is focused.
    expect(html).toContain('<span class="sp-visually-hidden" aria-live="polite"></span>');
  });

  it('draws the series as exactly one line path over one wash path', () => {
    const paths = tags(html, 'path');
    expect(paths.filter((path) => attribute(path, 'class') === 'sp-area__line')).toHaveLength(1);
    expect(paths.filter((path) => attribute(path, 'class') === 'sp-area__wash')).toHaveLength(1);
    expect(paths).toHaveLength(2);
    // The wash is drawn first, so the line sits on top of it.
    expect(html.indexOf('sp-area__wash')).toBeLessThan(html.indexOf('sp-area__line'));
  });

  it('plots one point per bucket, in order, on a duration axis that starts at zero', () => {
    const line = attribute(tags(html, 'path').find((path) => attribute(path, 'class') === 'sp-area__line') ?? '', 'd') ?? '';
    const points = line
      .replace(/^M/, '')
      .split(' L')
      .map((pair) => pair.split(',').map(Number) as [number, number]);
    expect(points).toHaveLength(WEEK.length);
    // x: the middle of each bucket's band, left to right.
    const band = (480 - AXIS_LEFT) / WEEK.length;
    points.forEach(([x], index) => expect(x).toBeCloseTo(AXIS_LEFT + band * index + band / 2, 1));
    // y: 3 h is the top tick, so the largest value touches the top and zero sits on the baseline.
    expect(points.map(([, y]) => y)).toEqual([112, 0, 168, 56, 84, 168, 140]);

    // The wash closes down to the baseline under the first and last points.
    const wash = attribute(tags(html, 'path').find((path) => attribute(path, 'class') === 'sp-area__wash') ?? '', 'd') ?? '';
    expect(wash.startsWith(`M${points[0]?.[0]},${HEIGHT} L`)).toBe(true);
    expect(wash.endsWith(` L${points[6]?.[0]},${HEIGHT} Z`)).toBe(true);
  });

  it('labels the y-axis with durations and every bucket on the x-axis when they fit', () => {
    expect(labels(html, 'sp-area__ylabel')).toEqual(['0', '1h', '2h', '3h']);
    expect(labels(html, 'sp-area__xlabel')).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    // A grid line per tick above zero, and the baseline.
    expect(tags(html, 'line').filter((line) => attribute(line, 'class') === 'sp-area__grid')).toHaveLength(3);
    expect(tags(html, 'line').filter((line) => attribute(line, 'class') === 'sp-area__baseline')).toHaveLength(1);
  });

  it('shows no crosshair, point or tooltip until a point is hovered or focused', () => {
    expect(html).not.toContain('sp-area__crosshair');
    expect(html).not.toContain('sp-area__dot');
    expect(html).not.toContain('sp-chart-tip');
    expect(tags(html, 'rect').filter((rect) => attribute(rect, 'class') === 'sp-area__hit')).toHaveLength(1);
  });

  it('thins the x labels to fit the width, always keeping the first', () => {
    const month = render({ data: Array.from({ length: 30 }, (_, index) => point(index, HOUR)) });
    expect(labels(month, 'sp-area__xlabel')).toEqual(['1', '5', '9', '13', '17', '21', '25', '29']);
    const narrow = render({ data: Array.from({ length: 30 }, (_, index) => point(index, HOUR)), width: 120 });
    expect(labels(narrow, 'sp-area__xlabel')).toEqual(['1']);
  });

  it('takes its ticks and labels from the caller when given, and clamps values to the scale', () => {
    const custom = render({
      data: [point(0, -HOUR), point(1, 10 * HOUR), point(2, 2 * HOUR)],
      yTicks: [0, 2 * HOUR, 4 * HOUR],
      formatTick: (value) => `${value / HOUR} hrs`,
    });
    expect(labels(custom, 'sp-area__ylabel')).toEqual(['0 hrs', '2 hrs', '4 hrs']);
    const line = attribute(tags(custom, 'path').find((path) => attribute(path, 'class') === 'sp-area__line') ?? '', 'd') ?? '';
    // A negative value is drawn as zero, one above the top tick at the top.
    expect(line.replace(/^M/, '').split(' L').map((pair) => Number(pair.split(',')[1]))).toEqual([168, 0, 84]);
  });

  it('marks a single point with a dot (a one-point line draws nothing)', () => {
    const single = render({ data: [point(0, HOUR)] });
    expect(tags(single, 'circle').filter((circle) => attribute(circle, 'class') === 'sp-area__dot')).toHaveLength(1);
    expect(tags(single, 'path').filter((path) => attribute(path, 'class') === 'sp-area__line')).toHaveLength(1);
  });

  it('gives the plot height plus the axis band, whatever the data', () => {
    expect(attribute(root(html), 'style')).toBe('height:190px');
    expect(attribute(root(render({ data: WEEK, height: 100 })), 'style')).toBe('height:122px');
  });
});

describe('AreaChart without data', () => {
  const html = render({ data: [] });

  it('keeps the empty frame: axis, grid and baseline, no marks', () => {
    expect(attribute(root(html), 'data-empty')).toBe('true');
    expect(tags(html, 'svg')).toHaveLength(1);
    expect(tags(html, 'path')).toHaveLength(0);
    expect(tags(html, 'circle')).toHaveLength(0);
    expect(html).not.toContain('sp-area__hit');
    expect(labels(html, 'sp-area__ylabel')).toEqual(['0', '1h']);
    expect(labels(html, 'sp-area__xlabel')).toEqual([]);
    expect(tags(html, 'line').filter((line) => attribute(line, 'class') === 'sp-area__baseline')).toHaveLength(1);
    expect(html).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('is labelled but takes no focus and promises no keys', () => {
    expect(attribute(root(html), 'role')).toBe('group');
    expect(attribute(root(html), 'aria-label')).toBe('Active time by day');
    expect(attribute(root(html), 'tabindex')).toBeNull();
    expect(attribute(root(html), 'style')).toBe('height:190px'); // the same frame, so the layout does not jump
  });

  it('all-zero data is data: a flat line on the baseline', () => {
    const flat = render({ data: [point(0, 0), point(1, 0), point(2, 0)] });
    expect(attribute(root(flat), 'data-empty')).toBeNull();
    expect(attribute(root(flat), 'tabindex')).toBe('0');
    const line = attribute(tags(flat, 'path').find((path) => attribute(path, 'class') === 'sp-area__line') ?? '', 'd') ?? '';
    expect(line.replace(/^M/, '').split(' L').map((pair) => Number(pair.split(',')[1]))).toEqual([168, 168, 168]);
    expect(labels(flat, 'sp-area__ylabel')).toEqual(['0', '1h']);
  });
});

describe('AreaChart while refreshing', () => {
  it('stale keeps the frame and the marks, flagged for dimming', () => {
    const fresh = render({ data: WEEK });
    const stale = render({ data: WEEK, stale: true });
    expect(attribute(root(stale), 'data-stale')).toBe('true');
    expect(attribute(root(fresh), 'data-stale')).toBeNull();
    // Nothing else changes: the last result stays on screen.
    expect(stale.replace(' data-stale="true"', '')).toBe(fresh);
    expect(attribute(root(render({ data: [], stale: true })), 'data-stale')).toBe('true');
  });

  it('before its width is known it holds its place and its label, and draws nothing', () => {
    const unmeasured = renderToStaticMarkup(createElement(AreaChart, { data: WEEK, 'aria-label': 'Active time by day' }));
    expect(tags(unmeasured, 'svg')).toHaveLength(0);
    expect(attribute(root(unmeasured), 'style')).toBe('height:190px');
    expect(attribute(root(unmeasured), 'aria-label')).toMatch(/^Active time by day\./);
  });
});

describe('AreaChart colour', () => {
  const SERIES = 'var(--sp-series-3)';

  it('the series colour reaches the line and wash through one custom property, the neutral total by default', () => {
    const coloured = render({ data: WEEK, color: SERIES });
    expect(attribute(tags(coloured, 'svg')[0] ?? '', 'style')).toBe(`--c:${SERIES}`);
    expect(coloured.split(SERIES)).toHaveLength(2); // nowhere else in the markup
    expect(attribute(tags(render({ data: WEEK }), 'svg')[0] ?? '', 'style')).toBe('--c:var(--sp-viz-total)');
  });

  it('no text carries the series colour: labels are styled by class alone', () => {
    const coloured = render({ data: WEEK, color: SERIES });
    const all = texts(coloured);
    expect(all).toHaveLength(4 + 7);
    for (const text of all) {
      expect(text.attrs).toMatch(/class="sp-area__(x|y)label"/);
      expect(text.attrs).not.toMatch(/\b(style|fill|stroke|color)=/);
    }
  });

  it('the label classes use a text token, and only marks use the series colour', () => {
    const css = readFileSync(fileURLToPath(new URL('../../../packages/ui/src/charts.css', import.meta.url)), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' }));
    const labelRules = rules.filter((rule) => /\.sp-area__(x|y)label\b/.test(rule.selector));
    expect(labelRules.length).toBeGreaterThan(0);
    expect(labelRules.some((rule) => /fill:\s*var\(--sp-text-[a-z-]+\)/.test(rule.body))).toBe(true);
    for (const rule of labelRules) expect(rule.body).not.toMatch(/--c\b|--sp-series|--sp-viz-total/);
    // The series colour (`--c`) belongs to the line, the wash and the point.
    const coloured = rules.filter((rule) => /\.sp-area/.test(rule.selector) && /var\(--c\b/.test(rule.body)).map((rule) => rule.selector);
    expect(coloured.sort()).toEqual(['.sp-area__dot', '.sp-area__line', '.sp-area__wash']);
    // A 2px line and a ~10% wash.
    expect(rules.find((rule) => rule.selector === '.sp-area__line')?.body).toMatch(/stroke-width:\s*2;/);
    expect(rules.find((rule) => rule.selector === '.sp-area__wash')?.body).toMatch(/fill-opacity:\s*0\.1;/);
  });
});
