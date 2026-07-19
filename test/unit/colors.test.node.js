const color = require('~/util/color');

const testClasses = [
  {
    name: ['Test', 'Subtest'],
    rule: { type: 'regex', pattern: 'subtest' },
    data: { color: '#F00' },
  },
  {
    name: ['Test', 'Subtest', 'Subsubtest'],
    rule: { type: 'regex', pattern: 'subsubtest' },
  },
];

test('returns parent category color as fallback', () => {
  const _color = color.getColorFromCategory(testClasses[1], testClasses);
  expect(_color).toEqual('#F00');
});

test('uses an unmistakable inline treatment for AFK timeline items', () => {
  const active = color.getTimelineItemStyle('#ed336a', false);
  const afk = color.getTimelineItemStyle('#ed336a', true);

  expect(active).toContain('background-color: #ed336a');
  expect(active).not.toContain('background-image');
  expect(active).not.toContain('opacity');
  expect(afk).toContain('background-image: repeating-linear-gradient');
  expect(afk).toContain('border-style: dashed');
  expect(afk).toContain('opacity: 0.5');
  expect(afk).not.toContain('background-color: #ed336a;');
});
