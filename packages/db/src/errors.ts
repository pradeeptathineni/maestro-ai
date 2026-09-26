export class NotFoundError extends Error {
  readonly code = 'not_found';
}

export class ConflictError extends Error {
  readonly code = 'revision_conflict';
}

export class DomainValidationError extends Error {
  readonly code = 'invalid_domain_input';
}
