// Computes the minimal set of GSI operations (create/update/delete)
// required to transition the current table state to the desired configuration.

import type {
  GSIConfiguration,
  GSIInfo,
  GSIOperation,
  ProjectionType,
} from "../../../lib/types/index.js";

// Memoises the key schema so repeated lookups are cheap.
const toKeySchemaMap = (info: GSIInfo) => {
  const map = new Map<string, "HASH" | "RANGE">();
  info.keySchema.forEach((entry) => map.set(entry.attributeName, entry.keyType));
  return map;
};

// Helper to compare projection attribute lists regardless of order.
const arraysEqualIgnoreOrder = (a: string[] = [], b: string[] = []) => {
  if (a.length !== b.length) {
    return false;
  }

  const setA = new Set(a);
  return b.every((value) => setA.has(value));
};

const projectionChanged = (
  current: GSIInfo,
  desired: GSIConfiguration
): boolean => {
  const currentProjection = current.projection.projectionType;
  const desiredProjection: ProjectionType = desired.projectionType ?? "ALL";
  if (currentProjection !== desiredProjection) {
    return true;
  }

  if (desiredProjection === "INCLUDE") {
    return !arraysEqualIgnoreOrder(
      current.projection.nonKeyAttributes ?? [],
      desired.nonKeyAttributes ?? []
    );
  }

  return false;
};

const keySchemaChanged = (
  current: GSIInfo,
  desired: GSIConfiguration
): boolean => {
  const schema = toKeySchemaMap(current);
  const desiredPartition = desired.partitionKey.name;
  const desiredSort = desired.sortKey?.name;

  if (schema.get(desiredPartition) !== "HASH") {
    return true;
  }

  const currentSortEntry = [...schema.entries()].find(
    (entry) => entry[1] === "RANGE"
  );

  if (!desiredSort && currentSortEntry) {
    return true;
  }

  if (desiredSort && (!currentSortEntry || currentSortEntry[0] !== desiredSort)) {
    return true;
  }

  return false;
};

const shouldUpdateThroughput = (
  current: GSIInfo,
  desired: GSIConfiguration
): boolean => {
  // PAY_PER_REQUEST indexes omit throughput; nothing to update in that case.
  if (!desired.provisionedThroughput) {
    return false;
  }

  const currentThroughput = current.provisionedThroughput;
  if (!currentThroughput) {
    return true;
  }

  return (
    currentThroughput.readCapacityUnits !==
      desired.provisionedThroughput.readCapacityUnits ||
    currentThroughput.writeCapacityUnits !==
      desired.provisionedThroughput.writeCapacityUnits
  );
};

export const planGsiOperations = (
  current: GSIInfo[],
  desired: GSIConfiguration[]
): GSIOperation[] => {
  // We first figure out which existing indexes must be removed.
  const operations: GSIOperation[] = [];
  const currentMap = new Map(current.map((gsi) => [gsi.indexName, gsi]));
  const desiredNames = new Set(desired.map((gsi) => gsi.indexName));

  current.forEach((gsi) => {
    if (!desiredNames.has(gsi.indexName)) {
      operations.push({
        type: "DELETE",
        indexName: gsi.indexName,
        currentConfiguration: gsi,
      });
    }
  });

  desired.forEach((config) => {
    const existing = currentMap.get(config.indexName);
    if (!existing) {
      operations.push({
        type: "CREATE",
        indexName: config.indexName,
        desiredConfiguration: config,
      });
      return;
    }

    if (keySchemaChanged(existing, config) || projectionChanged(existing, config)) {
      operations.push({
        type: "DELETE",
        indexName: existing.indexName,
        currentConfiguration: existing,
      });
      operations.push({
        type: "CREATE",
        indexName: config.indexName,
        desiredConfiguration: config,
      });
      return;
    }

    if (shouldUpdateThroughput(existing, config)) {
      operations.push({
        // Throughput updates can be applied in place, so we emit a single UPDATE step.
        type: "UPDATE",
        indexName: config.indexName,
        desiredConfiguration: config,
        currentConfiguration: existing,
      });
    }
  });

  return operations;
};
