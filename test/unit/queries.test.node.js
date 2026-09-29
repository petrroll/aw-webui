const queries = require('~/queries');

// test data
const hostname = 'testhost';
const bid_window = 'aw-watcher-window_' + hostname;
const bid_afk = 'aw-watcher-afk_' + hostname;
const bid_browsers = [];
const filter_afk = true;
const always_active_pattern = /meow|nyaan|specials: \w(\\)/.toString().substring(1).slice(0, -1);
const queryParams = {
  bid_window,
  bid_afk,
  bid_browsers,
  filter_afk,
  categories: [],
  filter_categories: [],
  include_audible: true,
  always_active_pattern,
};

function expectBracketsClosed(query) {
  // Checks that there are matching parens, brackets, braces, etc
  // Doesn't actually check placement, just matching open/closed count.

  // parens
  const openParens = query.match(/\(/g);
  const closeParens = query.match(/\)/g);
  expect(openParens && openParens.length).toEqual(closeParens && closeParens.length);

  // brackets
  const openBrackets = query.match(/\[/g);
  const closeBrackets = query.match(/\]/g);
  expect(openBrackets && openBrackets.length).toEqual(closeBrackets && closeBrackets.length);

  // braces
  const openBraces = query.match(/\{/g);
  const closeBraces = query.match(/\}/g);
  expect(openBraces && openBraces.length).toEqual(closeBraces && closeBraces.length);
}

test('generate fullDesktopQuery', () => {
  let query = queries.fullDesktopQuery(queryParams).join('\n');
  expect(query).toMatchSnapshot();
  expectBracketsClosed(query);

});

test('materializes configured browser and stopwatch builtins from legacy bucket parameters', () => {
  const browser = 'aw-watcher-web-chrome_testhost';
  const stopwatch = 'aw-stopwatch';
  const query = queries
    .fullDesktopQuery({
      ...queryParams,
      bid_browsers: [browser],
      bid_stopwatch: stopwatch,
      capabilities: [
        'query.categorize_v2.v1',
        'query.merge_subwatcher_fields.source_namespace.v1',
      ],
      category_specs: [
        {
          id: 'browser',
          name: ['Browser'],
          rule: { type: 'regex', source: 'browser', field: 'url', regex: 'github' },
        },
      ],
      context_sources: [
        {
          source_id: 'browser',
          builtin: 'browser',
          bucket_ids: [],
          fields: ['url'],
        },
      ],
      activity_coverage_sources: [
        {
          source_id: 'stopwatch',
          builtin: 'stopwatch',
          bucket_ids: [],
          fields: ['label'],
        },
      ],
    })
    .join('\n');

  expect(query).toContain(browser);
  expect(query).toContain(stopwatch);
  expect(query).toContain('"source_id":"browser"');
  expect(query).toContain('"source_id":"stopwatch"');
  expectBracketsClosed(query);
});
