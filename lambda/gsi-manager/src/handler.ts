/**
 * CloudFormation カスタムリソースハンドラー
 * DynamoDB の Global Secondary Index (GSI) の作成・更新・削除を管理します
 *
 * このハンドラーは以下の2つのパターンをサポートします：
 * 1. 同期パターン (handler): 完了まで待機してから応答を返す
 * 2. 非同期パターン (onEventHandler): 操作を開始して即座に返却し、isCompleteHandlerでポーリング
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GSIOperation,
  GSIOperationResult,
  validateGsiConfigurations,
  mergeErrorHandlingConfig,
  ErrorHandlingConfig,
  OnEventResponse,
  GSIInfo,
} from "../../../lib/types/index.js";
import { DynamoDBGSIServiceImpl } from "./dynamodb-gsi-service.js";
import {
  collectManagedNames,
  parseManagerProps,
  resolveCurrentForPlanning,
} from "./gsi-config-utils.js";
import { planGsiOperations } from "./operation-planner.js";

/** CloudFormation カスタムリソースのリクエストタイプ */
type CloudFormationRequestType = "Create" | "Update" | "Delete";

/**
 * CloudFormation カスタムリソースイベントの共通プロパティ
 * すべてのリクエストタイプ（Create, Update, Delete）に共通するフィールドを定義
 */
interface CloudFormationCustomResourceEventCommon {
  /** リクエストの種類（Create, Update, Delete） */
  RequestType: CloudFormationRequestType;
  /** Lambda関数を呼び出すためのARN */
  ServiceToken: string;
  /** CloudFormationがレスポンスを受け取るための署名付きURL */
  ResponseURL: string;
  /** スタックの一意識別子 */
  StackId: string;
  /** このリクエストの一意識別子 */
  RequestId: string;
  /** CloudFormationテンプレート内のリソースの論理ID */
  LogicalResourceId: string;
  /** リソースの物理ID（省略可能） */
  PhysicalResourceId?: string;
  /** カスタムリソースのタイプ名（省略可能） */
  ResourceType?: string;
  /** リソースのプロパティ */
  ResourceProperties: Record<string, unknown>;
  /** 以前のリソースプロパティ（Update時のみ） */
  OldResourceProperties?: Record<string, unknown>;
}

/**
 * CloudFormation カスタムリソースの Create イベント
 * リソースが初めて作成されるときに発火
 */
export interface CloudFormationCustomResourceCreateEvent
  extends CloudFormationCustomResourceEventCommon {
  RequestType: "Create";
}

/**
 * CloudFormation カスタムリソースの Update イベント
 * リソースのプロパティが変更されたときに発火
 */
export interface CloudFormationCustomResourceUpdateEvent
  extends CloudFormationCustomResourceEventCommon {
  RequestType: "Update";
  /** 既存リソースの物理ID（必須） */
  PhysicalResourceId: string;
}

/**
 * CloudFormation カスタムリソースの Delete イベント
 * リソースが削除されるときに発火
 */
export interface CloudFormationCustomResourceDeleteEvent
  extends CloudFormationCustomResourceEventCommon {
  RequestType: "Delete";
  /** 削除対象リソースの物理ID（必須） */
  PhysicalResourceId: string;
}

/**
 * CloudFormation カスタムリソースイベントの統合型
 * Create, Update, Delete のいずれかのイベント
 */
type CloudFormationCustomResourceEvent =
  | CloudFormationCustomResourceCreateEvent
  | CloudFormationCustomResourceUpdateEvent
  | CloudFormationCustomResourceDeleteEvent;

/**
 * ハンドラーのレスポンス型
 * CloudFormation に返却するデータ構造
 */
interface HandlerResponse {
  /** リソースの物理ID */
  PhysicalResourceId: string;
  /** CloudFormation スタックの出力に含める追加データ */
  Data?: Record<string, unknown>;
}

/** DynamoDB クライアントのシングルトンインスタンス */
const client = new DynamoDBClient({});

/**
 * 物理リソースIDを取得または生成
 *
 * CloudFormation はリソースを一意に識別するために物理IDを必要とします。
 * 既存の ID がある場合はそれを使用し、ない場合は新規生成します。
 *
 * @param event - CloudFormation カスタムリソースイベント
 * @returns リソースの物理ID
 */
const ensurePhysicalId = (
  event: CloudFormationCustomResourceEvent
): string =>
  event.PhysicalResourceId && event.PhysicalResourceId.length > 0
    ? event.PhysicalResourceId
    : `GSIManager-${event.ResourceProperties["tableName"] ?? "UnknownTable"}`;

/**
 * GSI 操作を順次実行
 *
 * DynamoDB の制限により、GSI 操作は1つずつ順番に実行する必要があります。
 * 各操作の完了を待機してから次の操作を開始します。
 *
 * @param tableName - 対象テーブル名
 * @param operations - 実行する GSI 操作のリスト
 * @param service - DynamoDB GSI サービスインスタンス
 * @returns 各操作の実行結果
 */
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

  // CloudFormation が再実行する可能性があるため、最初にテーブルが安定していることを確認
  await service.waitForTableActive(tableName);
  const results: GSIOperationResult[] = [];

  // 各操作を順次実行（DynamoDB は同時に1つの GSI 操作のみサポート）
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

/**
 * Create または Update イベントを処理（同期パターン）
 *
 * GSI 構成を検証し、現在の状態と比較して必要な操作を計画・実行します。
 * Update の場合は、削除された GSI も検出して削除します。
 *
 * @param event - CloudFormation の Create または Update イベント
 * @returns ハンドラーレスポンス（物理ID と実行結果データ）
 * @throws GSI 構成が無効な場合にエラーをスロー
 */
const handleCreateOrUpdate = async (
  event: CloudFormationCustomResourceCreateEvent | CloudFormationCustomResourceUpdateEvent
): Promise<HandlerResponse> => {
  const props = parseManagerProps(event.ResourceProperties);
  const errors = validateGsiConfigurations(props.globalSecondaryIndexes);
  if (errors.length > 0) {
    throw new Error(["Invalid GSI configuration detected:", ...errors].join("\n- "));
  }

  const errorHandling = mergeErrorHandlingConfig(props.errorHandling);
  const service = new DynamoDBGSIServiceImpl({
    client,
    errorHandling,
  });

  // Update イベントの場合、削除された GSI を検出するために
  // 現在と以前の管理対象 GSI の両方を追跡する必要がある
  const oldProps =
    event.RequestType === "Update" && event.OldResourceProperties
      ? parseManagerProps(event.OldResourceProperties)
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
      `[GSI Manager] Detected ${untrackedCount} pre-existing GSI(s) not present in configuration; treating them as managed for cleanup.`
    );
  }
  const operations = planGsiOperations(
    managedCurrent,
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

/**
 * Delete イベントを処理（同期パターン）
 *
 * 管理対象のすべての GSI を削除します。
 * 管理されていない GSI も検出した場合は、クリーンアップのために削除します。
 *
 * @param event - CloudFormation の Delete イベント
 * @returns ハンドラーレスポンス（物理ID と削除結果データ）
 */
const handleDelete = async (
  event: CloudFormationCustomResourceDeleteEvent
): Promise<HandlerResponse> => {
  const props = parseManagerProps(event.ResourceProperties);
  const service = new DynamoDBGSIServiceImpl({
    client,
    errorHandling: mergeErrorHandlingConfig(props.errorHandling),
  });

  const current = await service.getCurrentGSIs(props.tableName);
  const { candidates: targets, adoptedLegacyIndexes, untrackedCount } =
    resolveCurrentForPlanning(event.RequestType, current, collectManagedNames(props.globalSecondaryIndexes));
  if (adoptedLegacyIndexes) {
    console.log(
      `[GSI Manager] Detected ${untrackedCount} unmanaged GSI(s) during Delete; including them in cleanup.`
    );
  }

  if (targets.length === 0) {
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
      managedIndexes: props.globalSecondaryIndexes
        .map((gsi) => gsi.indexName)
        .join(","),
    },
  };
};

/**
 * CloudFormation カスタムリソースのメインハンドラー（同期パターン）
 *
 * すべての GSI 操作が完了するまで待機してから応答を返します。
 * Lambda のタイムアウト制限（最大15分）に注意が必要です。
 *
 * @param event - CloudFormation カスタムリソースイベント
 * @returns ハンドラーレスポンス
 * @throws サポートされていないリクエストタイプの場合にエラーをスロー
 */
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

// ===== 非同期カスタムリソースパターン用の関数 =====

/**
 * GSI 操作を開始（完了を待機しない）
 *
 * テーブルが ACTIVE 状態になるまで待機してから操作を開始しますが、
 * GSI のステータス変更完了は待ちません。
 *
 * @param tableName - 対象テーブル名
 * @param operation - 実行する GSI 操作
 * @param service - DynamoDB GSI サービスインスタンス
 * @throws 必須の構成が欠けている場合にエラーをスロー
 */
const startOperation = async (
  tableName: string,
  operation: GSIOperation,
  service: DynamoDBGSIServiceImpl
): Promise<void> => {
  // テーブルが ACTIVE になるまで待機（必須前提条件）
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

  // 操作を開始したら即座に返す（GSI のステータス変更完了は待機しない）
};

/**
 * Create または Update イベントを処理（非同期パターン）
 *
 * 最初の GSI 操作のみを開始し、完了を待たずに即座に IsComplete=false を返します。
 * isCompleteHandler が操作の完了を確認し、次の操作を開始します。
 *
 * @param event - CloudFormation の Create または Update イベント
 * @returns 非同期レスポンス（IsComplete フラグと物理ID）
 * @throws GSI 構成が無効な場合にエラーをスロー
 */
const handleCreateOrUpdateAsync = async (
  event: CloudFormationCustomResourceCreateEvent | CloudFormationCustomResourceUpdateEvent
): Promise<OnEventResponse> => {
  const props = parseManagerProps(event.ResourceProperties);
  const errors = validateGsiConfigurations(props.globalSecondaryIndexes);
  if (errors.length > 0) {
    throw new Error(["Invalid GSI configuration detected:", ...errors].join("\n- "));
  }

  const errorHandling = mergeErrorHandlingConfig(props.errorHandling);
  const service = new DynamoDBGSIServiceImpl({ client, errorHandling });

  const oldProps =
    event.RequestType === "Update" && event.OldResourceProperties
      ? parseManagerProps(event.OldResourceProperties)
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
      `[GSI Manager] Detected ${untrackedCount} pre-existing GSI(s) not present in configuration; treating them as managed for cleanup.`
    );
  }
  const operations = planGsiOperations(
    managedCurrent,
    props.globalSecondaryIndexes
  );

  if (operations.length === 0) {
    // 操作が不要な場合は即座に完了を通知
    return {
      IsComplete: true,
      PhysicalResourceId: ensurePhysicalId(event),
      Data: {
        operationsExecuted: 0,
        managedIndexes: props.globalSecondaryIndexes.map((gsi) => gsi.indexName).join(","),
      },
    };
  }

  // 最初の操作のみを開始（完了を待機しない）
  const firstOperation = operations[0];
  await startOperation(props.tableName, firstOperation, service);

  console.log(
    `[GSI Manager][onEvent] Started operation ${firstOperation.type} for ${firstOperation.indexName}. ` +
    `Total operations: ${operations.length}`
  );

  // IsComplete=false の場合は Data を返さない（CloudFormation Provider Framework の制約）
  return {
    IsComplete: false,
    PhysicalResourceId: ensurePhysicalId(event),
  };
};

/**
 * Delete イベントを処理（非同期パターン）
 *
 * 最初の GSI 削除操作のみを開始し、完了を待たずに即座に IsComplete=false を返します。
 * isCompleteHandler が削除の完了を確認し、次の削除操作を開始します。
 *
 * @param event - CloudFormation の Delete イベント
 * @returns 非同期レスポンス（IsComplete フラグと物理ID）
 */
const handleDeleteAsync = async (
  event: CloudFormationCustomResourceDeleteEvent
): Promise<OnEventResponse> => {
  const props = parseManagerProps(event.ResourceProperties);
  const service = new DynamoDBGSIServiceImpl({
    client,
    errorHandling: mergeErrorHandlingConfig(props.errorHandling),
  });

  const current = await service.getCurrentGSIs(props.tableName);
  const { candidates: targets, adoptedLegacyIndexes, untrackedCount } =
    resolveCurrentForPlanning(event.RequestType, current, collectManagedNames(props.globalSecondaryIndexes));
  if (adoptedLegacyIndexes) {
    console.log(
      `[GSI Manager] Detected ${untrackedCount} unmanaged GSI(s) during Delete; including them in cleanup.`
    );
  }

  if (targets.length === 0) {
    return {
      IsComplete: true,
      PhysicalResourceId: ensurePhysicalId(event),
      Data: {
        operationsExecuted: 0,
        managedIndexes: props.globalSecondaryIndexes
          .map((gsi) => gsi.indexName)
          .join(","),
      },
    };
  }

  const operations = targets.map<GSIOperation>((gsi) => ({
    type: "DELETE",
    indexName: gsi.indexName,
    currentConfiguration: gsi,
  }));

  // 最初の削除操作のみを開始（完了を待機しない）
  const firstOperation = operations[0];
  await startOperation(props.tableName, firstOperation, service);

  console.log(
    `[GSI Manager][onEvent] Started DELETE operation for ${firstOperation.indexName}. ` +
    `Total operations: ${operations.length}`
  );

  // IsComplete=false の場合は Data を返さない（CloudFormation Provider Framework の制約）
  return {
    IsComplete: false,
    PhysicalResourceId: ensurePhysicalId(event),
  };
};

/**
 * CloudFormation カスタムリソースの onEvent ハンドラー（非同期パターン）
 *
 * 操作を開始するが、完了を待たずに即座に返却します。
 * CloudFormation Provider Framework が定期的に isCompleteHandler を呼び出して
 * 操作の完了を確認します。
 *
 * このパターンは Lambda のタイムアウト制限（15分）を回避し、
 * 長時間実行される GSI 操作を安全に処理できます。
 *
 * @param event - CloudFormation カスタムリソースイベント
 * @returns 非同期レスポンス（IsComplete フラグと物理ID）
 * @throws サポートされていないリクエストタイプの場合にエラーをスロー
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
