#!/usr/bin/env bash
set -euo pipefail

npm run db:init
npm run db:seed
npm run db:schema-check
npm run format:check
npm run lint
npm run typecheck
npm run context:verify
npm run quality:structure
npm test
npm run test:integration
npm run build
npm run test:provenance
npm run security:dependencies
npm run security:secrets
npm run security:audit:test
npm run security:audit
npm run test:e2e
