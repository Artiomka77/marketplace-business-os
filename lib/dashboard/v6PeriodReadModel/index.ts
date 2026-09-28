export * from "./contract";
export * from "./d1d5Eligibility";
export * from "./v2SafetyAttestation";
export * from "./fingerprint";
export * from "./jobIdentity";
export * from "./finality";
export * from "./repository";
export * from "./consumer";
export {
  produceV6DashboardPeriodReadModel,
  persistPrecomputedV6DashboardBundle,
  buildV6DashboardPeriodCompanyRows,
  buildV6DashboardDailyPoints,
} from "./producer";
export {
  asPrismaLikeV6Client,
  createV6ReadModelTargetPrismaClient,
  disconnectV6ReadModelTargetPrismaClient,
} from "./targetClient";

import {
  createMemoryV6PeriodReadModelRepository,
  createPrismaV6PeriodReadModelRepository,
  type V6PeriodReadModelRepository,
} from "./repository";
import {
  asPrismaLikeV6Client,
  createV6ReadModelTargetPrismaClient,
} from "./targetClient";

let defaultRepository: V6PeriodReadModelRepository | null = null;
let defaultRepositoryKind: "prisma" | "memory" | null = null;

/**
 * Memory repository is TEST / explicit fixture only.
 * Ordinary server runtime MUST use Prisma persistence.
 */
export function setDefaultV6PeriodReadModelRepository(
  repository: V6PeriodReadModelRepository,
  kind: "prisma" | "memory" = "memory"
) {
  defaultRepository = repository;
  defaultRepositoryKind = kind;
}

function resolveDefaultRepository(): V6PeriodReadModelRepository {
  if (defaultRepository) return defaultRepository;

  // Explicit test/fixture override only.
  if (process.env.V6_READMODEL_FORCE_MEMORY === "1") {
    defaultRepository = createMemoryV6PeriodReadModelRepository();
    defaultRepositoryKind = "memory";
    return defaultRepository;
  }

  const client = createV6ReadModelTargetPrismaClient();
  defaultRepository = createPrismaV6PeriodReadModelRepository(
    asPrismaLikeV6Client(client)
  );
  defaultRepositoryKind = "prisma";
  return defaultRepository;
}

export function getDefaultV6PeriodReadModelRepository() {
  return resolveDefaultRepository();
}

export function getDefaultV6PeriodReadModelRepositoryKind() {
  resolveDefaultRepository();
  return defaultRepositoryKind;
}
