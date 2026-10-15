import { DEVICE_TYPES } from './catalog.js';
import { CONTROL_PARTS, CONTROL_PART_THRESHOLD_BOUNDS } from './controlParts.js';

export const [SENSOR_THRESHOLD_MIN, SENSOR_THRESHOLD_MAX] = CONTROL_PART_THRESHOLD_BOUNDS;
export const SENSOR_THRESHOLD_DEFAULT = CONTROL_PARTS.TSNS.defaultThreshold;

export const FACTORY_PARTS = Object.freeze(Object.values(CONTROL_PARTS)
  .map(part => ({ key: part.key, label: part.name, price: part.cost })));

export function validSensorThreshold(value) {
  if (value === '' || value === null || value === undefined) return false;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= SENSOR_THRESHOLD_MIN && number <= SENSOR_THRESHOLD_MAX;
}

const OBSERVATION_LABELS = Object.freeze({
  ready: 'Ready — transfer not confirmed',
  'empty inlet': 'No eligible input observed',
  'outlet occupied': 'Outlet has no open cells',
  'control off': 'Powered control is inactive',
  'base damaged': 'Base is damaged',
  pending: 'Observation pending',
  unknown: 'Status unknown',
});

export function presentFactoryObservation(observation) {
  const status = typeof observation?.status === 'string' ? observation.status : 'unknown';
  const freshness = ['fresh', 'stale'].includes(observation?.freshness) ? observation.freshness : 'unknown';
  return {
    status,
    freshness,
    label: OBSERVATION_LABELS[status] ?? OBSERVATION_LABELS.unknown,
    sampleLabel: `Sample: ${freshness}${observation?.pending ? ' · request pending' : ''}`,
  };
}

export function presentGateResult(result) {
  if (result == null) return 'No gate transition result.';
  if (typeof result === 'string') return `Gate result: ${result}`;
  if (typeof result !== 'object') return 'Gate result unavailable.';
  for (const key of ['status', 'state', 'reason', 'message']) {
    if (typeof result[key] === 'string' && result[key]) return `Gate result: ${result[key]}`;
  }
  return result.pending === true ? 'Gate transition pending.' : 'Gate result received; state unavailable.';
}

const node = (tag, className, parent, content) => {
  const element = document.createElement(tag);
  element.className = className;
  if (content !== undefined) element.textContent = content;
  parent?.append(element);
  return element;
};
const button = (parent, className, label, onClick) => {
  const element = node('button', className, parent, label);
  element.type = 'button';
  element.onclick = onClick;
  return element;
};
const text = (element, value) => {
  value = String(value);
  if (element.textContent !== value) element.textContent = value;
};
const attribute = (element, key, value) => {
  value = String(value);
  if (element.getAttribute(key) !== value) element.setAttribute(key, value);
};
const action = (actions, name, ...args) => {
  if (typeof actions?.[name] === 'function') return actions[name](...args);
};

/** Factory-only controls for paid material placement and inspection of real devices. */
export function createOperationsView(parent, actions = {}) {
  const root = node('section', 'industry-operations', parent);
  root.setAttribute('aria-label', 'Factory parts and inspection');

  const partsHeading = node('h2', 'industry-operations-heading', root, 'Control parts');
  const partsHelp = node('p', 'industry-operations-help', root,
    'Choose a part, then place one cell. Purchases cost credits and are irreversible; there is no refund.');
  const partGroup = node('div', 'industry-part-list', root);
  partGroup.setAttribute('role', 'group');
  partGroup.setAttribute('aria-label', 'Choose a control part');
  const partButtons = Object.fromEntries(FACTORY_PARTS.map(part => {
    const element = button(partGroup, 'industry-part', `${part.key} · ${part.price} cr`, () => action(actions, 'selectPart', part.key));
    element.setAttribute('data-part', part.key);
    element.setAttribute('aria-label', `${part.label} (${part.key}), ${part.price} credits. Select for one-cell placement.`);
    element.title = part.label;
    return [part.key, element];
  }));

  const thresholdLabel = node('label', 'industry-threshold', root, 'Sensor threshold (°C)');
  const threshold = node('input', 'industry-threshold-input', thresholdLabel);
  threshold.type = 'number';
  threshold.min = String(SENSOR_THRESHOLD_MIN);
  threshold.max = String(SENSOR_THRESHOLD_MAX);
  threshold.step = 'any';
  threshold.setAttribute('aria-label', 'Temperature sensor threshold in degrees Celsius');
  threshold.setAttribute('aria-invalid', 'false');
  const thresholdHelp = node('p', 'industry-operations-help', root,
    `Valid range: ${SENSOR_THRESHOLD_MIN} to ${SENSOR_THRESHOLD_MAX}°C; default ${SENSOR_THRESHOLD_DEFAULT}°C.`);
  thresholdHelp.id = 'industry-threshold-help';
  threshold.setAttribute('aria-describedby', thresholdHelp.id);
  thresholdLabel.hidden = thresholdHelp.hidden = true;
  threshold.oninput = () => {
    const valid = validSensorThreshold(threshold.value);
    attribute(threshold, 'aria-invalid', !valid);
    if (valid) action(actions, 'setThreshold', Number(threshold.value));
  };

  const inspectHeading = node('h2', 'industry-operations-heading', root, 'Inspect and control');
  const inspectButton = button(root, 'industry-inspect-toggle', 'Inspect a machine', () => action(actions, 'toggleInspect'));
  inspectButton.setAttribute('aria-pressed', 'false');
  const inspectHelp = node('p', 'industry-operations-help', root, 'Select a machine or cell to inspect it.');
  const inspection = node('div', 'industry-inspection', root);
  inspection.hidden = true;
  const machineName = node('p', 'industry-inspection-machine', inspection);
  const observation = node('p', 'industry-observation', inspection);
  const freshness = node('p', 'industry-freshness', inspection);
  const samples = node('p', 'industry-observed-regions', inspection);
  const gateResult = node('p', 'industry-gate-result', inspection);
  const drive = button(inspection, 'industry-drive', '', () => {});
  const gateModes = node('div', 'industry-gate-modes', inspection);
  gateModes.setAttribute('role', 'group');
  gateModes.setAttribute('aria-label', 'Gate operating mode');
  const gateButtons = Object.fromEntries(['open', 'closed', 'signal'].map(mode => {
    const element = button(gateModes, 'industry-gate-mode', mode[0].toUpperCase() + mode.slice(1), () => {});
    element.setAttribute('data-gate-mode', mode);
    return [mode, element];
  }));
  const gateHelp = node('p', 'industry-operations-help', inspection,
    'Open and Closed are manual modes. Signal opens while energized; closure waits if blocked. Damage is reported, not repaired.');
  const controlPart = node('div', 'industry-control-part', inspection);
  const controlPartText = node('p', 'industry-control-part-label', controlPart);
  const toggleControl = button(controlPart, 'industry-switch-toggle', 'Toggle inspected switch', () => action(actions, 'toggleControl'));
  drive.hidden = gateModes.hidden = gateHelp.hidden = controlPart.hidden = true;

  return {
    update(state = {}) {
      for (const part of FACTORY_PARTS) {
        const element = partButtons[part.key];
        attribute(element, 'aria-pressed', state.part === part.key);
        element.disabled = typeof actions?.selectPart !== 'function';
      }
      const thresholdMode = state.part === 'TSNS';
      thresholdLabel.hidden = thresholdHelp.hidden = !thresholdMode;
      threshold.disabled = typeof actions?.setThreshold !== 'function';
      if (document.activeElement !== threshold) {
        const value = state.partThreshold ?? SENSOR_THRESHOLD_DEFAULT;
        if (threshold.value !== String(value)) threshold.value = String(value);
        const valid = validSensorThreshold(value);
        attribute(threshold, 'aria-invalid', !valid);
      }

      const inspecting = !!state.inspectMode;
      text(inspectButton, inspecting ? 'Stop inspecting' : 'Inspect a machine');
      attribute(inspectButton, 'aria-pressed', inspecting);
      inspectButton.disabled = typeof actions?.toggleInspect !== 'function';
      text(inspectHelp, inspecting ? 'Inspection mode: select a machine or cell.' : 'Select a machine or cell to inspect it.');

      const details = state.inspection;
      const device = details?.device;
      inspection.hidden = !device && !details?.controlPart;
      if (inspection.hidden) return;
      const name = device ? DEVICE_TYPES[device.type]?.name ?? device.type
        : CONTROL_PARTS[details.controlPart.type]?.name ?? 'Control part';
      text(machineName, name);

      const presented = presentFactoryObservation(details.observation);
      text(observation, presented.label);
      text(freshness, presented.sampleLabel);
      const regions = Object.entries(details.observation?.evidence?.regions ?? {});
      samples.hidden = !regions.length;
      text(samples, regions.map(([name, region]) => {
        const heat = Number.isFinite(region.maxTemperatureC) ? ` · region peak ${Math.round(region.maxTemperatureC)}°C` : '';
        const label = device?.type === 'hearth' && name === 'charge' ? 'front chamber' : name;
        return `${label}: ${region.eligible ?? '?'} eligible / ${region.sampled ?? '?'} sampled${heat}`;
      }).join(' · '));
      observation.setAttribute('data-status', presented.status);
      freshness.setAttribute('data-freshness', presented.freshness);

      const usableId = typeof device?.id === 'string' && device.id.length > 0;
      const canDrive = usableId && !['foundation', 'gate'].includes(device.type);
      drive.hidden = !canDrive;
      drive.disabled = !canDrive || typeof actions?.setDrive !== 'function';
      text(drive, device?.powered ? 'Disable native port control' : 'Enable native port control');
      attribute(drive, 'aria-pressed', !!device?.powered);
      drive.onclick = () => {
        if (canDrive && typeof actions?.setDrive === 'function') action(actions, 'setDrive', device.id, !device.powered);
      };

      const isGate = device?.type === 'gate';
      gateModes.hidden = gateHelp.hidden = gateResult.hidden = !isGate;
      if (isGate) {
        text(gateResult, presentGateResult(details.gateStatus));
        for (const mode of ['open', 'closed', 'signal']) {
          const element = gateButtons[mode];
          attribute(element, 'aria-pressed', (device.gateMode ?? 'open') === mode);
          element.disabled = typeof actions?.setGateMode !== 'function' || !usableId;
          element.onclick = () => {
            if (usableId && typeof actions?.setGateMode === 'function') action(actions, 'setGateMode', device.id, mode);
          };
        }
      }

      const part = details.controlPart;
      const isSwitch = part?.type === 'SWITCH';
      controlPart.hidden = !part;
      toggleControl.hidden = !isSwitch;
      if (part) {
        const name = CONTROL_PARTS[part.type]?.name ?? part.type;
        const thresholdText = part.type === 'TSNS' && Number.isFinite(part.threshold) ? ` · threshold ${part.threshold}°C` : '';
        text(controlPartText, `${name}${part.on === true ? ' · on' : part.on === false ? ' · off' : ''}${thresholdText}`);
      }
      if (isSwitch) {
        toggleControl.disabled = typeof actions?.toggleControl !== 'function';
        attribute(toggleControl, 'aria-pressed', part.on === true);
        text(toggleControl, part.on === true ? 'Turn inspected switch off' : part.on === false ? 'Turn inspected switch on' : 'Toggle inspected switch');
      }
    },
  };
}
