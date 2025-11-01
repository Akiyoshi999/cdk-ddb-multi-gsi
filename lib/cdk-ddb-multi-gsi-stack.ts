import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import type { GSIConfiguration } from "./types/index";
import { GsiManager } from "./gsi-manager-construct";

export class CdkDdbMultiGsiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ddb = new dynamodb.Table(this, "MyTable", {
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const globalSecondaryIndexes: GSIConfiguration[] = [
      // // 基本: パーティションキー + ソートキー (デフォルトプロジェクション: ALL)
      {
        indexName: "GSI1",
        partitionKey: { name: "GSI1PK", type: "S" },
        sortKey: { name: "GSI1SK", type: "S" },
      },
      // // パーティションキーのみ（ソートキーなし）
      {
        indexName: "GSI2",
        partitionKey: { name: "GSI2PK", type: "S" },
      },
      // // プロジェクションタイプ: KEYS_ONLY
      {
        indexName: "GSI3",
        partitionKey: { name: "GSI3PK", type: "S" },
        sortKey: { name: "GSI3SK", type: "S" },
        projectionType: "KEYS_ONLY",
      },
      // // プロジェクションタイプ: INCLUDE + 非キー属性
      {
        indexName: "GSI4",
        partitionKey: { name: "GSI4PK", type: "S" },
        sortKey: { name: "GSI4SK", type: "S" },
        projectionType: "INCLUDE",
        nonKeyAttributes: ["attr1", "attr2", "attr3"],
      },
      // プロジェクションタイプ: ALL（明示的に指定）
      {
        indexName: "GSI5",
        partitionKey: { name: "GSI5PK", type: "S" },
        sortKey: { name: "GSI5SK", type: "S" },
        projectionType: "ALL",
      },
      // Number型のキー
      {
        indexName: "GSI6",
        partitionKey: { name: "GSI6PK", type: "N" },
        sortKey: { name: "GSI6SK", type: "N" },
      },
      // String型PK + Number型SK
      {
        indexName: "GSI7",
        partitionKey: { name: "GSI7PK", type: "S" },
        sortKey: { name: "GSI7SK", type: "N" },
        projectionType: "KEYS_ONLY",
      },
    ];

    new GsiManager(this, "GsiManager", {
      table: ddb,
      globalSecondaryIndexes: globalSecondaryIndexes,
    });
  }
}
