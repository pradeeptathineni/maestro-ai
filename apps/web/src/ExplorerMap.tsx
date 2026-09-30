import { useEffect, useRef, useState } from 'react';
import type { Graph as G6Graph } from '@antv/g6';
import type { ExplorerGraphData } from './types.js';

const conciseGroupLabels: Record<string, string> = {
  'Agent control planes': 'Agent control',
  'Agent workflow evaluation': 'Agent UX evaluation',
  'Capability infrastructure': 'Infrastructure',
  'Context and code intelligence': 'Code context',
  'Observability and evaluation': 'Evaluation',
  'Registries and discovery': 'Discovery',
  'Skills and plugins': 'Skills & plugins',
  'Tool and agent protocols': 'Tool protocols',
};

export function ExplorerMap({
  data,
  selectedId,
  onSelect,
}: {
  data: ExplorerGraphData;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const graphRef = useRef<G6Graph | null>(null);
  const [mapSearch, setMapSearch] = useState('');
  const [renderState, setRenderState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [showAccessibleList, setShowAccessibleList] = useState(false);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeFrame: number | null = null;
    async function render() {
      if (!container.current) return;
      setRenderState('loading');
      try {
        const { Graph, NodeEvent } = await import('@antv/g6');
        if (disposed || !container.current) return;
        graphRef.current?.destroy();
        const groups = data.nodes.filter((node) => node.type === 'capability_group');
        const groupIds = new Set(groups.map((node) => node.id));
        const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(groups.length * 1.5))));
        const cellWidth = 250;
        const cellHeight = 220;
        const groupPositions = new Map(
          groups.map((node, index) => [
            node.group,
            {
              x: (index % columns) * cellWidth + cellWidth / 2,
              y: Math.floor(index / columns) * cellHeight + cellHeight / 2,
            },
          ]),
        );
        const groupMembers = new Map<string, typeof data.nodes>();
        for (const node of data.nodes) {
          if (node.type === 'capability_group') continue;
          groupMembers.set(node.group, [...(groupMembers.get(node.group) ?? []), node]);
        }
        const graph = new Graph({
          container: container.current,
          autoFit: 'view',
          data: {
            nodes: data.nodes.map((node) => {
              const isGroup = groupIds.has(node.id);
              const center = groupPositions.get(node.group) ?? { x: 0, y: 0 };
              const members = groupMembers.get(node.group) ?? [];
              const memberIndex = members.findIndex((member) => member.id === node.id);
              const angle = (Math.PI * 2 * Math.max(0, memberIndex)) / Math.max(1, members.length);
              const radius = Math.min(82, 48 + members.length * 4);
              const isSelected = node.resultItemId === selectedId;
              return {
                id: node.id,
                data: { resultItemId: node.resultItemId, group: node.group, label: node.label },
                style: {
                  x: isGroup ? center.x : center.x + Math.cos(angle) * radius,
                  y: isGroup ? center.y : center.y + Math.sin(angle) * radius,
                  label: isGroup || isSelected,
                  labelText: isGroup ? (conciseGroupLabels[node.label] ?? node.label) : node.label,
                  labelPlacement: isGroup ? 'center' : 'bottom',
                  labelMaxWidth: isGroup ? 104 : 90,
                  labelWordWrap: isGroup,
                  labelFontSize: isGroup ? 10 : 9,
                  labelFontWeight: isGroup ? 600 : 500,
                  labelFill: isGroup ? '#fffefa' : '#1f2925',
                  labelBackground: !isGroup && isSelected,
                  labelBackgroundFill: '#fffefa',
                  labelBackgroundPadding: [3, 5],
                  size: isGroup ? 72 : 22,
                  fill: isGroup
                    ? '#174235'
                    : node.type === 'document'
                      ? '#dce4f3'
                      : node.displayState === 'provisional'
                        ? '#f2deb0'
                        : '#dcebe2',
                  stroke: isSelected ? '#de9c27' : '#225b48',
                  lineWidth: isSelected ? 4 : 1.5,
                },
              };
            }),
            edges: data.edges.map((edge) => ({
              id: edge.id,
              source: edge.source,
              target: edge.target,
              data: { type: edge.type, status: edge.status, scope: edge.scope },
              style: {
                stroke: edge.id.startsWith('grouping:')
                  ? '#8ba99a'
                  : edge.status === 'provisional'
                    ? '#b87824'
                    : '#315b87',
                lineDash: edge.status === 'provisional' ? [5, 4] : undefined,
                lineWidth: edge.id.startsWith('grouping:') ? 1 : 2,
              },
            })),
          },
          node: { type: 'circle' },
          edge: { type: 'line' },
          behaviors: ['drag-canvas', 'zoom-canvas', 'hover-activate'],
          animation: false,
        });
        graph.on(NodeEvent.CLICK, (event) => {
          const target = (event as unknown as { target?: { id?: string } }).target;
          const id = target?.id ?? '';
          const node = data.nodes.find((item) => item.id === id);
          if (node?.resultItemId) onSelect(node.resultItemId);
        });
        await graph.render();
        if (!disposed) {
          graphRef.current = graph;
          resizeObserver = new ResizeObserver(() => {
            if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(() => {
              resizeFrame = null;
              graph.resize();
              void graph.fitView({ when: 'overflow' });
            });
          });
          resizeObserver.observe(container.current);
          setRenderState('ready');
        } else {
          graph.destroy();
        }
      } catch {
        if (!disposed) setRenderState('failed');
      }
    }
    void render();
    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      graphRef.current?.destroy();
      graphRef.current = null;
    };
  }, [data, onSelect, selectedId]);

  async function focusMatch() {
    const match = data.nodes.find(
      (node) => node.resultItemId && node.label.toLowerCase().includes(mapSearch.toLowerCase()),
    );
    if (match) {
      onSelect(match.resultItemId!);
      await graphRef.current?.focusElement(match.id, { duration: 180 });
    }
  }

  return (
    <div className="explorer-map-shell" data-render-state={renderState}>
      <div className="map-toolbar" aria-label="Map controls">
        <label>
          Search in map
          <input
            value={mapSearch}
            onChange={(event) => setMapSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void focusMatch();
            }}
          />
        </label>
        <button
          className="button secondary compact"
          onClick={() => void focusMatch()}
          type="button"
        >
          Center match
        </button>
        <button
          className="button secondary compact"
          onClick={() => void graphRef.current?.fitView({ when: 'overflow' }, { duration: 180 })}
          type="button"
        >
          Fit
        </button>
        <button
          className="button secondary compact"
          onClick={() => void graphRef.current?.zoomBy(1.2, { duration: 120 })}
          type="button"
          aria-label="Zoom map in"
        >
          +
        </button>
        <button
          className="button secondary compact"
          onClick={() => void graphRef.current?.zoomBy(0.8, { duration: 120 })}
          type="button"
          aria-label="Zoom map out"
        >
          −
        </button>
      </div>
      <p className="map-count" role="status">
        Showing {data.visibleCount} of {data.filteredCount}; {data.hiddenCount} hidden by the
        bounded neighborhood. Capability hubs organize the overview and direct item-to-item lines
        preserve recorded relationships; search, select a dot, or open the keyboard list for the
        complete text alternative.
      </p>
      <div className="map-canvas" ref={container} aria-hidden="true" />
      {renderState === 'loading' ? (
        <p className="map-status">Preparing the capability map…</p>
      ) : null}
      {renderState === 'failed' ? (
        <p className="map-status">
          The canvas renderer failed; the equivalent result tree remains available.
        </p>
      ) : null}
      <div className="map-legend" aria-label="Map legend">
        <span>
          <i className="legend-dot reviewed" /> Source-backed item
        </span>
        <span>
          <i className="legend-dot provisional" /> Proposed item
        </span>
        <span>
          <i className="legend-dot document" /> Knowledge document
        </span>
        <span>
          <i className="legend-dot group" /> Capability group
        </span>
        <span>
          <i className="legend-line" /> Provides or is about a mechanism
        </span>
        <span>
          <i className="legend-line relationship" /> Recorded item relationship
        </span>
      </div>
      <section className="map-accessible-tree" aria-labelledby="map-tree-heading">
        <div className="map-tree-heading">
          <div>
            <h3 id="map-tree-heading">Equivalent map navigation</h3>
            <p>Every plotted result remains reachable without using the canvas.</p>
          </div>
          <button
            aria-controls="map-result-list"
            aria-expanded={showAccessibleList}
            className="button secondary compact"
            onClick={() => setShowAccessibleList((current) => !current)}
            type="button"
          >
            {showAccessibleList ? 'Hide item list' : `Browse ${data.accessibleItems.length} items`}
          </button>
        </div>
        {showAccessibleList ? (
          <ul id="map-result-list">
            {data.accessibleItems.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={selectedId === item.id ? 'true' : undefined}
                  onClick={() => onSelect(item.id)}
                >
                  <strong>{item.name}</strong>
                  <span>
                    {item.kind.replaceAll('_', ' ')} · {item.group}
                  </span>
                  <span>
                    {item.matchBand ?? 'Legacy'} Match ·{' '}
                    {item.signalDisplay === null
                      ? 'Signal unavailable'
                      : `Signal ${item.signalDisplay}`}{' '}
                    · {Math.round(item.evidenceConfidence * 100)}% evidence confidence ·{' '}
                    {(item.trendState ?? 'trend unavailable').replaceAll('_', ' ')}
                  </span>
                  {item.relationships.map((relationship) => (
                    <span
                      key={`${relationship.type}:${relationship.targetName}:${relationship.scope}`}
                    >
                      {relationship.type.replaceAll('_', ' ')} {relationship.targetName} ·{' '}
                      {relationship.status.replaceAll('_', ' ')}
                    </span>
                  ))}
                  {!item.relationships.length ? (
                    <span>
                      {item.relation.type.replaceAll('_', ' ')} · {item.relation.scope} ·{' '}
                      {item.relation.status.replaceAll('_', ' ')}
                    </span>
                  ) : null}
                  <small>{item.explanation}</small>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
