import type { ResourceStore } from '../../data/resources/ResourceStore';
import { conditionOf, findingsFor, freeUnits } from '../../domain/resources/findings';
import { CSV_TEMPLATE, type ImportResult } from '../../domain/resources/importing';
import { toTypeCode } from '../../domain/resources/inventory';
import { knownItemTypes, PROCEDURES, procedureName } from '../../domain/resources/protocols';
import {
  AVAILABILITY_LABEL,
  CATEGORY_LABEL,
  CREW_AVAILABILITY,
  GEAR_STATES,
  isStock,
  MOVEMENT_HELP,
  MOVEMENT_LABEL,
  MOVEMENT_TYPES,
  RESOURCE_CATEGORIES,
  STATE_LABEL,
  STOCK_STATES,
  TRAINING_LABEL,
  TRAINING_LEVELS,
  type Certification,
  type CrewAvailability,
  type CrewMember,
  type MovementType,
  type Resource,
  type ResourceCategory,
  type ResourceInput,
  type ResourceState,
  type TrainingLevel,
} from '../../domain/resources/types';
import { h } from '../dom';
import { confirmDialog, download, field, formatDate, formatDateTime, levelBadge, openDialog, qrCode, selectInput, showErrors, textInput, toast, type Field } from './kit';

const TYPE_LABELS = new Map(knownItemTypes().map((t) => [t.typeCode, t.label]));
/** A kind of item in words: the protocol's own name for it when it has one. */
export const typeLabel = (typeCode: string): string => TYPE_LABELS.get(typeCode) ?? typeCode.replace(/-/g, ' ');

const section = (title: string, ...fields: (Field | null)[]): HTMLElement =>
  h('fieldset', { class: 'res-form-section' }, h('legend', null, title), h('div', { class: 'res-form-grid' }, ...fields.map((f) => f?.element ?? null)));

// ---------- Register / edit a resource ----------

export function openResourceForm(store: ResourceStore, existing?: Resource, presetCategory?: ResourceCategory): void {
  const editing = Boolean(existing);
  let category: ResourceCategory = existing?.category ?? presetCategory ?? 'pharmaceutical';
  const value = <K extends keyof Resource>(key: K): string => (existing?.[key] === undefined || existing[key] === null ? '' : String(existing[key]));

  const categoryField = field('Category', selectInput(RESOURCE_CATEGORIES.map((c) => [c, CATEGORY_LABEL[c]] as const), category));
  categoryField.control.disabled = editing;
  const name = field('Name', textInput({ value: value('name'), maxLength: 80, required: true }));
  const typeList = h('datalist', { id: 'res-type-list' }, ...knownItemTypes().map((t) => h('option', { value: t.label })));
  const type = field('Kind of item', textInput({ value: existing ? typeLabel(existing.typeCode) : '', list: 'res-type-list', required: true }), {
    hint: 'Protocols look for resources by kind. Pick one from the list when it fits.',
  });
  const id = field('Identifier', textInput({ value: value('id'), placeholder: 'Assigned automatically', disabled: editing }), { optional: !editing, hint: editing ? undefined : 'Leave empty to get the next free one. It is also the QR code.' });
  const quantity = field(editing ? 'On board' : 'Quantity on board', textInput({ type: 'number', min: '0', step: '1', value: existing ? value('quantity') : '', disabled: editing, required: true }), {
    hint: editing ? 'The count only changes through a movement, so the history explains it.' : undefined,
  });
  const unit = field('Counted in', textInput({ value: value('unit'), placeholder: 'tablets, units, pairs…', required: true }));
  const minStock = field('Minimum stock', textInput({ type: 'number', min: '0', step: '1', value: value('minStock') }), { optional: true, hint: 'An alert appears at or below this.' });
  const location = field('Location', textInput({ value: value('location'), required: true }));
  const state = field('State', selectInput([]));
  const lot = field('Lot number', textInput({ value: value('lot') }), { optional: true });
  const expiresOn = field('Expiry date', textInput({ type: 'date', value: value('expiresOn') }), { optional: true });
  const storage = field('Storage conditions', textInput({ value: value('storage') }), { optional: true, span: true });
  const brand = field('Brand', textInput({ value: value('brand') }), { optional: true });
  const model = field('Model', textInput({ value: value('model') }), { optional: true });
  const batteryPct = field('Battery %', textInput({ type: 'number', min: '0', max: '100', step: '1', value: value('batteryPct') }), { optional: true, hint: 'Leave empty if it has no battery.' });
  const lastMaintenance = field('Last maintenance', textInput({ type: 'date', value: value('lastMaintenance') }), { optional: true });
  const nextMaintenance = field('Next maintenance', textInput({ type: 'date', value: value('nextMaintenance') }), { optional: true });
  const nextCalibration = field('Next calibration', textInput({ type: 'date', value: value('nextCalibration') }), { optional: true });
  const lastInspection = field('Last inspection', textInput({ type: 'date', value: value('lastInspection') }), { optional: true });
  const nextInspection = field('Next inspection', textInput({ type: 'date', value: value('nextInspection') }), { optional: true });
  const notes = field('Notes', h('textarea', { class: 'res-input', rows: 2, maxLength: 400 }, value('notes')), { optional: true, span: true });

  const stockSection = section('Lot and storage', lot, expiresOn, storage);
  const deviceSection = section('Device details', brand, model, batteryPct, lastMaintenance, nextMaintenance, nextCalibration);
  const emergencySection = section('Inspection', lastInspection, nextInspection);
  const summary = h('p', { class: 'res-form-summary', role: 'alert' });

  const applyCategory = (): void => {
    category = categoryField.control.value as ResourceCategory;
    const stock = isStock(category);
    const states: readonly ResourceState[] = stock ? STOCK_STATES : GEAR_STATES;
    const current = (state.control.value || existing?.state || states[0]) as ResourceState;
    state.control.replaceChildren(...states.map((s) => h('option', { value: s }, STATE_LABEL[s])));
    state.control.value = states.includes(current) ? current : states[0];
    stockSection.hidden = !stock;
    deviceSection.hidden = category !== 'device';
    emergencySection.hidden = category !== 'emergency';
    minStock.element.hidden = !stock;
    // Emergency gear can have a battery and a maker too; it borrows those fields.
    const gearHost = category === 'emergency' ? emergencySection.querySelector('.res-form-grid')! : deviceSection.querySelector('.res-form-grid')!;
    if (!stock) gearHost.prepend(brand.element, model.element, batteryPct.element);
  };
  categoryField.control.addEventListener('change', applyCategory);
  applyCategory();

  const fields: Record<string, Field> = { category: categoryField, name, typeCode: type, id, quantity, unit, minStock, location, state, lot, expiresOn, storage, brand, model, batteryPct, lastMaintenance, nextMaintenance, nextCalibration, lastInspection, nextInspection, notes };
  const read = (): ResourceInput => {
    const text = (f: Field): string => f.control.value.trim();
    const number = (f: Field): number | null => (text(f) === '' ? null : Number(text(f)));
    const typed = text(type);
    const known = knownItemTypes().find((t) => t.label.toLowerCase() === typed.toLowerCase());
    const stock = isStock(category);
    return {
      id: editing ? undefined : text(id) || undefined,
      category,
      name: text(name),
      typeCode: known?.typeCode ?? toTypeCode(typed),
      quantity: editing ? existing!.quantity : (number(quantity) ?? Number.NaN),
      unit: text(unit),
      minStock: stock ? number(minStock) : null,
      location: text(location),
      state: state.control.value as ResourceState,
      lot: stock ? text(lot) : undefined,
      expiresOn: stock ? text(expiresOn) : undefined,
      storage: stock ? text(storage) : undefined,
      brand: stock ? undefined : text(brand),
      model: stock ? undefined : text(model),
      batteryPct: stock ? undefined : number(batteryPct),
      lastMaintenance: category === 'device' ? text(lastMaintenance) : undefined,
      nextMaintenance: category === 'device' ? text(nextMaintenance) : undefined,
      nextCalibration: category === 'device' ? text(nextCalibration) : undefined,
      lastInspection: category === 'emergency' ? text(lastInspection) : undefined,
      nextInspection: category === 'emergency' ? text(nextInspection) : undefined,
      notes: text(notes),
    };
  };

  const form = h(
    'form',
    {
      class: 'res-form',
      noValidate: true,
      onsubmit: async (event: Event) => {
        event.preventDefault();
        try {
          const saved = editing ? await store.updateResource(existing!.id, read()) : await store.createResource(read());
          dialog.close();
          toast(editing ? `${saved.name} updated.` : `${saved.name} registered as ${saved.id}.`);
        } catch (error) {
          showErrors(error, fields, summary);
        }
      },
    },
    typeList,
    section('What it is', categoryField, name, type, id),
    section('Count and place', quantity, unit, minStock, location, state),
    stockSection,
    deviceSection,
    emergencySection,
    section('Notes', notes),
    summary,
    h(
      'div',
      { class: 'res-form-actions' },
      h('button', { class: 'button button-quiet', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      h('button', { class: 'button', type: 'submit' }, editing ? 'Save changes' : 'Register resource'),
    ),
  );
  const dialog = openDialog(editing ? `Edit ${existing!.name}` : 'Register a resource', [form], { wide: true });
  (editing ? name : categoryField).control.focus();
}

// ---------- Record a movement ----------

export function openMovementForm(store: ResourceStore, user: string, preset?: { resourceId?: string; type?: MovementType }): void {
  const active = store.activeResources.sort((a, b) => a.name.localeCompare(b.name));
  if (active.length === 0) {
    toast('Register a resource first.', 'error');
    return;
  }
  const resource = field('Resource', selectInput(active.map((r) => [r.id, `${r.name} · ${r.id}`] as const), preset?.resourceId ?? active[0].id));
  const type = field('Type of movement', selectInput(MOVEMENT_TYPES.filter((t) => t !== 'entry').map((t) => [t, MOVEMENT_LABEL[t]] as const), preset?.type ?? 'consumption'));
  const quantity = field('Quantity', textInput({ type: 'number', min: '1', step: '1', required: true }));
  const reason = field('Reason', textInput({ maxLength: 120, required: true, placeholder: 'Why this movement happened' }), { span: true });
  const notes = field('Notes', h('textarea', { class: 'res-input', rows: 2, maxLength: 400 }), { optional: true, span: true });
  const stockLine = h('p', { class: 'res-stock-line' });
  const typeHelp = h('p', { class: 'res-field-hint' });
  const summary = h('p', { class: 'res-form-summary', role: 'alert' });

  const describe = (): void => {
    const current = store.resource(resource.control.value);
    typeHelp.textContent = MOVEMENT_HELP[type.control.value as MovementType];
    if (!current) return;
    const condition = conditionOf(current, store.today);
    stockLine.replaceChildren(
      h('strong', null, `${freeUnits(current)} ${current.unit} free`),
      current.reserved > 0 ? ` · ${current.reserved} reserved · ${current.quantity} on board` : ` of ${current.quantity} on board`,
      ' ',
      levelBadge(condition.level, condition.label),
    );
  };
  resource.control.addEventListener('change', describe);
  type.control.addEventListener('change', describe);
  describe();

  const form = h(
    'form',
    {
      class: 'res-form',
      noValidate: true,
      onsubmit: async (event: Event) => {
        event.preventDefault();
        try {
          const movement = await store.recordMovement({
            resourceId: resource.control.value,
            type: type.control.value as MovementType,
            quantity: quantity.control.value.trim() === '' ? Number.NaN : Number(quantity.control.value),
            reason: reason.control.value,
            notes: notes.control.value,
          });
          dialog.close();
          toast(`${MOVEMENT_LABEL[movement.type]} recorded: ${movement.resourceName} now ${movement.balance.quantity} on board.`);
        } catch (error) {
          showErrors(error, { resourceId: resource, type, quantity, reason }, summary);
        }
      },
    },
    h('div', { class: 'res-form-grid' }, resource.element, type.element, h('div', { class: 'res-field res-field-span' }, stockLine, typeHelp), quantity.element, reason.element, notes.element),
    h('p', { class: 'res-field-hint' }, `Recorded as ${user}, with the current date and time. Movements cannot be edited or deleted afterwards.`),
    summary,
    h(
      'div',
      { class: 'res-form-actions' },
      h('button', { class: 'button button-quiet', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      h('button', { class: 'button', type: 'submit' }, 'Record movement'),
    ),
  );
  const dialog = openDialog('Record a movement', [form]);
  (preset?.resourceId ? quantity : resource).control.focus();
}

// ---------- Resource details ----------

export function openResourceDetail(store: ResourceStore, user: string, resourceId: string): void {
  const resource = store.resource(resourceId);
  if (!resource) return;
  const condition = conditionOf(resource, store.today);
  const findings = findingsFor(resource, store.today);
  const stock = isStock(resource.category);
  const fact = (label: string, value: string | null | undefined): HTMLElement | null => (value ? h('div', { class: 'res-fact' }, h('dt', null, label), h('dd', null, value)) : null);
  const history = store.movementsOf(resource.id);
  const reopen = (action: () => void): void => {
    dialog.close();
    action();
  };

  const dialog = openDialog(
    resource.name,
    [
      h(
        'div',
        { class: 'res-detail-top' },
        h(
          'div',
          { class: 'res-detail-main' },
          h('p', { class: 'res-detail-id' }, `${resource.id} · ${CATEGORY_LABEL[resource.category]}`, resource.simulated ? h('span', { class: 'res-sim-tag' }, 'Simulated') : null),
          h('p', { class: 'res-detail-count' }, h('strong', null, String(freeUnits(resource))), ` ${resource.unit} free`, resource.reserved > 0 ? ` · ${resource.reserved} reserved` : '', ` · ${resource.quantity} on board`),
          levelBadge(condition.level, condition.label),
          findings.length > 0 ? h('ul', { class: 'res-findings' }, ...findings.map((f) => h('li', { dataset: { level: f.level } }, f.message))) : null,
        ),
        h('div', { class: 'res-detail-qr' }, qrCode(resource.id), h('p', null, 'Scan to open this record')),
      ),
      h(
        'dl',
        { class: 'res-facts' },
        fact('Kind of item', typeLabel(resource.typeCode)),
        fact('Location', resource.location),
        fact('State set by crew', STATE_LABEL[resource.state]),
        stock ? fact('Minimum stock', resource.minStock === null ? 'Not tracked' : `${resource.minStock} ${resource.unit}`) : null,
        fact('Lot', resource.lot),
        resource.expiresOn ? fact('Expires', formatDate(resource.expiresOn)) : null,
        fact('Storage', resource.storage),
        fact('Brand and model', [resource.brand, resource.model].filter(Boolean).join(' ')),
        typeof resource.batteryPct === 'number' ? fact('Battery', `${resource.batteryPct}%`) : null,
        resource.lastMaintenance ? fact('Last maintenance', formatDate(resource.lastMaintenance)) : null,
        resource.nextMaintenance ? fact('Next maintenance', formatDate(resource.nextMaintenance)) : null,
        resource.nextCalibration ? fact('Next calibration', formatDate(resource.nextCalibration)) : null,
        resource.lastInspection ? fact('Last inspection', formatDate(resource.lastInspection)) : null,
        resource.nextInspection ? fact('Next inspection', formatDate(resource.nextInspection)) : null,
        fact('Notes', resource.notes),
      ),
      h(
        'div',
        { class: 'res-form-actions res-form-actions-start' },
        resource.active ? h('button', { class: 'button', type: 'button', onclick: () => reopen(() => openMovementForm(store, user, { resourceId: resource.id })) }, 'Record movement') : null,
        h('button', { class: 'button button-quiet', type: 'button', onclick: () => reopen(() => openResourceForm(store, resource)) }, 'Edit details'),
        h(
          'button',
          {
            class: 'button button-quiet',
            type: 'button',
            onclick: () =>
              resource.active
                ? confirmDialog(`Deactivate ${resource.name}?`, 'It will no longer count for protocols or alerts. The record and its full history are kept, and it can be reactivated.', 'Deactivate', async () => {
                    await store.setActive(resource.id, false);
                    dialog.close();
                    toast(`${resource.name} deactivated. Its history is kept.`);
                  })
                : void store.setActive(resource.id, true).then(() => {
                    dialog.close();
                    toast(`${resource.name} is active again.`);
                  }),
          },
          resource.active ? 'Deactivate' : 'Reactivate',
        ),
      ),
      h('h3', { class: 'res-subhead' }, `History (${history.length})`),
      history.length === 0
        ? h('p', { class: 'empty' }, 'No movements recorded.')
        : h(
            'div',
            { class: 'res-table-wrap' },
            h(
              'table',
              { class: 'res-table res-table-compact' },
              h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Movement'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'On board after'), h('th', null, 'By'), h('th', null, 'Reason'))),
              h(
                'tbody',
                null,
                ...history.map((m) =>
                  h('tr', null, h('td', null, formatDateTime(m.at)), h('td', null, MOVEMENT_LABEL[m.type]), h('td', { class: 'num' }, String(m.quantity)), h('td', { class: 'num' }, String(m.balance.quantity)), h('td', null, m.user), h('td', null, m.reason, m.notes ? h('span', { class: 'res-note' }, ` — ${m.notes}`) : null)),
                ),
              ),
            ),
          ),
    ],
    { wide: true },
  );
}

// ---------- Find by code / scan ----------

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike;

export function openScanDialog(store: ResourceStore, user: string): void {
  const code = field('Identifier or QR content', textInput({ placeholder: 'MED-0001', autocomplete: 'off', autocapitalize: 'characters' }), {
    hint: 'Type the identifier printed under the QR code, or use a handheld scanner: it types the code here and presses Enter.',
  });
  const result = h('p', { class: 'res-form-summary', role: 'alert' });
  const video = h('video', { class: 'res-scan-video', hidden: true, playsInline: true, muted: true });
  let stream: MediaStream | null = null;
  let scanning = false;
  const stop = (): void => {
    scanning = false;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.hidden = true;
  };
  const lookup = (value: string): boolean => {
    const found = store.findByCode(value);
    if (!found) {
      result.textContent = value.trim() ? `No resource is registered as “${value.trim()}”.` : 'Enter an identifier.';
      return false;
    }
    stop();
    dialog.close();
    openResourceDetail(store, user, found.id);
    return true;
  };

  const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  const cameraButton = h(
    'button',
    {
      class: 'button button-quiet',
      type: 'button',
      onclick: async () => {
        if (scanning) return stop();
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
          video.srcObject = stream;
          video.hidden = false;
          await video.play();
          scanning = true;
          const detector = new Detector!({ formats: ['qr_code'] });
          const tick = async (): Promise<void> => {
            if (!scanning) return;
            const codes = await detector.detect(video).catch(() => []);
            if (codes[0] && lookup(codes[0].rawValue)) return;
            window.setTimeout(tick, 250);
          };
          void tick();
        } catch {
          stop();
          result.textContent = 'The camera could not be used. Type the identifier instead.';
        }
      },
    },
    'Use the camera',
  );
  const camera = Detector && navigator.mediaDevices
    ? cameraButton
    : h('p', { class: 'res-field-hint' }, 'Camera scanning is not available in this browser. Typing the identifier, or a handheld scanner, works everywhere.');

  const dialog = openDialog(
    'Find a resource by its code',
    [
      h(
        'form',
        {
          class: 'res-form',
          onsubmit: (event: Event) => {
            event.preventDefault();
            lookup(code.control.value);
          },
        },
        code.element,
        result,
        video,
        h('div', { class: 'res-form-actions res-form-actions-start' }, h('button', { class: 'button', type: 'submit' }, 'Find'), camera),
      ),
    ],
    { onClose: stop },
  );
  code.control.focus();
}

// ---------- Import ----------

export function openImportDialog(store: ResourceStore): void {
  let preview: ImportResult | null = null;
  const file = h('input', { type: 'file', class: 'res-input', accept: '.csv,.json,text/csv,application/json', 'aria-label': 'Inventory file' });
  const report = h('div', { class: 'res-import-report' });
  const importButton = h('button', { class: 'button', type: 'button', disabled: true }, 'Import');

  file.addEventListener('change', async () => {
    const chosen = file.files?.[0];
    preview = null;
    importButton.disabled = true;
    report.replaceChildren();
    if (!chosen) return;
    const format = chosen.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
    preview = store.previewImport(await chosen.text(), format);
    const { valid, errors } = preview;
    importButton.disabled = valid.length === 0;
    importButton.textContent = valid.length > 0 ? `Import ${valid.length} resource${valid.length === 1 ? '' : 's'}` : 'Import';
    const parts: (HTMLElement | null)[] = [
      h('p', null, h('strong', null, `${valid.length} row${valid.length === 1 ? '' : 's'} ready to import`), errors.length > 0 ? `, ${errors.length} refused.` : '.'),
      errors.length > 0 ? h('ul', { class: 'res-findings' }, ...errors.slice(0, 12).map((e) => h('li', { dataset: { level: 'critical' } }, e.row > 0 ? `Row ${e.row}: ${e.message}` : e.message))) : null,
      errors.length > 12 ? h('p', { class: 'res-field-hint' }, `…and ${errors.length - 12} more.`) : null,
      errors.length > 0 && valid.length > 0 ? h('p', { class: 'res-field-hint' }, 'Refused rows are skipped; fix them in the file and import it again. Rows already imported will be recognised as duplicates.') : null,
    ];
    report.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null));
  });
  importButton.addEventListener('click', async () => {
    if (!preview) return;
    try {
      const count = await store.importResources(preview.valid);
      dialog.close();
      toast(`${count} resource${count === 1 ? '' : 's'} imported.`);
    } catch (error) {
      report.append(h('p', { class: 'res-form-summary' }, error instanceof Error ? error.message : 'The import failed. Nothing was saved.'));
    }
  });

  const dialog = openDialog('Import an inventory file', [
    h('p', { class: 'res-dialog-text' }, 'Choose a CSV or JSON file. Every row is checked with the same rules as the form before anything is saved.'),
    file,
    h(
      'p',
      { class: 'res-field-hint' },
      h('button', { class: 'link-button', type: 'button', onclick: () => download('helios-inventory-template.csv', CSV_TEMPLATE, 'text/csv') }, 'Download the CSV template'),
      ' · ',
      h('button', { class: 'link-button', type: 'button', onclick: () => download('helios-inventory.json', JSON.stringify({ resources: store.resources }, null, 2), 'application/json') }, 'Export the current inventory as JSON'),
    ),
    report,
    h('div', { class: 'res-form-actions' }, h('button', { class: 'button button-quiet', type: 'button', onclick: () => dialog.close() }, 'Cancel'), importButton),
  ]);
}

// ---------- Crew member ----------

export function openCrewForm(store: ResourceStore, existing?: CrewMember): void {
  const name = field('Name', textInput({ value: existing?.name ?? '', required: true, maxLength: 60 }));
  const role = field('Role on the mission', textInput({ value: existing?.role ?? '', required: true, maxLength: 60 }));
  const availability = field('Availability', selectInput(CREW_AVAILABILITY.map((a) => [a, AVAILABILITY_LABEL[a]] as const), existing?.availability ?? 'available'));
  const rows = h('div', { class: 'res-cert-rows' });
  const summary = h('p', { class: 'res-form-summary', role: 'alert' });
  const certRows: { read(): Certification; error: HTMLElement }[] = [];

  const addRow = (cert?: Certification): void => {
    const procedure = selectInput([['', 'Choose a procedure…'], ...PROCEDURES.map((p) => [p.code, p.name] as const)], cert?.procedureCode ?? '');
    procedure.setAttribute('aria-label', 'Procedure');
    const level = selectInput(TRAINING_LEVELS.map((l) => [l, TRAINING_LABEL[l]] as const), cert?.level ?? 'operator');
    level.setAttribute('aria-label', 'Training level');
    const certified = textInput({ type: 'date', value: cert?.certifiedOn ?? '', 'aria-label': 'Certified on' });
    const expires = textInput({ type: 'date', value: cert?.expiresOn ?? '', 'aria-label': 'Certification expires on (optional)' });
    const error = h('p', { class: 'res-field-error', role: 'alert' });
    const entry = { read: (): Certification => ({ procedureCode: procedure.value, level: level.value as TrainingLevel, certifiedOn: certified.value, expiresOn: expires.value || undefined }), error };
    const row = h(
      'div',
      { class: 'res-cert-row' },
      procedure,
      level,
      h('label', { class: 'res-cert-date' }, h('span', null, 'Certified'), certified),
      h('label', { class: 'res-cert-date' }, h('span', null, 'Expires (optional)'), expires),
      h(
        'button',
        {
          class: 'icon-button',
          type: 'button',
          'aria-label': 'Remove this certification',
          onclick: () => {
            certRows.splice(certRows.indexOf(entry), 1);
            row.remove();
          },
        },
        '×',
      ),
      error,
    );
    certRows.push(entry);
    rows.append(row);
  };
  (existing?.certifications ?? []).forEach(addRow);

  const form = h(
    'form',
    {
      class: 'res-form',
      noValidate: true,
      onsubmit: async (event: Event) => {
        event.preventDefault();
        certRows.forEach((r) => (r.error.textContent = ''));
        try {
          const saved = await store.saveCrewMember({ id: existing?.id, name: name.control.value, role: role.control.value, availability: availability.control.value as CrewAvailability, certifications: certRows.map((r) => r.read()) });
          dialog.close();
          toast(`${saved.name} saved.`);
        } catch (error) {
          showErrors(error, { name, role, availability }, summary);
          const fields = (error as { fields?: Record<string, string> }).fields ?? {};
          certRows.forEach((r, i) => (r.error.textContent = fields[`certifications.${i}`] ?? ''));
        }
      },
    },
    section('Crew member', name, role, availability),
    h(
      'fieldset',
      { class: 'res-form-section' },
      h('legend', null, 'Trained procedures'),
      h('p', { class: 'res-field-hint' }, 'List only what this person holds a certification for. Nothing is assumed: an empty list means no medical training on record.'),
      rows,
      h('button', { class: 'button button-quiet button-small', type: 'button', onclick: () => addRow() }, '+ Add a procedure'),
    ),
    summary,
    h(
      'div',
      { class: 'res-form-actions' },
      existing
        ? h(
            'button',
            {
              class: 'button button-quiet res-danger',
              type: 'button',
              onclick: () =>
                confirmDialog(`Remove ${existing.name} from the roster?`, 'Their training record is removed. Movements they recorded stay in the history under their name.', 'Remove', async () => {
                  await store.removeCrewMember(existing.id);
                  dialog.close();
                  toast(`${existing.name} removed from the roster.`);
                }),
            },
            'Remove from roster',
          )
        : null,
      h('span', { class: 'res-spacer' }),
      h('button', { class: 'button button-quiet', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      h('button', { class: 'button', type: 'submit' }, existing ? 'Save changes' : 'Add crew member'),
    ),
  );
  const dialog = openDialog(existing ? `Edit ${existing.name}` : 'Add a crew member', [form], { wide: true });
  name.control.focus();
}

export { procedureName };
