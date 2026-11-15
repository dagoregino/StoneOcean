import type { HealthStore } from '../data/HealthStore';
import { STATUS_GLYPH, STATUS_LABEL } from '../domain/status';
import { SYSTEM_IDS, type SystemEvaluation } from '../domain/types';
import { h, setText, syncList } from './dom';
import { formatValue } from './format';

function summary(system: SystemEvaluation): string {
  const driver = system.driver;

  if (!driver?.latest) {
    return 'No data yet';
  }

  return `${driver.def.name}: ${formatValue(
    driver.latest.value,
    driver.def,
  )} ${driver.def.unit}`;
}

/**
 * Every body system with its live status, mirroring the 3D body.
 *
 * It behaves as a drawer over the left side of the 3D view.
 * It starts closed so the astronaut has the full stage available.
 *
 * Opening the drawer uses transforms instead of resizing the canvas.
 */
export class SystemList {
  private readonly list = h('div', {
    class: 'system-list',
  });

  private readonly toggle: HTMLButtonElement;

  /**
   * Body Systems starts closed by default.
   */
  private open = false;

  /**
   * @param parent
   * The drawer containing Body Systems.
   *
   * @param store
   * Current health state.
   *
   * @param toggleHost
   * Element where the button used to open the drawer is rendered.
   */
  constructor(
    private readonly parent: HTMLElement,
    private readonly store: HealthStore,
    toggleHost: HTMLElement,
  ) {
    /**
     * aria-controls requires an id.
     */
    parent.id ||= 'systems';

    /**
     * Floating button shown while the drawer is closed.
     */
    this.toggle = h(
      'button',
      {
        class: 'systems-toggle',
        type: 'button',
        'aria-controls': parent.id,
        'aria-expanded': 'false',
        'aria-label': 'Body systems',
        onclick: () => this.setOpen(!this.open),
      },

      h('span', {
        class: 'systems-toggle-icon',
        'aria-hidden': 'true',
      }),

      h(
        'span',
        {
          class: 'systems-toggle-label',
        },
        'Body systems',
      ),

      h('span', {
        class: 'systems-toggle-count',
        hidden: true,
      }),
    );

    /**
     * Put the open button beside / over the 3D viewport.
     */
    toggleHost.prepend(this.toggle);

    /**
     * Drawer content.
     */
    parent.append(
      h(
        'div',
        {
          class: 'systems-head',
        },

        h(
          'h2',
          {
            class: 'section-title',
          },
          'Body systems',
        ),

        h(
          'button',
          {
            class: 'icon-button',
            type: 'button',
            'aria-label': 'Hide body systems',
            title: 'Hide body systems',
            onclick: () => this.setOpen(false, true),
          },
          '×',
        ),
      ),

      this.list,
    );

    /**
     * ESC closes the drawer.
     */
    parent.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.setOpen(false, true);
      }
    });

    /**
     * Re-render when relevant store data changes.
     */
    const render = (): void => this.render();

    store.events.on('data', render);
    store.events.on('selection', render);
    store.events.on('hover', render);
    store.events.on('visibility', render);

    /**
     * Important:
     * Body Systems starts hidden.
     */
    this.setOpen(false);
  }

  /**
   * Opens or closes the Body Systems drawer.
   */
  private setOpen(
    open: boolean,
    returnFocus = false,
  ): void {
    this.open = open;

    this.parent.classList.toggle(
      'is-open',
      open,
    );

    /**
     * When hidden, prevent keyboard and accessibility navigation
     * from entering the invisible drawer.
     */
    this.parent.inert = !open;

    this.toggle.setAttribute(
      'aria-expanded',
      String(open),
    );

    /**
     * Can be used by CSS if the viewport needs different styling.
     */
    document
      .getElementById('app')
      ?.toggleAttribute(
        'data-systems-open',
        open,
      );

    this.render();

    if (open) {
      this.list
        .querySelector<HTMLElement>(
          '.system-main',
        )
        ?.focus({
          preventScroll: true,
        });
    } else if (returnFocus) {
      this.toggle.focus({
        preventScroll: true,
      });
    }
  }

  private render(): void {
    const { store } = this;

    const systems = SYSTEM_IDS.map(
      (id) =>
        store.evaluation.systems[id],
    );

    /**
     * Even while the drawer is closed,
     * show how many systems need attention.
     */
    const flagged = systems.filter(
      (system) =>
        system.status === 'caution' ||
        system.status === 'critical',
    );

    const count =
      this.toggle.querySelector<HTMLElement>(
        '.systems-toggle-count',
      );

    if (count) {
      count.hidden = flagged.length === 0;

      setText(
        count,
        String(flagged.length),
      );

      count.dataset.status =
        flagged.some(
          (system) =>
            system.status === 'critical',
        )
          ? 'critical'
          : 'caution';
    }

    /**
     * Accessibility label for collapsed state.
     */
    this.toggle.setAttribute(
      'aria-label',
      flagged.length > 0
        ? `Body systems: ${flagged.length} need attention`
        : 'Body systems',
    );

    /**
     * Performance optimization:
     * don't update all rows while the drawer is hidden.
     */
    if (!this.open) {
      return;
    }

    syncList(
      this.list,
      systems,

      /**
       * Unique key.
       */
      (system) => system.def.id,

      /**
       * Create each row.
       */
      (system) => {
        const id = system.def.id;

        return h(
          'div',
          {
            class: 'system-row',
          },

          h(
            'button',
            {
              class: 'system-main',
              type: 'button',

              onclick: () =>
                store.select(
                  store.selected === id
                    ? null
                    : id,
                ),

              onpointerenter: () =>
                store.hover(id),

              onpointerleave: () =>
                store.hover(null),
            },

            h('span', {
              class: 'status-glyph',
              'aria-hidden': 'true',
            }),

            h(
              'span',
              {
                class: 'system-text',
              },

              h(
                'span',
                {
                  class: 'system-name',
                },
                system.def.name,
              ),

              h('span', {
                class: 'system-summary',
              }),
            ),

            h('span', {
              class: 'system-status',
            }),
          ),

          /**
           * Toggle visibility of this body layer in 3D.
           */
          h(
            'button',
            {
              class: 'layer-toggle',
              type: 'button',

              onclick: () =>
                store.toggleVisibility(
                  id,
                ),
            },

            h('span', {
              'aria-hidden': 'true',
            }),
          ),
        );
      },

      /**
       * Update each existing row.
       */
      (element, system) => {
        const id = system.def.id;

        const hidden =
          store.hidden.has(id);

        element.dataset.status =
          system.status;

        element.classList.toggle(
          'is-selected',
          store.selected === id,
        );

        element.classList.toggle(
          'is-hovered',
          store.hovered === id,
        );

        element.classList.toggle(
          'is-hidden',
          hidden,
        );

        const mainButton =
          element.querySelector(
            '.system-main',
          );

        mainButton?.setAttribute(
          'aria-pressed',
          String(
            store.selected === id,
          ),
        );

        const statusGlyph =
          element.querySelector(
            '.status-glyph',
          );

        if (statusGlyph) {
          setText(
            statusGlyph,
            STATUS_GLYPH[
              system.status
            ],
          );
        }

        const summaryElement =
          element.querySelector(
            '.system-summary',
          );

        if (summaryElement) {
          setText(
            summaryElement,
            summary(system),
          );
        }

        const statusElement =
          element.querySelector(
            '.system-status',
          );

        if (statusElement) {
          setText(
            statusElement,
            STATUS_LABEL[
              system.status
            ],
          );
        }

        const visibilityToggle =
          element.querySelector(
            '.layer-toggle',
          );

        if (
          visibilityToggle instanceof
          HTMLButtonElement
        ) {
          visibilityToggle.setAttribute(
            'aria-pressed',
            String(!hidden),
          );

          visibilityToggle.setAttribute(
            'title',
            hidden
              ? `Show ${system.def.name} in 3D`
              : `Hide ${system.def.name} in 3D`,
          );

          visibilityToggle.setAttribute(
            'aria-label',
            hidden
              ? `Show ${system.def.name} layer`
              : `Hide ${system.def.name} layer`,
          );

          if (
            visibilityToggle.firstElementChild
          ) {
            setText(
              visibilityToggle.firstElementChild,
              hidden ? 'Off' : 'On',
            );
          }
        }
      },
    );
  }
}