import type { AppActions } from '../../app/actions';
import type { HealthStore } from '../../data/HealthStore';
import type { ResourceStore } from '../../data/resources/ResourceStore';
import type { Evaluation, IndicatorId, SystemId } from '../../domain/types';

/** What every tab of the side panel can see and ask for. */
export interface PanelContext {
  store: HealthStore;
  actions: AppActions;
  /** The medical inventory and crew roster, for the resource check on each protocol. */
  resources: ResourceStore;
  openResources(): void;
  /** The selected body system, or null for the whole crew member. */
  system: SystemId | null;
  /** The indicator the reader last opened, if any. */
  indicator: IndicatorId | null;
  openTrend(id: IndicatorId): void;
  openProtocol(id: IndicatorId): void;
  /** Back from one indicator to its whole body system. */
  openSystem(id: SystemId): void;
}

export interface PanelTab {
  readonly element: HTMLElement;
  update(evaluation: Evaluation): void;
  dispose(): void;
}
