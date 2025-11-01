import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type {
  IsCompleteResponse,
  GSIOperation,
  GSIConfiguration,
  GSIManagerProps,
  ErrorHandlingConfig,
  GSIInfo,
} from "../../../lib/types/index.js";
import { mergeErrorHandlingConfig } from "../../../lib/types/index.js";
import { DynamoDBGSIServiceImpl } from "./dynamodb-gsi-service.js";
import { planGsiOperations } from "./operation-planner.js";

const client = new DynamoDBClient({});

interface IsCompleteEvent {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId: string;
  ResourceProperties: Record<string, unknown>;
  OldResourceProperties?: Record<string, unknown>;
}

// ResourceProperties のパース（handler.ts と同じロジック）
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

/**
 * 操作を開始（待機なし）
 * テーブルがACTIVEになるまで待機してから操作を開始する
 */
const startOperation = async (
  tableName: string,
  operation: GSIOperation,
  service: DynamoDBGSIServiceImpl
): Promise<void> => {
  // テーブルがACTIVEになるまで待機（必須）
  await service.waitForTableActive(tableName);

  switch (operation.type) {
    case "DELETE":
      await service.deleteGSI(tableName, operation.indexName);
      console.log(`[GSI Manager] DELETE operation started for ${operation.indexName}`);
      break;

    case "CREATE":
      if (!operation.desiredConfiguration) {
        throw new Error(`CREATE operation missing desiredConfiguration for ${operation.indexName}`);
      }
      await service.createGSI(tableName, operation.desiredConfiguration);
      console.log(`[GSI Manager] CREATE operation started for ${operation.indexName}`);
      break;

    case "UPDATE":
      if (!operation.desiredConfiguration) {
        throw new Error(`UPDATE operation missing desiredConfiguration for ${operation.indexName}`);
      }
      await service.updateGSI(tableName, operation.desiredConfiguration);
      console.log(`[GSI Manager] UPDATE operation started for ${operation.indexName}`);
      break;

    default:
      throw new Error(`Unknown operation type for ${operation.indexName}`);
  }
};

/**
 * 操作が完了しているか確認
 */
const checkOperationComplete = async (
  tableName: string,
  operation: GSIOperation,
  service: DynamoDBGSIServiceImpl
): Promise<boolean> => {
  const tableActive = await service.isTableActive(tableName);
  if (!tableActive) {
    return false;
  }

  const targetStatus = operation.type === "DELETE" ? "DELETED" : "ACTIVE";
  return await service.isGSIInStatus(tableName, operation.indexName, targetStatus);
};

/**
 * CloudFormation カスタムリソースの isComplete ハンドラー
 * ResourceProperties から操作計画を再計算し、未完了の操作を実行
 */
export const isCompleteHandler = async (
  event: IsCompleteEvent
): Promise<IsCompleteResponse> => {
  const props = parseProperties(event.ResourceProperties);
  const service = new DynamoDBGSIServiceImpl({
    client,
    errorHandling: mergeErrorHandlingConfig(props.errorHandling)
  });

  console.log(`[GSI Manager][isComplete] Checking operations for table ${props.tableName}`);

  // 現在の GSI 状態を取得
  const oldProps =
    event.RequestType === "Update" && event.OldResourceProperties
      ? parseProperties(event.OldResourceProperties)
      : undefined;
  const managedNames = collectManagedNames(
    props.globalSecondaryIndexes,
    oldProps?.globalSecondaryIndexes
  );

  const current = await service.getCurrentGSIs(props.tableName);
  const {
    candidates: managedCurrent,
    adoptedLegacyIndexes,
    untrackedCount,
  } = resolveCurrentForPlanning(event.RequestType, current, managedNames);
  if (adoptedLegacyIndexes) {
    console.log(
      `[GSI Manager][isComplete] Detected ${untrackedCount} pre-existing GSI(s) not present in configuration; adopting them for cleanup.`
    );
  }

  // Delete の場合は、管理対象のGSIを1つずつ削除
  if (event.RequestType === "Delete") {
    const existingManaged = managedCurrent;

    if (existingManaged.length === 0) {
      // すべて削除済み
      console.log(`[GSI Manager][isComplete] All GSIs deleted`);
      return {
        IsComplete: true,
        Data: {
          operationsExecuted: props.globalSecondaryIndexes.length,
          managedIndexes: props.globalSecondaryIndexes.map((gsi) => gsi.indexName).join(","),
        },
      };
    }

    // DynamoDB制限: 1度に1つのGSI操作のみ
    // 最初の管理対象GSIを処理
    const gsi = existingManaged[0];
    console.log(`[GSI Manager][isComplete] Checking deletion of ${gsi.indexName} (${existingManaged.length} GSIs remaining)`);

    const isDeleted = await service.isGSIInStatus(props.tableName, gsi.indexName, "DELETED");
    if (isDeleted) {
      // この GSI は削除完了
      console.log(`[GSI Manager][isComplete] ${gsi.indexName} deleted successfully`);

      if (existingManaged.length > 1) {
        // まだ他のGSIがある
        return {
          IsComplete: false,
        };
      }

      // すべて削除完了
      console.log(`[GSI Manager][isComplete] All GSIs deleted`);
      return {
        IsComplete: true,
        Data: {
          operationsExecuted: props.globalSecondaryIndexes.length,
          managedIndexes: props.globalSecondaryIndexes.map((gsi) => gsi.indexName).join(","),
        },
      };
    }

    // まだ削除されていない
    if (gsi.indexStatus !== "DELETING") {
      // 削除操作がまだ開始されていない
      const tableActive = await service.isTableActive(props.tableName);
      if (tableActive) {
        console.log(`[GSI Manager][isComplete] Starting deletion of ${gsi.indexName}`);
        await service.deleteGSI(props.tableName, gsi.indexName);
      } else {
        console.log(`[GSI Manager][isComplete] Waiting for table to become ACTIVE before deleting ${gsi.indexName}`);
      }
    } else {
      console.log(`[GSI Manager][isComplete] ${gsi.indexName} deletion in progress`);
    }

    return {
      IsComplete: false,
    };
  }

  // Create/Update の場合:
  // まず、進行中の操作があるかチェック（DynamoDB制限対応）
  const inProgressGSI = managedCurrent.find(
    (gsi) =>
      gsi.indexStatus === "CREATING" ||
      gsi.indexStatus === "UPDATING" ||
      gsi.indexStatus === "DELETING"
  );

  if (inProgressGSI) {
    // 進行中の操作がある → 完了を待つ（新しい操作は開始しない）
    console.log(
      `[GSI Manager][isComplete] Waiting for ${inProgressGSI.indexName} to complete (status: ${inProgressGSI.indexStatus})`
    );

    // 完了しているかチェック
    const targetStatus = inProgressGSI.indexStatus === "DELETING" ? "DELETED" : "ACTIVE";
    const isComplete = await service.isGSIInStatus(
      props.tableName,
      inProgressGSI.indexName,
      targetStatus
    );

    if (isComplete) {
      console.log(`[GSI Manager][isComplete] ${inProgressGSI.indexName} completed successfully`);
      // 完了したので、次のポーリングで新しい operations を確認
      return {
        IsComplete: false,
      };
    }

    // まだ完了していない
    return {
      IsComplete: false,
    };
  }

  // 進行中の操作がない → 操作計画を再計算
  const operations = planGsiOperations(managedCurrent, props.globalSecondaryIndexes);

  if (operations.length === 0) {
    // すべての操作が完了している
    console.log(`[GSI Manager][isComplete] All operations completed`);
    return {
      IsComplete: true,
      Data: {
        operationsExecuted: props.globalSecondaryIndexes.length,
        managedIndexes: props.globalSecondaryIndexes.map((gsi) => gsi.indexName).join(","),
      },
    };
  }

  // DynamoDB制限: 同時に1つのGSI操作のみ可能
  // 最初の操作のみを処理
  console.log(`[GSI Manager][isComplete] Found ${operations.length} pending operations`);

  const operation = operations[0];
  const isComplete = await checkOperationComplete(props.tableName, operation, service);

  if (isComplete) {
    // 最初の操作が完了
    console.log(`[GSI Manager][isComplete] Operation ${operation.type} for ${operation.indexName} is complete`);

    if (operations.length > 1) {
      // まだ他の操作がある
      console.log(`[GSI Manager][isComplete] ${operations.length - 1} operations remaining`);
      return {
        IsComplete: false,
      };
    }

    // すべての操作が完了
    console.log(`[GSI Manager][isComplete] All operations completed`);
    return {
      IsComplete: true,
      Data: {
        operationsExecuted: props.globalSecondaryIndexes.length,
        managedIndexes: props.globalSecondaryIndexes.map((gsi) => gsi.indexName).join(","),
      },
    };
  }

  // 最初の操作がまだ完了していない
  // 操作が開始されているか確認
  const currentGSI = current.find((gsi) => gsi.indexName === operation.indexName);

  if (operation.type === "CREATE") {
    if (!currentGSI) {
      // CREATE操作がまだ開始されていない - 開始する
      console.log(`[GSI Manager][isComplete] Starting CREATE for ${operation.indexName}`);
      await startOperation(props.tableName, operation, service);
    } else {
      // 操作は開始済み、完了を待つ
      console.log(`[GSI Manager][isComplete] CREATE ${operation.indexName} is in progress (status: ${currentGSI.indexStatus})`);
    }
    return {
      IsComplete: false,
    };
  }

  if (operation.type === "DELETE") {
    if (currentGSI && currentGSI.indexStatus !== "DELETING") {
      // DELETE操作がまだ開始されていない - 開始する
      console.log(`[GSI Manager][isComplete] Starting DELETE for ${operation.indexName}`);
      await startOperation(props.tableName, operation, service);
    } else {
      // 操作は開始済み、完了を待つ
      console.log(`[GSI Manager][isComplete] DELETE ${operation.indexName} is in progress`);
    }
    return {
      IsComplete: false,
    };
  }

  if (operation.type === "UPDATE") {
    // UPDATEはべき等なので、常に実行（複数回実行しても問題ない）
    console.log(`[GSI Manager][isComplete] Starting UPDATE for ${operation.indexName}`);
    await startOperation(props.tableName, operation, service);
    return {
      IsComplete: false,
    };
  }

  // 想定外の操作タイプ
  throw new Error(`Unknown operation type: ${operation.type}`);
};
const collectManagedNames = (
  desired: GSIConfiguration[],
  prior?: GSIConfiguration[]
): Set<string> => {
  const names = new Set<string>();
  desired.forEach((gsi) => names.add(gsi.indexName));
  prior?.forEach((gsi) => names.add(gsi.indexName));
  return names;
};

const resolveCurrentForPlanning = (
  requestType: IsCompleteEvent["RequestType"],
  current: GSIInfo[],
  managedNames: Set<string>
): {
  candidates: GSIInfo[];
  adoptedLegacyIndexes: boolean;
  untrackedCount: number;
} => {
  if (managedNames.size === 0) {
    return {
      candidates: current,
      adoptedLegacyIndexes: requestType !== "Create" && current.length > 0,
      untrackedCount: current.length,
    };
  }

  const tracked: GSIInfo[] = [];
  const untracked: GSIInfo[] = [];

  for (const gsi of current) {
    if (managedNames.has(gsi.indexName)) {
      tracked.push(gsi);
    } else {
      untracked.push(gsi);
    }
  }

  const shouldAdopt =
    (requestType === "Update" || requestType === "Delete") &&
    untracked.length > 0;

  return {
    candidates: shouldAdopt ? current : tracked,
    adoptedLegacyIndexes: shouldAdopt,
    untrackedCount: untracked.length,
  };
};
