/**
 * DynamoDB テーブルと Global Secondary Index (GSI) を管理する CDK スタック
 *
 * このスタックは DynamoDB テーブルを作成し、GsiManager コンストラクトを使用して
 * 複数の GSI を管理します。GSI の作成・更新・削除はカスタムリソースにより自動化されています。
 */

import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import type { GSIConfiguration } from "./types/index";
import { GsiManager } from "./gsi-manager-construct";

/**
 * DynamoDB マルチ GSI スタック
 *
 * 複数の Global Secondary Index を持つ DynamoDB テーブルの管理を簡素化します。
 * GSI の設定変更時も自動的に適切な操作（作成・更新・削除）が実行されます。
 */
export class CdkDdbMultiGsiStack extends cdk.Stack {
  /**
   * スタックを初期化
   *
   * @param scope - コンストラクトのスコープ
   * @param id - コンストラクトID
   * @param props - スタックのプロパティ（オプション）
   */
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB テーブルの作成（オンデマンド課金モード）
    const ddb = new dynamodb.Table(this, "MyTable", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /**
     * GSI 構成の配列
     *
     * 各 GSI は以下の設定が可能：
     * - パーティションキー（必須）とソートキー（オプション）
     * - プロジェクションタイプ（ALL, KEYS_ONLY, INCLUDE）
     * - 非キー属性（INCLUDE 時のみ）
     * - プロビジョンドスループット（オプション）
     */
    const globalSecondaryIndexes: GSIConfiguration[] = [
      // 基本: パーティションキー + ソートキー（デフォルトプロジェクション: ALL）
      {
        indexName: "GSI1",
        partitionKey: { name: "GSI1PK", type: "S" },
        sortKey: { name: "GSI1SK", type: "N" },
        projectionType: "KEYS_ONLY",
      },
      // パーティションキーのみ（ソートキーなし）
      {
        indexName: "GSI2",
        partitionKey: { name: "GSI2PK", type: "S" },
      },
      // プロジェクションタイプ: KEYS_ONLY（キー属性のみ含める）
      {
        indexName: "GSI3",
        partitionKey: { name: "GSI3PK", type: "S" },
        sortKey: { name: "GSI3SK", type: "S" },
        projectionType: "ALL",
      },
      // プロジェクションタイプ: INCLUDE（特定の属性を含める）
      {
        indexName: "GSI4",
        partitionKey: { name: "GSI4PK", type: "S" },
        sortKey: { name: "GSI4SK", type: "S" },
        projectionType: "INCLUDE",
        nonKeyAttributes: ["attr1", "attr2"],
      },
    ];

    // GsiManager コンストラクトで GSI を管理
    // このコンストラクトは Lambda 関数とカスタムリソースを作成し、
    // GSI の作成・更新・削除を自動的に処理します
    new GsiManager(this, "GsiManager", {
      table: ddb,
      globalSecondaryIndexes: globalSecondaryIndexes,
    });
  }
}
