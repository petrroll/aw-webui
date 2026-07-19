jest.mock('vue-chartjs/legacy', () => ({
  Bar: {},
}));
jest.mock('chart.js/auto', () => ({}));

import TimelineBarChart from '~/visualizations/TimelineBarChart.vue';

describe('TimelineBarChart tooltips', () => {
  function tooltipLabel(dataset) {
    const options = TimelineBarChart.computed.chartOptions.call({
      timeperiod_length: [1, 'day'],
    });
    return options.plugins.tooltip.callbacks.label({
      parsed: { y: 1.5 },
      dataset,
    });
  }

  test('names the category represented by a category-colored segment', () => {
    expect(tooltipLabel({ category: 'Work > Programming' })).toEqual([
      'Category: Work > Programming',
      '1:30',
    ]);
  });

  test('does not mislabel a non-category dataset as a category', () => {
    expect(tooltipLabel({ label: 'Total time' })).toBe('1:30');
  });
});
