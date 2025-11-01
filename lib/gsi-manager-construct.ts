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

    // onEventHandler（操作開始）
    const onEventHandler = new lambdaNodejs.NodejsFunction(
      this,
      "OnEventHandler",
      {
        entry: path.join(__dirname, "../lambda/gsi-manager/src/handler.ts"),
        handler: "onEventHandler",
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: props.timeout ?? Duration.minutes(3), // 操作開始のみなので短くてOK
        memorySize: 512,
        bundling: {
          minify: true,
          externalModules: ["aws-sdk"],
          target: "node20",
          format: lambdaNodejs.OutputFormat.CJS,
        },
        logGroup: logGroup,
      }
    );

    // isCompleteHandler（完了確認）
    const isCompleteHandler = new lambdaNodejs.NodejsFunction(
      this,
      "IsCompleteHandler",
      {
        entry: path.join(
          __dirname,
          "../lambda/gsi-manager/src/is-complete-handler.ts"
        ),
        handler: "isCompleteHandler",
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: Duration.minutes(5), // 短めでOK（状態確認のみ）
        memorySize: 512,
        bundling: {
          minify: true,
          externalModules: ["aws-sdk"],
          target: "node20",
          format: lambdaNodejs.OutputFormat.CJS,
        },
        logGroup: logGroup,
      }
    );

    // 両方のハンドラーに権限を付与
    props.table.grantReadWriteData(onEventHandler);
    props.table.grant(
      onEventHandler,
      "dynamodb:UpdateTable",
      "dynamodb:DescribeTable"
    );

    props.table.grantReadWriteData(isCompleteHandler);
    props.table.grant(
      isCompleteHandler,
      "dynamodb:UpdateTable",
      "dynamodb:DescribeTable"
    );

    // Provider に両方のハンドラーを設定
    const provider = new customResources.Provider(this, "Provider", {
      onEventHandler: onEventHandler,
      isCompleteHandler: isCompleteHandler,
      queryInterval: Duration.seconds(15), // ポーリング間隔
      totalTimeout: Duration.hours(2), // 全体タイムアウト（2時間）
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
