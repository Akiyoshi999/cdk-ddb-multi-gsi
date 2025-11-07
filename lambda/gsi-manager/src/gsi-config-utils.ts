/**
 * GSI 構成ユーティリティ
 *
 * CloudFormation ResourceProperties のパース、管理対象 GSI の解決、
 * プロパティ名のケース変換などを提供します。
 *
 * CloudFormation は PascalCase を使用しますが、TypeScript では camelCase を使用するため、
 * 両方のケースに対応したパース処理が必要です。
 */

import type {
  ErrorHandlingConfig,
  GSIConfiguration,
  GSIInfo,
  GSIManagerProps,
} from "../../../lib/types/index.js";

/**
 * オブジェクトから camelCase または PascalCase のプロパティ値を取得
 *
 * CloudFormation は PascalCase を使用するため、両方の形式をサポートします。
 * TypeScript の型安全性を保ちつつ、実行時の柔軟な処理を実現します。
 *
 * @param record - プロパティを含むオブジェクト
 * @param key - 取得するプロパティ名（camelCase）
 * @returns プロパティの値、見つからない場合は undefined
 */
const pickVariant = (
  record: Record<string, unknown> | undefined,
  key: string
): unknown => {
  if (!record) {
    return undefined;
  }

  // まず camelCase で探す
  if (Object.prototype.hasOwnProperty.call(record, key)) {
    return record[key];
  }

  // 次に PascalCase で探す
  const pascalKey = key.charAt(0).toUpperCase() + key.slice(1);
  if (Object.prototype.hasOwnProperty.call(record, pascalKey)) {
    return record[pascalKey];
  }

  return undefined;
};

/**
 * unknown 型の値を string 配列に変換
 *
 * 型安全性を保ちつつ、実行時に配列要素を検証します。
 * 文字列でない要素は除外されます。
 *
 * @param value - 変換対象の値
 * @returns 文字列配列、または undefined（配列でない、または空の場合）
 */
const toArrayOfStrings = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  // 文字列要素のみをフィルタリング
  const values = value
    .map((entry) => (typeof entry === "string" ? entry : undefined))
    .filter((entry): entry is string => Boolean(entry));

  return values.length > 0 ? values : undefined;
};

/**
 * DynamoDB 属性定義をパース
 *
 * CloudFormation の属性定義を内部形式に変換します。
 * 型の検証を行い、不正な値にはフォールバックを適用します。
 *
 * @param value - パース対象の属性定義
 * @param fallbackType - デフォルトの属性タイプ（S: String, N: Number, B: Binary）
 * @returns パースされた属性定義
 */
const parseAttribute = (
  value: unknown,
  fallbackType: "S" | "N" | "B" = "S"
) => {
  if (!value || typeof value !== "object") {
    return { name: "", type: fallbackType };
  }

  const record = value as Record<string, unknown>;
  const name = pickVariant(record, "name");
  const type = pickVariant(record, "type");

  return {
    name: typeof name === "string" ? name : "",
    // 型安全性: 有効な DynamoDB 属性タイプのみ許可
    type:
      type === "S" || type === "N" || type === "B"
        ? (type as "S" | "N" | "B")
        : fallbackType,
  };
};

/**
 * プロビジョンドスループット設定をパース
 *
 * CloudFormation から渡される読み込み/書き込みキャパシティユニットを解析します。
 * 文字列として渡される場合もあるため、数値への変換を試みます。
 *
 * @param value - パース対象のスループット設定
 * @returns パースされたスループット設定、または undefined（無効な場合）
 */
const parseProvisionedThroughput = (value: unknown) => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const read = pickVariant(record, "readCapacityUnits");
  const write = pickVariant(record, "writeCapacityUnits");

  // 文字列で渡される可能性もあるため、数値への変換を試みる
  const readCapacityUnits =
    typeof read === "number" ? read : read !== undefined ? Number(read) : undefined;
  const writeCapacityUnits =
    typeof write === "number"
      ? write
      : write !== undefined
        ? Number(write)
        : undefined;

  // 両方の値が必須
  if (readCapacityUnits === undefined || writeCapacityUnits === undefined) {
    return undefined;
  }

  return {
    readCapacityUnits,
    writeCapacityUnits,
  };
};

/**
 * GSI 構成配列をパース
 *
 * CloudFormation ResourceProperties から GSI の配列を抽出し、
 * 各 GSI を内部形式に変換します。
 *
 * @param value - パース対象の GSI 配列
 * @returns パースされた GSI 構成の配列
 */
const parseGsiConfigs = (value: unknown): GSIConfiguration[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const record =
      entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};

    // プロジェクションタイプの検証（ALL, KEYS_ONLY, INCLUDE のみ許可）
    const projectionSource = pickVariant(record, "projectionType");
    const projectionType =
      projectionSource === "ALL" ||
      projectionSource === "KEYS_ONLY" ||
      projectionSource === "INCLUDE"
        ? projectionSource
        : undefined;

    const partitionKey = pickVariant(record, "partitionKey");
    const sortKey = pickVariant(record, "sortKey");

    const indexNameValue = pickVariant(record, "indexName");
    return {
      indexName:
        typeof indexNameValue === "string" ? indexNameValue : "",
      partitionKey: parseAttribute(partitionKey, "S"),
      sortKey: sortKey ? parseAttribute(sortKey, "S") : undefined,
      projectionType,
      nonKeyAttributes: toArrayOfStrings(pickVariant(record, "nonKeyAttributes")),
      provisionedThroughput: parseProvisionedThroughput(
        pickVariant(record, "provisionedThroughput")
      ),
    };
  });
};

/**
 * CloudFormation ResourceProperties をパース
 *
 * Lambda 関数に渡される ResourceProperties を GSIManagerProps に変換します。
 * PascalCase と camelCase の両方に対応し、型安全な変換を行います。
 *
 * @param props - CloudFormation から渡される ResourceProperties
 * @returns パースされた GSI マネージャープロパティ
 */
export const parseManagerProps = (
  props: Record<string, unknown>
): GSIManagerProps => {
  const tableNameSource = pickVariant(props, "tableName");
  const errorHandlingSource = pickVariant(props, "errorHandling");

  return {
    tableName: typeof tableNameSource === "string" ? tableNameSource : "",
    globalSecondaryIndexes: parseGsiConfigs(
      pickVariant(props, "globalSecondaryIndexes")
    ),
    errorHandling:
      errorHandlingSource && typeof errorHandlingSource === "object"
        ? (errorHandlingSource as Partial<ErrorHandlingConfig>)
        : undefined,
  };
};

/**
 * 管理対象の GSI 名を収集
 *
 * 現在の構成と以前の構成から、すべての管理対象 GSI 名を集めます。
 * Update 操作時に削除された GSI を検出するために使用されます。
 *
 * @param desired - 希望する GSI 構成
 * @param prior - 以前の GSI 構成（Update 時のみ）
 * @returns 管理対象の GSI 名の Set
 */
export const collectManagedNames = (
  desired: GSIConfiguration[],
  prior?: GSIConfiguration[]
): Set<string> => {
  const names = new Set<string>();
  desired.forEach((gsi) => names.add(gsi.indexName));
  prior?.forEach((gsi) => names.add(gsi.indexName));
  return names;
};

/**
 * 操作計画のための現在の GSI を解決
 *
 * DynamoDB テーブルの現在の GSI を分析し、以下を判断します：
 * 1. 管理対象の GSI（構成に含まれる）
 * 2. 管理されていない GSI（レガシー/手動作成）
 * 3. Update/Delete 時にレガシー GSI を採用するかどうか
 *
 * Update/Delete の場合、管理されていない GSI もクリーンアップ対象に含めます。
 * これにより、手動作成された GSI も適切に削除できます。
 *
 * @param requestType - リクエストの種類（Create, Update, Delete）
 * @param current - 現在の GSI 状態
 * @param managedNames - 管理対象の GSI 名の Set
 * @returns 操作候補の GSI と採用フラグ
 */
export const resolveCurrentForPlanning = (
  requestType: "Create" | "Update" | "Delete",
  current: GSIInfo[],
  managedNames: Set<string>
): {
  /** 操作対象の GSI 候補 */
  candidates: GSIInfo[];
  /** レガシー GSI を採用したかどうか */
  adoptedLegacyIndexes: boolean;
  /** 管理されていない GSI の数 */
  untrackedCount: number;
} => {
  // 管理対象が空の場合、すべての GSI を対象とする
  if (managedNames.size === 0) {
    return {
      candidates: current,
      adoptedLegacyIndexes: requestType !== "Create" && current.length > 0,
      untrackedCount: current.length,
    };
  }

  const tracked: GSIInfo[] = [];
  const untracked: GSIInfo[] = [];

  // GSI を管理対象と非管理対象に分類
  for (const gsi of current) {
    if (managedNames.has(gsi.indexName)) {
      tracked.push(gsi);
    } else {
      untracked.push(gsi);
    }
  }

  // Update/Delete 時は、管理されていない GSI も採用してクリーンアップ
  const shouldAdopt =
    (requestType === "Update" || requestType === "Delete") &&
    untracked.length > 0;

  return {
    candidates: shouldAdopt ? current : tracked,
    adoptedLegacyIndexes: shouldAdopt,
    untrackedCount: untracked.length,
  };
};
