/**
 * CloudFormation カスタムリソースの isComplete ハンドラー（非同期パターン用）
 *
 * onEventHandler で開始された GSI 操作の完了状態を確認し、
 * 必要に応じて次の操作を開始します。
 *
 * CloudFormation Provider Framework により定期的に呼び出され、
 * IsComplete=true を返すまで繰り返し実行されます。
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type {
  IsCompleteResponse,
  GSIOperation,
  ErrorHandlingConfig,
  GSIInfo,
} from "../../../lib/types/index.js";
import { mergeErrorHandlingConfig } from "../../../lib/types/index.js";
import { DynamoDBGSIServiceImpl } from "./dynamodb-gsi-service.js";
import {
  collectManagedNames,
  parseManagerProps,
  resolveCurrentForPlanning,
} from "./gsi-config-utils.js";
import { planGsiOperations } from "./operation-planner.js";

/** DynamoDB クライアントのシングルトンインスタンス */
const client = new DynamoDBClient({});

/**
 * isComplete ハンドラーに渡されるイベント
 * CloudFormation Provider Framework から定期的に呼び出される
 */
interface IsCompleteEvent {
  /** リクエストの種類（Create, Update, Delete） */
  RequestType: "Create" | "Update" | "Delete";
  /** リソースの物理ID */
  PhysicalResourceId: string;
  /** リソースのプロパティ */
  ResourceProperties: Record<string, unknown>;
  /** 以前のリソースプロパティ（Update時のみ） */
  OldResourceProperties?: Record<string, unknown>;
}

/**
 * GSI 操作を開始（完了を待機しない）
 *
 * テーブルが ACTIVE 状態になるまで待機してから操作を開始しますが、
 * GSI のステータス変更完了は待ちません。
 *
 * @param tableName - 対象テーブル名
 * @param operation - 実行する GSI 操作
 * @param service - DynamoDB GSI サービスインスタンス
 * @throws 必須の構成が欠けている場合、または不明な操作タイプの場合にエラーをスロー
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
      // TypeScript の exhaustiveness チェックにより、すべての操作タイプが処理されることを保証
      throw new Error(`Unknown operation type for ${operation.indexName}`);
  }
};

/**
 * GSI 操作が完了しているか確認
 *
 * テーブルが ACTIVE 状態であり、かつ GSI が目標のステータスに達しているかを確認します。
 *
 * @param tableName - 対象テーブル名
 * @param operation - 確認する GSI 操作
 * @param service - DynamoDB GSI サービスインスタンス
 * @returns 操作が完了している場合は true、それ以外は false
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

  // DELETE の場合は DELETED、それ以外（CREATE, UPDATE）は ACTIVE を待つ
  const targetStatus = operation.type === "DELETE" ? "DELETED" : "ACTIVE";
  return await service.isGSIInStatus(tableName, operation.indexName, targetStatus);
};

/**
 * CloudFormation カスタムリソースの isComplete ハンドラー
 *
 * CloudFormation Provider Framework により定期的に呼び出され、
 * GSI 操作の完了状態を確認します。
 *
 * 主な処理フロー：
 * 1. 現在のテーブル状態を取得
 * 2. 操作計画を再計算（べき等性の確保）
 * 3. 進行中の操作がある場合は完了を待機
 * 4. 未完了の操作がある場合は次の操作を開始
 * 5. すべて完了している場合は IsComplete=true を返す
 *
 * DynamoDB の制限により、同時に実行できる GSI 操作は1つだけです。
 *
 * @param event - isComplete イベント（ResourceProperties を含む）
 * @returns 完了状態を示すレスポンス
 */
export const isCompleteHandler = async (
  event: IsCompleteEvent
): Promise<IsCompleteResponse> => {
  const props = parseManagerProps(event.ResourceProperties);
  const service = new DynamoDBGSIServiceImpl({
    client,
    errorHandling: mergeErrorHandlingConfig(props.errorHandling)
  });

  console.log(`[GSI Manager][isComplete] Checking operations for table ${props.tableName}`);

  // Update の場合、削除された GSI を検出するために以前のプロパティも考慮
  const oldProps =
    event.RequestType === "Update" && event.OldResourceProperties
      ? parseManagerProps(event.OldResourceProperties)
      : undefined;
  const managedNames = collectManagedNames(
    props.globalSecondaryIndexes,
    oldProps?.globalSecondaryIndexes
  );

  // 現在の GSI 状態を取得し、管理対象を解決
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

  // Delete リクエストの処理：管理対象の GSI を1つずつ削除
  if (event.RequestType === "Delete") {
    const existingManaged = managedCurrent;

    if (existingManaged.length === 0) {
      // すべての GSI が削除完了
      console.log(`[GSI Manager][isComplete] All GSIs deleted`);
      return {
        IsComplete: true,
        Data: {
          operationsExecuted: props.globalSecondaryIndexes.length,
          managedIndexes: props.globalSecondaryIndexes.map((gsi) => gsi.indexName).join(","),
        },
      };
    }

    // DynamoDB 制限: 同時に1つの GSI 操作のみ可能
    // 最初の管理対象 GSI から処理を開始
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
