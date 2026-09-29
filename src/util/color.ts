import _ from 'lodash';
import { Category } from './classes';
import Color from 'color';
import * as d3 from 'd3';
import { IEvent, IBucket } from './interfaces';

// See here for examples:
//   https://bl.ocks.org/pstuffa/3393ff2711a53975040077b7453781a9
//

const COLOR_UNCAT = '#CCC';

const scale = d3.scaleOrdinal(['#90CAF9', '#FFE082', '#EF9A9A', '#A5D6A7']);

// Needed to prewarm the color table
scale.domain(
  '0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20'.split(/, /)
);

const customColors = {
  afk: '#EEE',
  'not-afk': '#7F6',
  hibernating: '#DD6',

  'google-chrome': '#6AA7FE', // Google Blue: "#4885ed"
  chromium: '#8CF', // Google Blue: "#4885ed"
  firefox: '#F94', // Firefox Orange: "#E55B0A"
  spotify: '#5FA', // Spotify Green: "#1ED760"
  alacritty: '#FD8',

  vue: '#5d9', // Vue teal #4fc08d
  python: '#369', // Python blue #2b5b84
  javascript: '#f6b', // JavaScript pink #eb47a5

  // Developer domains
  localhost: '#CCC',
  'github.com': '#EBF',
  'stackoverflow.com': Color('#F48024').lighten(0.3),

  'google.com': '#0AF',
  'google.se': '#0AF',

  // Social media sites
  'messenger.com': Color('#3b5998').lighten(0.5),
  'facebook.com': Color('#3b5998').lighten(0.5),

  // Categories
  uncategorized: COLOR_UNCAT,
};

function hashcode(str: string): number {
  let hash = 0;
  if (str.length === 0) {
    return hash;
  }
  for (let i = 0; i < str.length; i++) {
    const character = str.charCodeAt(i);
    hash = (hash << 5) - hash + character;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
}

export function getColorFromString(appname: string): string {
  appname = appname || '';
  appname = appname.toLowerCase();
  return customColors[appname] || scale(Math.abs(hashcode(appname) % 20).toString());
}

// TODO: Move into vuex?
export function getColorFromCategory(c: Category, allCats: Category[]): string {
  // Returns the color for a certain category, falling back to parents if none set
  if (c && c.data && c.data.color) {
    return c.data.color;
  } else if (c && c.name.slice(0, -1).length > 0) {
    // If no color is set on category, traverse parents until one is found
    const parent = c.name.slice(0, -1);
    const parentCat = allCats.find(cc => _.isEqual(cc.name, parent));
    if (parentCat === undefined) {
      console.error("Couldn't find parent!", parent);
    }
    return getColorFromCategory(parentCat, allCats);
  } else {
    return COLOR_UNCAT;
  }
}

export function getTitleAttr(bucket: { type?: string }, e: IEvent) {
  if (bucket.type == 'currentwindow') {
    return e.data.app;
  } else if (bucket.type == 'web.tab.current') {
    const domainRegex = /^.+:\/\/(?:www.)?([^/]+)/;
    const match = e.data.url.match(domainRegex);
    return match ? match[1] : e.data.url;
  } else if (bucket.type == 'afkstatus') {
    return e.data.status;
  } else if (bucket.type?.startsWith('app.editor')) {
    return _.last(e.data.file.split('/'));
  } else if (bucket.type?.startsWith('general.stopwatch')) {
    return e.data.label;
  } else {
    const title = e.data.title;
    if (title && typeof title === 'string') {
      return title;
    }

    const keys = Object.keys(e.data);
    if (keys.length === 1) {
      const val = e.data[keys[0]];
      if (typeof val === 'string') {
        return val.length > 50 ? val.slice(0, 50) : val;
      }
    }

    return '';
  }
}

export function getRawColorFromEvent(bucket: IBucket, e: IEvent) {
  return getColorFromString(getTitleAttr(bucket, e));
}

export function getTimelineItemStyle(backgroundColor: string, afk: boolean): string {
  const borderColor = Color(backgroundColor).darken(0.3);
  if (!afk) {
    return `background-color: ${backgroundColor}; border-color: ${borderColor}`;
  }

  const mutedColor = Color(backgroundColor).desaturate(0.35).lighten(0.1);
  const hatch =
    'repeating-linear-gradient(135deg,' +
    'rgba(255,255,255,0.6) 0,rgba(255,255,255,0.6) 5px,' +
    'rgba(0,0,0,0.32) 5px,rgba(0,0,0,0.32) 11px)';
  return (
    `background-color: ${mutedColor}; background-image: ${hatch}; ` +
    `border-color: ${borderColor}; border-style: dashed; opacity: 0.5`
  );
}
