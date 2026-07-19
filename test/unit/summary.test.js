import { buildSummaryTooltip } from '~/visualizations/summary';

describe('summary tooltips', () => {
  test('names the full category path when category color is available', () => {
    expect(
      buildSummaryTooltip({
        name: 'ActivityWatch',
        hovertext: 'ActivityWatch',
        duration: 3600,
        category: ['Work', 'Programming'],
      })
    ).toContain('Category: Work > Programming');
  });

  test('does not add a category label to non-category-colored entries', () => {
    expect(
      buildSummaryTooltip({
        name: 'ActivityWatch',
        hovertext: 'ActivityWatch',
        duration: 3600,
      })
    ).not.toContain('Category:');
  });
});
