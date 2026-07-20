import type { IEvent } from '~/util/interfaces';
import { createMissingParents } from '~/util/classes';
import { getColorFromCategory } from '~/util/color';
import {
  categorySetToLegacyClasses,
  type CategorySetV2,
  type CompiledActivityQueryV2,
} from '~/util/rulesV2';
import { hostHasResolvedActivityV2 } from '~/util/activityProfile';
import type { IBucket } from '~/util/interfaces';

interface Interval {
  start: number;
  end: number;
}

interface TimelineBucket {
  hostname?: string;
  type?: string;
  events?: IEvent[];
  [key: string]: unknown;
}

interface TimelinePeriodFilterOptions {
  activeOnly: boolean;
  keepAfkBuckets: boolean;
}

export function hostCanResolveTimelineCategory(input: {
  host: string;
  buckets: IBucket[];
  compiledV2?: CompiledActivityQueryV2;
}): boolean {
  return input.compiledV2
    ? hostHasResolvedActivityV2(input.host, input.buckets, input.compiledV2)
    : false;
}

export function buildTimelineCategoryQuery(canonicalQuery: string): string {
  return (
    canonicalQuery +
    `
      category_events = events;
      RETURN = {"all": category_events, "active": not_afk};
    `
  );
}

export function buildTimelineCategoryColorResolver(
  categorySet: CategorySetV2
): (category: string[]) => string {
  const classes = createMissingParents(categorySetToLegacyClasses(categorySet));
  const classesByName = new Map(classes.map(category => [JSON.stringify(category.name), category]));
  return category => {
    const matched = classesByName.get(JSON.stringify(category));
    return getColorFromCategory(
      matched ?? { name: ['Uncategorized'], rule: { type: 'none' } },
      classes
    );
  };
}

function eventInterval(event: IEvent): Interval {
  const start = new Date(event.timestamp).getTime();
  return { start, end: start + event.duration * 1000 };
}

function sliceEvent(event: IEvent, start: number, end: number, inactive: boolean): IEvent {
  return {
    timestamp: new Date(start).toISOString(),
    duration: (end - start) / 1000,
    data: { ...event.data, $inactive: inactive },
  };
}

function sameCategorySlice(left: IEvent, right: IEvent): boolean {
  return (
    left.data.$inactive === right.data.$inactive &&
    left.data.$category_score === right.data.$category_score &&
    JSON.stringify(left.data.$category) === JSON.stringify(right.data.$category)
  );
}

function mergeAdjacentCategorySlices(events: IEvent[]): IEvent[] {
  return events
    .sort((left, right) => eventInterval(left).start - eventInterval(right).start)
    .reduce<IEvent[]>((merged, event) => {
      const previous = merged[merged.length - 1];
      if (!previous || !sameCategorySlice(previous, event)) {
        merged.push(event);
        return merged;
      }

      const previousInterval = eventInterval(previous);
      const interval = eventInterval(event);
      if (interval.start > previousInterval.end + 1) {
        merged.push(event);
        return merged;
      }

      previous.duration =
        (Math.max(previousInterval.end, interval.end) - previousInterval.start) / 1000;
      return merged;
    }, []);
}

export function splitCategoryEventsByActivity(
  categoryEvents: IEvent[],
  activeEvents: IEvent[]
): IEvent[] {
  const activeIntervals = activeEvents
    .map(eventInterval)
    .filter(interval => interval.end > interval.start)
    .sort((left, right) => left.start - right.start)
    .reduce<Interval[]>((merged, interval) => {
      const previous = merged[merged.length - 1];
      if (previous && interval.start <= previous.end) {
        previous.end = Math.max(previous.end, interval.end);
      } else {
        merged.push({ ...interval });
      }
      return merged;
    }, []);

  const slices: IEvent[] = [];
  let activeIndex = 0;
  const sortedCategoryEvents = [...categoryEvents].sort(
    (left, right) => eventInterval(left).start - eventInterval(right).start
  );

  for (const event of sortedCategoryEvents) {
    const interval = eventInterval(event);
    if (interval.end <= interval.start) continue;

    while (
      activeIndex < activeIntervals.length &&
      activeIntervals[activeIndex].end <= interval.start
    ) {
      activeIndex += 1;
    }

    const overlaps: Interval[] = [];
    for (
      let index = activeIndex;
      index < activeIntervals.length && activeIntervals[index].start < interval.end;
      index += 1
    ) {
      const active = activeIntervals[index];
      if (active.end > interval.start) {
        overlaps.push({
          start: Math.max(active.start, interval.start),
          end: Math.min(active.end, interval.end),
        });
      }
    }
    const eventSlices: IEvent[] = [];
    let cursor = interval.start;

    for (const active of overlaps) {
      if (active.start > cursor) {
        eventSlices.push(sliceEvent(event, cursor, active.start, true));
      }
      const activeStart = Math.max(cursor, active.start);
      if (active.end > activeStart) {
        eventSlices.push(sliceEvent(event, activeStart, active.end, false));
      }
      cursor = Math.max(cursor, active.end);
    }
    if (cursor < interval.end) {
      eventSlices.push(sliceEvent(event, cursor, interval.end, true));
    }
    slices.push(...eventSlices);
  }

  return mergeAdjacentCategorySlices(slices);
}

export function filterTimelineBucketsByPeriods(
  buckets: TimelineBucket[],
  categoryBuckets: TimelineBucket[],
  { activeOnly, keepAfkBuckets }: TimelinePeriodFilterOptions
): TimelineBucket[] {
  const periodsByHost = new Map<string | undefined, Interval[]>();
  for (const categoryBucket of categoryBuckets) {
    const periods = (categoryBucket.events ?? [])
      .filter(event => !activeOnly || event.data?.$inactive !== true)
      .map(eventInterval)
      .sort((left, right) => left.start - right.start)
      .reduce<Interval[]>((merged, period) => {
        const previous = merged[merged.length - 1];
        if (previous && period.start <= previous.end) {
          previous.end = Math.max(previous.end, period.end);
        } else {
          merged.push({ ...period });
        }
        return merged;
      }, []);
    periodsByHost.set(categoryBucket.hostname, periods);
  }

  return buckets.flatMap(bucket => {
    if (!periodsByHost.has(bucket.hostname)) return [bucket];
    if (bucket.type === 'afkstatus') return keepAfkBuckets ? [bucket] : [];
    const periods = periodsByHost.get(bucket.hostname) ?? [];
    let periodIndex = 0;
    const events = [...(bucket.events ?? [])]
      .sort((left, right) => eventInterval(left).start - eventInterval(right).start)
      .flatMap(event => {
        const interval = eventInterval(event);
        while (periodIndex < periods.length && periods[periodIndex].end <= interval.start) {
          periodIndex += 1;
        }
        const slices: IEvent[] = [];
        for (
          let index = periodIndex;
          index < periods.length && periods[index].start < interval.end;
          index += 1
        ) {
          const period = periods[index];
          if (period.end <= interval.start) continue;
          const start = Math.max(interval.start, period.start);
          const end = Math.min(interval.end, period.end);
          slices.push({
            ...event,
            timestamp: new Date(start).toISOString(),
            duration: (end - start) / 1000,
          });
        }
        return slices;
      });
    return [{ ...bucket, events }];
  });
}
