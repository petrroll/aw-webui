// Browser watcher bucket discovery and process-name matching shared by report
// projection and legacy audible-active-time materialization.

// Exact app names (Flatpak app IDs and similar reverse-domain identifiers) used
// as a fallback for names that do not match the broader patterns below.
export const browserAppNames: Record<string, string[]> = {
  chrome: ['com.google.Chrome', 'com.google.ChromeDev', 'org.chromium.Chromium'],
  firefox: ['org.mozilla.firefox', 'io.gitlab.librewolf-community', 'net.waterfox.waterfox'],
  opera: ['com.opera.Opera'],
  brave: ['com.brave.Browser'],
  edge: ['com.microsoft.Edge', 'com.microsoft.EdgeDev'],
  arc: [],
  vivaldi: ['com.vivaldi.Vivaldi'],
  orion: ['Orion'],
  yandex: ['ru.yandex.Browser'],
  zen: ['app.zen_browser.zen'],
  floorp: ['one.ablaze.floorp'],
  helium: ['net.imput.helium'],
};

// Case-insensitive regex patterns covering OS/platform process-name variants
// (Windows .exe, Linux lowercase, macOS capitalized, versioned names).
export const browserAppNameRegex: Record<string, string> = {
  chrome: '(?i)^(google[-_ ]?chrome|chrome|chromium)',
  firefox: '(?i)(firefox|librewolf|waterfox|nightly)',
  opera: '(?i)(opera)',
  brave: '(?i)(brave)',
  edge: '(?i)^(microsoft[-_ ]?edge|msedge)',
  arc: '(?i)^arc(\\.exe)?$',
  vivaldi: '(?i)(vivaldi)',
  orion: '(?i)(orion)',
  yandex: '(?i)(yandex)',
  zen: '(?i)(zen)',
  floorp: '(?i)(floorp)',
  helium: '(?i)(helium)',
};

// Return every recognized browser bucket. A browser can have several buckets
// (for example one per host/profile); callers must not silently select only the
// first one.
export function browsersWithBuckets(browserBucketIds: string[]): [string, string][] {
  return Object.keys(browserAppNames).flatMap(browserName =>
    browserBucketIds
      .filter(bucketId => bucketId.includes(browserName))
      .map(bucketId => [browserName, bucketId] as [string, string])
  );
}

// Keep same-family events together until overlap precedence has been resolved.
// Projecting each bucket first would replace original browser timestamps with
// coverage timestamps, making bucket order decide which tab wins.
export function browserFamiliesWithBuckets(browserBucketIds: string[]): [string, string[]][] {
  return Object.keys(browserAppNames).flatMap(browserName => {
    const bucketIds = browserBucketIds.filter(bucketId => bucketId.includes(browserName));
    return bucketIds.length > 0 ? [[browserName, bucketIds]] : [];
  });
}
