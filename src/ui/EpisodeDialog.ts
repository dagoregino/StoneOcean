import { episodeSummary, type EpisodeLine, type HealthEpisode } from '../domain/episode';
import { EVENT_SOURCE_LABEL } from '../domain/missionLog';
import { openDialog } from './dialog';
import { h } from './dom';
import { download } from './download';
import { formatWhen } from './format';

const sourceTag = (source: EpisodeLine['source']): HTMLElement => h('span', { class: 'guide-source', dataset: { source } }, EVENT_SOURCE_LABEL[source]);

const SECTIONS: { key: 'subjective' | 'objective' | 'assessment' | 'plan'; letter: string; title: string; note: string; empty: string }[] = [
  { key: 'subjective', letter: 'S', title: 'Subjective', note: 'What the crew member reported', empty: 'Nothing was reported during this episode.' },
  { key: 'objective', letter: 'O', title: 'Objective', note: 'What was measured', empty: 'No measurement was recorded.' },
  { key: 'assessment', letter: 'A', title: 'Assessment', note: 'Status and triage from the onboard rules; not a diagnosis', empty: 'No assessment was recorded.' },
  { key: 'plan', letter: 'P', title: 'Plan', note: 'Actions, consultations and verification', empty: 'No action was recorded.' },
];

/** One episode as a SOAP note and a timeline, with the source of every line, and its export. */
export function openEpisodeRecord(episode: HealthEpisode): void {
  const file = `helios-${episode.id.toLowerCase()}-${episode.systemId}`;
  openDialog(
    `Episode record ${episode.id}`,
    [
      h(
        'div',
        { class: 'episode-head' },
        h('div', null, h('h3', null, episode.systemName), h('p', null, `Opened ${formatWhen(episode.startedAt)}${episode.closedAt !== undefined ? ` · closed ${formatWhen(episode.closedAt)}` : ''}`)),
        h('span', { class: 'badge', dataset: { status: episode.outcome === 'resolved' ? 'nominal' : 'caution' } }, episode.outcome === 'resolved' ? '● Closed · back to nominal' : '▲ Open'),
      ),
      h(
        'div',
        { class: 'episode-soap' },
        ...SECTIONS.map(({ key, letter, title, note, empty }) =>
          h(
            'section',
            { class: 'episode-section' },
            h('h4', null, h('span', { class: 'episode-letter', 'aria-hidden': 'true' }, letter), title, h('span', { class: 'episode-note' }, note)),
            episode[key].length === 0
              ? h('p', { class: 'empty' }, empty)
              : h('ul', { class: 'guide-lines' }, ...episode[key].map((line) => h('li', null, h('span', { class: 'guide-text' }, h('span', { class: 'episode-when' }, formatWhen(line.t)), line.text), sourceTag(line.source)))),
          ),
        ),
      ),
      h('h4', { class: 'episode-subhead' }, 'Episode timeline'),
      h(
        'ol',
        { class: 'episode-timeline' },
        ...episode.timeline.map((event) => h('li', { dataset: { kind: event.kind } }, h('span', { class: 'episode-when' }, formatWhen(event.t)), h('span', { class: 'guide-text' }, event.text), sourceTag(event.source))),
      ),
      h(
        'div',
        { class: 'guide-actions' },
        h('button', { class: 'button button-quiet', type: 'button', onclick: () => download(`${file}.txt`, episodeSummary(episode, formatWhen), 'text/plain') }, 'Export medical summary'),
        h('button', { class: 'button', type: 'button', onclick: () => download(`${file}.json`, JSON.stringify(episode, null, 2), 'application/json') }, 'Export JSON'),
      ),
    ],
    { wide: true, className: 'episode-dialog' },
  );
}
