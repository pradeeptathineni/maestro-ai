import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate, label } from '../api.js';
import type { DecisionDetail } from '../types.js';
import { Badge, DefinitionList, ErrorPanel, JsonDetails, Loading, PageHeader } from '../ui.js';

export function DecisionPage() {
  const { id = '' } = useParams();
  const decision = useQuery({
    queryKey: ['decision', id],
    queryFn: () => api<DecisionDetail>(`/api/v1/decisions/${id}`),
  });
  if (decision.isPending)
    return (
      <div className="page-shell">
        <Loading message="Opening immutable receipt…" />
      </div>
    );
  if (decision.isError)
    return (
      <div className="page-shell">
        <ErrorPanel error={decision.error} />
      </div>
    );
  const item = decision.data;
  return (
    <div className="page-shell narrow-shell">
      <div className="breadcrumb">
        <Link to="/decide">Decide</Link>
        <span aria-hidden="true">/</span>Decision receipt
      </div>
      <PageHeader
        eyebrow={`${item.projectName} · ${formatDate(item.decidedAt)}`}
        title={`${label(item.outcome)}: ${item.needTitle}`}
        description="This receipt is an immutable historical input snapshot. Recomputing current scores does not rewrite it."
        action={
          item.receiptVerified ? (
            <Badge tone="positive">Receipt verified by hash</Badge>
          ) : (
            <Badge tone="negative">Receipt hash mismatch</Badge>
          )
        }
      />
      <section className="panel receipt" aria-labelledby="receipt-heading">
        {!item.receiptVerified ? (
          <div className="state-panel error" role="alert">
            <strong>Historical receipt integrity check failed.</strong>
            <p>Do not rely on this decision until its stored receipt is recovered.</p>
          </div>
        ) : null}
        <div className="receipt-seal" aria-hidden="true">
          M
        </div>
        <p className="eyebrow">{item.receipt.receiptVersion}</p>
        <h2 id="receipt-heading">Human decision</h2>
        <DefinitionList
          items={[
            ['Outcome', label(item.outcome)],
            ['Selected candidate', item.selectedCandidateLabel ?? 'No candidate selected'],
            ['Rationale', item.rationale],
            [
              'Conditions',
              item.conditions.length ? (
                <ul>
                  {item.conditions.map((condition) => (
                    <li key={condition}>{condition}</li>
                  ))}
                </ul>
              ) : (
                'None'
              ),
            ],
            ['Decided at', formatDate(item.decidedAt)],
          ]}
        />
        <h3>Bound inputs</h3>
        <DefinitionList
          items={[
            [
              'Project context',
              `revision ${item.receipt.project.revision} · ${item.receipt.project.snapshotHash}`,
            ],
            ['Need revision', `${item.receipt.needRevision}`],
            ['Candidates', `${item.receipt.candidateIds.length} immutable identifiers`],
            ['Score runs', `${item.receipt.scoreRunIds.length} recorded runs`],
            ['Fit assessments', `${item.receipt.fitAssessmentIds.length} recorded assessments`],
            ['Evidence items', `${item.receipt.evidenceIds.length} identifiers`],
            ['Policies', item.receipt.policyVersions.join(', ')],
            ['Input hash', <code>{item.inputHash}</code>],
          ]}
        />
        <JsonDetails summary="Inspect complete receipt" value={item.receipt} />
      </section>
    </div>
  );
}
