-- Phase 08 generic query interpretation and bounded two-pass research planning.

-- Alternate labels describe general entity/document/interface vocabulary. They are
-- taxonomy data, not query-specific ranking rules.
WITH labels(concept_id, label, label_kind) AS (
  VALUES
    ('9844255b-8896-5f40-8d5a-4255e492fb19'::uuid, 'Technology', 'alternate'),
    ('9844255b-8896-5f40-8d5a-4255e492fb19'::uuid, 'Tool', 'alternate'),
    ('9844255b-8896-5f40-8d5a-4255e492fb19'::uuid, 'Software', 'alternate'),
    ('9844255b-8896-5f40-8d5a-4255e492fb19'::uuid, 'Library', 'alternate'),
    ('9844255b-8896-5f40-8d5a-4255e492fb19'::uuid, 'Framework', 'alternate'),
    ('5caa6181-066f-501b-95c8-45214068b466'::uuid, 'Provider', 'alternate'),
    ('5caa6181-066f-501b-95c8-45214068b466'::uuid, 'Vendor', 'alternate'),
    ('5caa6181-066f-501b-95c8-45214068b466'::uuid, 'Hosted service', 'alternate'),
    ('b624cc32-0ad3-5d27-bf52-8e6d5b4059fe'::uuid, 'Model family', 'alternate'),
    ('49c4fba3-0fa7-5111-9dd2-06f657e1c328'::uuid, 'Technique', 'alternate'),
    ('49c4fba3-0fa7-5111-9dd2-06f657e1c328'::uuid, 'Method', 'alternate'),
    ('49c4fba3-0fa7-5111-9dd2-06f657e1c328'::uuid, 'Workflow', 'alternate'),
    ('f47a71dd-6836-530f-a4a7-cfb550a679c9'::uuid, 'Programming language', 'alternate'),
    ('343d4bf3-bff0-5e89-a2b4-b9c142822176'::uuid, 'Protocol', 'alternate'),
    ('343d4bf3-bff0-5e89-a2b4-b9c142822176'::uuid, 'Specification', 'alternate'),
    ('343d4bf3-bff0-5e89-a2b4-b9c142822176'::uuid, 'RFC', 'alternate'),
    ('4aa775a2-cbcb-5dd4-b21c-c24230356ade'::uuid, 'Paper', 'alternate'),
    ('4aa775a2-cbcb-5dd4-b21c-c24230356ade'::uuid, 'Documentation', 'alternate'),
    ('4aa775a2-cbcb-5dd4-b21c-c24230356ade'::uuid, 'News', 'alternate'),
    ('4aa775a2-cbcb-5dd4-b21c-c24230356ade'::uuid, 'Tutorial', 'alternate'),
    ('43118ef0-6115-5fe4-94d2-f38a30e9eb24'::uuid, 'CLI', 'alternate'),
    ('f139ac64-bdda-522c-b5d4-25e8a8ad67c0'::uuid, 'SDK', 'alternate'),
    ('eceb72e3-ef6b-5260-88cf-355f9b2990aa'::uuid, 'Extension', 'alternate'),
    ('dcdb07c8-5ef1-566a-a186-2ce0c353fbbb'::uuid, 'Model Context Protocol server', 'alternate'),
    ('7da48e4f-23f2-52b1-863f-0d663ab09c6e'::uuid, 'Protocol endpoint', 'alternate'),
    ('4c39e31f-3acf-5e21-851d-118b01599d9e'::uuid, 'Application programming interface', 'alternate')
)
INSERT INTO catalog.concept_labels
  (id, concept_id, label, normalized_label, label_kind, locale)
SELECT gen_random_uuid(), concept_id, label,
       lower(regexp_replace(normalize(label, NFKC), '[^[:alnum:]]+', ' ', 'g')),
       label_kind, 'en'
FROM labels
ON CONFLICT (concept_id, normalized_label, label_kind, locale) DO NOTHING;

INSERT INTO catalog.concepts
  (id, concept_scheme_id, facet_key, stable_key, preferred_label, definition, status)
VALUES
  ('e552476d-cb38-56f8-b150-8d06c6297c7a', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'service_model', 'service-model:saas', 'SaaS', 'Operated as multi-tenant software as a service.', 'active'),
  ('6cb05366-615c-5411-8c79-43f830c5a79f', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'service_model', 'service-model:managed', 'Managed', 'Operated for the user by a service provider.', 'active'),
  ('473d4020-944e-5ab9-a067-a5b88a6634c6', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'service_model', 'service-model:self-hosted', 'Self-hosted', 'Operated by the adopting organization.', 'active'),
  ('bf0e00d9-ad8e-59ca-8273-b464b89c5242', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'service_model', 'service-model:local', 'Local', 'Operated on a user-controlled local host.', 'active'),
  ('3ed0f24d-f17a-5ece-96bc-4c93dec9363c', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'service_model', 'service-model:hosted-api', 'Hosted API', 'Operated remotely behind an API.', 'active'),
  ('4f9e508b-9cf2-5923-803a-879d4071d672', '4a746d49-a1b3-5573-8c63-c9bb75956097',
   'service_model', 'service-model:hybrid', 'Hybrid', 'Combines local or self-hosted and managed components.', 'active')
ON CONFLICT (concept_scheme_id, stable_key) DO NOTHING;

INSERT INTO catalog.concept_labels
  (id, concept_id, label, normalized_label, label_kind, locale)
SELECT gen_random_uuid(), id, preferred_label,
       lower(regexp_replace(normalize(preferred_label, NFKC), '[^[:alnum:]]+', ' ', 'g')),
       'preferred', 'en'
FROM catalog.concepts
WHERE facet_key = 'service_model'
ON CONFLICT (concept_id, normalized_label, label_kind, locale) DO NOTHING;

ALTER TABLE workspace.query_plans
  ADD COLUMN budgets jsonb,
  ADD COLUMN stop_policy jsonb,
  ADD COLUMN stop_reason text,
  ADD COLUMN coverage_assessment jsonb,
  ADD COLUMN planned_passes integer;

ALTER TABLE workspace.query_plans
  ADD CONSTRAINT query_plans_budgets_object_check
    CHECK (budgets IS NULL OR jsonb_typeof(budgets) = 'object'),
  ADD CONSTRAINT query_plans_stop_policy_object_check
    CHECK (stop_policy IS NULL OR jsonb_typeof(stop_policy) = 'object'),
  ADD CONSTRAINT query_plans_coverage_assessment_object_check
    CHECK (coverage_assessment IS NULL OR jsonb_typeof(coverage_assessment) = 'object'),
  ADD CONSTRAINT query_plans_planned_passes_check
    CHECK (planned_passes IS NULL OR planned_passes BETWEEN 1 AND 2);

CREATE INDEX query_plans_stop_reason_idx
  ON workspace.query_plans (stop_reason, created_at DESC)
  WHERE stop_reason IS NOT NULL;
