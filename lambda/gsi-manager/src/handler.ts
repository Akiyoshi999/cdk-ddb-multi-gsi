// CloudFormation custom resource handler that orchestrates DynamoDB GSI changes.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GSIConfiguration,
  GSIManagerProps,
  GSIOperation,
  GSIOperationResult,
  validateGsiConfigurations,
  mergeErrorHandlingConfig,
  ErrorHandlingConfig,
  OnEventResponse,
} from "../../../lib/types/index.js";
import { DynamoDBGSIServiceImpl } from "./dynamodb-gsi-service.js";
import { planGsiOperations } from "./operation-planner.js";

type CloudFormationRequestType = "Create" | "Update" | "Delete";

interface CloudFormationCustomResourceEventCommon {
  RequestType: CloudFormationRequestType;
  ServiceToken: string;
  ResponseURL: string;
  StackId: string;
  RequestId: string;
  LogicalResourceId: string;
  PhysicalResourceId?: string;
  ResourceType?: string;
  ResourceProperties: Record<string, unknown>;
  OldResourceProperties?: Record<string, unknown>;
}

export interface CloudFormationCustomResourceCreateEvent
  extends CloudFormationCustomResourceEventCommon {
  RequestType: "Create";
}

export interface CloudFormationCustomResourceUpdateEvent
  extends CloudFormationCustomResourceEventCommon {
  RequestType: "Update";
  PhysicalResourceId: string;
}

export interface CloudFormationCustomResourceDeleteEvent
  extends CloudFormationCustomResourceEventCommon {
  RequestType: "Delete";
  PhysicalResourceId: string;
}

type CloudFormationCustomResourceEvent =
  | CloudFormationCustomResourceCreateEvent
  | CloudFormationCustomResourceUpdateEvent
  | CloudFormationCustomResourceDeleteEvent;

interface HandlerResponse {
  PhysicalResourceId: string;
  Data?: Record<string, unknown>;
}

const client = new DynamoDBClient({});

const toArrayOfStrings = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value
    .map((entry) => (typeof entry === "string" ? entry : undefined))
    .filter((entry): entry is string => Boolean(entry));

  return values.length > 0 ? values : undefined;
};

const parseAttribute = (
  value: unknown,
  fallbackType: "S" | "N" | "B" = "S"
) => {
  if (!value || typeof value !== "object") {
    return { name: "", type: fallbackType };
  }

  const record = value as { name?: unknown; type?: unknown };
  return {
    name: typeof record.name === "string" ? record.name : "",
    type:
      record.type === "S" || record.type === "N" || record.type === "B"
        ? record.type
        : fallbackType,
  };
};

const parseProvisionedThroughput = (value: unknown) => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    readCapacityUnits?: unknown;
    writeCapacityUnits?: unknown;
  };

  const readCapacityUnits =
    typeof record.readCapacityUnits === "number"
      ? record.readCapacityUnits
      : record.readCapacityUnits
        ? Number(record.readCapacityUnits)
        : undefined;

  const writeCapacityUnits =
    typeof record.writeCapacityUnits === "number"
      ? record.writeCapacityUnits
      : record.writeCapacityUnits
        ? Number(record.writeCapacityUnits)
        : undefined;

  if (readCapacityUnits === undefined || writeCapacityUnits === undefined) {
    return undefined;
  }

  return {
    readCapacityUnits,
    writeCapacityUnits,
  };
};

const parseGsiConfigs = (value: unknown): GSIConfiguration[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const record =
      entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};

    const projectionType =
      record.projectionType === "ALL" ||
      record.projectionType === "KEYS_ONLY" ||
      record.projectionType === "INCLUDE"
        ? record.projectionType
        : undefined;

    return {
      indexName: typeof record.indexName === "string" ? record.indexName : "",
      partitionKey: parseAttribute(record.partitionKey, "S"),
      sortKey: record.sortKey ? parseAttribute(record.sortKey, "S") : undefined,
      projectionType,
      nonKeyAttributes: toArrayOfStrings(record.nonKeyAttributes),
      provisionedThroughput: parseProvisionedThroughput(
        record.provisionedThroughput
      ),
    };
  });
};

const parseProperties = (
  props: Record<string, unknown>
): GSIManagerProps => {
  // CloudFormation sometimes re-cases property names, so we check both variants.
  const tableNameSource =
    typeof props.tableName === "string"
      ? props.tableName
      : props.TableName;

  return {
    tableName: typeof tableNameSource === "string" ? tableNameSource : "",
    globalSecondaryIndexes: parseGsiConfigs(
      props.globalSecondaryIndexes ?? props.GlobalSecondaryIndexes
    ),
    errorHandling:
      props.errorHandling && typeof props.errorHandling === "object"
        ? (props.errorHandling as Partial<ErrorHandlingConfig>)
        : undefined,
  };
};

const ensurePhysicalId = (
  event: CloudFormationCustomResourceEvent
): string =>
  event.PhysicalResourceId && event.PhysicalResourceId.length > 0
    ? event.PhysicalResourceId
    : `GSIManager-${event.ResourceProperties["tableName"] ?? "UnknownTable"}`;

const executeOperations = async (
  tableName: string,
  operations: GSIOperation[],
  service: DynamoDBGSIServiceImpl
): Promise<GSIOperationResult[]> => {
  const total = operations.length;
  const startTime = Date.now();
  if (total === 0) {
    console.log(
      `[GSI Manager] No GSI operations to execute (table=${tableName}).`
    );
    return [];
  }

  console.log(
    `[GSI Manager] Starting ${total} GSI operation(s) (table=${tableName}).`
  );

  // CloudFormation may re-invoke the handler quickly; ensure the table is stable first.
  await service.waitForTableActive(tableName);
  const results: GSIOperationResult[] = [];

  for (const [index, operation] of operations.entries()) {
    const displayIndex = index + 1;
    const before = Date.now();
    console.log(
      `[GSI Manager][start ${displayIndex}/${total}] ${operation.type} ${operation.indexName}`
    );

    if (operation.type === "DELETE") {
      await service.deleteGSI(tableName, operation.indexName);
      await service.waitForTableActive(tableName);
      await service.waitForGSIStatus(tableName, operation.indexName, "DELETED");
      results.push({
        success: true,
        operation: operation.type,
        indexName: operation.indexName,
      });
      continue;
    }

    if (operation.type === "CREATE" && operation.desiredConfiguration) {
      const pk = operation.desiredConfiguration.partitionKey.name;
      const sk = operation.desiredConfiguration.sortKey?.name;
      console.log(
        `[GSI Manager] Creating GSI ${operation.indexName} (PK=${pk}${
          sk ? `, SK=${sk}` : ""
        }).`
      );
      await service.createGSI(tableName, operation.desiredConfiguration);
      await service.waitForTableActive(tableName);
      await service.waitForGSIStatus(tableName, operation.indexName, "ACTIVE");
      results.push({
        success: true,
        operation: operation.type,
        indexName: operation.indexName,
      });
      continue;
    }

    if (operation.type === "UPDATE" && operation.desiredConfiguration) {
      console.log(
        `[GSI Manager] Updating configuration for GSI ${operation.indexName}.`
      );
      await service.updateGSI(tableName, operation.desiredConfiguration);
      await service.waitForTableActive(tableName);
      await service.waitForGSIStatus(tableName, operation.indexName, "ACTIVE");
      results.push({
        success: true,
        operation: operation.type,
        indexName: operation.indexName,
      });
    }

    const elapsedForOp = Date.now() - before;
    const completed = results.length;
    const progressPercent = ((completed / total) * 100).toFixed(1);
    console.log(
      `[GSI Manager][done ${displayIndex}/${total}] ${operation.type} ${operation.indexName} (progress ${progressPercent}%, elapsed ${
        Math.round(elapsedForOp / 100) / 10
      }s)`
    );
  }

  const totalElapsed = Date.now() - startTime;
  console.log(
    `[GSI Manager] Completed all GSI operations (table=${tableName}, total ${
      Math.round(totalElapsed / 100) / 10
    }s).`
  );

  return results;
};

const handleCreateOrUpdate = async (
  event: CloudFormationCustomResourceCreateEvent | CloudFormationCustomResourceUpdateEvent
): Promise<HandlerResponse> => {
  const props = parseProperties(event.ResourceProperties);
  const errors = validateGsiConfigurations(props.globalSecondaryIndexes);
  if (errors.length > 0) {
    throw new Error(["Invalid GSI configuration detected:", ...errors].join("\n- "));
  }

  const errorHandling = mergeErrorHandlingConfig(props.errorHandling);
  const service = new DynamoDBGSIServiceImpl({
    client,
    errorHandling,
  });

  const managedNames = new Set(
    props.globalSecondaryIndexes.map((gsi) => gsi.indexName)
  );
  const current = await service.getCurrentGSIs(props.tableName);
  const operations = planGsiOperations(
    current.filter((gsi) => managedNames.has(gsi.indexName)),
    props.globalSecondaryIndexes
  );
  if (operations.length === 0) {
    return {
      PhysicalResourceId: ensurePhysicalId(event),
      Data: {
        operationsExecuted: 0,
        managedIndexes: props.globalSecondaryIndexes
          .map((gsi) => gsi.indexName)
          .join(","),
      },
    };
  }

  const results = await executeOperations(props.tableName, operations, service);
  return {
    PhysicalResourceId: ensurePhysicalId(event),
    Data: {
      operationsExecuted: results.length,
      managedIndexes: props.globalSecondaryIndexes
        .map((gsi) => gsi.indexName)
        .join(","),
    },
  };
};

const handleDelete = async (
  event: CloudFormationCustomResourceDeleteEvent
): Promise<HandlerResponse> => {
  const props = parseProperties(event.ResourceProperties);
  const managedIndexes = new Set(
    props.globalSecondaryIndexes.map((gsi) => gsi.indexName)
  );

  const service = new DynamoDBGSIServiceImpl({
    client,
    errorHandling: mergeErrorHandlingConfig(props.errorHandling),
  });

  const current = await service.getCurrentGSIs(props.tableName);
  const targets = current.filter((gsi) => managedIndexes.has(gsi.indexName));

  if (targets.length === 0) {
    return {
      PhysicalResourceId: ensurePhysicalId(event),
      Data: {
        operationsExecuted: 0,
        managedIndexes: Array.from(managedIndexes).join(","),
      },
    };
  }

  const results = await executeOperations(
    props.tableName,
    targets.map<GSIOperation>((gsi) => ({
      type: "DELETE",
      indexName: gsi.indexName,
      currentConfiguration: gsi,
    })),
    service
  );

  return {
    PhysicalResourceId: ensurePhysicalId(event),
    Data: {
      operationsExecuted: results.length,
      managedIndexes: Array.from(managedIndexes).join(","),
    },
  };
};

export const handler = async (
  event: CloudFormationCustomResourceEvent
): Promise<HandlerResponse> => {
  switch (event.RequestType) {
    case "Create":
      return handleCreateOrUpdate(event);
    case "Update":
      return handleCreateOrUpdate(event);
    case "Delete":
      return handleDelete(event);
    default:
      throw new Error("Unsupported request type");
  }
};

// ===== Async Custom Resource Pattern Functions =====

/**
 * 操作を開始（待機なし）
 */
const startOperation = async (
  tableName: string,
  operation: GSIOperation,
  service: DynamoDBGSIServiceImpl
): Promise<void> => {
  // テーブルがACTIVEになるまで待機（これは必須）
  await service.waitForTableActive(tableName);

  switch (operation.type) {
    case "DELETE":
      await service.deleteGSI(tableName, operation.indexName);
      break;
    case "CREATE":
      if (!operation.desiredConfiguration) {
        throw new Error(`CREATE operation missing desiredConfiguration for ${operation.indexName}`);
      }
      await service.createGSI(tableName, operation.desiredConfiguration);
      break;
    case "UPDATE":
      if (!operation.desiredConfiguration) {
        throw new Error(`UPDATE operation missing desiredConfiguration for ${operation.indexName}`);
      }
      await service.updateGSI(tableName, operation.desiredConfiguration);
      break;
  }

  // 操作を開始したら即座に返す（GSIのステータス待機はしない）
};

const handleCreateOrUpdateAsync = async (
  event: CloudFormationCustomResourceCreateEvent | CloudFormationCustomResourceUpdateEvent
): Promise<OnEventResponse> => {
  const props = parseProperties(event.ResourceProperties);
  const errors = validateGsiConfigurations(props.globalSecondaryIndexes);
  if (errors.length > 0) {
    throw new Error(["Invalid GSI configuration detected:", ...errors].join("\n- "));
  }

  const errorHandling = mergeErrorHandlingConfig(props.errorHandling);
  const service = new DynamoDBGSIServiceImpl({ client, errorHandling });

  const managedNames = new Set(props.globalSecondaryIndexes.map((gsi) => gsi.indexName));
  const current = await service.getCurrentGSIs(props.tableName);
  const operations = planGsiOperations(
    current.filter((gsi) => managedNames.has(gsi.indexName)),
    props.globalSecondaryIndexes
  );

  if (operations.length === 0) {
    // 操作が不要な場合は即座に完了
    return {
      IsComplete: true,
      PhysicalResourceId: ensurePhysicalId(event),
      Data: {
        operationsExecuted: 0,
        managedIndexes: props.globalSecondaryIndexes.map((gsi) => gsi.indexName).join(","),
      },
    };
  }

  // 最初の操作を開始（待機しない）
  const firstOperation = operations[0];
  await startOperation(props.tableName, firstOperation, service);

  console.log(
    `[GSI Manager][onEvent] Started operation ${firstOperation.type} for ${firstOperation.indexName}. ` +
    `Total operations: ${operations.length}`
  );

  // IsComplete=false の場合は Data を返さない（CloudFormation Provider の制約）
  return {
    IsComplete: false,
    PhysicalResourceId: ensurePhysicalId(event),
  };
};

const handleDeleteAsync = async (
  event: CloudFormationCustomResourceDeleteEvent
): Promise<OnEventResponse> => {
  const props = parseProperties(event.ResourceProperties);
  const managedIndexes = new Set(
    props.globalSecondaryIndexes.map((gsi) => gsi.indexName)
  );

  const service = new DynamoDBGSIServiceImpl({
    client,
    errorHandling: mergeErrorHandlingConfig(props.errorHandling),
  });

  const current = await service.getCurrentGSIs(props.tableName);
  const targets = current.filter((gsi) => managedIndexes.has(gsi.indexName));

  if (targets.length === 0) {
    return {
      IsComplete: true,
      PhysicalResourceId: ensurePhysicalId(event),
      Data: {
        operationsExecuted: 0,
        managedIndexes: Array.from(managedIndexes).join(","),
      },
    };
  }

  const operations = targets.map<GSIOperation>((gsi) => ({
    type: "DELETE",
    indexName: gsi.indexName,
    currentConfiguration: gsi,
  }));

  // 最初の操作を開始（待機しない）
  const firstOperation = operations[0];
  await startOperation(props.tableName, firstOperation, service);

  console.log(
    `[GSI Manager][onEvent] Started DELETE operation for ${firstOperation.indexName}. ` +
    `Total operations: ${operations.length}`
  );

  // IsComplete=false の場合は Data を返さない（CloudFormation Provider の制約）
  return {
    IsComplete: false,
    PhysicalResourceId: ensurePhysicalId(event),
  };
};

/**
 * CloudFormation カスタムリソースの onEvent ハンドラー
 * 操作を開始するが、完了を待たずに即座に返却
 */
export const onEventHandler = async (
  event: CloudFormationCustomResourceEvent
): Promise<OnEventResponse> => {
  switch (event.RequestType) {
    case "Create":
    case "Update":
      return handleCreateOrUpdateAsync(event);
    case "Delete":
      return handleDeleteAsync(event);
    default:
      throw new Error("Unsupported request type");
  }
};
