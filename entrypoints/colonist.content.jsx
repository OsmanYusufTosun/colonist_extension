import ReactDOM from "react-dom/client";
import { createShadowRootUi, defineContentScript, injectScript } from "#imports";
import ColonistOverlay from "../src/ColonistOverlay.jsx";
import "../src/content.css";

const COLONIST_MATCHES = ["https://colonist.io/*", "https://*.colonist.io/*"];

export default defineContentScript({
  matches: COLONIST_MATCHES,
  runAt: "document_start",
  cssInjectionMode: "ui",
  async main(ctx) {
    try {
      await injectScript("/colonist-main-world.js", {
        keepInDom: true
      });
    } catch (error) {
      console.warn("[Colonist Stats Helper] Failed to inject main-world hook", error);
    }

    startColonistHelper(ctx);
  }
});

function startColonistHelper(ctx) {
  "use strict";

  const SOURCE = "colonist-stats-helper";
  const STORAGE_KEY = "colonistStatsHelper.events.v1";
  const SETTINGS_KEY = "colonistStatsHelper.settings.v1";
  const MAX_EVENTS = 1000;
  const SCAN_INTERVAL_MS = 1200;
  const SAVE_DELAY_MS = 250;
  const HISTORY_SCAN_SETTLE_MS = 220;
  const HISTORY_SCAN_STEP_RATIO = 0.28;
  const HISTORY_SCAN_MIN_STEP_PX = 24;
  const HISTORY_SCAN_MAX_STEPS = 900;
  const HISTORY_SCAN_READS_PER_STEP = 2;
  const NEAR_BOTTOM_PX = 48;
  const LOCAL_USER_SCAN_INTERVAL_MS = 5000;

  const ACTION_WORDS = [
    "placed",
    "built",
    "rolled",
    "got",
    "received",
    "discarded",
    "stole",
    "robbed",
    "bought",
    "used",
    "traded",
    "gave",
    "took",
    "wants",
    "proposed",
    "moved",
    "blocked",
    "joined",
    "left",
    "started",
    "ended",
    "won"
  ];

  const ACTION_PATTERN = new RegExp("\\b(" + ACTION_WORDS.join("|") + ")\\b", "i");
  const ACTION_PATTERN_GLOBAL = new RegExp("\\b(" + ACTION_WORDS.join("|") + ")\\b", "gi");
  const MAX_AGGREGATE_SPLIT_PARTS = 8;
  const LOG_HINT_PATTERN = /Happy settling|List of commands|placed a|rolled|received|discarded|stole|built|bought|traded|robber|wants to give|proposed counter offer|has won/i;
  const NOISE_PATTERN =
    /^(Happy settling.*|Learn how.*|List of commands.*|\/help|Chat|Place Settlement|Place Road|Roll Dice|End Turn|.*\b\d+\s+(days?|hours?|minutes?)\s+left(?:\s+NEW)?)$/i;
  const PLAYER_TOKEN_TEXT = "[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}";
  const GENERIC_DISCONNECTION_PATTERN = new RegExp(
    "\\b" +
      PLAYER_TOKEN_TEXT +
      "\\s+has\\s+disconnected\\.\\s*A\\s+bot\\s+will\\s+take\\s+over\\s+next\\s+turn\\s+unless\\s+" +
      PLAYER_TOKEN_TEXT +
      "\\s+reconnects\\.?",
    "gi"
  );
  const GENERIC_RECONNECTION_PATTERN = new RegExp("\\b" + PLAYER_TOKEN_TEXT + "\\s+has\\s+reconnected\\b\\.?", "gi");
  const CONNECTION_STATUS_TEXT_PATTERN = /\b(?:has\s+(?:disconnected|reconnected)|reconnects?\b|A\s+bot\s+will\s+take\s+over\s+next\s+turn)\b/i;
  const COUNTDOWN_TEXT_PATTERN = /\b\d+\s+(?:days?|hours?|minutes?)(?:\s+left)?(?:\s+NEW)?$/i;
  const RESOURCE_ALIASES = [
    { token: "lumber", pattern: /\b(lumber|wood|tree|forest)\b/i },
    { token: "brick", pattern: /\b(brick|clay)\b/i },
    { token: "wool", pattern: /\b(wool|sheep|pasture)\b/i },
    { token: "grain", pattern: /\b(grain|wheat|crop|field)\b/i },
    { token: "ore", pattern: /\b(ore|rock|stone|mountain)\b/i }
  ];
  const RESOURCE_TYPES = RESOURCE_ALIASES.map((resource) => resource.token);
  const BUILD_COSTS = {
    road: { lumber: 1, brick: 1 },
    settlement: { lumber: 1, brick: 1, wool: 1, grain: 1 },
    city: { grain: 2, ore: 3 },
    devCard: { wool: 1, grain: 1, ore: 1 }
  };
  const TRANSIENT_PLAYER_NAME_PATTERN = /^(bot|bot\s*\d+|ai|computer)$/i;
  const NUMBER_WORDS = new Map([
    ["one", 1],
    ["two", 2],
    ["three", 3],
    ["four", 4],
    ["five", 5],
    ["six", 6]
  ]);

  const state = {
    events: [],
    settings: {
      paused: false,
      overlayLeft: null,
      overlayTop: null,
      overlayWidth: null,
      overlayHeight: null
    },
    logContainer: null,
    logScrollContainer: null,
    domObserver: null,
    domSyncTimer: null,
    lastVisibleLines: [],
    lastVisibleRecords: [],
    saveTimer: null,
    domScanCount: 0,
    wsFrames: 0,
    wsTextFrames: 0,
    wsTextSamples: [],
    historyScanRunning: false,
    historyScanStatus: "",
    localUserName: "",
    localUserSource: "",
    localUserDomCandidates: [],
    lastLocalUserScanAt: 0,
    lastDomReadAt: null,
    lastWsAt: null,
    monopolyDrafts: {},
    sourceStatus: {
      dom: "searching",
      ws: "waiting"
    }
  };

  let overlayReactRoot = null;
  let overlayUi = null;
  const overlayActions = {
    clearEvents,
    togglePaused,
    scanHistory: scanExistingLogHistory,
    exportEvents,
    exportLogSample,
    setMonopolyResource,
    setMonopolyLeftTotal,
    saveMonopolyCorrection,
    saveOverlayPosition,
    saveOverlaySize
  };

  ctx.addEventListener(window, "message", handlePageMessage);
  loadState().then(() => {
    whenBodyReady(() => {
      createOverlay(ctx)
        .then(() => render())
        .catch((error) => {
          console.warn("[Colonist Stats Helper] Overlay mount failed", error);
        });
    });

    ctx.setTimeout(syncDomLog, 400);
    ctx.setInterval(syncDomLog, SCAN_INTERVAL_MS);
  });

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });
  }

  function storageSet(values) {
    return new Promise((resolve) => {
      chrome.storage.local.set(values, resolve);
    });
  }

  function syncLocalUserIdentity(force = false) {
    const now = Date.now();

    if (!force && now - state.lastLocalUserScanAt < LOCAL_USER_SCAN_INTERVAL_MS) {
      return;
    }

    state.lastLocalUserScanAt = now;
    const domUserName = detectDomLocalUserName();

    if (domUserName) {
      state.localUserName = domUserName;
      state.localUserSource = "profile-dom";
      return;
    }

    const storedUserName = detectStoredLocalUserName();

    if (storedUserName && state.localUserSource !== "profile-dom") {
      state.localUserName = storedUserName;
      state.localUserSource = "storage";
    }
  }

  function detectDomLocalUserName() {
    const candidates = collectDomLocalUserNameCandidates();
    state.localUserDomCandidates = candidates.slice(0, 8).map(describeLocalUserDomCandidate);
    return chooseDomLocalUserName(candidates);
  }

  function collectDomLocalUserNameCandidates() {
    const candidates = [];
    const nodes = Array.from(document.querySelectorAll("span, div, button, [aria-label], [title]"));

    for (const node of nodes) {
      if (!(node instanceof HTMLElement) || shouldIgnoreLocalUserCandidateElement(node) || !isVisibleEnough(node)) {
        continue;
      }

      const rect = node.getBoundingClientRect();

      if (!isInLocalProfileRegion(rect)) {
        continue;
      }

      const values = [getDirectText(node), node.getAttribute("aria-label") || "", node.getAttribute("title") || ""];

      for (const value of values) {
        const name = cleanPlayerName(value);

        if (!isLikelyProfileUserName(name)) {
          continue;
        }

        candidates.push({
          name,
          score: scoreDomLocalUserNameCandidate(node, rect),
          rect
        });
      }
    }

    return mergeLocalUserDomCandidates(candidates).sort((first, second) => second.score - first.score);
  }

  function shouldIgnoreLocalUserCandidateElement(element) {
    return (
      element.id === "colonist-stats-helper-root" ||
      Boolean(element.closest("#colonist-stats-helper-root")) ||
      Boolean(state.logContainer && (state.logContainer === element || state.logContainer.contains(element)))
    );
  }

  function isInLocalProfileRegion(rect) {
    const viewportWidth = Math.max(window.innerWidth || 0, 1);
    const viewportHeight = Math.max(window.innerHeight || 0, 1);
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    return (
      centerX >= viewportWidth * 0.62 &&
      centerY >= viewportHeight * 0.82 &&
      rect.width >= 8 &&
      rect.width <= viewportWidth * 0.35 &&
      rect.height >= 8 &&
      rect.height <= viewportHeight * 0.18
    );
  }

  function isLikelyProfileUserName(name) {
    if (!isLikelyStoredPlayerName(name)) {
      return false;
    }

    return !/^(bank|chat|colonist|dice|end|game|menu|profile|resources?|settings|shop|trade|turn|vps?)$/i.test(name);
  }

  function scoreDomLocalUserNameCandidate(element, rect) {
    const viewportWidth = Math.max(window.innerWidth || 0, 1);
    const viewportHeight = Math.max(window.innerHeight || 0, 1);
    const style = window.getComputedStyle(element);
    const descriptor = getStorageKeyWords(
      [
        element.id,
        element.className,
        element.getAttribute("data-testid") || "",
        element.getAttribute("aria-label") || "",
        describeAncestorClasses(element, 3)
      ].join(" ")
    );
    let score = 6;

    score += Math.max(0, Math.round(((rect.right / viewportWidth) - 0.62) * 8));
    score += Math.max(0, Math.round(((rect.bottom / viewportHeight) - 0.82) * 20));

    if (Number(style.fontWeight || "0") >= 600) {
      score += 2;
    }

    if (hasAnyWord(descriptor, ["account", "avatar", "me", "name", "player", "profile", "self", "user", "username"])) {
      score += 4;
    }

    return score;
  }

  function describeAncestorClasses(element, depth) {
    const parts = [];
    let node = element.parentElement;

    while (node && node instanceof HTMLElement && parts.length < depth) {
      parts.push([node.id, node.className, node.getAttribute("data-testid") || ""].filter(Boolean).join(" "));
      node = node.parentElement;
    }

    return parts.join(" ");
  }

  function mergeLocalUserDomCandidates(candidates) {
    const bestByName = new Map();

    for (const candidate of candidates) {
      const existing = bestByName.get(candidate.name);

      if (!existing || candidate.score > existing.score) {
        bestByName.set(candidate.name, candidate);
      }
    }

    return Array.from(bestByName.values());
  }

  function chooseDomLocalUserName(candidates) {
    if (!candidates.length || candidates[0].score < 7) {
      return "";
    }

    if (candidates[1] && candidates[0].score - candidates[1].score < 2) {
      return "";
    }

    return candidates[0].name;
  }

  function describeLocalUserDomCandidate(candidate) {
    return {
      name: candidate.name,
      score: candidate.score,
      rect: {
        left: Math.round(candidate.rect.left),
        top: Math.round(candidate.rect.top),
        width: Math.round(candidate.rect.width),
        height: Math.round(candidate.rect.height)
      }
    };
  }

  function detectStoredLocalUserName() {
    const candidates = [];

    try {
      collectStorageUserNameCandidates(window.localStorage, "localStorage", candidates);
    } catch (_error) {
      // Accessing storage itself can throw in locked-down browser contexts.
    }

    try {
      collectStorageUserNameCandidates(window.sessionStorage, "sessionStorage", candidates);
    } catch (_error) {
      // Accessing storage itself can throw in locked-down browser contexts.
    }

    return chooseStoredLocalUserName(candidates);
  }

  function collectStorageUserNameCandidates(storage, storageType, candidates) {
    if (!storage) {
      return;
    }

    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);

        if (!key) {
          continue;
        }

        const value = storage.getItem(key);

        collectStoredValueUserNameCandidates(value, key, [storageType, key], candidates, 0);

        try {
          collectStoredValueUserNameCandidates(JSON.parse(value), key, [storageType, key], candidates, 0);
        } catch (_error) {
          // Most storage values are plain strings; only JSON values need a deep scan.
        }
      }
    } catch (_error) {
      // Storage can be unavailable under some browser privacy settings.
    }
  }

  function collectStoredValueUserNameCandidates(value, storageKey, path, candidates, depth) {
    if (depth > 8 || value == null) {
      return;
    }

    if (typeof value === "string") {
      const playerName = cleanPlayerName(value);

      if (isLikelyStoredPlayerName(playerName)) {
        const leafKey = path[path.length - 1] || storageKey;
        const score = scoreStoredUserNameCandidate(storageKey, path, leafKey);

        if (score >= 8) {
          candidates.push({
            name: playerName,
            score
          });
        }
      }

      return;
    }

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        collectStoredValueUserNameCandidates(value[index], storageKey, path.concat(String(index)), candidates, depth + 1);
      }

      return;
    }

    if (typeof value === "object") {
      for (const key of Object.keys(value)) {
        collectStoredValueUserNameCandidates(value[key], storageKey, path.concat(key), candidates, depth + 1);
      }
    }
  }

  function isLikelyStoredPlayerName(value) {
    return /^[A-Za-z0-9_][A-Za-z0-9_.-]{1,39}$/.test(value) && !isInvalidPlayerName(value);
  }

  function scoreStoredUserNameCandidate(storageKey, path, leafKey) {
    const leafWords = getStorageKeyWords(leafKey);
    const contextWords = getStorageKeyWords([storageKey].concat(path).join(" "));
    let score = 0;

    if (hasWords(leafWords, ["username"]) || hasWords(leafWords, ["user", "name"])) {
      score += 8;
    } else if (hasWords(leafWords, ["player", "name"]) || hasWords(leafWords, ["display", "name"]) || hasWords(leafWords, ["nick", "name"])) {
      score += 6;
    } else if (hasWords(leafWords, ["name"]) && hasAnyWord(contextWords, ["account", "auth", "current", "me", "profile", "self", "user"])) {
      score += 3;
    }

    if (hasAnyWord(contextWords, ["account", "auth", "current", "me", "profile", "self", "user"])) {
      score += 4;
    }

    if (hasAnyWord(contextWords, ["opponent", "opponents", "players", "room", "state"])) {
      score -= 4;
    }

    return score;
  }

  function getStorageKeyWords(value) {
    return String(value || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[^A-Za-z0-9]+/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  function hasWords(words, requiredWords) {
    return requiredWords.every((word) => words.includes(word));
  }

  function hasAnyWord(words, candidateWords) {
    return candidateWords.some((word) => words.includes(word));
  }

  function chooseStoredLocalUserName(candidates) {
    const bestByName = new Map();

    for (const candidate of candidates) {
      const existing = bestByName.get(candidate.name);

      if (!existing || candidate.score > existing.score) {
        bestByName.set(candidate.name, candidate);
      }
    }

    const ranked = Array.from(bestByName.values()).sort((first, second) => second.score - first.score);

    if (!ranked.length || ranked[0].score < 8) {
      return "";
    }

    if (ranked[1] && ranked[0].score - ranked[1].score < 2) {
      return "";
    }

    return ranked[0].name;
  }

  async function loadState() {
    const stored = await storageGet([STORAGE_KEY, SETTINGS_KEY]);

    if (Array.isArray(stored[STORAGE_KEY])) {
      state.events = stored[STORAGE_KEY].slice(-MAX_EVENTS);
    }

    if (stored[SETTINGS_KEY] && typeof stored[SETTINGS_KEY] === "object") {
      state.settings = {
        ...state.settings,
        ...stored[SETTINGS_KEY]
      };
    }
  }

  function saveEventsSoon() {
    window.clearTimeout(state.saveTimer);

    state.saveTimer = window.setTimeout(() => {
      storageSet({ [STORAGE_KEY]: state.events });
    }, SAVE_DELAY_MS);
  }

  function saveSettingsSoon() {
    storageSet({ [SETTINGS_KEY]: state.settings });
  }

  function whenBodyReady(callback) {
    if (document.body) {
      callback();
      return;
    }

    document.addEventListener("DOMContentLoaded", callback, { once: true });
  }

  function handlePageMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== SOURCE) {
      return;
    }

    if (event.data.type === "ws-hook-ready") {
      state.sourceStatus.ws = "hooked";
      render();
      return;
    }

    if (event.data.type === "ws-opened") {
      state.sourceStatus.ws = "active";
      render();
      return;
    }

    if (event.data.type === "ws-frame") {
      handleWebSocketFrame(event.data.payload);
    }
  }

  function handleWebSocketFrame(payload) {
    state.wsFrames += 1;
    state.lastWsAt = Date.now();

    if (payload && payload.data && payload.data.kind === "text") {
      state.wsTextFrames += 1;
      state.sourceStatus.ws = "readable";
      rememberWebSocketTextSample(payload);

      if (!state.settings.paused) {
        const lines = extractCandidateLinesFromNetworkText(payload.data.text);

        for (const line of lines) {
          appendEvent(line, "ws", {
            direction: payload.direction || "",
            url: payload.url || ""
          });
        }
      }
    } else {
      state.sourceStatus.ws = "active";
    }

    render();
  }

  function rememberWebSocketTextSample(payload) {
    const text = String(payload.data.text || "");
    const extractedStrings = [];

    try {
      collectStrings(JSON.parse(text.trim()), extractedStrings, 0);
    } catch (_error) {
      extractedStrings.push(...linesFromText(text));
    }

    state.wsTextSamples.push({
      timestamp: payload.timestamp || new Date().toISOString(),
      direction: payload.direction || "",
      url: payload.url || "",
      size: payload.data.size || text.length,
      textPreview: text.slice(0, 2000),
      extractedStrings: extractedStrings.slice(0, 40).map((value) => String(value).slice(0, 300)),
      likelyLogLines: extractedStrings.map((line) => normalizeGameplayLogLine(line)).filter(isLikelyLogLine).slice(0, 20)
    });

    if (state.wsTextSamples.length > 30) {
      state.wsTextSamples = state.wsTextSamples.slice(-30);
    }
  }

  function syncDomLog() {
    state.domScanCount += 1;

    if (state.settings.paused || state.historyScanRunning) {
      render();
      return;
    }

    const existingContainer =
      state.logContainer && document.contains(state.logContainer) && isVisible(state.logContainer)
        ? state.logContainer
        : null;

    const container = existingContainer || findGameLogContainer();

    if (!container) {
      disconnectDomObserver();
      state.sourceStatus.dom = "searching";
      render();
      return;
    }

    if (state.logContainer !== container) {
      watchLogContainer(container);
    }

    state.sourceStatus.dom = "connected";

    if (!shouldCaptureLiveDom(container)) {
      state.sourceStatus.dom = "viewing history";
      render();
      return;
    }

    const records = extractVisibleLogRecords(container).filter((record) => isLikelyLogLine(record.text));

    if (!records.length) {
      render();
      return;
    }

    const newRecords = state.lastVisibleRecords.length
      ? getNewVisibleRecords(state.lastVisibleRecords, records)
      : getInitialRecords(records);

    for (const record of newRecords) {
      appendEvent(record.text, "dom", getRecordEventExtra(record));
    }

    state.lastVisibleRecords = records;
    state.lastVisibleLines = records.map((record) => record.text);
    state.lastDomReadAt = Date.now();
    render();
  }

  function watchLogContainer(container) {
    if (state.domObserver) {
      state.domObserver.disconnect();
      state.domObserver = null;
    }

    state.logContainer = container;
    state.domObserver = new MutationObserver(() => {
      window.clearTimeout(state.domSyncTimer);
      state.domSyncTimer = window.setTimeout(syncDomLog, 80);
    });

    state.domObserver.observe(container, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function disconnectDomObserver() {
    if (state.domObserver) {
      state.domObserver.disconnect();
      state.domObserver = null;
    }

    state.logContainer = null;
    state.logScrollContainer = null;
  }

  function shouldCaptureLiveDom(container) {
    const scrollContainer = getLogScrollContainer(container);

    if (!scrollContainer) {
      return true;
    }

    return isNearScrollBottom(scrollContainer);
  }

  function getLogScrollContainer(container) {
    if (
      state.logScrollContainer &&
      document.contains(state.logScrollContainer) &&
      (state.logScrollContainer === container || state.logScrollContainer.contains(container) || container.contains(state.logScrollContainer)) &&
      isScrollableElement(state.logScrollContainer)
    ) {
      return state.logScrollContainer;
    }

    state.logScrollContainer = findLogScrollContainer(container);
    return state.logScrollContainer;
  }

  function findLogScrollContainer(container) {
    const candidates = [];

    for (let node = container; node && node instanceof HTMLElement && node !== document.body; node = node.parentElement) {
      candidates.push(node);
    }

    candidates.push(...Array.from(container.querySelectorAll("*")).filter((node) => node instanceof HTMLElement));

    let bestNode = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const node of candidates) {
      if (!isScrollableElement(node)) {
        continue;
      }

      const score = scoreScrollContainer(node, container);

      if (score > bestScore) {
        bestNode = node;
        bestScore = score;
      }
    }

    return bestNode;
  }

  function scoreScrollContainer(node, logContainer) {
    const rect = node.getBoundingClientRect();
    const logRect = logContainer.getBoundingClientRect();
    let score = node.scrollHeight - node.clientHeight;

    if (node.className && /virtual|scroll|feed|chat/i.test(String(node.className))) {
      score += 1000;
    }

    if (node.contains(logContainer)) {
      score += 300;
    }

    if (logContainer.contains(node)) {
      score += 500;
    }

    if (rect.left >= logRect.left - 8 && rect.right <= logRect.right + 8) {
      score += 100;
    }

    return score;
  }

  function isScrollableElement(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY;
    const canScrollBySize = element.scrollHeight > element.clientHeight + 8;
    const canScrollByStyle = /(auto|scroll|overlay)/i.test(overflowY);

    return canScrollBySize && (canScrollByStyle || /virtual|scroll/i.test(String(element.className)));
  }

  function isNearScrollBottom(element) {
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    return distanceFromBottom <= Math.max(NEAR_BOTTOM_PX, element.clientHeight * 0.12);
  }

  function getInitialRecords(records) {
    const eventTail = state.events.slice(-records.length).map((eventRecord) => eventRecord.raw);
    const lines = records.map((record) => record.text);

    if (arraysEqual(eventTail, lines)) {
      return [];
    }

    return records.filter((record) => !hasRecordedDomRecord(record));
  }

  function getNewVisibleRecords(previousRecords, currentRecords) {
    if (recordsHaveStableIndexes(previousRecords) && recordsHaveStableIndexes(currentRecords)) {
      const previousMaxIndex = Math.max(...previousRecords.map((record) => record.index));

      return currentRecords.filter((record) => record.index > previousMaxIndex && !hasRecordedDomRecord(record));
    }

    const previousLines = previousRecords.map((record) => record.text);
    const currentLines = currentRecords.map((record) => record.text);
    const maxOverlap = Math.min(previousLines.length, currentLines.length);

    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      const previousTail = previousLines.slice(previousLines.length - overlap);
      const currentHead = currentLines.slice(0, overlap);

      if (arraysEqual(previousTail, currentHead)) {
        return currentRecords.slice(overlap).filter((record) => !hasRecordedDomRecord(record));
      }
    }

    const recentRawLines = new Set(state.events.slice(-50).map((eventRecord) => eventRecord.raw));
    return currentRecords.filter((record) => !recentRawLines.has(record.text) && !hasRecordedDomRecord(record));
  }

  function recordsHaveStableIndexes(records) {
    return records.length > 0 && records.every((record) => Number.isFinite(record.index));
  }

  function hasRecordedDomRecord(record) {
    if (Number.isFinite(record.index)) {
      return state.events.some((eventRecord) => eventRecord.domIndex === record.index && eventRecord.raw === record.text);
    }

    return false;
  }

  function getRecordEventExtra(record) {
    return {
      domIndex: record.index,
      domKey: record.key,
      playerPlacement: record.playerPlacement || "",
      playerPlacements: Array.isArray(record.playerPlacements) ? record.playerPlacements : [],
      isUserAction: Boolean(record.isUserAction),
      userName: record.userPlayerName || "",
      userPlacement: record.userPlacement || "",
      userIdentitySource: record.userIdentitySource || ""
    };
  }

  function arraysEqual(first, second) {
    if (first.length !== second.length) {
      return false;
    }

    for (let index = 0; index < first.length; index += 1) {
      if (first[index] !== second[index]) {
        return false;
      }
    }

    return true;
  }

  function findGameLogContainer() {
    const nodes = Array.from(document.querySelectorAll("div, section, aside, main, [role='log'], [aria-live]"));
    let bestNode = null;
    let bestScore = 0;
    let bestArea = Number.POSITIVE_INFINITY;

    for (const node of nodes) {
      if (!(node instanceof HTMLElement) || node.id === "colonist-stats-helper-root" || node.closest("#colonist-stats-helper-root")) {
        continue;
      }

      const score = scoreLogCandidate(node);

      if (score < 4) {
        continue;
      }

      const rect = node.getBoundingClientRect();
      const area = rect.width * rect.height;

      if (score > bestScore || (score === bestScore && area < bestArea)) {
        bestNode = node;
        bestScore = score;
        bestArea = area;
      }
    }

    return bestNode;
  }

  function scoreLogCandidate(node) {
    if (!isVisible(node)) {
      return Number.NEGATIVE_INFINITY;
    }

    const rect = node.getBoundingClientRect();
    const text = normalizeText(node.innerText || node.textContent || "");

    if (!text || text.length < 12 || text.length > 5000) {
      return Number.NEGATIVE_INFINITY;
    }

    let score = 0;

    if (rect.left >= window.innerWidth * 0.55) {
      score += 4;
    }

    if (rect.top <= window.innerHeight * 0.55) {
      score += 2;
    }

    if (/Happy settling|List of commands/i.test(text)) {
      score += 8;
    }

    if (LOG_HINT_PATTERN.test(text)) {
      score += 5;
    }

    const actionMatches = text.match(ACTION_PATTERN_GLOBAL) || [];
    score += Math.min(actionMatches.length, 8);

    const lines = linesFromText(text);

    if (lines.length >= 2) {
      score += 2;
    }

    if (lines.length >= 4) {
      score += 2;
    }

    if (/^Chat$/i.test(text.trim())) {
      score -= 10;
    }

    if (/Place Settlement|Place Road|End Turn|Roll Dice/i.test(text)) {
      score -= 5;
    }

    const pageArea = Math.max(window.innerWidth * window.innerHeight, 1);
    const area = rect.width * rect.height;

    if (area > pageArea * 0.4) {
      score -= 12;
    }

    return score;
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);

    return (
      rect.width >= 180 &&
      rect.height >= 40 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0
    );
  }

  function extractLogEntries(container) {
    return extractVisibleLogRecords(container)
      .map((record) => record.text)
      .filter(isLikelyLogLine);
  }

  function extractVisualLogLines(container) {
    return extractVisibleLogRecords(container).map((record) => ({
      text: record.text,
      images: record.images,
      element: record.element,
      index: record.index,
      playerPlacement: record.playerPlacement,
      playerPlacements: record.playerPlacements,
      isUserAction: Boolean(record.isUserAction),
      userPlayerName: record.userPlayerName || "",
      userPlacement: record.userPlacement || "",
      userIdentitySource: record.userIdentitySource || ""
    }));
  }

  function extractVisibleLogRecords(container) {
    const rowElements = findLogRowElements(container);

    if (rowElements.length) {
      return rowElements.map((element) => makeVisualRecord(element, { includeIdentity: true })).filter((record) => record.text);
    }

    return linesFromVisualText(container).map((text) => ({
      text,
      images: [],
      element: null,
      index: null,
      key: "text:" + text,
      playerPlacement: "",
      playerPlacements: [],
      isUserAction: false,
      userPlayerName: "",
      userPlacement: "",
      userIdentitySource: ""
    }));
  }

  function findLogRowElements(container) {
    const nodes = Array.from(container.querySelectorAll("*")).filter((node) => node instanceof HTMLElement && isVisibleEnough(node));
    const candidates = [];

    for (const node of nodes) {
      const line = makeVisualRecord(node);

      if (!isLikelyLogLine(line.text)) {
        continue;
      }

      candidates.push({
        node,
        line,
        rect: node.getBoundingClientRect()
      });
    }

    const rowCandidates = chooseBestLogRowCandidates(candidates);

    return rowCandidates
      .sort((first, second) => {
        const verticalDistance = first.rect.top - second.rect.top;

        if (Math.abs(verticalDistance) > 2) {
          return verticalDistance;
        }

        return first.rect.left - second.rect.left;
      })
      .filter((candidate, index, sortedCandidates) => {
        return !sortedCandidates.slice(0, index).some((previous) => {
          return candidate.line.text === previous.line.text && Math.abs(candidate.rect.top - previous.rect.top) < 3;
        });
      })
      .map((candidate) => candidate.node);
  }

  function chooseBestLogRowCandidates(candidates) {
    const candidatesByRow = new Map();

    for (const candidate of candidates) {
      const rowKey = getLogRowGroupKey(candidate.node);
      const existingCandidate = candidatesByRow.get(rowKey);

      if (!existingCandidate || scoreVisualLogCandidate(candidate) > scoreVisualLogCandidate(existingCandidate)) {
        candidatesByRow.set(rowKey, candidate);
      }
    }

    return Array.from(candidatesByRow.values()).filter((candidate, _index, groupedCandidates) => {
      if (isAggregateLogCandidate(candidate, groupedCandidates)) {
        return false;
      }

      return !groupedCandidates.some((other) => {
        return other !== candidate && other.node.contains(candidate.node) && other.line.text === candidate.line.text;
      });
    });
  }

  function isAggregateLogCandidate(candidate, groupedCandidates) {
    if (candidate.node.closest("[data-index]")) {
      return false;
    }

    const childRows = new Set();

    for (const other of groupedCandidates) {
      if (other === candidate || !candidate.node.contains(other.node)) {
        continue;
      }

      const childRow = other.node.closest("[data-index]");

      if (childRow) {
        childRows.add(childRow);
      }
    }

    return childRows.size > 1;
  }

  function getLogRowGroupKey(node) {
    const indexedElement = node.closest("[data-index]");

    if (indexedElement) {
      return indexedElement;
    }

    return node;
  }

  function scoreVisualLogCandidate(candidate) {
    const visualTokens = extractVisualTokens(candidate.line.text);
    let score = candidate.line.text.length;

    if (/\b(Knight|Monopoly|Road Building|Year of Plenty)\b/i.test(candidate.line.text)) {
      score += 40;
    }

    score += visualTokens.resources.length * 8;
    score += visualTokens.dice.length * 3;

    if (candidate.node.className && /feed|message|row/i.test(String(candidate.node.className))) {
      score += 4;
    }

    return score;
  }

  function makeVisualRecord(element, options = {}) {
    const images = [];
    const rawText = normalizeLine(readVisualText(element, images));
    const index = getLogRowIndex(element);
    const playerPlacements = extractPlayerPlacements(element, rawText);
    const text = normalizeGameplayLogLine(rawText, { playerPlacements });
    const parsed = parseLogLine(text);
    const playerPlacement = findPlayerPlacement(playerPlacements, parsed.player);
    const userIdentity = options.includeIdentity ? extractSelfUserIdentity(parsed, playerPlacements) : {};

    return {
      text,
      images,
      playerPlacement,
      playerPlacements,
      isUserAction: Boolean(userIdentity.isUserAction),
      userPlayerName: userIdentity.userPlayerName || "",
      userPlacement: userIdentity.userPlacement || "",
      userIdentitySource: userIdentity.userIdentitySource || "",
      element: describeElement(element),
      index,
      key: Number.isFinite(index) ? "index:" + index + ":" + text : "text:" + text
    };
  }

  function getLogRowIndex(element) {
    const indexedElement = element.closest("[data-index]");

    if (!indexedElement) {
      return null;
    }

    const index = Number(indexedElement.getAttribute("data-index"));
    return Number.isFinite(index) ? index : null;
  }

  function getLogRowContextElement(element) {
    return element.closest("[data-index]") || element;
  }

  function extractSelfUserIdentity(parsed, playerPlacements) {
    if (!isUserPlaceholderName(parsed.player)) {
      return {
        isUserAction: false,
        userPlayerName: "",
        userPlacement: "",
        userIdentitySource: ""
      };
    }

    const actor = cleanPlayerName(parsed.player);
    const actorPlacement = findPlayerPlacement(playerPlacements, actor);

    return {
      isUserAction: true,
      userPlayerName: "",
      userPlacement: actorPlacement,
      userIdentitySource: "self-text"
    };
  }

  function extractPlayerPlacements(element, raw) {
    const rawText = normalizeLine(raw);
    const nodes = [element, ...Array.from(element.querySelectorAll("*"))].filter((node) => node instanceof HTMLElement);
    const placements = [];
    const seen = new Set();

    for (const node of nodes) {
      const name = cleanPlayerName(getDirectText(node));

      if (!isLikelyPlayerNameCandidate(name, rawText)) {
        continue;
      }

      const placement = getElementPlacementKey(node);

      if (!placement) {
        continue;
      }

      const key = placement + ":" + name.toLowerCase();

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      placements.push({ name, placement });
    }

    return placements;
  }

  function getDirectText(element) {
    return Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.nodeValue || "")
      .join(" ");
  }

  function isLikelyPlayerNameCandidate(name, rawText) {
    if (!name || name.length > 40 || !rawText.toLowerCase().includes(name.toLowerCase())) {
      return false;
    }

    if (/[\[\]]/.test(name) || /^\+?\d+\s*VPs?$/i.test(name) || ACTION_PATTERN.test(name) || isInvalidPlayerName(name)) {
      return false;
    }

    return !RESOURCE_ALIASES.some((resource) => resource.pattern.test(name));
  }

  function getElementPlacementKey(element) {
    const inlineStyle = element.getAttribute("style") || "";
    const computedStyle = window.getComputedStyle(element);
    const fontWeight = Number(computedStyle.fontWeight) || 0;
    const hasPlayerStyle = /\bcolor\s*:/i.test(inlineStyle) || /\bfont-weight\s*:/i.test(inlineStyle) || fontWeight >= 600;

    if (!hasPlayerStyle) {
      return "";
    }

    return normalizePlacementKey(computedStyle.color || element.style.color || "");
  }

  function normalizePlacementKey(value) {
    const color = String(value || "").trim().toLowerCase();

    if (!color) {
      return "";
    }

    const rgbMatch = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)$/);

    if (rgbMatch) {
      return (
        "#" +
        [rgbMatch[1], rgbMatch[2], rgbMatch[3]]
          .map((part) => Number(part).toString(16).padStart(2, "0"))
          .join("")
      );
    }

    const shortHexMatch = color.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);

    if (shortHexMatch) {
      return "#" + shortHexMatch.slice(1).map((part) => part + part).join("").toLowerCase();
    }

    return color.replace(/\s+/g, "");
  }

  function findPlayerPlacement(playerPlacements, playerName) {
    const player = cleanPlayerName(playerName).toLowerCase();

    if (!player || !Array.isArray(playerPlacements)) {
      return "";
    }

    const match = playerPlacements.find((candidate) => cleanPlayerName(candidate.name).toLowerCase() === player);
    return match ? match.placement : "";
  }

  function linesFromVisualText(element) {
    return readVisualText(element, [])
      .split("\n")
      .map((line) => normalizeGameplayLogLine(line))
      .filter(Boolean);
  }

  function readVisualText(node, images, options = {}) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || "";
    }

    if (!(node instanceof HTMLElement || node instanceof SVGElement)) {
      return "";
    }

    if (node instanceof HTMLElement && isHiddenForText(node)) {
      return "";
    }

    const parts = [];
    const imageDescriptor = getImageDescriptor(node);

    if (imageDescriptor) {
      images.push(imageDescriptor);

      if (imageDescriptor.token || options.includeUnknownImages) {
        parts.push(imageDescriptor.token || "[image]");
      }
    }

    for (const child of node.childNodes) {
      parts.push(readVisualText(child, images, options));
    }

    const joined = joinVisualParts(parts);

    if (node instanceof HTMLElement && shouldAddLineBreak(node)) {
      return "\n" + joined + "\n";
    }

    return joined;
  }

  function joinVisualParts(parts) {
    return parts
      .filter(Boolean)
      .join(" ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ");
  }

  function getImageDescriptor(element) {
    const descriptor = createImageDescriptor(element, "");

    if (!isImageLikeElement(element, descriptor)) {
      return null;
    }

    descriptor.token = tokenFromImageDescriptor(descriptor);
    return descriptor;
  }

  function tokenFromImageDescriptor(descriptor) {
    const haystack = descriptorToSearchText(descriptor);

    for (const resource of RESOURCE_ALIASES) {
      if (resource.pattern.test(haystack)) {
        return "[" + resource.token + "]";
      }
    }

    const dieValue = findDieValue(haystack);

    if (dieValue) {
      return "[die:" + dieValue + "]";
    }

    if (/\b(di(c|e)|dice|roll)\b/i.test(haystack)) {
      return "[die]";
    }

    if (/\brobber\b/i.test(haystack)) {
      return "[robber]";
    }

    return "";
  }

  function findDieValue(haystack) {
    const normalized = haystack.toLowerCase();
    const numericMatch =
      normalized.match(/\b(?:die|dice|dice[_-]?face|roll)[^\d]{0,12}([1-6])\b/) ||
      normalized.match(/\b([1-6])[^\w]{0,4}(?:die|dice)\b/) ||
      normalized.match(/\bdice[_-]?([1-6])\b/);

    if (numericMatch) {
      return Number(numericMatch[1]);
    }

    for (const [word, value] of NUMBER_WORDS) {
      const wordPattern = new RegExp("\\b(?:die|dice|roll)[^a-z]{0,12}" + word + "\\b|\\b" + word + "[^a-z]{0,12}(?:die|dice)\\b", "i");

      if (wordPattern.test(normalized)) {
        return value;
      }
    }

    return null;
  }

  function descriptorToSearchText(descriptor) {
    return [
      descriptor.tagName,
      descriptor.id,
      descriptor.className,
      descriptor.role,
      descriptor.alt,
      descriptor.title,
      descriptor.ariaLabel,
      descriptor.src,
      descriptor.currentSrc,
      descriptor.backgroundImage,
      descriptor.backgroundPosition,
      descriptor.maskImage,
      Object.values(descriptor.dataAttributes || {}).join(" ")
    ]
      .filter(Boolean)
      .join(" ");
  }

  function isImageLikeElement(element, descriptor) {
    const tagName = descriptor.tagName;

    if (tagName === "img" || tagName === "svg" || tagName === "canvas" || descriptor.role === "img") {
      return true;
    }

    if (descriptor.backgroundImage && descriptor.backgroundImage !== "none" && isSmallIconRect(descriptor.rect)) {
      return true;
    }

    if (descriptor.maskImage && descriptor.maskImage !== "none" && isSmallIconRect(descriptor.rect)) {
      return true;
    }

    return false;
  }

  function isSmallIconRect(rect) {
    return rect.width > 4 && rect.height > 4 && rect.width <= 80 && rect.height <= 80;
  }

  function createImageDescriptor(element, token) {
    const rect = element.getBoundingClientRect();
    const style = element instanceof HTMLElement ? window.getComputedStyle(element) : null;
    const attributes = collectElementAttributes(element);

    return {
      token,
      tagName: element.tagName.toLowerCase(),
      id: element.id || "",
      className: typeof element.className === "string" ? element.className : element.getAttribute("class") || "",
      role: element.getAttribute("role") || "",
      alt: element.getAttribute("alt") || "",
      title: element.getAttribute("title") || "",
      ariaLabel: element.getAttribute("aria-label") || "",
      src: shortenUrl(element.getAttribute("src") || ""),
      currentSrc: shortenUrl(element instanceof HTMLImageElement ? element.currentSrc || "" : ""),
      backgroundImage: shortenCssValue(style ? style.backgroundImage : ""),
      backgroundPosition: style ? style.backgroundPosition : "",
      backgroundSize: style ? style.backgroundSize : "",
      maskImage: shortenCssValue(style ? style.maskImage || style.webkitMaskImage || "" : ""),
      dataAttributes: attributes.dataAttributes,
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function collectElementAttributes(element) {
    const dataAttributes = {};

    if (!element.attributes) {
      return { dataAttributes };
    }

    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.startsWith("data-")) {
        dataAttributes[attribute.name] = String(attribute.value).slice(0, 200);
      }
    }

    return { dataAttributes };
  }

  function shortenCssValue(value) {
    if (!value || value === "none") {
      return "";
    }

    return String(value).replace(/data:[^)"]+/g, (match) => "data:<" + match.length + " chars>").slice(0, 500);
  }

  function shortenUrl(value) {
    if (!value) {
      return "";
    }

    return String(value).replace(/data:.+/, (match) => "data:<" + match.length + " chars>").slice(0, 500);
  }

  function isHiddenForText(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity || "1") === 0 ||
      rect.width === 0 ||
      rect.height === 0
    );
  }

  function isVisibleEnough(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);

    return (
      rect.width > 1 &&
      rect.height > 1 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0
    );
  }

  function shouldAddLineBreak(element) {
    const display = window.getComputedStyle(element).display;

    return /^(block|flex|grid|table|list-item)$/.test(display);
  }

  function extractCandidateLinesFromNetworkText(text) {
    const strings = [];
    const trimmed = String(text || "").trim();

    if (!trimmed) {
      return strings;
    }

    try {
      collectStrings(JSON.parse(trimmed), strings, 0);
    } catch (_error) {
      strings.push(...linesFromText(trimmed));
    }

    return strings.map((line) => normalizeGameplayLogLine(line)).filter(isLikelyLogLine);
  }

  function collectStrings(value, strings, depth) {
    if (depth > 8 || value == null) {
      return;
    }

    if (typeof value === "string") {
      strings.push(value);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectStrings(item, strings, depth + 1);
      }

      return;
    }

    if (typeof value === "object") {
      for (const key of Object.keys(value)) {
        collectStrings(value[key], strings, depth + 1);
      }
    }
  }

  function linesFromText(text) {
    return normalizeText(text)
      .split("\n")
      .map(normalizeLine)
      .filter(Boolean);
  }

  function normalizeText(text) {
    return String(text || "").replace(/\r/g, "\n");
  }

  function normalizeLine(line) {
    return String(line || "")
      .replace(/[\u{1f300}-\u{1faff}]/gu, "")
      .replace(/\s+/g, " ")
      .replace(/^[\s:|.-]+/, "")
      .replace(/[\s:|.-]+$/, "")
      .trim();
  }

  function normalizeGameplayLogLine(line, metadata = {}) {
    const raw = normalizeLine(line);

    if (!raw) {
      return "";
    }

    return stripConnectionStatusText(raw, getMetadataPlayerNames(metadata));
  }

  function stripConnectionStatusText(raw, playerNames) {
    let cleaned = String(raw || "");

    for (const playerName of playerNames) {
      const player = cleanPlayerName(playerName);

      if (!player) {
        continue;
      }

      const escapedPlayer = escapeRegExp(player);

      cleaned = cleaned
        .replace(
          new RegExp(
            "(^|\\s)" +
              escapedPlayer +
              "\\s+has\\s+disconnected\\.\\s*A\\s+bot\\s+will\\s+take\\s+over\\s+next\\s+turn\\s+unless\\s+" +
              escapedPlayer +
              "\\s+reconnects\\.?",
            "gi"
          ),
          " "
        )
        .replace(new RegExp("(^|\\s)" + escapedPlayer + "\\s+has\\s+reconnected\\b\\.?", "gi"), " ");
    }

    return normalizeLine(cleaned.replace(GENERIC_DISCONNECTION_PATTERN, " ").replace(GENERIC_RECONNECTION_PATTERN, " "));
  }

  function getMetadataPlayerNames(metadata) {
    const names = [];
    const placements = Array.isArray(metadata.playerPlacements) ? metadata.playerPlacements : [];

    for (const placement of placements) {
      if (placement && placement.name) {
        names.push(placement.name);
      }
    }

    if (metadata.player) {
      names.push(metadata.player);
    }

    return names;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isLikelyLogLine(line) {
    if (!line || line.length < 4 || line.length > 240) {
      return false;
    }

    if (NOISE_PATTERN.test(line)) {
      return false;
    }

    return ACTION_PATTERN.test(line) || /\bhas won\b/i.test(line);
  }

  function appendEvent(rawLine, source, extra = {}) {
    const raw = normalizeGameplayLogLine(rawLine, extra);
    const metadata = { ...extra, source };

    if (!raw) {
      return false;
    }

    if (isAggregateLogLine(raw, metadata)) {
      return appendSplitAggregateEvents(raw, source, extra);
    }

    if (!isLikelyLogLine(raw) || wasAlreadyRecorded(raw, extra)) {
      return false;
    }

    const parsed = parseLogLine(raw);

    if (isInvalidPlayerName(parsed.player)) {
      return false;
    }

    const visualTokens = extractVisualTokens(raw);
    const createdAt = Date.now();
    const eventRecord = {
      id: makeId(),
      raw,
      player: parsed.player,
      action: parsed.action,
      detail: parsed.detail,
      tokens: visualTokens.tokens,
      resources: visualTokens.resources,
      dice: visualTokens.dice,
      rollTotal: visualTokens.rollTotal,
      source,
      createdAt,
      timestamp: new Date(createdAt).toISOString(),
      ...extra
    };

    state.events.push(eventRecord);

    if (state.events.length > MAX_EVENTS) {
      state.events = state.events.slice(-MAX_EVENTS);
    }

    saveEventsSoon();
    return true;
  }

  function appendSplitAggregateEvents(raw, source, extra) {
    const parts = splitAggregateLogLine(raw, { ...extra, source });
    let added = false;

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];

      if (!part || part === raw) {
        continue;
      }

      if (hasRecordedRaw(part)) {
        continue;
      }

      const splitExtra = {
        ...extra,
        domIndex: null,
        domKey: extra.domKey ? extra.domKey + ":part:" + index : "",
        aggregateRaw: raw,
        aggregatePart: index
      };

      if (appendEvent(part, source, splitExtra)) {
        added = true;
      }
    }

    return added;
  }

  function hasRecordedRaw(raw) {
    return state.events.some((eventRecord) => eventRecord.raw === raw);
  }

  function wasAlreadyRecorded(raw, extra) {
    if (Number.isFinite(extra.domIndex)) {
      if (state.events.some((eventRecord) => eventRecord.domIndex === extra.domIndex && eventRecord.raw === raw)) {
        return true;
      }

      return !extra.historyScan && mergeRecentUnindexedDuplicate(raw, extra);
    }

    return wasJustRecorded(raw);
  }

  function mergeRecentUnindexedDuplicate(raw, extra) {
    const now = Date.now();
    const recentEvent = state.events
      .slice()
      .reverse()
      .find((eventRecord) => {
        return (
          eventRecord.raw === raw &&
          !Number.isFinite(eventRecord.domIndex) &&
          now - Number(eventRecord.createdAt || 0) < 2000
        );
      });

    if (!recentEvent) {
      return false;
    }

    mergeDomMetadata(recentEvent, extra);
    saveEventsSoon();
    return true;
  }

  function mergeDomMetadata(eventRecord, extra) {
    eventRecord.domIndex = extra.domIndex;
    eventRecord.domKey = extra.domKey || eventRecord.domKey || "";
    eventRecord.playerPlacement = extra.playerPlacement || eventRecord.playerPlacement || "";

    if (Array.isArray(extra.playerPlacements) && extra.playerPlacements.length) {
      eventRecord.playerPlacements = extra.playerPlacements;
    }

    if (extra.isUserAction) {
      eventRecord.isUserAction = true;
    }

    if (extra.userName) {
      eventRecord.userName = extra.userName;
    }

    if (extra.userPlacement) {
      eventRecord.userPlacement = extra.userPlacement;
    }
  }

  function wasJustRecorded(raw) {
    const now = Date.now();

    return state.events
      .slice(-20)
      .some((eventRecord) => eventRecord.raw === raw && now - Number(eventRecord.createdAt || 0) < 2000);
  }

  function isAggregateLogLine(raw, metadata = {}) {
    if (metadata.source && metadata.source !== "dom" && metadata.source !== "hist") {
      return false;
    }

    if (Number.isFinite(metadata.domIndex)) {
      return false;
    }

    const actionMatches = String(raw || "").match(ACTION_PATTERN_GLOBAL) || [];

    if (actionMatches.length <= 1) {
      return false;
    }

    if (actionMatches.length <= 2 && isKnownCompoundLogLine(raw)) {
      return false;
    }

    return true;
  }

  function isKnownCompoundLogLine(raw) {
    const parsed = parseLogLine(raw);
    const action = parsed.action.toLowerCase();
    const detail = String(parsed.detail || "");

    return (
      (action === "wants" && /^to\s+give\b.+\bfor\b.+$/i.test(detail)) ||
      (action === "gave" && /^bank\b.+\band\s+took\b.+$/i.test(detail)) ||
      (action === "gave" && /^.+\band\s+got\b.+\bfrom\b.+$/i.test(detail))
    );
  }

  function splitAggregateLogLine(raw, metadata = {}) {
    const names = getAggregateSplitPlayerNames(raw, metadata);

    if (!names.length) {
      return [];
    }

    const playerPattern = names.map(escapeRegExp).join("|");
    const eventStartPattern = new RegExp(
      "(^|\\s)(" + playerPattern + ")\\s+(?:" + ACTION_WORDS.join("|") + "|has\\s+won)\\b",
      "gi"
    );
    const starts = new Set([0]);
    let match = eventStartPattern.exec(raw);

    while (match) {
      const start = match.index + (match[1] ? match[1].length : 0);

      if (start > 0) {
        starts.add(start);
      }

      match = eventStartPattern.exec(raw);
    }

    const orderedStarts = Array.from(starts).sort((first, second) => first - second);

    if (orderedStarts.length <= 1 || orderedStarts.length > MAX_AGGREGATE_SPLIT_PARTS) {
      return [];
    }

    return orderedStarts
      .map((start, index) => normalizeLine(raw.slice(start, orderedStarts[index + 1] || raw.length)))
      .filter(isSafeAggregateSplitPart);
  }

  function isSafeAggregateSplitPart(part) {
    if (!part || !isLikelyLogLine(part) || isAggregateLogLine(part)) {
      return false;
    }

    const parsed = parseLogLine(part);
    return Boolean(parsed.action && !isInvalidPlayerName(parsed.player));
  }

  function getAggregateSplitPlayerNames(raw, metadata) {
    const names = [];

    for (const name of getMetadataPlayerNames(metadata)) {
      names.push(name);
    }

    const parsed = parseLogLine(raw);

    if (parsed.player) {
      names.push(parsed.player);
    }

    names.push("You");

    return Array.from(new Set(names.map(cleanPlayerName).filter((name) => name && !isInvalidPlayerName(name)))).sort(
      (first, second) => second.length - first.length
    );
  }

  function parseLogLine(raw) {
    const wonMatch = raw.match(/^(.+?)\s+has\s+won\b\s*(.*)$/i);

    if (wonMatch) {
      return {
        player: cleanPlayerName(wonMatch[1]),
        action: "won",
        detail: wonMatch[2].trim()
      };
    }

    const actionMatch = raw.match(new RegExp("^(.+?)\\s+(" + ACTION_WORDS.join("|") + ")\\b\\s*(.*)$", "i"));

    if (!actionMatch) {
      return {
        player: "",
        action: "",
        detail: raw
      };
    }

    return {
      player: cleanPlayerName(actionMatch[1]),
      action: actionMatch[2].toLowerCase(),
      detail: actionMatch[3].trim()
    };
  }

  function extractVisualTokens(raw) {
    const tokenMatches = Array.from(String(raw || "").matchAll(/\[([a-z]+)(?::([^\]]+))?\]/gi));
    const tokens = tokenMatches.map((match) => ({
      type: match[1].toLowerCase(),
      value: match[2] || ""
    }));
    const resources = tokens
      .filter((token) => RESOURCE_ALIASES.some((resource) => resource.token === token.type))
      .map((token) => token.type);
    const dice = tokens
      .filter((token) => token.type === "die" && /^[1-6]$/.test(token.value))
      .map((token) => Number(token.value));

    return {
      tokens,
      resources,
      dice,
      rollTotal: dice.length ? dice.reduce((sum, value) => sum + value, 0) : null
    };
  }

  function cleanPlayerName(playerName) {
    return String(playerName || "")
      .replace(/^[\s:|.-]+/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isInvalidPlayerName(playerName) {
    const player = cleanPlayerName(playerName);

    return !player || ACTION_PATTERN.test(player) || hasConnectionStatusText(player) || COUNTDOWN_TEXT_PATTERN.test(player);
  }

  function hasConnectionStatusText(value) {
    return CONNECTION_STATUS_TEXT_PATTERN.test(String(value || ""));
  }

  function makeId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }

  function computeResourceTracker() {
    return computeResourceTrackerThroughEvent("");
  }

  function computeResourceTrackerThroughEvent(stopEventId) {
    const tracker = makeResourceTracker();

    for (const eventRecord of state.events) {
      applyResourceEvent(tracker, eventRecord);

      if (stopEventId && eventRecord.id === stopEventId) {
        break;
      }
    }

    applyKnownLocalUserIdentity(tracker);

    return tracker;
  }

  function applyKnownLocalUserIdentity(tracker) {
    const localUserName = cleanPlayerName(state.localUserName);

    if (!localUserName || isUserPlaceholderName(localUserName) || isInvalidPlayerName(localUserName)) {
      return;
    }

    if (!tracker.players.has(localUserName) && !tracker.placementByPlayer.has(localUserName)) {
      return;
    }

    setTrackerUserName(tracker, localUserName, { allowChange: true });
  }

  function makeResourceTracker() {
    return {
      players: new Map(),
      playerByPlacement: new Map(),
      placementByPlayer: new Map(),
      robberies: [],
      userName: "",
      userPlacement: "",
      lastRobberMover: "",
      nextPlayerOrder: 0,
      issues: []
    };
  }

  function applyResourceEvent(tracker, eventRecord) {
    const raw = normalizeLine(eventRecord.raw || "");

    if (!raw) {
      return;
    }

    if (!Number.isFinite(eventRecord.domIndex) && hasConnectionStatusText(raw)) {
      return;
    }

    if (isAggregateLogLine(raw, eventRecord)) {
      return;
    }

    if (eventRecord.manualType === "monopoly") {
      applyManualMonopolyCorrection(tracker, eventRecord);
      return;
    }

    const parsed = parseLogLine(raw);
    const action = (parsed.action || eventRecord.action || "").toLowerCase();
    rememberEventPlayerPlacements(tracker, eventRecord);
    const actorPlacement = getEventPlayerPlacement(eventRecord, parsed.player) || eventRecord.playerPlacement || "";
    rememberEventUserIdentity(tracker, eventRecord, parsed.player, actorPlacement);

    if (/\bmoved\s+Robber\b/i.test(raw)) {
      const actor = canonicalPlayerName(tracker, parsed.player, actorPlacement);

      if (actor) {
        ensureTrackedPlayer(tracker, actor);
        tracker.lastRobberMover = actor;
      }

      return;
    }

    if (/\b(?:stole|robbed)\b/i.test(raw)) {
      applyStealEvent(tracker, eventRecord, raw);
      return;
    }

    if (action === "gave" && applyBankTradeEvent(tracker, eventRecord, raw)) {
      return;
    }

    if (action === "gave" && applyPlayerTradeEvent(tracker, eventRecord, raw)) {
      return;
    }

    if ((action === "took" || /\btook\s+from\s+bank\b/i.test(raw)) && applyTookFromBankEvent(tracker, eventRecord, raw)) {
      return;
    }

    if (action === "wants" && applyTradeOfferEvent(tracker, eventRecord, raw)) {
      return;
    }

    if (action === "proposed" && applyCounterOfferEvent(tracker, eventRecord, raw)) {
      return;
    }

    const actor = canonicalPlayerName(tracker, parsed.player, actorPlacement);

    if (!actor) {
      return;
    }

    if (action === "placed") {
      ensureTrackedPlayer(tracker, actor);
      return;
    }

    if (action === "received" && /\bstarting resources\b/i.test(raw)) {
      gainResources(tracker, actor, resourcesToCounts(extractResourceList(raw)));
      return;
    }

    if (action === "got") {
      gainResources(tracker, actor, resourcesToCounts(extractResourceList(raw)));
      return;
    }

    if (action === "discarded") {
      spendResources(tracker, actor, resourcesToCounts(extractResourceList(raw)), "discard");
      return;
    }

    if (action === "bought") {
      spendResources(tracker, actor, BUILD_COSTS.devCard, "development card");
      return;
    }

    if (action === "built") {
      applyBuildEvent(tracker, actor, raw);
      return;
    }

    if (action === "used") {
      applyUsedEvent(tracker, actor, raw);
    }
  }

  function rememberEventPlayerPlacements(tracker, eventRecord) {
    const placements = Array.isArray(eventRecord.playerPlacements) ? eventRecord.playerPlacements : [];

    for (const placement of placements) {
      rememberPlayerPlacement(tracker, placement.name, placement.placement);
    }

    if (eventRecord.player && eventRecord.playerPlacement) {
      rememberPlayerPlacement(tracker, eventRecord.player, eventRecord.playerPlacement);
    }
  }

  function rememberEventUserIdentity(tracker, eventRecord, actorName, actorPlacement) {
    const actor = cleanPlayerName(actorName);
    const hasSelfText = isUserPlaceholderName(actor);
    const trustedMetadata = isTrustedUserIdentityMetadata(eventRecord, actor);
    const userPlacement = normalizePlacementKey(trustedMetadata ? eventRecord.userPlacement || actorPlacement : hasSelfText ? actorPlacement : "");

    if (userPlacement) {
      rememberUserPlacement(tracker, userPlacement);
    }

    const metadataUserName = cleanPlayerName(eventRecord.userName);

    if (trustedMetadata && metadataUserName && !isUserPlaceholderName(metadataUserName) && !isInvalidPlayerName(metadataUserName)) {
      setTrackerUserName(tracker, metadataUserName);
      return;
    }

    if (trustedMetadata && actor && !isUserPlaceholderName(actor) && !isInvalidPlayerName(actor)) {
      setTrackerUserName(tracker, actor);
      return;
    }

    if (trustedMetadata || hasSelfText) {
      const placementPlayer = getKnownPlayerByPlacement(tracker, userPlacement || actorPlacement);

      if (placementPlayer) {
        setTrackerUserName(tracker, placementPlayer);
      }
    }
  }

  function isTrustedUserIdentityMetadata(eventRecord, actorName) {
    if (!eventRecord || !eventRecord.isUserAction) {
      return false;
    }

    return eventRecord.userIdentitySource === "self-text" || isUserPlaceholderName(actorName);
  }

  function rememberPlayerPlacement(tracker, playerName, placement) {
    const player = cleanPlayerName(playerName);
    const placementKey = normalizePlacementKey(placement);

    if (!player || isInvalidPlayerName(player) || !placementKey) {
      return;
    }

    const isUserPlaceholder = isUserPlaceholderName(player);

    if (isUserPlaceholder) {
      tracker.userPlacement = placementKey;
    }

    const nextPlayer = isTransientPlayerName(player) ? makePlacementPlayerName(player, placementKey) : player;
    const existingPlayer = tracker.playerByPlacement.get(placementKey);

    if (!existingPlayer) {
      tracker.playerByPlacement.set(placementKey, nextPlayer);
      tracker.placementByPlayer.set(nextPlayer, placementKey);

      if (tracker.userPlacement === placementKey && !isUserPlaceholderName(nextPlayer) && !isTransientPlayerName(nextPlayer)) {
        setTrackerUserName(tracker, nextPlayer);
      }

      return;
    }

    if (isUserPlaceholder && !isUserPlaceholderName(existingPlayer)) {
      setTrackerUserName(tracker, existingPlayer);
    }

    const preferredPlayer = choosePreferredPlacementPlayer(existingPlayer, nextPlayer);

    if (preferredPlayer !== existingPlayer) {
      mergeTrackedPlayers(tracker, existingPlayer, preferredPlayer);
    }

    tracker.playerByPlacement.set(placementKey, preferredPlayer);
    tracker.placementByPlayer.set(preferredPlayer, placementKey);
    tracker.placementByPlayer.set(nextPlayer, placementKey);

    if (tracker.userPlacement === placementKey && !isUserPlaceholderName(preferredPlayer) && !isTransientPlayerName(preferredPlayer)) {
      setTrackerUserName(tracker, preferredPlayer);
    }
  }

  function choosePreferredPlacementPlayer(existingPlayer, nextPlayer) {
    if (existingPlayer === nextPlayer) {
      return existingPlayer;
    }

    if (isUserPlaceholderName(existingPlayer) && !isUserPlaceholderName(nextPlayer) && !isTransientPlayerName(nextPlayer)) {
      return nextPlayer;
    }

    if (!isUserPlaceholderName(existingPlayer) && isUserPlaceholderName(nextPlayer)) {
      return existingPlayer;
    }

    if (isTransientPlayerName(existingPlayer) && !isTransientPlayerName(nextPlayer)) {
      return nextPlayer;
    }

    return existingPlayer;
  }

  function rememberUserPlacement(tracker, placement) {
    const placementKey = normalizePlacementKey(placement);

    if (!placementKey) {
      return;
    }

    tracker.userPlacement = placementKey;

    const placementPlayer = getKnownPlayerByPlacement(tracker, placementKey);

    if (placementPlayer) {
      setTrackerUserName(tracker, placementPlayer);
    }
  }

  function getEventPlayerPlacement(eventRecord, playerName) {
    const placements = Array.isArray(eventRecord.playerPlacements) ? eventRecord.playerPlacements : [];
    return findPlayerPlacement(placements, playerName);
  }

  function getKnownPlayerByPlacement(tracker, placement) {
    const placementKey = normalizePlacementKey(placement);

    if (!placementKey) {
      return "";
    }

    const player = tracker.playerByPlacement.get(placementKey);

    if (!player || isUserPlaceholderName(player) || isTransientPlayerName(player)) {
      return "";
    }

    return player;
  }

  function isTransientPlayerName(playerName) {
    const player = cleanPlayerName(playerName).replace(/\s+#[0-9a-f]{6}$/i, "");
    return TRANSIENT_PLAYER_NAME_PATTERN.test(player);
  }

  function isUserPlaceholderName(playerName) {
    return /^you$/i.test(cleanPlayerName(playerName));
  }

  function makePlacementPlayerName(playerName, placementKey) {
    return cleanPlayerName(playerName) + " " + normalizePlacementKey(placementKey);
  }

  function applyBankTradeEvent(tracker, eventRecord, raw) {
    const match = raw.match(/^(.+?)\s+gave\s+bank\s+(.+?)\s+and\s+took\s+(.+)$/i);

    if (!match) {
      return false;
    }

    const actor = canonicalPlayerName(tracker, match[1], getEventPlayerPlacement(eventRecord, match[1]));

    if (!actor) {
      return false;
    }

    spendResources(tracker, actor, resourcesToCounts(extractResourceList(match[2])), "bank trade");
    gainResources(tracker, actor, resourcesToCounts(extractResourceList(match[3])));
    return true;
  }

  function applyPlayerTradeEvent(tracker, eventRecord, raw) {
    const match = raw.match(/^(.+?)\s+gave\s+(.+?)\s+and\s+got\s+(.+?)\s+from\s+(.+)$/i);

    if (!match) {
      return false;
    }

    const actor = canonicalPlayerName(tracker, match[1], getEventPlayerPlacement(eventRecord, match[1]));
    const otherPlayer = canonicalPlayerName(tracker, match[4], getEventPlayerPlacement(eventRecord, match[4]));

    if (!actor || !otherPlayer) {
      return false;
    }

    const actorGave = resourcesToCounts(extractResourceList(match[2]));
    const actorGot = resourcesToCounts(extractResourceList(match[3]));

    spendResources(tracker, actor, actorGave, "player trade");
    gainResources(tracker, actor, actorGot);
    spendResources(tracker, otherPlayer, actorGot, "player trade");
    gainResources(tracker, otherPlayer, actorGave);
    return true;
  }

  function applyTookFromBankEvent(tracker, eventRecord, raw) {
    const match = raw.match(/^(.+?)\s+took\s+from\s+bank\s+(.+)$/i);

    if (!match) {
      return false;
    }

    const actor = canonicalPlayerName(tracker, match[1], getEventPlayerPlacement(eventRecord, match[1]));

    if (!actor) {
      return false;
    }

    gainResources(tracker, actor, resourcesToCounts(extractResourceList(match[2])));
    return true;
  }

  function applyTradeOfferEvent(tracker, eventRecord, raw) {
    const match = raw.match(/^(.+?)\s+wants\s+to\s+give\s+(.+?)\s+for\s+(.+)$/i);

    if (!match) {
      return false;
    }

    const actor = canonicalPlayerName(tracker, match[1], getEventPlayerPlacement(eventRecord, match[1]));

    if (!actor) {
      return false;
    }

    const offeredResources = resourcesToCounts(extractResourceList(match[2]));

    if (!hasAnyResource(offeredResources)) {
      return false;
    }

    observeMinimumResources(tracker, actor, offeredResources, "trade offer");
    return true;
  }

  function applyCounterOfferEvent(tracker, eventRecord, raw) {
    const match = raw.match(/^(.+?)\s+proposed\s+counter\s+offer\s+to\s+(.+?),\s+offering\s+(.+?)\s+for\s+(.+)$/i);

    if (!match) {
      return false;
    }

    const actor = canonicalPlayerName(tracker, match[1], getEventPlayerPlacement(eventRecord, match[1]));

    if (!actor) {
      return false;
    }

    const offeredResources = resourcesToCounts(extractResourceList(match[3]));

    if (!hasAnyResource(offeredResources)) {
      return false;
    }

    observeMinimumResources(tracker, actor, offeredResources, "counter offer");
    return true;
  }

  function applyStealEvent(tracker, eventRecord, raw) {
    const match = raw.match(/^(.+?)\s+(?:stole|robbed)(?:\s+(.*?))?\s+from\s+(.+)$/i);

    if (!match) {
      return;
    }

    const actorRaw = cleanPlayerName(match[1]);

    if (/^you$/i.test(actorRaw) && tracker.lastRobberMover) {
      setTrackerUserName(tracker, tracker.lastRobberMover);
    }

    const actor = canonicalPlayerName(tracker, actorRaw, getEventPlayerPlacement(eventRecord, actorRaw));
    const victim = canonicalPlayerName(tracker, match[3], getEventPlayerPlacement(eventRecord, match[3]));

    if (!actor || !victim) {
      return;
    }

    const stolenResources = extractResourceList(match[2] || "");

    if (stolenResources.length) {
      for (const resource of stolenResources) {
        transferResource(tracker, victim, actor, resource, "known robbery");
      }

      return;
    }

    registerUnknownRobbery(tracker, victim, actor, raw);
  }

  function applyBuildEvent(tracker, actor, raw) {
    const player = ensureTrackedPlayer(tracker, actor);

    if (/\bcity\b/i.test(raw)) {
      spendResources(tracker, actor, BUILD_COSTS.city, "city");
      return;
    }

    if (/\bsettlement\b/i.test(raw)) {
      spendResources(tracker, actor, BUILD_COSTS.settlement, "settlement");
      return;
    }

    if (/\broad\b/i.test(raw)) {
      if (player.freeRoads > 0) {
        player.freeRoads -= 1;
        return;
      }

      spendResources(tracker, actor, BUILD_COSTS.road, "road");
    }
  }

  function applyUsedEvent(tracker, actor, raw) {
    if (/\bRoad Building\b/i.test(raw)) {
      ensureTrackedPlayer(tracker, actor).freeRoads += 2;
    }
  }

  function applyManualMonopolyCorrection(tracker, eventRecord) {
    const actor = canonicalPlayerName(tracker, eventRecord.player || eventRecord.actor || "");
    const resource = normalizeResourceName(eventRecord.monopolyResource);
    const transfers = Array.isArray(eventRecord.monopolyTransfers) ? eventRecord.monopolyTransfers : [];

    if (!actor || !resource) {
      return;
    }

    ensureTrackedPlayer(tracker, actor);

    for (const transfer of transfers) {
      const from = canonicalPlayerName(tracker, transfer.from || "");
      const amount = clampWholeNumber(transfer.count, 0, 30);

      if (!from || from === actor || !amount) {
        continue;
      }

      for (let index = 0; index < amount; index += 1) {
        transferResource(tracker, from, actor, resource, "monopoly");
      }
    }
  }

  function registerUnknownRobbery(tracker, fromPlayer, toPlayer, raw) {
    const from = canonicalPlayerName(tracker, fromPlayer);
    const to = canonicalPlayerName(tracker, toPlayer);

    if (!from || !to) {
      return;
    }

    ensureTrackedPlayer(tracker, from);
    ensureTrackedPlayer(tracker, to);

    const robbery = {
      id: "robbery-" + (tracker.robberies.length + 1),
      from,
      to,
      possible: getPossibleVictimResources(tracker, from),
      resolved: "",
      raw
    };

    tracker.robberies.push(robbery);

    if (robbery.possible.length === 1) {
      resolveRobbery(tracker, robbery, robbery.possible[0], "only possible resource");
    }
  }

  function getPossibleVictimResources(tracker, playerName) {
    const possibleResources = RESOURCE_TYPES.filter((resource) => {
      return getPlayerResourceRange(tracker, playerName, resource).max > 0;
    });

    return possibleResources.length ? possibleResources : RESOURCE_TYPES.slice();
  }

  function spendResources(tracker, playerName, resources, reason) {
    const player = ensureTrackedPlayer(tracker, playerName);
    const cost = normalizeResourceCounts(resources);

    if (!hasAnyResource(cost)) {
      return;
    }

    narrowOutgoingRobberiesForSpend(tracker, player.player, cost);
    resolveIncomingRobberiesForDeficit(tracker, player.player, cost, reason);
    subtractResources(tracker, player.player, cost, reason);
  }

  function observeMinimumResources(tracker, playerName, resources, reason) {
    const player = ensureTrackedPlayer(tracker, playerName);
    const minimums = normalizeResourceCounts(resources);

    if (!hasAnyResource(minimums)) {
      return;
    }

    narrowOutgoingRobberiesForMinimum(tracker, player.player, minimums, reason);
    resolveIncomingRobberiesForDeficit(tracker, player.player, minimums, reason);
    liftResourcesToMinimum(player, minimums);
  }

  function narrowOutgoingRobberiesForSpend(tracker, playerName, cost) {
    narrowOutgoingRobberiesForMinimum(tracker, playerName, cost, "victim spend");
  }

  function narrowOutgoingRobberiesForMinimum(tracker, playerName, minimums, reason) {
    const player = ensureTrackedPlayer(tracker, playerName);

    for (const robbery of tracker.robberies) {
      if (robbery.resolved || robbery.from !== player.player) {
        continue;
      }

      const nextPossible = robbery.possible.filter((resource) => {
        const amountNeeded = minimums[resource] || 0;

        if (!amountNeeded) {
          return true;
        }

        return Math.max(0, player.resources[resource] - 1) >= amountNeeded;
      });

      if (nextPossible.length && nextPossible.length < robbery.possible.length) {
        robbery.possible = nextPossible;
      }

      if (robbery.possible.length === 1) {
        resolveRobbery(tracker, robbery, robbery.possible[0], reason);
      }
    }
  }

  function liftResourcesToMinimum(player, minimums) {
    for (const resource of RESOURCE_TYPES) {
      const minimum = minimums[resource] || 0;

      if (player.resources[resource] < minimum) {
        player.resources[resource] = minimum;
      }
    }
  }

  function resolveIncomingRobberiesForDeficit(tracker, playerName, cost, reason) {
    const player = ensureTrackedPlayer(tracker, playerName);

    for (const resource of RESOURCE_TYPES) {
      while (player.resources[resource] < (cost[resource] || 0)) {
        const robbery = tracker.robberies.find((candidate) => {
          return !candidate.resolved && candidate.to === player.player && candidate.possible.includes(resource);
        });

        if (!robbery) {
          break;
        }

        resolveRobbery(tracker, robbery, resource, reason);
      }
    }
  }

  function resolveRobbery(tracker, robbery, resource, reason) {
    const resourceName = normalizeResourceName(resource);

    if (!resourceName || robbery.resolved) {
      return;
    }

    robbery.possible = [resourceName];
    robbery.resolved = resourceName;
    robbery.reason = reason || "";

    spendResources(tracker, robbery.from, { [resourceName]: 1 }, "resolved robbery");
    gainResources(tracker, robbery.to, { [resourceName]: 1 });
  }

  function transferResource(tracker, fromPlayer, toPlayer, resource, reason) {
    const resourceName = normalizeResourceName(resource);

    if (!resourceName) {
      return;
    }

    spendResources(tracker, fromPlayer, { [resourceName]: 1 }, reason);
    gainResources(tracker, toPlayer, { [resourceName]: 1 });
  }

  function gainResources(tracker, playerName, resources) {
    const player = ensureTrackedPlayer(tracker, playerName);
    const gain = normalizeResourceCounts(resources);

    for (const resource of RESOURCE_TYPES) {
      player.resources[resource] += gain[resource];
    }
  }

  function subtractResources(tracker, playerName, resources, reason) {
    const player = ensureTrackedPlayer(tracker, playerName);
    const cost = normalizeResourceCounts(resources);

    for (const resource of RESOURCE_TYPES) {
      const amount = cost[resource];

      if (!amount) {
        continue;
      }

      if (player.resources[resource] < amount) {
        const missing = amount - player.resources[resource];
        player.resources[resource] = 0;
        player.unknownSpent[resource] += missing;
        tracker.issues.push({
          player: player.player,
          resource,
          amount: missing,
          reason: reason || ""
        });
        continue;
      }

      player.resources[resource] -= amount;
    }
  }

  function ensureTrackedPlayer(tracker, playerName) {
    const player = canonicalPlayerName(tracker, playerName) || "Unknown";

    if (!tracker.players.has(player)) {
      tracker.players.set(player, {
        player,
        firstSeen: tracker.nextPlayerOrder,
        freeRoads: 0,
        resources: makeResourceCounts(),
        unknownSpent: makeResourceCounts()
      });
      tracker.nextPlayerOrder += 1;
    }

    return tracker.players.get(player);
  }

  function canonicalPlayerName(tracker, playerName, placement) {
    const player = cleanPlayerName(playerName);

    if (!player || isInvalidPlayerName(player)) {
      return "";
    }

    const placementKey = normalizePlacementKey(placement);

    if (isUserPlaceholderName(player)) {
      const placedPlayer = getKnownPlayerByPlacement(tracker, placementKey);

      if (placedPlayer) {
        return placedPlayer;
      }

      if (tracker.userName) {
        return tracker.userName;
      }

      return getKnownPlayerByPlacement(tracker, tracker.userPlacement) || "You";
    }

    if (placementKey) {
      const placedPlayer = tracker.playerByPlacement.get(placementKey);

      if (placedPlayer) {
        return placedPlayer;
      }

      if (isTransientPlayerName(player)) {
        return makePlacementPlayerName(player, placementKey);
      }
    }

    const knownPlacement = tracker.placementByPlayer.get(player);

    if (knownPlacement) {
      const placedPlayer = tracker.playerByPlacement.get(knownPlacement);

      if (placedPlayer) {
        return placedPlayer;
      }
    }

    return player;
  }

  function setTrackerUserName(tracker, playerName, options = {}) {
    const userName = cleanPlayerName(playerName);

    if (!userName || isUserPlaceholderName(userName)) {
      return false;
    }

    const previousUserName = tracker.userName;

    if (previousUserName && previousUserName !== userName && !options.allowChange) {
      return false;
    }

    tracker.userName = userName;
    const knownUserPlacement = tracker.placementByPlayer.get(userName);
    const userPlacement = knownUserPlacement || (previousUserName && previousUserName !== userName ? "" : tracker.userPlacement);

    if (userPlacement) {
      tracker.userPlacement = userPlacement;
      tracker.playerByPlacement.set(userPlacement, userName);
      tracker.placementByPlayer.set(userName, userPlacement);
    }

    mergeTrackedPlayers(tracker, "You", userName);

    for (const robbery of tracker.robberies) {
      if (robbery.from === "You") {
        robbery.from = userName;
      }

      if (robbery.to === "You") {
        robbery.to = userName;
      }
    }

    return true;
  }

  function mergeTrackedPlayers(tracker, fromPlayer, toPlayer) {
    if (fromPlayer === toPlayer || !tracker.players.has(fromPlayer)) {
      return;
    }

    const source = tracker.players.get(fromPlayer);
    let target = tracker.players.get(toPlayer);

    if (!target) {
      target = {
        player: toPlayer,
        firstSeen: source.firstSeen,
        freeRoads: 0,
        resources: makeResourceCounts(),
        unknownSpent: makeResourceCounts()
      };
      tracker.players.set(toPlayer, target);
    }

    target.firstSeen = Math.min(target.firstSeen, source.firstSeen);
    target.freeRoads += source.freeRoads;

    for (const resource of RESOURCE_TYPES) {
      target.resources[resource] += source.resources[resource];
      target.unknownSpent[resource] += source.unknownSpent[resource];
    }

    tracker.players.delete(fromPlayer);

    for (const robbery of tracker.robberies) {
      if (robbery.from === fromPlayer) {
        robbery.from = toPlayer;
      }

      if (robbery.to === fromPlayer) {
        robbery.to = toPlayer;
      }
    }

    if (tracker.lastRobberMover === fromPlayer) {
      tracker.lastRobberMover = toPlayer;
    }

    if (tracker.userName === fromPlayer) {
      tracker.userName = toPlayer;
    }

    for (const [placement, player] of tracker.playerByPlacement.entries()) {
      if (player === fromPlayer) {
        tracker.playerByPlacement.set(placement, toPlayer);
      }
    }

    const placement = tracker.placementByPlayer.get(fromPlayer);

    if (placement) {
      tracker.placementByPlayer.delete(fromPlayer);
      tracker.placementByPlayer.set(toPlayer, placement);
    }
  }

  function getTrackedPlayerRows(tracker) {
    const rows = Array.from(tracker.players.values())
      .map((player) => {
        const ranges = {};

        for (const resource of RESOURCE_TYPES) {
          ranges[resource] = getPlayerResourceRange(tracker, player.player, resource);
        }

        return {
          player: player.player,
          displayName: formatTrackedPlayerName(tracker, player.player),
          color: getPlayerColor(tracker, player.player),
          firstSeen: player.firstSeen,
          totalRange: getPlayerTotalRange(tracker, player.player),
          ranges
        };
      })
      .sort((first, second) => first.firstSeen - second.firstSeen);

    return rotatePlayerRowsToUserBottom(tracker, rows);
  }

  function getTrackedResourceTotals(tracker) {
    const counts = makeResourceCounts();
    let total = 0;

    for (const player of tracker.players.values()) {
      for (const resource of RESOURCE_TYPES) {
        const amount = Math.max(0, Number(player.resources[resource] || 0));
        counts[resource] += amount;
        total += amount;
      }
    }

    const ranges = {};

    for (const resource of RESOURCE_TYPES) {
      ranges[resource] = {
        min: counts[resource],
        max: counts[resource]
      };
    }

    return {
      totalRange: {
        min: total,
        max: total
      },
      ranges
    };
  }

  function rotatePlayerRowsToUserBottom(tracker, rows) {
    const userIndex = rows.findIndex((row) => isUserTrackedPlayer(tracker, row.player));

    if (userIndex < 0) {
      return rows;
    }

    return rows.slice(userIndex + 1).concat(rows.slice(0, userIndex + 1));
  }

  function isUserTrackedPlayer(tracker, playerName) {
    const player = cleanPlayerName(playerName);
    return isUserPlaceholderName(player) || Boolean(tracker.userName && player === tracker.userName);
  }

  function getPlayerColor(tracker, playerName) {
    const player = cleanPlayerName(playerName);

    if (!player) {
      return "";
    }

    if (isUserPlaceholderName(player) && tracker.userPlacement) {
      return tracker.userPlacement;
    }

    const trackedPlayerName = canonicalPlayerName(tracker, player);
    return normalizePlacementKey(tracker.placementByPlayer.get(trackedPlayerName) || "");
  }

  function getPlayerResourceRange(tracker, playerName, resource) {
    const trackedPlayerName = canonicalPlayerName(tracker, playerName);
    const player = tracker.players.get(trackedPlayerName);
    let min = player ? player.resources[resource] || 0 : 0;
    let max = min;

    for (const robbery of tracker.robberies) {
      if (robbery.resolved || !robbery.possible.includes(resource)) {
        continue;
      }

      if (robbery.from === trackedPlayerName) {
        min -= 1;
      }

      if (robbery.to === trackedPlayerName) {
        max += 1;
      }
    }

    return {
      min: Math.max(0, min),
      max: Math.max(0, max)
    };
  }

  function getPlayerTotalRange(tracker, playerName) {
    const trackedPlayerName = canonicalPlayerName(tracker, playerName);
    const player = tracker.players.get(trackedPlayerName);
    let total = 0;

    if (player) {
      for (const resource of RESOURCE_TYPES) {
        total += player.resources[resource] || 0;
      }
    }

    for (const robbery of tracker.robberies) {
      if (robbery.resolved) {
        continue;
      }

      if (robbery.from === trackedPlayerName) {
        total -= 1;
      }

      if (robbery.to === trackedPlayerName) {
        total += 1;
      }
    }

    return {
      min: Math.max(0, total),
      max: Math.max(0, total)
    };
  }

  function formatTrackedPlayerName(tracker, playerName) {
    if (tracker.userName && playerName === tracker.userName) {
      return playerName + " (you)";
    }

    return playerName;
  }

  function makeResourceCounts() {
    const counts = {};

    for (const resource of RESOURCE_TYPES) {
      counts[resource] = 0;
    }

    return counts;
  }

  function normalizeResourceCounts(resources) {
    const counts = makeResourceCounts();

    if (!resources) {
      return counts;
    }

    for (const resource of RESOURCE_TYPES) {
      counts[resource] = Math.max(0, Number(resources[resource] || 0));
    }

    return counts;
  }

  function resourcesToCounts(resources) {
    const counts = makeResourceCounts();

    for (const resource of resources) {
      const resourceName = normalizeResourceName(resource);

      if (resourceName) {
        counts[resourceName] += 1;
      }
    }

    return counts;
  }

  function extractResourceList(text) {
    const resourcePattern = new RegExp("\\[(" + RESOURCE_TYPES.join("|") + ")\\]", "gi");

    return Array.from(String(text || "").matchAll(resourcePattern)).map((match) => match[1].toLowerCase());
  }

  function normalizeResourceName(resource) {
    const resourceName = String(resource || "").toLowerCase();

    return RESOURCE_TYPES.includes(resourceName) ? resourceName : "";
  }

  function hasAnyResource(resources) {
    return RESOURCE_TYPES.some((resource) => Number(resources[resource] || 0) > 0);
  }

  async function createOverlay(contentScriptContext) {
    if (overlayUi) {
      return;
    }

    overlayUi = await createShadowRootUi(contentScriptContext, {
      name: "colonist-stats-helper",
      position: "inline",
      anchor: "body",
      isolateEvents: false,
      onMount(container) {
        const app = document.createElement("div");
        container.append(app);
        overlayReactRoot = ReactDOM.createRoot(app);
        return overlayReactRoot;
      },
      onRemove(root) {
        root?.unmount();
        overlayReactRoot = null;
        overlayUi = null;
      }
    });

    overlayUi.mount();
  }

  function clearEvents() {
    state.events = [];
    state.lastVisibleLines = [];
    state.lastVisibleRecords = [];
    storageSet({ [STORAGE_KEY]: [] });
    render();
  }

  function togglePaused() {
    state.settings.paused = !state.settings.paused;
    saveSettingsSoon();
    render();
  }

  function setMonopolyResource(eventId, value) {
    const draft = getMonopolyDraft(eventId);
    draft.resource = normalizeResourceName(value) || "lumber";
    render();
  }

  function setMonopolyLeftTotal(eventId, player, value) {
    if (!player) {
      return;
    }

    const draft = getMonopolyDraft(eventId);
    draft.leftTotals[player] = normalizeMonopolyLeftTotalInput(value);
    render();
  }

  function saveOverlayPosition(left, top) {
    state.settings.overlayLeft = left;
    state.settings.overlayTop = top;
    saveSettingsSoon();
  }

  function saveOverlaySize(width, height) {
    state.settings.overlayWidth = width;
    state.settings.overlayHeight = height;
    saveSettingsSoon();
  }

  async function scanExistingLogHistory() {
    if (state.historyScanRunning) {
      return;
    }

    const container = state.logContainer && document.contains(state.logContainer) ? state.logContainer : findGameLogContainer();

    if (!container) {
      state.historyScanStatus = "No log panel found";
      state.sourceStatus.dom = "searching";
      render();
      return;
    }

    state.logContainer = container;
    state.historyScanRunning = true;
    state.historyScanStatus = "Scanning history";
    state.sourceStatus.dom = "scanning";
    render();

    const scrollContainer = getLogScrollContainer(container);
    const originalScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
    const originalScrollBehavior = scrollContainer ? scrollContainer.style.scrollBehavior : "";
    const recordsByKey = new Map();
    const seenHistoryRecords = new Set();
    let firstSeen = 0;

    try {
      if (!scrollContainer) {
        collectHistoryRecords(container, recordsByKey, seenHistoryRecords, () => firstSeen++);
      } else {
        scrollContainer.style.scrollBehavior = "auto";
        await scanScrollableLogHistory(container, scrollContainer, recordsByKey, seenHistoryRecords, () => firstSeen++);
      }

      const records = Array.from(recordsByKey.values()).sort(compareHistoryRecords);
      let imported = 0;

      for (const record of records) {
        const added = appendEvent(record.text, "hist", {
          ...getRecordEventExtra(record),
          historyScan: true
        });

        if (added) {
          imported += 1;
        }
      }

      sortEventsByGameOrder();
      state.historyScanStatus = "Imported " + imported + "/" + records.length;
      state.sourceStatus.dom = "connected";
    } catch (error) {
      state.historyScanStatus = "History failed";
      state.sourceStatus.dom = "connected";
      console.warn("[Colonist Stats Helper] History scan failed", error);
    } finally {
      if (scrollContainer) {
        scrollContainer.scrollTop = originalScrollTop;
        scrollContainer.style.scrollBehavior = originalScrollBehavior;
        await waitForDomSettle();
      }

      state.historyScanRunning = false;

      if (document.contains(container)) {
        const records = extractVisibleLogRecords(container).filter((record) => isLikelyLogLine(record.text));
        state.lastVisibleRecords = records;
        state.lastVisibleLines = records.map((record) => record.text);
        watchLogContainer(container);
      }

      render();
    }
  }

  async function scanScrollableLogHistory(container, scrollContainer, recordsByKey, seenHistoryRecords, nextFirstSeen) {
    const stepSize = Math.max(HISTORY_SCAN_MIN_STEP_PX, Math.floor(scrollContainer.clientHeight * HISTORY_SCAN_STEP_RATIO));
    let nextTop = 0;

    for (let step = 0; step < HISTORY_SCAN_MAX_STEPS; step += 1) {
      scrollContainer.scrollTop = nextTop;
      await collectSettledHistoryRecords(container, recordsByKey, seenHistoryRecords, nextFirstSeen);

      const maxTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      state.historyScanStatus = "History " + Math.round(maxTop ? (nextTop / maxTop) * 100 : 100) + "%";
      render();

      if (nextTop >= maxTop) {
        break;
      }

      nextTop = Math.min(maxTop, nextTop + stepSize);
    }
  }

  async function collectSettledHistoryRecords(container, recordsByKey, seenHistoryRecords, nextFirstSeen) {
    for (let read = 0; read < HISTORY_SCAN_READS_PER_STEP; read += 1) {
      await waitForDomSettle();
      collectHistoryRecords(container, recordsByKey, seenHistoryRecords, nextFirstSeen);
    }
  }

  function collectHistoryRecords(container, recordsByKey, seenHistoryRecords, nextFirstSeen) {
    const records = extractVisibleLogRecords(container).filter((record) => isLikelyLogLine(record.text));

    for (const record of records) {
      const visibleKey = getHistoryVisibleRecordKey(record);

      if (seenHistoryRecords.has(visibleKey)) {
        continue;
      }

      seenHistoryRecords.add(visibleKey);
      const seenOrder = nextFirstSeen();
      const key = Number.isFinite(record.index) ? "index:" + record.index : "seen:" + seenOrder + ":" + record.text;

      if (!recordsByKey.has(key)) {
        recordsByKey.set(key, {
          ...record,
          key,
          firstSeen: seenOrder
        });
      }
    }
  }

  function getHistoryVisibleRecordKey(record) {
    if (Number.isFinite(record.index)) {
      return "index:" + record.index;
    }

    return record.key || "text:" + record.text;
  }

  function compareHistoryRecords(first, second) {
    if (Number.isFinite(first.index) && Number.isFinite(second.index)) {
      return first.index - second.index;
    }

    if (Number.isFinite(first.index)) {
      return -1;
    }

    if (Number.isFinite(second.index)) {
      return 1;
    }

    return first.firstSeen - second.firstSeen;
  }

  function sortEventsByGameOrder() {
    state.events.sort((first, second) => {
      const firstHasIndex = Number.isFinite(first.domIndex);
      const secondHasIndex = Number.isFinite(second.domIndex);

      if (firstHasIndex && secondHasIndex && first.domIndex !== second.domIndex) {
        return first.domIndex - second.domIndex;
      }

      return Number(first.createdAt || 0) - Number(second.createdAt || 0);
    });
  }

  function waitForDomSettle() {
    return new Promise((resolve) => {
      window.setTimeout(resolve, HISTORY_SCAN_SETTLE_MS);
    });
  }

  function exportEvents() {
    downloadJson("colonist-log-events.json", state.events);
  }

  function exportLogSample() {
    syncLocalUserIdentity(true);

    if (!state.logContainer || !document.contains(state.logContainer)) {
      state.logContainer = findGameLogContainer();
    }

    const container = state.logContainer;
    const rawText = container ? normalizeText(container.innerText || container.textContent || "") : "";
    const rawLines = linesFromText(rawText);
    const visualLines = container ? extractVisualLogLines(container) : [];
    const allLines = visualLines.length ? visualLines.map((line) => line.text) : rawLines;
    const likelyLogLines = allLines.filter(isLikelyLogLine);
    const scrollContainer = container ? getLogScrollContainer(container) : null;

    downloadJson("colonist-log-sample.json", {
      capturedAt: new Date().toISOString(),
      pageUrl: window.location.href,
      userAgent: navigator.userAgent,
      sourceStatus: state.sourceStatus,
      domScanCount: state.domScanCount,
      wsFrames: state.wsFrames,
      wsTextFrames: state.wsTextFrames,
      wsTextSamples: state.wsTextSamples,
      historyScanStatus: state.historyScanStatus,
      localUserName: state.localUserName,
      localUserSource: state.localUserSource,
      localUserDomCandidates: state.localUserDomCandidates,
      logContainer: container ? describeElement(container) : null,
      scrollContainer: scrollContainer ? describeScrollContainer(scrollContainer) : null,
      rawText,
      rawLines,
      visualLines,
      imageDescriptors: container ? collectImageDescriptors(container) : [],
      htmlPreview: container ? String(container.outerHTML || "").slice(0, 25000) : "",
      allLines,
      likelyLogLines,
      lastVisibleLines: state.lastVisibleLines,
      lastVisibleRecords: state.lastVisibleRecords,
      parsedEvents: state.events.slice(-100)
    });
  }

  function collectImageDescriptors(container) {
    return [container, ...Array.from(container.querySelectorAll("*"))]
      .map((element) => getImageDescriptor(element))
      .filter(Boolean);
  }

  function describeElement(element) {
    const rect = element.getBoundingClientRect();

    return {
      tagName: element.tagName.toLowerCase(),
      id: element.id || "",
      className: typeof element.className === "string" ? element.className : element.getAttribute("class") || "",
      role: element.getAttribute("role") || "",
      ariaLive: element.getAttribute("aria-live") || "",
      rect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      selectorHint: buildSelectorHint(element)
    };
  }

  function describeScrollContainer(element) {
    return {
      ...describeElement(element),
      scrollTop: Math.round(element.scrollTop),
      scrollHeight: Math.round(element.scrollHeight),
      clientHeight: Math.round(element.clientHeight),
      nearBottom: isNearScrollBottom(element)
    };
  }

  function buildSelectorHint(element) {
    const parts = [];
    let node = element;

    while (node && node instanceof HTMLElement && node !== document.body && parts.length < 5) {
      let part = node.tagName.toLowerCase();

      if (node.id) {
        part += "#" + node.id;
        parts.unshift(part);
        break;
      }

      if (typeof node.className === "string" && node.className.trim()) {
        part +=
          "." +
          node.className
            .trim()
            .split(/\s+/)
            .slice(0, 3)
            .join(".");
      }

      parts.unshift(part);
      node = node.parentElement;
    }

    return parts.join(" > ");
  }

  function downloadJson(filename, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = filename;
    anchor.click();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function clampWholeNumber(value, min, max) {
    const number = Math.floor(Number(value));

    if (!Number.isFinite(number)) {
      return min;
    }

    return clamp(number, min, max);
  }

  function normalizeMonopolyLeftTotalInput(value) {
    const digits = String(value || "").replace(/\D+/g, "");

    if (!digits) {
      return "";
    }

    return String(clampWholeNumber(digits, 0, 99));
  }

  function getMonopolyLeftTotalValue(value, fallback) {
    if (value === "") {
      return clampWholeNumber(fallback, 0, 99);
    }

    return clampWholeNumber(value, 0, 99);
  }

  function getMonopolyDraft(eventId) {
    if (!state.monopolyDrafts[eventId]) {
      state.monopolyDrafts[eventId] = {
        resource: "lumber",
        leftTotals: {}
      };
    }

    return state.monopolyDrafts[eventId];
  }

  function isMonopolyEvent(eventRecord) {
    const action = String(eventRecord.action || parseLogLine(eventRecord.raw || "").action || "").toLowerCase();
    return action === "used" && /\bmonopoly\b/i.test(eventRecord.raw || "");
  }

  function getPendingMonopolyEvents() {
    const correctedEventIds = new Set(
      state.events
        .filter((eventRecord) => eventRecord.manualType === "monopoly" && eventRecord.monopolyEventId)
        .map((eventRecord) => eventRecord.monopolyEventId)
    );

    return state.events.filter((eventRecord) => isMonopolyEvent(eventRecord) && !correctedEventIds.has(eventRecord.id));
  }

  function saveMonopolyCorrection(target) {
    const panel = target instanceof HTMLElement ? target.closest("[data-role='monopoly-panel']") : null;
    const eventId = typeof target === "string" ? target : panel ? panel.getAttribute("data-event-id") || "" : "";
    const monopolyEvent = state.events.find((eventRecord) => eventRecord.id === eventId);

    if (!monopolyEvent) {
      return;
    }

    const draft = getMonopolyDraft(eventId);
    const resource = normalizeResourceName(draft.resource) || "lumber";
    const monopolyTracker = computeResourceTrackerThroughEvent(monopolyEvent.id);
    const parsed = parseLogLine(monopolyEvent.raw || "");
    const actor =
      canonicalPlayerName(
        monopolyTracker,
        parsed.player,
        getEventPlayerPlacement(monopolyEvent, parsed.player) || monopolyEvent.playerPlacement || ""
      ) || parsed.player;
    const leftTotals = getTrackedPlayerRows(monopolyTracker)
      .filter((row) => row.player !== actor)
      .map((row) => {
        const before = getPlayerTotalRange(monopolyTracker, row.player).max;
        const hasDraftValue = Object.prototype.hasOwnProperty.call(draft.leftTotals, row.player);
        const left = getMonopolyLeftTotalValue(hasDraftValue ? draft.leftTotals[row.player] : before, before);

        return {
          player: row.player,
          before,
          left,
          stolen: Math.max(0, before - left)
        };
      })
      .filter((entry) => entry.player);
    const transfers = leftTotals
      .map((entry) => ({
        from: entry.player,
        count: entry.stolen
      }))
      .filter((transfer) => transfer.count > 0);

    const correction = {
      id: makeId(),
      raw: parsed.player + " resolved Monopoly [" + resource + "]",
      player: parsed.player,
      action: "manual",
      detail: "resolved Monopoly [" + resource + "]",
      tokens: [{ type: resource, value: "" }],
      resources: [resource],
      dice: [],
      rollTotal: null,
      source: "manual",
      createdAt: Date.now(),
      timestamp: new Date().toISOString(),
      manualType: "monopoly",
      monopolyEventId: monopolyEvent.id,
      monopolyResource: resource,
      monopolyLeftTotals: leftTotals,
      monopolyTransfers: transfers
    };
    const eventIndex = state.events.indexOf(monopolyEvent);

    state.events = state.events.filter((eventRecord) => eventRecord.monopolyEventId !== monopolyEvent.id);
    state.events.splice(eventIndex + 1, 0, correction);

    if (state.events.length > MAX_EVENTS) {
      state.events = state.events.slice(-MAX_EVENTS);
    }

    delete state.monopolyDrafts[eventId];
    saveEventsSoon();
    render();
  }

  function render() {
    if (!overlayReactRoot) {
      return;
    }

    syncLocalUserIdentity();
    const resourceTracker = computeResourceTracker();
    const playerRows = getTrackedPlayerRows(resourceTracker);
    const snapshot = {
      eventCount: state.events.length,
      domStatus: state.sourceStatus.dom,
      wsStatus: state.sourceStatus.ws,
      statusText: buildStatusText(resourceTracker),
      paused: state.settings.paused,
      historyScanRunning: state.historyScanRunning,
      playerRows,
      resourceTotals: getTrackedResourceTotals(resourceTracker),
      robberies: getVisibleRobberyRows(resourceTracker).map((robbery) => ({
        id: robbery.id,
        from: robbery.from,
        fromColor: getPlayerColor(resourceTracker, robbery.from),
        to: robbery.to,
        toColor: getPlayerColor(resourceTracker, robbery.to),
        possible: robbery.possible.slice(),
        resolved: robbery.resolved,
        raw: robbery.raw
      })),
      monopoly: buildMonopolyViewModel(),
      latestEvents: buildLatestEventViewModels(resourceTracker),
      localUserName: state.localUserName,
      localUserSource: state.localUserSource,
      overlayLeft: state.settings.overlayLeft,
      overlayTop: state.settings.overlayTop,
      overlayWidth: state.settings.overlayWidth,
      overlayHeight: state.settings.overlayHeight
    };

    overlayReactRoot.render(<ColonistOverlay snapshot={snapshot} actions={overlayActions} />);
  }

  function buildMonopolyViewModel() {
    const pendingMonopolies = getPendingMonopolyEvents();

    if (!pendingMonopolies.length) {
      return null;
    }

    const eventRecord = pendingMonopolies[pendingMonopolies.length - 1];
    const parsed = parseLogLine(eventRecord.raw || "");
    const monopolyTracker = computeResourceTrackerThroughEvent(eventRecord.id);
    const actor =
      canonicalPlayerName(
        monopolyTracker,
        parsed.player,
        getEventPlayerPlacement(eventRecord, parsed.player) || eventRecord.playerPlacement || ""
      ) || parsed.player;
    const draft = getMonopolyDraft(eventRecord.id);
    const resource = normalizeResourceName(draft.resource) || "lumber";
    const victims = getTrackedPlayerRows(monopolyTracker)
      .filter((row) => row.player !== actor)
      .map((row) => {
        const hasDraftValue = Object.prototype.hasOwnProperty.call(draft.leftTotals, row.player);

        return {
          player: row.player,
          displayName: row.displayName,
          color: row.color,
          totalRange: row.totalRange,
          value: hasDraftValue ? draft.leftTotals[row.player] : String(row.totalRange.max)
        };
      });

    if (!victims.length) {
      return null;
    }

    return {
      eventId: eventRecord.id,
      actor: actor || parsed.player,
      actorColor: getPlayerColor(monopolyTracker, actor),
      resource,
      victims
    };
  }

  function buildLatestEventViewModels(resourceTracker) {
    return state.events.slice(-6).reverse().map((eventRecord) => ({
      ...eventRecord,
      playerColors: getEventPlayerColorMap(resourceTracker, eventRecord)
    }));
  }

  function getEventPlayerColorMap(tracker, eventRecord) {
    const playerColors = {};
    const addColor = (playerName, color) => {
      const player = cleanPlayerName(playerName);
      const playerColor = normalizePlacementKey(color);

      if (!player || !playerColor) {
        return;
      }

      playerColors[player] = playerColor;
    };

    for (const player of tracker.players.keys()) {
      addColor(player, getPlayerColor(tracker, player));
    }

    if (tracker.userName) {
      addColor("You", getPlayerColor(tracker, tracker.userName));
    }

    const placements = Array.isArray(eventRecord.playerPlacements) ? eventRecord.playerPlacements : [];

    for (const placement of placements) {
      const color = normalizePlacementKey(placement.placement);
      const canonicalPlayer = canonicalPlayerName(tracker, placement.name, color);

      addColor(placement.name, color);
      addColor(canonicalPlayer, color || getPlayerColor(tracker, canonicalPlayer));
    }

    const parsed = parseLogLine(eventRecord.raw || "");
    const actorPlacement = getEventPlayerPlacement(eventRecord, parsed.player) || eventRecord.playerPlacement || "";
    const actor = canonicalPlayerName(tracker, parsed.player, actorPlacement);

    addColor(parsed.player, getPlayerColor(tracker, actor) || actorPlacement);
    addColor(actor, getPlayerColor(tracker, actor) || actorPlacement);

    return playerColors;
  }

  function buildStatusText(resourceTracker) {
    const parts = [];
    const pendingRobberies = resourceTracker
      ? resourceTracker.robberies.filter((robbery) => !robbery.resolved).length
      : 0;

    if (state.settings.paused) {
      parts.push("paused");
    }

    if (state.historyScanStatus) {
      parts.push(state.historyScanStatus);
    }

    parts.push("DOM " + state.sourceStatus.dom);
    parts.push("WS " + state.sourceStatus.ws + " (" + state.wsFrames + ")");

    if (pendingRobberies) {
      parts.push(pendingRobberies + " pending steal" + (pendingRobberies === 1 ? "" : "s"));
    }

    return parts.join(" | ");
  }

  function getVisibleRobberyRows(resourceTracker) {
    const pendingRobberies = resourceTracker.robberies.filter((robbery) => !robbery.resolved);
    const resolvedRobberies = resourceTracker.robberies.filter((robbery) => robbery.resolved).slice(-2);

    return pendingRobberies.concat(resolvedRobberies).slice(0, 4);
  }
}
