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
      {
        indexName: "GSI1",
        partitionKey: { name: "GSI1PK", type: "S" },
        sortKey: { name: "GSI1SK", type: "S" },
      },
      {
        indexName: "GSI2",
        partitionKey: { name: "GSI2PK", type: "S" },
        sortKey: { name: "GSI2SK", type: "S" },
      },
      {
        indexName: "GSI3",
        partitionKey: { name: "GSI3PK", type: "S" },
        sortKey: { name: "GSI3SK", type: "S" },
      },
      {
        indexName: "GSI4",
        partitionKey: { name: "GSI4PK", type: "S" },
        sortKey: { name: "GSI4SK", type: "S" },
      },
      {
        indexName: "GSI5",
        partitionKey: { name: "GSI5PK", type: "S" },
        sortKey: { name: "GSI5SK", type: "S" },
      },
      {
        indexName: "GSI6",
        partitionKey: { name: "GSI6PK", type: "S" },
        sortKey: { name: "GSI6SK", type: "S" },
      },
    ];

    new GsiManager(this, "GsiManager", {
      table: ddb,
      globalSecondaryIndexes: globalSecondaryIndexes,
    });
  }
}
