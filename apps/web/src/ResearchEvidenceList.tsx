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
  protocolVersion: string;
  contextAssessment: 'sufficient' | 'insufficient' | 'legacy';
  abstentionReason: string | null;
  summary: string;
  summaryCitationCandidateIds: string[];
  groups: Array<{ label: string; description: string; candidateIds: string[] }>;
  items: ResearchEvidenceItem[];
  limitations: string[];
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

/** Normalize immutable v1 and v2 proposal history without rewriting it. */
export function normalizeResearchEvidenceSynthesis(
  value: unknown,
): ResearchEvidenceSynthesis | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proposal = value as Record<string, unknown>;
  if (
    typeof proposal.protocolVersion !== 'string' ||
    typeof proposal.summary !== 'string' ||
    !Array.isArray(proposal.groups) ||
    !Array.isArray(proposal.items)
  ) {
    return null;
  }
  const limitations = strings(proposal.limitations);
  if (!limitations) return null;
  const items: ResearchEvidenceItem[] = [];
  for (const valueItem of proposal.items) {
    if (!valueItem || typeof valueItem !== 'object' || Array.isArray(valueItem)) return null;
    const item = valueItem as Record<string, unknown>;
    const citationCandidateIds = strings(item.citationCandidateIds);
    if (
      typeof item.candidateId !== 'string' ||
      typeof item.reason !== 'string' ||
      (item.uncertainty !== null && typeof item.uncertainty !== 'string') ||
      !citationCandidateIds
    ) {
      return null;
    }
    items.push({
      candidateId: item.candidateId,
      reason: item.reason,
      uncertainty: item.uncertainty,
      citationCandidateIds,
    });
  }
  const groups: ResearchEvidenceSynthesis['groups'] = [];
  for (const valueGroup of proposal.groups) {
    if (!valueGroup || typeof valueGroup !== 'object' || Array.isArray(valueGroup)) return null;
    const group = valueGroup as Record<string, unknown>;
    const candidateIds = strings(group.candidateIds);
    if (typeof group.label !== 'string' || typeof group.description !== 'string' || !candidateIds) {
      return null;
    }
    groups.push({ label: group.label, description: group.description, candidateIds });
  }
  if (proposal.protocolVersion === 'research-protocol-v1') {
    return {
      protocolVersion: proposal.protocolVersion,
      contextAssessment: 'legacy',
      abstentionReason: null,
      summary: proposal.summary,
      summaryCitationCandidateIds: [...new Set(items.flatMap((item) => item.citationCandidateIds))],
      groups,
      items,
      limitations,
    };
  }
  const summaryCitationCandidateIds = strings(proposal.summaryCitationCandidateIds);
  if (
    proposal.protocolVersion !== 'research-protocol-v2' ||
    !['sufficient', 'insufficient'].includes(String(proposal.contextAssessment)) ||
    (proposal.abstentionReason !== null && typeof proposal.abstentionReason !== 'string') ||
    !summaryCitationCandidateIds
  ) {
    return null;
  }
  return {
    protocolVersion: proposal.protocolVersion,
    contextAssessment: proposal.contextAssessment as 'sufficient' | 'insufficient',
    abstentionReason: proposal.abstentionReason,
    summary: proposal.summary,
    summaryCitationCandidateIds,
    groups,
    items,
    limitations,
  };
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
