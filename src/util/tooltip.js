import moment from 'moment';
import { seconds_to_duration } from './time';
import DOMPurify from 'dompurify';
import _ from 'lodash';
import { i18n } from '~/i18n';

const sanitize = DOMPurify.sanitize;

function formatTooltipValue(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return 'undefined';
  }
  return JSON.stringify(value);
}

function buildDataRows(data) {
  const rows = Object.entries(data).map(
    ([key, value]) =>
      `<tr><th>${sanitize(key)}</th><td>${sanitize(formatTooltipValue(value))}</td></tr>`
  );
  return rows.length > 0 ? rows.join('') : '<tr><th>Data</th><td>{}</td></tr>';
}

export function buildTooltip(bucket, e) {
  // WARNING: XSS risk, make sure to sanitize properly
  // FIXME: Not actually tested against XSS attacks, implementation needs to be verified in tests.
  let inner = 'Unknown bucket type';

  // if same day, don't show date
  let start = moment(e.timestamp);
  let stop = moment(e.timestamp).add(e.duration, 'seconds');
  if (start.isSame(stop, 'day')) {
    start = start.format('HH:mm:ss');
    stop = stop.format('HH:mm:ss');
  } else {
    start = start.format('YYYY-MM-DD HH:mm:ss');
    stop = stop.format('YYYY-MM-DD HH:mm:ss');
  }

  if (bucket.type == 'currentwindow') {
    inner = `
      <tr><th>App</th><td>${sanitize(e.data.app)}</td></tr>
      <tr><th>Title</th><td>${sanitize(e.data.title)}</td></tr>
      `;
  } else if (bucket.type == 'web.tab.current') {
    inner = `
      <tr><th>Title</th><td>${sanitize(e.data.title)}</td></tr>
      <tr><th>URL</th><td><a href=${sanitize(e.data.url)}>${sanitize(e.data.url)}</a></td></tr>
      `;
  } else if (bucket.type.startsWith('app.editor')) {
    inner = `
      <tr><th>Filename</th><td>${sanitize(_.last(e.data.file.split('/')))}</td></tr>
      <tr><th>Path</th><td>${sanitize(e.data.file)}</td></tr>
      <tr><th>Language</th><td>${sanitize(e.data.language)}</td></tr>
      `;
  } else if (bucket.type.startsWith('general.stopwatch')) {
    inner = `
      <tr><th>Label</th><td>${sanitize(e.data.label)}</td></tr>
      `;
  } else if (bucket.type === 'category-result') {
    const category = Array.isArray(e.data.$category)
      ? e.data.$category.join(' > ')
      : 'Uncategorized';
    const activity = e.data.$inactive
      ? i18n.t('timeline.inactiveStatus')
      : i18n.t('timeline.activeStatus');
    inner = `
      <tr><th>Category</th><td>${sanitize(category)}</td></tr>
      <tr><th>Status</th><td>${sanitize(activity)}</td></tr>
      `;
  } else {
    inner = buildDataRows(e.data);
  }
  return `<table>
    <tr></tr>
    <tr><th>Start</th><td>${start}</td></tr>
    <tr><th>Stop</th><td>${stop}</td></tr>
    <tr><th>Duration&nbsp;</th><td>${seconds_to_duration(e.duration)}</td></tr>
    ${inner}
    </table>`;
}
