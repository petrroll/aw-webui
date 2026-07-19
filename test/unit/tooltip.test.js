import { buildTooltip } from '~/util/tooltip';

describe('buildTooltip', () => {
  test('renders fallback event data as wrapping-friendly key/value rows', () => {
    const tooltip = buildTooltip(
      { type: 'test' },
      {
        timestamp: '2026-07-19T21:16:37+02:00',
        duration: 241,
        data: {
          title: 'Away',
          availability: 'Away',
          metadata: { source: 'test' },
        },
      }
    );

    expect(tooltip).toContain('<th>title</th><td>Away</td>');
    expect(tooltip).toContain('<th>availability</th><td>Away</td>');
    expect(tooltip).toContain('<th>metadata</th><td>{"source":"test"}</td>');
    expect(tooltip).not.toContain('<th>Data</th>');
  });
});
