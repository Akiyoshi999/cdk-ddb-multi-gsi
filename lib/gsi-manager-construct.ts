import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Duration } from "aws-cdk-lib";
import * as customResources from "aws-cdk-lib/custom-resources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type {
  GSIConfiguration,
  ErrorHandlingConfig,
  GSIManagerProps,
} from "./types/index.ts";

export interface GsiManagerConstructProps
  extends Omit<GSIManagerProps, "tableName"> {
  /**
   * 管理対象のDynamoDBテーブル。
   */
  table: dynamodb.Table;
  /**
   * Lambdaログの保持期間。省略時は1週間。
   */
  logRetention?: logs.RetentionDays;
  /**
   * テーブル名を明示的に指定したい場合に使用。
   * 省略時は `table.tableName` を利用する。
   */
  tableName?: string;
  /**
   * Lambdaのタイムアウト。省略時は15分。
   */
  timeout?: Duration;
  /**
   * エラーハンドリング設定を上書き。
   */
  errorHandling?: Partial<ErrorHandlingConfig>;
}

export class GsiManager extends Construct {
  readonly customResource: cdk.CustomResource;

  constructor(scope: Construct, id: string, props: GsiManagerConstructProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, "HandlerLogGroup", {
      retention: props.logRetention ?? logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const handler = new lambdaNodejs.NodejsFunction(this, "Handler", {
      entry: path.join(__dirname, "../lambda/gsi-manager/src/handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: props.timeout ?? Duration.minutes(15),
      memorySize: 512,
      bundling: {
        minify: true,
        externalModules: ["aws-sdk"],
        target: "node20",
        format: lambdaNodejs.OutputFormat.CJS,
        // banner:
        //   "import { createRequire as topLevelCreateRequire } from 'module';const require = topLevelCreateRequire(import.meta.url);",
      },
      logGroup: logGroup,
    });

    props.table.grantReadWriteData(handler);
    props.table.grant(
      handler,
      "dynamodb:UpdateTable",
      "dynamodb:DescribeTable"
    );

    const provider = new customResources.Provider(this, "Provider", {
      onEventHandler: handler,
    });

    const tableName = props.tableName ?? props.table.tableName;

    this.customResource = new cdk.CustomResource(this, "Resource", {
      serviceToken: provider.serviceToken,
      properties: {
        tableName,
        globalSecondaryIndexes: props.globalSecondaryIndexes,
        errorHandling: props.errorHandling,
      },
    });

    this.customResource.node.addDependency(props.table);
  }

  get managedIndexNames(): string[] {
    const indexes = this.customResource.getAttString("managedIndexes");
    return cdk.Fn.split(",", indexes);
  }
}
