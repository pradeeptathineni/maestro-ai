import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { ApiError, label } from './api.js';

const navigation = [
  ['/decide', 'Decide'],
  ['/explore', 'Explore'],
  ['/consider', 'Consider'],
  ['/evidence', 'Evidence'],
  ['/workspace', 'Workspace'],
] as const;

export function Shell(): ReactNode {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="app-header">
        <NavLink className="brand" to="/decide" aria-label="Maestro home">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          <span>
            <strong>Maestro</strong>
            <small>Evidence to decision</small>
          </span>
        </NavLink>
        <nav aria-label="Primary navigation">
          {navigation.map(([to, text]) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>
              {text}
            </NavLink>
          ))}
        </nav>
        <span className="local-chip">Local workspace</span>
      </header>
      <main id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
      <footer>
        Maestro v0 records evidence and decisions. It does not install or run cataloged software.
      </footer>
    </>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="lede">{description}</p>
      </div>
      {action ? <div className="page-action">{action}</div> : null}
    </header>
  );
}

export function Loading({ message = 'Loading reviewed data…' }: { message?: string }): ReactNode {
  return (
    <div className="state-panel loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p>{message}</p>
    </div>
  );
}

export function ErrorPanel({ error }: { error: unknown }): ReactNode {
  const detail = error instanceof Error ? error.message : 'The request failed.';
  const correlation = error instanceof ApiError ? error.problem.correlationId : null;
  return (
    <div className="state-panel error" role="alert">
      <strong>Could not load this view</strong>
      <p>{detail}</p>
      {correlation ? <small>Correlation ID: {correlation}</small> : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="state-panel empty">
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: string;
}): ReactNode {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function StateBadge({ state }: { state: string | null | undefined }): ReactNode {
  const normalized = state ?? 'missing';
  const tone =
    normalized === 'eligible' || normalized === 'pass' || normalized === 'succeeded'
      ? 'positive'
      : normalized === 'ineligible' || normalized === 'fail' || normalized.includes('failed')
        ? 'negative'
        : normalized.includes('unknown') || normalized === 'missing'
          ? 'warning'
          : 'neutral';
  return <Badge tone={tone}>{label(normalized)}</Badge>;
}

export function Score({
  band,
  lowerBound,
  uncertainty,
}: {
  band: string | null;
  lowerBound: number | null;
  uncertainty?: number | null;
}): ReactNode {
  if (lowerBound === null || !band) {
    return (
      <div className="score missing-score">
        <strong>Insufficient coverage</strong>
        <small>No zero was substituted for missing evidence.</small>
      </div>
    );
  }
  return (
    <div className="score">
      <strong>{label(band)}</strong>
      <span>{lowerBound.toFixed(1)} conservative lower bound</span>
      {uncertainty !== undefined && uncertainty !== null ? (
        <small>{Math.round(uncertainty * 100)}% policy uncertainty</small>
      ) : null}
    </div>
  );
}

export function DefinitionList({ items }: { items: Array<[string, ReactNode]> }): ReactNode {
  return (
    <dl className="definition-list">
      {items.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function JsonDetails({ summary, value }: { summary: string; value: unknown }): ReactNode {
  return (
    <details className="json-details">
      <summary>{summary}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function InputError({ id, children }: { id: string; children?: ReactNode }): ReactNode {
  if (!children) return null;
  return (
    <p id={id} className="input-error" role="alert">
      {children}
    </p>
  );
}
