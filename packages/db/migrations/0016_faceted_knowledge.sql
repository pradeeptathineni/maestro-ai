-- Phase 08 faceted concept and canonical-entity compatibility layer.
-- Existing provider, document, evidence, score, receipt, and query records remain authoritative.

CREATE TABLE catalog.facet_definitions (
  facet_key text PRIMARY KEY
    CHECK (facet_key IN ('entity_class', 'interface', 'service_model', 'domain',
                         'capability', 'document_type')),
  label text NOT NULL,
  description text NOT NULL,
  selection_mode text NOT NULL CHECK (selection_mode IN ('single', 'multiple')),
  display_order integer NOT NULL CHECK (display_order > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO catalog.facet_definitions
  (facet_key, label, description, selection_mode, display_order)
VALUES
  ('entity_class', 'Entity class', 'What kind of knowledge subject this is.', 'single', 10),
  ('interface', 'Interface', 'How the subject is accessed or composed.', 'multiple', 20),
  ('service_model', 'Service model', 'How the subject is operated or delivered.', 'multiple', 30),
  ('domain', 'Domain', 'Fields of practice or study associated with the subject.', 'multiple', 40),
  ('capability', 'Capability', 'What the subject can provide, explain, or support.', 'multiple', 50),
  ('document_type', 'Document type', 'The publication form of a knowledge document.', 'single', 60)
ON CONFLICT (facet_key) DO NOTHING;

CREATE TABLE catalog.concept_schemes (
  id uuid PRIMARY KEY,
  scheme_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'active', 'superseded')),
  source_uri text,
  supersedes_id uuid REFERENCES catalog.concept_schemes(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scheme_key, version)
);

CREATE TABLE catalog.concepts (
  id uuid PRIMARY KEY,
  concept_scheme_id uuid NOT NULL REFERENCES catalog.concept_schemes(id),
  facet_key text NOT NULL REFERENCES catalog.facet_definitions(facet_key),
  stable_key text NOT NULL,
  preferred_label text NOT NULL,
  definition text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'deprecated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (concept_scheme_id, stable_key),
  UNIQUE (id, concept_scheme_id),
  UNIQUE (id, facet_key)
);

CREATE TABLE catalog.concept_labels (
  id uuid PRIMARY KEY,
  concept_id uuid NOT NULL REFERENCES catalog.concepts(id),
  label text NOT NULL,
  normalized_label text NOT NULL,
  label_kind text NOT NULL CHECK (label_kind IN ('preferred', 'alternate', 'hidden')),
  locale text NOT NULL DEFAULT 'en',
  source_observation_id uuid REFERENCES catalog.source_observations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (concept_id, normalized_label, label_kind, locale)
);

CREATE INDEX concept_labels_lookup_idx
  ON catalog.concept_labels (normalized_label, locale, label_kind);
CREATE INDEX concept_labels_trgm_idx
  ON catalog.concept_labels USING gin (normalized_label gin_trgm_ops);

CREATE TABLE catalog.concept_relations (
  id uuid PRIMARY KEY,
  concept_scheme_id uuid NOT NULL REFERENCES catalog.concept_schemes(id),
  subject_concept_id uuid NOT NULL,
  relation_type text NOT NULL
    CHECK (relation_type IN ('broader', 'narrower', 'related', 'exact_match', 'close_match')),
  object_concept_id uuid NOT NULL,
  source_observation_id uuid REFERENCES catalog.source_observations(id),
  evidence_basis jsonb NOT NULL CHECK (
    jsonb_typeof(evidence_basis) = 'object' AND evidence_basis <> '{}'::jsonb
  ),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_concept_id, concept_scheme_id)
    REFERENCES catalog.concepts(id, concept_scheme_id),
  FOREIGN KEY (object_concept_id, concept_scheme_id)
    REFERENCES catalog.concepts(id, concept_scheme_id),
  CHECK (subject_concept_id <> object_concept_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (concept_scheme_id, subject_concept_id, relation_type, object_concept_id, valid_from)
);

CREATE INDEX concept_relations_subject_idx
  ON catalog.concept_relations (subject_concept_id, relation_type, valid_from DESC);
CREATE INDEX concept_relations_object_idx
  ON catalog.concept_relations (object_concept_id, relation_type, valid_from DESC);

CREATE TABLE catalog.knowledge_entities (
  id uuid PRIMARY KEY,
  source_kind text NOT NULL CHECK (source_kind IN ('provider', 'document')),
  provider_id uuid UNIQUE REFERENCES catalog.providers(id),
  document_id uuid UNIQUE REFERENCES catalog.knowledge_documents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((provider_id IS NOT NULL)::integer + (document_id IS NOT NULL)::integer = 1),
  CHECK ((source_kind = 'provider' AND provider_id IS NOT NULL) OR
         (source_kind = 'document' AND document_id IS NOT NULL))
);

CREATE TABLE catalog.knowledge_entity_revisions (
  id uuid PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES catalog.knowledge_entities(id),
  revision integer NOT NULL CHECK (revision > 0),
  entity_class_concept_id uuid NOT NULL,
  entity_class_facet_key text NOT NULL DEFAULT 'entity_class'
    CHECK (entity_class_facet_key = 'entity_class'),
  preferred_label text NOT NULL,
  summary text NOT NULL,
  lifecycle_state text NOT NULL,
  source_observation_id uuid REFERENCES catalog.source_observations(id),
  predecessor_id uuid REFERENCES catalog.knowledge_entity_revisions(id),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (entity_class_concept_id, entity_class_facet_key)
    REFERENCES catalog.concepts(id, facet_key),
  UNIQUE (entity_id, revision),
  UNIQUE (id, entity_id)
);

CREATE TABLE catalog.entity_facet_assignments (
  id uuid PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES catalog.knowledge_entities(id),
  concept_id uuid NOT NULL,
  facet_key text NOT NULL REFERENCES catalog.facet_definitions(facet_key),
  origin text NOT NULL
    CHECK (origin IN ('legacy_migration', 'manual', 'source_assertion', 'derived', 'model_proposal')),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  rationale text NOT NULL,
  source_observation_id uuid REFERENCES catalog.source_observations(id),
  evidence_item_ids uuid[] NOT NULL DEFAULT '{}',
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  supersedes_id uuid REFERENCES catalog.entity_facet_assignments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (concept_id, facet_key) REFERENCES catalog.concepts(id, facet_key),
  CHECK (facet_key <> 'entity_class'),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (entity_id, concept_id, valid_from)
);

CREATE INDEX entity_facet_active_idx
  ON catalog.entity_facet_assignments (facet_key, concept_id, entity_id)
  WHERE valid_to IS NULL;

CREATE TABLE catalog.knowledge_relationships (
  id uuid PRIMARY KEY,
  subject_entity_id uuid NOT NULL REFERENCES catalog.knowledge_entities(id),
  relation_type text NOT NULL CHECK (length(relation_type) BETWEEN 1 AND 100),
  object_entity_id uuid REFERENCES catalog.knowledge_entities(id),
  object_concept_id uuid REFERENCES catalog.concepts(id),
  direction text NOT NULL CHECK (direction IN ('directed', 'symmetric')),
  source_observation_id uuid REFERENCES catalog.source_observations(id),
  evidence_item_ids uuid[] NOT NULL DEFAULT '{}',
  evidence_basis jsonb NOT NULL CHECK (
    jsonb_typeof(evidence_basis) = 'object' AND evidence_basis <> '{}'::jsonb
  ),
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  revision_scope jsonb NOT NULL CHECK (jsonb_typeof(revision_scope) = 'object'),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  state text NOT NULL CHECK (state IN ('proposed', 'reviewed', 'superseded', 'rejected')),
  supersedes_id uuid REFERENCES catalog.knowledge_relationships(id),
  legacy_source_table text,
  legacy_source_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((object_entity_id IS NOT NULL)::integer +
         (object_concept_id IS NOT NULL)::integer = 1),
  CHECK (object_entity_id IS NULL OR object_entity_id <> subject_entity_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (legacy_source_table, legacy_source_key)
);

CREATE INDEX knowledge_relationships_subject_idx
  ON catalog.knowledge_relationships (subject_entity_id, relation_type, valid_from DESC);
CREATE INDEX knowledge_relationships_object_entity_idx
  ON catalog.knowledge_relationships (object_entity_id, relation_type, valid_from DESC)
  WHERE object_entity_id IS NOT NULL;
CREATE INDEX knowledge_relationships_object_concept_idx
  ON catalog.knowledge_relationships (object_concept_id, relation_type, valid_from DESC)
  WHERE object_concept_id IS NOT NULL;

CREATE TABLE catalog.knowledge_document_revisions (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES catalog.knowledge_documents(id),
  revision integer NOT NULL CHECK (revision > 0),
  predecessor_id uuid REFERENCES catalog.knowledge_document_revisions(id),
  supersedes_document_id uuid REFERENCES catalog.knowledge_documents(id),
  title text NOT NULL,
  summary text NOT NULL,
  canonical_uri text NOT NULL,
  publication_state text NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  source_observation_id uuid NOT NULL REFERENCES catalog.source_observations(id),
  observed_at timestamptz NOT NULL,
  change_kind text NOT NULL
    CHECK (change_kind IN ('initial', 'content_update', 'correction', 'supersession', 'withdrawal')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision),
  UNIQUE (id, document_id),
  CHECK (supersedes_document_id IS NULL OR supersedes_document_id <> document_id)
);

-- Mirror the legacy domain taxonomies as concept schemes without changing them.
INSERT INTO catalog.concept_schemes
  (id, scheme_key, version, title, status, created_at)
SELECT id, taxonomy_key, version, 'Domain taxonomy ' || taxonomy_key,
       status, created_at
FROM catalog.domain_taxonomy_versions
ON CONFLICT (scheme_key, version) DO NOTHING;

INSERT INTO catalog.concepts
  (id, concept_scheme_id, facet_key, stable_key, preferred_label, definition, status, created_at)
SELECT node.id, node.taxonomy_version_id, 'domain', node.stable_key, node.label,
       node.definition, node.status, version.created_at
FROM catalog.domain_nodes node
JOIN catalog.domain_taxonomy_versions version ON version.id = node.taxonomy_version_id
ON CONFLICT (concept_scheme_id, stable_key) DO NOTHING;

INSERT INTO catalog.concept_labels
  (id, concept_id, label, normalized_label, label_kind, locale, created_at)
SELECT gen_random_uuid(), node.id, node.label,
       lower(regexp_replace(normalize(node.label, NFKC), '[^[:alnum:]]+', ' ', 'g')),
       'preferred', 'en', version.created_at
FROM catalog.domain_nodes node
JOIN catalog.domain_taxonomy_versions version ON version.id = node.taxonomy_version_id
ON CONFLICT (concept_id, normalized_label, label_kind, locale) DO NOTHING;

INSERT INTO catalog.concept_relations
  (id, concept_scheme_id, subject_concept_id, relation_type, object_concept_id,
   evidence_basis, confidence, valid_from)
SELECT gen_random_uuid(), child.taxonomy_version_id, child.id, 'broader', child.parent_id,
       jsonb_build_object('origin', 'legacy_domain_taxonomy',
                          'taxonomyVersionId', child.taxonomy_version_id),
       1, version.created_at
FROM catalog.domain_nodes child
JOIN catalog.domain_taxonomy_versions version ON version.id = child.taxonomy_version_id
WHERE child.parent_id IS NOT NULL
ON CONFLICT (concept_scheme_id, subject_concept_id, relation_type, object_concept_id, valid_from)
DO NOTHING;

INSERT INTO catalog.concept_schemes
  (id, scheme_key, version, title, status, source_uri)
VALUES
  ('4a746d49-a1b3-5573-8c63-c9bb75956097', 'signals-facets', 1,
   'Signals AI faceted knowledge model', 'active', 'https://www.w3.org/TR/skos-reference/')
ON CONFLICT (scheme_key, version) DO NOTHING;

INSERT INTO catalog.concepts
  (id, concept_scheme_id, facet_key, stable_key, preferred_label, definition, status)
VALUES
  ('9844255b-8896-5f40-8d5a-4255e492fb19', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'entity_class', 'entity-class:implementation', 'Implementation',
   'A concrete software artifact or integration that can be evaluated without granting authority.', 'active'),
  ('5caa6181-066f-501b-95c8-45214068b466', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'entity_class', 'entity-class:service', 'Service',
   'A hosted or operated technology service.', 'active'),
  ('b624cc32-0ad3-5d27-bf52-8e6d5b4059fe', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'entity_class', 'entity-class:model', 'Model',
   'A named computational model or model family.', 'active'),
  ('49c4fba3-0fa7-5111-9dd2-06f657e1c328', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'entity_class', 'entity-class:practice', 'Practice',
   'A method, technique, workflow, or convention.', 'active'),
  ('f47a71dd-6836-530f-a4a7-cfb550a679c9', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'entity_class', 'entity-class:language', 'Language',
   'A programming, query, or specification language.', 'active'),
  ('343d4bf3-bff0-5e89-a2b4-b9c142822176', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'entity_class', 'entity-class:standard', 'Standard or protocol',
   'A versioned standard, protocol, or interoperability contract.', 'active'),
  ('4aa775a2-cbcb-5dd4-b21c-c24230356ade', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'entity_class', 'entity-class:document', 'Document',
   'A publication that explains, evaluates, specifies, or reports knowledge.', 'active'),
  ('04ae0e65-de5f-5812-a2d2-d779132a0b7b', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'document_type', 'document-type:article', 'Article', 'An authored article.', 'active'),
  ('4bb71e8d-594d-5b85-ba94-c035d9eed7c2', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'document_type', 'document-type:research', 'Research', 'A research publication.', 'active'),
  ('dab59ee8-764b-50f8-b55b-f36dde0c60be', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'document_type', 'document-type:resource', 'Resource', 'A durable reference resource.', 'active'),
  ('c4bdbcb1-d413-5b0a-9543-75549eb48d9b', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'document_type', 'document-type:specification', 'Specification',
   'A normative or descriptive specification.', 'active'),
  ('8185e377-8f37-5e26-9ddc-2a54ca306d31', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'document_type', 'document-type:standard', 'Standard document',
   'A published standard or standards artifact.', 'active'),
  ('43118ef0-6115-5fe4-94d2-f38a30e9eb24', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'interface', 'interface:cli', 'Command line', 'A command-line interface.', 'active'),
  ('f139ac64-bdda-522c-b5d4-25e8a8ad67c0', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'interface', 'interface:library', 'Library', 'A programmatic library interface.', 'active'),
  ('eceb72e3-ef6b-5260-88cf-355f9b2990aa', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'interface', 'interface:plugin', 'Plugin', 'A host-extension or plugin interface.', 'active'),
  ('dcdb07c8-5ef1-566a-a186-2ce0c353fbbb', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'interface', 'interface:mcp-server', 'MCP server', 'A Model Context Protocol server interface.', 'active'),
  ('7da48e4f-23f2-52b1-863f-0d663ab09c6e', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'interface', 'interface:protocol', 'Protocol', 'A protocol-facing interface.', 'active'),
  ('8a78e2f4-b6cc-57b9-9e05-4353a2e0b1ed', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'interface', 'interface:language', 'Language', 'A language-facing interface.', 'active'),
  ('4c39e31f-3acf-5e21-851d-118b01599d9e', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'interface', 'interface:api', 'API', 'A programmatic service interface.', 'active')
ON CONFLICT (concept_scheme_id, stable_key) DO NOTHING;

INSERT INTO catalog.concept_labels
  (id, concept_id, label, normalized_label, label_kind, locale)
SELECT gen_random_uuid(), id, preferred_label,
       lower(regexp_replace(normalize(preferred_label, NFKC), '[^[:alnum:]]+', ' ', 'g')),
       'preferred', 'en'
FROM catalog.concepts
WHERE concept_scheme_id = '4a746d49-a1b3-5573-8c63-c9bb75956097'
ON CONFLICT (concept_id, normalized_label, label_kind, locale) DO NOTHING;

-- Capability definitions become capability concepts without replacing the historical contract.
INSERT INTO catalog.concepts
  (id, concept_scheme_id, facet_key, stable_key, preferred_label, definition, status, created_at)
SELECT id, '4a746d49-a1b3-5573-8c63-c9bb75956097', 'capability',
       'capability:' || stable_key, name, description, 'active', created_at
FROM catalog.capability_definitions
ON CONFLICT (concept_scheme_id, stable_key) DO NOTHING;

INSERT INTO catalog.concept_labels
  (id, concept_id, label, normalized_label, label_kind, locale, created_at)
SELECT gen_random_uuid(), id, name,
       lower(regexp_replace(normalize(name, NFKC), '[^[:alnum:]]+', ' ', 'g')),
       'preferred', 'en', created_at
FROM catalog.capability_definitions
ON CONFLICT (concept_id, normalized_label, label_kind, locale) DO NOTHING;

CREATE FUNCTION catalog.entity_class_for_provider_kind(provider_kind text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE
    WHEN provider_kind = 'model' THEN 'b624cc32-0ad3-5d27-bf52-8e6d5b4059fe'::uuid
    WHEN provider_kind IN ('practice', 'workflow')
      THEN '49c4fba3-0fa7-5111-9dd2-06f657e1c328'::uuid
    WHEN provider_kind = 'language' THEN 'f47a71dd-6836-530f-a4a7-cfb550a679c9'::uuid
    WHEN provider_kind IN ('protocol', 'standard')
      THEN '343d4bf3-bff0-5e89-a2b4-b9c142822176'::uuid
    WHEN provider_kind IN ('service', 'platform', 'product', 'gateway', 'registry')
      THEN '5caa6181-066f-501b-95c8-45214068b466'::uuid
    ELSE '9844255b-8896-5f40-8d5a-4255e492fb19'::uuid
  END
$$;

CREATE FUNCTION catalog.sync_provider_knowledge_entity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  previous_revision_id uuid;
  interface_concept_id uuid;
BEGIN
  INSERT INTO catalog.knowledge_entities (id, source_kind, provider_id)
  VALUES (NEW.id, 'provider', NEW.id)
  ON CONFLICT (provider_id) DO NOTHING;

  SELECT id INTO previous_revision_id
  FROM catalog.knowledge_entity_revisions
  WHERE entity_id = NEW.id AND revision < NEW.revision
  ORDER BY revision DESC LIMIT 1;

  INSERT INTO catalog.knowledge_entity_revisions
    (id, entity_id, revision, entity_class_concept_id, preferred_label, summary,
     lifecycle_state, predecessor_id, content_hash)
  VALUES
    (gen_random_uuid(), NEW.id, NEW.revision,
     catalog.entity_class_for_provider_kind(NEW.kind), NEW.canonical_name, NEW.description,
     NEW.lifecycle_state, previous_revision_id,
     encode(digest(convert_to(concat_ws(E'\x1f', NEW.kind, NEW.canonical_name,
                                         NEW.description, NEW.lifecycle_state,
                                         NEW.revision::text), 'UTF8'), 'sha256'), 'hex'))
  ON CONFLICT (entity_id, revision) DO NOTHING;

  interface_concept_id := CASE NEW.kind
    WHEN 'cli' THEN '43118ef0-6115-5fe4-94d2-f38a30e9eb24'::uuid
    WHEN 'library' THEN 'f139ac64-bdda-522c-b5d4-25e8a8ad67c0'::uuid
    WHEN 'plugin' THEN 'eceb72e3-ef6b-5260-88cf-355f9b2990aa'::uuid
    WHEN 'mcp_server' THEN 'dcdb07c8-5ef1-566a-a186-2ce0c353fbbb'::uuid
    WHEN 'protocol' THEN '7da48e4f-23f2-52b1-863f-0d663ab09c6e'::uuid
    WHEN 'language' THEN '8a78e2f4-b6cc-57b9-9e05-4353a2e0b1ed'::uuid
    WHEN 'service' THEN '4c39e31f-3acf-5e21-851d-118b01599d9e'::uuid
    ELSE NULL
  END;
  IF interface_concept_id IS NOT NULL THEN
    INSERT INTO catalog.entity_facet_assignments
      (id, entity_id, concept_id, facet_key, origin, confidence, rationale, valid_from)
    VALUES (gen_random_uuid(), NEW.id, interface_concept_id, 'interface', 'derived', 1,
            'Derived from the historical provider kind.', NEW.created_at)
    ON CONFLICT (entity_id, concept_id, valid_from) DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION catalog.sync_document_knowledge_entity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  document_type_concept_id uuid;
BEGIN
  INSERT INTO catalog.knowledge_entities (id, source_kind, document_id)
  VALUES (NEW.id, 'document', NEW.id)
  ON CONFLICT (document_id) DO NOTHING;

  INSERT INTO catalog.knowledge_entity_revisions
    (id, entity_id, revision, entity_class_concept_id, preferred_label, summary,
     lifecycle_state, source_observation_id, content_hash)
  VALUES (gen_random_uuid(), NEW.id, 1, '4aa775a2-cbcb-5dd4-b21c-c24230356ade',
          NEW.title, NEW.summary, NEW.publication_state, NEW.source_observation_id,
          NEW.content_digest)
  ON CONFLICT (entity_id, revision) DO NOTHING;

  INSERT INTO catalog.knowledge_document_revisions
    (id, document_id, revision, title, summary, canonical_uri, publication_state,
     content_digest, source_observation_id, observed_at, change_kind)
  VALUES (gen_random_uuid(), NEW.id, 1, NEW.title, NEW.summary, NEW.canonical_uri,
          NEW.publication_state, NEW.content_digest, NEW.source_observation_id,
          NEW.observed_at, 'initial')
  ON CONFLICT (document_id, revision) DO NOTHING;

  document_type_concept_id := CASE NEW.document_kind
    WHEN 'article' THEN '04ae0e65-de5f-5812-a2d2-d779132a0b7b'::uuid
    WHEN 'research' THEN '4bb71e8d-594d-5b85-ba94-c035d9eed7c2'::uuid
    WHEN 'resource' THEN 'dab59ee8-764b-50f8-b55b-f36dde0c60be'::uuid
    WHEN 'specification' THEN 'c4bdbcb1-d413-5b0a-9543-75549eb48d9b'::uuid
    WHEN 'standard' THEN '8185e377-8f37-5e26-9ddc-2a54ca306d31'::uuid
  END;
  INSERT INTO catalog.entity_facet_assignments
    (id, entity_id, concept_id, facet_key, origin, confidence, rationale,
     source_observation_id, valid_from)
  VALUES (gen_random_uuid(), NEW.id, document_type_concept_id, 'document_type',
          'source_assertion', 1, 'Copied from the reviewed document kind.',
          NEW.source_observation_id, NEW.observed_at)
  ON CONFLICT (entity_id, concept_id, valid_from) DO NOTHING;
  RETURN NEW;
END
$$;

CREATE FUNCTION catalog.sync_capability_concept()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO catalog.concepts
    (id, concept_scheme_id, facet_key, stable_key, preferred_label, definition, status, created_at)
  VALUES (NEW.id, '4a746d49-a1b3-5573-8c63-c9bb75956097', 'capability',
          'capability:' || NEW.stable_key, NEW.name, NEW.description, 'active', NEW.created_at)
  ON CONFLICT (concept_scheme_id, stable_key) DO NOTHING;
  INSERT INTO catalog.concept_labels
    (id, concept_id, label, normalized_label, label_kind, locale, created_at)
  VALUES (gen_random_uuid(), NEW.id, NEW.name,
          lower(regexp_replace(normalize(NEW.name, NFKC), '[^[:alnum:]]+', ' ', 'g')),
          'preferred', 'en', NEW.created_at)
  ON CONFLICT (concept_id, normalized_label, label_kind, locale) DO NOTHING;
  RETURN NEW;
END
$$;

CREATE FUNCTION catalog.sync_domain_taxonomy_concept_scheme()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO catalog.concept_schemes
    (id, scheme_key, version, title, status, created_at)
  VALUES (NEW.id, NEW.taxonomy_key, NEW.version,
          'Domain taxonomy ' || NEW.taxonomy_key, NEW.status, NEW.created_at)
  ON CONFLICT (scheme_key, version) DO NOTHING;
  RETURN NEW;
END
$$;

CREATE FUNCTION catalog.sync_domain_node_concept()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  scheme_created_at timestamptz;
BEGIN
  SELECT created_at INTO scheme_created_at
  FROM catalog.concept_schemes
  WHERE id = NEW.taxonomy_version_id;

  IF scheme_created_at IS NULL THEN
    RAISE EXCEPTION 'Domain taxonomy % has no faceted concept scheme projection',
      NEW.taxonomy_version_id;
  END IF;

  INSERT INTO catalog.concepts
    (id, concept_scheme_id, facet_key, stable_key, preferred_label, definition,
     status, created_at)
  VALUES (NEW.id, NEW.taxonomy_version_id, 'domain', NEW.stable_key, NEW.label,
          NEW.definition, NEW.status, scheme_created_at)
  ON CONFLICT (concept_scheme_id, stable_key) DO NOTHING;

  INSERT INTO catalog.concept_labels
    (id, concept_id, label, normalized_label, label_kind, locale, created_at)
  VALUES (gen_random_uuid(), NEW.id, NEW.label,
          lower(regexp_replace(normalize(NEW.label, NFKC), '[^[:alnum:]]+', ' ', 'g')),
          'preferred', 'en', scheme_created_at)
  ON CONFLICT (concept_id, normalized_label, label_kind, locale) DO NOTHING;

  IF NEW.parent_id IS NOT NULL THEN
    INSERT INTO catalog.concept_relations
      (id, concept_scheme_id, subject_concept_id, relation_type, object_concept_id,
       evidence_basis, confidence, valid_from)
    VALUES (gen_random_uuid(), NEW.taxonomy_version_id, NEW.id, 'broader', NEW.parent_id,
            jsonb_build_object('origin', 'legacy_domain_taxonomy',
                               'taxonomyVersionId', NEW.taxonomy_version_id),
            1, scheme_created_at)
    ON CONFLICT
      (concept_scheme_id, subject_concept_id, relation_type, object_concept_id, valid_from)
    DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION catalog.sync_domain_facet_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO catalog.entity_facet_assignments
    (id, entity_id, concept_id, facet_key, origin, confidence, rationale,
     source_observation_id, valid_from)
  VALUES (NEW.id, NEW.provider_id, NEW.domain_node_id, 'domain',
          CASE WHEN NEW.origin = 'manual' THEN 'manual' ELSE 'legacy_migration' END,
          NEW.confidence, NEW.rationale, NEW.source_observation_id, now())
  ON CONFLICT (entity_id, concept_id, valid_from) DO NOTHING;
  RETURN NEW;
END
$$;

CREATE FUNCTION catalog.sync_capability_facet_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO catalog.entity_facet_assignments
    (id, entity_id, concept_id, facet_key, origin, confidence, rationale,
     valid_from)
  VALUES (NEW.id, NEW.provider_id, NEW.capability_definition_id, 'capability',
          'source_assertion',
          CASE WHEN NEW.assertion_state = 'verified_for_scope' THEN 0.95 ELSE 0.75 END,
          'Copied from the historical provider capability assertion.', now())
  ON CONFLICT (entity_id, concept_id, valid_from) DO NOTHING;
  RETURN NEW;
END
$$;

CREATE FUNCTION catalog.sync_provider_relationship()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO catalog.knowledge_relationships
    (id, subject_entity_id, relation_type, object_entity_id, direction,
     source_observation_id, evidence_basis, confidence, revision_scope,
     valid_from, valid_to, state, legacy_source_table, legacy_source_key)
  VALUES (gen_random_uuid(), NEW.subject_provider_id, NEW.relation_type,
          NEW.object_provider_id, 'directed', NEW.source_observation_id,
          jsonb_build_object('origin', 'provider_relations',
                             'applicabilityScope', NEW.applicability_scope),
          NEW.confidence, jsonb_build_object('applicabilityScope', NEW.applicability_scope),
          NEW.valid_from, NEW.valid_to, 'reviewed', 'provider_relations', NEW.id::text)
  ON CONFLICT (legacy_source_table, legacy_source_key) DO NOTHING;
  RETURN NEW;
END
$$;

CREATE FUNCTION catalog.sync_document_subject_relationship()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO catalog.knowledge_relationships
    (id, subject_entity_id, relation_type, object_entity_id, object_concept_id,
     direction, source_observation_id, evidence_basis, confidence, revision_scope,
     valid_from, state, legacy_source_table, legacy_source_key)
  VALUES (gen_random_uuid(), NEW.document_id, NEW.relation_type,
          NEW.provider_id, NEW.capability_definition_id, 'directed',
          NEW.source_observation_id,
          jsonb_build_object('origin', 'knowledge_document_subjects',
                             'rationale', NEW.rationale),
          1, jsonb_build_object('documentRevision', 1), NEW.created_at, 'reviewed',
          'knowledge_document_subjects',
          concat_ws(':', NEW.document_id, NEW.provider_id, NEW.capability_definition_id,
                    NEW.relation_type))
  ON CONFLICT (legacy_source_table, legacy_source_key) DO NOTHING;
  RETURN NEW;
END
$$;

-- Backfill stable entities before their facet and relationship projections.
INSERT INTO catalog.knowledge_entities (id, source_kind, provider_id)
SELECT id, 'provider', id FROM catalog.providers
ON CONFLICT (provider_id) DO NOTHING;

INSERT INTO catalog.knowledge_entity_revisions
  (id, entity_id, revision, entity_class_concept_id, preferred_label, summary,
   lifecycle_state, content_hash, created_at)
SELECT gen_random_uuid(), id, revision, catalog.entity_class_for_provider_kind(kind),
       canonical_name, description, lifecycle_state,
       encode(digest(convert_to(concat_ws(E'\x1f', kind, canonical_name, description,
                                           lifecycle_state, revision::text), 'UTF8'),
                     'sha256'), 'hex'),
       updated_at
FROM catalog.providers
ON CONFLICT (entity_id, revision) DO NOTHING;

INSERT INTO catalog.knowledge_entities (id, source_kind, document_id)
SELECT id, 'document', id FROM catalog.knowledge_documents
ON CONFLICT (document_id) DO NOTHING;

INSERT INTO catalog.knowledge_entity_revisions
  (id, entity_id, revision, entity_class_concept_id, preferred_label, summary,
   lifecycle_state, source_observation_id, content_hash, created_at)
SELECT gen_random_uuid(), id, 1, '4aa775a2-cbcb-5dd4-b21c-c24230356ade',
       title, summary, publication_state, source_observation_id, content_digest, created_at
FROM catalog.knowledge_documents
ON CONFLICT (entity_id, revision) DO NOTHING;

INSERT INTO catalog.knowledge_document_revisions
  (id, document_id, revision, title, summary, canonical_uri, publication_state,
   content_digest, source_observation_id, observed_at, change_kind, created_at)
SELECT gen_random_uuid(), id, 1, title, summary, canonical_uri, publication_state,
       content_digest, source_observation_id, observed_at, 'initial', created_at
FROM catalog.knowledge_documents
ON CONFLICT (document_id, revision) DO NOTHING;

INSERT INTO catalog.entity_facet_assignments
  (id, entity_id, concept_id, facet_key, origin, confidence, rationale,
   source_observation_id, valid_from)
SELECT dm.id, dm.provider_id, dm.domain_node_id, 'domain', 'legacy_migration', dm.confidence,
       dm.rationale, dm.source_observation_id, p.created_at
FROM catalog.domain_memberships dm
JOIN catalog.providers p ON p.id = dm.provider_id
ON CONFLICT (entity_id, concept_id, valid_from) DO NOTHING;

INSERT INTO catalog.entity_facet_assignments
  (id, entity_id, concept_id, facet_key, origin, confidence, rationale, valid_from)
SELECT pc.id, pc.provider_id, pc.capability_definition_id, 'capability', 'legacy_migration',
       CASE WHEN pc.assertion_state = 'verified_for_scope' THEN 0.95 ELSE 0.75 END,
       'Copied from the historical provider capability assertion.', p.created_at
FROM catalog.provider_capabilities pc
JOIN catalog.providers p ON p.id = pc.provider_id
ON CONFLICT (entity_id, concept_id, valid_from) DO NOTHING;

INSERT INTO catalog.entity_facet_assignments
  (id, entity_id, concept_id, facet_key, origin, confidence, rationale, valid_from)
SELECT gen_random_uuid(), p.id,
       CASE p.kind
         WHEN 'cli' THEN '43118ef0-6115-5fe4-94d2-f38a30e9eb24'::uuid
         WHEN 'library' THEN 'f139ac64-bdda-522c-b5d4-25e8a8ad67c0'::uuid
         WHEN 'plugin' THEN 'eceb72e3-ef6b-5260-88cf-355f9b2990aa'::uuid
         WHEN 'mcp_server' THEN 'dcdb07c8-5ef1-566a-a186-2ce0c353fbbb'::uuid
         WHEN 'protocol' THEN '7da48e4f-23f2-52b1-863f-0d663ab09c6e'::uuid
         WHEN 'language' THEN '8a78e2f4-b6cc-57b9-9e05-4353a2e0b1ed'::uuid
         WHEN 'service' THEN '4c39e31f-3acf-5e21-851d-118b01599d9e'::uuid
       END,
       'interface', 'derived', 1, 'Derived from the historical provider kind.', p.created_at
FROM catalog.providers p
WHERE p.kind IN ('cli', 'library', 'plugin', 'mcp_server', 'protocol', 'language', 'service')
ON CONFLICT (entity_id, concept_id, valid_from) DO NOTHING;

INSERT INTO catalog.entity_facet_assignments
  (id, entity_id, concept_id, facet_key, origin, confidence, rationale,
   source_observation_id, valid_from)
SELECT gen_random_uuid(), id,
       CASE document_kind
         WHEN 'article' THEN '04ae0e65-de5f-5812-a2d2-d779132a0b7b'::uuid
         WHEN 'research' THEN '4bb71e8d-594d-5b85-ba94-c035d9eed7c2'::uuid
         WHEN 'resource' THEN 'dab59ee8-764b-50f8-b55b-f36dde0c60be'::uuid
         WHEN 'specification' THEN 'c4bdbcb1-d413-5b0a-9543-75549eb48d9b'::uuid
         WHEN 'standard' THEN '8185e377-8f37-5e26-9ddc-2a54ca306d31'::uuid
       END,
       'document_type', 'legacy_migration', 1,
       'Copied from the historical document kind.', source_observation_id, observed_at
FROM catalog.knowledge_documents
ON CONFLICT (entity_id, concept_id, valid_from) DO NOTHING;

INSERT INTO catalog.knowledge_relationships
  (id, subject_entity_id, relation_type, object_entity_id, direction,
   source_observation_id, evidence_basis, confidence, revision_scope,
   valid_from, valid_to, state, legacy_source_table, legacy_source_key, created_at)
SELECT gen_random_uuid(), subject_provider_id, relation_type, object_provider_id, 'directed',
       source_observation_id,
       jsonb_build_object('origin', 'provider_relations',
                          'applicabilityScope', applicability_scope),
       confidence, jsonb_build_object('applicabilityScope', applicability_scope),
       valid_from, valid_to, 'reviewed', 'provider_relations', id::text, created_at
FROM catalog.provider_relations
ON CONFLICT (legacy_source_table, legacy_source_key) DO NOTHING;

INSERT INTO catalog.knowledge_relationships
  (id, subject_entity_id, relation_type, object_entity_id, object_concept_id,
   direction, source_observation_id, evidence_basis, confidence, revision_scope,
   valid_from, state, legacy_source_table, legacy_source_key, created_at)
SELECT gen_random_uuid(), document_id, relation_type, provider_id, capability_definition_id,
       'directed', source_observation_id,
       jsonb_build_object('origin', 'knowledge_document_subjects', 'rationale', rationale),
       1, jsonb_build_object('documentRevision', 1), created_at, 'reviewed',
       'knowledge_document_subjects',
       concat_ws(':', document_id, provider_id, capability_definition_id, relation_type), created_at
FROM catalog.knowledge_document_subjects
ON CONFLICT (legacy_source_table, legacy_source_key) DO NOTHING;

CREATE TRIGGER providers_knowledge_entity_sync
  AFTER INSERT OR UPDATE OF kind, canonical_name, description, lifecycle_state, revision
  ON catalog.providers
  FOR EACH ROW EXECUTE FUNCTION catalog.sync_provider_knowledge_entity();
CREATE TRIGGER knowledge_documents_entity_sync
  AFTER INSERT ON catalog.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION catalog.sync_document_knowledge_entity();
CREATE TRIGGER capability_definitions_concept_sync
  AFTER INSERT ON catalog.capability_definitions
  FOR EACH ROW EXECUTE FUNCTION catalog.sync_capability_concept();
CREATE TRIGGER domain_taxonomy_versions_concept_sync
  AFTER INSERT ON catalog.domain_taxonomy_versions
  FOR EACH ROW EXECUTE FUNCTION catalog.sync_domain_taxonomy_concept_scheme();
CREATE TRIGGER domain_nodes_concept_sync
  AFTER INSERT ON catalog.domain_nodes
  FOR EACH ROW EXECUTE FUNCTION catalog.sync_domain_node_concept();
CREATE TRIGGER domain_memberships_facet_sync
  AFTER INSERT ON catalog.domain_memberships
  FOR EACH ROW EXECUTE FUNCTION catalog.sync_domain_facet_assignment();
CREATE TRIGGER provider_capabilities_facet_sync
  AFTER INSERT ON catalog.provider_capabilities
  FOR EACH ROW EXECUTE FUNCTION catalog.sync_capability_facet_assignment();
CREATE TRIGGER provider_relations_knowledge_sync
  AFTER INSERT ON catalog.provider_relations
  FOR EACH ROW EXECUTE FUNCTION catalog.sync_provider_relationship();
CREATE TRIGGER document_subjects_knowledge_sync
  AFTER INSERT ON catalog.knowledge_document_subjects
  FOR EACH ROW EXECUTE FUNCTION catalog.sync_document_subject_relationship();

CREATE TRIGGER facet_definitions_immutable
  BEFORE UPDATE OR DELETE ON catalog.facet_definitions
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
CREATE TRIGGER concept_schemes_immutable
  BEFORE UPDATE OR DELETE ON catalog.concept_schemes
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
CREATE TRIGGER concepts_immutable
  BEFORE UPDATE OR DELETE ON catalog.concepts
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
CREATE TRIGGER concept_labels_immutable
  BEFORE UPDATE OR DELETE ON catalog.concept_labels
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
CREATE TRIGGER concept_relations_immutable
  BEFORE UPDATE OR DELETE ON catalog.concept_relations
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
CREATE TRIGGER knowledge_entities_immutable
  BEFORE UPDATE OR DELETE ON catalog.knowledge_entities
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
CREATE TRIGGER knowledge_entity_revisions_immutable
  BEFORE UPDATE OR DELETE ON catalog.knowledge_entity_revisions
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
CREATE TRIGGER entity_facet_assignments_immutable
  BEFORE UPDATE OR DELETE ON catalog.entity_facet_assignments
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
CREATE TRIGGER knowledge_relationships_immutable
  BEFORE UPDATE OR DELETE ON catalog.knowledge_relationships
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
CREATE TRIGGER knowledge_document_revisions_immutable
  BEFORE UPDATE OR DELETE ON catalog.knowledge_document_revisions
  FOR EACH ROW EXECUTE FUNCTION ops.reject_immutable_change();
