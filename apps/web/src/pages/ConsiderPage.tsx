import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, formatDate, formString, label } from '../api.js';
import type { Intake, ProviderSummary } from '../types.js';
import { Badge, Empty, ErrorPanel, InputError, Loading, PageHeader, StateBadge } from '../ui.js';

interface IntakeReceipt extends Intake {
  duplicate: boolean;
  duplicateReason?: string;
}

interface IntakeDetail extends Intake {
  note: string | null;
  contentDigest: string | null;
  events: Array<{ state: string; detail: string; correlationId: string; createdAt: string }>;
}

const stateCopy: Record<string, string> = {
  captured: 'The inert source record was captured.',
  queued: 'An allowlisted metadata task is queued.',
  fetching_metadata: 'The bounded allowlisted adapter is running.',
  identity_candidates_ready: 'Strong identity is ready for human review.',
  manual_review_required: 'Captured safely; automatic retrieval is not allowed for this host.',
  rejected_invalid: 'The URL failed local policy validation.',
  fetch_failed: 'Metadata retrieval stopped safely; no content was executed.',
  curated: 'A human attached this intake to a reviewed provider.',
  merged_duplicate: 'A human linked this duplicate to an existing provider.',
};

export function ConsiderPage() {
  const [receipt, setReceipt] = useState<IntakeReceipt | null>(null);
  const [selectedIntakeId, setSelectedIntakeId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const queryClient = useQueryClient();
  const intakes = useQuery({
    queryKey: ['intakes'],
    queryFn: () => api<{ items: Intake[] }>('/api/v1/intakes'),
    refetchInterval: 3000,
  });
  const providers = useQuery({
    queryKey: ['providers-for-curation'],
    queryFn: () => api<{ items: ProviderSummary[] }>('/api/v1/providers?sort=name&limit=50'),
  });
  const intakeDetail = useQuery({
    queryKey: ['intake', selectedIntakeId],
    enabled: Boolean(selectedIntakeId),
    queryFn: () => api<IntakeDetail>(`/api/v1/intakes/${selectedIntakeId!}`),
  });
  const submit = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<IntakeReceipt>('/api/v1/intakes', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: async (result) => {
      setReceipt(result);
      setSelectedIntakeId(result.id);
      setFormError('');
      await queryClient.invalidateQueries({ queryKey: ['intakes'] });
    },
    onError: (error) =>
      setFormError(error instanceof Error ? error.message : 'Could not capture URL.'),
  });
  const curate = useMutation({
    mutationFn: ({ intakeId, providerId }: { intakeId: string; providerId: string }) =>
      api(`/api/v1/intakes/${intakeId}/curate`, {
        method: 'POST',
        body: JSON.stringify({ providerId, action: 'attach' }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['intakes'] });
      await queryClient.invalidateQueries({ queryKey: ['intake', selectedIntakeId] });
    },
  });
  const retry = useMutation({
    mutationFn: (intakeId: string) =>
      api(`/api/v1/intakes/${intakeId}/retry`, { method: 'POST', body: '{}' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['intakes'] });
      await queryClient.invalidateQueries({ queryKey: ['intake', selectedIntakeId] });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError('');
    const data = new FormData(event.currentTarget);
    submit.mutate({
      url: formString(data, 'url'),
      note: formString(data, 'note') || undefined,
      foundBy: formString(data, 'foundBy') || 'manual',
      idempotencyKey: crypto.randomUUID(),
    });
  }

  return (
    <div className="page-shell">
      <PageHeader
        eyebrow="Safe source intake"
        title="Consider a URL"
        description="Submitting records an inert source for review. It does not install, configure, authorize, or run anything."
      />
      <div className="split-layout">
        <section className="panel form-panel" aria-labelledby="submit-url-heading">
          <h2 id="submit-url-heading">Capture a source</h2>
          <form onSubmit={onSubmit}>
            <label>
              URL
              <input
                name="url"
                type="url"
                required
                maxLength={2048}
                placeholder="https://github.com/owner/repository"
              />
            </label>
            <label>
              Optional note
              <textarea
                name="note"
                maxLength={2000}
                rows={4}
                placeholder="Why might this matter for a project need?"
              />
            </label>
            <label>
              Found via
              <select name="foundBy" defaultValue="manual">
                <option value="manual">Manual</option>
                <option value="browser_extension">Browser extension</option>
                <option value="import">Import</option>
                <option value="colleague">Colleague</option>
              </select>
            </label>
            <div className="boundary-note">
              <strong>Network boundary</strong>
              <p>
                Only an explicit GitHub metadata adapter may fetch, with no cookies or ambient
                credentials. Other hosts enter manual review.
              </p>
            </div>
            <InputError id="consider-error">{formError}</InputError>
            <button className="button" disabled={submit.isPending}>
              {submit.isPending ? 'Capturing…' : 'Capture for review'}
            </button>
          </form>
        </section>
        <section aria-labelledby="receipt-heading">
          <p className="eyebrow">Latest receipt</p>
          <h2 id="receipt-heading">What happened</h2>
          {receipt ? (
            <article className="intake-receipt" aria-live="polite">
              <div className="card-topline">
                <StateBadge state={receipt.state} />
                {receipt.duplicate ? (
                  <Badge tone="warning">
                    Duplicate · {label(receipt.duplicateReason ?? 'match')}
                  </Badge>
                ) : (
                  <Badge tone="positive">New intake</Badge>
                )}
              </div>
              <h3>{receipt.normalizedUrl}</h3>
              <p>{stateCopy[receipt.state] ?? 'The source remains in a reviewable state.'}</p>
              <dl className="definition-list">
                <div>
                  <dt>Intake ID</dt>
                  <dd>
                    <code>{receipt.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>Host</dt>
                  <dd>{receipt.hostname}</dd>
                </div>
                {receipt.strongIdentity ? (
                  <div>
                    <dt>Strong identity</dt>
                    <dd>
                      {receipt.strongIdentity.scheme}: {receipt.strongIdentity.value}
                    </dd>
                  </div>
                ) : null}
              </dl>
              <ol className="timeline" aria-label="Intake progress">
                {[
                  'Captured',
                  'Policy check',
                  'Metadata',
                  'Identity suggestions',
                  'Needs review',
                  'Curated',
                ].map((step, index) => (
                  <li
                    key={step}
                    className={
                      index <= (receipt.state === 'manual_review_required' ? 1 : 2) ? 'done' : ''
                    }
                  >
                    {step}
                  </li>
                ))}
              </ol>
            </article>
          ) : (
            <Empty title="No submission in this session">
              Enter a URL to see its normalized receipt, duplicate result, and safe next state.
            </Empty>
          )}
        </section>
      </div>

      <section aria-labelledby="intakes-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Curation queue</p>
            <h2 id="intakes-heading">Recent source intakes</h2>
          </div>
        </div>
        {intakes.isPending ? <Loading /> : null}
        {intakes.isError ? <ErrorPanel error={intakes.error} /> : null}
        {intakes.data?.items.length === 0 ? (
          <Empty title="No sources captured">
            Submitted URLs will appear here with factual state and recovery guidance.
          </Empty>
        ) : null}
        {intakes.data?.items.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">State</th>
                  <th scope="col">Handling</th>
                  <th scope="col">Found via</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Review action</th>
                </tr>
              </thead>
              <tbody>
                {intakes.data.items.map((intake) => (
                  <tr key={intake.id}>
                    <th scope="row">
                      <span>{intake.normalizedUrl}</span>
                      <small>
                        {intake.failureCode
                          ? `Failure: ${label(intake.failureCode)}`
                          : intake.hostname}
                      </small>
                    </th>
                    <td>
                      <StateBadge state={intake.state} />
                      <small>{stateCopy[intake.state]}</small>
                    </td>
                    <td>{label(intake.handlingStatus)}</td>
                    <td>{label(intake.foundBy)}</td>
                    <td>{formatDate(intake.updatedAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => setSelectedIntakeId(intake.id)}
                        >
                          View history
                        </button>
                        {intake.state === 'fetch_failed' &&
                        intake.retryDisposition === 'transient' ? (
                          <button
                            className="text-button"
                            type="button"
                            disabled={retry.isPending}
                            onClick={() => retry.mutate(intake.id)}
                          >
                            Retry safely
                          </button>
                        ) : null}
                        {[
                          'manual_review_required',
                          'identity_candidates_ready',
                          'fetch_failed',
                        ].includes(intake.state) ? (
                          <form
                            className="curation-form"
                            onSubmit={(event) => {
                              event.preventDefault();
                              const providerId = formString(
                                new FormData(event.currentTarget),
                                'providerId',
                              );
                              if (providerId) curate.mutate({ intakeId: intake.id, providerId });
                            }}
                          >
                            <label htmlFor={`provider-${intake.id}`} className="sr-only">
                              Existing provider for {intake.normalizedUrl}
                            </label>
                            <select
                              id={`provider-${intake.id}`}
                              name="providerId"
                              required
                              defaultValue=""
                            >
                              <option value="" disabled>
                                Attach to reviewed provider…
                              </option>
                              {providers.data?.items.map((provider) => (
                                <option value={provider.id} key={provider.id}>
                                  {provider.name}
                                </option>
                              ))}
                            </select>
                            <button
                              className="text-button"
                              disabled={curate.isPending}
                              type="submit"
                            >
                              Attach
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {selectedIntakeId ? (
        <section className="panel" aria-labelledby="intake-history-heading">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Append-only state history</p>
              <h2 id="intake-history-heading">Intake events</h2>
            </div>
            <button className="text-button" type="button" onClick={() => setSelectedIntakeId(null)}>
              Close history
            </button>
          </div>
          {intakeDetail.isPending ? <Loading message="Loading intake history…" /> : null}
          {intakeDetail.isError ? <ErrorPanel error={intakeDetail.error} /> : null}
          {intakeDetail.data ? (
            <>
              <p className="section-intro">
                {intakeDetail.data.normalizedUrl} · revision {intakeDetail.data.revision}
              </p>
              <ol className="event-list">
                {intakeDetail.data.events.map((event) => (
                  <li key={`${event.createdAt}:${event.state}`}>
                    <StateBadge state={event.state} />
                    <div>
                      <strong>{event.detail}</strong>
                      <small>
                        {formatDate(event.createdAt)} · correlation {event.correlationId}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
