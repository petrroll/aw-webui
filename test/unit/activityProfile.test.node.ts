import {
  hostHasResolvedActivity,
  hostHasResolvedActiveTime,
} from '~/util/activityProfile';
import type { CompiledProfileQueryOptions } from '~/util/rulesV2';
import type { IBucket } from '~/util/interfaces';

function bucket(id: string, type: string, hostname: string): IBucket {
  return { id, type, hostname, device_id: hostname, data: {} } as IBucket;
}

function compiled(
  overrides: Partial<CompiledProfileQueryOptions> = {}
): CompiledProfileQueryOptions {
  return {
    category_specs: [],
    context_sources: [],
    activity_coverage_sources: [],
    activity_sources: [],
    background_sources: [],
    capabilities: [
      'query.categorize_v2.v1',
      'query.merge_subwatcher_fields.source_namespace.v1',
      'query.active_periods_v2.v1',
    ],
    legacy_window_mode: 'none',
    legacy_window_fields: ['app', 'title'],
    ...overrides,
  };
}

describe('activity profile availability', () => {
  const host = 'desktop';
  const windowBucket = bucket('aw-watcher-window_desktop', 'currentwindow', host);
  const afkBucket = bucket('aw-watcher-afk_desktop', 'afkstatus', host);
  const meetingBucket = bucket('aw-watcher-meeting_desktop', 'general.activity', host);

  test('an unconfigured window bucket is inert when no source references it', () => {
    // legacy_window_mode 'none' means the profile does not treat the window as
    // activity; mere discovery of the currentwindow bucket must contribute nothing.
    const options = compiled({ legacy_window_mode: 'none' });
    expect(hostHasResolvedActivity(host, [windowBucket], options)).toBe(false);
  });

  test('a meeting-only profile resolves activity without any window bucket', () => {
    const options = compiled({
      legacy_window_mode: 'none',
      activity_coverage_sources: [
        {
          source_id: 'meeting',
          bucket_ids: ['aw-watcher-meeting_desktop'],
          bucket_hosts: { 'aw-watcher-meeting_desktop': host },
          scope: 'host',
          fields: ['subject'],
        },
      ],
    });
    expect(hostHasResolvedActivity(host, [meetingBucket], options)).toBe(true);
    // Without the meeting bucket the same profile is inert (no window fallback).
    expect(hostHasResolvedActivity(host, [windowBucket], options)).toBe(false);
  });

  test('legacy availability is isolated to old servers without compiled options', () => {
    // No compiled options (old server): the legacy window activity default applies.
    expect(hostHasResolvedActivity(host, [windowBucket], undefined)).toBe(true);
    expect(hostHasResolvedActivity(host, [afkBucket], undefined)).toBe(false);
  });

  test('a simple compiled profile still resolves via the legacy window projection', () => {
    // Capability-gated fallback: when the window remains a legacy input
    // (legacy_window_mode 'activity'), the currentwindow bucket resolves activity.
    const options = compiled({ legacy_window_mode: 'activity' });
    expect(hostHasResolvedActivity(host, [windowBucket], options)).toBe(true);
  });

  test('active-time resolves from an explicit AFK source and legacy fallback', () => {
    const options = compiled({
      active_time_rule: { type: 'regex', source: 'afk', field: 'status', regex: 'not-afk' },
      active_time_sources: [
        {
          source_id: 'afk',
          bucket_ids: ['aw-watcher-afk_desktop'],
          bucket_hosts: { 'aw-watcher-afk_desktop': host },
          scope: 'host',
        },
      ],
    });
    expect(hostHasResolvedActiveTime(host, [afkBucket], options)).toBe(true);
    expect(hostHasResolvedActiveTime(host, [meetingBucket], options)).toBe(false);
    // Legacy active-time (no rule) falls back to the AFK bucket type.
    expect(hostHasResolvedActiveTime(host, [afkBucket], compiled())).toBe(true);
  });
});
