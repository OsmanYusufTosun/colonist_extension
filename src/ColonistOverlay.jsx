import { useEffect, useMemo, useRef, useState } from "react";

const RESOURCE_TYPES = ["lumber", "brick", "wool", "grain", "ore"];
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
  const [position, setPosition] = useState(() => ({
    left: Number.isFinite(snapshot.overlayLeft) ? snapshot.overlayLeft : null,
    top: Number.isFinite(snapshot.overlayTop) ? snapshot.overlayTop : null
  }));

  useEffect(() => {
    if (dragStateRef.current) {
      return;
    }

    if (Number.isFinite(snapshot.overlayLeft) && Number.isFinite(snapshot.overlayTop)) {
      setPosition({
        left: snapshot.overlayLeft,
        top: snapshot.overlayTop
      });
    }
  }, [snapshot.overlayLeft, snapshot.overlayTop]);

  const rootStyle = useMemo(() => {
    if (!Number.isFinite(position.left) || !Number.isFinite(position.top)) {
      return undefined;
    }

    return {
      left: `${position.left}px`,
      top: `${position.top}px`
    };
  }, [position.left, position.top]);

  function handlePointerDown(event) {
    if (event.target instanceof HTMLElement && event.target.closest("button, select, input")) {
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

    const nextLeft = clamp(dragState.startLeft + event.clientX - dragState.startX, 0, window.innerWidth - root.offsetWidth);
    const nextTop = clamp(dragState.startTop + event.clientY - dragState.startY, 0, window.innerHeight - root.offsetHeight);

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
    event.currentTarget.releasePointerCapture(event.pointerId);

    if (Number.isFinite(dragState.left) && Number.isFinite(dragState.top)) {
      actions.saveOverlayPosition(dragState.left, dragState.top);
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
        >
          <div className="csh-brand">
            <div className="csh-mark" aria-hidden="true">
              <span className="csh-mark-card csh-resource-lumber" />
              <span className="csh-mark-card csh-resource-brick" />
              <span className="csh-mark-card csh-resource-grain" />
            </div>
            <div>
              <div className="csh-title">Colonist resources</div>
              <div className="csh-subtitle" title={snapshot.statusText}>
                {snapshot.statusText}
              </div>
            </div>
          </div>
          <button
            className="csh-icon-button"
            type="button"
            title={collapsed ? "Expand" : "Collapse"}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? "+" : "-"}
          </button>
        </div>

        <div className="csh-body">
          <div className="csh-metrics">
            <Metric value={snapshot.eventCount} label="events" status={snapshot.eventCount ? "active" : "waiting"} />
            <Metric value={snapshot.domStatus} label="DOM" status={snapshot.domStatus} />
            <Metric value={snapshot.wsStatus} label="WS" status={snapshot.wsStatus} />
          </div>

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

          <div className="csh-actions">
            <button type="button" onClick={actions.scanHistory} disabled={snapshot.historyScanRunning}>
              {snapshot.historyScanRunning ? "Scanning" : "History"}
            </button>
            <button type="button" onClick={actions.togglePaused}>
              {snapshot.paused ? "Resume" : "Pause"}
            </button>
            <button type="button" onClick={actions.exportLogSample}>
              Sample
            </button>
            <button type="button" onClick={actions.exportEvents}>
              Export
            </button>
            <button type="button" onClick={actions.clearEvents}>
              Clear
            </button>
          </div>
        </div>
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

function Metric({ value, label, status }) {
  return (
    <div className={`csh-metric-card ${getStatusClass(status)}`}>
      <span>{value}</span>
      <small>{label}</small>
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
      <strong title={row.displayName}>{row.displayName}</strong>
      <TotalCell range={row.totalRange} />
      {RESOURCE_TYPES.map((resource) => (
        <ResourceCell key={resource} range={row.ranges[resource]} resource={resource} />
      ))}
    </div>
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
        <strong>{formatShortPlayerName(robbery.to)}</strong> stole from {formatShortPlayerName(robbery.from)}
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
          <strong title={monopoly.actor}>{formatShortPlayerName(monopoly.actor)}</strong>
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
                {formatShortPlayerName(victim.displayName)} <small>{formatRange(victim.totalRange)}</small>
              </span>
              <input
                type="number"
                min="0"
                max="99"
                inputMode="numeric"
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
        <VisualizedLogText text={eventRecord.raw} />
      </span>
    </div>
  );
}

function VisualizedLogText({ text }) {
  const parts = [];
  const resourcePattern = new RegExp("\\[(" + RESOURCE_TYPES.join("|") + ")\\]", "gi");
  let lastIndex = 0;

  for (const match of String(text || "").matchAll(resourcePattern)) {
    if (match.index > lastIndex) {
      parts.push(String(text).slice(lastIndex, match.index));
    }

    parts.push(<ResourceIcon key={`${match.index}-${match[1]}`} resource={match[1].toLowerCase()} className="csh-inline-resource-icon" />);
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < String(text || "").length) {
    parts.push(String(text).slice(lastIndex));
  }

  return parts.length ? parts : text;
}

function getStatusClass(status) {
  if (/connected|readable|active|hooked/i.test(String(status))) {
    return "csh-status-good";
  }

  if (/searching|waiting|history|scanning/i.test(String(status))) {
    return "csh-status-warn";
  }

  return "csh-status-idle";
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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
