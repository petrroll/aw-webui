import {
  buildTimelineCategoryColorResolver,
  buildTimelineCategoryQuery,
  filterTimelineBucketsByPeriods,
  splitCategoryEventsByActivity,
} from '~/util/timelineCategories';

describe('timeline category activity slices', () => {
  test('resolves configured and inherited colors from the canonical category set', () => {
    const categoryColor = buildTimelineCategoryColorResolver({
      schema_version: 2,
      id: 'default',
      categories: [
        {
          id: 'personal',
          name: ['Personal'],
          rule: { type: 'none' },
          data: { color: '#ed336a' },
        },
        {
          id: 'work',
          name: ['Work'],
          rule: { type: 'none' },
          data: { color: '#123456' },
        },
        {
          id: 'programming',
          name: ['Work', 'Programming'],
          rule: { type: 'none' },
        },
      ],
    });

    expect(categoryColor(['Personal'])).toBe('#ed336a');
    expect(categoryColor(['Work', 'Programming'])).toBe('#123456');
    expect(categoryColor(['Unknown'])).toBe('#CCC');
  });

  test('preserves category event timestamps instead of aggregating by category', () => {
    const query = buildTimelineCategoryQuery('events = categorize_v2(events, rules);');

    expect(query).toContain('category_events = events;');
    expect(query).toContain('"active": not_afk');
    expect(query).not.toContain('filter_period_intersect(category_events, not_afk)');
    expect(query).not.toContain('merge_events_by_keys');

    const result = splitCategoryEventsByActivity(
      [
        {
          timestamp: '2026-07-18T15:00:00Z',
          duration: 10,
          data: { $category: ['Personal'] },
        },
        {
          timestamp: '2026-07-18T19:00:00Z',
          duration: 10,
          data: { $category: ['Personal'] },
        },
      ],
      [
        {
          timestamp: '2026-07-18T15:00:00Z',
          duration: 10,
          data: { $category: ['Personal'] },
        },
        {
          timestamp: '2026-07-18T19:00:00Z',
          duration: 10,
          data: { $category: ['Personal'] },
        },
      ]
    );

    expect(result.map(event => event.timestamp)).toEqual([
      '2026-07-18T15:00:00.000Z',
      '2026-07-18T19:00:00.000Z',
    ]);
  });

  test('merges only adjacent slices with the same category and activity status', () => {
    const result = splitCategoryEventsByActivity(
      [
        {
          timestamp: '2026-07-18T15:00:00Z',
          duration: 10,
          data: { $category: ['Personal'] },
        },
        {
          timestamp: '2026-07-18T15:00:10Z',
          duration: 20,
          data: { $category: ['Personal'] },
        },
      ],
      [
        {
          timestamp: '2026-07-18T15:00:00Z',
          duration: 30,
          data: {},
        },
      ]
    );

    expect(result).toHaveLength(1);
    expect(result[0].duration).toBe(30);
  });

  test('marks the parts outside active periods as AFK', () => {
    const result = splitCategoryEventsByActivity(
      [
        {
          timestamp: '2026-07-18T12:00:00.000Z',
          duration: 60,
          data: { $category: ['Work'] },
        },
      ],
      [
        {
          timestamp: '2026-07-18T12:00:20.000Z',
          duration: 20,
          data: {},
        },
      ]
    );

    expect(result).toEqual([
      {
        timestamp: '2026-07-18T12:00:00.000Z',
        duration: 20,
        data: { $category: ['Work'], $inactive: true },
      },
      {
        timestamp: '2026-07-18T12:00:20.000Z',
        duration: 20,
        data: { $category: ['Work'], $inactive: false },
      },
      {
        timestamp: '2026-07-18T12:00:40.000Z',
        duration: 20,
        data: { $category: ['Work'], $inactive: true },
      },
    ]);
  });

  test('handles overlapping active periods without duplicating time', () => {
    const result = splitCategoryEventsByActivity(
      [
        {
          timestamp: '2026-07-18T12:00:00.000Z',
          duration: 60,
          data: { $category: ['Work'] },
        },
      ],
      [
        { timestamp: '2026-07-18T12:00:10.000Z', duration: 30, data: {} },
        { timestamp: '2026-07-18T12:00:30.000Z', duration: 20, data: {} },
      ]
    );

    expect(result.reduce((total, event) => total + event.duration, 0)).toBe(60);
    expect(result.filter(event => !event.data.$inactive)).toHaveLength(1);
  });

  test('clips every raw watcher row to canonical active periods', () => {
    const buckets = filterTimelineBucketsByPeriods(
      [
        {
          hostname: 'desktop',
          type: 'virtual-desktop',
          events: [
            {
              timestamp: '2026-07-18T12:00:00.000Z',
              duration: 60,
              data: { desktop: 'Personal' },
            },
          ],
        },
        {
          hostname: 'desktop',
          type: 'afkstatus',
          events: [{ timestamp: '2026-07-18T12:00:00.000Z', duration: 60, data: {} }],
        },
      ],
      [
        {
          hostname: 'desktop',
          type: 'category-result',
          events: [
            {
              timestamp: '2026-07-18T12:00:00.000Z',
              duration: 20,
              data: { $inactive: true },
            },
            {
              timestamp: '2026-07-18T12:00:20.000Z',
              duration: 20,
              data: { $inactive: false },
            },
          ],
        },
      ],
      { activeOnly: true, keepAfkBuckets: false }
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0].events).toEqual([
      {
        timestamp: '2026-07-18T12:00:20.000Z',
        duration: 20,
        data: { desktop: 'Personal' },
      },
    ]);
  });

  test('category filtering includes inactive category periods and keeps AFK rows', () => {
    const afkBucket = {
      hostname: 'desktop',
      type: 'afkstatus',
      events: [{ timestamp: '2026-07-18T12:00:00.000Z', duration: 60, data: {} }],
    };
    const buckets = filterTimelineBucketsByPeriods(
      [afkBucket],
      [
        {
          hostname: 'desktop',
          type: 'category-result',
          events: [
            {
              timestamp: '2026-07-18T12:00:00.000Z',
              duration: 20,
              data: { $inactive: true },
            },
          ],
        },
      ],
      { activeOnly: false, keepAfkBuckets: true }
    );

    expect(buckets).toEqual([afkBucket]);
  });
});
