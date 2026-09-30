-- Bind append-only predecessor and supersession links to their logical owner.
-- Earlier migrations intentionally remain byte-for-byte stable; these composite
-- constraints harden both the Phase 08 records and the result/score chains they
-- extend without rewriting historical rows.

CREATE UNIQUE INDEX concept_schemes_id_scheme_unique
  ON catalog.concept_schemes (id, scheme_key);
ALTER TABLE catalog.concept_schemes
  ADD CONSTRAINT concept_schemes_supersedes_same_scheme_fkey
  FOREIGN KEY (supersedes_id, scheme_key)
  REFERENCES catalog.concept_schemes (id, scheme_key);

ALTER TABLE catalog.knowledge_entity_revisions
  ADD CONSTRAINT knowledge_entity_revisions_predecessor_same_entity_fkey
  FOREIGN KEY (predecessor_id, entity_id)
  REFERENCES catalog.knowledge_entity_revisions (id, entity_id);

CREATE UNIQUE INDEX entity_facet_assignments_id_entity_facet_unique
  ON catalog.entity_facet_assignments (id, entity_id, facet_key);
ALTER TABLE catalog.entity_facet_assignments
  ADD CONSTRAINT entity_facet_assignments_supersedes_same_facet_fkey
  FOREIGN KEY (supersedes_id, entity_id, facet_key)
  REFERENCES catalog.entity_facet_assignments (id, entity_id, facet_key);

CREATE UNIQUE INDEX knowledge_relationships_id_subject_type_unique
  ON catalog.knowledge_relationships (id, subject_entity_id, relation_type);
ALTER TABLE catalog.knowledge_relationships
  ADD CONSTRAINT knowledge_relationships_supersedes_same_subject_type_fkey
  FOREIGN KEY (supersedes_id, subject_entity_id, relation_type)
  REFERENCES catalog.knowledge_relationships (id, subject_entity_id, relation_type);

ALTER TABLE catalog.knowledge_document_revisions
  ADD CONSTRAINT knowledge_document_revisions_predecessor_same_document_fkey
  FOREIGN KEY (predecessor_id, document_id)
  REFERENCES catalog.knowledge_document_revisions (id, document_id);

CREATE UNIQUE INDEX intrinsic_signal_runs_id_entity_unique
  ON catalog.intrinsic_signal_runs (id, knowledge_entity_id);
ALTER TABLE catalog.intrinsic_signal_runs
  ADD CONSTRAINT intrinsic_signal_runs_revision_same_entity_fkey
  FOREIGN KEY (entity_revision_id, knowledge_entity_id)
  REFERENCES catalog.knowledge_entity_revisions (id, entity_id),
  ADD CONSTRAINT intrinsic_signal_runs_superseded_same_entity_fkey
  FOREIGN KEY (superseded_by, knowledge_entity_id)
  REFERENCES catalog.intrinsic_signal_runs (id, knowledge_entity_id);

CREATE UNIQUE INDEX source_reliability_id_source_unique
  ON catalog.source_reliability_assessments (id, source_id);
ALTER TABLE catalog.source_reliability_assessments
  ADD CONSTRAINT source_reliability_predecessor_same_source_fkey
  FOREIGN KEY (predecessor_id, source_id)
  REFERENCES catalog.source_reliability_assessments (id, source_id);

CREATE UNIQUE INDEX corroboration_id_subject_unique
  ON catalog.corroboration_assessments
    (id, knowledge_entity_id, predicate, applicability_scope);
ALTER TABLE catalog.corroboration_assessments
  ADD CONSTRAINT corroboration_predecessor_same_subject_fkey
  FOREIGN KEY (predecessor_id, knowledge_entity_id, predicate, applicability_scope)
  REFERENCES catalog.corroboration_assessments
    (id, knowledge_entity_id, predicate, applicability_scope);

CREATE UNIQUE INDEX query_result_sets_id_session_unique
  ON workspace.query_result_sets (id, workspace_id, query_session_id);
ALTER TABLE workspace.query_result_sets
  ADD CONSTRAINT query_result_sets_predecessor_same_session_fkey
  FOREIGN KEY (predecessor_id, workspace_id, query_session_id)
  REFERENCES workspace.query_result_sets (id, workspace_id, query_session_id);

CREATE UNIQUE INDEX query_signal_runs_id_provider_unique
  ON workspace.query_signal_runs (id, workspace_id, provider_id);
ALTER TABLE workspace.query_signal_runs
  ADD CONSTRAINT query_signal_runs_predecessor_same_provider_fkey
  FOREIGN KEY (predecessor_id, workspace_id, provider_id)
  REFERENCES workspace.query_signal_runs (id, workspace_id, provider_id);

ALTER TABLE catalog.score_runs
  ADD CONSTRAINT score_runs_predecessor_same_provider_fkey
  FOREIGN KEY (predecessor_id, provider_id)
  REFERENCES catalog.score_runs (id, provider_id),
  ADD CONSTRAINT score_runs_superseded_same_provider_fkey
  FOREIGN KEY (superseded_by, provider_id)
  REFERENCES catalog.score_runs (id, provider_id);
