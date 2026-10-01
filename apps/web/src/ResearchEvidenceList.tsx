import { formatDate, label } from './api.js';
import { Badge } from './ui.js';

export interface ResearchEvidenceCandidate {
  id: string;
  sourceKey: string;
  title: string;
  summary: string;
  canonicalUri: string;
  observedAt?: string | null;
  sourceClass?: string | null;
  sourceTypes?: string[];
  reviewState?: string | null;
  kindHint?: string | null;
}

export interface ResearchEvidenceItem {
  candidateId: string;
  reason: string;
  uncertainty: string | null;
  citationCandidateIds: string[];
}

export interface ResearchEvidenceSynthesis {
  contextAssessment: 'sufficient' | 'insufficient';
  abstentionReason: string | null;
  summary: string;
  summaryCitationCandidateIds: string[];
  groups: Array<{ label: string; description: string; candidateIds: string[] }>;
  items: ResearchEvidenceItem[];
  limitations: string[];
}

export function ResearchCitationList({
  candidates,
  citationCandidateIds,
  labelText = 'Evidence cited',
}: {
  candidates: ReadonlyMap<string, ResearchEvidenceCandidate>;
  citationCandidateIds: string[];
  labelText?: string;
}) {
  const citations = citationCandidateIds.flatMap((id) => {
    const candidate = candidates.get(id);
    return candidate ? [candidate] : [];
  });
  if (!citations.length) return null;
  return (
    <div className="query-signal">
      <strong>{labelText}</strong>
      {citations.map((citation) => (
        <a href={citation.canonicalUri} key={citation.id} rel="noreferrer" target="_blank">
          {citation.title} · {label(citation.sourceKey)}
          {citation.observedAt ? ` · observed ${formatDate(citation.observedAt)}` : ''}
        </a>
      ))}
    </div>
  );
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
                {candidate.kindHint ? <Badge>{label(candidate.kindHint)}</Badge> : null}
                {candidate.reviewState ? <Badge>{label(candidate.reviewState)}</Badge> : null}
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
            <ResearchCitationList
              candidates={candidates}
              citationCandidateIds={item.citationCandidateIds}
            />
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
