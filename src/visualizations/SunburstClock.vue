<template lang="pug">
div.sunburst
  div.sidebar
    div.legend

  div.main
    div.chart
      div.explanation
        div.base
          | {{ centerMsg }}
        div.hover(style="visibility: hidden")
          div.date
          div.title
          div.time
          div.duration
          div.data(style="text-overflow: ellipsis; white-space: nowrap; overflow: hidden;")
</template>

<style scoped lang="scss">
.sunburst {
  font-family: 'Open Sans', sans-serif;
  font-size: 12px;
  font-weight: 400;
  width: 100%;
  height: 620px;
  margin-top: 10px;

  .main {
    width: 750px;
    margin-right: auto;
    margin-left: auto;
  }

  .sidebar {
    float: left;
    height: 0;
    width: 100px;
  }

  .sequence {
    width: 600px;
    height: 70px;
  }

  .legend {
    padding: 10px 0 0 3px;
  }

  .sequence text,
  .legend text {
    font-weight: 600;
    fill: #fff;
  }

  .chart {
    position: relative;
  }

  .chart path {
    stroke: #fff;
  }

  .explanation {
    position: absolute;
    top: 260px;
    left: 305px;
    width: 140px;
    text-align: center;
    color: #666;
    z-index: 10; // might not be needed

    .base {
      color: #ddd;
      font-size: 2em;
    }

    .hover {
      .date {
        font-size: 0.8em;
      }

      .time {
        font-size: 1em;
      }

      .title {
        font-size: 2em;
        font-weight: bold;
      }

      .duration {
        font-size: 1em;
      }

      .data {
        font-size: 1em;
      }
    }
  }
}
</style>

<script>
import sunburst from './sunburst-clock';
import moment from 'moment';
import _ from 'lodash';
import { getClient } from '~/util/awclient';
import { useBucketsStore } from '~/stores/buckets';
import { useCategoryStore } from '~/stores/categories';
import { useSettingsStore } from '~/stores/settings';
import { queryStringToArray, resolveActivityProfile, serializeQueryJson } from '~/queries';
import { splitCategoryEventsByActivity } from '~/util/timelineCategories';

export default {
  name: 'aw-sunburst-clock',
  props: {
    date: { type: String },
    host: { type: String, required: true },
  },

  data: () => {
    return {
      starttime: moment(),
      endtime: moment(),
      centerMsg: 'Loading...',
    };
  },

  watch: {
    date: function (to) {
      this.starttime = moment(to);
      this.endtime = moment(this.starttime).add(1, 'days');
      this.visualize();
    },
  },
  mounted: function () {
    sunburst.create(this.$el);
    this.starttime = moment(this.date);
    this.endtime = moment(this.date).add(1, 'days');
    this.visualize();
  },

  methods: {
    resolvedEvents: async function () {
      const bucketsStore = useBucketsStore();
      const settingsStore = useSettingsStore();
      const categoryStore = useCategoryStore();
      const activeTime = settingsStore.rulesV2.activity_profiles_v2[0]?.active_time;
      const afkBucket =
        activeTime?.type === 'legacy' ? bucketsStore.bucketsAFK(this.host)[0] : undefined;
      const query =
        resolveActivityProfile({
          hostname: this.host,
          bid_window: bucketsStore.bucketsWindow(this.host)[0],
          bid_afk: bucketsStore.bucketsAFK(this.host)[0],
          bid_browsers: bucketsStore.bucketsBrowser(this.host),
          filter_afk: false,
          include_audible: activeTime?.type === 'legacy' ? activeTime.include_audible : undefined,
          always_active_pattern: settingsStore.always_active_pattern || undefined,
          categories: categoryStore.classes_for_query,
          filter_categories: null,
          ...settingsStore.compiledRulesV2,
        }) +
        (afkBucket
          ? `\nafk_status = flood(query_bucket(${serializeQueryJson(afkBucket)}));`
          : '\nafk_status = [];') +
        '\nRETURN = {"activity": events, "active": not_afk, "afk": afk_status};';
      const data = await getClient().query(
        [`${this.starttime.format()}/${this.endtime.format()}`],
        queryStringToArray(query)
      );
      return data[0] ?? { activity: [], active: [], afk: [] };
    },

    visualize: async function () {
      function buildHierarchy(parents, children) {
        parents = _.sortBy(parents, 'timestamp', 'desc');
        children = _.sortBy(children, 'timestamp', 'desc');

        let i_child = 0;
        for (let i_parent = 0; i_parent < parents.length; i_parent++) {
          const p = parents[i_parent];
          const p_start = moment(p.timestamp);
          const p_end = p_start.clone().add(p.duration, 'seconds');

          p.children = [];
          while (i_child < children.length) {
            const e = children[i_child];
            const e_start = moment(e.timestamp);
            const e_end = e_start.clone().add(e.duration, 'seconds');

            const before_parent = e_end.isBefore(p_start);
            const within_parent = e_start.isAfter(p_start) && e_end.isBefore(p_end);
            const after_parent = e_start.isAfter(p_end);

            // TODO: This isn't correct, yet
            if (before_parent) {
              // Child is behind parent
              //console.log("Too far behind: " + i_child);
              i_child++;
            } else if (within_parent) {
              //console.log("Added relation: " + i_child);
              p.children = _.concat(p.children, e);
              i_child++;
            } else if (after_parent) {
              // Child is ahead of parent
              //console.log("Too far ahead: " + i_child);
              break;
            } else {
              // TODO: Split events when this happens
              console.warn('Between parents');
              p.children = _.concat(p.children, e);
              i_child++;
            }
          }
        }

        // Build the root node
        //console.log(parents);
        const m_start = moment(_.first(parents).timestamp);
        const m_end = moment(_.tail(parents).timestamp);
        const duration = (m_end - m_start) / 1000;
        return {
          timestamp: _.first(parents).timestamp,
          // TODO: If we want a 12/24h clock, this has to change
          duration: duration,
          data: { title: 'ROOT' },
          children: parents,
        };
      }

      const { active, activity, afk } = await this.resolvedEvents();
      const parents =
        afk.length > 0
          ? afk
          : splitCategoryEventsByActivity(activity, active).map(event => ({
              ...event,
              data: { status: event.data.$inactive ? 'afk' : 'not-afk' },
            }));
      let hierarchy = null;
      if (parents.length > 0 && activity.length > 0) {
        hierarchy = buildHierarchy(parents, activity);
        this.centerMsg = 'Hover to inspect';
      } else {
        hierarchy = {
          timestamp: '',
          duration: 0,
          data: { title: 'ROOT' },
          children: [],
        };
        this.centerMsg = 'No data';
      }
      sunburst.update(this.$el, hierarchy, this.starttime);
    },
  },
};
</script>
