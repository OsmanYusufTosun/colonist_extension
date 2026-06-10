import { useEffect, useMemo, useRef, useState } from "react";

const RESOURCE_TYPES = ["lumber", "brick", "wool", "grain", "ore"];
const MIN_OVERLAY_WIDTH = 340;
const MIN_OVERLAY_HEIGHT = 220;
const VIEWPORT_MARGIN = 8;
const RESOURCE_LABELS = {
  lumber: { label: "Lumber" },
  brick: { label: "Brick" },
  wool: { label: "Wool" },
  grain: { label: "Grain" },
  ore: { label: "Ore" }
};
const RESOURCE_BAR_MAX = 8;

export default function ColonistOverlay({ snapshot, actions }) {
  const [collapsed, setCollapsed] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState({
    steals: false,
    log: false
  });
  const rootRef = useRef(null);
  const dragStateRef = useRef(null);
  const resizeStateRef = useRef(null);
  const [position, setPosition] = useState(() => ({
    left: Number.isFinite(snapshot.overlayLeft) ? snapshot.overlayLeft : null,
    top: Number.isFinite(snapshot.overlayTop) ? snapshot.overlayTop : null
  }));
  const [size, setSize] = useState(() => ({
    width: Number.isFinite(snapshot.overlayWidth) ? snapshot.overlayWidth : null,
    height: Number.isFinite(snapshot.overlayHeight) ? snapshot.overlayHeight : null
  }));

  useEffect(() => {
    return () => {
      finishResize(null, { save: false });
      dragStateRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (dragStateRef.current || resizeStateRef.current) {
      return;
    }

    if (Number.isFinite(snapshot.overlayLeft) && Number.isFinite(snapshot.overlayTop)) {
      setPosition({
        left: snapshot.overlayLeft,
        top: snapshot.overlayTop
      });
    }
  }, [snapshot.overlayLeft, snapshot.overlayTop]);

  useEffect(() => {
    if (resizeStateRef.current) {
      return;
    }

    if (Number.isFinite(snapshot.overlayWidth) && Number.isFinite(snapshot.overlayHeight)) {
      setSize({
        width: snapshot.overlayWidth,
        height: snapshot.overlayHeight
      });
    }
  }, [snapshot.overlayWidth, snapshot.overlayHeight]);

  const rootStyle = useMemo(() => {
    const style = {};

    if (Number.isFinite(position.left) && Number.isFinite(position.top)) {
      style.left = `${position.left}px`;
      style.top = `${position.top}px`;
    }

    if (Number.isFinite(size.width)) {
      style.width = `${size.width}px`;
    }

    if (!collapsed && Number.isFinite(size.height)) {
      style.height = `${size.height}px`;
    }

    return Object.keys(style).length ? style : undefined;
  }, [collapsed, position.left, position.top, size.height, size.width]);

  function handlePointerDown(event) {
    if (event.target instanceof HTMLElement && event.target.closest("button, select, input, [data-role='resize-handle']")) {
      return;
    }

    const root = rootRef.current;

    if (!root) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: root.offsetLeft,
      startTop: root.offsetTop
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event) {
    const dragState = dragStateRef.current;
    const root = rootRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId || !root) {
      return;
    }

    const nextLeft = clamp(dragState.startLeft + event.clientX - dragState.startX, 0, Math.max(0, window.innerWidth - root.offsetWidth));
    const nextTop = clamp(dragState.startTop + event.clientY - dragState.startY, 0, Math.max(0, window.innerHeight - root.offsetHeight));

    dragState.left = nextLeft;
    dragState.top = nextTop;
    setPosition({
      left: nextLeft,
      top: nextTop
    });
  }

  function handlePointerUp(event) {
    const dragState = dragStateRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    dragStateRef.current = null;
    safelyReleasePointerCapture(event.currentTarget, event.pointerId);

    if (Number.isFinite(dragState.left) && Number.isFinite(dragState.top)) {
      actions.saveOverlayPosition(dragState.left, dragState.top);
    }
  }

  function handleResizePointerDown(event) {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const pointerTarget = event.currentTarget;
    const ownerDocument = pointerTarget.ownerDocument || document;
    const ownerWindow = ownerDocument.defaultView || window;
    const cleanup = () => {
      ownerDocument.removeEventListener("pointermove", handleResizePointerMove, true);
      ownerDocument.removeEventListener("pointerup", handleResizePointerUp, true);
      ownerDocument.removeEventListener("pointercancel", handleResizePointerCancel, true);
      ownerWindow.removeEventListener("blur", handleResizeWindowBlur, true);
    };

    resizeStateRef.current = {
      pointerId: event.pointerId,
      pointerTarget,
      cleanup,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: root.offsetWidth,
      startHeight: root.offsetHeight,
      width: root.offsetWidth,
      height: root.offsetHeight
    };
    safelySetPointerCapture(pointerTarget, event.pointerId);
    ownerDocument.addEventListener("pointermove", handleResizePointerMove, true);
    ownerDocument.addEventListener("pointerup", handleResizePointerUp, true);
    ownerDocument.addEventListener("pointercancel", handleResizePointerCancel, true);
    ownerWindow.addEventListener("blur", handleResizeWindowBlur, true);
  }

  function handleResizePointerMove(event) {
    const resizeState = resizeStateRef.current;
    const root = rootRef.current;

    if (!resizeState || resizeState.pointerId !== event.pointerId || !root) {
      return;
    }

    event.preventDefault();
    const bounds = getResizeBounds(root);
    const nextWidth = clamp(resizeState.startWidth + event.clientX - resizeState.startX, bounds.minWidth, bounds.maxWidth);
    const nextHeight = clamp(resizeState.startHeight + event.clientY - resizeState.startY, bounds.minHeight, bounds.maxHeight);

    resizeState.width = nextWidth;
    resizeState.height = nextHeight;
    setSize({
      width: nextWidth,
      height: nextHeight
    });
  }

  function handleResizePointerUp(event) {
    finishResize(event, { save: true });
  }

  function handleResizePointerCancel(event) {
    finishResize(event, { save: true });
  }

  function handleResizeWindowBlur() {
    finishResize(null, { save: true });
  }

  function finishResize(event, { save }) {
    const resizeState = resizeStateRef.current;

    if (!resizeState || (event && resizeState.pointerId !== event.pointerId)) {
      return;
    }

    resizeStateRef.current = null;
    resizeState.cleanup();
    safelyReleasePointerCapture(resizeState.pointerTarget, resizeState.pointerId);

    if (save && Number.isFinite(resizeState.width) && Number.isFinite(resizeState.height)) {
      actions.saveOverlaySize(resizeState.width, resizeState.height);
    }
  }

  function toggleSection(section) {
    setCollapsedSections((value) => ({
      ...value,
      [section]: !value[section]
    }));
  }

  return (
    <div
      id="colonist-stats-helper-root"
      ref={rootRef}
      className={collapsed ? "csh-collapsed" : ""}
      style={rootStyle}
    >
      <div className="csh-panel">
        <div
          className="csh-titlebar"
          data-role="drag-handle"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div className="csh-brand">
            <div className="csh-mark" aria-hidden="true">
              <span className="csh-mark-card csh-resource-lumber" />
              <span className="csh-mark-card csh-resource-brick" />
              <span className="csh-mark-card csh-resource-grain" />
            </div>
            <div>
              <div className="csh-title">Colonist resources</div>
            </div>
          </div>
          <div className="csh-title-actions">
            <ActionRail snapshot={snapshot} actions={actions} />
            <button
              className="csh-icon-button"
              type="button"
              title={collapsed ? "Expand" : "Collapse"}
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? "+" : "-"}
            </button>
          </div>
        </div>

        <div className="csh-body">
          <div className="csh-main">
            <div className="csh-section">
              <div className="csh-section-title">Resources</div>
              <div className="csh-table">
                {snapshot.playerRows.length ? (
                  <>
                    <ResourceHeader />
                    {snapshot.playerRows.map((row) => (
                      <TrackedPlayerRow key={row.player} row={row} />
                    ))}
                    <ResourceTotalRow totals={snapshot.resourceTotals} />
                  </>
                ) : (
                  <div className="csh-empty">No resource data yet</div>
                )}
              </div>
            </div>

            {snapshot.robberies.length > 0 && (
              <CollapsibleSection
                title="Steals"
                count={snapshot.robberies.length}
                collapsed={collapsedSections.steals}
                className="csh-steals"
                onToggle={() => toggleSection("steals")}
              >
                <div className="csh-steal-list">
                  {snapshot.robberies.map((robbery) => (
                    <RobberyRow key={robbery.id} robbery={robbery} />
                  ))}
                </div>
              </CollapsibleSection>
            )}

            {snapshot.monopoly && <MonopolyPanel monopoly={snapshot.monopoly} actions={actions} />}

            <CollapsibleSection
              title="Latest log"
              count={snapshot.latestEvents.length}
              collapsed={collapsedSections.log}
              onToggle={() => toggleSection("log")}
            >
              <div className="csh-log">
                {snapshot.latestEvents.length ? (
                  snapshot.latestEvents.map((eventRecord) => <EventRow key={eventRecord.id} eventRecord={eventRecord} />)
                ) : (
                  <div className="csh-empty">Waiting for log entries</div>
                )}
              </div>
            </CollapsibleSection>
          </div>

        </div>

        <div
          className="csh-resize-handle"
          data-role="resize-handle"
          title="Resize"
          onPointerDown={handleResizePointerDown}
        />
      </div>
    </div>
  );
}

function CollapsibleSection({ title, count, collapsed, className = "", onToggle, children }) {
  return (
    <div className={["csh-section", className].filter(Boolean).join(" ")}>
      <button className="csh-section-toggle" type="button" aria-expanded={!collapsed} onClick={onToggle}>
        <span>{title}</span>
        <span className="csh-section-toggle-meta">
          <span className="csh-section-count">{count}</span>
          <span className="csh-section-caret">{collapsed ? "+" : "-"}</span>
        </span>
      </button>
      {!collapsed && children}
    </div>
  );
}

function ActionRail({ snapshot, actions }) {
  const [open, setOpen] = useState(false);

  function runAction(action) {
    action();
    setOpen(false);
  }

  return (
    <div className="csh-action-rail">
      <button
        type="button"
        className="csh-action-menu-toggle"
        title="More options"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ...
      </button>
      <div className="csh-action-menu" hidden={!open}>
        <button type="button" title="Scan history" onClick={() => runAction(actions.scanHistory)} disabled={snapshot.historyScanRunning}>
          {snapshot.historyScanRunning ? "Scan" : "Hist"}
        </button>
        <button type="button" title={snapshot.paused ? "Resume recording" : "Pause recording"} onClick={() => runAction(actions.togglePaused)}>
          {snapshot.paused ? "Resume" : "Pause"}
        </button>
        <button type="button" title="Download parser sample" onClick={() => runAction(actions.exportLogSample)}>
          Sample
        </button>
        <button type="button" title="Export events" onClick={() => runAction(actions.exportEvents)}>
          Export
        </button>
        <button type="button" title="Clear events" onClick={() => runAction(actions.clearEvents)}>
          Clear
        </button>
      </div>
    </div>
  );
}

function ResourceHeader() {
  return (
    <div className="csh-resource-row csh-resource-header">
      <strong>Player</strong>
      <span className="csh-resource-head" title="Total resource cards">
        Tot
      </span>
      {RESOURCE_TYPES.map((resource) => {
        const label = RESOURCE_LABELS[resource];

        return (
          <span key={resource} className={`csh-resource-head csh-resource-${resource}`} title={label.label}>
            <ResourceIcon resource={resource} decorative />
          </span>
        );
      })}
    </div>
  );
}

function TrackedPlayerRow({ row }) {
  return (
    <div className="csh-resource-row">
      <PlayerName as="strong" name={row.displayName} color={row.color} title={row.displayName} />
      <TotalCell range={row.totalRange} />
      {RESOURCE_TYPES.map((resource) => (
        <ResourceCell key={resource} range={row.ranges[resource]} resource={resource} />
      ))}
    </div>
  );
}

function PlayerName({ name, displayName, color, title, className = "", as: Tag = "span" }) {
  const label = displayName || name;
  const style = color ? { "--csh-player-color": color } : undefined;
  const classes = ["csh-player-name", color ? "csh-player-name-colored" : "", className].filter(Boolean).join(" ");

  return (
    <Tag className={classes} title={title || name} style={style}>
      {label}
    </Tag>
  );
}

function ResourceTotalRow({ totals }) {
  if (!totals) {
    return null;
  }

  return (
    <div className="csh-resource-row csh-resource-total-row">
      <strong>Total</strong>
      <TotalCell range={totals.totalRange} />
      {RESOURCE_TYPES.map((resource) => (
        <ResourceCell key={resource} range={totals.ranges[resource]} resource={resource} total />
      ))}
    </div>
  );
}

function TotalCell({ range }) {
  const value = formatRange(range);

  return (
    <span className="csh-total-cell" title={`Total resource cards: ${value}`}>
      {value}
    </span>
  );
}

function ResourceCell({ range, resource, total = false }) {
  const value = formatRange(range);
  const className = [
    "csh-resource-cell",
    `csh-resource-${resource}`,
    total ? "csh-total-resource-cell" : "",
    range.min === range.max ? "" : "csh-uncertain"
  ]
    .filter(Boolean)
    .join(" ");
  const title = `${total ? "Total " : ""}${RESOURCE_LABELS[resource].label}: ${value}`;

  return (
    <span className={className} title={title} style={{ "--csh-fill": `${getResourceFillPercent(range)}%` }}>
      <span className="csh-resource-fill" />
      <span className="csh-resource-value">{value}</span>
    </span>
  );
}

function ResourceIcon({ resource, decorative = false, className = "" }) {
  const label = RESOURCE_LABELS[resource];

  if (!label) {
    return null;
  }

  return (
    <span
      className={["csh-resource-icon", `csh-resource-${resource}`, className].filter(Boolean).join(" ")}
      title={label.label}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? "true" : undefined}
      aria-label={decorative ? undefined : label.label}
    >
      <span className="csh-resource-icon-mark" />
    </span>
  );
}

function RobberyRow({ robbery }) {
  const status = robbery.resolved ? "resolved" : "pending";
  const resources = robbery.resolved ? [robbery.resolved] : robbery.possible;
  const title = robbery.raw || `${robbery.to} stole from ${robbery.from}`;

  return (
    <div className={`csh-steal-row csh-steal-${status}`} title={title}>
      <span className="csh-steal-route">
        <PlayerName as="strong" name={robbery.to} displayName={formatShortPlayerName(robbery.to)} color={robbery.toColor} /> stole from{" "}
        <PlayerName name={robbery.from} displayName={formatShortPlayerName(robbery.from)} color={robbery.fromColor} />
      </span>
      <span className="csh-steal-resources">
        {resources.map((resource) => (
          <ResourceTag key={resource} resource={resource} />
        ))}
      </span>
      <span className="csh-steal-state">{status}</span>
    </div>
  );
}

function ResourceTag({ resource }) {
  const label = RESOURCE_LABELS[resource];

  if (!label) {
    return null;
  }

  return (
    <span className={`csh-resource-tag csh-resource-${resource}`} title={label.label}>
      <ResourceIcon resource={resource} decorative />
    </span>
  );
}

function MonopolyPanel({ monopoly, actions }) {
  return (
    <div className="csh-monopoly">
      <div className="csh-section-title">Monopoly</div>
      <div className="csh-monopoly-panel">
        <div className="csh-monopoly-head">
          <PlayerName
            as="strong"
            name={monopoly.actor}
            displayName={formatShortPlayerName(monopoly.actor)}
            color={monopoly.actorColor}
            title={monopoly.actor}
          />
          <select
            value={monopoly.resource}
            title="Resource stolen by Monopoly"
            onChange={(event) => actions.setMonopolyResource(monopoly.eventId, event.target.value)}
          >
            {RESOURCE_TYPES.map((resource) => (
              <option key={resource} value={resource}>
                {RESOURCE_LABELS[resource].label}
              </option>
            ))}
          </select>
        </div>
        <div className="csh-monopoly-note">Enter total cards left</div>
        <div className="csh-monopoly-grid">
          {monopoly.victims.map((victim) => (
            <label key={victim.player} className="csh-monopoly-victim">
              <span title={victim.displayName}>
                <PlayerName
                  name={victim.displayName}
                  displayName={formatShortPlayerName(victim.displayName)}
                  color={victim.color}
                  title={victim.displayName}
                />{" "}
                <small>{formatRange(victim.totalRange)}</small>
              </span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={victim.value}
                title="Total cards left after Monopoly"
                onChange={(event) => actions.setMonopolyLeftTotal(monopoly.eventId, victim.player, event.target.value)}
              />
            </label>
          ))}
        </div>
        <button type="button" onClick={() => actions.saveMonopolyCorrection(monopoly.eventId)}>
          Apply
        </button>
      </div>
    </div>
  );
}

function EventRow({ eventRecord }) {
  return (
    <div className="csh-event-row">
      <span className="csh-source">{String(eventRecord.source || "").toUpperCase()}</span>
      <span className="csh-event-text" title={eventRecord.raw}>
        <VisualizedLogText text={eventRecord.raw} playerColors={eventRecord.playerColors} />
      </span>
    </div>
  );
}

function VisualizedLogText({ text, playerColors = {} }) {
  const value = String(text || "");
  const tokens = getVisualLogTokens(value, playerColors);
  const parts = [];
  let lastIndex = 0;

  for (const token of tokens) {
    if (token.start > lastIndex) {
      parts.push(value.slice(lastIndex, token.start));
    }

    if (token.type === "resource") {
      parts.push(<ResourceIcon key={`${token.start}-${token.resource}`} resource={token.resource} className="csh-inline-resource-icon" />);
    } else {
      const playerName = value.slice(token.start, token.end);

      parts.push(
        <PlayerName
          key={`${token.start}-${playerName}`}
          as="strong"
          name={playerName}
          color={token.color}
          className="csh-inline-player-name"
        />
      );
    }

    lastIndex = token.end;
  }

  if (lastIndex < value.length) {
    parts.push(value.slice(lastIndex));
  }

  return parts.length ? parts : text;
}

function getVisualLogTokens(text, playerColors) {
  const tokens = [];
  const resourcePattern = new RegExp("\\[(" + RESOURCE_TYPES.join("|") + ")\\]", "gi");

  for (const match of text.matchAll(resourcePattern)) {
    tokens.push({
      type: "resource",
      start: match.index,
      end: match.index + match[0].length,
      resource: match[1].toLowerCase()
    });
  }

  const playerEntries = Object.entries(playerColors || {})
    .filter(([player, color]) => player && color)
    .sort(([first], [second]) => second.length - first.length);

  for (const [player, color] of playerEntries) {
    const playerPattern = new RegExp("(^|[^A-Za-z0-9_.-])(" + escapeRegExp(player) + ")(?=$|[^A-Za-z0-9_.-])", "g");

    for (const match of text.matchAll(playerPattern)) {
      const start = match.index + (match[1] ? match[1].length : 0);
      tokens.push({
        type: "player",
        start,
        end: start + match[2].length,
        color
      });
    }
  }

  return tokens
    .sort((first, second) => {
      if (first.start !== second.start) {
        return first.start - second.start;
      }

      return second.end - second.start - (first.end - first.start);
    })
    .filter((token, index, sortedTokens) => {
      return !sortedTokens.slice(0, index).some((previous) => token.start < previous.end && token.end > previous.start);
    });
}

function formatRange(range) {
  return range.min === range.max ? String(range.max) : `${range.min}-${range.max}`;
}

function getResourceFillPercent(range) {
  const value = Math.max(range.max, range.min);

  if (!value) {
    return 0;
  }

  return Math.min(100, Math.max(12, Math.round((value / RESOURCE_BAR_MAX) * 100)));
}

function formatShortPlayerName(playerName) {
  const player = String(playerName || "").replace(/\s+/g, " ").trim();

  if (player.length <= 11) {
    return player;
  }

  return `${player.slice(0, 10)}...`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getResizeBounds(root) {
  const rect = root.getBoundingClientRect();
  const maxWidth = Math.max(0, window.innerWidth - rect.left - VIEWPORT_MARGIN);
  const maxHeight = Math.max(0, window.innerHeight - rect.top - VIEWPORT_MARGIN);

  return {
    minWidth: Math.min(MIN_OVERLAY_WIDTH, maxWidth),
    minHeight: Math.min(MIN_OVERLAY_HEIGHT, maxHeight),
    maxWidth,
    maxHeight
  };
}

function safelySetPointerCapture(target, pointerId) {
  try {
    target.setPointerCapture(pointerId);
  } catch (_error) {
    // Document-level listeners keep the resize active if capture is unavailable.
  }
}

function safelyReleasePointerCapture(target, pointerId) {
  try {
    if (target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  } catch (_error) {
    // The browser may already have released capture after pointer cancellation.
  }
}

function clamp(value, min, max) {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);

  return Math.min(Math.max(value, lower), upper);
}
