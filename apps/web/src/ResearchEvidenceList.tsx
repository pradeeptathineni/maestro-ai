import { label } from './api.js';
import { Badge } from './ui.js';

export interface ResearchEvidenceCandidate {
  id: string;
  sourceKey: string;
  title: string;
  summary: string;
  canonicalUri: string;
  observedAt?: string | null;
}

export interface ResearchEvidenceItem {
  candidateId: string;
  reason: string;
  uncertainty: string | null;
}

export function ResearchEvidenceList({
  candidates,
  items,
  selectionLabel,
}: {
  candidates: ReadonlyMap<string, ResearchEvidenceCandidate>;
  items: ResearchEvidenceItem[];
  selectionLabel?: string;
}) {
  return (
    <div className="source-result-list">
      {items.map((item) => {
        const candidate = candidates.get(item.candidateId);
        if (!candidate) return null;
        return (
          <article className="source-result-row" key={candidate.id}>
            <div className="result-identity">
              <div className="card-topline">
                <Badge>{label(candidate.sourceKey)}</Badge>
                {selectionLabel ? <Badge>{selectionLabel}</Badge> : null}
              </div>
              <h3>{candidate.title}</h3>
              <p>{candidate.summary}</p>
            </div>
            <div className="query-signal">
              <strong>Why it surfaced</strong>
              <span>{item.reason}</span>
              {item.uncertainty ? <small>{item.uncertainty}</small> : null}
            </div>
            <a
              className="button secondary compact"
              href={candidate.canonicalUri}
              rel="noreferrer"
              target="_blank"
            >
              Open evidence
            </a>
          </article>
        );
      })}
    </div>
  );
}
