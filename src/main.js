import './styles.css';
import {
  AVIATOR_RED,
  CONTINUOUS_CONFIG,
  applyPayout,
  clamp,
  createPlaneRun,
  deductStake,
  generateBotRun,
  maxSelectableAltitude,
  nextChargeAltitude,
  normalizeAltitudeTicks,
  normalizeStake,
  quoteAltitudeBet,
  randomInt,
  settleRun,
} from './game.js';
import {
  PLANE_TRACE_CENTER,
  PLANE_TRACE_LEVEL_ROTATION_DEGREES,
  PLANE_TRACE_PATH,
  PLANE_TRACE_VIEWBOX,
} from './planeTrace.js';

const STORAGE_KEYS = Object.freeze({
  balance: 'anti-aviator.balance',
  username: 'anti-aviator.username',
});

const PREVIEW_COLOR = AVIATOR_RED;
const UI_REFRESH_MS = 160;
const BOT_MIN_GAP_MS = 700;
const BOT_MAX_GAP_MS = 1_900;
const HISTORY_LIMIT = 8;
const IMPACT_WINDOW_PX = 10;
const CHART_MAX_ALTITUDE = CONTINUOUS_CONFIG.maxFlightAltitude;
const MOBILE_CANVAS_BREAKPOINT = 640;
const PLANE_WIDTH = Object.freeze({
  desktopMin: 78,
  desktopMax: 150,
  mobileMin: 56,
  mobileMax: 104,
});

let planeTracePathCache = null;

const elements = {
  streamLabel: document.querySelector('#streamLabel'),
  phaseBadge: document.querySelector('#phaseBadge'),
  altitudeBadge: document.querySelector('#timerLabel'),
  balanceLabel: document.querySelector('#balanceLabel'),
  usernameInput: document.querySelector('#usernameInput'),
  stakeInput: document.querySelector('#stakeInput'),
  stakeTimeLabel: document.querySelector('#stakeTimeLabel'),
  stakeCreditLabel: document.querySelector('#stakeCreditLabel'),
  altitudeInput: document.querySelector('#altitudeInput'),
  altitudeRange: document.querySelector('#altitudeRange'),
  altitudeTickLabel: document.querySelector('#altitudeTickLabel'),
  altitudeLimitLabel: document.querySelector('#altitudeLimitLabel'),
  payoutLabel: document.querySelector('#payoutLabel'),
  chanceLabel: document.querySelector('#chanceLabel'),
  returnLabel: document.querySelector('#returnLabel'),
  placeBetButton: document.querySelector('#placeBetButton'),
  resetBalanceButton: document.querySelector('#resetBalanceButton'),
  betMessage: document.querySelector('#betMessage'),
  canvas: document.querySelector('#gameCanvas'),
  playerList: document.querySelector('#playerList'),
  inspector: document.querySelector('#inspector'),
  historyList: document.querySelector('#historyList'),
};

const context = elements.canvas.getContext('2d');
const state = {
  balance: loadBalance(),
  currentAltitude: CONTINUOUS_CONFIG.initialAltitude,
  timeline: [],
  runs: [],
  history: [],
  hitboxes: [],
  selectedRunId: null,
  selectedAltitude: CONTINUOUS_CONFIG.initialAltitude + 10,
  nextBotAtMs: 0,
  lastTickAtMs: 0,
  lastUiRenderAt: 0,
  runSequence: 0,
  message: 'Airspace is live.',
};

function loadBalance() {
  const stored = Number.parseFloat(localStorage.getItem(STORAGE_KEYS.balance));
  return Number.isFinite(stored) && stored >= 0 ? stored : CONTINUOUS_CONFIG.startingBalance;
}

function saveBalance() {
  localStorage.setItem(STORAGE_KEYS.balance, String(state.balance));
}

function formatCredits(value, { signed = false } = {}) {
  const amount = Math.round(Math.abs(value) * 100) / 100;
  const money = `$${amount}`;
  if (!signed) {
    return value < 0 ? `-${money}` : money;
  }
  if (value > 0) {
    return `+${money}`;
  }
  if (value < 0) {
    return `-${money}`;
  }
  return money;
}

function formatMultiplier(value) {
  if (!Number.isFinite(value)) {
    return '-';
  }

  const decimals = value >= 10 ? 1 : 2;
  const rounded = Number(value.toFixed(decimals));
  const finalDecimals = rounded % 1 === 0 ? 0 : decimals;
  return `${rounded.toFixed(finalDecimals)}x`;
}

function formatPercent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

function formatSeconds(value) {
  return `${Math.max(0, value).toFixed(1)}s`;
}

function formatOffset(offsetTicks) {
  if (offsetTicks === 0) {
    return 'current charge';
  }
  if (offsetTicks > 0) {
    return `+${offsetTicks} above charge`;
  }
  return `${offsetTicks} below charge`;
}

function statusLabel(status) {
  if (status === 'survived') {
    return 'Cleared';
  }
  if (status === 'hit') {
    return 'Exploded';
  }
  return 'Inbound';
}

function getCurrentStake() {
  return normalizeStake(elements.stakeInput.value, state.balance);
}

function getSelectedOption() {
  const altitudeTicks = normalizeAltitudeTicks(state.selectedAltitude, state.currentAltitude);
  state.selectedAltitude = altitudeTicks;
  return quoteAltitudeBet(state.currentAltitude, altitudeTicks);
}

function updateChargeTimeline(now) {
  if (!state.lastTickAtMs) {
    state.lastTickAtMs = now;
    state.timeline = [{ timeMs: now, altitudeTicks: state.currentAltitude }];
    return;
  }

  let iterations = 0;
  while (state.lastTickAtMs + CONTINUOUS_CONFIG.tickMs <= now && iterations < 240) {
    state.lastTickAtMs += CONTINUOUS_CONFIG.tickMs;
    state.currentAltitude = nextChargeAltitude(state.currentAltitude);
    state.timeline.push({ timeMs: state.lastTickAtMs, altitudeTicks: state.currentAltitude });
    iterations += 1;
  }

  if (iterations >= 240) {
    state.lastTickAtMs = now;
    state.timeline.push({ timeMs: now, altitudeTicks: state.currentAltitude });
  }

  const oldestVisible = now - (CONTINUOUS_CONFIG.exitAfterCenterSeconds + 6) * 1000;
  state.timeline = state.timeline.filter((point) => point.timeMs >= oldestVisible);
}

function createRun({ username, kind, color, stakeCredits, option, enteredAtMs }) {
  state.runSequence += 1;
  return createPlaneRun({
    id: `${kind}-${state.runSequence}`,
    username,
    kind,
    color,
    stakeCredits,
    option,
    enteredAtMs,
  });
}

function spawnBot(enteredAtMs = performance.now()) {
  state.runSequence += 1;
  const run = generateBotRun({
    id: `bot-${state.runSequence}`,
    currentChargeAltitude: state.currentAltitude,
    enteredAtMs,
  });
  state.runs.push(run);
  if (!state.selectedRunId) {
    state.selectedRunId = run.id;
  }
}

function seedInitialTraffic(now) {
  for (let index = 0; index < 10; index += 1) {
    spawnBot(now - randomInt(0, 11_500));
  }
  state.nextBotAtMs = now + randomInt(350, 900);
}

function updateBotTraffic(now) {
  if (!state.nextBotAtMs) {
    state.nextBotAtMs = now + randomInt(350, 900);
  }

  let spawned = 0;
  while (now >= state.nextBotAtMs && spawned < 6) {
    spawnBot(state.nextBotAtMs);
    state.nextBotAtMs += randomInt(BOT_MIN_GAP_MS, BOT_MAX_GAP_MS);
    spawned += 1;
  }

  if (spawned >= 6 && now >= state.nextBotAtMs) {
    state.nextBotAtMs = now + randomInt(BOT_MIN_GAP_MS, BOT_MAX_GAP_MS);
  }
}

function settleDueRuns(now) {
  state.runs = state.runs.map((run) => {
    if (run.status !== 'inbound' || now < run.impactTimeMs) {
      return run;
    }

    const settled = settleRun(run, state.currentAltitude, now);
    if (settled.kind === 'user') {
      const beforePayout = state.balance;
      state.balance = applyPayout(state.balance, settled);
      saveBalance();
      state.history.unshift({
        id: `history-${settled.id}`,
        runId: settled.id,
        status: settled.status,
        stakeCredits: settled.stakeCredits,
        payoutMultiplier: settled.payoutMultiplier,
        delta: Math.round((state.balance - beforePayout) * 100) / 100,
      });
      state.history = state.history.slice(0, HISTORY_LIMIT);
      state.message = settled.status === 'survived'
        ? 'Your plane cleared the flak.'
        : 'Your plane exploded in the flak.';
    }
    return settled;
  });
}

function pruneOldRuns(now) {
  state.runs = state.runs.filter((run) => (
    run.exitsAtMs + 2_000 >= now || run.id === state.selectedRunId
  ));
}

function updateSimulation(now) {
  updateChargeTimeline(now);
  updateBotTraffic(now);
  settleDueRuns(now);
  pruneOldRuns(now);
}

function placeUserBet() {
  const username = elements.usernameInput.value.trim() || 'Pilot';
  const stakeCredits = getCurrentStake();
  const option = getSelectedOption();
  const now = performance.now();

  if (stakeCredits < 1 || stakeCredits > state.balance) {
    state.message = 'Insufficient balance.';
    renderControls();
    return;
  }

  if (!option) {
    state.message = 'Choose an altitude with a viable payout.';
    renderControls();
    return;
  }

  if (!option.valid) {
    state.message = 'That altitude has no viable survival chance.';
    renderControls();
    return;
  }

  state.balance = deductStake(state.balance, stakeCredits);
  saveBalance();
  localStorage.setItem(STORAGE_KEYS.username, username);

  const run = createRun({
    username,
    kind: 'user',
    color: AVIATOR_RED,
    stakeCredits,
    option,
    enteredAtMs: now,
  });

  state.runs.unshift(run);
  state.selectedRunId = run.id;
  state.message = `Plane launched. Impact ETA ${CONTINUOUS_CONFIG.entryEtaSeconds}s.`;
  renderControls();
  renderPlayerList(now);
  renderInspector(now);
}

function resetBalance() {
  state.balance = CONTINUOUS_CONFIG.startingBalance;
  saveBalance();
  syncStakeBounds();
  renderControls();
}

function syncStakeBounds() {
  const maxStake = Math.max(0, Math.min(CONTINUOUS_CONFIG.maxStake, Math.floor(state.balance)));
  const previousStake = Number(elements.stakeInput.value) || 75;
  const nextStake = maxStake < 1 ? 0 : normalizeStake(previousStake, state.balance);

  elements.stakeInput.max = String(Math.max(1, maxStake));
  elements.stakeInput.value = String(nextStake);
}

function syncAltitudeBounds() {
  const maxAltitude = maxSelectableAltitude(state.currentAltitude);
  const nextAltitude = normalizeAltitudeTicks(state.selectedAltitude, state.currentAltitude);

  state.selectedAltitude = nextAltitude;
  elements.altitudeInput.max = String(maxAltitude);
  elements.altitudeRange.max = String(maxAltitude);
  elements.altitudeInput.value = String(nextAltitude);
  elements.altitudeRange.value = String(nextAltitude);
  elements.altitudeTickLabel.textContent = `${nextAltitude} ticks`;
  elements.altitudeLimitLabel.textContent = `max ${maxAltitude}`;
}

function renderControls() {
  syncStakeBounds();
  syncAltitudeBounds();

  const stakeCredits = getCurrentStake();
  const option = getSelectedOption();
  const canBet = Boolean(stakeCredits >= 1 && stakeCredits <= state.balance && option?.valid);

  elements.balanceLabel.textContent = formatCredits(state.balance);
  elements.stakeTimeLabel.textContent = `ETA ${CONTINUOUS_CONFIG.entryEtaSeconds}s`;
  elements.stakeCreditLabel.textContent = formatCredits(stakeCredits);
  elements.payoutLabel.textContent = option?.valid
    ? `${formatMultiplier(option.payoutMultiplier)}${option.capped ? '+' : ''}`
    : '-';
  elements.chanceLabel.textContent = option?.valid ? formatPercent(option.winChance) : '-';
  elements.returnLabel.textContent = option?.valid
    ? formatCredits(stakeCredits * option.payoutMultiplier)
    : '-';
  elements.placeBetButton.disabled = !canBet;
  elements.betMessage.textContent = state.message;
}

function renderTopbar() {
  elements.streamLabel.textContent = 'Live airspace';
  elements.phaseBadge.textContent = 'Streaming';
  elements.phaseBadge.dataset.phase = 'live';
  elements.altitudeBadge.textContent = `Altitude ${state.currentAltitude}`;
}

function getVisibleRuns(now) {
  return state.runs
    .filter((run) => run.exitsAtMs + 2_000 >= now || run.id === state.selectedRunId)
    .sort((a, b) => a.impactTimeMs - b.impactTimeMs);
}

function getLaunchPreview(now = performance.now()) {
  const stakeCredits = getCurrentStake();
  const option = getSelectedOption();

  if (!option?.valid || stakeCredits < 1 || stakeCredits > state.balance) {
    return null;
  }

  return {
    id: 'launch-preview',
    username: elements.usernameInput.value.trim() || 'Pilot',
    kind: 'preview',
    color: PREVIEW_COLOR,
    stakeCredits,
    payoutMultiplier: option.payoutMultiplier,
    potentialPayout: Math.round(stakeCredits * option.payoutMultiplier * 100) / 100,
    impactTimeMs: now + CONTINUOUS_CONFIG.entryEtaSeconds * 1000,
    altitudeTicks: option.altitudeTicks,
    altitudeOffsetTicks: option.altitudeOffsetTicks,
    winChance: option.winChance,
    status: 'preview',
  };
}

function etaForRun(run, now) {
  return (run.impactTimeMs - now) / 1000;
}

function renderPlayerList(now = performance.now()) {
  const runs = getVisibleRuns(now);
  elements.playerList.innerHTML = '';

  if (!runs.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Planes are launching from the left.';
    elements.playerList.append(empty);
    return;
  }

  runs.forEach((run) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `player-row ${state.selectedRunId === run.id ? 'selected' : ''}`;
    item.dataset.status = run.status;
    item.addEventListener('click', () => {
      state.selectedRunId = run.id;
      renderPlayerList(now);
      renderInspector(now);
    });

    const marker = document.createElement('span');
    marker.className = 'player-marker';
    marker.style.background = run.color;

    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = run.username;

    const etaText = run.status === 'inbound'
      ? `ETA ${formatSeconds(etaForRun(run, now))}`
      : `flak ${run.chargeAltitudeAtImpact}`;
    const meta = document.createElement('span');
    meta.className = 'player-meta';
    meta.textContent = `${formatCredits(run.stakeCredits)} | ${formatMultiplier(run.payoutMultiplier)} | ${etaText}`;

    const status = document.createElement('span');
    status.className = 'player-status';
    status.textContent = statusLabel(run.status);

    item.append(marker, name, meta, status);
    elements.playerList.append(item);
  });
}

function renderInspector(now = performance.now()) {
  const selected = state.runs.find((run) => run.id === state.selectedRunId);
  elements.inspector.innerHTML = '';

  if (!selected) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Select a plane on the chart or traffic list.';
    elements.inspector.append(empty);
    return;
  }

  const title = document.createElement('div');
  title.className = 'inspect-title';
  const swatch = document.createElement('span');
  swatch.style.background = selected.color;
  const name = document.createElement('strong');
  name.textContent = selected.username;
  title.append(swatch, name);

  const eta = etaForRun(selected, now);
  const list = document.createElement('dl');
  list.className = 'inspect-grid';
  const rows = [
    ['Stake', formatCredits(selected.stakeCredits)],
    ['Payout', formatMultiplier(selected.payoutMultiplier)],
    ['Return', formatCredits(selected.potentialPayout)],
    ['Altitude', `${selected.altitudeTicks} ticks`],
    ['Offset', formatOffset(selected.altitudeOffsetTicks)],
    ['Win chance', formatPercent(selected.winChance)],
    ['ETA', selected.status === 'inbound' ? formatSeconds(eta) : 'resolved'],
    ['Status', statusLabel(selected.status)],
  ];

  if (selected.chargeAltitudeAtImpact !== null) {
    rows.splice(6, 0, ['Flak altitude', `${selected.chargeAltitudeAtImpact} ticks`]);
  }

  rows.forEach(([label, value]) => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<dt>${label}</dt><dd>${value}</dd>`;
    list.append(wrapper);
  });

  elements.inspector.append(title, list);
}

function renderHistory() {
  elements.historyList.innerHTML = '';
  if (!state.history.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No resolved user flights.';
    elements.historyList.append(empty);
    return;
  }

  state.history.forEach((entry, index) => {
    const item = document.createElement('div');
    item.className = 'history-row';
    item.dataset.status = entry.status;
    item.innerHTML = `
      <span>Flight ${state.history.length - index}</span>
      <strong>${statusLabel(entry.status)}</strong>
      <small>${formatCredits(entry.stakeCredits)} at ${formatMultiplier(entry.payoutMultiplier)}</small>
      <em>${formatCredits(entry.delta, { signed: true })}</em>
    `;
    elements.historyList.append(item);
  });
}

function renderUi(now) {
  renderTopbar();
  renderControls();
  renderPlayerList(now);
  renderInspector(now);
  renderHistory();
}

function resizeCanvas() {
  const canvas = elements.canvas;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(320, Math.floor(rect.width));
  const height = Math.max(320, Math.floor(rect.height));

  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  return { width, height };
}

function createChartMapper(width, height, maxAltitude) {
  const mobile = width <= MOBILE_CANVAS_BREAKPOINT;
  const padding = mobile
    ? {
        left: 36,
        right: 14,
        top: 34,
        bottom: 96,
      }
    : {
        left: 62,
        right: 36,
        top: 62,
        bottom: 132,
      };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const impactX = padding.left + plotWidth * 0.75;
  const rightX = width - padding.right;
  const leftX = padding.left;
  const bottomY = height - padding.bottom;
  const pxPerSecond = (impactX - leftX) / CONTINUOUS_CONFIG.entryEtaSeconds;

  return {
    padding,
    plotWidth,
    plotHeight,
    centerX: impactX,
    impactX,
    rightX,
    leftX,
    bottomY,
    pxPerSecond,
    mobile,
    xForImpactTime(impactTimeMs, now) {
      return impactX - ((impactTimeMs - now) / 1000) * pxPerSecond;
    },
    xForTimelineTime(timeMs, now) {
      return impactX + ((timeMs - now) / 1000) * pxPerSecond;
    },
    yForAltitude(altitudeTicks) {
      const boundedAltitude = clamp(
        Number(altitudeTicks) || CONTINUOUS_CONFIG.minAltitude,
        CONTINUOUS_CONFIG.minAltitude,
        maxAltitude,
      );
      return bottomY - (boundedAltitude / maxAltitude) * plotHeight;
    },
  };
}

function drawCanvas(now = performance.now()) {
  const { width, height } = resizeCanvas();
  const maxAltitude = CHART_MAX_ALTITUDE;
  const map = createChartMapper(width, height, maxAltitude);

  state.hitboxes = [];
  context.clearRect(0, 0, width, height);
  drawSky(width, height, map, now);
  drawGrid(width, height, map, maxAltitude);
  drawKillZone(map, now);
  drawChargePath(map, now);
  drawLaunchPreview(map, now);
  drawPlanes(map, now);
  drawAntiAircraftGun(map, now);
}

function drawSky(width, height, map, now) {
  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#191512');
  sky.addColorStop(0.48, '#12110f');
  sky.addColorStop(1, '#050504');
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);

  context.save();
  context.globalAlpha = 0.22;
  context.strokeStyle = '#f3043f';
  context.lineWidth = 1;
  for (let y = map.padding.top; y <= map.bottomY; y += 34) {
    context.beginPath();
    context.moveTo(map.leftX, y + Math.sin((now / 600) + y) * 2);
    context.lineTo(map.rightX, y + Math.cos((now / 700) + y) * 2);
    context.stroke();
  }
  context.restore();
}

function drawGrid(width, height, map, maxAltitude) {
  context.save();
  context.strokeStyle = 'rgba(243, 4, 63, 0.18)';
  context.fillStyle = 'rgba(245, 245, 240, 0.76)';
  context.lineWidth = 1;
  context.font = `${map.mobile ? 10 : 12}px Inter, system-ui, sans-serif`;

  const secondMarks = map.mobile ? [-20, -10, 0] : [-20, -15, -10, -5, 0, 5];
  secondMarks.forEach((seconds) => {
    const x = map.impactX + seconds * map.pxPerSecond;
    if (seconds !== 0) {
      context.beginPath();
      context.moveTo(x, map.padding.top);
      context.lineTo(x, map.bottomY);
      context.stroke();
    }
    const label = seconds === 0 ? 'impact' : `${seconds > 0 ? '+' : ''}${seconds}s`;
    context.fillText(label, x - (map.mobile ? 14 : 18), map.bottomY + (map.mobile ? 19 : 26));
  });

  const altitudeStep = maxAltitude <= 50 ? 10 : 20;
  for (let altitude = 0; altitude <= maxAltitude; altitude += altitudeStep) {
    const y = map.yForAltitude(altitude);
    context.beginPath();
    context.moveTo(map.leftX, y);
    context.lineTo(map.rightX, y);
    context.stroke();
    context.fillText(`${altitude}`, map.mobile ? 8 : 22, y + 4);
  }

  if (!map.mobile) {
    context.fillStyle = 'rgba(245, 245, 240, 0.9)';
    context.font = '600 12px Inter, system-ui, sans-serif';
    context.fillText('impact timeline', width - 126, map.bottomY + 26);
    context.save();
    context.translate(18, map.padding.top + map.plotHeight / 2);
    context.rotate(-Math.PI / 2);
    context.fillText('altitude ticks', 0, 0);
    context.restore();
  }

  context.strokeStyle = 'rgba(243, 4, 63, 0.75)';
  context.lineWidth = 1.5;
  context.strokeRect(map.leftX, map.padding.top, map.plotWidth, map.plotHeight);
  context.restore();
}

function visibleChargePoints(map, now) {
  return state.timeline
    .map((point) => ({
      ...point,
      x: map.xForTimelineTime(point.timeMs, now),
      y: map.yForAltitude(point.altitudeTicks),
    }))
    .filter((point) => point.x >= map.leftX - 40 && point.x <= map.centerX + 2);
}

function drawKillZone(map, now) {
  const points = visibleChargePoints(map, now);
  if (points.length < 2) {
    return;
  }

  const first = points[0];
  const last = points[points.length - 1];

  context.save();
  context.beginPath();
  context.moveTo(first.x, map.bottomY);
  points.forEach((point) => {
    context.lineTo(point.x, point.y);
  });
  context.lineTo(last.x, map.bottomY);
  context.closePath();
  context.fillStyle = 'rgba(243, 4, 63, 0.22)';
  context.fill();
  context.restore();
}

function drawChargePath(map, now) {
  const points = visibleChargePoints(map, now);
  if (!points.length) {
    return;
  }

  context.save();
  context.lineWidth = 3;
  context.strokeStyle = '#f3043f';
  context.shadowColor = 'rgba(243, 4, 63, 0.65)';
  context.shadowBlur = 12;
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      context.moveTo(point.x, point.y);
    } else {
      context.lineTo(point.x, point.y);
    }
  });
  context.stroke();
  context.restore();

  context.save();
  const recent = points.slice(-14);
  recent.forEach((point, index) => {
    context.globalAlpha = 0.25 + (index / recent.length) * 0.75;
    drawExplosion(point.x, point.y, 5 + index / 4, '#f3043f');
  });
  context.restore();
}

function drawAntiAircraftGun(map, now) {
  const scale = map.mobile ? 0.76 : 1;
  const gunX = map.rightX - 64 * scale;
  const gunY = map.bottomY + 84 * scale;
  const targetX = map.centerX;
  const targetY = map.yForAltitude(state.currentAltitude);
  const pivotX = gunX - 8 * scale;
  const pivotY = gunY - 33 * scale;
  const angle = Math.atan2(targetY - pivotY, targetX - pivotX);
  const muzzle = {
    x: pivotX + Math.cos(angle) * 88 * scale,
    y: pivotY + Math.sin(angle) * 88 * scale,
  };

  drawTracerFire({ start: muzzle, end: { x: targetX, y: targetY }, angle, now });
  drawRapidFlakBursts(targetX, targetY, now);
  drawGunBody({ gunX, gunY, angle, now, scale });
}

function drawGunBody({ gunX, gunY, angle, now, scale = 1 }) {
  context.save();
  context.translate(gunX, gunY);
  context.scale(scale, scale);
  context.lineJoin = 'round';
  context.lineCap = 'round';

  const glow = 0.5 + Math.sin(now / 80) * 0.2;
  context.shadowColor = 'rgba(243, 4, 63, 0.55)';
  context.shadowBlur = 12 * glow;

  context.strokeStyle = 'rgba(10, 8, 8, 0.95)';
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(-34, 12);
  context.lineTo(-12, -5);
  context.lineTo(18, 12);
  context.moveTo(-10, 7);
  context.lineTo(-18, 26);
  context.moveTo(8, 7);
  context.lineTo(24, 26);
  context.stroke();

  context.fillStyle = '#220b12';
  context.strokeStyle = '#f3043f';
  context.lineWidth = 2;
  roundedRect(-38, 5, 74, 18, 5);
  context.fill();
  context.stroke();

  context.beginPath();
  context.arc(-28, 25, 9, 0, Math.PI * 2);
  context.arc(27, 25, 9, 0, Math.PI * 2);
  context.fillStyle = '#12090a';
  context.fill();
  context.stroke();

  context.fillStyle = '#f3043f';
  context.strokeStyle = 'rgba(8, 6, 6, 0.95)';
  context.lineWidth = 3;
  roundedRect(-24, -18, 42, 24, 7);
  context.fill();
  context.stroke();

  context.save();
  context.translate(-8, -33);
  context.rotate(angle);
  context.shadowBlur = 10;

  context.fillStyle = '#f3043f';
  context.strokeStyle = 'rgba(8, 6, 6, 0.96)';
  context.lineWidth = 2.5;
  roundedRect(-16, -12, 36, 24, 6);
  context.fill();
  context.stroke();

  context.fillStyle = '#2b0c13';
  context.strokeStyle = '#f3043f';
  roundedRect(12, -11, 82, 7, 3);
  context.fill();
  context.stroke();
  roundedRect(12, 4, 82, 7, 3);
  context.fill();
  context.stroke();

  context.fillStyle = '#ffb000';
  context.strokeStyle = '#ffd166';
  roundedRect(90, -13, 12, 11, 4);
  context.fill();
  context.stroke();
  roundedRect(90, 2, 12, 11, 4);
  context.fill();
  context.stroke();

  drawMuzzleFlash(100, -6, now);
  drawMuzzleFlash(100, 9, now + 90);
  context.restore();

  context.restore();
}

function drawMuzzleFlash(x, y, now) {
  const pulse = 0.68 + Math.sin(now / 34) * 0.32;
  context.save();
  context.globalAlpha = 0.55 + pulse * 0.45;
  context.fillStyle = '#ffb000';
  context.shadowColor = '#ffb000';
  context.shadowBlur = 18;
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x + 26 * pulse, y - 8);
  context.lineTo(x + 17 * pulse, y);
  context.lineTo(x + 29 * pulse, y + 8);
  context.closePath();
  context.fill();
  context.restore();
}

function drawTracerFire({ start, end, angle, now }) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= 0) {
    return;
  }

  const ux = dx / distance;
  const uy = dy / distance;
  const px = -uy;
  const py = ux;
  const streams = [-5, 5];

  context.save();
  context.lineCap = 'round';
  streams.forEach((offset, streamIndex) => {
    for (let shell = 0; shell < 7; shell += 1) {
      const phase = ((now + shell * 58 + streamIndex * 72) % 430) / 430;
      const travel = phase * distance;
      const length = 18 + phase * 18;
      const x = start.x + ux * travel + px * offset;
      const y = start.y + uy * travel + py * offset;
      const tailX = x - ux * length;
      const tailY = y - uy * length;

      context.globalAlpha = 0.18 + phase * 0.82;
      context.strokeStyle = shell % 2 === 0 ? '#ffb000' : '#f3043f';
      context.lineWidth = shell % 2 === 0 ? 3 : 2;
      context.shadowColor = context.strokeStyle;
      context.shadowBlur = 11;
      context.beginPath();
      context.moveTo(tailX, tailY);
      context.lineTo(x, y);
      context.stroke();

      context.fillStyle = '#fff2b8';
      context.beginPath();
      context.arc(x, y, 2.4, 0, Math.PI * 2);
      context.fill();
    }
  });

  context.globalAlpha = 0.22;
  context.strokeStyle = 'rgba(255, 176, 0, 0.55)';
  context.lineWidth = 1;
  context.setLineDash([9, 10]);
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.stroke();
  context.setLineDash([]);
  context.restore();

  drawGunSmoke(start.x + Math.cos(angle) * 6, start.y + Math.sin(angle) * 6, now);
}

function drawGunSmoke(x, y, now) {
  context.save();
  context.globalAlpha = 0.22;
  context.fillStyle = '#f5f5f0';
  for (let puff = 0; puff < 4; puff += 1) {
    const drift = ((now / 240) + puff * 0.31) % 1;
    context.beginPath();
    context.arc(
      x - 8 - drift * 18,
      y - 8 - puff * 3 + Math.sin(now / 140 + puff) * 2,
      5 + drift * 7,
      0,
      Math.PI * 2,
    );
    context.fill();
  }
  context.restore();
}

function drawRapidFlakBursts(x, y, now) {
  context.save();
  for (let burst = 0; burst < 4; burst += 1) {
    const phase = ((now + burst * 88) % 360) / 360;
    const alpha = 1 - phase;
    const offsetX = Math.sin(now / 95 + burst * 2.1) * (5 + burst * 3);
    const offsetY = Math.cos(now / 110 + burst * 1.7) * (5 + burst * 2);
    const radius = 7 + phase * 24;

    context.globalAlpha = 0.18 + alpha * 0.68;
    drawExplosion(x + offsetX, y + offsetY, radius, burst % 2 === 0 ? '#ffb000' : '#f3043f');

    context.globalAlpha = alpha * 0.28;
    context.strokeStyle = '#fff2b8';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(x + offsetX, y + offsetY, radius * 1.25, 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();
}

function drawPlanes(map, now) {
  const visibleRuns = getVisibleRuns(now);
  const botRuns = visibleRuns.filter((run) => run.kind !== 'user');
  const userRuns = visibleRuns.filter((run) => run.kind === 'user');

  botRuns.forEach((run) => drawPlaneRun(run, map, now));
  userRuns.forEach((run) => drawPlaneRun(run, map, now));
}

function drawPlaneRun(run, map, now) {
  const x = map.xForImpactTime(run.impactTimeMs, now);
  if (x < map.leftX - 80 || x > map.rightX + 80) {
    return;
  }

  const y = map.yForAltitude(run.altitudeTicks);
  const planeWidth = planeWidthForStake(run.stakeCredits, map);
  const labelOffset = planeLabelOffset(planeWidth, map);
  const selected = state.selectedRunId === run.id;
  const userRun = run.kind === 'user';
  const planeSelected = selected && !userRun;
  const hasReachedFiringLine = x >= map.centerX - IMPACT_WINDOW_PX;
  const showImpact = run.status === 'hit' && hasReachedFiringLine;
  const impactAgeMs = Math.max(0, now - run.impactTimeMs);

  if (userRun) {
    drawUserPlaneMarker(x, y, now);
  }

  if (showImpact) {
    drawFireball(x, y, impactAgeMs, planeSelected || userRun, planeWidth);
    drawPlaneLabel(run.username, formatRunWager(run), x, y + labelOffset + 15, planeSelected || userRun, map.mobile);
  } else {
    drawSvgPlane({
      x,
      y,
      color: run.color,
      width: planeWidth,
      selected: planeSelected,
      ghost: false,
      label: run.username,
      labelDetail: formatRunWager(run),
      compact: map.mobile,
    });
  }

  const hitboxWidth = Math.max(map.mobile ? 72 : 88, planeWidth * 0.92);
  const hitboxHeight = Math.max(map.mobile ? 58 : 70, planeWidth * 0.66);
  state.hitboxes.push({
    runId: run.id,
    x: x - hitboxWidth / 2,
    y: y - hitboxHeight / 2,
    width: hitboxWidth,
    height: hitboxHeight,
  });
}

function formatRunWager(run) {
  return `${formatCredits(run.stakeCredits)} @ ${formatMultiplier(run.payoutMultiplier)}`;
}

function planeStakeRatio(stakeCredits) {
  const stake = clamp(Number(stakeCredits) || 1, 1, CONTINUOUS_CONFIG.maxStake);
  return Math.sqrt(stake / CONTINUOUS_CONFIG.maxStake);
}

function planeWidthForStake(stakeCredits, map) {
  const minWidth = map.mobile ? PLANE_WIDTH.mobileMin : PLANE_WIDTH.desktopMin;
  const maxWidth = map.mobile ? PLANE_WIDTH.mobileMax : PLANE_WIDTH.desktopMax;
  return minWidth + planeStakeRatio(stakeCredits) * (maxWidth - minWidth);
}

function planeLabelOffset(planeWidth, map) {
  return clamp(planeWidth * 0.38, map.mobile ? 27 : 34, map.mobile ? 42 : 56);
}

function drawLaunchPreview(map, now) {
  const preview = getLaunchPreview(now);
  if (!preview) {
    return;
  }

  const actualEntryX = map.xForImpactTime(preview.impactTimeMs, now);
  const x = Math.max(map.leftX + 24, actualEntryX);
  const y = map.yForAltitude(preview.altitudeTicks);
  const planeWidth = planeWidthForStake(preview.stakeCredits, map);

  context.save();
  context.setLineDash([8, 7]);
  context.lineWidth = 1.5;
  context.strokeStyle = 'rgba(243, 4, 63, 0.65)';
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(map.centerX, y);
  context.stroke();
  context.restore();

  drawSvgPlane({
    x,
    y,
    color: PREVIEW_COLOR,
    width: planeWidth,
    selected: true,
    ghost: true,
    compact: map.mobile,
  });
}

function getPlaneTracePath() {
  if (!planeTracePathCache) {
    planeTracePathCache = new Path2D(PLANE_TRACE_PATH);
  }
  return planeTracePathCache;
}

function drawSvgPlane({
  x,
  y,
  color,
  width,
  selected = false,
  ghost = false,
  label = '',
  labelDetail = '',
  compact = false,
}) {
  const path = getPlaneTracePath();
  const scale = width / PLANE_TRACE_VIEWBOX.width;

  context.save();
  context.translate(x, y);
  context.rotate((PLANE_TRACE_LEVEL_ROTATION_DEGREES * Math.PI) / 180);
  context.scale(scale, scale);
  context.translate(-PLANE_TRACE_CENTER.x, -PLANE_TRACE_CENTER.y);
  context.globalAlpha = ghost ? 0.42 : 1;
  context.shadowColor = selected ? 'rgba(243, 4, 63, 0.75)' : 'transparent';
  context.shadowBlur = selected ? 18 : 0;

  context.fillStyle = color;
  context.fill(path, 'evenodd');
  context.restore();

  if (label) {
    drawPlaneLabel(label, labelDetail, x, y + planeLabelOffset(width, { mobile: compact }), selected, compact);
  }
}

function drawPlaneLabel(label, detail, x, y, selected = false, compact = false) {
  context.save();
  context.textAlign = 'center';
  context.strokeStyle = 'rgba(3, 2, 2, 0.86)';
  context.lineJoin = 'round';
  context.lineWidth = compact ? 3 : 4;

  context.font = selected
    ? `800 ${compact ? 11 : 13}px Inter, system-ui, sans-serif`
    : `700 ${compact ? 10 : 12}px Inter, system-ui, sans-serif`;
  context.fillStyle = '#fff8fa';
  context.strokeText(label, x, y);
  context.fillText(label, x, y);

  if (detail) {
    context.font = selected
      ? `700 ${compact ? 9 : 11}px Inter, system-ui, sans-serif`
      : `650 ${compact ? 9 : 10}px Inter, system-ui, sans-serif`;
    context.fillStyle = 'rgba(255, 245, 247, 0.88)';
    context.strokeText(detail, x, y + (compact ? 11 : 13));
    context.fillText(detail, x, y + (compact ? 11 : 13));
  }
  context.restore();
}

function drawUserPlaneMarker(x, y, now) {
  const pulse = 0.5 + Math.sin(now / 260) * 0.5;
  const glowWidth = 128 + pulse * 18;
  const glowHeight = 68 + pulse * 10;

  context.save();
  context.translate(x, y);
  context.rotate(-0.08);
  context.globalCompositeOperation = 'lighter';
  context.scale(glowWidth / 2, glowHeight / 2);
  const glow = context.createRadialGradient(-0.08, -0.03, 0.06, 0, 0, 1);
  glow.addColorStop(0, 'rgba(255, 250, 184, 0.98)');
  glow.addColorStop(0.32, 'rgba(255, 204, 54, 0.78)');
  glow.addColorStop(0.66, 'rgba(255, 176, 0, 0.34)');
  glow.addColorStop(1, 'rgba(255, 185, 38, 0)');
  context.fillStyle = glow;
  context.shadowColor = 'rgba(255, 215, 82, 0.9)';
  context.shadowBlur = 42;
  context.beginPath();
  context.arc(0, 0, 1, 0, Math.PI * 2);
  context.fill();
  context.restore();

  context.save();
  context.translate(x, y);
  context.rotate(-0.08);
  context.lineWidth = 3;
  context.strokeStyle = `rgba(255, 232, 93, ${0.78 + pulse * 0.16})`;
  context.shadowColor = '#ffdd4a';
  context.shadowBlur = 18;
  context.beginPath();
  context.ellipse(0, 0, glowWidth * 0.44, glowHeight * 0.38, 0, 0, Math.PI * 2);
  context.stroke();
  context.lineWidth = 1.5;
  context.strokeStyle = 'rgba(255, 248, 190, 0.86)';
  context.beginPath();
  context.ellipse(0, 0, glowWidth * 0.34, glowHeight * 0.28, 0, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

function drawFireball(x, y, impactAgeMs, selected = false, planeWidth = PLANE_WIDTH.desktopMin) {
  const pulse = 0.84 + Math.sin(impactAgeMs / 74) * 0.16;
  const radius = clamp(planeWidth * 0.34, 25, 48) * pulse;
  const glow = context.createRadialGradient(x - 6, y - 7, 2, x, y, radius * 1.45);
  glow.addColorStop(0, '#fff7cf');
  glow.addColorStop(0.2, '#ffb000');
  glow.addColorStop(0.52, '#f3043f');
  glow.addColorStop(1, 'rgba(58, 8, 9, 0)');

  context.save();
  context.fillStyle = glow;
  context.shadowColor = '#f3043f';
  context.shadowBlur = selected ? 28 : 18;
  context.beginPath();
  context.arc(x, y, radius * 1.45, 0, Math.PI * 2);
  context.fill();

  const lobes = [
    [-17, -9, 18],
    [7, -15, 23],
    [20, 4, 17],
    [-3, 14, 21],
    [-22, 12, 14],
  ];

  lobes.forEach(([offsetX, offsetY, size], index) => {
    const wobble = Math.sin((impactAgeMs / 92) + index * 1.7) * 4;
    context.fillStyle = index % 2 === 0 ? '#ffb000' : '#f3043f';
    context.beginPath();
    context.arc(x + offsetX + wobble, y + offsetY - wobble / 2, size * pulse, 0, Math.PI * 2);
    context.fill();
  });

  context.fillStyle = '#fff7cf';
  context.beginPath();
  context.arc(x - 5, y - 5, 10 * pulse, 0, Math.PI * 2);
  context.fill();

  if (selected) {
    context.strokeStyle = '#fff4f7';
    context.lineWidth = 2.5;
    context.beginPath();
    context.arc(x, y, radius * 1.18, 0, Math.PI * 2);
    context.stroke();
  }

  context.restore();
}

function drawExplosion(x, y, radius, color) {
  context.save();
  context.translate(x, y);
  context.strokeStyle = color;
  context.fillStyle = color;
  context.shadowColor = color;
  context.shadowBlur = 12;
  context.lineWidth = 2;
  for (let ray = 0; ray < 8; ray += 1) {
    const angle = (Math.PI * 2 * ray) / 8;
    context.beginPath();
    context.moveTo(Math.cos(angle) * (radius * 0.45), Math.sin(angle) * (radius * 0.45));
    context.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    context.stroke();
  }
  context.beginPath();
  context.arc(0, 0, radius * 0.35, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function roundedRect(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function handleCanvasClick(event) {
  const rect = elements.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = [...state.hitboxes].reverse().find((box) => (
    x >= box.x
      && x <= box.x + box.width
      && y >= box.y
      && y <= box.y + box.height
  ));

  if (hit) {
    state.selectedRunId = hit.runId;
    renderPlayerList(performance.now());
    renderInspector(performance.now());
  }
}

function syncStakeInputs() {
  const stake = normalizeStake(elements.stakeInput.value, state.balance);
  elements.stakeInput.value = String(stake);
  renderControls();
}

function syncAltitudeInputs(source) {
  const value = source === 'range' ? elements.altitudeRange.value : elements.altitudeInput.value;
  state.selectedAltitude = normalizeAltitudeTicks(value, state.currentAltitude);
  elements.altitudeInput.value = String(state.selectedAltitude);
  elements.altitudeRange.value = String(state.selectedAltitude);
  renderControls();
}

function bindEvents() {
  elements.placeBetButton.addEventListener('click', placeUserBet);
  elements.resetBalanceButton.addEventListener('click', resetBalance);
  elements.stakeInput.addEventListener('input', syncStakeInputs);
  elements.altitudeInput.addEventListener('input', () => syncAltitudeInputs('input'));
  elements.altitudeRange.addEventListener('input', () => syncAltitudeInputs('range'));
  elements.usernameInput.addEventListener('input', () => {
    localStorage.setItem(STORAGE_KEYS.username, elements.usernameInput.value.trim());
  });
  elements.canvas.addEventListener('click', handleCanvasClick);
  window.addEventListener('resize', () => drawCanvas(performance.now()));
}

function animationLoop(now) {
  updateSimulation(now);
  drawCanvas(now);

  if (now - state.lastUiRenderAt > UI_REFRESH_MS) {
    renderUi(now);
    state.lastUiRenderAt = now;
  }

  requestAnimationFrame(animationLoop);
}

function init() {
  const now = performance.now();
  elements.usernameInput.value = localStorage.getItem(STORAGE_KEYS.username) || 'Pilot';
  elements.stakeInput.value = '75';
  state.selectedAltitude = state.currentAltitude + 10;
  elements.altitudeInput.value = String(state.selectedAltitude);
  elements.altitudeRange.value = String(state.selectedAltitude);
  state.lastTickAtMs = now;
  state.timeline = [{ timeMs: now, altitudeTicks: state.currentAltitude }];
  bindEvents();
  syncStakeBounds();
  syncAltitudeBounds();
  seedInitialTraffic(now);
  renderUi(now);
  requestAnimationFrame(animationLoop);
}

init();
